// ─── Helpers cache géométrie IDB ─────────────────────────────────────────────
// Extrait le mapping matName → texFilename depuis le texte MTL
export function parseMtlTextures(mtlText) {
    if (!mtlText) return {};
    const map = {};
    let cur = null;
    for (const line of mtlText.split('\n')) {
        const t = line.trim();
        if (t.startsWith('newmtl ')) cur = t.slice(7).trim().toLowerCase();
        else if (cur && t.startsWith('map_Kd ')) {
            const fn = t.slice(7).trim().split(/[/\\]/).pop();
            if (fn) { map[cur] = fn; map[cur + '.material'] = fn; }
        }
    }
    return map;
}

export function parseMtlAllTextures(mtlText) {
    if (!mtlText) return {};
    const map = {};
    let cur = null;
    for (const line of mtlText.split('\n')) {
        const t = line.trim();
        if (t.startsWith('newmtl ')) { cur = t.slice(7).trim().toLowerCase(); }
        else if (cur) {
            let type = null, fn = null;
            if (t.startsWith('map_Kd ')) { type = 'diffuse'; fn = t.slice(7).trim().split(/[/\\]/).pop(); }
            else if (t.startsWith('map_Ks ')) { type = 'specular'; fn = t.slice(7).trim().split(/[/\\]/).pop(); }
            else if (t.startsWith('bump ')) { type = 'normal'; fn = t.slice(5).trim().split(/[/\\]/).pop(); }
            else if (t.startsWith('# tex_')) {
                const rest = t.slice(6);
                const spaceIdx = rest.indexOf(' ');
                if (spaceIdx > 0) { type = rest.slice(0, spaceIdx); fn = rest.slice(spaceIdx + 1).trim().split(/[/\\]/).pop(); }
            }
            if (type && fn) {
                if (!map[cur]) map[cur] = {};
                map[cur][type] = fn;
                if (!map[cur + '.material']) map[cur + '.material'] = {};
                map[cur + '.material'][type] = fn;
            }
        }
    }
    return map;
}

export function _getTri3DAvgColor(mesh) {
    const colors = mesh.geometry?.getAttribute('color');
    if (!colors) return '#ffffff';
    let r = 0, g = 0, b = 0;
    const count = colors.count;
    for (let i = 0; i < count; i++) {
        r += colors.getX(i); g += colors.getY(i); b += colors.getZ(i);
    }
    r = Math.round((r / count) * 255);
    g = Math.round((g / count) * 255);
    b = Math.round((b / count) * 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function _getTri3DUniqueColors(mesh) {
    const colors = mesh.geometry?.getAttribute('color');
    if (!colors) return [{ key: 'vc_0', name: 'Vertex Colors', hex: '#ffffff' }];
    const seen = new Map();
    for (let i = 0; i < colors.count; i++) {
        const r = Math.round(colors.getX(i) * 255);
        const g = Math.round(colors.getY(i) * 255);
        const b = Math.round(colors.getZ(i) * 255);
        const hex = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
        if (!seen.has(hex)) seen.set(hex, seen.size);
    }
    return [...seen.entries()].map(([hex, idx]) => ({
        key: 'vc_' + idx,
        name: 'Color ' + (idx + 1),
        hex
    }));
}
