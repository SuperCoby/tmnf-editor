using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace TMNFeditor.Services;

public partial class AppState
{
    // ─── Triangles3D list ─────────────────────────────────────────────────────
    public class Tri3DEntry
    {
        public int MeshIndex { get; set; } = -1;
        public string Name { get; set; } = "";
        public string ClipType { get; set; } = "";
        public string ClipName { get; set; } = "";
        public string ClipDisplayName { get; set; } = "";
        public string TrackName { get; set; } = "";
        public int Vertices { get; set; }
        public int Triangles { get; set; }
        public bool HasMesh { get; set; }
        public bool Is2D { get; set; }
        public bool Visible { get; set; } = true;
        public int ImportIndex { get; set; } = -1;
        public bool IsImported => ImportIndex >= 0;
    }

    public List<Tri3DEntry> Tri3dEntries = new();
    public List<Tri3DBlock> Tri3dBlocks = new();
    public HashSet<string> CustomClips = new();
    public static readonly string[] AllClipTypes = ["Intro", "In Game", "End Race", "Global"];
    public string SelectedClipType = "In Game";
    public int SelectedClipIdx = 0;

    public record ClipInfo(string ClipType, string ClipName, string DisplayName, string Key);

    public List<string> GetDistinctClipTypes() =>
        Tri3dEntries.Select(e => e.ClipType).Distinct().ToList();

    public List<ClipInfo> GetClipsForSelectedType()
    {
        var fromEntries = Tri3dEntries
            .Where(e => e.ClipType == SelectedClipType)
            .Select(e => new { e.ClipName, e.ClipDisplayName })
            .GroupBy(e => e.ClipName)
            .Select(g => new { ClipName = g.Key, DisplayName = g.First().ClipDisplayName });
        var fromCustom = CustomClips
            .Where(k => k.StartsWith(SelectedClipType + "|"))
            .Select(k => k.Substring(SelectedClipType.Length + 1))
            .Select(n => new { ClipName = n, DisplayName = n });
        return fromEntries.Union(fromCustom)
            .Select(n => new ClipInfo(SelectedClipType, n.ClipName, string.IsNullOrEmpty(n.DisplayName) ? n.ClipName : n.DisplayName, $"{SelectedClipType}|{n.ClipName}"))
            .ToList();
    }

    public static bool HasClipsPanel(string type) => type is "In Game" or "End Race";

    public async Task SelectClipType(string type)
    {
        SelectedClipType = type;
        SelectedClipIdx = 0;
        await SyncTriVisibilityToClipType();
    }

    public async Task SyncTriVisibilityToClipType()
    {
        string? clipName = null;
        if (HasClipsPanel(SelectedClipType))
        {
            var clips = GetClipsForSelectedType();
            if (SelectedClipIdx >= 0 && SelectedClipIdx < clips.Count)
                clipName = clips[SelectedClipIdx].ClipName;
        }
        foreach (var e in Tri3dEntries)
        {
            if (!e.HasMesh && !e.IsImported) continue;
            bool show = e.ClipType == SelectedClipType && e.Visible
                && (clipName == null || e.ClipName == clipName);
            if (e.IsImported)
                await JS.InvokeVoidAsync("TMNFeditorScene.setImportVisibleByIndex", e.ImportIndex, show, e.Is2D);
            else if (e.HasMesh)
                await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DVisible", e.MeshIndex, show);
        }
    }

    public List<Tri3DEntry> GetSelectedClipTracks()
    {
        if (!HasClipsPanel(SelectedClipType))
            return Tri3dEntries.Where(e => e.ClipType == SelectedClipType).ToList();

        var clips = GetClipsForSelectedType();
        if (SelectedClipIdx < 0 || SelectedClipIdx >= clips.Count) return new();
        var sel = clips[SelectedClipIdx];
        return Tri3dEntries.Where(e => e.ClipType == sel.ClipType && e.ClipName == sel.ClipName).ToList();
    }

    public void AddClip()
    {
        var clips = GetClipsForSelectedType();
        int n = 1;
        string name;
        do { name = $"New Clip {n++}"; }
        while (clips.Any(c => c.ClipName == name));

        CustomClips.Add($"{SelectedClipType}|{name}");
        SelectedClipIdx = GetClipsForSelectedType().Count - 1;
    }

