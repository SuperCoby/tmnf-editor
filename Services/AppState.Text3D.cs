using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace TMNFeditor.Services;

public partial class AppState
{
    // ─── Font names ────────────────────────────────────────────────────────────
    private static readonly Dictionary<string, string> _fontDisplayNames = new()
    {
        ["arimo"] = "Arial",
        ["tinos"] = "Times New Roman",
        ["courier_prime"] = "Courier New",
        ["comic_neue"] = "Comic Sans",
        ["anton"] = "Impact",
        ["eb_garamond"] = "Garamond",
        ["libre_franklin"] = "Franklin Gothic",
        ["raleway"] = "Century Gothic",
    };
    public static string FormatFontName(string f) =>
        _fontDisplayNames.TryGetValue(f, out var name) ? name
        : string.Join(" ", f.Split('_').Select(w => char.ToUpper(w[0]) + w[1..]));

    // ─── Text 3D / 2D ──────────────────────────────────────────────────────────
    public string Text3dValue = "";
    public double Text3dThickness = 0.0;
    public double Text3dLetterSpacing = 0.3;
    public string Text3dFont = "arimo";
    public bool Text3dBold, Text3dItalic, Text3dUnderline, Text3dStrike;
    public static readonly string[] Text3dFonts = [
        "arimo", "helvetiker", "roboto", "inter", "open_sans", "noto_sans",
        "montserrat", "poppins", "ubuntu", "fira_sans", "cantarell", "oswald",
        "raleway", "libre_franklin",
        "tinos", "optimer", "gentilis", "eb_garamond", "lora",
        "playfair_display", "merriweather",
        "courier_prime", "droid_sans_mono", "source_code_pro",
        "droid_sans", "droid_serif",
        "comic_neue", "anton"
    ];

    public class Text3DEntry { public string Text = ""; public string Font = "arimo"; public double Thickness; public double Spacing; public bool Bold; public bool Italic; public bool Underline; public bool Strike; public int SceneIdx; public bool Is2D; }
    public readonly List<Text3DEntry> Text3dEntries = new();
    public int Text3dActiveIdx = -1;

    public async Task SendText3DToScene()
    {
        if (string.IsNullOrWhiteSpace(Text3dValue)) return;
        var idx = await JS.InvokeAsync<int>("TMNFeditorScene.createText3D", Text3dValue, Text3dFont, Text3dThickness, Text3dLetterSpacing, Text3dBold, Text3dItalic, Text3dUnderline, Text3dStrike);
        var entry = new Text3DEntry { Text = Text3dValue, Font = Text3dFont, Thickness = Text3dThickness, Spacing = Text3dLetterSpacing, Bold = Text3dBold, Italic = Text3dItalic, Underline = Text3dUnderline, Strike = Text3dStrike, SceneIdx = idx, Is2D = false };
        Text3dEntries.Add(entry);
        Text3dActiveIdx = -1;
        Text3dValue = "";
    }

    public async Task SendText2DToScene()
    {
        if (string.IsNullOrWhiteSpace(Text3dValue)) return;
        var idx = await JS.InvokeAsync<int>("TMNFeditorScene.createText2D", Text3dValue, Text3dFont, Text3dThickness, Text3dLetterSpacing, Text3dBold, Text3dItalic, Text3dUnderline, Text3dStrike);
        var entry = new Text3DEntry { Text = Text3dValue, Font = Text3dFont, Thickness = Text3dThickness, Spacing = Text3dLetterSpacing, Bold = Text3dBold, Italic = Text3dItalic, Underline = Text3dUnderline, Strike = Text3dStrike, SceneIdx = idx, Is2D = true };
        Text3dEntries.Add(entry);
        Text3dActiveIdx = -1;
        Text3dValue = "";
    }

    public async Task UpdateActiveText3D()
    {
        if (Text3dActiveIdx < 0) return;
        var entry = Text3dEntries.Find(e => e.SceneIdx == Text3dActiveIdx);
        if (entry == null) return;
        await JS.InvokeVoidAsync("TMNFeditorScene.updateText3D", Text3dActiveIdx, entry.Text, Text3dFont, Text3dThickness, Text3dLetterSpacing, Text3dBold, Text3dItalic, Text3dUnderline, Text3dStrike);
    }

    public bool IsText3DUnchanged()
    {
        var entry = Text3dEntries.Find(e => e.SceneIdx == Text3dActiveIdx);
        if (entry == null) return true;
        return Text3dValue == entry.Text && Text3dFont == entry.Font
            && Text3dThickness == entry.Thickness && Text3dLetterSpacing == entry.Spacing
            && Text3dBold == entry.Bold && Text3dItalic == entry.Italic
            && Text3dUnderline == entry.Underline && Text3dStrike == entry.Strike;
    }

