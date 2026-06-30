using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace TMNFeditor.Services;

public partial class AppState
{
    // ─── Import tabs ──────────────────────────────────────────────────────────
    public bool ImportPreviewInited = false;
    public int  ImportTabCount      = 0;
    public int  ActiveImportTab     = 0;

    public async Task TriggerImportFile()
        => await JS.InvokeVoidAsync("TMNFeditorScene.triggerFileInput", "import-file-input");

    public async Task DeleteActiveImport()
    {
        if (ImportTabCount <= 0) return;
        var idx = ActiveImportTab;
        foreach (var e in Tri3dEntries.Where(e => e.ImportIndex == idx))
        {
            e.ImportIndex = -1;
            e.Name = e.TrackName;
        }
        if (PerImportAnim.ContainsKey(idx)) PerImportAnim.Remove(idx);
        var newCount = await JS.InvokeAsync<int>("TMNFeditorScene.removeImportModel", idx);
        ImportTabCount = newCount;
        ActiveImportTab = newCount > 0 ? Math.Min(idx, newCount - 1) : 0;
        ActiveTabInScene = newCount > 0 && ActiveImportTab >= 0;
        ImportMaterials = new();
        if (newCount == 0) ActiveTabInScene = false;
    }

    // ─── Selection / position / origin ────────────────────────────────────────
    public bool   ActiveTabInScene = false;
    public double ImportPosX, ImportPosY, ImportPosZ;
    public double ImportOriginX
    {
        get => ActiveImportTab >= 0 ? GetOrCreateAnim(ActiveImportTab).OriginX : _fallbackOriginX;
        set { if (ActiveImportTab >= 0) GetOrCreateAnim(ActiveImportTab).OriginX = value; else _fallbackOriginX = value; }
    }
    public double ImportOriginY
    {
        get => ActiveImportTab >= 0 ? GetOrCreateAnim(ActiveImportTab).OriginY : _fallbackOriginY;
        set { if (ActiveImportTab >= 0) GetOrCreateAnim(ActiveImportTab).OriginY = value; else _fallbackOriginY = value; }
    }
    public double ImportOriginZ
    {
        get => ActiveImportTab >= 0 ? GetOrCreateAnim(ActiveImportTab).OriginZ : _fallbackOriginZ;
        set { if (ActiveImportTab >= 0) GetOrCreateAnim(ActiveImportTab).OriginZ = value; else _fallbackOriginZ = value; }
    }
    private double _fallbackOriginX, _fallbackOriginY, _fallbackOriginZ;
    public double Tri3dPosX, Tri3dPosY, Tri3dPosZ;

    public bool MeshIsSelected = false;
    public bool HasActiveObject => MeshIsSelected || SelectedTri3DTrack is { HasMesh: true };

    public async void OnOriginChange(ChangeEventArgs e, char axis)
    {
        if (!double.TryParse(e.Value?.ToString(),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var v)) return;
        if (axis == 'x') ImportOriginX = v;
        else if (axis == 'y') ImportOriginY = v;
        else ImportOriginZ = v;
        await JS.InvokeVoidAsync("TMNFeditorScene.setImportOrigin", ImportOriginX, ImportOriginY, ImportOriginZ);
    }

    public async void OnPosChange(ChangeEventArgs e, char axis)
    {
        if (!double.TryParse(e.Value?.ToString(),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var v)) return;
        if (SelectedTri3DTrack is { HasMesh: true })
        {
            if (axis == 'x') Tri3dPosX = v;
            else if (axis == 'y') Tri3dPosY = v;
            else Tri3dPosZ = v;
            await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DPosition", SelectedTri3DTrack.MeshIndex, Tri3dPosX, Tri3dPosY, Tri3dPosZ);
        }
        else
        {
            if (axis == 'x') ImportPosX = v;
            else if (axis == 'y') ImportPosY = v;
            else ImportPosZ = v;
            await JS.InvokeVoidAsync("TMNFeditorScene.setImportPosition", ImportPosX, ImportPosY, ImportPosZ);
        }
    }

    public async Task ResetModelPosition()
    {
        if (SelectedTri3DTrack is { HasMesh: true })
        {
            Tri3dPosX = 0; Tri3dPosY = 0; Tri3dPosZ = 0;
            await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DPosition", SelectedTri3DTrack.MeshIndex, 0.0, 0.0, 0.0);
        }
        else
        {
            ImportPosX = 0; ImportPosY = 0; ImportPosZ = 0;
            await JS.InvokeVoidAsync("TMNFeditorScene.setImportPosition", 0.0, 0.0, 0.0);
        }
    }

