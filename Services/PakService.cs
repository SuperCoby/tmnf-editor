using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.Engines.Plug;
using GBX.NET.PAK;
using System.Text;
using System.Text.Json;
using TmEssentials;

namespace TMNFeditor.Services;

public class PakService
{
    // Clés de déchiffrement par pak
    public static readonly Dictionary<string, string> PakKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Resource"] = "087480148E51B70DD83AF2D86F974FEF",
        ["Game"]     = "EB2EA8E276999116DEE4CAC13E97354D",
        ["Alpine"]   = "3CB15D69FF8BE9C2C14D93F9379BC8EE",
        ["Speed"]    = "1323243EB19404511B51BB62A2A2C38F",
        ["Rally"]    = "1DDD2185144D6AB1F232596AAD9E8C46",
        ["Island"]   = "BD267DA6DA7F790A8D597600DC1C8EA1",
        ["Coast"]    = "130BE6AAA08D844CB56E879F50F961E5",
        ["Bay"]      = "CF77EDFD5A6447BD91927FF03C229DE2",
        ["Stadium"]  = "21DA8E75B00B33FD68EFA7182FD2163F",
        ["Patch1"]   = "19ED4601E3E8E53CFB30E184C013B3DF",
    };

    // Paks qui ont des fichiers de mappings (block_variants + block_coord_sizes)
    public static readonly HashSet<string> PaksWithMappings = new(StringComparer.OrdinalIgnoreCase)
        { "Alpine", "Speed", "Rally", "Island", "Coast", "Bay", "Stadium" };

    // Cache en mémoire : pakName → données ouvertes
    private readonly Dictionary<string, CachedPak> _cache = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _lock = new(1, 1);

    // Cache des bytes DDS extraits (évite de ré-extraire la même texture à chaque bloc)
    private readonly Dictionary<string, byte[]> _textureCache = new(StringComparer.OrdinalIgnoreCase);

    // Cache des résultats de GenerateModelAsync — évite de ré-extraire le même solid
    private readonly Dictionary<(string, int), (string Obj, string Mtl, object Hier)> _modelCache = new();

    // Cache des textures par matériau — évite de ré-ouvrir les GBX partagés entre blocs
    private readonly Dictionary<string, Dictionary<string, string>> _materialTextureCache
        = new(StringComparer.OrdinalIgnoreCase);

    // Index inverse FileHashes : fileName → hashKey (O(1) au lieu de O(N))
    private Dictionary<string, string>? _fileNameIndex;

    // Mapping hash → vrai nom de fichier, chargé depuis FileHashes_TMUF.txt
    public Dictionary<string, string> FileHashes { get; } = new(StringComparer.OrdinalIgnoreCase);

    // Mappings de variants : pakName → { "BlockName|IsGround|Variant|SubVariant" → "SolidPath.Solid.Gbx" }
    private readonly Dictionary<string, Dictionary<string, string>> _blockVariantMaps
        = new(StringComparer.OrdinalIgnoreCase);

    // Lookup inverse : pakName → { solidPath normalisé → nom du bloc }
    private readonly Dictionary<string, Dictionary<string, string>> _solidToBlockName
        = new(StringComparer.OrdinalIgnoreCase);

    // Cache EditorHelper : pakName → { "solidIndex|blockName" → (indices, sameFolder) }
    private readonly Dictionary<string, Dictionary<string, (List<int> Indices, bool SameFolder)>> _editorHelperCache
        = new(StringComparer.OrdinalIgnoreCase);

    // Blocs Checkpoint qui n'ont pas d'EditorHelper
    // Blocs dont le nom contient "CheckpointRing" → jamais d'EditorHelper.
    private static bool IsNoEditorHelperBlock(string blockName) =>
        blockName.Contains("CheckpointRing", StringComparison.OrdinalIgnoreCase);

    private static readonly string[] _directionPrefixes = ["Down", "Left", "Right", "Up"];

    // Tailles de blocs : pakName → { "BlockName|IsGround" → [sx, sz, h] }
    private readonly Dictionary<string, Dictionary<string, int[]>> _blockCoordSizeMaps
        = new(StringComparer.OrdinalIgnoreCase);

    public void LoadBlockVariants(string pakName, string json)
    {
        var map = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (map == null) return;
        _blockVariantMaps[pakName] = new Dictionary<string, string>(map, StringComparer.OrdinalIgnoreCase);

        // Construit la lookup inverse solidPath → nom affiché (blockName + Air/Ground si pas déjà présent)
        var inverse = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in map)
        {
            var blockName = kv.Key.Split('|')[0];
            var normalizedSolid = kv.Value.Replace('\\', '/');

            // Extrait le nom du fichier sans les extensions .Solid.Gbx
            var solidFile = normalizedSolid.Split('/').Last();
            if (solidFile.EndsWith(".Solid.Gbx", StringComparison.OrdinalIgnoreCase))
                solidFile = solidFile[..^".Solid.Gbx".Length];

            // Ajoute "Air" ou "Ground" si le filename le précise et que le nom de bloc ne le contient pas déjà
            string suffix = "";
            if (solidFile.EndsWith("Air", StringComparison.OrdinalIgnoreCase) &&
                !blockName.EndsWith("Air", StringComparison.OrdinalIgnoreCase))
                suffix = "Air";
            else if (solidFile.EndsWith("Ground", StringComparison.OrdinalIgnoreCase) &&
                !blockName.EndsWith("Ground", StringComparison.OrdinalIgnoreCase))
                suffix = "Ground";

            inverse.TryAdd(normalizedSolid, blockName + suffix);
        }
        _solidToBlockName[pakName] = inverse;
    }

    public string? GetBlockNameForSolid(string pakName, string solidPath)
    {
        if (!_solidToBlockName.TryGetValue(pakName, out var map)) return null;
        var normalized = solidPath.Replace('\\', '/');
        return map.TryGetValue(normalized, out var name) ? name : null;
    }

    // Trouve les indices des solids EditorHelper correspondant au bloc.
    // SameFolder=true → EditorHelper dans le même dossier que le solid principal (pas de biais Y).
    // SameFolder=false → dossier différent ; la géométrie a un biais +CELL_V que le caller doit compenser (h+1).
    public (List<int> Indices, bool SameFolder) FindEditorHelperIndices(string pakName, int mainSolidIndex, string blockName)
    {
        static (List<int>, bool) Empty(bool sf = true) => ([], sf);

        if (IsNoEditorHelperBlock(blockName)) return Empty();
        if (!_cache.TryGetValue(pakName, out var cached)) return Empty();
        if (mainSolidIndex < 0 || mainSolidIndex >= cached.Solids.Count) return Empty();

        if (!_editorHelperCache.TryGetValue(pakName, out var pakCache))
            _editorHelperCache[pakName] = pakCache = new Dictionary<string, (List<int>, bool)>();
        var cacheKey = $"{mainSolidIndex}|{blockName}";
        if (pakCache.TryGetValue(cacheKey, out var cached2)) return cached2;

        var mainPath  = cached.Solids[mainSolidIndex].Name.Replace('\\', '/');
        var lastSlash = mainPath.LastIndexOf('/');
        if (lastSlash < 0) { pakCache[cacheKey] = Empty(); return Empty(); }

        var mainFile = mainPath[(lastSlash + 1)..];

        // Si le solid principal est lui-même un EditorHelper, ne pas chercher
        if (mainFile.StartsWith("EditorHelper", StringComparison.OrdinalIgnoreCase)
            || _directionPrefixes.Any(d => mainFile.StartsWith(d + "EditorHelper", StringComparison.OrdinalIgnoreCase)))
        {
            pakCache[cacheKey] = Empty(); return Empty();
        }

        // Préfixe directionnel depuis le nom du bloc
        // ex: StadiumRoadMainCheckpointDownAir → "Down"
        string dirPrefix = "";
        foreach (var dir in _directionPrefixes)
        {
            if (blockName.Contains("Checkpoint" + dir, StringComparison.OrdinalIgnoreCase)
                || blockName.Contains("Start" + dir, StringComparison.OrdinalIgnoreCase)
                || blockName.Contains("Finish" + dir, StringComparison.OrdinalIgnoreCase))
            {
                dirPrefix = dir;
                break;
            }
        }

        var folder = mainPath[..lastSlash];

        // ── Calcul du typeKeyword (commun aux 3 phases) ──────────────────────
        // Ex: "StadiumRoadMainCheckpointRightAir" → "RoadMain" → ["Road","Main"]
        // Permet de filtrer les EditorHelpers d'une mauvaise famille (ex: Platform vs Road).
        const int stadiumLen = 7;
        int specialIdx0 = blockName.IndexOf("Checkpoint", StringComparison.OrdinalIgnoreCase);
        if (specialIdx0 < 0) specialIdx0 = blockName.IndexOf("Start",  StringComparison.OrdinalIgnoreCase);
        if (specialIdx0 < 0) specialIdx0 = blockName.IndexOf("Finish", StringComparison.OrdinalIgnoreCase);
        var typeKeyword = specialIdx0 > stadiumLen ? blockName[stadiumLen..specialIdx0] : "";

        var typeWords = new List<string>();
        if (!string.IsNullOrEmpty(typeKeyword))
        {
            int ws0 = 0;
            for (int k = 1; k <= typeKeyword.Length; k++)
            {
                if (k == typeKeyword.Length || char.IsUpper(typeKeyword[k]))
                { typeWords.Add(typeKeyword[ws0..k]); ws0 = k; }
            }
        }

        // Retourne true si le dossier correspond à la famille du bloc (ou si aucun typeKeyword).
        bool FolderMatchesFamily(string f) =>
            typeWords.Count == 0
            || typeWords.All(w => f.Contains(w, StringComparison.OrdinalIgnoreCase));

        // ── Phase 1 : même dossier que le solid résolu ───────────────────────
        // Essai 1a : dirPrefix dans le nom de fichier (ex: Platform\Checkpoint\DownEditorHelper.Solid.Gbx)
        var result = SearchEditorHelpers(cached, folder, dirPrefix, mainSolidIndex);
        // Essai 1b : dirPrefix dans le nom de dossier → fichier générique EditorHelper (ex: Road\Main\CheckpointDown\EditorHelper.Solid.Gbx)
        if (result.Count == 0 && dirPrefix != ""
            && folder.EndsWith(dirPrefix, StringComparison.OrdinalIgnoreCase))
        {
            result = SearchEditorHelpers(cached, folder, "", mainSolidIndex);
        }
        if (result.Count > 0 && FolderMatchesFamily(folder))
        {
            var r = (result, true);
            pakCache[cacheKey] = r; return r;
        }

        // ── Phase 2 : dossier sibling (strip direction du nom de dossier) ────
        if (dirPrefix != "")
        {
            var lastSeg    = folder.Contains('/') ? folder[(folder.LastIndexOf('/') + 1)..] : folder;
            var parentPath = folder.Contains('/') ? folder[..folder.LastIndexOf('/')] : "";
            if (lastSeg.EndsWith(dirPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var siblingFolder = (string.IsNullOrEmpty(parentPath) ? "" : parentPath + "/")
                    + lastSeg[..^dirPrefix.Length];
                result = SearchEditorHelpers(cached, siblingFolder, dirPrefix, mainSolidIndex);
                if (result.Count > 0 && FolderMatchesFamily(siblingFolder))
                {
                    var r = (result, false);
                    pakCache[cacheKey] = r; return r;
                }
            }
        }

        // ── Phase 3 : recherche globale avec bonus par famille de bloc ──────────
        {
            var mainParts  = folder.Split('/', StringSplitOptions.RemoveEmptyEntries);
            int bestScore  = -1;
            var candidates = new List<int>();

            for (int i = 0; i < cached.Solids.Count; i++)
            {
                if (i == mainSolidIndex) continue;
                var sp = cached.Solids[i].Name.Replace('\\', '/');
                var ss = sp.LastIndexOf('/');
                if (ss < 0) continue;
                var sf      = sp[(ss + 1)..];
                var sfolder = sp[..ss];

                if (!sf.StartsWith(dirPrefix + "EditorHelper", StringComparison.OrdinalIgnoreCase)) continue;
                if (dirPrefix == "" && _directionPrefixes.Any(d => sf.StartsWith(d, StringComparison.OrdinalIgnoreCase))) continue;

                var candidateParts = sfolder.Split('/', StringSplitOptions.RemoveEmptyEntries);
                int score = 0;
                int maxLen = Math.Min(mainParts.Length, candidateParts.Length);
                for (int k = 0; k < maxLen; k++)
                {
                    if (mainParts[k].Equals(candidateParts[k], StringComparison.OrdinalIgnoreCase)) { score++; continue; }
                    // Bonus partiel : nb de chars en commun entre les segments divergents
                    // Ex: "StartLine" vs "Start" → +5, "StartLine" vs "CheckpointDown" → +0
                    var ms = mainParts[k]; var cs = candidateParts[k];
                    int pLen = Math.Min(ms.Length, cs.Length), p = 0;
                    while (p < pLen && char.ToUpperInvariant(ms[p]) == char.ToUpperInvariant(cs[p])) p++;
                    score += p;
                    break;
                }

                if (typeWords.Count > 0
                    && typeWords.All(w => sfolder.Contains(w, StringComparison.OrdinalIgnoreCase)))
                    score += 1000;

                if (score > bestScore)       { bestScore = score; candidates = [i]; }
                else if (score == bestScore)  { candidates.Add(i); }
            }

            result = bestScore >= (typeWords.Count > 0 ? 1000 : 0) ? candidates : [];
        }

        {
            var r = (result, false);  // dossier différent → biais Y probable
            pakCache[cacheKey] = r; return r;
        }
    }

    private static List<int> SearchEditorHelpers(
        CachedPak cached, string folder, string dirPrefix, int excludeIndex)
    {
        var result = new List<int>();
        for (int i = 0; i < cached.Solids.Count; i++)
        {
            if (i == excludeIndex) continue;
            var solidPath   = cached.Solids[i].Name.Replace('\\', '/');
            var solidSlash  = solidPath.LastIndexOf('/');
            var solidFolder = solidSlash >= 0 ? solidPath[..solidSlash] : "";
            var solidFile   = solidSlash >= 0 ? solidPath[(solidSlash + 1)..] : solidPath;

            if (!solidFolder.Equals(folder, StringComparison.OrdinalIgnoreCase)) continue;
            if (!solidFile.StartsWith(dirPrefix + "EditorHelper", StringComparison.OrdinalIgnoreCase)) continue;
            if (dirPrefix == "" && _directionPrefixes.Any(d => solidFile.StartsWith(d, StringComparison.OrdinalIgnoreCase))) continue;

            result.Add(i);
        }
        return result;
    }

public void LoadBlockCoordSizes(string pakName, string json)
    {
        var map = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, int[]>>(json,
            new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (map != null)
            _blockCoordSizeMaps[pakName] = new Dictionary<string, int[]>(map, StringComparer.OrdinalIgnoreCase);
    }

    public (int Sx, int Sz, int H) GetBlockCoordSize(string pakName, string blockName, bool isGround)
    {
        if (_blockCoordSizeMaps.TryGetValue(pakName, out var sizeMap))
        {
            var key = $"{blockName}|{isGround}";
            if (sizeMap.TryGetValue(key, out var cs) && cs.Length >= 2)
                return (cs[0], cs[1], cs.Length > 2 ? cs[2] : 0);
        }
        return (1, 1, 0);
    }

    public void LoadFileHashes(string content)
    {
        FileHashes.Clear();
        _fileNameIndex = null;
        foreach (var line in content.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 2) FileHashes[parts[0]] = parts[1];
        }
    }

    // Lookup O(1) au lieu du FirstOrDefault O(N) sur FileHashes
    private string? FindHashKey(string fileName)
    {
        if (_fileNameIndex == null)
        {
            _fileNameIndex = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kvp in FileHashes)
                _fileNameIndex.TryAdd(Path.GetFileName(kvp.Value), kvp.Key);
        }
        return _fileNameIndex.TryGetValue(fileName, out var key) ? key : null;
    }

    // Ouvre un pak depuis des octets bruts (File System API → byte[] → MemoryStream)
    public async Task<CachedPak?> OpenPakAsync(string pakName, byte[] pakBytes)
    {
        await _lock.WaitAsync();
        try
        {
            if (_cache.TryGetValue(pakName, out var cached)) return cached;

            if (!PakKeys.TryGetValue(pakName, out var keyHex)) return null;
            var key = Convert.FromHexString(keyHex);

            // Ne pas disposer le stream : Pak le garde ouvert pour lire les fichiers à la demande
            var stream = new MemoryStream(pakBytes);
            var pak = await Pak.ParseAsync(stream, key);

            var solids = new List<SolidEntry>();
            foreach (var file in pak.Files.Values)
            {
                var realName = FileHashes.GetValueOrDefault(file.Name, file.Name);
                if (realName.EndsWith(".Solid.Gbx", StringComparison.OrdinalIgnoreCase))
                    solids.Add(new SolidEntry(realName, file));
            }
            solids = [.. solids.OrderBy(s => s.Name)];

            var result = new CachedPak(pak, solids, stream);
            _cache[pakName] = result;
            return result;
        }
        finally { _lock.Release(); }
    }

    public void ClearCache()
    {
        foreach (var entry in _cache.Values) entry.Stream.Dispose();
        _cache.Clear();
        _textureCache.Clear();
        _modelCache.Clear();
        _materialTextureCache.Clear();
        _editorHelperCache.Clear();
        _fileNameIndex = null;
    }

    public CachedPak? GetCached(string pakName)
        => _cache.TryGetValue(pakName, out var v) ? v : null;

    public bool IsModelCached(string pakName, int index)
        => _modelCache.ContainsKey((pakName, index));

    // Injecte une entrée IDB dans le cache mémoire (évite le re-parsing GBX pour les sessions suivantes)
    public void SetModelCache(string pakName, int index, string obj, string mtl)
        => _modelCache[(pakName, index)] = (obj, mtl, new Dictionary<string, object>());

    // Pré-indexe tous les solids d'un pak en tâche de fond (avec yields pour ne pas bloquer l'UI)
    public async Task PreIndexPakAsync(string pakName, CancellationToken ct = default)
    {
        if (!_cache.TryGetValue(pakName, out var cached)) return;
        for (int i = 0; i < cached.Solids.Count; i++)
        {
            if (ct.IsCancellationRequested) return;
            await Task.Yield();
            if (_modelCache.ContainsKey((pakName, i))) continue;
            try { await GenerateModelAsync(pakName, i); } catch { }
        }
    }

    // Génère OBJ + MTL pour un solid
    public async Task<(string Obj, string Mtl, object Hierarchy)?> GenerateModelAsync(string pakName, int index)
    {
        if (!_cache.TryGetValue(pakName, out var cached)) return null;
        if (index < 0 || index >= cached.Solids.Count) return null;

        var modelKey = (pakName, index);
        if (_modelCache.TryGetValue(modelKey, out var cachedModel)) return cachedModel;

        var (name, file) = cached.Solids[index];
        var gbx = await cached.Pak.OpenGbxFileAsync(file, importExternalNodesFromRefTable: true);
        if (gbx.Node is not CPlugSolid solid) return null;

        await Task.Yield(); // libère le thread avant ExportToObj (synchrone, potentiellement lent)
        using var objWriter = new StringWriter();
        using var mtlWriter = new StringWriter();
        solid.ExportToObj(objWriter, mtlWriter);

        var objText = objWriter.ToString();
        var mtlText = await EnrichMtlWithTexturesAsync(solid, mtlWriter.ToString(), cached.Pak, pakName);
        var hierarchy = ExtractHierarchy(solid);

        var result = (objText, mtlText, hierarchy);
        _modelCache[modelKey] = result;
        return result;
    }

    // Enrichit le MTL avec les noms de fichiers de textures (async pour éviter deadlock en WASM)
    private async Task<string> EnrichMtlWithTexturesAsync(CPlugSolid solid, string mtlContent, Pak pak, string pakName)
    {
        var tree = solid.Tree as CPlugTree;
        if (tree == null) return mtlContent;

        var materialTextures = new Dictionary<string, string>();

        var paksToSearch = new List<Pak> { pak };
        foreach (var (pk, c) in _cache)
            if (!pk.Equals(pakName, StringComparison.OrdinalIgnoreCase)) paksToSearch.Add(c.Pak);

        async Task LoadMatAsync(string matName)
        {
            if (_materialTextureCache.TryGetValue(matName, out var cached))
            {
                foreach (var kv in cached) materialTextures[kv.Key] = kv.Value;
                return;
            }

            var matResult = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var baseKey = matName.Replace(".Material", "");
            foreach (var p in paksToSearch)
            {
                await LoadMaterialFromPak(matName, matResult, p);
                if (matResult.ContainsKey($"{baseKey}_diffuse") ||
                    matResult.ContainsKey($"{matName}_diffuse"))
                    break;
            }
            _materialTextureCache[matName] = matResult;
            foreach (var kv in matResult) materialTextures[kv.Key] = kv.Value;
        }

        // Dédupliquer les noms de matériaux avant d'ouvrir les GBX (évite N ouvertures pour le même fichier)
        var matNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (tree.ShaderFile != null)
            matNames.Add(Path.GetFileNameWithoutExtension(Path.GetFileName(tree.ShaderFile.GetFullPath())));
        foreach (var child in tree.GetAllChildren(includeVisualMipLevels: true))
            if (child.ShaderFile != null)
                matNames.Add(Path.GetFileNameWithoutExtension(Path.GetFileName(child.ShaderFile.GetFullPath())));

        foreach (var matName in matNames)
            await LoadMatAsync(matName);

        var lines = mtlContent.Split('\n').ToList();
        var enriched = new List<string>();
        string? currentMaterial = null;

        foreach (var line in lines)
        {
            enriched.Add(line);
            if (line.StartsWith("newmtl "))
                currentMaterial = line.Substring(7).Trim();
            else if (line.StartsWith("Kd ") && currentMaterial != null)
            {
                var diff   = FindTextureName(currentMaterial, "_diffuse",  ["", "_D", "1", "2"], materialTextures);
                var spec   = FindTextureName(currentMaterial, "_specular", ["_S", "2"],           materialTextures);
                var normal = FindTextureName(currentMaterial, "_normal",   ["_N", "N"],           materialTextures);
                if (diff   != null) enriched.Add($"map_Kd {diff}");
                if (spec   != null) enriched.Add($"map_Ks {spec}");
                if (normal != null) enriched.Add($"bump {normal}");
            }
        }

        return string.Join("\n", enriched);
    }

    private static string? FindTextureName(string matName, string kind, string[] suffixes, Dictionary<string, string> materialTextures)
    {
        if (materialTextures.TryGetValue($"{matName}{kind}", out var path)) return path;
        return null;
    }

    private async Task LoadMaterialFromPak(string materialName, Dictionary<string, string> result, Pak pak)
    {
        var materialFileName = $"{materialName}.Gbx";
        var hashKey = FindHashKey(materialFileName);
        if (hashKey == null) return;

        var pakFileKey = pak.Files.Keys.FirstOrDefault(k => k.Contains(hashKey));
        if (pakFileKey == null) return;

        try
        {
            var matFile = pak.Files[pakFileKey];
            var gbx = await pak.OpenGbxFileAsync(matFile, importExternalNodesFromRefTable: true);
            if (gbx.Node is CPlugMaterial material)
                ExtractTextureFromMaterial(materialName, material, result);
        }
        catch { }
    }

    private static void ExtractTextureFromMaterial(string materialName, CPlugMaterial material, Dictionary<string, string> result)
    {
        var baseName = materialName.Replace(".Material", "");
        if (material.CustomMaterial?.Textures == null) return;

        foreach (var bitmap in material.CustomMaterial.Textures)
        {
            if (bitmap.TextureFile == null) continue;
            var texPath = Path.GetFileName(bitmap.TextureFile.GetFullPath())
                ?.Replace(".Texture.gbx", ".dds", StringComparison.OrdinalIgnoreCase);
            if (texPath == null) continue;

            switch (bitmap.Name?.ToLowerInvariant() ?? "")
            {
                case "diffuse": case "blend1": case "d":
                    result[$"{baseName}_diffuse"]  = texPath; break;
                case "specular": case "s":
                    result[$"{baseName}_specular"] = texPath; break;
                case "normal": case "n": case "bump":
                    result[$"{baseName}_normal"]   = texPath; break;
                default:
                    result.TryAdd($"{baseName}_diffuse", texPath); break;
            }
        }
    }

    // Extrait les octets DDS des textures référencées dans un MTL, depuis les paks en cache
    public async Task<Dictionary<string, byte[]>> ExtractTexturesFromPakAsync(string mtlContent)
    {
        var result = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        var textureNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var line in mtlContent.Split('\n'))
        {
            var t = line.Trim();
            if ((t.StartsWith("map_Kd ") || t.StartsWith("map_Ks ") || t.StartsWith("bump "))
                && t.Contains(' '))
            {
                var fname = t[(t.IndexOf(' ') + 1)..].Trim();
                if (!string.IsNullOrEmpty(fname)) textureNames.Add(fname);
            }
        }

        foreach (var ddsName in textureNames)
        {
            var bytes = await TryExtractTextureBytesAsync(ddsName);
            if (bytes != null) result[ddsName] = bytes;
        }

        return result;
    }

    private async Task<byte[]?> TryExtractTextureBytesAsync(string ddsFilename)
    {
        if (_textureCache.TryGetValue(ddsFilename, out var cached)) return cached;

        var textureGbxName = Path.GetFileNameWithoutExtension(ddsFilename) + ".Texture.gbx";
        var hashEntry = FileHashes.FirstOrDefault(kvp =>
            Path.GetFileName(kvp.Value).Equals(textureGbxName, StringComparison.OrdinalIgnoreCase));
        if (hashEntry.Key == null) return null;

        foreach (var (_, c) in _cache)
        {
            var fileKey = c.Pak.Files.Keys.FirstOrDefault(k => k.Contains(hashEntry.Key));
            if (fileKey == null) continue;

            try
            {
                var pakFile = c.Pak.Files[fileKey];
                var gbx = await c.Pak.OpenGbxFileAsync(pakFile);
                if (gbx.Node is CPlugBitmap bitmap)
                {
                    var bytes = ExtractBitmapDdsBytes(bitmap);
                    if (bytes != null) { _textureCache[ddsFilename] = bytes; return bytes; }
                }
            }
            catch { }
        }

        return null;
    }

    private static byte[]? ExtractBitmapDdsBytes(CPlugBitmap bitmap)
    {
        var bf = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;

        foreach (var prop in bitmap.GetType().GetProperties(bf).Where(p => p.PropertyType == typeof(byte[])))
        {
            try
            {
                if (prop.GetValue(bitmap) is not byte[] data || data.Length < 128) continue;
                if (data[0] == 0x44 && data[1] == 0x44 && data[2] == 0x53 && data[3] == 0x20) return data;
                if (data.Length > 1024) return data;
            }
            catch { }
        }

        foreach (var field in bitmap.GetType().GetFields(bf).Where(f => f.FieldType == typeof(byte[])))
        {
            try
            {
                if (field.GetValue(bitmap) is not byte[] data || data.Length < 128) continue;
                if (data[0] == 0x44 && data[1] == 0x44 && data[2] == 0x53 && data[3] == 0x20) return data;
                if (data.Length > 1024) return data;
            }
            catch { }
        }

        return null;
    }

    // Parse un fichier .Challenge.Gbx et retourne les données de placement des blocs
    public async Task<ChallengeData?> ParseChallengeAsync(byte[] bytes)
    {
        var stream = new MemoryStream(bytes);
        Gbx gbx;
        try { gbx = await Gbx.ParseAsync(stream); }
        catch { return null; }

        if (gbx.Node is not CGameCtnChallenge challenge) return null;

        var blocks = new List<ChallengeBlock>();
        foreach (var block in challenge.Blocks ?? [])
        {
            if (string.IsNullOrEmpty(block.Name)) continue;
            blocks.Add(new ChallengeBlock(
                Name: block.Name,
                X: block.Coord.X,
                Y: block.Coord.Y,
                Z: block.Coord.Z,
                Dir: (int)block.Direction,
                IsGround: block.IsGround,
                Variant: block.Variant,
                SubVariant: block.SubVariant
            ));
        }

        // Extraire les blocs Triangles3D depuis les clips MediaTracker
        var tri3dBlocks = new List<Tri3DBlock>();
        var allTracks = new List<TrackInfo>();

        void ExtractFromTracks(IEnumerable<CGameCtnMediaTrack>? tracks, string clipType, string clipName)
        {
            if (tracks == null) return;
            foreach (var track in tracks)
            {
                if (track?.Blocks == null) continue;
                var trackName = track.Name ?? "";
                bool hasTri3D = false;
                foreach (var block in track.Blocks)
                {
                    if (block is not CGameCtnMediaBlockTriangles3D tri) continue;
                    if (tri.Vertices.Length == 0 || tri.Keys.Count == 0) continue;

                    int meshIndex = tri3dBlocks.Count;
                    var verts = tri.Vertices.Select(v => new Tri3DVertex(v.X, v.Y, v.Z, v.W)).ToArray();
                    var indices = tri.Triangles.SelectMany(t => new[] { t.X, t.Y, t.Z }).ToArray();
                    var keyframes = tri.Keys.Select(k => new Tri3DKeyframe(
                        k.Time.TotalSeconds,
                        k.Positions.SelectMany(p => new[] { p.X, p.Y, p.Z }).ToArray()
                    )).ToArray();

                    tri3dBlocks.Add(new Tri3DBlock(clipType, clipName, trackName, verts, indices, keyframes));
                    allTracks.Add(new TrackInfo(clipType, clipName, trackName, meshIndex));
                    hasTri3D = true;
                }
                if (!hasTri3D)
                    allTracks.Add(new TrackInfo(clipType, clipName, trackName, -1));
            }
        }

        try
        {
            ExtractFromTracks(challenge.ClipIntro?.Tracks, "Intro", challenge.ClipIntro?.Name ?? "Intro");

            if (challenge.ClipGroupInGame?.Clips != null)
                foreach (var c in challenge.ClipGroupInGame.Clips)
                    ExtractFromTracks(c.Clip?.Tracks, "In Game", c.Clip?.Name ?? "");

            if (challenge.ClipGroupEndRace?.Clips != null)
                foreach (var c in challenge.ClipGroupEndRace.Clips)
                    ExtractFromTracks(c.Clip?.Tracks, "End Race", c.Clip?.Name ?? "");

            ExtractFromTracks(challenge.ClipGlobal?.Tracks, "Global", challenge.ClipGlobal?.Name ?? "Global");
        }
        catch { }

        return new ChallengeData(
            MapName: challenge.MapName ?? "Carte",
            SizeX: challenge.Size.X,
            SizeZ: challenge.Size.Z,
            Blocks: blocks,
            Triangles3D: tri3dBlocks,
            AllTracks: allTracks
        );
    }

    // Résout blockName + isGround + variant → (pakName, solidIndex)
    public (string Pak, int Index)? ResolveBlock(string blockName, bool isGround, int variant = 0, int subVariant = 0)
    {
        var preferredPak = PakKeys.Keys.FirstOrDefault(p =>
            blockName.StartsWith(p, StringComparison.OrdinalIgnoreCase));

        // 1. Via mapping de variants (approche principale)
        if (preferredPak != null && _blockVariantMaps.TryGetValue(preferredPak, out var varMap))
        {
            var solidPath = ResolveSolidPathFromVariantMap(varMap, blockName, isGround, variant, subVariant);
            if (solidPath != null && GetCached(preferredPak) is { } cached)
            {
                var idx = cached.Solids.FindIndex(s =>
                    s.Name.Equals(solidPath, StringComparison.OrdinalIgnoreCase) ||
                    s.Name.Replace('/', '\\').Equals(solidPath.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase));
                if (idx >= 0) return (preferredPak, idx);
            }
        }

        // 2. Fallback : matching par préfixe de nom (pour Alpine et paks avec noms complets dans FileHashes)
        if (preferredPak != null)
        {
            var cached = GetCached(preferredPak);
            if (cached != null)
            {
                var idx = FindSolidByNamePrefix(cached, blockName, isGround);
                if (idx >= 0) return (preferredPak, idx);
            }
        }

        // 3. Fallback tous paks ouverts
        foreach (var (pk, cached) in _cache)
        {
            if (pk.Equals(preferredPak, StringComparison.OrdinalIgnoreCase)) continue;
            var idx = FindSolidByNamePrefix(cached, blockName, isGround);
            if (idx >= 0) return (pk, idx);
        }

        return null;
    }

    private static string? ResolveSolidPathFromVariantMap(
        Dictionary<string, string> varMap, string blockName, bool isGround, int variant, int subVariant)
    {
        // Exact : blockName|isGround|variant|subVariant
        if (varMap.TryGetValue($"{blockName}|{isGround}|{variant}|{subVariant}", out var path)) return path;
        // Fallback subVariant 0
        if (subVariant != 0 && varMap.TryGetValue($"{blockName}|{isGround}|{variant}|0", out path)) return path;
        // Fallback variant 0, subVariant 0
        if (varMap.TryGetValue($"{blockName}|{isGround}|0|0", out path)) return path;
        // Fallback autre valeur isGround
        if (varMap.TryGetValue($"{blockName}|{!isGround}|{variant}|{subVariant}", out path)) return path;
        if (varMap.TryGetValue($"{blockName}|{!isGround}|0|0", out path)) return path;
        return null;
    }

    private static int FindSolidByNamePrefix(CachedPak cached, string blockName, bool isGround)
    {
        var suffix = isGround ? "Ground" : "Air";
        var idx = cached.Solids.FindIndex(s =>
        {
            var baseName = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(Path.GetFileName(s.Name)));
            return baseName.StartsWith(blockName + suffix, StringComparison.OrdinalIgnoreCase);
        });
        if (idx >= 0) return idx;
        return cached.Solids.FindIndex(s =>
        {
            var baseName = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(Path.GetFileName(s.Name)));
            return baseName.StartsWith(blockName, StringComparison.OrdinalIgnoreCase);
        });
    }

    // Hiérarchie pour le panneau d'info
    public static object ExtractHierarchy(CPlugSolid solid)
    {
        var tree = solid.Tree as CPlugTree;
        if (tree == null) return new { type = "empty", children = Array.Empty<object>() };
        return BuildTreeNode(tree, !string.IsNullOrEmpty(tree.Name) ? tree.Name : solid.GetType().Name);
    }

    private static object BuildTreeNode(CPlugTree tree, string name, int depth = 0)
    {
        var node = new Dictionary<string, object>
        {
            ["name"] = name,
            ["type"] = tree.GetType().Name,
            ["children"] = new List<object>()
        };

        if (tree.ShaderFile != null)
            node["material"] = Path.GetFileNameWithoutExtension(tree.ShaderFile.GetFullPath());

        var children = (List<object>)node["children"];

        if (tree is CPlugTreeVisualMip mip && mip.Levels?.Count > 0)
        {
            var lodGroup = new Dictionary<string, object>
            {
                ["name"] = "LOD", ["type"] = "LODGroup", ["children"] = new List<object>()
            };
            for (int i = 0; i < mip.Levels.Count; i++)
            {
                var level = mip.Levels[i];
                var levelChildren = new List<object>();
                if (level.Tree?.Children != null)
                    foreach (var c in level.Tree.Children)
                        levelChildren.Add(BuildTreeNode(c, !string.IsNullOrEmpty(c.Name) ? c.Name : c.GetType().Name, depth + 2));

                ((List<object>)lodGroup["children"]).Add(new Dictionary<string, object>
                {
                    ["name"] = $"{i + 2}", ["type"] = "LODLevel",
                    ["distance"] = level.FarZ, ["children"] = levelChildren
                });
            }
            children.Add(lodGroup);
        }
        else if (tree.Children != null)
        {
            foreach (var c in tree.Children)
                children.Add(BuildTreeNode(c, !string.IsNullOrEmpty(c.Name) ? c.Name : c.GetType().Name, depth + 1));
        }

        node["childCount"] = children.Count;
        return node;
    }
}

