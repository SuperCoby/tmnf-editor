using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace TMNFeditor.Services;

public partial class AppState
{
    // ─── Animation keyframes ──────────────────────────────────────────────────
    public class AnimKeyframe
    {
        public double Time    { get; set; }
        public double EndTime { get; set; }
        public double X       { get; set; }
        public double Y       { get; set; }
        public double Z       { get; set; }
    }

    public class RotationKeyframe
    {
        public double Time    { get; set; }
        public double EndTime { get; set; }
        public double X       { get; set; }
        public double Y       { get; set; }
        public double Z       { get; set; }
        public double Steps   { get; set; } = 10;
    }

    public class OrbitKeyframe
    {
        public double Time    { get; set; }
        public double EndTime { get; set; }
        public double Radius  { get; set; } = 0;
        public double Steps   { get; set; } = 60;
        public double Degrees { get; set; } = 360;
    }

    public class ImportAnimData
    {
        public List<AnimKeyframe> Trans = new() { new() { Time = 0, EndTime = 3 } };
        public List<AnimKeyframe> Scale = new() { new() { Time = 0, EndTime = 3, X = 1, Y = 1, Z = 1 } };
        public List<RotationKeyframe> Rot = new() { new() { Time = 0, EndTime = 3 } };
        public List<OrbitKeyframe> Orbit = new() { new() { Time = 0, EndTime = 3 } };
        public double Shading = 0.0;
        public double OriginX, OriginY, OriginZ;
    }

    public readonly Dictionary<int, ImportAnimData> PerImportAnim = new();

    public ImportAnimData GetOrCreateAnim(int idx)
    {
        if (!PerImportAnim.TryGetValue(idx, out var data))
        {
            data = new ImportAnimData();
            PerImportAnim[idx] = data;
        }
        return data;
    }

    private int ActiveAnimKey
    {
        get
        {
            if (SelectedTri3DTrack is { HasMesh: true, IsImported: false } && ResetLoadedTracks.Contains(SelectedTri3DTrack.MeshIndex))
                return SelectedTri3DTrack.MeshIndex + 10000;
            if (SelectedTri3DTrack is { IsImported: true })
                return SelectedTri3DTrack.Is2D ? SelectedTri3DTrack.ImportIndex + 20000 : SelectedTri3DTrack.ImportIndex;
            return ImportMode == "2D" ? ActiveImportTab + 20000 : ActiveImportTab;
        }
    }

    public List<AnimKeyframe> AnimKeyframes => ActiveAnimKey >= 0 ? GetOrCreateAnim(ActiveAnimKey).Trans : _fallbackTrans;
    public List<AnimKeyframe> ScalingKeyframes => ActiveAnimKey >= 0 ? GetOrCreateAnim(ActiveAnimKey).Scale : _fallbackScale;
    public List<RotationKeyframe> RotationKeyframes => ActiveAnimKey >= 0 ? GetOrCreateAnim(ActiveAnimKey).Rot : _fallbackRot;
    public List<OrbitKeyframe> OrbitKeyframes => ActiveAnimKey >= 0 ? GetOrCreateAnim(ActiveAnimKey).Orbit : _fallbackOrbit;

    private List<AnimKeyframe> _fallbackTrans = new() { new() { Time = 0, EndTime = 3 } };
    private List<AnimKeyframe> _fallbackScale = new() { new() { Time = 0, EndTime = 3, X = 1, Y = 1, Z = 1 } };
    private List<RotationKeyframe> _fallbackRot = new() { new() { Time = 0, EndTime = 3 } };
    private List<OrbitKeyframe> _fallbackOrbit = new() { new() { Time = 0, EndTime = 3 } };

    private static void KfChange(List<AnimKeyframe> list, ChangeEventArgs e, int row, char field)
    {
        if (!double.TryParse(e.Value?.ToString(),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var v)) return;
        var kf = list[row];
        switch (field)
        {
            case 't': kf.Time    = v; break;
            case 'e': kf.EndTime = v; break;
            case 'x': kf.X      = v; break;
            case 'y': kf.Y      = v; break;
            case 'z': kf.Z      = v; break;
        }
    }

