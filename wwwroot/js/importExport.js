import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import {
    S, scene, camera, controls, overlayScene,
    loadingManager, _apply2DGizmoMode,
} from './state.js';
import {
    _groupToObjMtl, _removeSelectionBox, _getImportGroup, _getActiveObject,
} from './helpers.js';
import { importPrev } from './importPreview.js';

export async function sendImportToMainScene(idx, is2D = false) {
    if (is2D) {
        await _sendImport2D(idx);
        return;
    }

    // Si le mesh existe déjà, le réutiliser sans re-parser
    if (S.importMeshGroups.has(idx)) {
        const group = S.importMeshGroups.get(idx);
        group.visible = true;
        if (S.currentMesh) S.currentMesh.visible = false;
        S.activeImportIdx = idx;
        S._activeIs2D = false;
        if (S.selectionBox) { _removeSelectionBox(); }
        S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        S.selectionBox.material.transparent = true;
        S.selectionBox.material.opacity = 0.35;
        scene.add(S.selectionBox);
        if (S._currentTransformMode !== 'none' && S.transformCtrl) {
            S.transformCtrl.attach(group);
            S.transformCtrl.setMode(S._currentTransformMode);
        }
        S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
        return;
    }

    const data = importPrev.getModelData(idx);
    if (!data?.objText) return;

    let materials = null;
    if (data.mtlText?.trim()) {
        const ml = new MTLLoader(loadingManager);
        materials = ml.parse(data.mtlText, '');
        materials.preload();
    }
    const ol = new OBJLoader();
    if (materials) ol.setMaterials(materials);
    const group = ol.parse(data.objText);

    const r = Math.random();
    const defMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0.5 + r * 0.5, 0.5 + Math.sin(r * 10) * 0.5, 0.5 + Math.cos(r * 10) * 0.5),
        side: THREE.DoubleSide, shininess: 30, userData: { isDefault: true }
    });
    group.traverse(child => {
        if (!child.isMesh) return;
        const fixMat = m => { if (!m) return defMat; if (m.map) m.color?.set(0xffffff); return m; };
        if (Array.isArray(child.material)) child.material = materials ? child.material.map(fixMat) : child.material.map(() => defMat);
        else child.material = materials ? fixMat(child.material) : defMat;
    });

    if (S.currentMesh) S.currentMesh.visible = false;
    scene.add(group);
    S.importMeshGroups.set(idx, group);
    S.activeImportIdx = idx;
    S._activeIs2D = false;
    if (S.selectionBox) { _removeSelectionBox(); }
    S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
    S.selectionBox.material.transparent = true;
    S.selectionBox.material.opacity = 0.35;
    scene.add(S.selectionBox);
    if (S._currentTransformMode !== 'none' && S.transformCtrl) {
        S.transformCtrl.attach(group);
        S.transformCtrl.setMode(S._currentTransformMode);
    }
    S.importOriginOffsets.delete(idx);
    S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
    window._pushImportPosition?.();
    window._pushImportMaterials?.();
    window._pushImportOrigin?.();

    const box = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3(); box.getCenter(center);
    const size = box.getSize(new THREE.Vector3()).length();
    if (isFinite(size) && size > 0) {
        camera.far = Math.max(2000, size * 3);
        camera.updateProjectionMatrix();
        camera.position.set(center.x + size * 0.6, center.y + size * 0.4, center.z + size * 0.6);
        camera.lookAt(center); controls.target.copy(center); controls.update();
    }
}