    public async Task RemoveSelectedClip()
    {
        var clips = GetClipsForSelectedType();
        if (SelectedClipIdx < 0 || SelectedClipIdx >= clips.Count) return;
        var sel = clips[SelectedClipIdx];
        foreach (var e in Tri3dEntries.Where(e => e.ClipType == sel.ClipType && e.ClipName == sel.ClipName))
        {
            if (e.HasMesh)
                await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DVisible", e.MeshIndex, false);
            else if (e.IsImported)
                await JS.InvokeVoidAsync("TMNFeditorScene.setImportVisibleByIndex", e.ImportIndex, false, e.Is2D);
        }
        Tri3dEntries.RemoveAll(e => e.ClipType == sel.ClipType && e.ClipName == sel.ClipName);
        CustomClips.Remove($"{sel.ClipType}|{sel.ClipName}");
        if (SelectedTri3DTrack?.ClipName == sel.ClipName) SelectedTri3DTrack = null;
        await JS.InvokeVoidAsync("TMNFeditorScene.selectTri3DMesh", -1);
        SelectedClipIdx = Math.Clamp(SelectedClipIdx, 0, Math.Max(0, GetClipsForSelectedType().Count - 1));
    }

    public void AddTrack()
    {
        string clipName;
        if (HasClipsPanel(SelectedClipType))
        {
            var clips = GetClipsForSelectedType();
            if (SelectedClipIdx < 0 || SelectedClipIdx >= clips.Count) return;
            clipName = clips[SelectedClipIdx].ClipName;
        }
        else
        {
            clipName = SelectedClipType;
        }

        var tracks = Tri3dEntries.Where(e => e.ClipType == SelectedClipType && e.ClipName == clipName).ToList();
        int n = tracks.Count + 1;
        Tri3dEntries.Add(new Tri3DEntry
        {
            ClipType = SelectedClipType,
            ClipName = clipName,
            ClipDisplayName = clipName,
            TrackName = $"Track {n}",
            Name = $"Track {n}",
        });
    }

    public async Task RemoveSelectedTrack()
    {
        if (SelectedTri3DTrack == null || SelectedTri3DTrack.ClipType != SelectedClipType) return;
        if (SelectedTri3DTrack.HasMesh)
            await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DVisible", SelectedTri3DTrack.MeshIndex, false);
        else if (SelectedTri3DTrack.IsImported)
            await JS.InvokeVoidAsync("TMNFeditorScene.setImportVisibleByIndex", SelectedTri3DTrack.ImportIndex, false, SelectedTri3DTrack.Is2D);
        await JS.InvokeVoidAsync("TMNFeditorScene.selectTri3DMesh", -1);
        Tri3dEntries.Remove(SelectedTri3DTrack);
        SelectedTri3DTrack = null;
    }

    public async Task AssignImportToTrack(Tri3DEntry track)
    {
        if (ImportTabCount == 0) return;
        track.ImportIndex = ActiveImportTab;
        track.Is2D = ImportMode == "2D";
        var isText = Text3dEntries.Any(e => e.SceneIdx == ActiveImportTab);
        var suffix = ImportMode == "2D" ? "2D" : "3D";
        track.Name = isText ? $"Text{suffix} #{ActiveImportTab + 1}" : $"Model{suffix} #{ActiveImportTab + 1}";
        await JS.InvokeVoidAsync("TMNFeditorScene.sendImportToMainScene", ActiveImportTab, ImportMode == "2D");
    }

    public async Task RemoveImportFromTrack(Tri3DEntry track)
    {
        if (track.ImportIndex >= 0)
        {
            var newCount = await JS.InvokeAsync<int>("TMNFeditorScene.removeImportModel", track.ImportIndex);
            ImportTabCount = newCount;
            if (newCount == 0) ActiveTabInScene = false;
        }
        track.ImportIndex = -1;
        track.Name = track.TrackName;
    }

    public static MarkupString ParseTmColors(string text)
    {
        if (string.IsNullOrEmpty(text)) return new MarkupString("");
        var sb = new System.Text.StringBuilder();
        bool inSpan = false;
        int i = 0;
        while (i < text.Length)
        {
            if (text[i] == '$' && i + 1 < text.Length)
            {
                char next = text[i + 1];
                if (i + 4 <= text.Length && IsHex(text[i + 1]) && IsHex(text[i + 2]) && IsHex(text[i + 3]))
                {
                    if (inSpan) sb.Append("</span>");
                    char r = text[i + 1], g = text[i + 2], b = text[i + 3];
                    sb.Append($"<span style=\"color:#{r}{r}{g}{g}{b}{b}\">");
                    inSpan = true;
                    i += 4;
                    continue;
                }
                if (next == 'z' || next == 'Z' || next == 'g' || next == 'G')
                {
                    if (inSpan) { sb.Append("</span>"); inSpan = false; }
                    i += 2;
                    continue;
                }
                if ("oOiIsSnNwWtT".Contains(next))
                {
                    i += 2;
                    continue;
                }
                if ((next == 'l' || next == 'L' || next == 'h' || next == 'H') && i + 2 < text.Length && text[i + 2] == '[')
                {
                    int close = text.IndexOf(']', i + 3);
                    i = close >= 0 ? close + 1 : i + 2;
                    continue;
                }
                if (next == '$') { sb.Append('$'); i += 2; continue; }
                i += 2;
                continue;
            }
            sb.Append(System.Net.WebUtility.HtmlEncode(text[i].ToString()));
            i++;
        }
        if (inSpan) sb.Append("</span>");
        return new MarkupString(sb.ToString());
    }