    private static void KfAdd(List<AnimKeyframe> list, int afterRow)
    {
        var prev = list[afterRow];
        list.Insert(afterRow + 1, new AnimKeyframe { Time = prev.EndTime, EndTime = prev.EndTime + 3 });
    }

    private static void KfRemove(List<AnimKeyframe> list, int row) { if (list.Count > 1) list.RemoveAt(row); }

    public void OnAnimChange(ChangeEventArgs e, int row, char field) => KfChange(AnimKeyframes, e, row, field);
    public void AddAnimKeyframe(int afterRow) => KfAdd(AnimKeyframes, afterRow);
    public void RemoveAnimKeyframe(int row) => KfRemove(AnimKeyframes, row);
    public void ResetAnimKeyframes() { AnimKeyframes.Clear(); AnimKeyframes.Add(new() { Time = 0, EndTime = 3 }); }

    public bool PlaybackRepeat = false;

    public object[] BuildPlaybackKeyframes()
    {
        return AnimKeyframes.Select(kf => (object)new
        {
            time = kf.Time,
            endTime = kf.EndTime,
            x = kf.X,
            y = kf.Y,
            z = kf.Z
        }).ToArray();
    }

    public object[] BuildScalingKeyframes()
    {
        return ScalingKeyframes.Select(kf => (object)new
        {
            time = kf.Time,
            endTime = kf.EndTime,
            x = kf.X,
            y = kf.Y,
            z = kf.Z
        }).ToArray();
    }

    public object[] BuildRotationKeyframes()
    {
        return RotationKeyframes.Select(kf => (object)new
        {
            time = kf.Time,
            endTime = kf.EndTime,
            x = kf.X * Math.PI / 180.0,
            y = kf.Y * Math.PI / 180.0,
            z = kf.Z * Math.PI / 180.0
        }).ToArray();
    }

    public double GetTotalEndTime()
    {
        double t = 0;
        foreach (var data in PerImportAnim.Values)
        {
            if (data.Trans.Count > 0) t = Math.Max(t, data.Trans[^1].EndTime);
            if (data.Scale.Count > 0) t = Math.Max(t, data.Scale[^1].EndTime);
            if (data.Rot.Count > 0) t = Math.Max(t, data.Rot[^1].EndTime);
            if (data.Orbit.Count > 0) t = Math.Max(t, data.Orbit[^1].EndTime);
        }
        return t;
    }

    public async Task PlaybackPlay()
    {
        var allAnims = PerImportAnim.Select(kvp =>
        {
            bool is2DKey = kvp.Key >= 20000 && kvp.Key < 30000;
            int realKey = is2DKey ? kvp.Key - 20000 : kvp.Key;
            var entry = realKey >= 10000
                ? Tri3dEntries.FirstOrDefault(e => e.HasMesh && !e.IsImported && e.MeshIndex == realKey - 10000)
                : Tri3dEntries.FirstOrDefault(e => e.IsImported && e.ImportIndex == realKey && e.Is2D == is2DKey);
            if (entry == null && !is2DKey)
                entry = Tri3dEntries.FirstOrDefault(e => e.IsImported && e.ImportIndex == realKey);
            bool entryIs2D = entry?.Is2D ?? is2DKey;
            int meshIdx = realKey >= 10000 ? entry?.MeshIndex ?? -1 : realKey;
            return (object)new
            {
                idx = meshIdx,
                is2D = entryIs2D,
                transKf = kvp.Value.Trans.Select(kf => new { time = kf.Time, endTime = kf.EndTime, x = kf.X, y = kf.Y, z = kf.Z }).ToArray(),
                scaleKf = kvp.Value.Scale.Select(kf => new { time = kf.Time, endTime = kf.EndTime, x = kf.X, y = kf.Y, z = kf.Z }).ToArray(),
                rotKf = kvp.Value.Rot.Select(kf => new { time = kf.Time, endTime = kf.EndTime, x = kf.X * Math.PI / 180.0, y = kf.Y * Math.PI / 180.0, z = kf.Z * Math.PI / 180.0 }).ToArray(),
                orbitKf = kvp.Value.Orbit.Select(kf => new { time = kf.Time, endTime = kf.EndTime, radius = kf.Radius, steps = kf.Steps, degrees = kf.Degrees }).ToArray()
            };
        }).ToArray();
        await JS.InvokeVoidAsync("TMNFeditorScene.playbackStartAll", allAnims, PlaybackRepeat);
    }