public record SolidEntry(string Name, PakFile File);
public record CachedPak(Pak Pak, List<SolidEntry> Solids, MemoryStream Stream);
public record ChallengeBlock(string Name, int X, int Y, int Z, int Dir, bool IsGround, byte Variant, byte SubVariant);
public record Tri3DVertex(float R, float G, float B, float A);
public record Tri3DKeyframe(float Time, float[] Positions);
public record Tri3DBlock(string ClipType, string ClipName, string TrackName, Tri3DVertex[] Vertices, int[] Indices, Tri3DKeyframe[] Keyframes);
public record TrackInfo(string ClipType, string ClipName, string TrackName, int Tri3DIndex);
public record ChallengeData(string MapName, int SizeX, int SizeZ, List<ChallengeBlock> Blocks, List<Tri3DBlock> Triangles3D, List<TrackInfo> AllTracks);

public static class ClipGbxExporter
{
    public static byte[] ExportTri3DBlockAsClip(Tri3DBlock block, string trackName,
        float posX = 0, float posY = 0, float posZ = 0,
        float rotX = 0, float rotY = 0, float rotZ = 0,
        float scaleX = 1, float scaleY = 1, float scaleZ = 1,
        string? colorOverrideHex = null)
    {
        bool hasTransform = posX != 0 || posY != 0 || posZ != 0 ||
                            rotX != 0 || rotY != 0 || rotZ != 0 ||
                            scaleX != 1 || scaleY != 1 || scaleZ != 1;

        var cosRx = (float)Math.Cos(rotX); var sinRx = (float)Math.Sin(rotX);
        var cosRy = (float)Math.Cos(rotY); var sinRy = (float)Math.Sin(rotY);
        var cosRz = (float)Math.Cos(rotZ); var sinRz = (float)Math.Sin(rotZ);

        Vec4[] vertColors;
        if (!string.IsNullOrEmpty(colorOverrideHex))
        {
            var (cr, cg, cb) = ParseHexColor(colorOverrideHex);
            vertColors = Enumerable.Repeat(new Vec4(cr, cg, cb, 1f), block.Vertices.Length).ToArray();
        }
        else
        {
            vertColors = block.Vertices.Select(v => new Vec4(v.R, v.G, v.B, v.A)).ToArray();
        }

        var tri3d = new CGameCtnMediaBlockTriangles3D
        {
            Vertices = vertColors,
            Triangles = Enumerable.Range(0, block.Indices.Length / 3)
                .Select(i => new Int3(block.Indices[i * 3], block.Indices[i * 3 + 1], block.Indices[i * 3 + 2]))
                .ToArray()
        };

        // Compute center from first keyframe (same as JS centering)
        float cx = 0, cy = 0, cz = 0;
        if (hasTransform && block.Keyframes.Length > 0)
        {
            var kf0 = block.Keyframes[0];
            for (int i = 0; i < block.Vertices.Length; i++)
            {
                int pi = i * 3;
                if (pi + 2 < kf0.Positions.Length)
                { cx += kf0.Positions[pi]; cy += kf0.Positions[pi + 1]; cz += kf0.Positions[pi + 2]; }
            }
            cx /= block.Vertices.Length; cy /= block.Vertices.Length; cz /= block.Vertices.Length;
        }

        tri3d.Keys = block.Keyframes.Select(kf =>
        {
            var positions = new Vec3[block.Vertices.Length];
            for (int i = 0; i < positions.Length; i++)
            {
                int pi = i * 3;
                if (pi + 2 >= kf.Positions.Length) continue;
                float x = kf.Positions[pi], y = kf.Positions[pi + 1], z = kf.Positions[pi + 2];

                if (hasTransform)
                {
                    x -= cx; y -= cy; z -= cz;
                    x *= scaleX; y *= scaleY; z *= scaleZ;
                    float y1 = y * cosRx - z * sinRx;
                    float z1 = y * sinRx + z * cosRx;
                    float x2 = x * cosRy + z1 * sinRy;
                    float z2 = -x * sinRy + z1 * cosRy;
                    float x3 = x2 * cosRz - y1 * sinRz;
                    float y3 = x2 * sinRz + y1 * cosRz;
                    x = x3 + cx + posX; y = y3 + cy + posY; z = z2 + cz + posZ;
                }
                positions[i] = new Vec3(x, y, z);
            }
            var key = new CGameCtnMediaBlockTriangles.Key(tri3d)
            {
                Time = TimeSingle.FromSeconds(kf.Time),
                Positions = positions
            };
            return key;
        }).ToList();

        var chunk = tri3d.CreateChunk<CGameCtnMediaBlockTriangles.Chunk03029001>();
        chunk.U01 = 1;
        chunk.U04 = 1;

        return BuildClipBytes(tri3d, trackName);
    }

