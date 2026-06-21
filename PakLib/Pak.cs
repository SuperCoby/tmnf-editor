using GBX.NET.Components;
using GBX.NET.Crypto;
using GBX.NET.Exceptions;
using GBX.NET.PAK.Exceptions;
using NativeSharpZlib;
using System.Collections.Immutable;
using System.IO.Compression;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;

namespace GBX.NET.PAK;

public partial class Pak : IDisposable
#if NET5_0_OR_GREATER
    , IAsyncDisposable
#endif
{
    /// <summary>
    /// Magic (intial binary letters) for Pak files.
    /// </summary>
    public const string Magic = "NadeoPak";

    private readonly Stream stream;
    private readonly byte[]? key;
    private readonly object _streamLock = new();

    private static readonly byte[] headerKey = [
        0x56, 0xee, 0xcb, 0xbb, 0xde, 0xb6, 0xbc, 0x90,
        0xa1, 0x7d, 0xfc, 0xeb, 0x76, 0x1d, 0x59, 0xce
    ];

    public int Version { get; }

    public uint GbxHeadersStart { get; private set; }
    public int? GbxHeadersSize { get; private set; }
    public int? GbxHeadersComprSize { get; private set; }
    public int? HeaderMaxSize { get; protected set; }
    public uint? Size { get; private set; }
    public byte[]? HeaderMD5 { get; private set; }
    public uint Flags { get; private set; }
    public virtual bool IsHeaderPrivate => true;
    public virtual bool UseDefaultHeaderKey => false;
    public virtual bool IsHeaderEncrypted => true;

    public AuthorInfo? AuthorInfo { get; protected set; }

    public ImmutableDictionary<string, PakFile> Files { get; private set; } = ImmutableDictionary<string, PakFile>.Empty;

    protected Pak(Stream stream, byte[]? key, int version)
    {
        this.stream = stream;
        this.key = key;
        Version = version;
    }

    /// <summary>
    /// Parses the Pak file from the stream. Should be disposed after use, as it keeps the file open (currently at least).
    /// </summary>
    /// <param name="stream">Stream.</param>
    /// <param name="key">Key for decryption.</param>
    /// <param name="computeKey">Expects the key to be a "base" key and will calculate the actual decryption key if set to <see langword="true"/>. Use <see langword="false"/> if you already have the computed key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task. The task result contains the parsed Pak format.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="stream"/> is null.</exception>
    /// <exception cref="NotAPakException">Stream is not Pak-formatted.</exception>
    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    public static async Task<Pak> ParseAsync(Stream stream, byte[]? key = null, bool computeKey = true, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);

        var r = new AsyncGbxReader(stream);

        if (!await r.ReadPakMagicAsync(cancellationToken))
        {
            throw new NotAPakException();
        }

        var version = await r.ReadInt32Async(cancellationToken);

        if (key is not null && computeKey)
        {
            key = MD5.Compute(Encoding.ASCII.GetBytes(Convert.ToHexString(key) + Magic));
        }

        var pak = version < 6
            ? new Pak(stream, key, version)
            : new Pak6(stream, key, version);

        await pak.ReadHeaderAsync(stream, r, version, cancellationToken);

        return pak;
    }

    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    internal virtual async Task ReadHeaderAsync(Stream stream, AsyncGbxReader r, int version, CancellationToken cancellationToken)
    {
        if (!IsHeaderEncrypted)
        {
            await ReadHeaderAsync(stream, cancellationToken);
            return;
        }

        byte[] keyForHeader;
        if (version >= 18 && !IsHeaderPrivate)
        {
            keyForHeader = headerKey;
        }
        else if (key is null)
        {
            return;
        }
        else if (version < 6) // || !UseDefaultHeaderKey ??
        {
            keyForHeader = key;
        }
        else
        {
            keyForHeader = new byte[key.Length];
            Array.Copy(key, keyForHeader, key.Length);

            for (var i = 0; i < 16; i++)
            {
                keyForHeader[i] ^= headerKey[i];
            }
        }

        var iv = await r.ReadUInt64Async(cancellationToken);
        var blowfishStream = new BlowfishStream(stream, keyForHeader, iv, version == 18);

        await ReadHeaderAsync(blowfishStream, cancellationToken);
    }

    /// <summary>
    /// Parses the Pak file from file path. Should be disposed after use, as it keeps the file open (currently at least).
    /// </summary>
    /// <param name="filePath">File path.</param>
    /// <param name="key">Key for decryption.</param>
    /// <param name="computeKey">Expects the key to be a "base" key and will calculate the actual decryption key if set to <see langword="true"/>. Use <see langword="false"/> if you already have the computed key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task. The task result contains the parsed Pak format.</returns>
    /// <exception cref="ArgumentNullException"><paramref name="filePath"/> is null.</exception>
    /// <exception cref="NotAPakException">Stream is not Pak-formatted.</exception>
    public static async Task<Pak> ParseAsync(string filePath, byte[]? key = null, bool computeKey = true, CancellationToken cancellationToken = default)
    {
        var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read, bufferSize: 4096, useAsync: true);
        return await ParseAsync(fs, key, computeKey, cancellationToken);
    }

    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    private async Task ReadHeaderAsync(Stream stream, CancellationToken cancellationToken)
    {
        var r = new AsyncGbxReader(stream);

        HeaderMD5 = await r.ReadBytesAsync(16, cancellationToken);
        GbxHeadersStart = await r.ReadUInt32Async(cancellationToken); // offset to metadata section

        if (Version < 15)
        {
            HeaderMaxSize = await r.ReadInt32Async(cancellationToken); // data start
        }

        if (Version >= 2)
        {
            GbxHeadersSize = await r.ReadInt32Async(cancellationToken);
            GbxHeadersComprSize = await r.ReadInt32Async(cancellationToken);
        }

        if (Version >= 14)
        {
            await r.ReadBytesAsync(16, cancellationToken); // unused

            if (Version >= 16)
            {
                Size = await r.ReadUInt32Async(cancellationToken);
            }
        }

        if (Version >= 3)
        {
            await r.ReadBytesAsync(16, cancellationToken); // unused

            if (Version == 6)
            {
                AuthorInfo = await ReadAuthorInfoAsync(r, cancellationToken);
            }
        }

        Flags = await r.ReadUInt32Async(cancellationToken);

        var allFolders = await ReadAllFoldersAsync(r, cancellationToken);

        if (allFolders.Length > 2 && allFolders[2].Name.Length > 4)
        {
            var nameBytes = Encoding.Unicode.GetBytes(allFolders[2].Name);

            if (stream is IEncryptionInitializer encryptionInitializer)
            {
                encryptionInitializer.Initialize(nameBytes, 4, 4);
            }
        }

        Files = await ReadAllFilesAsync(r, allFolders, cancellationToken);
    }

    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    internal static async Task<AuthorInfo> ReadAuthorInfoAsync(AsyncGbxReader r, CancellationToken cancellationToken)
    {
        return new AuthorInfo
        {
            AuthorVersion = await r.ReadInt32Async(cancellationToken),
            AuthorLogin = await r.ReadStringAsync(cancellationToken),
            AuthorNickname = await r.ReadStringAsync(cancellationToken),
            AuthorZone = await r.ReadStringAsync(cancellationToken),
            AuthorExtraInfo = await r.ReadStringAsync(cancellationToken)
        };
    }

    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    private static async Task<PakFolder[]> ReadAllFoldersAsync(AsyncGbxReader r, CancellationToken cancellationToken)
    {
        var numFolders = await r.ReadInt32Async(cancellationToken);
        var allFolders = new PakFolder[numFolders];

        for (var i = 0; i < numFolders; i++)
        {
            var parentFolderIndex = await r.ReadInt32Async(cancellationToken); // index into folders; -1 if this is a root folder
            var name = await r.ReadStringAsync(cancellationToken);

            if (!name.EndsWith('\\') && !name.EndsWith('/'))
            {
                name += '\\';
            }

            allFolders[i] = new PakFolder(name, parentFolderIndex == -1 ? null : parentFolderIndex);
        }

        return allFolders;
    }

    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    private async Task<ImmutableDictionary<string, PakFile>> ReadAllFilesAsync(AsyncGbxReader r, PakFolder[] allFolders, CancellationToken cancellationToken)
    {
        var files = ImmutableDictionary.CreateBuilder<string, PakFile>();

        var numFiles = await r.ReadInt32Async(cancellationToken);
        for (var i = 0; i < numFiles; i++)
        {
            var folderIndex = await r.ReadInt32Async(cancellationToken); // index into folders
            var name = (await r.ReadStringAsync(cancellationToken)).Replace('\\', Path.DirectorySeparatorChar); // should this replacement really happen?
            var u01 = await r.ReadInt32Async(cancellationToken);
            var uncompressedSize = await r.ReadInt32Async(cancellationToken);
            var compressedSize = await r.ReadInt32Async(cancellationToken);
            var offset = await r.ReadUInt32Async(cancellationToken);
            var classId = await r.ReadUInt32Async(cancellationToken); // indicates the type of the file
            var size = Version >= 17 ? await r.ReadInt32Async(cancellationToken) : default(int?);
            var checksum = Version >= 14 ? await r.ReadUInt128Async(cancellationToken) : default(UInt128?);

            var fileFlags = await r.ReadUInt64Async(cancellationToken);

            var folderPath = string.Join(Path.DirectorySeparatorChar, RecurseFoldersToParent(folderIndex, allFolders)
                .Reverse()
                .Select(f => f.Name.TrimEnd('\\')));
            var filePath = Path.Combine(folderPath, name);

            var file = new PakFile(name, folderPath, classId, offset, uncompressedSize, compressedSize, size, checksum, fileFlags);
            files[filePath] = file;
        }

        return files.ToImmutable();
    }

    private static IEnumerable<PakFolder> RecurseFoldersToParent(int folderIndex, PakFolder[] allFolders)
    {
        if (folderIndex == -1)
        {
            yield break;
        }

        var folder = allFolders[folderIndex];

        yield return folder;

        if (folder.ParentIndex is null)
        {
            yield break;
        }

        foreach (var f in RecurseFoldersToParent(folder.ParentIndex.Value, allFolders))
        {
            yield return f;
        }
    }

    public Stream OpenFile(PakFile file, out EncryptionInitializer? encryptionInitializer)
    {
        if (HeaderMaxSize is null)
            throw new Exception("Cannot open file.");

        encryptionInitializer = null;

        // How many raw (possibly encrypted) bytes to read from the shared PAK stream.
        // Blowfish encrypts in 8-byte blocks, so the PAK stores ceil(dataSize/8)*8 bytes.
        // Round up to the next 8-byte boundary so we capture all encrypted blocks.
        int ivSize = file.IsEncrypted ? 8 : 0;
        int dataSize = file.IsCompressed
            ? (file.CompressedSize > 0 ? file.CompressedSize : file.UncompressedSize)
            : (file.UncompressedSize > 0 ? file.UncompressedSize : file.CompressedSize);
        if (dataSize <= 0) dataSize = 65536;
        if (file.IsEncrypted) dataSize = (dataSize + 7) & ~7;  // align to Blowfish block
        if (file.IsCompressed) dataSize += 8;  // extra margin for compressed files

        var rawBuffer = new byte[ivSize + dataSize];
        int rawCount;

        // Read raw bytes inside the lock so concurrent requests don't race on stream.Position.
        lock (_streamLock)
        {
            stream.Position = HeaderMaxSize.Value + file.Offset;
            rawCount = 0;
            while (rawCount < rawBuffer.Length)
            {
                int n = stream.Read(rawBuffer, rawCount, rawBuffer.Length - rawCount);
                if (n == 0) break;
                rawCount += n;
            }
        }

        // Build a private source stream from the captured bytes.
        // For encrypted files we wrap in a private BlowfishStream so that GBX.ParseAsync can
        // call Initialize() at the right moment to update the 256-byte-boundary cipher state.
        Stream source;
        if (file.IsEncrypted)
        {
            if (rawCount < 8) throw new EndOfStreamException("Could not read IV from file.");
            var iv = BitConverter.ToUInt64(rawBuffer, 0);
            if (key is null) throw new Exception("Encryption key is missing");
            var encMs = new MemoryStream(rawBuffer, 8, rawCount - 8);
            var blowfish = new BlowfishStream(encMs, key, iv, Version == 18);
            encryptionInitializer = new EncryptionInitializer(blowfish);
            source = blowfish;
        }
        else
        {
            source = new MemoryStream(rawBuffer, 0, rawCount);
        }

        if (!file.IsCompressed)
        {
            return source;
        }

        if (Version >= 18)
        {
            // Version 18 uses a different iv-update formula; safe to decompress all at once.
            using var lz4 = new LZ4Stream(source, file.UncompressedSize);
            if (file.UncompressedSize > 0)
            {
                var buf = new byte[file.UncompressedSize];
                int total = 0;
                while (total < buf.Length)
                {
                    int n = lz4.Read(buf, total, buf.Length - total);
                    if (n == 0) break;
                    total += n;
                }
                return new MemoryStream(buf);
            }
            else
            {
                var tmp = new MemoryStream();
                lz4.CopyTo(tmp);
                tmp.Position = 0;
                return tmp;
            }
        }
        else
        {
            // Version < 18: NativeZlibStream (NativeSharpZlib) handles FDICT transparently
            // via native zlib inflate, including Nadeo's preset-dictionary variants.
            // For encrypted files, GBX.ParseAsync calls Initialize() on the BlowfishStream
            // while parsing the GBX header, correctly updating the cipher state before the
            // 256-byte boundary is reached in the compressed data.
            return new NativeZlibStream(source, CompressionMode.Decompress);
        }
    }

    private static byte[] DecompressLZ4(byte[] rawBytes, int rawCount, int uncompressedSize)
    {
        var ms = new MemoryStream(rawBytes, 0, rawCount);
        using var lz4 = new LZ4Stream(ms, uncompressedSize);

        if (uncompressedSize > 0)
        {
            var buf = new byte[uncompressedSize];
            int total = 0;
            while (total < buf.Length)
            {
                int n = lz4.Read(buf, total, buf.Length - total);
                if (n == 0) break;
                total += n;
            }
            return buf;
        }
        else
        {
            var chunk = new byte[65536];
            using var tmp = new MemoryStream();
            int n;
            while ((n = lz4.Read(chunk, 0, chunk.Length)) > 0)
                tmp.Write(chunk, 0, n);
            return tmp.ToArray();
        }
    }

    private static byte[]? TryDecompressZlib(byte[] rawBytes, int rawCount, int uncompressedSize)
    {
        try
        {
            var ms = new MemoryStream(rawBytes, 0, rawCount);
            using var zlib = new NativeZlibStream(ms, CompressionMode.Decompress);

            if (uncompressedSize > 0)
            {
                var buf = new byte[uncompressedSize];
                int total = 0;
                while (total < buf.Length)
                {
                    int n = zlib.Read(buf, total, buf.Length - total);
                    if (n == 0) break;
                    total += n;
                }
                return buf;
            }
            else
            {
                var chunk = new byte[65536];
                using var tmp = new MemoryStream();
                int n;
                while ((n = zlib.Read(chunk, 0, chunk.Length)) > 0)
                    tmp.Write(chunk, 0, n);
                return tmp.ToArray();
            }
        }
        catch
        {
            return null;
        }
    }

    private static byte[]? TryDecompressLZ4(byte[] rawBytes, int rawCount, int uncompressedSize)
    {
        try
        {
            var result = DecompressLZ4(rawBytes, rawCount, uncompressedSize);
            return IsGbx(result) ? result : null;
        }
        catch
        {
            return null;
        }
    }

    // For zlib data compressed with Nadeo's preset dictionary: prepend a DEFLATE stored block
    // containing LZ4_DICTIONARY so the decompressor's 32KB window is correctly seeded.
    private static byte[]? TryDecompressZlibWithDict(byte[] rawBytes, int rawCount, int uncompressedSize)
    {
        // Must start with a valid zlib CMF byte (method = deflate, low nibble = 8)
        if (rawCount < 2 || (rawBytes[0] & 0x0F) != 8) return null;
        if (((rawBytes[0] << 8) | rawBytes[1]) % 31 != 0) return null;

        // Skip zlib header (2 bytes) and optional dict checksum (4 bytes if FDICT flag set)
        bool hasFDict = (rawBytes[1] & 0x20) != 0;
        int dataOffset = hasFDict ? 6 : 2;
        if (rawCount <= dataOffset) return null;

        // Build combined stream: [stored block with LZ4_DICTIONARY] + [raw deflate data]
        // DEFLATE stored block: 1 byte flags (BFINAL=0, BTYPE=00) + 2 bytes LEN + 2 bytes NLEN + data
        byte[] dict = LZ4Stream.LZ4_DICTIONARY;
        ushort len = (ushort)Math.Min(dict.Length, 0xFFFF);
        int realLen = rawCount - dataOffset;
        var combined = new byte[5 + len + realLen];
        combined[0] = 0x00;                             // BFINAL=0, BTYPE=00, 5-bit padding
        combined[1] = (byte)(len & 0xFF);
        combined[2] = (byte)(len >> 8);
        combined[3] = (byte)((~len) & 0xFF);
        combined[4] = (byte)((~len) >> 8);
        Array.Copy(dict, 0, combined, 5, len);
        Array.Copy(rawBytes, dataOffset, combined, 5 + len, realLen);

        try
        {
            var ms = new MemoryStream(combined);
            using var deflate = new System.IO.Compression.DeflateStream(
                ms, System.IO.Compression.CompressionMode.Decompress);

            // Skip the dict bytes that are output before the real content
            var skip = new byte[len];
            int skipped = 0;
            while (skipped < len)
            {
                int n = deflate.Read(skip, skipped, len - skipped);
                if (n == 0) return null;
                skipped += n;
            }

            if (uncompressedSize > 0)
            {
                var result = new byte[uncompressedSize];
                int total = 0;
                while (total < result.Length)
                {
                    int n = deflate.Read(result, total, result.Length - total);
                    if (n == 0) break;
                    total += n;
                }
                return (total > 0 && IsGbx(result)) ? result : null;
            }
            else
            {
                var chunk = new byte[65536];
                using var tmp = new MemoryStream();
                int n;
                while ((n = deflate.Read(chunk, 0, chunk.Length)) > 0) tmp.Write(chunk, 0, n);
                var arr = tmp.ToArray();
                return (arr.Length > 0 && IsGbx(arr)) ? arr : null;
            }
        }
        catch
        {
            return null;
        }
    }

    // Validates GBX magic + version range + byte-format char to reject garbage output from fallback decompressors.
    private static bool IsGbx(byte[] data)
    {
        if (data.Length < 9) return false;
        if (data[0] != 0x47 || data[1] != 0x42 || data[2] != 0x58) return false; // "GBX"
        var version = (ushort)(data[3] | (data[4] << 8));
        if (version < 2 || version > 12) return false; // TMUF era: versions 2-10ish
        if (data[5] != 0x45 && data[5] != 0x42) return false; // 'E' (little-endian) or 'B' (big-endian)
        if (data[6] != 0x43 && data[6] != 0x55 && data[6] != 0x52) return false; // 'C', 'U', or 'R'
        return true;
    }

    /// <summary>
    /// Attempts to open the Gbx file from Pak. If the file is not a Gbx file, <see cref="NotAGbxException"/> is thrown.
    /// </summary>
    /// <param name="file"></param>
    /// <param name="settings"></param>
    /// <param name="importExternalNodesFromRefTable"></param>
    /// <param name="fileHashes"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    public async Task<Gbx> OpenGbxFileAsync(PakFile file, GbxReadSettings settings = default, bool importExternalNodesFromRefTable = false, IDictionary<string, string>? fileHashes = default, CancellationToken cancellationToken = default)
    {
        using var stream = OpenFile(file, out var encryptionInitializer);

        if (!file.DontUseDummyWrite)
        {
            settings = settings with { EncryptionInitializer = encryptionInitializer };
        }

        var gbx = await Gbx.ParseAsync(stream, settings, cancellationToken);

        if (gbx.RefTable is not null && importExternalNodesFromRefTable)
        {
            // this can miss some files from other Pak files
            ImportExternalNodesFromRefTable(this, file, gbx.RefTable, settings, fileHashes);
        }

        return gbx;
    }

    private static void ImportExternalNodesFromRefTable(Pak pak, PakFile file, GbxRefTable refTable, GbxReadSettings settings, IDictionary<string, string>? fileHashes)
    {
        // Use platform separator so lookups match pak.Files keys (which use Path.DirectorySeparatorChar).
        // On WASM the separator is '/' but the GBX ref-table stores '\' — normalise everything.
        char sep = Path.DirectorySeparatorChar;
        var ancestor = string.Join(sep, Enumerable.Repeat("..", refTable.AncestorLevel));
        var currentFileName = fileHashes?.TryGetValue(file.Name, out var resolvedFileName) == true ? resolvedFileName : file.Name;
        var normalizedCurrentFileName = currentFileName.Replace('\\', sep).Replace('/', sep);
        var currentFileFolderPath = Path.GetDirectoryName(normalizedCurrentFileName);
        var currentPakFileFolderPath = string.IsNullOrEmpty(currentFileFolderPath) ? file.FolderPath : Path.Combine(file.FolderPath, currentFileFolderPath);

        foreach (var refTableFile in refTable.Files)
        {
            // Normalise the ref-table path so Path.Combine works correctly on every platform.
            var normalizedRefPath = refTableFile.FilePath.Replace('\\', sep).Replace('/', sep);
            var filePath = Path.GetRelativePath(Directory.GetCurrentDirectory(), Path.Combine(currentPakFileFolderPath, ancestor, normalizedRefPath));

            if (!pak.Files.TryGetValue(filePath, out var refTableFileInPak))
            {
                var directoryPath = Path.GetDirectoryName(filePath);
                var fileName = Path.GetFileName(filePath);

                while (true)
                {
                    var hash = MD5.Compute136(fileName);

                    var lookupKey = string.IsNullOrEmpty(directoryPath)
                        ? hash
                        : directoryPath + sep + hash;

                    if (pak.Files.TryGetValue(lookupKey, out refTableFileInPak))
                    {
                        break;
                    }

                    fileName = Path.Combine(Path.GetFileName(directoryPath ?? "")!, fileName);
                    directoryPath = Path.GetDirectoryName(directoryPath);

                    if (string.IsNullOrEmpty(directoryPath))
                    {
                        break;
                    }
                }
            }

            if (refTableFileInPak is null)
            {
                continue;
            }

            refTable.ExternalNodes.Add(refTableFile.FilePath, () => pak.OpenGbxFile(refTableFileInPak, settings));
        }
    }

    public Gbx OpenGbxFileHeader(PakFile file, GbxReadSettings settings = default)
    {
        using var stream = OpenFile(file, out var encryptionInitializer);
        return Gbx.ParseHeader(stream, settings with { EncryptionInitializer = encryptionInitializer });
    }

    [Zomp.SyncMethodGenerator.CreateSyncVersion]
    public async Task<bool> CheckFileIsGbxAsync(PakFile file, CancellationToken cancellationToken = default)
    {
        using var stream = OpenFile(file, out var _);
        return await Gbx.IsGbxAsync(stream, cancellationToken);
    }

    public void Dispose()
    {
        stream.Dispose();
    }