    // ─── ImportExportData DTO ─────────────────────────────────────────────────
    public class ImportExportData
    {
        [System.Text.Json.Serialization.JsonPropertyName("objText")]
        public string ObjText { get; set; } = "";
        [System.Text.Json.Serialization.JsonPropertyName("mtlText")]
        public string MtlText { get; set; } = "";
        [System.Text.Json.Serialization.JsonPropertyName("posX")]
        public float PosX { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("posY")]
        public float PosY { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("posZ")]
        public float PosZ { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("rotX")]
        public float RotX { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("rotY")]
        public float RotY { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("rotZ")]
        public float RotZ { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("scaleX")]
        public float ScaleX { get; set; } = 1;
        [System.Text.Json.Serialization.JsonPropertyName("scaleY")]
        public float ScaleY { get; set; } = 1;
        [System.Text.Json.Serialization.JsonPropertyName("scaleZ")]
        public float ScaleZ { get; set; } = 1;
        [System.Text.Json.Serialization.JsonPropertyName("colorHex")]
        public string? ColorHex { get; set; }
        [System.Text.Json.Serialization.JsonPropertyName("scale2D")]
        public float Scale2D { get; set; } = 1;
    }

    // ─── Shading Intensity ────────────────────────────────────────────────────
    public double ShadingIntensity
    {
        get => ActiveImportTab >= 0 ? GetOrCreateAnim(ActiveImportTab).Shading : _fallbackShading;
        set { if (ActiveImportTab >= 0) GetOrCreateAnim(ActiveImportTab).Shading = value; else _fallbackShading = value; }
    }
    private double _fallbackShading = 0.0;

    public void OnShadingSlider(ChangeEventArgs e)
    {
        if (double.TryParse(e.Value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v))
            ShadingIntensity = Math.Clamp(v, 0, 1);
    }

    public void OnShadingInput(ChangeEventArgs e)
    {
        if (double.TryParse(e.Value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v))
            ShadingIntensity = Math.Clamp(v, 0, 1);
    }

    public void ResetShading() => ShadingIntensity = 0.0;

    // ─── Matériaux ─────────────────────────────────────────────────────────────
    public class ImportMatDto
    {
        public string Key  { get; set; } = "";
        public string Name { get; set; } = "";
        public string Hex  { get; set; } = "#ffffff";
    }

    public List<ImportMatDto> ImportMaterials = new();

    public async Task SetMaterialColor(ImportMatDto mat, string hex)
    {
        mat.Hex = hex;
        await JS.InvokeVoidAsync("TMNFeditorScene.setImportMaterialColor", mat.Key, hex);
    }

    public async Task ResetMaterials()
        => await JS.InvokeVoidAsync("TMNFeditorScene.resetImportMaterials");

    public async Task SwitchImportTab(int idx)
    {
        ActiveImportTab = idx;
        await JS.InvokeVoidAsync("TMNFeditorScene.switchImportTab", idx, ImportMode == "2D");
    }

    public async Task SendImportToMainScene()
        => await JS.InvokeVoidAsync("TMNFeditorScene.sendImportToMainScene", ActiveImportTab, ImportMode == "2D");

    // ─── Toolbar Triangles3D ───────────────────────────────────────────────────
    public string T3dTool      = "none";
    public bool   ImportVisible = true;

    public async Task SetT3DTool(string tool)
    {
        T3dTool = (T3dTool == tool) ? "none" : tool;
        await JS.InvokeVoidAsync("TMNFeditorScene.setTransformMode", T3dTool);
    }

    public async Task MirrorImport()
        => await JS.InvokeVoidAsync("TMNFeditorScene.mirrorImport");

    public bool ShowOriginDot = false;

    public async Task ToggleOriginDot()
    {
        ShowOriginDot = !ShowOriginDot;
        await JS.InvokeVoidAsync("TMNFeditorScene.setOriginDotVisible", ShowOriginDot);
    }

    public async Task SelectAnimTab(string tab)
    {
        T3dAnimTab = tab;
        if (tab == "Origin" && !ShowOriginDot)
        {
            ShowOriginDot = true;
            await JS.InvokeVoidAsync("TMNFeditorScene.setOriginDotVisible", true);
        }
        else if (tab != "Origin" && ShowOriginDot)
        {
            ShowOriginDot = false;
            await JS.InvokeVoidAsync("TMNFeditorScene.setOriginDotVisible", false);
        }
    }

    public async Task CenterImportOrigin()
        => await JS.InvokeVoidAsync("TMNFeditorScene.centerImportOrigin");

    public async Task ToggleImportVisible()
    {
        ImportVisible = !ImportVisible;
        await JS.InvokeVoidAsync("TMNFeditorScene.setImportVisible", ImportVisible);
    }
}