    public static byte[] ExportObjAsClip(
        string objText, string mtlText,
        float posX, float posY, float posZ,
        float rotX, float rotY, float rotZ,
        float scaleX, float scaleY, float scaleZ,
        string trackName,
        Dictionary<string, string>? materialColorOverrides = null,
        float shadingIntensity = 0f)
    {
        var mtlColors = ParseMtlColors(mtlText);
        if (materialColorOverrides != null)
        {
            foreach (var (name, hex) in materialColorOverrides)
            {
                var (r, g, b) = ParseHexColor(hex);
                mtlColors[name] = (r, g, b);
            }
        }

        var rng = new Random();
        var objPositions = new List<float[]>();
        var outVerts = new List<(float x, float y, float z, float r, float g, float b, float a)>();
        var outTris = new List<Int3>();
        float curR = 0.5f, curG = 0.5f, curB = 0.5f;

        foreach (var rawLine in objText.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.StartsWith("v "))
            {
                var parts = line.Substring(2).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 3)
                    objPositions.Add(new[] {
                        float.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture),
                        float.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture),
                        float.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture)
                    });
            }
            else if (line.StartsWith("usemtl "))
            {
                var matName = line.Substring(7).Trim();
                if (mtlColors.TryGetValue(matName, out var c))
                { curR = c.r; curG = c.g; curB = c.b; }
                else
                { curR = 0.5f; curG = 0.5f; curB = 0.5f; }
            }
            else if (line.StartsWith("f "))
            {
                var parts = line.Substring(2).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var faceIndices = new List<int>();
                foreach (var p in parts)
                {
                    var vi = p.Split('/')[0];
                    if (int.TryParse(vi, out int idx))
                        faceIndices.Add(idx > 0 ? idx - 1 : objPositions.Count + idx);
                }
                float fr = curR, fg = curG, fb = curB;
                if (shadingIntensity > 0)
                {
                    float shade = (1f - rng.NextSingle() * 2f) * shadingIntensity;
                    fr = Math.Min(1f, curR * (1f - shade));
                    fg = Math.Min(1f, curG * (1f - shade));
                    fb = Math.Min(1f, curB * (1f - shade));
                }
                var baseIdx = outVerts.Count;
                foreach (var fi in faceIndices)
                {
                    if (fi >= 0 && fi < objPositions.Count)
                    {
                        var p = objPositions[fi];
                        outVerts.Add((p[0], p[1], p[2], fr, fg, fb, 1f));
                    }
                    else
                        outVerts.Add((0, 0, 0, fr, fg, fb, 1f));
                }
                for (int i = 1; i < faceIndices.Count - 1; i++)
                    outTris.Add(new Int3(baseIdx, baseIdx + i, baseIdx + i + 1));
            }
        }

        if (outVerts.Count == 0) return Array.Empty<byte>();

        var vertices = new Vec4[outVerts.Count];
        var positions = new Vec3[outVerts.Count];

        var cosX = (float)Math.Cos(rotX); var sinX = (float)Math.Sin(rotX);
        var cosY = (float)Math.Cos(rotY); var sinY = (float)Math.Sin(rotY);
        var cosZ = (float)Math.Cos(rotZ); var sinZ = (float)Math.Sin(rotZ);

        for (int i = 0; i < outVerts.Count; i++)
        {
            var v = outVerts[i];
            vertices[i] = new Vec4(v.r, v.g, v.b, v.a);

            float x = v.x * scaleX;
            float y = v.y * scaleY;
            float z = v.z * scaleZ;

            float y1 = y * cosX - z * sinX;
            float z1 = y * sinX + z * cosX;
            float x2 = x * cosY + z1 * sinY;
            float z2 = -x * sinY + z1 * cosY;
            float x3 = x2 * cosZ - y1 * sinZ;
            float y3 = x2 * sinZ + y1 * cosZ;

            positions[i] = new Vec3(x3 + posX, y3 + posY, z2 + posZ);
        }

        var tri3d = new CGameCtnMediaBlockTriangles3D
        {
            Vertices = vertices,
            Triangles = outTris.ToArray()
        };

        var key0 = new CGameCtnMediaBlockTriangles.Key(tri3d)
        {
            Time = TimeSingle.FromSeconds(0f),
            Positions = positions
        };
        var key1 = new CGameCtnMediaBlockTriangles.Key(tri3d)
        {
            Time = TimeSingle.FromSeconds(3f),
            Positions = positions
        };
        tri3d.Keys = [key0, key1];

        var chunk = tri3d.CreateChunk<CGameCtnMediaBlockTriangles.Chunk03029001>();
        chunk.U01 = 1;
        chunk.U04 = 1;

        return BuildClipBytes(tri3d, trackName);
    }

    private static (float r, float g, float b) ParseHexColor(string hex)
    {
        hex = hex.TrimStart('#');
        if (hex.Length < 6) return (0.5f, 0.5f, 0.5f);
        int ri = Convert.ToInt32(hex.Substring(0, 2), 16);
        int gi = Convert.ToInt32(hex.Substring(2, 2), 16);
        int bi = Convert.ToInt32(hex.Substring(4, 2), 16);
        return (ri / 255f, gi / 255f, bi / 255f);
    }

    private static Dictionary<string, (float r, float g, float b)> ParseMtlColors(string mtlText)
    {
        var colors = new Dictionary<string, (float r, float g, float b)>();
        if (string.IsNullOrEmpty(mtlText)) return colors;

        string currentMat = "";
        foreach (var rawLine in mtlText.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.StartsWith("newmtl "))
                currentMat = line.Substring(7).Trim();
            else if (line.StartsWith("Kd ") && currentMat.Length > 0)
            {
                var parts = line.Substring(3).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 3)
                    colors[currentMat] = (
                        float.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture),
                        float.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture),
                        float.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        return colors;
    }

    public record AnimKf(double Time, double EndTime, double X, double Y, double Z, int Steps = 1);

    public static CGameCtnMediaBlockTriangles3D BuildAnimatedTri3DBlock(
        Tri3DBlock block,
        List<AnimKf>? transKfs, List<AnimKf>? scaleKfs, List<AnimKf>? rotKfs,
        string? colorOverrideHex = null,
        Vec3? origin = null,
        Vec3? rotationOrigin = null)
    {
        Vec4[] vertColors;
        if (!string.IsNullOrEmpty(colorOverrideHex))
        {
            var (cr, cg, cb) = ParseHexColor(colorOverrideHex);
            vertColors = Enumerable.Repeat(new Vec4(cr, cg, cb, 1f), block.Vertices.Length).ToArray();
        }
        else
            vertColors = block.Vertices.Select(v => new Vec4(v.R, v.G, v.B, v.A)).ToArray();

        var tri3d = new CGameCtnMediaBlockTriangles3D
        {
            Vertices = vertColors,
            Triangles = Enumerable.Range(0, block.Indices.Length / 3)
                .Select(i => new Int3(block.Indices[i * 3], block.Indices[i * 3 + 1], block.Indices[i * 3 + 2]))
                .ToArray()
        };

        var basePositions = new Vec3[block.Vertices.Length];
        if (block.Keyframes.Length > 0)
        {
            var kf0 = block.Keyframes[0];
            for (int i = 0; i < basePositions.Length; i++)
            {
                int pi = i * 3;
                if (pi + 2 < kf0.Positions.Length)
                    basePositions[i] = new Vec3(kf0.Positions[pi], kf0.Positions[pi + 1], kf0.Positions[pi + 2]);
            }
        }

        var allTimes = new SortedSet<double>();
        void CollectTimes(List<AnimKf>? kfs, bool subdivide = false)
        {
            if (kfs == null) return;
            foreach (var kf in kfs)
            {
                allTimes.Add(kf.Time);
                allTimes.Add(kf.EndTime);
                if (subdivide && kf.Steps > 1 && (kf.X != 0 || kf.Y != 0 || kf.Z != 0))
                {
                    var dur = kf.EndTime - kf.Time;
                    for (int s = 1; s < kf.Steps; s++)
                        allTimes.Add(kf.Time + dur * s / kf.Steps);
                }
            }
        }
        CollectTimes(transKfs);
        CollectTimes(scaleKfs);
        CollectTimes(rotKfs, subdivide: true);
        if (allTimes.Count == 0) { allTimes.Add(0); allTimes.Add(3); }

        float cx, cy, cz;
        if (rotationOrigin.HasValue)
        {
            cx = rotationOrigin.Value.X;
            cy = rotationOrigin.Value.Y;
            cz = rotationOrigin.Value.Z;
        }
        else
        {
            cx = 0; cy = 0; cz = 0;
            foreach (var p in basePositions) { cx += p.X; cy += p.Y; cz += p.Z; }
            cx /= basePositions.Length; cy /= basePositions.Length; cz /= basePositions.Length;
        }

        float offX = origin?.X ?? 0, offY = origin?.Y ?? 0, offZ = origin?.Z ?? 0;

        tri3d.Keys = allTimes.Select(t =>
        {
            var positions = new Vec3[basePositions.Length];

            float ox = 0, oy = 0, oz = 0;
            if (transKfs != null)
                foreach (var kf in transKfs)
                {
                    if (t < kf.Time) break;
                    var dur = kf.EndTime - kf.Time;
                    if (dur <= 0) { ox += (float)kf.X; oy += (float)kf.Y; oz += (float)kf.Z; continue; }
                    var p = Math.Min(1.0, (t - kf.Time) / dur);
                    ox += (float)(kf.X * p); oy += (float)(kf.Y * p); oz += (float)(kf.Z * p);
                }

            float sx = 1, sy = 1, sz = 1;
            if (scaleKfs != null)
            {
                float prevSx = 1, prevSy = 1, prevSz = 1;
                foreach (var kf in scaleKfs)
                {
                    if (t < kf.Time) break;
                    var dur = kf.EndTime - kf.Time;
                    if (dur <= 0) { sx = (float)kf.X; sy = (float)kf.Y; sz = (float)kf.Z; }
                    else
                    {
                        var p = (float)Math.Min(1.0, (t - kf.Time) / dur);
                        sx = prevSx + ((float)kf.X - prevSx) * p;
                        sy = prevSy + ((float)kf.Y - prevSy) * p;
                        sz = prevSz + ((float)kf.Z - prevSz) * p;
                    }
                    prevSx = (float)kf.X; prevSy = (float)kf.Y; prevSz = (float)kf.Z;
                }
            }

            float rx = 0, ry = 0, rz = 0;
            if (rotKfs != null)
                foreach (var kf in rotKfs)
                {
                    if (t < kf.Time) break;
                    var dur = kf.EndTime - kf.Time;
                    if (dur <= 0) { rx += (float)kf.X; ry += (float)kf.Y; rz += (float)kf.Z; continue; }
                    var p = (float)Math.Min(1.0, (t - kf.Time) / dur);
                    rx += (float)(kf.X * p); ry += (float)(kf.Y * p); rz += (float)(kf.Z * p);
                }

            var cosA = MathF.Cos(rz); var sinA = MathF.Sin(rz);
            var cosB = MathF.Cos(ry); var sinB = MathF.Sin(ry);
            var cosC = MathF.Cos(rx); var sinC = MathF.Sin(rx);

            for (int i = 0; i < basePositions.Length; i++)
            {
                float x = basePositions[i].X - cx;
                float y = basePositions[i].Y - cy;
                float z = basePositions[i].Z - cz;

                x *= sx; y *= sy; z *= sz;

                if (rx != 0 || ry != 0 || rz != 0)
                {
                    float Axx = cosA * cosB;
                    float Axy = cosA * sinB * sinC - sinA * cosC;
                    float Axz = cosA * sinB * cosC + sinA * sinC;
                    float Ayx = sinA * cosB;
                    float Ayy = sinA * sinB * sinC + cosA * cosC;
                    float Ayz = sinA * sinB * cosC - cosA * sinC;
                    float Azx = -sinB;
                    float Azy = cosB * sinC;
                    float Azz = cosB * cosC;
                    float nx = Axx * x + Axy * y + Axz * z;
                    float ny = Ayx * x + Ayy * y + Ayz * z;
                    float nz = Azx * x + Azy * y + Azz * z;
                    x = nx; y = ny; z = nz;
                }

                positions[i] = new Vec3(x + cx + ox + offX, y + cy + oy + offY, z + cz + oz + offZ);
            }

            return new CGameCtnMediaBlockTriangles.Key(tri3d)
            {
                Time = TimeSingle.FromSeconds((float)t),
                Positions = positions
            };
        }).ToList();

        var chunk = tri3d.CreateChunk<CGameCtnMediaBlockTriangles.Chunk03029001>();
        chunk.U01 = 1; chunk.U04 = 1;
        return tri3d;
    }

    public static CGameCtnMediaBlockTriangles3D BuildObjTri3DBlock(
        string objText, string mtlText,
        float posX, float posY, float posZ,
        List<AnimKf>? transKfs, List<AnimKf>? scaleKfs, List<AnimKf>? rotKfs,
        Dictionary<string, string>? materialColorOverrides = null,
        float shadingIntensity = 0f,
        Vec3? rotationOrigin = null)
    {
        var mtlColors = ParseMtlColors(mtlText);
        if (materialColorOverrides != null)
            foreach (var (name, hex) in materialColorOverrides)
            {
                var (r, g, b) = ParseHexColor(hex);
                mtlColors[name] = (r, g, b);
            }

        var rng = new Random();
        var objPositions = new List<float[]>();
        var outVerts = new List<(float x, float y, float z, float r, float g, float b, float a)>();
        var outTris = new List<Int3>();
        float curR = 0.5f, curG = 0.5f, curB = 0.5f;

        foreach (var rawLine in objText.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.StartsWith("v "))
            {
                var parts = line.Substring(2).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 3)
                    objPositions.Add(new[] {
                        float.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture),
                        float.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture),
                        float.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture)
                    });
            }
            else if (line.StartsWith("usemtl "))
            {
                var matName = line.Substring(7).Trim();
                if (mtlColors.TryGetValue(matName, out var c))
                { curR = c.r; curG = c.g; curB = c.b; }
                else
                { curR = 0.5f; curG = 0.5f; curB = 0.5f; }
            }
            else if (line.StartsWith("f "))
            {
                var parts = line.Substring(2).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var faceIndices = new List<int>();
                foreach (var p in parts)
                {
                    var vi = p.Split('/')[0];
                    if (int.TryParse(vi, out int idx))
                        faceIndices.Add(idx > 0 ? idx - 1 : objPositions.Count + idx);
                }
                float fr = curR, fg = curG, fb = curB;
                if (shadingIntensity > 0)
                {
                    float shade = (1f - rng.NextSingle() * 2f) * shadingIntensity;
                    fr = Math.Min(1f, curR * (1f - shade));
                    fg = Math.Min(1f, curG * (1f - shade));
                    fb = Math.Min(1f, curB * (1f - shade));
                }
                var baseIdx = outVerts.Count;
                foreach (var fi in faceIndices)
                {
                    if (fi >= 0 && fi < objPositions.Count)
                    {
                        var pp = objPositions[fi];
                        outVerts.Add((pp[0], pp[1], pp[2], fr, fg, fb, 1f));
                    }
                    else outVerts.Add((0, 0, 0, fr, fg, fb, 1f));
                }
                for (int i = 1; i < faceIndices.Count - 1; i++)
                    outTris.Add(new Int3(baseIdx, baseIdx + i, baseIdx + i + 1));
            }
        }

        if (outVerts.Count == 0) return new CGameCtnMediaBlockTriangles3D();

        var tri3dBlock = new Tri3DBlock("", "", "",
            outVerts.Select(v => new Tri3DVertex(v.r, v.g, v.b, v.a)).ToArray(),
            outTris.SelectMany(t => new[] { t.X, t.Y, t.Z }).ToArray(),
            new[] { new Tri3DKeyframe(0, outVerts.Select(v => new[] { v.x, v.y, v.z }).SelectMany(a => a).ToArray()) }
        );

        return BuildAnimatedTri3DBlock(tri3dBlock, transKfs, scaleKfs, rotKfs, origin: new Vec3(posX, posY, posZ), rotationOrigin: rotationOrigin);
    }

    public static byte[] ExportChallengeBytes(byte[] originalBytes,
        List<(string clipType, string clipName, string trackName, CGameCtnMediaBlockTriangles3D block)> newBlocks)
    {
        var gbx = Gbx.Parse(new MemoryStream(originalBytes));
        if (gbx.Node is not CGameCtnChallenge challenge) return Array.Empty<byte>();

        CGameCtnMediaClip GetOrCreateClip(string clipType, string clipName)
        {
            if (clipType == "Intro")
                return challenge.ClipIntro ??= CreateMediaClip(clipName);
            if (clipType == "Global")
                return challenge.ClipGlobal ??= CreateMediaClip(clipName);

            var clipGroup = clipType == "End Race"
                ? (challenge.ClipGroupEndRace ??= CreateMediaClipGroup())
                : (challenge.ClipGroupInGame ??= CreateMediaClipGroup());

            foreach (var ct in clipGroup.Clips)
                if (ct.Clip.Name == clipName) return ct.Clip;

            var clip = CreateMediaClip(clipName);
            clipGroup.Clips.Add(new() { Clip = clip });
            return clip;
        }

        foreach (var (clipType, clipName, trackName, tri3dBlock) in newBlocks)
        {
            var clip = GetOrCreateClip(clipType, clipName);
            var track = CreateMediaTrack(trackName);
            track.Blocks.Add(tri3dBlock);
            clip.Tracks.Add(track);
        }

        using var ms = new MemoryStream();
        gbx.Save(ms);
        return ms.ToArray();
    }

    private static CGameCtnMediaClipGroup CreateMediaClipGroup()
    {
        var cg = new CGameCtnMediaClipGroup();
        cg.CreateChunk<CGameCtnMediaClipGroup.Chunk0307A003>();
        return cg;
    }

    private static CGameCtnMediaClip CreateMediaClip(string name)
    {
        var clip = new CGameCtnMediaClip();
        clip.CreateChunk<CGameCtnMediaClip.Chunk03079004>();
        clip.CreateChunk<CGameCtnMediaClip.Chunk03079005>();
        clip.CreateChunk<CGameCtnMediaClip.Chunk03079007>();
        clip.Name = name;
        return clip;
    }

    private static CGameCtnMediaTrack CreateMediaTrack(string name)
    {
        var track = new CGameCtnMediaTrack();
        track.CreateChunk<CGameCtnMediaTrack.Chunk03078001>().U01 = 2;
        track.CreateChunk<CGameCtnMediaTrack.Chunk03078004>();
        track.Name = name;
        return track;
    }

    private static byte[] BuildClipBytes(CGameCtnMediaBlockTriangles3D tri3d, string trackName)
    {
        var track = new CGameCtnMediaTrack();
        track.CreateChunk<CGameCtnMediaTrack.Chunk03078001>().U01 = 2;
        track.CreateChunk<CGameCtnMediaTrack.Chunk03078004>();
        track.Name = trackName;
        track.Blocks.Add(tri3d);

        var clip = new CGameCtnMediaClip();
        clip.CreateChunk<CGameCtnMediaClip.Chunk03079004>();
        clip.CreateChunk<CGameCtnMediaClip.Chunk03079005>();
        clip.CreateChunk<CGameCtnMediaClip.Chunk03079007>();
        clip.Name = trackName;
        clip.Tracks.Add(track);

        using var ms = new MemoryStream();
        clip.Save(ms);
        return ms.ToArray();
    }
}
