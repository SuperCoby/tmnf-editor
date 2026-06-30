import * as THREE from 'three';
import { S, scene, overlayScene, overlayCam, _apply2DGizmoMode } from './state.js';
import { _removeSelectionBox, _getImportGroup, _getActiveObject } from './helpers.js';
import { _getTri3DUniqueColors, _getTri3DAvgColor } from './materials.js';
import { importPrev } from './importPreview.js';

export function showBlockView() {
    if (S.currentMesh) S.currentMesh.visible = true;
    S.importMeshGroups.forEach(g => { g.visible = false; });
    S.tri3dMeshes.forEach(m => { m.visible = false; });
    if (S.selectionBox) S.selectionBox.visible = false;
    if (S._blockWireframe) { S._blockWireframe.parent?.remove(S._blockWireframe); S._blockWireframe.geometry?.dispose(); S._blockWireframe.material?.dispose(); S._blockWireframe = null; }
    if (S._blockMatInfoEl) S._blockMatInfoEl.style.display = 'none';
    if (S._gridCross) S._gridCross.visible = false;
    S._gridVisible = false;
    if (S._gridCursorEl) S._gridCursorEl.style.display = 'none';
    if (S.originDot)    S.originDot.visible    = false;
    S.transformCtrl?.detach();
}

export function showTrianglesView() {
    if (S.currentMesh) S.currentMesh.visible = false;
    if (S.mapGroup) S.mapGroup.visible = true;
    if (S._blockWireframe) { S._blockWireframe.parent?.remove(S._blockWireframe); S._blockWireframe.geometry?.dispose(); S._blockWireframe.material?.dispose(); S._blockWireframe = null; }
    S.importMeshGroups.forEach(g => { g.visible = true; });
    S.tri3dMeshes.forEach(m => { m.visible = true; });
    if (S.selectionBox) S.selectionBox.visible = true;
    if (S.originDot)    S.originDot.visible    = S._originDotVisible;
    if (S._currentTransformMode !== 'none' && S.transformCtrl) {
        const active = _getActiveObject();
        if (active) { S.transformCtrl.attach(active); S.transformCtrl.setMode(S._currentTransformMode); }
    }
}

export function setTransformMode(mode) {
    S._currentTransformMode = mode;
    const active = _getActiveObject();
    if (mode === 'none' || !active) {
        if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = true; }
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        return;
    }
    const is2D = active.userData?.is2D || S.importMeshGroups.has(`2d_${S.activeImportIdx}`);
    if (is2D) {
        if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = false; }
        if (S.transformCtrl2D) { S.transformCtrl2D.enabled = true; S.transformCtrl2D.attach(active); _apply2DGizmoMode(mode); }
    } else {
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        if (S.transformCtrl) { S.transformCtrl.enabled = true; S.transformCtrl.attach(active); S.transformCtrl.setMode(mode); }
    }
}

export function setOriginDotVisible(visible) {
    S._originDotVisible = visible;
    if (!visible) { if (S.originDot) S.originDot.visible = false; return; }
    const obj = _getActiveObject();
    if (!obj) return;
    const is2D = obj.userData?.is2D || S.importMeshGroups.has(`2d_${S.activeImportIdx}`);
    if (!S.originDot) {
        const geo = new THREE.SphereGeometry(1, 16, 10);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffee00, transparent: true, opacity: 0.65, depthTest: false });
        S.originDot = new THREE.Mesh(geo, mat);
        S.originDot.renderOrder = 999;
    }
    if (S.originDot.parent) S.originDot.parent.remove(S.originDot);
    if (is2D) {
        S.originDot.scale.setScalar(0.02);
        overlayScene.add(S.originDot);
    } else {
        scene.add(S.originDot);
    }
    obj.getWorldPosition(S.originDot.position);
    S.originDot.visible = true;
}

