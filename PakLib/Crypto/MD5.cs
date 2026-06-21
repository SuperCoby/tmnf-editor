using System.Text;

namespace GBX.NET.Crypto;

// Implémentation pure C# de MD5 — compatible WASM (pas de System.Security.Cryptography.MD5)
public static partial class MD5
{
    public static byte[] Compute(byte[] data) => ComputeManaged(data, 0, data.Length);

    public static byte[] Compute(Span<byte> data) => ComputeManaged(data.ToArray(), 0, data.Length);

    public static int Compute(Span<byte> data, Span<byte> destination)
    {
        var hash = Compute(data);
        hash.CopyTo(destination);
        return hash.Length;
    }

    public static byte[] Compute(string data) => Compute(Encoding.ASCII.GetBytes(data));

    public static Task<byte[]> ComputeAsync(byte[] data, CancellationToken cancellationToken = default)
        => Task.FromResult(Compute(data));

    public static Task<byte[]> ComputeAsync(string data, CancellationToken cancellationToken = default)
        => Task.FromResult(Compute(Encoding.ASCII.GetBytes(data)));

    public static string Compute136(string text)
    {
        var lowered = text.ToLowerInvariant();
        var bytes = Encoding.UTF8.GetBytes(lowered);
        var hashWithoutLength = Compute(bytes);
        var hash = new byte[17];
        Buffer.BlockCopy(hashWithoutLength, 0, hash, 1, 16);
        hash[0] = (byte)bytes.Length;
        return ToHex(hash).ToString();
    }

    // ── Implémentation MD5 pure managée ───────────────────────────────────────

    private static readonly uint[] T = GenerateT();

    private static uint[] GenerateT()
    {
        var t = new uint[64];
        for (int i = 0; i < 64; i++)
            t[i] = (uint)(long)(4294967296.0 * Math.Abs(Math.Sin(i + 1)));
        return t;
    }

    private static readonly int[] S =
    [
        7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,
        5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,
        4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,
        6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21,
    ];

    private static byte[] ComputeManaged(byte[] input, int offset, int length)
    {
        // Copie + padding
        long bitLen = (long)length * 8;
        int padLen = length % 64 < 56 ? 56 - length % 64 : 120 - length % 64;
        var msg = new byte[length + padLen + 8];
        Buffer.BlockCopy(input, offset, msg, 0, length);
        msg[length] = 0x80;
        // longueur en bits sur 64 bits little-endian
        var bitsBytes = BitConverter.GetBytes(bitLen);
        if (!BitConverter.IsLittleEndian) Array.Reverse(bitsBytes);
        Buffer.BlockCopy(bitsBytes, 0, msg, msg.Length - 8, 8);

        uint a0 = 0x67452301u, b0 = 0xefcdab89u, c0 = 0x98badcfeu, d0 = 0x10325476u;

        for (int i = 0; i < msg.Length; i += 64)
        {
            var M = new uint[16];
            for (int j = 0; j < 16; j++)
                M[j] = BitConverter.ToUInt32(msg, i + j * 4);

            uint A = a0, B = b0, C = c0, D = d0;

            unchecked
            {
                for (int j = 0; j < 64; j++)
                {
                    uint F; int g;
                    if (j < 16)      { F = (B & C) | (~B & D);  g = j; }
                    else if (j < 32) { F = (D & B) | (~D & C);  g = (5 * j + 1) % 16; }
                    else if (j < 48) { F = B ^ C ^ D;            g = (3 * j + 5) % 16; }
                    else             { F = C ^ (B | ~D);          g = (7 * j) % 16; }

                    F += A + T[j] + M[g];
                    A = D; D = C; C = B;
                    B += (F << S[j]) | (F >> (32 - S[j]));
                }

                a0 += A; b0 += B; c0 += C; d0 += D;
            }
        }

        var result = new byte[16];
        void Write(uint v, int pos) { var b = BitConverter.GetBytes(v); if (!BitConverter.IsLittleEndian) Array.Reverse(b); Buffer.BlockCopy(b, 0, result, pos, 4); }
        Write(a0, 0); Write(b0, 4); Write(c0, 8); Write(d0, 12);
        return result;
    }

    private static Span<char> ToHex(Span<byte> value)
    {
        var str = new char[value.Length * 2];
        for (int i = 0; i < value.Length; i++)
        {
            str[i * 2]     = HexIntToChar((byte)(value[i] % 16));
            str[i * 2 + 1] = HexIntToChar((byte)(value[i] / 16));
        }
        return str;
    }

    private static char HexIntToChar(byte v) => v < 10 ? (char)(v + 48) : (char)(v + 55);
}
