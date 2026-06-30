import * as THREE from 'three';
import { S, scene, overlayScene, _apply2DGizmoMode } from './state.js';
import { _loadFont, _buildTextGroup, _groupToObjMtl, _removeSelectionBox } from './helpers.js';
import { importPrev } from './importPreview.js';

export async function createText3D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
    const actualFont = bold ? fontName + '_bold' : fontName;
    const font = await _loadFont(actualFont);
    const group = _buildTextGroup(text, font, thickness, letterSpacing, italic, underline, strike);
    scene.add(group);

    const { objText, mtlText } = _groupToObjMtl(group);
    await importPrev.addModel(objText, mtlText);

    if (S.currentMesh) S.currentMesh.visible = false;
    const idx = [...S.importMeshGroups.keys()].filter(k => typeof k === 'number').length;
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

    S._text3dIndices.add(idx);
    S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
    window._pushImportMaterials?.();
    return idx;
}

export async function createText2D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
    const actualFont = bold ? fontName + '_bold' : fontName;
    const font = await _loadFont(actualFont);
    const srcGroup = _buildTextGroup(text, font, thickness, letterSpacing, italic, underline, strike);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let cx = 0, cy = 0, totalVerts = 0;
    srcGroup.traverse(child => {
        if (!child.isMesh) return;
        const posAttr = child.geometry.getAttribute('position');
        if (!posAttr) return;
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i) + child.position.x;
            const y = posAttr.getY(i) + child.position.y;
            cx += x; cy += y;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            totalVerts++;
        }
    });
    if (!totalVerts) return -1;
    cx /= totalVerts; cy /= totalVerts;
    const maxDim = Math.max(maxX - minX, maxY - minY, 0.001);
    const sc = 0.5 / maxDim;

    const group = new THREE.Group();
    group.userData.is2D = true;
    group.userData._2dScale = sc;

    srcGroup.traverse(child => {
        if (!child.isMesh) return;
        const posAttr = child.geometry.getAttribute('position');
        if (!posAttr) return;
        const newPos = new Float32Array(posAttr.count * 3);
        for (let i = 0; i < posAttr.count; i++) {
            newPos[i * 3]     = (posAttr.getX(i) + child.position.x - cx) * sc;
            newPos[i * 3 + 1] = (posAttr.getY(i) + child.position.y - cy) * sc;
            newPos[i * 3 + 2] = 0;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
        const idx2 = child.geometry.getIndex();
        if (idx2) geo.setIndex(idx2);
        const mat = new THREE.MeshBasicMaterial({
            color: child.material.color ? child.material.color.clone() : new THREE.Color(1, 1, 1),
            side: THREE.DoubleSide,
            transparent: true,
            depthTest: true,
            depthWrite: true,
            name: child.material.name || ''
        });
        group.add(new THREE.Mesh(geo, mat));
    });

    const rotMat = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    srcGroup.traverse(child => {
        if (!child.isMesh) return;
        child.geometry.applyMatrix4(rotMat);
        const p = child.position.clone().applyMatrix4(rotMat);
        child.position.copy(p);
    });
    const { objText, mtlText } = _groupToObjMtl(srcGroup);
    srcGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });

    await importPrev.addModel(objText, mtlText);

    const modeCount = [...S.importMeshGroups.keys()].filter(k => typeof k === 'string' && k.startsWith('2d_')).length;
    const key = `2d_${modeCount}`;
    group.userData._importIdx2D = modeCount;
    S.importMeshGroups.set(key, group);
    overlayScene.add(group);
    S.activeImportIdx = modeCount;
    S._activeIs2D = true;

    if (S.selectionBox) { _removeSelectionBox(); }
    S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
    S.selectionBox.material.transparent = true;
    S.selectionBox.material.opacity = 0.35;
    S.selectionBox.material.depthTest = false;
    S.selectionBox.userData._overlay = true;
    overlayScene.add(S.selectionBox);

    if (S._currentTransformMode !== 'none' && S.transformCtrl2D) {
        S.transformCtrl2D.enabled = true;
        S.transformCtrl2D.attach(group);
        _apply2DGizmoMode(S._currentTransformMode);
    }
    if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = false; }

    S._text3dIndices.add(modeCount);
    S.mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
    window._pushImportMaterials?.();
    return modeCount;
}

export async function updateText3D(idx, text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
    const group = S.importMeshGroups.get(idx);
    if (!group) return;
    const pos = group.position.clone();
    const rot = { x: group.rotation.x, y: group.rotation.y, z: group.rotation.z };
    const scl = group.scale.clone();

    const savedColors = new Map();
    group.children.forEach(c => {
        if (c.isMesh && c.material?.name) savedColors.set(c.material.name, c.material.color.getHex());
    });

    while (group.children.length > 0) {
        const c = group.children[0];
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        group.remove(c);
    }

    const actualFont = bold ? fontName + '_bold' : fontName;
    const font = await _loadFont(actualFont);
    const temp = _buildTextGroup(text, font, thickness, letterSpacing, italic, underline, strike);
    while (temp.children.length > 0) {
        const c = temp.children[0];
        temp.remove(c);
        if (c.isMesh && c.material?.name && savedColors.has(c.material.name)) {
            c.material.color.setHex(savedColors.get(c.material.name));
        }
        group.add(c);
    }

    group.position.copy(pos);
    group.rotation.set(rot.x, rot.y, rot.z);
    group.scale.copy(scl);

    if (S.selectionBox) S.selectionBox.update();
}

export function selectText3D(idx) {
    const group = S.importMeshGroups.get(idx);
    if (!group) return;
    S.activeImportIdx = idx;
    if (S.selectionBox) { _removeSelectionBox(); }
    S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
    S.selectionBox.material.transparent = true;
    S.selectionBox.material.opacity = 0.35;
    scene.add(S.selectionBox);
    if (S._currentTransformMode !== 'none' && S.transformCtrl) {
        S.transformCtrl.attach(group);
        S.transformCtrl.setMode(S._currentTransformMode);
    }
}