export async function _sendImport2D(idx) {
    const key = `2d_${idx}`;
    if (S.importMeshGroups.has(key)) {
        const group = S.importMeshGroups.get(key);
        group.visible = true;
        S.activeImportIdx = idx;
        S._activeIs2D = true;
        if (S.selectionBox) { _removeSelectionBox(); }
        S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        S.selectionBox.material.transparent = true;
        S.selectionBox.material.opacity = 0.35;
        S.selectionBox.material.depthTest = false;
        S.selectionBox.userData._overlay = true;
        overlayScene.add(S.selectionBox);
        S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
        window._pushImportMaterials?.();
        return;
    }

    const data = importPrev.getModelData(idx);
    if (!data?.objText) return;

    let materials = null;
    if (data.mtlText?.trim()) {
        const ml = new MTLLoader();
        materials = ml.parse(data.mtlText, '');
        materials.preload();
    }
    const ol = new OBJLoader();
    if (materials) ol.setMaterials(materials);
    const parsed = ol.parse(data.objText);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let cx = 0, cyObj = 0, cz = 0, totalVerts = 0;
    parsed.traverse(child => {
        if (!child.isMesh) return;
        const posAttr = child.geometry.getAttribute('position');
        if (!posAttr) return;
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
            cx += x; cyObj += y; cz += z;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            totalVerts++;
        }
    });
    if (!totalVerts) return;
    cx /= totalVerts; cyObj /= totalVerts; cz /= totalVerts;
    const maxDim = Math.max(maxX - minX, maxZ - minZ, 0.001);
    const sc = 0.5 / maxDim;

    const group = new THREE.Group();
    group.userData.is2D = true;
    group.userData._importIdx2D = idx;
    group.userData._2dScale = sc;

    parsed.traverse(child => {
        if (!child.isMesh) return;
        const posAttr = child.geometry.getAttribute('position');
        if (!posAttr) return;

        const newPos = new Float32Array(posAttr.count * 3);
        for (let i = 0; i < posAttr.count; i++) {
            newPos[i * 3]     = (posAttr.getX(i) - cx) * sc;
            newPos[i * 3 + 1] = (posAttr.getZ(i) - cz) * sc;
            newPos[i * 3 + 2] = (posAttr.getY(i) - cyObj) * sc;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
        const idx2 = child.geometry.getIndex();
        if (idx2) geo.setIndex(idx2);
        if (child.geometry.groups.length) {
            for (const g of child.geometry.groups) geo.addGroup(g.start, g.count, g.materialIndex);
        }

        const origMats = Array.isArray(child.material) ? child.material : [child.material];
        const newMats = origMats.map(m => {
            const nm = new THREE.MeshBasicMaterial({
                color: m.color ? m.color.clone() : new THREE.Color(0.6, 0.6, 0.6),
                side: THREE.DoubleSide,
                transparent: true,
                opacity: m.opacity ?? 0.95,
                depthTest: true,
                depthWrite: true,
            });
            nm.name = m.name || '';
            return nm;
        });

        const mesh = new THREE.Mesh(geo, newMats.length === 1 ? newMats[0] : newMats);
        group.add(mesh);
    });

    overlayScene.add(group);
    S.importMeshGroups.set(key, group);
    S.activeImportIdx = idx;
    S._activeIs2D = true;

    if (S.selectionBox) { _removeSelectionBox(); }
    S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
    S.selectionBox.material.transparent = true;
    S.selectionBox.material.opacity = 0.35;
    S.selectionBox.material.depthTest = false;
    S.selectionBox.userData._overlay = true;
    overlayScene.add(S.selectionBox);

    if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = false; }
    if (S._currentTransformMode !== 'none' && S.transformCtrl2D) {
        S.transformCtrl2D.enabled = true;
        S.transformCtrl2D.attach(group);
        _apply2DGizmoMode(S._currentTransformMode);
    }
    S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
    window._pushImportMaterials?.();
}

export function getActiveImportExportData() {
    return getImportExportDataByIndex(S.activeImportIdx);
}

export function getImportExportDataByIndex(idx, forceIs2D = null) {
    const is2D = forceIs2D !== null ? forceIs2D : S.importMeshGroups.has(`2d_${idx}`);
    const obj = is2D ? S.importMeshGroups.get(`2d_${idx}`) : S.importMeshGroups.get(idx);
    if (!obj) return null;
    if (is2D) {
        const data = _groupToObjMtl(obj);
        if (!data?.objText) return null;
        return {
            objText: data.objText,
            mtlText: data.mtlText || '',
            posX: obj.position.x,
            posY: obj.position.y,
            posZ: 0,
            rotX: 0, rotY: 0, rotZ: 0,
            scaleX: 1, scaleY: 1, scaleZ: 1,
            scale2D: obj.userData._2dScale || 1
        };
    }
    const data = _groupToObjMtl(obj);
    if (!data?.objText) return null;
    return {
        objText: data.objText,
        mtlText: data.mtlText || '',
        posX: obj.position.x - S.mapOffset.x,
        posY: obj.position.y - S.mapOffset.y,
        posZ: obj.position.z - S.mapOffset.z,
        rotX: 0, rotY: 0, rotZ: 0,
        scaleX: 1, scaleY: 1, scaleZ: 1
    };
}