    public static bool IsHex(char c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

    public static string StripTmCodes(string text)
    {
        if (string.IsNullOrEmpty(text)) return "track";
        var sb = new System.Text.StringBuilder();
        int i = 0;
        while (i < text.Length)
        {
            if (text[i] == '$' && i + 1 < text.Length)
            {
                char next = text[i + 1];
                if (i + 4 <= text.Length && IsHex(text[i + 1]) && IsHex(text[i + 2]) && IsHex(text[i + 3]))
                { i += 4; continue; }
                if (next == '$') { sb.Append('$'); i += 2; continue; }
                if ((next == 'l' || next == 'L' || next == 'h' || next == 'H') && i + 2 < text.Length && text[i + 2] == '[')
                { int close = text.IndexOf(']', i + 3); i = close >= 0 ? close + 1 : i + 2; continue; }
                i += 2; continue;
            }
            sb.Append(text[i]); i++;
        }
        var result = sb.ToString().Trim();
        return string.IsNullOrEmpty(result) ? "track" : result;
    }

    public Tri3DEntry? SelectedTri3DTrack;

    public async Task SelectTri3DTrack(Tri3DEntry entry)
    {
        if (SelectedTri3DTrack == entry)
        {
            if (entry.HasMesh || entry.IsImported)
                await JS.InvokeVoidAsync("TMNFeditorScene.selectTri3DMesh", -1);
            SelectedTri3DTrack = null;
        }
        else
        {
            if (entry.IsImported)
                await JS.InvokeVoidAsync("TMNFeditorScene.selectImportMesh", entry.ImportIndex, entry.Is2D);
            else if (entry.HasMesh)
                await JS.InvokeVoidAsync("TMNFeditorScene.selectTri3DMesh", entry.MeshIndex);
            SelectedTri3DTrack = entry;
            ImportOriginX = 0; ImportOriginY = 0; ImportOriginZ = 0;
        }
    }

    public async Task ToggleTri3DVisible(Tri3DEntry entry)
    {
        entry.Visible = !entry.Visible;
        if (entry.IsImported)
            await JS.InvokeVoidAsync("TMNFeditorScene.setImportVisibleByIndex", entry.ImportIndex, entry.Visible, entry.Is2D);
        else if (entry.HasMesh)
            await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DVisible", entry.MeshIndex, entry.Visible);
    }

    public async Task SetAllTri3DVisible(bool visible)
    {
        foreach (var e in Tri3dEntries.Where(e => e.ClipType == SelectedClipType))
        {
            if (!e.HasMesh && !e.IsImported) continue;
            e.Visible = visible;
            if (e.IsImported)
                await JS.InvokeVoidAsync("TMNFeditorScene.setImportVisibleByIndex", e.ImportIndex, visible, e.Is2D);
            else if (e.HasMesh)
                await JS.InvokeVoidAsync("TMNFeditorScene.setTri3DVisible", e.MeshIndex, visible);
        }
    }

    // ─── Loaded track animation reset ─────────────────────────────────────────
    public HashSet<int> ResetLoadedTracks = new();
    public HashSet<int> AnimatedLoadedTracks = new();
    public bool IsLoadedTrackWithAnim => SelectedTri3DTrack is { HasMesh: true, IsImported: false }
        && SelectedTri3DTrack.MeshIndex >= 0
        && AnimatedLoadedTracks.Contains(SelectedTri3DTrack.MeshIndex)
        && !ResetLoadedTracks.Contains(SelectedTri3DTrack.MeshIndex);

    public async Task ResetLoadedTrackAnim()
    {
        if (SelectedTri3DTrack != null && SelectedTri3DTrack.MeshIndex >= 0)
        {
            ResetLoadedTracks.Add(SelectedTri3DTrack.MeshIndex);
            await JS.InvokeVoidAsync("TMNFeditorScene.clearTri3DKeyframes", SelectedTri3DTrack.MeshIndex);
        }
    }
}
