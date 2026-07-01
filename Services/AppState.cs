using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace TMNFeditor.Services;

// État partagé entre Home.razor et ses composants enfants.
// Contient les champs/méthodes auparavant dans le @code de Home.razor qui sont
// utilisés par plusieurs composants. Les composants injectent AppState et
// appellent StateHasChanged()/NotifyStateChanged() quand ils modifient l'état.
public partial class AppState
{
    private readonly IJSRuntime JS;
    public AppState(IJSRuntime js) { JS = js; }

    // Notifie les composants abonnés qu'ils doivent se re-rendre.
    public event Action? OnStateChanged;
    public void NotifyStateChanged() => OnStateChanged?.Invoke();

    // ─── i18n ────────────────────────────────────────────────────────────────
    public string Lang = "FR";
    public string T(string key) => Lang == "EN" && _en.TryGetValue(key, out var v) ? v : key;
    private static readonly Dictionary<string, string> _en = new()
    {
        ["Sélectionner le dossier du jeu"] = "Select game folder",
        ["Charger une carte"] = "Load a map",
        ["Effacer la carte"] = "Clear map",
        ["Sélectionnez un dossier de jeu…"] = "Select a game folder…",
        ["Rechercher un bloc…"] = "Search a block…",
        ["Ouverture de"] = "Opening",
        ["Envoyer vers le rendu 3D"] = "Send to 3D render",
        ["Envoyer vers le rendu 2D"] = "Send to 2D render",
        ["Importer un .obj"] = "Import a .obj",
        ["Ajouter un clip"] = "Add a clip",
        ["Supprimer le clip"] = "Remove clip",
        ["Ajouter un track"] = "Add a track",
        ["Supprimer le track"] = "Remove track",
        ["Cacher"] = "Hide",
        ["Afficher"] = "Show",
        ["Tout afficher"] = "Show all",
        ["Tout cacher"] = "Hide all",
        ["Importer le modèle actif dans ce track"] = "Import active model into this track",
        ["Ajouter"] = "Add",
        ["Supprimer"] = "Remove",
        ["chargé"] = "loaded",
        ["non trouvé"] = "not found",
        ["Confirmer"] = "Confirm",
        ["Retour au début"] = "Go to start",
        ["Aller à la fin"] = "Go to end",
        ["Déplacer"] = "Move",
        ["Afficher l'origine"] = "Show origin",
        ["Centrer l'origine"] = "Center origin",
        ["Centrer à la mesh"] = "Center to mesh",
        ["paks manquants"] = "missing paks",
        ["Aide"] = "Help",
        ["Réglages"] = "Settings",
        ["Rendu"] = "Render",
        ["Retirer l'import de ce track"] = "Remove import from this track",
        ["Texte"] = "Text",
        ["Animation existante"] = "Existing animation",
        ["Préparation des blocs…"] = "Preparing blocks…",
        ["Écriture du fichier…"] = "Writing file…",
        ["Téléchargement…"] = "Downloading…",
        ["Entrez votre texte…"] = "Enter your text…",
        ["Police"] = "Font",
        ["Épaisseur"] = "Thickness",
        ["Espacement"] = "Spacing",
        ["Style"] = "Style",
        ["Gras"] = "Bold",
        ["Italique"] = "Italic",
        ["Souligné"] = "Underline",
        ["Barré"] = "Strikethrough",
        ["Déposez un .obj ici"] = "Drop a .obj here",
        ["Carte non chargée"] = "No map loaded",
        ["Seul les cartes Stadium sont supportées"] = "Only Stadium maps are supported",
        [".mtl optionnel"] = ".mtl optional",
        ["Aucun modèle importé"] = "No model imported",
        ["Modèle non transféré ou non sélectionné"] = "Model not sent or not selected",
        ["Aucun matériau"] = "No material",
        ["Présentation"] = "Overview",
        ["Comment ça marche ?"] = "How does it work?",
        ["Icônes"] = "Icons",
    };

    // ─── Render settings ─────────────────────────────────────────────────────
    public bool ShowSettings = false;
    public bool ShowEditorHelper = true;
    public bool ShowEditorHelperArrow = true;
    public bool ShowGlow = true;
    public void ToggleSettings() { ShowSettings = !ShowSettings; }