#if NET5_0_OR_GREATER
    public async ValueTask DisposeAsync()
    {
        await stream.DisposeAsync();
    }
#endif

    /// <summary>
    /// 
    /// </summary>
    /// <param name="directoryPath"></param>
    /// <param name="game"></param>
    /// <param name="progress"></param>
    /// <param name="keepUnresolvedHashes"></param>
    /// <param name="cancellationToken"></param>
    /// <returns>Dictionary where the key is the hash (file name) and value is the true resolved file name.</returns>
    public static async Task<Dictionary<string, string>> BruteforceFileHashesAsync(
        string directoryPath,
        PakListGame game = PakListGame.TM,
        IProgress<KeyValuePair<string, string>>? progress = null,
        bool keepUnresolvedHashes = false,
        CancellationToken cancellationToken = default)
    {
        var pakListFilePath = Path.Combine(directoryPath, PakList.FileName);

        if (!File.Exists(pakListFilePath))
        {
            return [];
        }

        var pakList = await PakList.ParseAsync(pakListFilePath, game, cancellationToken);

        return await BruteforceFileHashesAsync(directoryPath,
            pakList.ToDictionary(x => x.Key, x => (byte[]?)Convert.FromHexString(x.Value.Key)),
            progress,
            keepUnresolvedHashes,
            cancellationToken);
    }

    /// <summary>
    /// 
    /// </summary>
    /// <param name="directoryPath"></param>
    /// <param name="keys"></param>
    /// <param name="progress"></param>
    /// <param name="keepUnresolvedHashes"></param>
    /// <param name="cancellationToken"></param>
    /// <returns>Dictionary where the key is the hash (file name) and value is the true resolved file name.</returns>
    public static async Task<Dictionary<string, string>> BruteforceFileHashesAsync(
        string directoryPath,
        Dictionary<string, byte[]?> keys,
        IProgress<KeyValuePair<string, string>>? progress = null,
        bool keepUnresolvedHashes = false,
        CancellationToken cancellationToken = default)
    {
        var allPossibleFileHashes = new Dictionary<string, string>();
        var foundFileNames = new List<string>();

        await foreach (var (pak, file) in EnumeratePakFilesAsync(directoryPath, keys, cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested(); 
            
            foundFileNames.Add(file.Name);

            // only gbx files can be checked for reference table
            if (!await pak.CheckFileIsGbxAsync(file, cancellationToken))
            {
                continue;
            }

            Gbx gbx;
            try
            {
                gbx = pak.OpenGbxFileHeader(file);
            }
            catch (NotAGbxException)
            {
                continue;
            }
            catch (Exception)
            {
                continue;
            }

            if (gbx.RefTable is null)
            {
                continue;
            }

            foreach (var refTableFile in gbx.RefTable.Files)
            {
                var filePath = refTableFile.FilePath.Replace('/', '\\');

                var hash = MD5.Compute136(filePath);
                if (!allPossibleFileHashes.ContainsKey(hash))
                {
                    progress?.Report(new KeyValuePair<string, string>(hash, filePath));
                    allPossibleFileHashes[hash] = filePath;
                }

                var filePathDir = Path.GetDirectoryName(file.Name);
                if (!string.IsNullOrEmpty(filePathDir))
                {
                    var filePathWithDir = $"{filePathDir}\\{filePath}";
                    hash = MD5.Compute136(filePathWithDir);
                    if (!allPossibleFileHashes.ContainsKey(hash))
                    {
                        progress?.Report(new KeyValuePair<string, string>(hash, filePathWithDir));
                        allPossibleFileHashes[hash] = filePathWithDir;
                    }
                }

                while (filePath.Contains('\\'))
                {
                    filePath = filePath.Substring(filePath.IndexOf('\\') + 1);
                    hash = MD5.Compute136(filePath);

                    if (!allPossibleFileHashes.ContainsKey(hash))
                    {
                        progress?.Report(new KeyValuePair<string, string>(hash, filePath));
                        allPossibleFileHashes[hash] = filePath;
                    }
                }
            }
        }

        var usedHashes = new Dictionary<string, string>();

        foreach (var fileName in foundFileNames)
        {
            if (allPossibleFileHashes.TryGetValue(fileName, out var name))
            {
                usedHashes[fileName] = name;
            }
            else if (keepUnresolvedHashes && HashGuessRegex().IsMatch(fileName))
            {
                usedHashes[fileName] = "";
            }
        }

        return usedHashes;
    }

    private static async IAsyncEnumerable<(Pak, PakFile)> EnumeratePakFilesAsync(
        string directoryPath,
        Dictionary<string, byte[]?> keys, 
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (var filePath in Directory.EnumerateFiles(directoryPath)
            .Where(x => x.EndsWith(".pak", StringComparison.OrdinalIgnoreCase) || x.EndsWith(".Pack.Gbx", StringComparison.OrdinalIgnoreCase)))
        {
            var identifier = Path.GetFileNameWithoutExtension(filePath);
            var key = keys.GetValueOrDefault(identifier);

            if (key is null)
            {

            }

            await using var pak = await ParseAsync(filePath, key, cancellationToken: cancellationToken);

            foreach (var file in pak.Files.Values)
            {
                yield return (pak, file);
            }
        }
    }

    [GeneratedRegex("^[0-9a-fA-F]{34}$")]
    private static partial Regex HashGuessRegex();
}