export function getImportMaterialsByIndex(idx, forceIs2D = null) {
    const group = (forceIs2D === true)
        ? S.importMeshGroups.get(`2d_${idx}`)
        : (forceIs2D === false)
            ? S.importMeshGroups.get(idx)
            : (S.importMeshGroups.get(idx) ?? S.importMeshGroups.get(`2d_${idx}`));
    if (!group) return [];
    const seen = new Set();
    const result = [];
    let matCount = 0;
    group.traverse(child => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => {
            if (!m || seen.has(m.uuid)) return;
            seen.add(m.uuid);
            const name = m.name || 'mat_' + matCount;
            matCount++;
            result.push({ key: m.uuid, name, hex: '#' + (m.color?.getHexString() ?? 'ffffff') });
        });
    });
    return result;
}

export function selectImportMesh(idx, is2D = false) {
    const group = is2D ? S.importMeshGroups.get(`2d_${idx}`) : S.importMeshGroups.get(idx);
    if (!group) {
        if (S.selectionBox) { _removeSelectionBox(); }
        if (S.transformCtrl?.object) S.transformCtrl.detach();
        if (S.transformCtrl2D?.object) S.transformCtrl2D.detach();
        if (S.originDot) S.originDot.visible = false;
        return;
    }
    S.activeImportIdx = idx;
    S._activeIs2D = is2D;
    if (S.selectionBox) { _removeSelectionBox(); }
    S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
    S.selectionBox.material.transparent = true;
    S.selectionBox.material.opacity = 0.35;
    if (is2D) {
        S.selectionBox.material.depthTest = false;
        S.selectionBox.userData._overlay = true;
        overlayScene.add(S.selectionBox);
        if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = false; }
        if (S._currentTransformMode !== 'none' && S.transformCtrl2D) {
            S.transformCtrl2D.enabled = true;
            S.transformCtrl2D.attach(group);
            _apply2DGizmoMode(S._currentTransformMode);
        }
    } else {
        scene.add(S.selectionBox);
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        if (S._currentTransformMode !== 'none' && S.transformCtrl) {
            S.transformCtrl.attach(group);
            S.transformCtrl.setMode(S._currentTransformMode);
        }
    }
    if (S.originDot && S._originDotVisible) {
        S.originDot.position.copy(group.position);
        S.originDot.visible = true;
    }
}

export function setImportVisibleByIndex(idx, visible, is2D = false) {
    const g = is2D ? S.importMeshGroups.get(`2d_${idx}`) : S.importMeshGroups.get(idx);
    if (g) g.visible = visible;
}

export function setImportVisible(visible) {
    const active = _getImportGroup();
    if (active) active.visible = visible;
}

export function setImportPosition(x, y, z) {
    const active = _getImportGroup();
    if (!active) return;
    const is2D = S.importMeshGroups.has(`2d_${S.activeImportIdx}`);
    if (is2D) {
        const sc = active.userData._2dScale || 1;
        active.position.set(x * sc, z * sc, 0);
    } else
        active.position.set(x, y, z);
    if (S.selectionBox) S.selectionBox.update();
}

export function setImportMaterialColor(uuid, hexColor) {
    const active = _getActiveObject();
    if (!active) return;
    if (active.isMesh) {
        if (active.material?.uuid === uuid) {
            if (active.material.vertexColors) {
                active.material.vertexColors = false;
                active.material.needsUpdate = true;
            }
            active.material.color.set(hexColor);
        }
    } else {
        active.traverse(child => {
            if (!child.isMesh) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => { if (m?.uuid === uuid) m.color.set(hexColor); });
        });
    }
}

export function resetImportMaterials() {
    const active = _getImportGroup();
    if (!active) return;
    const data = importPrev.getModelData(S.activeImportIdx);
    if (!data?.mtlText?.trim()) return;
    const ml = new MTLLoader(loadingManager);
    const materials = ml.parse(data.mtlText, '');
    materials.preload();
    active.traverse(child => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => {
            if (!m?.name) return;
            const orig = materials.materials[m.name];
            if (orig?.color) m.color.copy(orig.color);
        });
    });
    window._pushImportMaterials?.();
}

