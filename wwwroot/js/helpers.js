import * as THREE from 'three';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import {
    S, scene, overlayScene,
    _fontLoader, _fontCache, _ttfLoader,
    _typefaceMap, _fontsourceFonts, _noBoldFonts,
} from './state.js';

export async function _loadFont(fontName) {
    let font = _fontCache.get(fontName);
    if (font) return font;

    const isBold = fontName.endsWith('_bold');
    const base = isBold ? fontName.slice(0, -5) : fontName;
    const fsKey = base.replace(/_/g, '-');

    if (_typefaceMap[fontName]) {
        const url = `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/${_typefaceMap[fontName]}`;
        font = await new Promise((res, rej) => _fontLoader.load(url, res, undefined, rej));
    } else if (_fontsourceFonts.has(fsKey)) {
        if (isBold && _noBoldFonts.has(base)) return _loadFont(base);
        const weight = isBold ? 700 : 400;
        const url = `https://cdn.jsdelivr.net/npm/@fontsource/${fsKey}/files/${fsKey}-latin-${weight}-normal.woff`;
        const json = await new Promise((res, rej) => _ttfLoader.load(url, res, undefined, rej));
        font = new Font(json);
    } else if (isBold) {
        return _loadFont(base);
    } else {
        const url = `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/${fontName}_regular.typeface.json`;
        font = await new Promise((res, rej) => _fontLoader.load(url, res, undefined, rej));
    }

    _fontCache.set(fontName, font);
    return font;
}

export function _buildTextGroup(text, font, thickness, letterSpacing, italic, underline, strike) {
    const group = new THREE.Group();
    let offsetX = 0;
    for (const char of text) {
        if (char === ' ') { offsetX += 3 + letterSpacing; continue; }
        const geom = new TextGeometry(char, {
            font,
            size: 5,
            depth: thickness,
            height: thickness,
            curveSegments: 6,
            bevelEnabled: false,
        });
        geom.computeBoundingBox();
        if (italic) {
            const shear = new THREE.Matrix4().set(
                1, 0.25, 0, 0,
                0, 1,    0, 0,
                0, 0,    1, 0,
                0, 0,    0, 1
            );
            geom.applyMatrix4(shear);
            geom.computeBoundingBox();
        }
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1, name: char });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.x = offsetX - geom.boundingBox.min.x;
        group.add(mesh);
        offsetX += (geom.boundingBox.max.x - geom.boundingBox.min.x) + letterSpacing;
    }
    if (group.children.length > 0) {
        const box = new THREE.Box3().setFromObject(group);
        const cx = box.getCenter(new THREE.Vector3()).x;
        group.children.forEach(c => c.position.x -= cx);
        const size = box.getSize(new THREE.Vector3());
        const barThick = Math.max(0.15, size.y * 0.06);
        const barDepth = Math.max(thickness, 0.05);
        if (underline) {
            const barGeom = new THREE.BoxGeometry(size.x, barThick, barDepth);
            const barMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1, name: '_underline' });
            const bar = new THREE.Mesh(barGeom, barMat);
            bar.position.set(0, box.min.y - barThick, barDepth / 2);
            group.add(bar);
        }
        if (strike) {
            const barGeom = new THREE.BoxGeometry(size.x, barThick, barDepth);
            const barMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1, name: '_strike' });
            const bar = new THREE.Mesh(barGeom, barMat);
            bar.position.set(0, box.min.y + size.y * 0.45, barDepth / 2);
            group.add(bar);
        }
    }
    return group;
}

