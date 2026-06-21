using Microsoft.JSInterop;

namespace TMNFeditor.Services;

public class FileSystemService(IJSRuntime js)
{
    // Ouvre le sélecteur de dossier natif du navigateur
    public async Task<string?> SelectGameFolderAsync()
        => await js.InvokeAsync<string?>("TMNFeditorFS.selectGameFolder");

    public async Task<string?> GetGameFolderNameAsync()
        => await js.InvokeAsync<string?>("TMNFeditorFS.getGameFolderName");

    // Liste les noms de paks (sans .pak) disponibles dans Packs/
    public async Task<List<string>> ListPakFilesAsync()
        => (await js.InvokeAsync<string[]>("TMNFeditorFS.listPakFiles")).ToList();

    // Lit un .pak complet en mémoire
    public async Task<byte[]> ReadPakBytesAsync(string pakName)
        => await js.InvokeAsync<byte[]>("TMNFeditorFS.readPakBytes", pakName);

    // Construit un mapping {filename.dds → blobUrl} pour les textures d'un MTL
    public async Task<Dictionary<string, string>> BuildTextureBlobUrlMapAsync(string mtlText, string pakName)
        => await js.InvokeAsync<Dictionary<string, string>>("TMNFeditorFS.buildTextureBlobUrlMap", mtlText, pakName);

    // Crée des blob URLs depuis des octets bruts (extraits du pak) — fallback si GameData vide
    public async Task<Dictionary<string, string>> CreateTextureBlobUrlsFromBytesAsync(Dictionary<string, byte[]> textures, string pakName)
        => await js.InvokeAsync<Dictionary<string, string>>("TMNFeditorFS.createTextureBlobUrlsFromBytes", textures, pakName);

    // Libère les blob URLs créés (à appeler quand on change de dossier)
    public async Task RevokeBlobUrlsAsync()
        => await js.InvokeVoidAsync("TMNFeditorFS.revokeBlobUrls");

    // Ouvre un sélecteur de fichier pour choisir un .Challenge.Gbx
    public async Task<ChallengeFileResult?> PickChallengeFileAsync()
        => await js.InvokeAsync<ChallengeFileResult?>("TMNFeditorFS.pickChallengeFile");

    // ─── Three.js interop ──────────────────────────────────────────────────────

    public async Task InitSceneAsync(IJSObjectReference? containerEl)
        => await js.InvokeVoidAsync("TMNFeditorScene.init", containerEl);

    public async Task SetBlobUrlMapAsync(Dictionary<string, string> map)
        => await js.InvokeVoidAsync("TMNFeditorScene.setBlobUrlMap", map);

    public async Task<ModelStats> LoadModelAsync(string objText, string mtlText, string pakName, string cacheKey = "", string geomKey = "")
        => await js.InvokeAsync<ModelStats>("TMNFeditorScene.loadModel", objText, mtlText, pakName, cacheKey, geomKey);

    public async Task SelectMeshAsync(string name, string materialName)
        => await js.InvokeVoidAsync("TMNFeditorScene.selectMesh", name, materialName);

    public async Task<bool> ToggleMeshAsync(string name, string materialName)
        => await js.InvokeAsync<bool>("TMNFeditorScene.toggleMesh", name, materialName);

    // ─── Map mode interop ─────────────────────────────────────────────────────

    public async Task ClearMapAsync()
        => await js.InvokeVoidAsync("TMNFeditorScene.clearMap");

    public async Task BeginMapAsync()
        => await js.InvokeVoidAsync("TMNFeditorScene.beginMap");

    public async Task AddModelToMapAsync(string objText, string mtlText, string pakName, object placements, string cacheKey = "", string geomKey = "")
        => await js.InvokeVoidAsync("TMNFeditorScene.addModelToMap", objText, mtlText, pakName, placements, cacheKey, geomKey);

    // Charge en parallèle la géométrie binaire depuis IDB et peuple rawModelCache (avant Phase 3)
    public async Task<bool[]> PopulateRawModelCacheFromIDBAsync(object[] entries)
        => await js.InvokeAsync<bool[]>("TMNFeditorScene.populateRawModelCacheFromIDB", (object)entries);

    public async Task ClearModelCacheAsync()
        => await js.InvokeVoidAsync("TMNFeditorScene.clearModelCache");

    // ─── Cache IndexedDB persistant (survit aux rechargements de page) ────────
    public async Task<ModelCacheEntry?> GetCachedModelAsync(string key)
        => await js.InvokeAsync<ModelCacheEntry?>("TMNFeditorCache.get", key);

    public async Task SetCachedModelAsync(string key, ModelCacheEntry entry)
        => await js.InvokeVoidAsync("TMNFeditorCache.set", key, entry);

    public async Task ClearCachedModelsDbAsync()
        => await js.InvokeVoidAsync("TMNFeditorCache.clear");

    public async Task AppendModelToSceneAsync(string objText, string mtlText, string pakName, string cacheKey = "", string geomKey = "", string color = "")
        => await js.InvokeVoidAsync("TMNFeditorScene.appendModelToCurrentBlock", objText, mtlText, pakName, cacheKey, geomKey, color);

    public async Task FinalizeMapAsync(int mapSizeX, int mapSizeZ, object[] groundBlocks)
        => await js.InvokeVoidAsync("TMNFeditorScene.finalizeMap", mapSizeX, mapSizeZ, groundBlocks);

    public async Task SetMapOffsetAsync(int x, int y, int z)
        => await js.InvokeVoidAsync("TMNFeditorScene.setMapOffset", x, y, z);
}

public record ChallengeFileResult(string Name, byte[] Bytes);

public record ModelStats(int Vertices, int Triangles, int Meshes);

public record ModelCacheEntry(string Obj, string Mtl);