    public async Task PlaybackPause()
        => await JS.InvokeVoidAsync("TMNFeditorScene.playbackPause");

    public async Task PlaybackGoToStart()
        => await JS.InvokeVoidAsync("TMNFeditorScene.playbackSeek", 0.0);

    public async Task PlaybackGoToEnd()
    {
        var endTime = GetTotalEndTime();
        await JS.InvokeVoidAsync("TMNFeditorScene.playbackSeek", endTime);
    }

    public void PlaybackToggleRepeat()
    {
        PlaybackRepeat = !PlaybackRepeat;
    }

    public void OnScalingChange(ChangeEventArgs e, int row, char field) => KfChange(ScalingKeyframes, e, row, field);
    public void AddScalingKeyframe(int afterRow)
    {
        var prev = ScalingKeyframes[afterRow];
        ScalingKeyframes.Insert(afterRow + 1, new AnimKeyframe { Time = prev.EndTime, EndTime = prev.EndTime + 3, X = 1, Y = 1, Z = 1 });
    }
    public void RemoveScalingKeyframe(int row) => KfRemove(ScalingKeyframes, row);
    public void ResetScalingKeyframes() { ScalingKeyframes.Clear(); ScalingKeyframes.Add(new() { Time = 0, EndTime = 3, X = 1, Y = 1, Z = 1 }); }

    public void OnRotationChange(ChangeEventArgs e, int row, char field)
    {
        if (!double.TryParse(e.Value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v)) return;
        var kf = RotationKeyframes[row];
        switch (field)
        {
            case 't': kf.Time = v; break;
            case 'e': kf.EndTime = v; break;
            case 'x': kf.X = v; break;
            case 'y': kf.Y = v; break;
            case 'z': kf.Z = v; break;
            case 's': kf.Steps = v; break;
        }
    }
    public void AddRotationKeyframe(int afterRow)
    {
        var prev = RotationKeyframes[afterRow];
        RotationKeyframes.Insert(afterRow + 1, new() { Time = prev.EndTime, EndTime = prev.EndTime + 3 });
    }
    public void RemoveRotationKeyframe(int row) { if (RotationKeyframes.Count > 1) RotationKeyframes.RemoveAt(row); }
    public void ResetRotationKeyframes() { RotationKeyframes.Clear(); RotationKeyframes.Add(new() { Time = 0, EndTime = 3 }); }

    public void OnOrbitChange(ChangeEventArgs e, int row, char field)
    {
        if (!double.TryParse(e.Value?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v)) return;
        var kf = OrbitKeyframes[row];
        switch (field)
        {
            case 't': kf.Time = v; break;
            case 'e': kf.EndTime = v; break;
            case 'r': kf.Radius = v; break;
            case 's': kf.Steps = v; break;
            case 'd': kf.Degrees = v; break;
        }
    }
    public void AddOrbitKeyframe(int afterRow)
    {
        var prev = OrbitKeyframes[afterRow];
        OrbitKeyframes.Insert(afterRow + 1, new() { Time = prev.EndTime, EndTime = prev.EndTime + 3 });
    }
    public void RemoveOrbitKeyframe(int row) { if (OrbitKeyframes.Count > 1) OrbitKeyframes.RemoveAt(row); }
    public void ResetOrbitKeyframes() { OrbitKeyframes.Clear(); OrbitKeyframes.Add(new() { Time = 0, EndTime = 3 }); }
}
