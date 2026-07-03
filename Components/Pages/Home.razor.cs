using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using TMNFeditor.Services;

namespace TMNFeditor.Components.Pages;

public partial class Home : ComponentBase, IDisposable
{
    [Inject] private FileSystemService FS { get; set; } = default!;
    [Inject] private PakService PakSvc { get; set; } = default!;
    [Inject] private HttpClient Http { get; set; } = default!;
    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private AppState State { get; set; } = default!;

    // Cache pour les BlockInfo issus de ConstructionBlockInfo/*.Gbx — chargés à la volée comme BlockLister.
    private Dictionary<string, string>? _cbiIndex;
    private readonly Dictionary<string, GBX.NET.Engines.Game.CGameCtnBlockInfo?> _cbiCache
        = new(StringComparer.OrdinalIgnoreCase);

    private ElementReference threeContainer;
    private bool sceneInitialized = false;
    private bool _slotsSentToJs = false;
    private bool _selectingGameFolder = false;
    private DotNetObjectReference<Home>? _dotNetRef;
    private readonly HashSet<string> _loadedSlotPaks = new(StringComparer.OrdinalIgnoreCase);

    private const bool DebugResume = false;

    private async Task EnsurePakMappingsLoaded(string pakName)
    {
        if (_loadedSlotPaks.Contains(pakName)) return;
        _loadedSlotPaks.Add(pakName);
        try { PakSvc.LoadMaterialSlotsJson(await Http.GetStringAsync($"mappings/{pakName}_material_slots.json")); } catch { }
        try { PakSvc.LoadBlockVariants(pakName, await Http.GetStringAsync($"mappings/{pakName}_block_variants.json")); } catch { }
        try { PakSvc.LoadBlockCoordSizes(pakName, await Http.GetStringAsync($"mappings/{pakName}_block_coord_sizes.json")); } catch { }
        try { PakSvc.LoadBlockUnits(await Http.GetStringAsync($"mappings/{pakName}_block_units.json")); } catch { }
        if (!_loadedSlotPaks.Contains("Game"))
        {
            _loadedSlotPaks.Add("Game");
            try { PakSvc.LoadMaterialSlotsJson(await Http.GetStringAsync("mappings/Game_material_slots.json")); } catch { }
        }
    }

    // ─── JSInvokable callbacks (must stay here for the DotNetObjectReference) ──