export function setImportOrigin(x, y, z) {
    const obj = _getActiveObject();
    if (!obj) return;
    if (obj.isMesh && S._activeTri3DIdx >= 0) {
        // Tri3D mesh
        const delta = new THREE.Vector3(x, y, z);
        obj.geometry.translate(-delta.x, -delta.y, -delta.z);
        obj.geometry.computeBoundingBox?.();
        obj.geometry.computeBoundingSphere?.();
        obj.position.x += delta.x;
        obj.position.y += delta.y;
        obj.position.z += delta.z;
        obj.userData.tri3dInitPos = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
        if (S.selectionBox) S.selectionBox.update();
        if (S.mainDotNetRef)
            S.mainDotNetRef.invokeMethodAsync('OnTri3DPositionChanged', 0, 0, 0);
        return;
    }
    // Import group
    const group = obj;
    const is2D = S.importMeshGroups.has(`2d_${S.activeImportIdx}`);
    const cur = S.importOriginOffsets.get(S.activeImportIdx) ?? new THREE.Vector3();
    const delta = new THREE.Vector3(x - cur.x, y - cur.y, z - cur.z);
    if (is2D) {
        const sc = group.userData._2dScale || 1;
        const d2d = new THREE.Vector3(delta.x * sc, delta.z * sc, 0);
        group.traverse(child => {
            if (!child.isMesh) return;
            child.geometry.translate(-d2d.x, -d2d.y, -d2d.z);
            child.geometry.computeBoundingBox?.();
            child.geometry.computeBoundingSphere?.();
        });
        group.position.x += d2d.x;
        group.position.y += d2d.y;
    } else {
        group.traverse(child => {
            if (!child.isMesh) return;
            child.geometry.translate(-delta.x, -delta.y, -delta.z);
            child.geometry.computeBoundingBox?.();
            child.geometry.computeBoundingSphere?.();
        });
        group.position.x += delta.x;
        group.position.y += delta.y;
        group.position.z += delta.z;
    }
    S.importOriginOffsets.set(S.activeImportIdx, new THREE.Vector3(x, y, z));
    if (S.selectionBox) S.selectionBox.update();
    window._pushImportPosition?.();
}

export function centerImportOrigin() {
    const obj = _getActiveObject();
    if (!obj) return;
    if (obj.isMesh) {
        // Tri3D mesh — déjà centré à la création, on recalcule au cas où
        const box = new THREE.Box3().setFromObject(obj);
        const center = new THREE.Vector3(); box.getCenter(center);
        const localCenter = obj.parent ? obj.parent.worldToLocal(center.clone()) : center.clone();
        const delta = localCenter.clone().sub(obj.position);
        if (delta.lengthSq() < 1e-10) return;
        obj.geometry.translate(-delta.x, -delta.y, -delta.z);
        obj.geometry.computeBoundingBox?.();
        obj.geometry.computeBoundingSphere?.();
        obj.position.copy(localCenter);
        obj.userData.tri3dInitPos = { x: localCenter.x, y: localCenter.y, z: localCenter.z };
        if (S.selectionBox) S.selectionBox.update();
        if (S._activeTri3DIdx >= 0 && S.mainDotNetRef)
            S.mainDotNetRef.invokeMethodAsync('OnTri3DPositionChanged', 0, 0, 0);
        return;
    }
    // Import group
    const worldBox = new THREE.Box3().setFromObject(obj);
    const worldCenter = new THREE.Vector3();
    worldBox.getCenter(worldCenter);
    const delta = worldCenter.clone().sub(obj.position);
    if (delta.lengthSq() < 1e-10) return;
    obj.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.translate(-delta.x, -delta.y, -delta.z);
        child.geometry.computeBoundingBox?.();
        child.geometry.computeBoundingSphere?.();
    });
    obj.position.copy(worldCenter);
    const cur = S.importOriginOffsets.get(S.activeImportIdx) ?? new THREE.Vector3();
    S.importOriginOffsets.set(S.activeImportIdx, cur.clone().add(delta));
    if (S.selectionBox) S.selectionBox.update();
    window._pushImportPosition?.();
    window._pushImportOrigin?.();
}