export function _groupToObjMtl(group) {
    let obj = '', mtl = '';
    const matNames = new Map();
    const usedNames = new Set();
    let vOff = 1;

    function ensureMat(m) {
        if (!m) return 'default';
        let name = matNames.get(m.uuid);
        if (name) return name;
        name = m.name || 'mat_' + matNames.size;
        let base = name, n = 1;
        while (usedNames.has(name)) name = base + '_' + n++;
        matNames.set(m.uuid, name);
        usedNames.add(name);
        const c = m.color || new THREE.Color(0.5, 0.5, 0.5);
        mtl += `newmtl ${name}\nKd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}\n\n`;
        return name;
    }

    const grpMat = new THREE.Matrix4();
    grpMat.makeRotationFromEuler(group.rotation);
    grpMat.scale(new THREE.Vector3(group.scale.x, group.scale.y, group.scale.z));
    const nrmMat = new THREE.Matrix3().getNormalMatrix(grpMat);

    group.traverse(child => {
        if (!child.isMesh) return;
        const geom = child.geometry;
        const pos = geom.attributes.position;
        const norm = geom.attributes.normal;
        if (!pos) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];

        for (let i = 0; i < pos.count; i++) {
            const v = new THREE.Vector3(
                pos.getX(i) + child.position.x,
                pos.getY(i) + child.position.y,
                pos.getZ(i) + child.position.z
            );
            v.applyMatrix4(grpMat);
            obj += `v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}\n`;
        }
        if (norm) {
            for (let i = 0; i < norm.count; i++) {
                const n = new THREE.Vector3(norm.getX(i), norm.getY(i), norm.getZ(i));
                n.applyMatrix3(nrmMat).normalize();
                obj += `vn ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}\n`;
            }
        }

        const idx = geom.index;
        const groups = geom.groups.length > 0
            ? geom.groups
            : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];

        for (const g of groups) {
            const mat = mats[g.materialIndex] || mats[0];
            obj += `usemtl ${ensureMat(mat)}\n`;
            if (idx) {
                for (let i = g.start; i < g.start + g.count; i += 3) {
                    const a = idx.getX(i) + vOff, b = idx.getX(i+1) + vOff, c2 = idx.getX(i+2) + vOff;
                    obj += norm ? `f ${a}//${a} ${b}//${b} ${c2}//${c2}\n` : `f ${a} ${b} ${c2}\n`;
                }
            } else {
                for (let i = g.start; i < g.start + g.count; i += 3) {
                    const a = i + vOff, b = i+1 + vOff, c2 = i+2 + vOff;
                    obj += norm ? `f ${a}//${a} ${b}//${b} ${c2}//${c2}\n` : `f ${a} ${b} ${c2}\n`;
                }
            }
        }
        vOff += pos.count;
    });
    return { objText: 'mtllib text.mtl\n' + obj, mtlText: mtl };
}

export function _removeSelectionBox() {
    if (!S.selectionBox) return;
    (S.selectionBox.userData._overlay ? overlayScene : scene).remove(S.selectionBox);
    S.selectionBox.dispose?.();
    S.selectionBox = null;
}

export function _getImportGroup(idx) {
    if (idx === undefined) idx = S.activeImportIdx;
    if (S._activeIs2D) {
        return S.importMeshGroups.get(`2d_${idx}`) ?? S.importMeshGroups.get(idx) ?? null;
    }
    return S.importMeshGroups.get(idx) ?? S.importMeshGroups.get(`2d_${idx}`) ?? null;
}

export function _getActiveObject() {
    if (S._activeTri3DIdx >= 0 && S._activeTri3DIdx < S.tri3dMeshes.length)
        return S.tri3dMeshes[S._activeTri3DIdx];
    return _getImportGroup() ?? null;
}

export function findMesh(obj, name, materialName) {
    if (obj.name === name) return obj;
    if (materialName && obj instanceof THREE.Mesh) {
        const check = n => n === materialName || n === materialName + '.Material' || n + '.Material' === materialName;
        if (obj.material?.name && check(obj.material.name)) return obj;
        if (obj.userData?.originalMaterialName && check(obj.userData.originalMaterialName)) return obj;
    }
    for (const child of (obj.children || [])) {
        const found = findMesh(child, name, materialName);
        if (found) return found;
    }
    return null;
}

export function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function downloadFileBytes(filename, base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function clearMesh() {
    if (S.currentMesh) {
        scene.remove(S.currentMesh);
        if (!S.currentMeshCacheKey) {
            // Mesh non-caché : disposal complet
            S.currentMesh.traverse(c => {
                if (c instanceof THREE.Mesh) {
                    c.geometry?.dispose();
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material?.dispose();
                }
            });
        } else {
            // Clone d'un objet caché : dispose uniquement les materials non-partagés (defaultMat)
            S.currentMesh.traverse(c => {
                if (c instanceof THREE.Mesh) {
                    const mats = Array.isArray(c.material) ? c.material : [c.material].filter(Boolean);
                    mats.forEach(m => { if (m?.userData?.isDefault) m.dispose(); });
                }
            });
        }
        S.currentMesh = null;
        S.currentMeshCacheKey = null;
    }
    if (S.selectionOutline) { scene.remove(S.selectionOutline); S.selectionOutline.geometry.dispose(); S.selectionOutline.material.dispose(); S.selectionOutline = null; S.selectedMesh = null; }
}