    [JSInvokable]
    public void OnText3DSelected(int sceneIdx)
    {
        State.SelectText3DBySceneIdx(sceneIdx);
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public async Task OnSceneDeselected()
    {
        await State.RevertText3DIfNeeded();
        State.Text3dActiveIdx = -1;
        State.Text3dValue = "";
        State.ImportMaterials.Clear();
        State.ClickedBlockMat = null;
        State.MeshIsSelected = false;
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public async Task OnBlockMaterialClicked(string matName)
    {
        try
        {
            var shortName = matName.Replace(".Material", "").Replace(".material", "").ToLowerInvariant();
            if (!PakSvc.GetAllMaterialSlots().ContainsKey(shortName) && !string.IsNullOrEmpty(State.LoadedMtl))
                await PakSvc.EnsureMaterialSlotsAsync(State.CurrentPak ?? "", State.LoadedMtl);
            var slots = PakSvc.GetAllMaterialSlots();
            var info = $"Material: {matName}";
            if (slots.TryGetValue(shortName, out var texMap) && texMap.Count > 0)
                foreach (var (type, file) in texMap)
                    info += $"\n{type}: {file}";
            else
                info += "\naucune texture";
            await JS.InvokeVoidAsync("eval",
                $"if(document.querySelector('.block-mat-info'))document.querySelector('.block-mat-info').innerText={System.Text.Json.JsonSerializer.Serialize(info)}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[MatClick ERROR] {ex.Message}");
            var errInfo = $"Material: {matName}\nErreur: {ex.Message}";
            try { await JS.InvokeVoidAsync("eval",
                $"if(document.querySelector('.block-mat-info'))document.querySelector('.block-mat-info').innerText={System.Text.Json.JsonSerializer.Serialize(errInfo)}"); } catch { }
        }
    }

    [JSInvokable]
    public void OnModelImported(int count, int activeIdx)
    {
        if (count > State.ImportTabCount)
        {
            var animKey = State.ImportMode == "2D" ? activeIdx + 20000 : activeIdx;
            State.PerImportAnim.Remove(animKey);
        }
        State.ImportTabCount  = count;
        State.ActiveImportTab = activeIdx;
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public void OnImportSelected(int idx)
    {
        State.ActiveImportTab = idx;
        State.SelectedTri3DTrack = null;
        State.MeshIsSelected = true;
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public async Task OnSwitchImportMode(string mode)
    {
        if (State.ImportMode != mode)
        {
            await State.SetImportMode(mode);
            State.NotifyStateChanged();
        }
    }

    [JSInvokable]
    public void OnTri3DSelected(int meshIndex)
    {
        State.SelectedTri3DTrack = State.Tri3dEntries.FirstOrDefault(e => e.MeshIndex == meshIndex);
        if (State.SelectedTri3DTrack != null)
        {
            State.Tri3dPosX = 0; State.Tri3dPosY = 0; State.Tri3dPosZ = 0;
            State.ImportOriginX = 0; State.ImportOriginY = 0; State.ImportOriginZ = 0;
            State.SelectedClipType = State.SelectedTri3DTrack.ClipType;
            var clips = State.GetClipsForSelectedType();
            var clipIdx = clips.FindIndex(c => c.ClipName == State.SelectedTri3DTrack.ClipName);
            if (clipIdx >= 0) State.SelectedClipIdx = clipIdx;
        }
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public void OnTri3DPositionChanged(double x, double y, double z)
    {
        State.Tri3dPosX = x; State.Tri3dPosY = y; State.Tri3dPosZ = z;
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public void OnImportPositionChanged(double x, double y, double z)
    {
        State.ImportPosX = x; State.ImportPosY = y; State.ImportPosZ = z;
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public void OnImportTabInScene(bool inScene)
    {
        State.ActiveTabInScene = inScene;
        State.MeshIsSelected = inScene;
        if (inScene) State.SelectedTri3DTrack = null;
        if (!inScene) State.ImportMaterials = new();
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public void OnImportOriginChanged(double x, double y, double z)
    {
        State.ImportOriginX = x; State.ImportOriginY = y; State.ImportOriginZ = z;
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public void OnImportMaterialsChanged(AppState.ImportMatDto[] mats)
    {
        State.ImportMaterials = mats?.ToList() ?? new();
        State.NotifyStateChanged();
    }

    [JSInvokable]
    public async Task<string> ScanBlockUnits()
    {
        string index;
        try { index = await Http.GetStringAsync("ConstructionBlockInfo/index.txt"); }
        catch { return "{}"; }
        var files = index.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var result = new Dictionary<string, object>();
        int done = 0;

        foreach (var filePath in files)
        {
            done++;
            if (done % 20 == 0) Console.WriteLine($"[BlockUnits] {done}/{files.Length}...");
            try
            {
                var bytes = await Http.GetByteArrayAsync(filePath);
                var gbx = GBX.NET.Gbx.Parse(new System.IO.MemoryStream(bytes));
                if (gbx.Node is not GBX.NET.Engines.Game.CGameCtnBlockInfo blockInfo) continue;

                var blockName = blockInfo.Ident?.Id ?? System.IO.Path.GetFileNameWithoutExtension(System.IO.Path.GetFileNameWithoutExtension(filePath));

                List<object> ExtractUnits(GBX.NET.Engines.Game.CGameCtnBlockUnitInfo[]? unitInfos)
                {
                    var units = new List<object>();
                    if (unitInfos == null) return units;
                    foreach (var unit in unitInfos)
                    {
                        var clips = new List<object>();
                        var clipsProp = unit.GetType().GetProperty("Clips");
                        if (clipsProp?.GetValue(unit) is Array clipsArr)
                        {
                            for (int ci = 0; ci < clipsArr.Length; ci++)
                            {
                                var item = clipsArr.GetValue(ci);
                                if (item == null) continue;
                                string? clipId = null;
                                var fileProp = item.GetType().GetProperty("File");
                                if (fileProp != null)
                                {
                                    var file = fileProp.GetValue(item);
                                    var gfp = file?.GetType().GetMethod("GetFullPath");
                                    if (gfp != null)
                                        try { clipId = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(Path.GetFileName(gfp.Invoke(file, null)?.ToString() ?? ""))); } catch { }
                                }
                                if (!string.IsNullOrEmpty(clipId))
                                    clips.Add(new { dir = ci, id = clipId });
                            }
                        }
                        var terrainMod = unit.GetType().GetProperty("TerrainModifierId")?.GetValue(unit)?.ToString();
                        if (string.IsNullOrEmpty(terrainMod)) terrainMod = null;
                        // Toutes les unités sont enregistrées (même sans clips/modifier) : nécessaire pour
                        // reconstruire l'emprise au sol précise d'un block (logique fidèle à BlockLister).
                        units.Add(new
                        {
                            offset = new { x = (int)unit.RelativeOffset.X, y = (int)unit.RelativeOffset.Y, z = (int)unit.RelativeOffset.Z },
                            clips = clips.Count > 0 ? clips : null,
                            terrainModifier = terrainMod
                        });
                    }
                    return units;
                }

                var groundUnits = ExtractUnits(blockInfo.GroundBlockUnitInfos);
                var airUnits = ExtractUnits(blockInfo.AirBlockUnitInfos);

                if (groundUnits.Count > 0 || airUnits.Count > 0)
                {
                    var entry = new Dictionary<string, object>();
                    if (groundUnits.Count > 0) entry["ground"] = groundUnits;
                    if (airUnits.Count > 0) entry["air"] = airUnits;
                    result[blockName] = entry;
                }
            }
            catch { }
        }

        Console.WriteLine($"[BlockUnits] Terminé! {result.Count} blocks avec units");
        return System.Text.Json.JsonSerializer.Serialize(result, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    // ─── BlockLister-style : chargement à la volée des ConstructionBlockInfo ─────────────────────
    // Fidèle à Aide/BlockLister/Program.cs (GetInfo + infoFiles).
    // Construit l'index blockName→filePath depuis ConstructionBlockInfo/index.txt (une seule fois).
    private async Task<Dictionary<string, string>> GetCbiIndexAsync()
    {
        if (_cbiIndex != null) return _cbiIndex;
        _cbiIndex = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var idx = await Http.GetStringAsync("ConstructionBlockInfo/index.txt");
            foreach (var line in idx.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var name = System.IO.Path.GetFileName(line);
                var dot = name.IndexOf('.');
                if (dot > 0) name = name[..dot];
                _cbiIndex.TryAdd(name, line);
            }
        }
        catch { }
        return _cbiIndex;
    }

    // Charge et met en cache le BlockInfo GBX d'un block (comme GetInfo() dans Program.cs).
    private async Task<GBX.NET.Engines.Game.CGameCtnBlockInfo?> GetBlockInfoAsync(string blockName)
    {
        if (_cbiCache.TryGetValue(blockName, out var cached)) return cached;
        var index = await GetCbiIndexAsync();
        if (!index.TryGetValue(blockName, out var filePath)) { _cbiCache[blockName] = null; return null; }
        try
        {
            var bytes = await Http.GetByteArrayAsync(filePath);
            var gbx = GBX.NET.Gbx.Parse(new System.IO.MemoryStream(bytes),
                new GBX.NET.GbxReadSettings { IgnoreExceptionsInBody = true });
            _cbiCache[blockName] = gbx.Node as GBX.NET.Engines.Game.CGameCtnBlockInfo;
        }
        catch { _cbiCache[blockName] = null; }
        return _cbiCache[blockName];
    }

    private async Task SetMeshMode() { State.BlockSelectMode = false; await JS.InvokeVoidAsync("TMNFeditorScene.setBlockSelectMode", false); }
    private async Task SetBlockMode() { State.BlockSelectMode = true; await JS.InvokeVoidAsync("TMNFeditorScene.setBlockSelectMode", true); }

    public void Dispose() => _dotNetRef?.Dispose();

    protected override async Task OnInitializedAsync()
    {
        try
        {
            var content = await Http.GetStringAsync("FileHashes_TMUF.txt");
            PakSvc.LoadFileHashes(content);
        }
        catch { }

        await EnsurePakMappingsLoaded("Stadium");
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!sceneInitialized)
        {
            try
            {
                _dotNetRef ??= DotNetObjectReference.Create(this);
                await JS.InvokeVoidAsync("TMNFeditorScene.init", threeContainer, _dotNetRef);
                sceneInitialized = true;
            }
            catch (JSException)
            {
                // Le module viewer.js (window.TMNFeditorScene) n'a pas encore fini de charger — réessaie au prochain rendu.
                await Task.Delay(100);
                StateHasChanged();
                return;
            }
        }
        if (!_slotsSentToJs && sceneInitialized)
        {
            var allSlots = PakSvc.GetAllMaterialSlots();
            if (allSlots.Count > 0)
            {
                try
                {
                    await JS.InvokeVoidAsync("TMNFeditorScene.updateMaterialSlots", (object)allSlots);
                    _slotsSentToJs = true;
                }
                catch (JSException)
                {
                    await Task.Delay(100);
                    StateHasChanged();
                }
            }
        }
    }

    // ─── Block panel actions (need FS / PakSvc) ───────────────────────────────

    private async Task SelectGameFolder()
    {
        if (_selectingGameFolder) return;
        _selectingGameFolder = true;
        try
        {
            await SelectGameFolderCore();
        }
        finally { _selectingGameFolder = false; }
    }

    private async Task SelectGameFolderCore()
    {
        var folderName = await FS.SelectGameFolderAsync();
        if (folderName == null) return;
        State.GameFolderStatus = $"✅ {folderName}";
        State.GameFolderKey = folderName;
        State.JsModelCacheKeys.Clear();
        PakSvc.ClearCache();
        await FS.RevokeBlobUrlsAsync();
        await FS.ClearModelCacheAsync();

        var paks = await FS.ListPakFilesAsync();
        State.PakNames = paks.Where(p => PakService.PakKeys.ContainsKey(p))
                       .OrderBy(p => p.Equals("Stadium", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                       .ToList();

        if (State.PakNames.Count == 0)
        {
            State.NadeoError = true;
            State.GameFolderKey = "";
            State.GameFolderStatus = "";
            State.Solids.Clear();
            State.FilteredSolids.Clear();
            State.StatsText = "";
            return;
        }
        State.NadeoError = false;

        State.Solids.Clear();
        State.FilteredSolids.Clear();
        State.StatsText = $"{State.PakNames.Count} paks disponibles";
        State.ActiveModelIndex = -1;

        if (State.PakNames.Count > 0)
        {
            State.CurrentPak = State.PakNames[0];
            await LoadPakIndex(State.CurrentPak);
        }
    }

    private async Task OnPakChanged(ChangeEventArgs e)
    {
        State.CurrentPak = e.Value?.ToString() ?? "";
        if (!string.IsNullOrEmpty(State.CurrentPak))
        {
            await EnsurePakMappingsLoaded(State.CurrentPak);
            await LoadPakIndex(State.CurrentPak);
        }
    }

    private async Task LoadPakIndex(string pakName)
    {
        State.IsLoadingPak = true;
        State.Solids.Clear();
        State.FilteredSolids.Clear();
        State.StatsText = "…";
        State.NotifyStateChanged();

        try
        {
            var cached = PakSvc.GetCached(pakName);
            if (cached == null)
            {
                var bytes = await FS.ReadPakBytesAsync(pakName);
                cached = await PakSvc.OpenPakAsync(pakName, bytes);
            }

            if (cached != null)
            {
                for (int i = 0; i < cached.Solids.Count; i++)
                {
                    var name = cached.Solids[i].Name;
                    var blockName = PakSvc.GetBlockNameForSolid(pakName, name);
                    string display;
                    if (blockName != null)
                        display = blockName;
                    else
                    {
                        var fn = name.Split('/', '\\').Last();
                        display = Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(fn));
                    }
                    State.Solids.Add(new AppState.SolidItem(i, display));
                }
                State.StatsText = $"{State.Solids.Count} blocs dans {pakName}";
            }
            else
            {
                State.StatsText = $"❌ Impossible d'ouvrir {pakName}";
            }
        }
        catch (Exception ex)
        {
            State.StatsText = $"❌ {ex.Message}";
        }

        ApplySearch();
        State.IsLoadingPak = false;
        State.NotifyStateChanged();
    }

    // Obtient OBJ+MTL : cache mémoire → IDB (~1ms) → parsing GBX (lent, sauvegarde en IDB)
    private async Task<(string Obj, string Mtl)?> GetModelFast(string pakName, int index)
    {
        // 1. Cache mémoire (session courante)
        if (PakSvc.IsModelCached(pakName, index))
        {
            var r = await PakSvc.GenerateModelAsync(pakName, index);
            return r.HasValue ? (r.Value.Obj, r.Value.Mtl) : null;
        }

        // 2. IndexedDB (persistant, ~1ms)
        var idbKey = $"{State.GameFolderKey}|{pakName}:{index}";
        try
        {
            var idb = await FS.GetCachedModelAsync(idbKey);
            if (idb != null)
            {
                PakSvc.SetModelCache(pakName, index, idb.Obj, idb.Mtl);
                return (idb.Obj, idb.Mtl);
            }
        }
        catch { }

        // 3. Parsing GBX (lent — première fois uniquement)
        var result = await PakSvc.GenerateModelAsync(pakName, index);
        if (result == null) return null;

        // Sauvegarder en IDB pour les prochaines sessions
        _ = FS.SetCachedModelAsync(idbKey, new(result.Value.Obj, result.Value.Mtl));
        return (result.Value.Obj, result.Value.Mtl);
    }

    private void OnSearch(ChangeEventArgs e)
    {
        State.SearchQuery = e.Value?.ToString() ?? "";
        ApplySearch();
    }

    private void ApplySearch()
    {
        State.FilteredSolids = string.IsNullOrWhiteSpace(State.SearchQuery)
            ? [.. State.Solids]
            : [.. State.Solids.Where(s => s.DisplayName.Contains(State.SearchQuery, StringComparison.OrdinalIgnoreCase))];
    }

    private async Task LoadModel(int index)
    {
        if (State.IsLoadingModel || string.IsNullOrEmpty(State.CurrentPak)) return;
        State.IsLoadingModel = true;
        State.ActiveModelIndex = index;
        State.ImportVisible = true;

        State.NotifyStateChanged();

        try
        {
            // Pré-charger depuis IDB si pas encore en cache mémoire (évite le parsing GBX)
            if (!PakSvc.IsModelCached(State.CurrentPak, index))
            {
                var idbKey = $"{State.GameFolderKey}|{State.CurrentPak}:{index}";
                try
                {
                    var idb = await FS.GetCachedModelAsync(idbKey);
                    if (idb != null) PakSvc.SetModelCache(State.CurrentPak, index, idb.Obj, idb.Mtl);
                }
                catch { }
            }

            var result = await PakSvc.GenerateModelAsync(State.CurrentPak, index);
            if (result != null)
            {
                var (objText, mtlText, _) = result.Value;
                State.LoadedMtl = mtlText;
                _ = FS.SetCachedModelAsync($"{State.GameFolderKey}|{State.CurrentPak}:{index}", new(objText, mtlText));

                // Détermine le nom du bloc pour chercher les EditorHelpers directionnels
                var solidPath2 = PakSvc.GetCached(State.CurrentPak)?.Solids[index].Name ?? "";
                var blockName2 = PakSvc.GetBlockNameForSolid(State.CurrentPak, solidPath2)
                    ?? Path.GetFileNameWithoutExtension(Path.GetFileNameWithoutExtension(Path.GetFileName(solidPath2)));

                bool isSpecial = blockName2.Contains("Checkpoint", StringComparison.OrdinalIgnoreCase)
                    || blockName2.Contains("Start", StringComparison.OrdinalIgnoreCase)
                    || blockName2.Contains("Finish", StringComparison.OrdinalIgnoreCase);

                var helperIndices = isSpecial
                    ? PakSvc.FindEditorHelperIndices(State.CurrentPak, index, blockName2).Indices
                    : [];

                // Collecte les blob maps du bloc + helpers en une seule passe
                var combinedBlobMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var mainBlobMap = await FS.BuildTextureBlobUrlMapAsync(mtlText, State.CurrentPak);
                foreach (var kv in mainBlobMap) combinedBlobMap.TryAdd(kv.Key, kv.Value);
                {
                    var texBytes = await PakSvc.ExtractTexturesFromPakAsync(mtlText);
                    if (texBytes.Count > 0)
                    {
                        var pakBlobMap = await FS.CreateTextureBlobUrlsFromBytesAsync(texBytes, State.CurrentPak);
                        foreach (var kv in pakBlobMap) combinedBlobMap.TryAdd(kv.Key, kv.Value);
                    }
                }

                var helperModels = new List<(int Idx, string Obj, string Mtl)>();
                foreach (var helperIdx in helperIndices)
                {
                    var hr = await PakSvc.GenerateModelAsync(State.CurrentPak, helperIdx);
                    if (hr == null) continue;
                    var (hObj, hMtl, _) = hr.Value;
                    _ = FS.SetCachedModelAsync($"{State.GameFolderKey}|{State.CurrentPak}:{helperIdx}", new(hObj, hMtl));
                    var hBlobMap = await FS.BuildTextureBlobUrlMapAsync(hMtl, State.CurrentPak);
                    if (hBlobMap.Count == 0)
                    {
                        var texBytes = await PakSvc.ExtractTexturesFromPakAsync(hMtl);
                        if (texBytes.Count > 0)
                            hBlobMap = await FS.CreateTextureBlobUrlsFromBytesAsync(texBytes, State.CurrentPak);
                    }
                    foreach (var kv in hBlobMap) combinedBlobMap.TryAdd(kv.Key, kv.Value);
                    helperModels.Add((helperIdx, hObj, hMtl));
                }

                await FS.SetBlobUrlMapAsync(combinedBlobMap);

                var cacheKey = $"{State.CurrentPak}:{index}";
                var geomKey  = $"geom:{State.GameFolderKey}|{State.CurrentPak}:{index}";
                bool isJsCached = State.JsModelCacheKeys.Contains(cacheKey) && !PakSvc.LastMtlChanged;
                await FS.LoadModelAsync(
                    isJsCached ? "" : objText,
                    isJsCached ? "" : mtlText,
                    State.CurrentPak, cacheKey,
                    isJsCached ? "" : geomKey);
                State.JsModelCacheKeys.Add(cacheKey);

                var ehColor = GetEditorHelperColor(blockName2);
                foreach (var (helperIdx, hObj, hMtl) in helperModels)
                {
                    var hKey  = $"{State.CurrentPak}:{helperIdx}";
                    var hGKey = $"geom:{State.GameFolderKey}|{State.CurrentPak}:{helperIdx}";
                    bool hCached = State.JsModelCacheKeys.Contains(hKey);
                    await FS.AppendModelToSceneAsync(
                        hCached ? "" : hObj,
                        hCached ? "" : hMtl,
                        State.CurrentPak, hKey,
                        hCached ? "" : hGKey,
                        ehColor);
                    State.JsModelCacheKeys.Add(hKey);
                }
            }
        }
        catch { }

        _ = Task.Run(async () =>
        {
            try
            {
                var allSlots = PakSvc.GetAllMaterialSlots();
                if (allSlots.Count > 0)
                    await InvokeAsync(async () => await JS.InvokeVoidAsync("TMNFeditorScene.updateMaterialSlots", (object)allSlots));
            }
            catch { }
        });

        State.IsLoadingModel = false;
        State.NotifyStateChanged();
    }

    private static string GetEditorHelperColor(string blockName) =>
        blockName.Contains("StartFinish", StringComparison.OrdinalIgnoreCase) ? "#ffff00" :
        blockName.Contains("StartLine",   StringComparison.OrdinalIgnoreCase) ? "#58ff3f" :
        blockName.Contains("FinishLine",  StringComparison.OrdinalIgnoreCase) ? "#ff0000" :
        "#00b2ff";

    // ─── Map mode ──────────────────────────────────────────────────────────────

    private async Task ClearMap()
    {
        await FS.ClearMapAsync();
        await JS.InvokeVoidAsync("TMNFeditorScene.clearTriangles3D");
        State.ShowMapOffsetPanel = false;
        State.MapStatus = "";
        State.Tri3dEntries = new();
        State.Tri3dBlocks = new();
        State.SelectedTri3DTrack = null;
        State.ResetLoadedTracks.Clear();
        State.AnimatedLoadedTracks.Clear();
        State.ChallengeBytes = null;
        State.ChallengeFileName = null;
    }

    private async Task LoadChallenge()
    {
        var file = await FS.PickChallengeFileAsync();
        if (file == null) return;

        State.RejectedEnv = null;
        State.MapStatus = $"Lecture de {file.Name}…";
        State.MapIsLoading = true;
        State.MapProgress = 0;
        State.ShowMapOffsetPanel = false;
        State.NotifyStateChanged();

        State.ChallengeBytes = file.Bytes;
        State.ChallengeFileName = file.Name;

        ChallengeData? data;
        try { data = await PakSvc.ParseChallengeAsync(file.Bytes); }
        catch (Exception ex) { State.MapStatus = $"❌ Parse: {ex.Message}"; State.MapIsLoading = false; State.NotifyStateChanged(); return; }

        if (data == null) { State.MapStatus = "❌ Fichier non reconnu (pas un Challenge.Gbx)"; State.MapIsLoading = false; State.NotifyStateChanged(); return; }

        await EnsurePakMappingsLoaded(data.Environment);

        if (!string.Equals(data.Environment, "Stadium", StringComparison.OrdinalIgnoreCase))
        {
            State.RejectedEnv = data.Environment;
            State.MapIsLoading = false;
            State.ChallengeBytes = null;
            State.ChallengeFileName = null;
            State.NotifyStateChanged();
            _ = Task.Delay(10000).ContinueWith(_ => { State.RejectedEnv = null; InvokeAsync(State.NotifyStateChanged); });
            return;
        }

        // ── Étape 1 : collecter les paks uniques requis par les blocs ──────────
        var neededPaks = data.Blocks
            .Select(b => PakService.PakKeys.Keys.FirstOrDefault(p =>
                b.Name.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            .Where(p => p != null)
            .Distinct()
            .ToList();

        // ── Étape 2 : ouvrir chaque pak UNE SEULE FOIS (avec message d'erreur) ─
        var pakErrors = new Dictionary<string, string>();
        for (int pi = 0; pi < neededPaks.Count; pi++)
        {
            var pakName = neededPaks[pi]!;
            if (PakSvc.GetCached(pakName) != null) continue;
            State.MapStatus = $"Ouverture {pakName}.pak ({pi + 1}/{neededPaks.Count})…";
            State.MapProgress = (pi + 1) * 5 / neededPaks.Count;
            State.NotifyStateChanged();
            try
            {
                var bytes = await FS.ReadPakBytesAsync(pakName);
                await PakSvc.OpenPakAsync(pakName, bytes);
            }
            catch (Exception ex)
            {
                pakErrors[pakName] = ex.Message;
            }
        }

        // ── Étape 3 : calculer terrain modifiers (logique fidèle à Aide/BlockLister/Program.cs) ──
        // Le TerrainModifier vient UNIQUEMENT de unit.TerrainModifierId (jamais du nom du block) —
        // confirmé par BlockLister : aucune map réelle ne produit de "TerrainModifier:Dirt", seulement "Fabric".
        // Pas de renormalisation min(X,Z) : cell = block.Coord + rotate(offset), comme Rot() dans Program.cs.
        (int X, int Z) RotOffset(int ox, int oz, int dir) => dir switch
        {
            1 => (-oz, ox),
            2 => (-ox, -oz),
            3 => (oz, -ox),
            _ => (ox, oz),
        };
        var terrainModMap = new Dictionary<(int, int), string>();
        foreach (var block in data.Blocks)
        {
            if (block.IsClipFlag) continue;
            var tmUnits = PakSvc.GetBlockUnits(block.Name, block.IsGround); // fallback Ground/Air inclus
            if (tmUnits == null) continue;
            foreach (var u in tmUnits)
            {
                if (u.TerrainModifier == null) continue;
                var (rx, rz) = RotOffset(u.X, u.Z, block.Dir);
                terrainModMap[(block.X + rx, block.Z + rz)] = u.TerrainModifier.ToLowerInvariant();
            }
        }

        // Colonnes (X,Z) ayant un block "StadiumDirt" (peu importe la hauteur) — sert uniquement à annoter
        // le terrain sous chaque block dans le panneau d'info (logique fidèle à Aide/BlockLister TerrainAt).
        var dirtColumns = new HashSet<(int, int)>();
        foreach (var block in data.Blocks)
            if (block.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase))
                dirtColumns.Add((block.X, block.Z));
        string TerrainAt(int x, int z) =>
            dirtColumns.Contains((x, z)) ? "Dirt"
            : terrainModMap.TryGetValue((x, z), out var m) ? char.ToUpperInvariant(m[0]) + m[1..]
            : "Grass";

        // DirtCovered : StadiumDirt masqué par un autre block au-dessus (même x,z, Y strictement supérieur)
        // Fidèle à Aide/BlockLister : ces blocks existent (occupent les cellules) mais ne sont pas rendus.
        var aboveByXZ = new Dictionary<(int, int), List<int>>();
        foreach (var b in data.Blocks)
        {
            if (b.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase)) continue;
            if (!aboveByXZ.TryGetValue((b.X, b.Z), out var aYs)) aboveByXZ[(b.X, b.Z)] = aYs = [];
            aYs.Add(b.Y);
        }

        var placements = new Dictionary<(string Pak, int Idx), List<object>>();
        int resolved = 0, skippedNoPak = 0, skippedNoSolid = 0;

        foreach (var block in data.Blocks)
        {
            if (block.IsClipFlag) continue;
            // DirtCovered : StadiumDirt sous un autre block → ne pas rendre (fidèle à BlockLister)
            if (block.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase)
                && aboveByXZ.TryGetValue((block.X, block.Z), out var coverYs)
                && coverYs.Any(y => y > block.Y))
                continue;
            var pakName = PakService.PakKeys.Keys.FirstOrDefault(p =>
                block.Name.StartsWith(p, StringComparison.OrdinalIgnoreCase));
            if (pakName == null || PakSvc.GetCached(pakName) == null)
            {
                skippedNoPak++;
                continue;
            }

            var resolved2 = PakSvc.ResolveBlock(block.Name, block.IsGround, block.Variant, block.SubVariant);
            if (resolved2 == null) { skippedNoSolid++; continue; }

            var key = (resolved2.Value.Pak, resolved2.Value.Index);
            if (!placements.TryGetValue(key, out var list))
                placements[key] = list = [];

            var (sx, sz, h) = PakSvc.GetBlockCoordSize(resolved2.Value.Pak, block.Name, block.IsGround);
            bool isClip = block.Name.Contains("Clip", StringComparison.OrdinalIgnoreCase);
            string terrainAt = TerrainAt(block.X, block.Z); // "Dirt" | "Fabric" | "Grass"
            string terrainAtLower = terrainAt.ToLowerInvariant();
            // StadiumDirt*/StadiumGrass sont eux-mêmes la source du terrain "dirt"/"grass" : jamais touchés.
            // StadiumFabric* n'est exclu que si le terrain résolu est ENCORE "fabric" (auto-référence) —
            // si le dirt a pris la priorité à cette position, son mesh doit quand même être traité normalement.
            bool skipTerrainMesh = block.Name.StartsWith("StadiumDirt", StringComparison.OrdinalIgnoreCase)
                || block.Name.Equals("StadiumGrass", StringComparison.OrdinalIgnoreCase)
                || (terrainAtLower == "fabric" && block.Name.StartsWith("StadiumFabric", StringComparison.OrdinalIgnoreCase));
            string? blockTerrainMod = (skipTerrainMesh || terrainAtLower == "grass") ? null : terrainAtLower;
            var placement = new { x = block.X, y = block.Y, z = block.Z, dir = block.Dir, sx, sz, h, isClip, blockName = block.Name, terrainMod = blockTerrainMod, isGround = block.IsGround, skipTerrainMesh, terrainAt };
            list.Add(placement);
            resolved++;

            // EditorHelper/EditorHelperArrow pour Checkpoint/Start/Finish (selon préfixe directionnel)
            bool isSpecial2 = block.Name.Contains("Checkpoint", StringComparison.OrdinalIgnoreCase)
                || block.Name.Contains("Start", StringComparison.OrdinalIgnoreCase)
                || block.Name.Contains("Finish", StringComparison.OrdinalIgnoreCase);
            if (isSpecial2)
            {
                var ehIndices = PakSvc.FindEditorHelperIndices(resolved2.Value.Pak, resolved2.Value.Index, block.Name).Indices;
                var ehColor   = GetEditorHelperColor(block.Name);
                foreach (var helperIdx in ehIndices)
                {
                    var helperKey = (resolved2.Value.Pak, helperIdx);
                    if (!placements.TryGetValue(helperKey, out var helperList))
                        placements[helperKey] = helperList = [];
                    var solidFile = PakSvc.GetSolidFileName(resolved2.Value.Pak, helperIdx) ?? "";
                    var helperType = solidFile.Contains("Arrow", StringComparison.OrdinalIgnoreCase) ? "arrow" : "helper";
                    helperList.Add(new { x = block.X, y = block.Y, z = block.Z, dir = block.Dir, sx, sz, h, color = ehColor, helperType });
                }
            }
        }

        if (placements.Count == 0)
        {
            var firstBlock = data.Blocks.FirstOrDefault();
            var firstPak = firstBlock != null ? PakService.PakKeys.Keys.FirstOrDefault(p =>
                firstBlock.Name.StartsWith(p, StringComparison.OrdinalIgnoreCase)) : null;
            var detail = new List<string>();
            if (firstBlock != null) detail.Add($"1er bloc: \"{firstBlock.Name}\" → pak: {firstPak ?? "inconnu"}");
            if (pakErrors.Count > 0) detail.Add($"erreurs: {string.Join(", ", pakErrors.Select(e => $"{e.Key}: {e.Value}"))}");
            if (skippedNoPak > 0) detail.Add($"{skippedNoPak} blocs sans pak");
            if (skippedNoSolid > 0) detail.Add($"{skippedNoSolid} blocs sans solid");
            State.MapStatus = $"❌ 0/{data.Blocks.Count} blocs — {string.Join(" | ", detail)}";
            State.MapIsLoading = false;
            State.NotifyStateChanged();
            return;
        }

        // ── Phase 0.5 : ajouter les clip blocks manquants ──────────
        var clipBlockPositions = new HashSet<(int, int)>(); // pour exclure du terrain fill et des zone faces
        {
            var existingBlocks = new HashSet<string>();
            foreach (var b in data.Blocks)
                existingBlocks.Add($"{b.X}|{b.Y}|{b.Z}|{b.Name}");
            var clipBlocks = ClipBlockHelper.CreateClipBlocks(data.Blocks, PakSvc);
            foreach (var clip in clipBlocks)
            {
                if (existingBlocks.Contains($"{clip.X}|{clip.Y}|{clip.Z}|{clip.Name}")) continue;

                var pakName2 = PakService.PakKeys.Keys.FirstOrDefault(p =>
                    clip.Name.StartsWith(p, StringComparison.OrdinalIgnoreCase));
                if (pakName2 == null || PakSvc.GetCached(pakName2) == null) continue;

                var resolved3 = PakSvc.ResolveBlock(clip.Name, clip.IsGround, clip.Variant, clip.SubVariant);
                if (resolved3 == null) continue;

                var key2 = (resolved3.Value.Pak, resolved3.Value.Index);
                if (!placements.TryGetValue(key2, out var list2))
                    placements[key2] = list2 = [];

                var (sx2, sz2, h2) = PakSvc.GetBlockCoordSize(resolved3.Value.Pak, clip.Name, clip.IsGround);
                var clipTerrainAt = TerrainAt(clip.X, clip.Z);
                var clipTerrainAtLower = clipTerrainAt.ToLowerInvariant();
                var clipSkipTerrainMesh = clip.Name.StartsWith("StadiumDirt", StringComparison.OrdinalIgnoreCase)
                    || clip.Name.Equals("StadiumGrass", StringComparison.OrdinalIgnoreCase)
                    || (clipTerrainAtLower == "fabric" && clip.Name.StartsWith("StadiumFabric", StringComparison.OrdinalIgnoreCase));
                string? clipTerrainMod = (clipSkipTerrainMesh || clipTerrainAtLower == "grass") ? null : clipTerrainAtLower;
                list2.Add(new { x = clip.X, y = clip.Y, z = clip.Z, dir = clip.Dir, sx = sx2, sz = sz2, h = h2, isClip = true, blockName = clip.Name, terrainMod = clipTerrainMod, terrainAt = clipTerrainAt, skipTerrainMesh = clipSkipTerrainMesh });
                clipBlockPositions.Add((clip.X, clip.Z));
            }
        }

        // ── Phase 1 : génération — cache mémoire → IDB → parsing GBX ──────────
        State.MapStatus = $"Génération des modèles…"; State.MapProgress = 5; State.NotifyStateChanged();
        var generated = new Dictionary<(string, int), (string Obj, string Mtl)>(placements.Count);
        int genDone = 0;
        foreach (var ((pakName, solidIdx), _) in placements)
        {
            await Task.Yield(); // libère le thread JS entre chaque bloc pour éviter le freeze
            try
            {
                var model = await GetModelFast(pakName, solidIdx);
                if (model != null) generated[(pakName, solidIdx)] = model.Value;
            }
            catch { }
            genDone++;
            if (genDone % 5 == 0) { State.MapProgress = 5 + genDone * 45 / placements.Count; State.NotifyStateChanged(); await Task.Delay(1); }
        }

        // ── Phase 1.5 : corriger les MTLs avec les slots pré-chargés ──
        {
            var fixedGenerated = new Dictionary<(string, int), (string Obj, string Mtl)>();
            foreach (var (key, val) in generated)
            {
                var fixedMtl = PakSvc.FixMtlPublic(val.Mtl);
                fixedGenerated[key] = (val.Obj, fixedMtl);
            }
            generated = fixedGenerated;
        }

        // ── Phase 2 : blob URL map global — collecte toutes les textures uniques par pak en un seul passage,
        // puis un seul appel JS + un seul passage d'extraction pak par pak (au lieu d'un aller-retour par bloc) ──
        State.MapStatus = "Chargement des textures…"; State.MapProgress = 50; State.NotifyStateChanged();
        var combinedBlobMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var allRequestedTextures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var texNamesByPak = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var ((pakName, _), (_, mtlText)) in generated)
        {
            if (!texNamesByPak.TryGetValue(pakName, out var pakTexNames))
                texNamesByPak[pakName] = pakTexNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in mtlText.Split('\n'))
            {
                var t = line.Trim();
                if ((t.StartsWith("map_Kd ") || t.StartsWith("map_Ks ") || t.StartsWith("bump ")) && t.Contains(' '))
                {
                    var fname = t[(t.IndexOf(' ') + 1)..].Trim();
                    if (!string.IsNullOrEmpty(fname)) { allRequestedTextures.Add(fname); pakTexNames.Add(fname); }
                }
                else if (t.StartsWith("# tex_") && t.Contains(' '))
                {
                    // Slots nommés (SoilFix, Blend1, Occlusion, etc.) — parsés par parseMtlAllTextures côté JS
                    var rest = t[6..];
                    var si = rest.IndexOf(' ');
                    if (si > 0)
                    {
                        var fname = rest[(si + 1)..].Trim();
                        if (!string.IsNullOrEmpty(fname)) { allRequestedTextures.Add(fname); pakTexNames.Add(fname); }
                    }
                }
            }
        }

        // Textures imposées pour les matériaux Stadium avec map_Kd incorrecte (MATERIAL_TEXTURE_OVERRIDES côté JS)
        if (generated.Keys.Any(k => k.Item1.Equals("Stadium", StringComparison.OrdinalIgnoreCase)))
        {
            if (!texNamesByPak.TryGetValue("Stadium", out var overrideTexNames))
                texNamesByPak["Stadium"] = overrideTexNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            overrideTexNames.Add("StadiumRoadDirtToRoadD.dds");
        }

        // Extraire les textures terrain modifier (Fabric) + zone faces explicites (StadiumDirt) dans le même passage groupé
        bool hasExplicitDirtZone = data.Blocks.Any(b => !b.IsClipFlag && b.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase));
        if (terrainModMap.Count > 0 || hasExplicitDirtZone)
        {
            if (!texNamesByPak.TryGetValue("Stadium", out var stadiumTexNames))
                texNamesByPak["Stadium"] = stadiumTexNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (hasExplicitDirtZone)
            {
                stadiumTexNames.Add("StadiumDirt1.dds");
                stadiumTexNames.Add("StadiumDirt2.dds");
            }
            if (terrainModMap.Values.Any(v => v == "fabric"))
                stadiumTexNames.Add("StadiumFabricFloorD.dds");
        }

        foreach (var (pakName, pakTexNames) in texNamesByPak)
        {
            var names = pakTexNames.ToArray();
            var blobMap = await FS.BuildTextureBlobUrlMapForNamesAsync(names, pakName);
            foreach (var kv in blobMap) combinedBlobMap.TryAdd(kv.Key, kv.Value);

            var stillMissing = names.Where(n => !combinedBlobMap.ContainsKey(n)).ToList();
            if (stillMissing.Count > 0)
            {
                var texBytes = await PakSvc.ExtractTexturesByNamesAsync(stillMissing);
                if (texBytes.Count > 0)
                {
                    var pakBlobMap = await FS.CreateTextureBlobUrlsFromBytesAsync(texBytes, pakName);
                    foreach (var kv in pakBlobMap) combinedBlobMap.TryAdd(kv.Key, kv.Value);
                }
            }
        }

        var missingTextures = allRequestedTextures.Where(t => !combinedBlobMap.ContainsKey(t)).ToList();
        if (missingTextures.Count > 0)
        {
            foreach (var t in missingTextures)
                Console.WriteLine($"[Texture manquante] {t}");
            Console.WriteLine($"Total: {missingTextures.Count} textures non trouvées sur {allRequestedTextures.Count}");
        }
        await FS.SetBlobUrlMapAsync(combinedBlobMap);

        // ── Phase 2.5 : restauration géométrie binaire depuis IDB en parallèle ──
        // Fait APRÈS setBlobUrlMap pour que deserializeRawObj trouve les blob URLs.
        // Si tout est dans IDB → Phase 3 = zéro OBJLoader, zéro parsing.
        State.MapStatus = "Restauration depuis le cache…"; State.MapProgress = 55; State.NotifyStateChanged();
        await FS.ClearModelCacheAsync(); // libère la RAM des blocs de la map précédente avant de repeupler
        var geomEntries = generated.Keys
            .Select(k => (object)new { cacheKey = $"{k.Item1}:{k.Item2}", geomKey = $"geom:{State.GameFolderKey}|{k.Item1}:{k.Item2}" })
            .ToArray();
        var geomHits = await FS.PopulateRawModelCacheFromIDBAsync(geomEntries);
        var geomKeys = generated.Keys.ToArray();
        for (int gi = 0; gi < geomHits.Length; gi++)
        {
            if (geomHits[gi]) State.JsModelCacheKeys.Add($"{geomKeys[gi].Item1}:{geomKeys[gi].Item2}");
        }

        // ── Phase 3 : ajout dans Three.js — rawModelCache évite de re-parser les OBJ ──
        State.MapStatus = "Rendu…"; State.MapProgress = 60; State.NotifyStateChanged();
        _cbiCache.Clear(); // libère les CGameCtnBlockInfo de la map précédente
        await FS.BeginMapAsync();
        int done = 0;
        foreach (var ((pakName, solidIdx), blockPlacements) in placements)
        {
            if (!generated.TryGetValue((pakName, solidIdx), out var m)) continue;
            await Task.Yield(); // libère le thread JS entre chaque bloc
            try
            {
                var ck = $"{pakName}:{solidIdx}";
                var gk = $"geom:{State.GameFolderKey}|{pakName}:{solidIdx}";
                bool jsCached = State.JsModelCacheKeys.Contains(ck);
                await FS.AddModelToMapAsync(
                    jsCached ? "" : m.Obj,
                    jsCached ? "" : m.Mtl,
                    pakName, blockPlacements, ck,
                    jsCached ? "" : gk);
                State.JsModelCacheKeys.Add(ck);
                done++;
            }
            catch { }
            if (done % 5 == 0) { State.MapProgress = 60 + done * 40 / placements.Count; State.NotifyStateChanged(); await Task.Delay(1); }
        }

        // Herbe uniquement pour les cartes Stadium
        var isStadiumMap = neededPaks.Any(p => "Stadium".Equals(p, StringComparison.OrdinalIgnoreCase));

        // UNE SEULE boucle — fidèle à Aide/BlockLister/Program.cs (lignes 117-144) :
        // occupied + modifiers calculés ensemble, même source (JSON puis CBI), TOUS les blocks non-clip.
        // Air blocks → modifiers seulement (pas occupied). Ground blocks → occupied ET modifiers.
        var occupiedTuples = new List<(int X, int Z, bool IsZone)>();
        var terrainModMapFill = new Dictionary<(int, int), string>(); // JSON+CBI, pour la reconstitution du sol
        if (isStadiumMap)
        {
            foreach (var b in data.Blocks)
            {
                if (b.IsClipFlag) continue; // clips se posent SUR le sol, n'occupent rien
                bool isZone = b.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase)
                           || b.Name.Equals("StadiumGrass", StringComparison.OrdinalIgnoreCase);

                // JSON pré-scanné d'abord, CBI en fallback — même ordre que BlockLister GetInfo.
                var jsonUnits = PakSvc.GetBlockUnits(b.Name, b.IsGround);
                if (jsonUnits != null && jsonUnits.Count > 0)
                {
                    foreach (var u in jsonUnits)
                    {
                        var (rx, rz) = RotOffset(u.X, u.Z, b.Dir);
                        var cell = (b.X + rx, b.Z + rz);
                        if (b.IsGround) occupiedTuples.Add((cell.Item1, cell.Item2, isZone));
                        if (u.TerrainModifier != null)
                            terrainModMapFill[cell] = u.TerrainModifier.ToLowerInvariant();
                    }
                    continue;
                }
                // Fallback CBI (comme BlockLister)
                var info = await GetBlockInfoAsync(b.Name);
                var units = (b.IsGround ? info?.GroundBlockUnitInfos : info?.AirBlockUnitInfos)
                         ?? info?.GroundBlockUnitInfos ?? info?.AirBlockUnitInfos;

                if (units == null || units.Length == 0)
                {
                    if (b.IsGround) occupiedTuples.Add((b.X, b.Z, isZone));
                    continue;
                }
                foreach (var u in units)
                {
                    var off = u.RelativeOffset;
                    var (rx, rz) = RotOffset(off.X, off.Z, b.Dir);
                    var cell = (b.X + rx, b.Z + rz);
                    if (b.IsGround) occupiedTuples.Add((cell.Item1, cell.Item2, isZone));
                    if (!string.IsNullOrEmpty(u.TerrainModifierId))
                        terrainModMapFill[cell] = u.TerrainModifierId.ToLowerInvariant();
                }
            }
        }
        // Liste explicite des cellules terrain — fidèle à la boucle floor de BlockLister (lignes 148-154).
        // Utilise terrainModMapFill (JSON+CBI) au lieu de terrainModMap (JSON seul) → données cohérentes.
        var occupiedForTerrain = new HashSet<(int, int)>(occupiedTuples.Select(t => (t.X, t.Z)));
        occupiedForTerrain.UnionWith(clipBlockPositions); // clips générés absents de data.Blocks
        var grassFill  = new List<object>();
        var dirtFill   = new List<object>();
        var fabricFill = new List<object>();
        if (isStadiumMap)
        {
            for (int x = 0; x < data.SizeX; x++)
                for (int z = 0; z < data.SizeZ; z++)
                {
                    if (occupiedForTerrain.Contains((x, z))) continue;
                    if (terrainModMapFill.TryGetValue((x, z), out var mod2))
                    {
                        if      (mod2 == "fabric") fabricFill.Add(new { x, z });
                        else if (mod2 == "dirt")   dirtFill.Add(new { x, z });
                        else                       grassFill.Add(new { x, z });
                    }
                    else
                        grassFill.Add(new { x, z });
                }
        }

        var zoneFaces = isStadiumMap
            ? data.Blocks
                .Where(b => (b.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase)
                          || b.Name.Equals("StadiumGrass", StringComparison.OrdinalIgnoreCase))
                          // DirtCovered : exclure les StadiumDirt sous un autre block (même logique que placements)
                          && !(b.Name.Equals("StadiumDirt", StringComparison.OrdinalIgnoreCase)
                               && aboveByXZ.TryGetValue((b.X, b.Z), out var zfYs)
                               && zfYs.Any(y => y > b.Y)))
                .Select(b =>
                {
                    string type = b.Name.Contains("Dirt", StringComparison.OrdinalIgnoreCase) ? "dirt" : "grass";
                    if (type == "grass" && terrainModMap.TryGetValue((b.X, b.Z), out var mod))
                        type = mod;
                    var pakName2 = PakService.PakKeys.Keys.FirstOrDefault(p =>
                        b.Name.StartsWith(p, StringComparison.OrdinalIgnoreCase)) ?? "";
                    var (_, _, h) = PakSvc.GetBlockCoordSize(pakName2, b.Name, true);
                    return (object)new { x = b.X, y = b.Y, z = b.Z, h, type };
                })
                .ToArray()
            : [];

        // nonZoneColumns : colonnes occupées par un bloc réel (non-zone, non-clip) → empêche les zone faces de se superposer.
        var nonZoneSet = new HashSet<(int, int)>(occupiedTuples.Where(t => !t.IsZone).Select(t => (t.X, t.Z)));
        foreach (var b in data.Blocks.Where(b => b.IsClipFlag))
            nonZoneSet.Add((b.X, b.Z));
        nonZoneSet.UnionWith(clipBlockPositions); // clips générés → pas de zone face dessus
        var nonZoneCols = nonZoneSet.Select(c => (object)new { x = c.Item1, z = c.Item2 }).ToArray();

        // ── Debug : résumé par type (équivalent du rapport Aide/BlockLister) ──────
        if (DebugResume && isStadiumMap)
        {
            var byName = data.Blocks.GroupBy(b => b.Name).OrderByDescending(g => g.Count()).ToList();
            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"[Resume] Blocks places   : {data.Blocks.Count}");
            sb.AppendLine($"[Resume] Sol StadiumGrass (reconstitue) : x{grassFill.Count}");
            if (dirtFill.Count   > 0) sb.AppendLine($"[Resume] TerrainModifier:dirt   : x{dirtFill.Count}");
            if (fabricFill.Count > 0) sb.AppendLine($"[Resume] TerrainModifier:fabric : x{fabricFill.Count}");
            foreach (var g in byName)
                sb.AppendLine($"[Resume] {g.Key,-42} x{g.Count()}");
            Console.WriteLine(sb.ToString());
        }

        await FS.FinalizeMapAsync(grassFill.ToArray(), dirtFill.ToArray(), fabricFill.ToArray(), zoneFaces, nonZoneCols);
        await FS.SetMapOffsetAsync(-512, -9, -512);
        await FS.SetRenderSettingsAsync(State.ShowEditorHelper, State.ShowEditorHelperArrow, State.ShowGlow);

        // Afficher les Triangles3D du MediaTracker
        State.Tri3dBlocks = data.Triangles3D;
        if (data.Triangles3D.Count > 0)
        {
            var tri3dData = data.Triangles3D.Select(t => (object)new
            {
                vertices = t.Vertices.Select(v => new { r = v.R, g = v.G, b = v.B, a = v.A }).ToArray(),
                indices = t.Indices,
                keyframes = t.Keyframes.Select(k => new { time = k.Time, positions = k.Positions }).ToArray(),
                is2D = t.Is2D
            }).ToArray();
            await JS.InvokeVoidAsync("TMNFeditorScene.addTriangles3D", (object)tri3dData);

            State.Tri3dEntries = data.AllTracks.Select(t =>
            {
                var entry = new AppState.Tri3DEntry
                {
                    MeshIndex = t.Tri3DIndex,
                    Name = string.IsNullOrWhiteSpace(t.TrackName) ? "Track" : t.TrackName,
                    ClipType = t.ClipType,
                    ClipName = t.ClipName,
                    ClipDisplayName = t.ClipDisplayName,
                    TrackName = t.TrackName,
                    HasMesh = t.Tri3DIndex >= 0,
                    Is2D = t.Tri3DIndex >= 0 && data.Triangles3D[t.Tri3DIndex].Is2D,
                };
                if (entry.HasMesh)
                {
                    var tri = data.Triangles3D[t.Tri3DIndex];
                    entry.Vertices = tri.Vertices.Length;
                    entry.Triangles = tri.Indices.Length / 3;
                }
                return entry;
            }).ToList();
            State.AnimatedLoadedTracks.Clear();
            for (int i = 0; i < data.Triangles3D.Count; i++)
            {
                var tri = data.Triangles3D[i];
                if (tri.Keyframes.Length > 2)
                    State.AnimatedLoadedTracks.Add(i);
                else if (tri.Keyframes.Length == 2 && tri.Vertices.Length > 0)
                {
                    var p0 = tri.Keyframes[0].Positions;
                    var p1 = tri.Keyframes[1].Positions;
                    for (int j = 0; j < p0.Length; j++)
                    {
                        if (Math.Abs(p0[j] - p1[j]) > 0.0001f)
                        { State.AnimatedLoadedTracks.Add(i); break; }
                    }
                }
            }
            State.SelectedClipType = State.Tri3dEntries.FirstOrDefault()?.ClipType ?? "";
            State.SelectedClipIdx = 0;
            await State.SyncTriVisibilityToClipType();
        }
        else
        {
            State.Tri3dEntries = new();
        }

        State.ShowMapOffsetPanel = true;

        State.MapStatus = pakErrors.Count > 0 ? $"❌ paks manquants: {string.Join(", ", pakErrors.Keys)}" : "";
        State.MapIsLoading = false;
        State.NotifyStateChanged();
        await FS.RevokeTexturesAfterLoadAsync();
        GC.Collect();
    }
}
