import * as THREE from 'three';

const CLIP_GROUND_PATCH_MESH_NAMES = new Set([
    'stadiumgrassocc',  // grass clips (StadiumRoadMainClip, StadiumRoadDirtClip, etc.)
    'stadiumdirt',      // dirt clips (StadiumRoadDirtHillTiltClipLeft/Right, etc.)
]);
const COMPLETION_NAME = 'clipGroundCompletion';

export function patchClipGroundIfNeeded(root) {
    if (root.children.some(c => c.name === COMPLETION_NAME)) return;

    let sourceMesh = null;
    root.traverse(c => {
        if (!sourceMesh && c.isMesh && CLIP_GROUND_PATCH_MESH_NAMES.has((c.name || '').toLowerCase()))
            sourceMesh = c;
    });
    if (!sourceMesh) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
        16, -16, 1,
        32, -32, 1,
         0, -32, 1,
        32,   0, 1,
        16,   0, 1,
         0,   0, 1,
    ], 3));
    // UVs : u = x/32, v = (y+32)/32 — alignés sur la convention PlaneGeometry des tuiles terrain
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([
        0.5, 0.5,
        1.0, 0.0,
        0.0, 0.0,
        1.0, 1.0,
        0.5, 1.0,
        0.0, 1.0,
    ], 2));
    geo.setIndex([4, 5, 0,  4, 0, 3,  3, 0, 1,  5, 2, 0]);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, sourceMesh.material);
    mesh.name = COMPLETION_NAME;
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.originalMaterialName = sourceMesh.userData.originalMaterialName || '';
    root.add(mesh);
}
