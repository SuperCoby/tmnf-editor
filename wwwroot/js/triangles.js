import * as THREE from 'three';
import { S, scene, overlayScene } from './state.js';
import { _getTri3DUniqueColors } from './materials.js';
import { _removeSelectionBox } from './helpers.js';

// ─── Triangles3D MediaTracker ───────────────────────────────────────────
export function clearTri3DKeyframes(index) {
    if (index >= 0 && index < S.tri3dMeshes.length) {
        delete S.tri3dMeshes[index].userData.tri3dKeyframes;
    }
}

export function clearTriangles3D() {
    for (const m of S.tri3dMeshes) {
        m.geometry?.dispose();
        if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
        else m.material?.dispose();
        if (m.userData.is2D) overlayScene.remove(m);
        else scene.remove(m);
    }
    S.tri3dMeshes = [];
    S._tri3dIs2D = [];
    S._activeTri3DIdx = -1;
    if (S.selectionBox) { _removeSelectionBox(); }
}

export function addTriangles3D(blocks) {
    if (!blocks?.length) return;
    for (const block of blocks) {
        const { vertices, indices, keyframes, is2D } = block;
        if (!vertices?.length || !indices?.length || !keyframes?.length) continue;

        const vertCount = vertices.length;
        const colors = new Float32Array(vertCount * 3);
        for (let i = 0; i < vertCount; i++) {
            colors[i * 3]     = vertices[i].r;
            colors[i * 3 + 1] = vertices[i].g;
            colors[i * 3 + 2] = vertices[i].b;
        }

        const firstKf = keyframes[0];
        const positions = new Float32Array(firstKf.positions);

        if (is2D) {
            for (let i = 0; i < vertCount; i++) {
                positions[i * 3] = -positions[i * 3];
                positions[i * 3 + 2] = 0;
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            geo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(indices), 1));

            const mat = new THREE.MeshBasicMaterial({
                vertexColors: true,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.95,
                depthTest: false,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData.is2D = true;

            if (keyframes.length > 1) {
                mesh.userData.tri3dKeyframes = keyframes;
                mesh.userData.tri3dVertCount = vertCount;
            }

            S.tri3dMeshes.push(mesh);
            S._tri3dIs2D.push(true);
            overlayScene.add(mesh);
        } else {
            // Triangles3D: world-space, centré au pivot
            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < vertCount; i++) {
                cx += positions[i * 3];
                cy += positions[i * 3 + 1];
                cz += positions[i * 3 + 2];
            }
            cx /= vertCount; cy /= vertCount; cz /= vertCount;
            for (let i = 0; i < vertCount; i++) {
                positions[i * 3]     -= cx;
                positions[i * 3 + 1] -= cy;
                positions[i * 3 + 2] -= cz;
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            geo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(indices), 1));
            geo.computeVertexNormals();

            const mat = new THREE.MeshBasicMaterial({
                vertexColors: true,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.95,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(cx, cy, cz);
            mesh.userData.tri3dInitPos = { x: cx, y: cy, z: cz };

            if (keyframes.length > 1) {
                mesh.userData.tri3dKeyframes = keyframes;
                mesh.userData.tri3dVertCount = vertCount;
            }

            S.tri3dMeshes.push(mesh);
            S._tri3dIs2D.push(false);
            if (S.mapGroup) S.mapGroup.add(mesh);
            else scene.add(mesh);
        }
    }
}

export function setTri3DVisible(index, visible) {
    if (index >= 0 && index < S.tri3dMeshes.length)
        S.tri3dMeshes[index].visible = visible;
}

export function setTri3DPosition(index, x, y, z) {
    if (index >= 0 && index < S.tri3dMeshes.length) {
        const mesh = S.tri3dMeshes[index];
        const init = mesh.userData.tri3dInitPos;
        if (init) mesh.position.set(init.x + x, init.y + y, init.z + z);
        else mesh.position.set(x, y, z);
        if (S.selectionBox) S.selectionBox.update();
    }
}

export function getTri3DTransform(index) {
    if (index < 0 || index >= S.tri3dMeshes.length) return null;
    const mesh = S.tri3dMeshes[index];
    const init = mesh.userData.tri3dInitPos || { x: 0, y: 0, z: 0 };
    const m = mesh.material;
    return {
        posX: mesh.position.x - init.x,
        posY: mesh.position.y - init.y,
        posZ: mesh.position.z - init.z,
        rotX: mesh.rotation.x,
        rotY: mesh.rotation.y,
        rotZ: mesh.rotation.z,
        scaleX: mesh.scale.x,
        scaleY: mesh.scale.y,
        scaleZ: mesh.scale.z,
        colorHex: (m && !m.vertexColors) ? '#' + m.color.getHexString() : null
    };
}

export function selectTri3DMesh(index) {
    if (index < 0 || index >= S.tri3dMeshes.length) {
        S._activeTri3DIdx = -1;
        if (S.selectionBox) { _removeSelectionBox(); }
        if (S.transformCtrl?.object) S.transformCtrl.detach();
        if (S.originDot) S.originDot.visible = false;
        return;
    }
    S._activeTri3DIdx = index;
    const mesh = S.tri3dMeshes[index];

    if (S.selectionBox) { _removeSelectionBox(); }

    if (mesh.userData.is2D) {
        if (S.transformCtrl?.object) S.transformCtrl.detach();
        S.selectionBox = new THREE.BoxHelper(mesh, 0x4488ff);
        S.selectionBox.material.transparent = true;
        S.selectionBox.material.opacity = 0.35;
        S.selectionBox.material.depthTest = false;
        S.selectionBox.userData._overlay = true;
        overlayScene.add(S.selectionBox);
    } else {
        S.selectionBox = new THREE.BoxHelper(mesh, 0x4488ff);
        S.selectionBox.material.transparent = true;
        S.selectionBox.material.opacity = 0.35;
        scene.add(S.selectionBox);

        if (S._currentTransformMode !== 'none' && S.transformCtrl) {
            S.transformCtrl.attach(mesh);
            S.transformCtrl.setMode(S._currentTransformMode);
        }
    }

    if (S.mainDotNetRef) {
        const m = mesh.material;
        const mats = m.vertexColors ? _getTri3DUniqueColors(mesh) : [
            { key: m.uuid, name: m.name || 'Material', hex: '#' + (m.color?.getHexString() ?? 'ffffff') }
        ];
        S.mainDotNetRef.invokeMethodAsync('OnImportMaterialsChanged', mats);
    }

    if (S.originDot && S._originDotVisible) {
        S.originDot.position.copy(mesh.position);
        S.originDot.visible = true;
    }
}