    public void OnText3DTextChanged(ChangeEventArgs e)
    {
        Text3dValue = e.Value?.ToString() ?? "";
    }

    public async Task OnText3DFontChanged(ChangeEventArgs e)
    {
        Text3dFont = e.Value?.ToString() ?? "helvetiker";
        await UpdateActiveText3D();
    }

    public async Task OnText3DThicknessChanged(ChangeEventArgs e)
    {
        if (double.TryParse(e.Value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v))
            Text3dThickness = v;
        await UpdateActiveText3D();
    }

    public async Task OnText3DSpacingChanged(ChangeEventArgs e)
    {
        if (double.TryParse(e.Value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v))
            Text3dLetterSpacing = v;
        await UpdateActiveText3D();
    }

    public async Task OnText3DBoldToggle() { Text3dBold = !Text3dBold; await UpdateActiveText3D(); }
    public async Task OnText3DItalicToggle() { Text3dItalic = !Text3dItalic; await UpdateActiveText3D(); }
    public async Task OnText3DUnderlineToggle() { Text3dUnderline = !Text3dUnderline; await UpdateActiveText3D(); }
    public async Task OnText3DStrikeToggle() { Text3dStrike = !Text3dStrike; await UpdateActiveText3D(); }

    public async Task ConfirmText3DEdit()
    {
        if (Text3dActiveIdx < 0 || string.IsNullOrWhiteSpace(Text3dValue)) return;
        var entry = Text3dEntries.Find(e => e.SceneIdx == Text3dActiveIdx);
        if (entry == null) return;
        entry.Text = Text3dValue;
        entry.Font = Text3dFont;
        entry.Thickness = Text3dThickness;
        entry.Spacing = Text3dLetterSpacing;
        entry.Bold = Text3dBold;
        entry.Italic = Text3dItalic;
        entry.Underline = Text3dUnderline;
        entry.Strike = Text3dStrike;
        await JS.InvokeVoidAsync("TMNFeditorScene.updateText3D", Text3dActiveIdx, Text3dValue, Text3dFont, Text3dThickness, Text3dLetterSpacing, Text3dBold, Text3dItalic, Text3dUnderline, Text3dStrike);
        Text3dActiveIdx = -1;
        Text3dValue = "";
    }

    public void SelectText3DBySceneIdx(int idx)
    {
        var entry = Text3dEntries.Find(e => e.SceneIdx == idx);
        if (entry == null) return;
        Text3dActiveIdx = idx;
        Text3dValue = entry.Text;
        Text3dFont = entry.Font;
        Text3dThickness = entry.Thickness;
        Text3dLetterSpacing = entry.Spacing;
        Text3dBold = entry.Bold;
        Text3dItalic = entry.Italic;
        Text3dUnderline = entry.Underline;
        Text3dStrike = entry.Strike;
    }

    public async Task SelectText3DEntry(Text3DEntry entry)
    {
        var needMode = entry.Is2D ? "2D" : "3D";
        if (ImportMode != needMode)
            await SetImportMode(needMode);
        SelectText3DBySceneIdx(entry.SceneIdx);
        await JS.InvokeVoidAsync("TMNFeditorScene.selectText3D", entry.SceneIdx);
    }

    public async Task DeselectText3D()
    {
        if (Text3dActiveIdx < 0) return;
        await RevertText3DIfNeeded();
        Text3dActiveIdx = -1;
        Text3dValue = "";
    }

    public async Task RevertText3DIfNeeded()
    {
        if (Text3dActiveIdx < 0) return;
        var entry = Text3dEntries.Find(e => e.SceneIdx == Text3dActiveIdx);
        if (entry == null) return;
        if (Text3dValue != entry.Text || Text3dFont != entry.Font || Text3dThickness != entry.Thickness
            || Text3dLetterSpacing != entry.Spacing || Text3dBold != entry.Bold
            || Text3dItalic != entry.Italic || Text3dUnderline != entry.Underline
            || Text3dStrike != entry.Strike)
        {
            await JS.InvokeVoidAsync("TMNFeditorScene.updateText3D", Text3dActiveIdx,
                entry.Text, entry.Font, entry.Thickness, entry.Spacing,
                entry.Bold, entry.Italic, entry.Underline, entry.Strike);
        }
    }

    public async Task RemoveText3DEntry(Text3DEntry entry)
    {
        await JS.InvokeVoidAsync("TMNFeditorScene.removeText3D", entry.SceneIdx);
        Text3dEntries.Remove(entry);
        if (Text3dActiveIdx == entry.SceneIdx)
        {
            Text3dActiveIdx = -1;
            Text3dValue = "";
        }
    }
}