export function handlePointerUp(e, rdx, rdy, ray, rm, camera, _setSelectionBox) {
    if (S.transformCtrl?.dragging || S.transformCtrl2D?.dragging) return;
    const dx = e.clientX - rdx, dy = e.clientY - rdy;
    if (dx * dx + dy * dy > 25) return;

    const rect = e.currentTarget.getBoundingClientRect();
    rm.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    rm.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

    // Raycast overlay (Triangles2D + imports 2D) first — they render on top
    const tri2dTargets = [];
    S.tri3dMeshes.forEach((mesh, idx) => {
        if (mesh.visible && mesh.userData.is2D) tri2dTargets.push({ mesh, idx, type: 'tri' });
    });
    const import2dTargets = [];
    S.importMeshGroups.forEach((mesh, key) => {
        if (typeof key === 'string' && key.startsWith('2d_') && mesh.visible) {
            import2dTargets.push({ mesh, key, type: 'import2d' });
        }
    });
    const allOverlay = [...tri2dTargets, ...import2dTargets];
    if (allOverlay.length) {
        ray.setFromCamera(rm, overlayCam);
        const hits2d = ray.intersectObjects(allOverlay.map(t => t.mesh), true);
        if (hits2d.length) {
            const hitObj2d = hits2d[0].object;
            const foundTri2d = tri2dTargets.find(t => t.mesh === hitObj2d);
            if (foundTri2d) {
                S.activeImportIdx = -1;
                S._activeTri3DIdx = foundTri2d.idx;
                _removeSelectionBox();
                S.selectionBox = new THREE.BoxHelper(foundTri2d.mesh, 0x4488ff);
                S.selectionBox.material.transparent = true;
                S.selectionBox.material.opacity = 0.35;
                S.selectionBox.material.depthTest = false;
                S.selectionBox.userData._overlay = true;
                overlayScene.add(S.selectionBox);
                if (S.transformCtrl?.object) S.transformCtrl.detach();
                const m = foundTri2d.mesh.material;
                const mats = m.vertexColors ? _getTri3DUniqueColors(foundTri2d.mesh) : [
                    { key: m.uuid, name: m.name || 'Material', hex: '#' + (m.color?.getHexString() ?? 'ffffff') }
                ];
                S.mainDotNetRef?.invokeMethodAsync('OnImportMaterialsChanged', mats);
                S.mainDotNetRef?.invokeMethodAsync('OnTri3DSelected', foundTri2d.idx);
                return;
            }
            let foundImp2d = import2dTargets.find(t => t.mesh === hitObj2d);
            if (!foundImp2d) {
                let p = hitObj2d.parent;
                while (p) {
                    foundImp2d = import2dTargets.find(t => t.mesh === p);
                    if (foundImp2d) break;
                    p = p.parent;
                }
            }
            if (foundImp2d) {
                S._activeTri3DIdx = -1;
                const impIdx = parseInt(foundImp2d.key.substring(3));
                S.activeImportIdx = impIdx;
                importPrev.switchTab(impIdx);
                _removeSelectionBox();
                S.selectionBox = new THREE.BoxHelper(foundImp2d.mesh, 0x4488ff);
                S.selectionBox.material.transparent = true;
                S.selectionBox.material.opacity = 0.35;
                S.selectionBox.material.depthTest = false;
                S.selectionBox.userData._overlay = true;
                overlayScene.add(S.selectionBox);
                if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = false; }
                if (S._currentTransformMode !== 'none' && S.transformCtrl2D) {
                    S.transformCtrl2D.enabled = true;
                    S.transformCtrl2D.attach(foundImp2d.mesh);
                    _apply2DGizmoMode(S._currentTransformMode);
                }
                S.mainDotNetRef?.invokeMethodAsync('OnSwitchImportMode', '2D');
                S.mainDotNetRef?.invokeMethodAsync('OnImportSelected', impIdx);
                window._pushImportMaterials?.();
                return;
            }
        }
    }

    // Raycast main scene
    ray.setFromCamera(rm, camera);

    // Imports
    const targets = [];
    S.importMeshGroups.forEach((group, idx) => {
        if (!group.visible) return;
        group.traverse(c => { if (c.isMesh) targets.push({ mesh: c, idx }); });
    });

    // Triangles3D (not 2D)
    const tri3dTargets = [];
    S.tri3dMeshes.forEach((mesh, idx) => {
        if (mesh.visible && !mesh.userData.is2D) tri3dTargets.push({ mesh, idx });
    });

    const blockMeshes = [];
    if (S.currentMesh?.visible) {
        S.currentMesh.traverse(c => { if (c.isMesh && c.visible) blockMeshes.push(c); });
    }
    if (S.mapGroup?.visible) {
        S.mapGroup.traverse(c => { if (c.isMesh && c.visible) blockMeshes.push(c); });
    }

    const allMeshes = [...targets.map(t => t.mesh), ...tri3dTargets.map(t => t.mesh), ...blockMeshes];

    const hits = allMeshes.length ? ray.intersectObjects(allMeshes, false) : [];
    if (S._blockWireframe) {
        S._blockWireframe.parent?.remove(S._blockWireframe);
        S._blockWireframe.geometry?.dispose();
        S._blockWireframe.material?.dispose();
        S._blockWireframe = null;
    }
    if (S._blockMatInfoEl) S._blockMatInfoEl.style.display = 'none';
    if (!hits.length) {
        S.activeImportIdx = -1;
        S._activeTri3DIdx = -1;
        _removeSelectionBox();
        if (S.transformCtrl) { S.transformCtrl.detach(); S.transformCtrl.enabled = true; }
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        S.mainDotNetRef?.invokeMethodAsync('OnSceneDeselected');
        return;
    }

    const hitObj = hits[0].object;
    const hitInstanceId = hits[0].instanceId;

    // Check import hit
    const foundImport = targets.find(t => t.mesh === hitObj);
    if (foundImport) {
        S._activeTri3DIdx = -1;
        S.activeImportIdx = foundImport.idx;
        _setSelectionBox(_getImportGroup());
        importPrev.switchTab(foundImport.idx);
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        if (S._currentTransformMode !== 'none' && S.transformCtrl) { S.transformCtrl.enabled = true; S.transformCtrl.attach(_getImportGroup()); S.transformCtrl.setMode(S._currentTransformMode); }
        S.mainDotNetRef?.invokeMethodAsync('OnSwitchImportMode', '3D');
        S.mainDotNetRef?.invokeMethodAsync('OnImportSelected', foundImport.idx);
        if (S._text3dIndices.has(foundImport.idx)) {
            S.mainDotNetRef?.invokeMethodAsync('OnText3DSelected', foundImport.idx);
        }
        window._pushImportPosition?.();
        window._pushImportMaterials?.();
        window._pushImportOrigin?.();
        return;
    }

    // Check tri3d hit
    const foundTri = tri3dTargets.find(t => t.mesh === hitObj);
    if (foundTri) {
        S._activeTri3DIdx = foundTri.idx;
        _setSelectionBox(foundTri.mesh);
        if (S.transformCtrl2D) { S.transformCtrl2D.detach(); S.transformCtrl2D.enabled = false; }
        if (S._currentTransformMode !== 'none' && S.transformCtrl) {
            S.transformCtrl.enabled = true;
            S.transformCtrl.attach(foundTri.mesh);
            S.transformCtrl.setMode(S._currentTransformMode);
        }
        const m = foundTri.mesh.material;
        const mats = m.vertexColors ? _getTri3DUniqueColors(foundTri.mesh) : [
            { key: m.uuid, name: m.name || 'Material', hex: '#' + (m.color?.getHexString() ?? 'ffffff') }
        ];
        S.mainDotNetRef?.invokeMethodAsync('OnImportMaterialsChanged', mats);
        S.mainDotNetRef?.invokeMethodAsync('OnSwitchImportMode', '3D');
        S.mainDotNetRef?.invokeMethodAsync('OnTri3DSelected', foundTri.idx);
        return;
    }

    // Check block/map hit — wireframe + show info
    if (blockMeshes.includes(hitObj)) {
        const mesh = hitObj;
        if (S._blockWireframe) {
            S._blockWireframe.parent?.remove(S._blockWireframe);
            S._blockWireframe.geometry?.dispose();
            S._blockWireframe.material?.dispose();
            S._blockWireframe = null;
        }
        _removeSelectionBox();

        // Une tuile de terrain (InstancedMesh) regroupe plusieurs cellules 32x32 dans le même objet —
        // il faut isoler la matrice de l'instance précise cliquée, sinon le wireframe/box couvre tout le plan.
        const isInstancedTile = mesh.isInstancedMesh && hitInstanceId != null;
        let instWorldMatrix = null;
        if (isInstancedTile) {
            instWorldMatrix = new THREE.Matrix4();
            mesh.getMatrixAt(hitInstanceId, instWorldMatrix);
            instWorldMatrix.premultiply(mesh.matrixWorld);
        }

        if (S._blockSelectMode) {
            // Block mode: sélectionne le block entier (ou la tuile de terrain seule si c'est le sol)
            _removeSelectionBox();
            if (isInstancedTile) {
                const geo = mesh.geometry;
                if (!geo.boundingBox) geo.computeBoundingBox();
                const box = geo.boundingBox.clone().applyMatrix4(instWorldMatrix);
                S.selectionBox = new THREE.Box3Helper(box, 0xffaa00);
                S.selectionBox.material.transparent = true;
                S.selectionBox.material.opacity = 0.6;
                scene.add(S.selectionBox);
                if (S._blockMatInfoEl) {
                    S._blockMatInfoEl.innerText = 'Terrain: ' + (mesh.userData.originalMaterialName || mesh.material?.name || '?');
                    S._blockMatInfoEl.style.display = '';
                }
            } else {
                let blockGroup = mesh;
                while (blockGroup.parent && blockGroup.parent !== S.mapGroup && blockGroup.parent !== S.currentMesh)
                    blockGroup = blockGroup.parent;
                const blockName = blockGroup.userData.blockName || '?';
                S.selectionBox = new THREE.BoxHelper(blockGroup, 0xffaa00);
                S.selectionBox.material.transparent = true;
                S.selectionBox.material.opacity = 0.6;
                scene.add(S.selectionBox);
                if (S._blockMatInfoEl) {
                    S._blockMatInfoEl.innerText = 'Block: ' + blockName;
                    S._blockMatInfoEl.style.display = '';
                }
            }
        } else {
            // Mesh mode: wireframe sur le mesh individuel (ou la tuile précise si c'est le sol)
            const wfGeo = new THREE.WireframeGeometry(mesh.geometry);
            const wfMat = new THREE.LineBasicMaterial({ color: 0xffaa00, depthTest: false });
            S._blockWireframe = new THREE.LineSegments(wfGeo, wfMat);
            if (isInstancedTile) {
                S._blockWireframe.matrix.copy(instWorldMatrix);
                S._blockWireframe.matrixAutoUpdate = false;
            } else {
                S._blockWireframe.position.copy(mesh.position);
                S._blockWireframe.rotation.copy(mesh.rotation);
                S._blockWireframe.scale.copy(mesh.scale);
                if (mesh.parent) {
                    S._blockWireframe.applyMatrix4(mesh.parent.matrixWorld);
                }
            }
            S._blockWireframe.renderOrder = 999;
            scene.add(S._blockWireframe);

            const matName = mesh.userData.originalMaterialName || mesh.material?.name || '?';
            if (S._blockMatInfoEl) {
                const texMap = S._matAllTextures[matName.toLowerCase()] || S._matAllTextures[matName] || {};
                const lines = ['Material: ' + matName];
                for (const [type, file] of Object.entries(texMap)) lines.push(type + ': ' + file);
                if (lines.length === 1) lines.push('aucune texture');
                S._blockMatInfoEl.innerText = lines.join('\n');
                S._blockMatInfoEl.style.display = '';
            }
        }
    }
}