export function mirrorImport() {
    const active = _getImportGroup();
    if (active) active.scale.x *= -1;
}

export function removeImportModel(idx) {
    const key2D = `2d_${idx}`;
    const is2D = S.importMeshGroups.has(key2D);
    const key = is2D ? key2D : idx;
    const group = S.importMeshGroups.get(key);
    if (group) {
        group.traverse(c => {
            if (c instanceof THREE.Mesh) {
                c.geometry?.dispose();
                if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                else c.material?.dispose();
            }
        });
        if (is2D) overlayScene.remove(group);
        else scene.remove(group);
        S.importMeshGroups.delete(key);
    }
    S._text3dIndices.delete(idx);
    if (S.selectionBox) { _removeSelectionBox(); }
    if (S.transformCtrl?.object) S.transformCtrl.detach();
    if (S.transformCtrl2D?.object) S.transformCtrl2D.detach();
    if (S.originDot) S.originDot.visible = false;
    S.activeImportIdx = -1;

    importPrev.removeModel(idx);
    const remaining = [...S.importMeshGroups.keys()].length;
    return remaining;
}

export function switchImportTab(idx, is2DMode = false) {
    importPrev.switchTab(idx);
    S._activeIs2D = is2DMode;
    let group = null;
    if (is2DMode) {
        const keys2d = [...S.importMeshGroups.keys()].filter(k => typeof k === 'string' && k.startsWith('2d_'));
        if (idx >= 0 && idx < keys2d.length) {
            group = S.importMeshGroups.get(keys2d[idx]);
            S.activeImportIdx = parseInt(keys2d[idx].replace('2d_', ''), 10);
        }
    } else {
        const keys3d = [...S.importMeshGroups.keys()].filter(k => typeof k === 'number');
        if (idx >= 0 && idx < keys3d.length) {
            group = S.importMeshGroups.get(keys3d[idx]);
            S.activeImportIdx = keys3d[idx];
        }
    }
    const is2D = is2DMode;
    // Met à jour le BoxHelper de sélection
    if (S.selectionBox) { _removeSelectionBox(); }
    if (group) {
        S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        S.selectionBox.material.transparent = true;
        S.selectionBox.material.opacity = 0.35;
        if (is2D) {
            S.selectionBox.material.depthTest = false;
            S.selectionBox.userData._overlay = true;
            overlayScene.add(S.selectionBox);
        } else {
            scene.add(S.selectionBox);
        }
    }
    // Re-attache le bon gizmo
    if (is2D) {
        if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = false; }
        if (S._currentTransformMode !== 'none' && group && S.transformCtrl2D) {
            S.transformCtrl2D.enabled = true;
            S.transformCtrl2D.attach(group);
            _apply2DGizmoMode(S._currentTransformMode);
        } else if (S.transformCtrl2D) {
            S.transformCtrl2D.detach();
        }
    } else {
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        if (S.transformCtrl) {
            if (S._currentTransformMode !== 'none' && group) {
                S.transformCtrl.enabled = true;
                S.transformCtrl.attach(group);
                S.transformCtrl.setMode(S._currentTransformMode);
            } else {
                S.transformCtrl.detach();
            }
        }
    }
    S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', !!group);
    if (group) {
        window._pushImportPosition?.();
        window._pushImportMaterials?.();
        window._pushImportOrigin?.();
    } else {
        S.mainDotNetRef?.invokeMethodAsync('OnImportMaterialsChanged', []);
    }
}

export function removeText3D(idx) {
    const group = S.importMeshGroups.get(idx);
    if (!group) return;
    group.traverse(c => {
        if (c instanceof THREE.Mesh) {
            c.geometry?.dispose();
            if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
            else c.material?.dispose();
        }
    });
    scene.remove(group);
    S.importMeshGroups.delete(idx);
    S._text3dIndices.delete(idx);
    if (S.activeImportIdx === idx) {
        if (S.selectionBox) { _removeSelectionBox(); }
        if (S.transformCtrl) S.transformCtrl.detach();
    }
}
