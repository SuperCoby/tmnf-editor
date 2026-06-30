using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace TMNFeditor.Services;

public partial class AppState
{
    // ─── Export state ──────────────────────────────────────────────────────────
    public bool Exporting = false;
    public int ExportProgress = 0;
    public string ExportStatus = "";

    public byte[]? ChallengeBytes;
    public string? ChallengeFileName;

    public async Task ExportTri3DObj(Tri3DEntry entry)
    {
        if (entry.IsImported)
        {
            var data = await JS.InvokeAsync<ImportExportData?>("TMNFeditorScene.getImportExportDataByIndex", entry.ImportIndex, entry.Is2D);
            if (data == null || string.IsNullOrEmpty(data.ObjText)) return;
            var name = StripTmCodes(entry.Name);
            foreach (var c in System.IO.Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');
            await JS.InvokeVoidAsync("TMNFeditorScene.downloadFile", $"{name}.obj", data.ObjText);
            if (!string.IsNullOrEmpty(data.MtlText))
                await JS.InvokeVoidAsync("TMNFeditorScene.downloadFile", $"{name}.mtl", data.MtlText);
            return;
        }
        if (!entry.HasMesh || entry.MeshIndex < 0 || entry.MeshIndex >= Tri3dBlocks.Count) return;
        var block = Tri3dBlocks[entry.MeshIndex];
        var cleanName = StripTmCodes(entry.Name);
        foreach (var c in System.IO.Path.GetInvalidFileNameChars())
            cleanName = cleanName.Replace(c, '_');

        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var obj = new System.Text.StringBuilder();
        var mtl = new System.Text.StringBuilder();
        var mtlFilename = $"{cleanName}.mtl";

        var positions = block.Keyframes.Length > 0 ? block.Keyframes[0].Positions : Array.Empty<float>();
        int vertCount = block.Vertices.Length;

        // Quantize face colors → materials
        static string ColorKey(float r, float g, float b) =>
            $"{(int)(Math.Clamp(r, 0, 1) * 20)}_{(int)(Math.Clamp(g, 0, 1) * 20)}_{(int)(Math.Clamp(b, 0, 1) * 20)}";

        var matColors = new Dictionary<string, (float R, float G, float B, float A)>();
        var faceMats = new List<string>();

        for (int fi = 0; fi + 2 < block.Indices.Length; fi += 3)
        {
            var c0 = block.Vertices[block.Indices[fi]];
            var c1 = block.Vertices[block.Indices[fi + 1]];
            var c2 = block.Vertices[block.Indices[fi + 2]];
            float ar = (c0.R + c1.R + c2.R) / 3f;
            float ag = (c0.G + c1.G + c2.G) / 3f;
            float ab = (c0.B + c1.B + c2.B) / 3f;
            float aa = (c0.A + c1.A + c2.A) / 3f;
            var key = ColorKey(ar, ag, ab);
            if (!matColors.ContainsKey(key))
                matColors[key] = (ar, ag, ab, aa);
            faceMats.Add(key);
        }

        // .mtl
        foreach (var (key, col) in matColors)
        {
            mtl.AppendLine($"newmtl mat_{key}");
            mtl.AppendLine(string.Format(inv, "Kd {0:F4} {1:F4} {2:F4}", col.R, col.G, col.B));
            mtl.AppendLine(string.Format(inv, "d {0:F4}", col.A));
            mtl.AppendLine("illum 1");
            mtl.AppendLine();
        }

        // .obj — vertices
        obj.AppendLine($"mtllib {mtlFilename}");
        obj.AppendLine($"o {cleanName}");

        for (int vi = 0; vi < vertCount; vi++)
        {
            float x = 0, y = 0, z = 0;
            int pi = vi * 3;
            if (pi + 2 < positions.Length)
            { x = positions[pi] - 512f; y = positions[pi + 1] - 9f; z = positions[pi + 2] - 512f; }
            obj.AppendLine(string.Format(inv, "v {0:F6} {1:F6} {2:F6}", x, y, z));
        }

        // .obj — faces grouped by material
        string? currentMat = null;
        var faceIndices = new List<(int fi, string mat)>();
        for (int i = 0; i < faceMats.Count; i++)
            faceIndices.Add((i, faceMats[i]));
        faceIndices.Sort((a, b) => string.Compare(a.mat, b.mat, StringComparison.Ordinal));

        foreach (var (fi, mat) in faceIndices)
        {
            if (mat != currentMat)
            {
                obj.AppendLine($"usemtl mat_{mat}");
                currentMat = mat;
            }
            int idx = fi * 3;
            obj.AppendLine($"f {block.Indices[idx] + 1} {block.Indices[idx + 1] + 1} {block.Indices[idx + 2] + 1}");
        }

        await JS.InvokeVoidAsync("TMNFeditorScene.downloadFile", $"{cleanName}.obj", obj.ToString());
        await JS.InvokeVoidAsync("TMNFeditorScene.downloadFile", mtlFilename, mtl.ToString());
    }

    public async Task ExportSelectedAsClipGbx()
    {
        if (SelectedTri3DTrack is { HasMesh: true } tri3d && tri3d.MeshIndex >= 0 && tri3d.MeshIndex < Tri3dBlocks.Count)
        {
            var block = Tri3dBlocks[tri3d.MeshIndex];
            var cleanName = StripTmCodes(tri3d.Name);
            foreach (var c in System.IO.Path.GetInvalidFileNameChars())
                cleanName = cleanName.Replace(c, '_');

            var tf = await JS.InvokeAsync<ImportExportData?>("TMNFeditorScene.getTri3DTransform", tri3d.MeshIndex);
            var bytes = ClipGbxExporter.ExportTri3DBlockAsClip(block, cleanName,
                tf?.PosX ?? 0, tf?.PosY ?? 0, tf?.PosZ ?? 0,
                tf?.RotX ?? 0, tf?.RotY ?? 0, tf?.RotZ ?? 0,
                tf?.ScaleX ?? 1, tf?.ScaleY ?? 1, tf?.ScaleZ ?? 1,
                tf?.ColorHex);
            var base64 = Convert.ToBase64String(bytes);
            await JS.InvokeVoidAsync("TMNFeditorScene.downloadFileBytes", $"{cleanName}.Clip.Gbx", base64);
            return;
        }

        if (SelectedTri3DTrack is { IsImported: true } impTrack)
        {
            var data = await JS.InvokeAsync<ImportExportData?>("TMNFeditorScene.getImportExportDataByIndex", impTrack.ImportIndex, impTrack.Is2D);
            if (data == null || string.IsNullOrEmpty(data.ObjText)) return;

            var name = StripTmCodes(impTrack.Name);
            foreach (var c in System.IO.Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');

            var mats = await JS.InvokeAsync<ImportMatDto[]>("TMNFeditorScene.getImportMaterialsByIndex", impTrack.ImportIndex, impTrack.Is2D);
            Dictionary<string, string>? matOverrides = null;
            if (mats != null && mats.Length > 0)
            {
                matOverrides = new();
                foreach (var mat in mats)
                    if (!string.IsNullOrEmpty(mat.Name) && mat.Name != "(sans nom)")
                        matOverrides[mat.Name] = mat.Hex;
            }

            var animKey = impTrack.Is2D ? impTrack.ImportIndex + 20000 : impTrack.ImportIndex;
            var impAnim = GetOrCreateAnim(animKey);
            var bytes = ClipGbxExporter.ExportObjAsClip(
                data.ObjText, data.MtlText,
                data.PosX, data.PosY, data.PosZ,
                data.RotX, data.RotY, data.RotZ,
                data.ScaleX, data.ScaleY, data.ScaleZ,
                name, matOverrides, (float)impAnim.Shading, impTrack.Is2D);
            if (bytes.Length == 0) return;
            await JS.InvokeVoidAsync("TMNFeditorScene.downloadFileBytes", $"{name}.Clip.Gbx", Convert.ToBase64String(bytes));
            return;
        }

        {
            var data = await JS.InvokeAsync<ImportExportData?>("TMNFeditorScene.getActiveImportExportData");
            if (data == null || string.IsNullOrEmpty(data.ObjText)) return;

            var name = "Exported";
            foreach (var c in System.IO.Path.GetInvalidFileNameChars())
                name = name.Replace(c, '_');

            Dictionary<string, string>? matOverrides = null;
            if (ImportMaterials.Count > 0)
            {
                matOverrides = new();
                foreach (var mat in ImportMaterials)
                    if (!string.IsNullOrEmpty(mat.Name) && mat.Name != "(sans nom)")
                        matOverrides[mat.Name] = mat.Hex;
            }

            var bytes2 = ClipGbxExporter.ExportObjAsClip(
                data.ObjText, data.MtlText,
                data.PosX, data.PosY, data.PosZ,
                data.RotX, data.RotY, data.RotZ,
                data.ScaleX, data.ScaleY, data.ScaleZ,
                name, matOverrides, (float)ShadingIntensity, ImportMode == "2D");
            if (bytes2.Length == 0) return;
            await JS.InvokeVoidAsync("TMNFeditorScene.downloadFileBytes", $"{name}.Clip.Gbx", Convert.ToBase64String(bytes2));
        }
    }

    // ─── Export Challenge (heavy, uses ClipGbxExporter + JS only) ─────────────
    public async Task ExportChallengeGbx()
    {
        if (ChallengeBytes == null) return;

        Exporting = true;
        ExportProgress = 0;
        ExportStatus = T("Préparation des blocs…");
        NotifyStateChanged();
        await Task.Delay(1);

        var newBlocks = new List<(string clipType, string clipName, string clipDisplayName, string trackName, GBX.NET.Engines.Game.CGameCtnMediaBlock block)>();

        int total = Tri3dEntries.Count;
        int processed = 0;
        foreach (var entry in Tri3dEntries)
        {
            bool isCustom = CustomClips.Contains($"{entry.ClipType}|{entry.ClipName}");

            if (entry.IsImported)
            {
                var data = await JS.InvokeAsync<ImportExportData?>("TMNFeditorScene.getImportExportDataByIndex", entry.ImportIndex, entry.Is2D);
                if (data == null || string.IsNullOrEmpty(data.ObjText)) { processed++; continue; }

                var animKey2 = entry.Is2D ? entry.ImportIndex + 20000 : entry.ImportIndex;
                var anim = GetOrCreateAnim(animKey2);

                List<ClipGbxExporter.AnimKf> transKfs, scaleKfs, rotKfs;
                List<ClipGbxExporter.OrbitKf> orbitKfs;
                if (entry.Is2D)
                {
                    float sc = data.Scale2D;
                    transKfs = anim.Trans.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime, k.X * sc, k.Z * sc, 0)).ToList();
                    scaleKfs = anim.Scale.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime, k.X, k.Z, 1)).ToList();
                    rotKfs = anim.Rot.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime,
                        0, 0, k.X * Math.PI / 180.0, (int)k.Steps)).ToList();
                    orbitKfs = anim.Orbit.Select(k => new ClipGbxExporter.OrbitKf(k.Time, k.EndTime, k.Radius * sc, (int)k.Steps, k.Degrees)).ToList();
                }
                else
                {
                    transKfs = anim.Trans.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime, k.X, k.Y, k.Z)).ToList();
                    scaleKfs = anim.Scale.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime, k.X, k.Y, k.Z)).ToList();
                    rotKfs = anim.Rot.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime,
                        k.X * Math.PI / 180.0, k.Y * Math.PI / 180.0, k.Z * Math.PI / 180.0, (int)k.Steps)).ToList();
                    orbitKfs = anim.Orbit.Select(k => new ClipGbxExporter.OrbitKf(k.Time, k.EndTime, k.Radius, (int)k.Steps, k.Degrees)).ToList();
                }

                bool hasAnim = transKfs.Any(k => k.X != 0 || k.Y != 0 || k.Z != 0)
                            || scaleKfs.Any(k => k.X != 1 || k.Y != 1 || k.Z != 1)
                            || rotKfs.Any(k => k.X != 0 || k.Y != 0 || k.Z != 0)
                            || orbitKfs.Any(k => k.Radius != 0);

                var mats = await JS.InvokeAsync<ImportMatDto[]>("TMNFeditorScene.getImportMaterialsByIndex", entry.ImportIndex, entry.Is2D);
                Dictionary<string, string>? matOverrides = null;
                if (mats != null && mats.Length > 0)
                {
                    matOverrides = new();
                    foreach (var mat in mats)
                        if (!string.IsNullOrEmpty(mat.Name))
                            matOverrides[mat.Name] = mat.Hex;
                }

                GBX.NET.Vec3 rotOrigin;
                if (entry.Is2D)
                {
                    float sc = data.Scale2D;
                    rotOrigin = new GBX.NET.Vec3((float)(anim.OriginX * sc), (float)(anim.OriginZ * sc), 0);
                }
                else
                    rotOrigin = new GBX.NET.Vec3((float)anim.OriginX, (float)anim.OriginY, (float)anim.OriginZ);
                if (entry.Is2D)
                {
                    var tri2dBlock = ClipGbxExporter.BuildObjTri2DBlock(
                        data.ObjText, data.MtlText,
                        data.PosX, data.PosY, data.PosZ,
                        hasAnim ? transKfs : null,
                        hasAnim ? scaleKfs : null,
                        hasAnim ? rotKfs : null,
                        matOverrides, (float)anim.Shading,
                        rotationOrigin: hasAnim ? rotOrigin : null,
                        orbitKfs: hasAnim ? orbitKfs : null,
                        scale2D: data.Scale2D);
                    newBlocks.Add((entry.ClipType, entry.ClipName, entry.ClipDisplayName, entry.Name, tri2dBlock));
                }
                else
                {
                    var tri3dBlock = ClipGbxExporter.BuildObjTri3DBlock(
                        data.ObjText, data.MtlText,
                        data.PosX, data.PosY, data.PosZ,
                        hasAnim ? transKfs : null,
                        hasAnim ? scaleKfs : null,
                        hasAnim ? rotKfs : null,
                        matOverrides, (float)anim.Shading,
                        rotationOrigin: hasAnim ? rotOrigin : null,
                        orbitKfs: hasAnim ? orbitKfs : null);
                    newBlocks.Add((entry.ClipType, entry.ClipName, entry.ClipDisplayName, entry.Name, tri3dBlock));
                }
            }
            else if (entry.HasMesh && entry.MeshIndex >= 0 && entry.MeshIndex < Tri3dBlocks.Count)
            {
                var block = Tri3dBlocks[entry.MeshIndex];
                int animKey = entry.MeshIndex + 10000;
                List<ClipGbxExporter.AnimKf>? lt = null, ls = null, lr = null;
                List<ClipGbxExporter.OrbitKf>? lo = null;
                if (ResetLoadedTracks.Contains(entry.MeshIndex) && PerImportAnim.TryGetValue(animKey, out var la))
                {
                    lt = la.Trans.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime, k.X, k.Y, k.Z)).ToList();
                    ls = la.Scale.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime, k.X, k.Y, k.Z)).ToList();
                    lr = la.Rot.Select(k => new ClipGbxExporter.AnimKf(k.Time, k.EndTime,
                        k.X * Math.PI / 180.0, k.Y * Math.PI / 180.0, k.Z * Math.PI / 180.0, (int)k.Steps)).ToList();
                    lo = la.Orbit.Select(k => new ClipGbxExporter.OrbitKf(k.Time, k.EndTime, k.Radius, (int)k.Steps, k.Degrees)).ToList();
                    bool any = lt.Any(k => k.X != 0 || k.Y != 0 || k.Z != 0)
                            || ls.Any(k => k.X != 1 || k.Y != 1 || k.Z != 1)
                            || lr.Any(k => k.X != 0 || k.Y != 0 || k.Z != 0)
                            || lo.Any(k => k.Radius != 0);
                    if (!any) { lt = null; ls = null; lr = null; lo = null; }
                }
                var tri3dBlock = ClipGbxExporter.BuildAnimatedTri3DBlock(block, lt, ls, lr, orbitKfs: lo, is2D: entry.Is2D);
                if (entry.Is2D)
                {
                    var tri2d = new GBX.NET.Engines.Game.CGameCtnMediaBlockTriangles2D
                    {
                        Vertices = tri3dBlock.Vertices,
                        Triangles = tri3dBlock.Triangles
                    };
                    tri2d.Keys = tri3dBlock.Keys.Select(k => new GBX.NET.Engines.Game.CGameCtnMediaBlockTriangles.Key(tri2d)
                    {
                        Time = k.Time,
                        Positions = k.Positions
                    }).ToList();
                    var chunk = tri2d.CreateChunk<GBX.NET.Engines.Game.CGameCtnMediaBlockTriangles.Chunk03029001>();
                    chunk.U01 = 1; chunk.U04 = 1;
                    newBlocks.Add((entry.ClipType, entry.ClipName, entry.ClipDisplayName, entry.Name, tri2d));
                }
                else
                {
                    newBlocks.Add((entry.ClipType, entry.ClipName, entry.ClipDisplayName, entry.Name, tri3dBlock));
                }
            }

            processed++;
            ExportProgress = processed * 70 / Math.Max(1, total);
            ExportStatus = $"{T("Préparation des blocs…")} ({processed}/{total})";
            NotifyStateChanged();
            await Task.Delay(1);
        }

        ExportStatus = T("Écriture du fichier…");
        ExportProgress = 75;
        NotifyStateChanged();
        await Task.Delay(1);

        var result = ClipGbxExporter.ExportChallengeBytes(ChallengeBytes, newBlocks);
        if (result.Length == 0) { Exporting = false; return; }

        ExportStatus = T("Téléchargement…");
        ExportProgress = 90;
        NotifyStateChanged();

        var fileName = ChallengeFileName ?? "Exported.Challenge.Gbx";
        await JS.InvokeVoidAsync("TMNFeditorScene.downloadFileBytes", fileName, Convert.ToBase64String(result));

        Exporting = false;
        NotifyStateChanged();
    }
}