    // ─── Help ────────────────────────────────────────────────────────────────
    public bool ShowHelp = false;
    public void ToggleHelp() { ShowHelp = !ShowHelp; }

    // ─── Block panel ──────────────────────────────────────────────────────────
    public string GameFolderStatus = "Non sélectionné";
    public List<string> PakNames = [];
    public string CurrentPak = "";
    public List<SolidItem> Solids = [];
    public List<SolidItem> FilteredSolids = [];
    public string SearchQuery = "";
    public string StatsText = "—";
    public int ActiveModelIndex = -1;
    public bool IsLoadingPak = false;
    public bool IsLoadingModel = false;
    public readonly HashSet<string> JsModelCacheKeys = new(StringComparer.OrdinalIgnoreCase);
    public string GameFolderKey = "";
    public bool NadeoError = false;
    public record SolidItem(int OriginalIndex, string DisplayName);

    // ─── Map mode ─────────────────────────────────────────────────────────────
    public string MapStatus = "";
    public string? RejectedEnv;
    public bool MapIsLoading = false;
    public int MapProgress = 0;

    public bool ShowBlockPanel = false;
    public bool ShowMapOffsetPanel = false;
    public bool ShowTriangles3D = false;
    public bool GridOverlay = false;
    public bool Tri3DPanelCollapsed = false;

    public async Task ToggleGridOverlay()
    {
        GridOverlay = !GridOverlay;
        await JS.InvokeVoidAsync("TMNFeditorScene.toggleGridOverlay", GridOverlay);
    }

    public bool BlockSelectMode = false;
    public async Task ToggleBlockSelectMode()
    {
        BlockSelectMode = !BlockSelectMode;
        await JS.InvokeVoidAsync("TMNFeditorScene.setBlockSelectMode", BlockSelectMode);
    }

    // ─── Triangles3D animation tabs ───────────────────────────────────────────
    public string T3dAnimTab = "Model Position";
    private static readonly string[] _t3dAnimTabs3D = ["Model Position", "Origin", "Translation", "Scaling", "Rotation", "Orbit", "Shading Intensity", "Material", "Text 3D", "Mediatracker"];
    private static readonly string[] _t3dAnimTabs2D = ["Model Position", "Origin", "Translation", "Scaling", "Rotation", "Orbit", "Shading Intensity", "Material", "Text 2D", "Mediatracker"];
    public string[] T3dAnimTabs => ImportMode == "2D" ? _t3dAnimTabs2D : _t3dAnimTabs3D;
    public bool IsTextTab => T3dAnimTab is "Text 3D" or "Text 2D";

    public async Task ToggleBlockPanel()   { bool next = !ShowBlockPanel;  CloseAllPanels(); ShowBlockPanel  = next; if (next) await JS.InvokeVoidAsync("TMNFeditorScene.showBlockView"); }
    public async Task ToggleTriangles3D() { bool next = !ShowTriangles3D; CloseAllPanels(); ShowTriangles3D = next; Tri3DPanelCollapsed = false; if (next) { ImportVisible = true; await JS.InvokeVoidAsync("TMNFeditorScene.showTrianglesView"); await SyncTriVisibilityToClipType(); } else { await JS.InvokeVoidAsync("TMNFeditorScene.showBlockView"); } }
    public void CloseAllPanels() { ShowBlockPanel = false; ShowTriangles3D = false; Tri3DPanelCollapsed = false; GridOverlay = false; ClickedBlockMat = null; }

    // ─── Import mode ──────────────────────────────────────────────────────────
    public string ImportMode = "3D";
    public async Task SetImportMode(string mode)
    {
        ImportMode = mode;
        if (T3dAnimTab == "Text 3D" && mode == "2D") T3dAnimTab = "Text 2D";
        else if (T3dAnimTab == "Text 2D" && mode == "3D") T3dAnimTab = "Text 3D";
        GridOverlay = mode == "2D";
        Text3dActiveIdx = -1;
        Text3dValue = "";
        await JS.InvokeVoidAsync("TMNFeditorScene.setImportTopView", mode == "2D");
        await JS.InvokeVoidAsync("TMNFeditorScene.toggleGridOverlay", GridOverlay);
    }

    // Material click block info (used by Home's JSInvokable). Stored here for sharing.
    public string? ClickedBlockMat;
    public string LoadedMtl = "";
}
