import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import {
    S, scene, camera, controls, overlayScene,
    loadingManager, objLoader,
    HIDDEN_MATERIALS, ALPHA_CUTOUT_MATERIALS, ADDITIVE_GLOW_MATERIALS, WATER_MATERIALS, WORLDUV_MATERIALS, getWaterMaterial,
    rawModelCache, MAP_OFFSET_DEFAULT,
} from './state.js';
import { parseMtlTextures, parseMtlAllTextures } from './materials.js';
import { _removeSelectionBox, findMesh, clearMesh } from './helpers.js';
import { patchClipGroundIfNeeded } from './clipGroundPatch.js';

// Fichiers DDS connus pour chaque matériau de sol — chargés directement depuis le pak
// (le blobUrlMap les contient déjà, extraits en Phase 2 côté C#).
const GROUND_TEXTURE_FILES = {
    stadiumgrass: 'StadiumGrass1.dds',
    stadiumdirt: 'StadiumDirt1.dds',
    stadiumfabricfloornoocc: 'StadiumFabricFloorD.dds',
};

// Textures imposées pour certains matériaux dont le MTL ne déclare pas le bon map_Kd
const MATERIAL_TEXTURE_OVERRIDES = {
    'stadiumroaddirttoroadflat': 'StadiumRoadDirtToRoadD.dds',
};

function findGroundDonorTexture(matName) {
    if (!S.mapGroup) return null;
    let tex = null;
    S.mapGroup.traverse(child => {
        if (tex || !child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats)
            if (m?.name?.toLowerCase() === matName && m.map) { tex = m.map; break; }
    });
    return tex;
}

// Cherche d'abord un mesh déjà rendu avec ce matériau (rapide, réutilise la texture),
// sinon charge directement le fichier DDS connu depuis le blobUrlMap.
function loadGroundTexture(matName) {
    const donor = findGroundDonorTexture(matName);
    if (donor) return donor;
    const file = GROUND_TEXTURE_FILES[matName];
    if (!file) return null;
    const handler = loadingManager.getHandler(file) || new THREE.TextureLoader(loadingManager);
    const tex = handler.load(file);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

function applyAdditiveGlow(mat) {
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
}

function applyWorldUV(mat) {
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uvScale = { value: new THREE.Matrix3().set(1/16, 0, 0, 0, 1/16, 0, 0, 0, 1) };
        shader.vertexShader = `uniform mat3 uvScale;\n${shader.vertexShader}`
            .replace('#include <uv_vertex>\n', '')
            .replace(
                '#include <worldpos_vertex>',
                `vec4 worldPosition = vec4(transformed, 1.0);
                #ifdef USE_INSTANCING
                worldPosition = instanceMatrix * worldPosition;
                #endif
                worldPosition = modelMatrix * worldPosition;
                vMapUv = (uvScale * vec3(worldPosition.xz, 1)).xy;`
            );
    };
    mat.customProgramCacheKey = () => 'worlduv';
}

// Sérialise un rawObj Three.js en format binaire stockable dans IDB (TypedArrays natifs)
export function serializeRawObj(rawObj, matTexMap) {
    const meshes = [];
    rawObj.traverse(c => {
        if (!c.isMesh || !c.geometry) return;
        const g = c.geometry;
        const matName = (c.material?.name || c.userData?.originalMaterialName || '').toLowerCase();
        meshes.push({
            name: c.name || '',
            matName,
            visible: c.visible !== false,
            texFilename: matTexMap?.[matName] || null,
            positions: new Float32Array(g.attributes.position.array),
            normals:   g.attributes.normal ? new Float32Array(g.attributes.normal.array) : null,
            uvs:       g.attributes.uv     ? new Float32Array(g.attributes.uv.array)     : null,
            indices:   g.index             ? new Uint32Array(g.index.array)               : null,
        });
    });
    return { meshes };
}

// Reconstruit un rawObj Three.js depuis les données IDB binaires
export function deserializeRawObj(cached) {
    const group = new THREE.Group();
    const rr = Math.random();
    const defMatBase = { side: THREE.DoubleSide, flatShading: false, shininess: 30, userData: { isDefault: true } };
    for (const m of cached.meshes) {
        if (HIDDEN_MATERIALS.has(m.matName)) continue;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
        if (m.normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
        if (m.uvs)     geo.setAttribute('uv',     new THREE.Float32BufferAttribute(m.uvs,     2));
        if (m.indices) geo.setIndex(new THREE.Uint32BufferAttribute(m.indices, 1));

        let mat;
        if (WATER_MATERIALS.has(m.matName)) {
            mat = getWaterMaterial();
        } else {
            // Corrige la texture diffuse depuis les slots JSON si disponible
            let texFile = MATERIAL_TEXTURE_OVERRIDES[m.matName] || m.texFilename;
            if (!MATERIAL_TEXTURE_OVERRIDES[m.matName]) {
                const slots = S._matAllTextures[m.matName];
                if (slots) {
                    const diffuseSlots = ['Diffuse','SoilFix','D','Soil','Grass','GDiffuse','Panorama','Advert','Glow','BaseColor','Blend1'];
                    for (const ds of diffuseSlots) { if (slots[ds]) { texFile = slots[ds]; break; } }
                }
            }
const blobUrl = texFile
                ? (S.currentBlobUrlMap[texFile] || S.currentBlobUrlMap[texFile.toLowerCase()] || null)
                : null;
            if (blobUrl) {
                const handler = loadingManager.getHandler(texFile) || new THREE.TextureLoader(loadingManager);
                const tex = handler.load(texFile);
                tex.flipY = false;
                // RepeatWrapping comme MTLLoader — sans ça les blocs avec UVs > 1 semblent étirés
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                mat = new THREE.MeshPhongMaterial({ map: tex, color: 0xffffff, name: m.matName, side: THREE.DoubleSide, shininess: 30 });
            } else {
                const r = Math.random();
                mat = new THREE.MeshPhongMaterial({
                    ...defMatBase,
                    color: new THREE.Color(0.5 + r * 0.5, 0.5 + Math.sin(r * 10) * 0.5, 0.5 + Math.cos(r * 10) * 0.5),
                });
            }
        }
        mat.name = m.matName;
        if (WORLDUV_MATERIALS.has(m.matName)) applyWorldUV(mat);
        if (ALPHA_CUTOUT_MATERIALS.has(m.matName) && mat.map) {
            mat.transparent = true; mat.alphaTest = 0.5; mat.depthWrite = true; mat.side = THREE.DoubleSide;
        }
        if (ADDITIVE_GLOW_MATERIALS.has(m.matName) && mat.map) { applyAdditiveGlow(mat); }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = m.name;
        mesh.visible = m.visible;
        mesh.userData.originalMaterialName = m.matName;
        mesh.userData.texFilename = m.texFilename || null;
        if (ADDITIVE_GLOW_MATERIALS.has(m.matName)) mesh.userData.isGlowMesh = true;
        group.add(mesh);
    }
    return group;
}

// Charge un modèle — OBJ + MTL avec textures DDS via URL modifier
// geomKey : clé IDB pour la géométrie binaire (persistante). Vide = pas de cache IDB.
export async function loadModel(objText, mtlText, pakName, cacheKey, geomKey) {
    clearMesh();
    S.importMeshGroups.forEach(g => { g.visible = false; });
    if (S.selectionBox) { _removeSelectionBox(); }
    if (S._blockWireframe) { S._blockWireframe.parent?.remove(S._blockWireframe); S._blockWireframe.geometry?.dispose(); S._blockWireframe.material?.dispose(); S._blockWireframe = null; }
    if (S._blockMatInfoEl) S._blockMatInfoEl.style.display = 'none';
    if (mtlText) {
        const parsed = parseMtlAllTextures(mtlText);
        for (const [k, v] of Object.entries(parsed)) {
            if (!S._matAllTextures[k]) S._matAllTextures[k] = v;
        }
    }

    // 1. Cache mémoire session — skip si objText fourni (MTL corrigé)
    let rawObj = (cacheKey && !objText) ? rawModelCache.get(cacheKey) : null;

    // 2. Cache IDB géométrie binaire — skip si objText fourni
    if (!rawObj && geomKey && !objText) {
        try {
            const idbGeom = await TMNFeditorCache.get(geomKey);
            if (idbGeom?.meshes?.length) {
                rawObj = deserializeRawObj(idbGeom);
                if (cacheKey) rawModelCache.set(cacheKey, rawObj);
            }
        } catch {}
    }

    // 3. Parsing OBJ/MTL (lent — seulement si IDB vide, 1ère session)
    if (!rawObj) {
        const matTexMap = parseMtlTextures(mtlText);
        if (mtlText && mtlText.trim()) {
            const mtlLoader = new MTLLoader(loadingManager);
            const materials = mtlLoader.parse(mtlText, '');
            materials.preload();
            objLoader.setMaterials(materials);
        } else {
            objLoader.setMaterials(null);
        }
        rawObj = objLoader.parse(objText);

        // Flip UV V sur la géométrie partagée (une seule fois)
        rawObj.traverse(child => {
            if (child.isMesh && child.geometry?.attributes?.uv) {
                const uv = child.geometry.attributes.uv;
                for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
                uv.needsUpdate = true;
            }
        });

        // Normales sur la géométrie partagée (une seule fois, si modèle petit)
        let tv = 0;
        rawObj.traverse(c => { if (c.isMesh && c.geometry) tv += c.geometry.attributes.position.count; });
        if (tv < 100000) rawObj.traverse(child => { if (child.isMesh && child.geometry) child.geometry.computeVertexNormals(); });

        if (cacheKey) rawModelCache.set(cacheKey, rawObj);
        // Sauvegarder la géométrie en IDB pour les prochaines sessions
        if (geomKey) TMNFeditorCache.set(geomKey, serializeRawObj(rawObj, matTexMap));
    }

    // Clone pour l'affichage (rawObj reste intact en cache)
    const obj = rawObj.clone(true);
    S.currentMeshCacheKey = cacheKey || null;

    let totalVertices = 0;
    obj.traverse(c => { if (c.isMesh && c.geometry) totalVertices += c.geometry.attributes.position.count; });

    const r = Math.random();
    const defaultMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0.5 + r * 0.5, 0.5 + Math.sin(r * 10) * 0.5, 0.5 + Math.cos(r * 10) * 0.5),
        side: THREE.DoubleSide, flatShading: totalVertices > 100000, shininess: 30,
        userData: { isDefault: true }
    });

    let meshCount = 0;
    obj.traverse(child => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
        if (mats[0]?.name) child.userData.originalMaterialName = mats[0].name;
        const matNameLower = (mats[0]?.name || '').toLowerCase();
        if (HIDDEN_MATERIALS.has(matNameLower)) { child.visible = false; return; }
        if (WATER_MATERIALS.has(matNameLower)) { child.material = getWaterMaterial(); return; }
        if (WORLDUV_MATERIALS.has(matNameLower)) {
            const m = Array.isArray(child.material) ? child.material[0] : child.material;
            if (m) applyWorldUV(m);
        }
        if (Array.isArray(child.material)) {
            child.material = child.material.map(m => {
                if (m?.map) { m.color.set(0xffffff); return m; }
                return defaultMat;
            });
        } else if (child.material?.map) {
            child.material.color.set(0xffffff);
        } else {
            child.material = defaultMat;
        }
        if (ALPHA_CUTOUT_MATERIALS.has(matNameLower) || ADDITIVE_GLOW_MATERIALS.has(matNameLower)) {
            const cmats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of cmats) {
                if (!m?.map) continue;
                if (ADDITIVE_GLOW_MATERIALS.has(matNameLower)) applyAdditiveGlow(m);
                else { m.transparent = true; m.alphaTest = 0.5; m.depthWrite = true; m.side = THREE.DoubleSide; }
            }
        }
        meshCount++;
    });

    if (!obj || obj.children.length === 0) return { vertices: 0, triangles: 0, meshes: 0 };

    S.currentMesh = obj;
    scene.add(S.currentMesh);

    // Centrer la caméra
    const box = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = box.getSize(new THREE.Vector3()).length();
    if (isFinite(size) && size > 0) {
        const dist = size * 2.5;
        scene.fog = new THREE.Fog(0x2a2a3a, Math.max(800, dist * 2) * 0.2, Math.max(800, dist * 2));
        camera.far = Math.max(2000, dist * 3);
        camera.updateProjectionMatrix();
        camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
        camera.lookAt(center);
        controls.target.copy(center);
        controls.update();
    }

    let totalTriangles = 0;
    obj.traverse(c => {
        if (c.isMesh && c.geometry) {
            totalTriangles += c.geometry.index ? c.geometry.index.count / 3 : c.geometry.attributes.position.count / 3;
        }
    });

    return { vertices: totalVertices, triangles: Math.floor(totalTriangles), meshes: meshCount };
}

export function selectMesh(name, materialName) {
    if (S.selectionOutline) { scene.remove(S.selectionOutline); S.selectionOutline.geometry.dispose(); S.selectionOutline.material.dispose(); S.selectionOutline = null; }
    if (!S.currentMesh || !name) return;
    const mesh = findMesh(S.currentMesh, name, materialName);
    if (!mesh || !(mesh instanceof THREE.Mesh) || !mesh.visible) return;
    S.selectedMesh = mesh;
    const wireGeo = new THREE.WireframeGeometry(mesh.geometry);
    const wireMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
    S.selectionOutline = new THREE.LineSegments(wireGeo, wireMat);
    mesh.updateMatrixWorld(true);
    S.selectionOutline.matrix.copy(mesh.matrixWorld);
    S.selectionOutline.matrixAutoUpdate = false;
    scene.add(S.selectionOutline);
}

export function toggleMesh(name, materialName) {
    if (!S.currentMesh) return false;
    const mesh = findMesh(S.currentMesh, name, materialName);
    if (mesh instanceof THREE.Mesh) {
        mesh.visible = !mesh.visible;
        if (!mesh.visible && mesh === S.selectedMesh && S.selectionOutline) {
            scene.remove(S.selectionOutline); S.selectionOutline.geometry.dispose(); S.selectionOutline.material.dispose(); S.selectionOutline = null;
        }
        return mesh.visible;
    }
    return true;
}

// Ajoute un model sur le currentMesh existant sans effacer la scène.
// Utilisé pour EditorHelper/EditorHelperArrow des blocs Checkpoint/Start/Finish.
export async function appendModelToCurrentBlock(objText, mtlText, pakName, cacheKey, geomKey, color) {
    if (!S.currentMesh) return;

    let rawObj = cacheKey ? rawModelCache.get(cacheKey) : null;

    if (!rawObj && geomKey) {
        try {
            const idbGeom = await TMNFeditorCache.get(geomKey);
            if (idbGeom?.meshes?.length) {
                rawObj = deserializeRawObj(idbGeom);
                if (cacheKey) rawModelCache.set(cacheKey, rawObj);
            }
        } catch {}
    }

    if (!rawObj) {
        const matTexMap = parseMtlTextures(mtlText);
        if (mtlText?.trim()) {
            const mtlLoader = new MTLLoader(loadingManager);
            const materials = mtlLoader.parse(mtlText, '');
            materials.preload();
            objLoader.setMaterials(materials);
        } else {
            objLoader.setMaterials(null);
        }
        rawObj = objLoader.parse(objText);

        rawObj.traverse(child => {
            if (child.isMesh && child.geometry?.attributes?.uv) {
                const uv = child.geometry.attributes.uv;
                for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
                uv.needsUpdate = true;
            }
        });

        let tv = 0;
        rawObj.traverse(c => { if (c.isMesh && c.geometry) tv += c.geometry.attributes.position.count; });
        if (tv < 100000) rawObj.traverse(child => { if (child.isMesh && child.geometry) child.geometry.computeVertexNormals(); });

        if (cacheKey) rawModelCache.set(cacheKey, rawObj);
        if (geomKey) TMNFeditorCache.set(geomKey, serializeRawObj(rawObj, matTexMap));
    }

    const obj = rawObj.clone(true);
    const r = Math.random();
    const defMat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0.5 + r * 0.5, 0.5 + Math.sin(r * 10) * 0.5, 0.5 + Math.cos(r * 10) * 0.5),
        side: THREE.DoubleSide, shininess: 30, userData: { isDefault: true }
    });
    obj.traverse(child => {
        if (!child.isMesh) return;
        if (child.material?.name) child.userData.originalMaterialName = child.material.name;
        const mn = (child.material?.name || '').toLowerCase();
        if (HIDDEN_MATERIALS.has(mn)) { child.visible = false; return; }
        if (WATER_MATERIALS.has(mn)) { child.material = getWaterMaterial(); return; }
        if (WORLDUV_MATERIALS.has(mn) && child.material) applyWorldUV(child.material);
        if (child.material?.map) child.material.color.set(0xffffff);
        else child.material = defMat;
        if (ALPHA_CUTOUT_MATERIALS.has(mn) && child.material?.map) {
            child.material.transparent = true; child.material.alphaTest = 0.5;
            child.material.depthWrite = true; child.material.side = THREE.DoubleSide;
        }
        if (ADDITIVE_GLOW_MATERIALS.has(mn) && child.material?.map) applyAdditiveGlow(child.material);
    });

    if (color) {
        const col = new THREE.Color(color);
        obj.traverse(child => {
            if (child.isMesh && child.visible) {
                child.material.color.set(col);
                child.material.map = null;
            }
        });
    }
    S.currentMesh.add(obj);
}

// ─── Map mode ─────────────────────────────────────────────────────────────
export function clearMap() {
    if (S.mapGroup) {
        scene.remove(S.mapGroup);
        S.mapGroup.traverse(c => {
            if (c instanceof THREE.Mesh) {
                c.geometry?.dispose();
                (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m?.dispose());
            }
        });
        S.mapGroup = null;
    }
    S.mapOffset = { ...MAP_OFFSET_DEFAULT };
    for (const m of S.tri3dMeshes) {
        if (m.userData.is2D) overlayScene.remove(m);
        m.geometry?.dispose();
        m.material?.dispose();
    }
    S.tri3dMeshes = [];
    S._tri3dIs2D = [];
}

export function beginMap() {
    clearMap();
    clearMesh();
    S.mapGroup = new THREE.Group();
}

// geomKey : clé IDB pour sauvegarder la géométrie binaire (fire-and-forget, sessions suivantes)
export function addModelToMap(objText, mtlText, pakName, placements, cacheKey, geomKey) {
    if (!S.mapGroup || !placements?.length) return;
    if (mtlText) {
        const parsed = parseMtlAllTextures(mtlText);
        for (const [k, v] of Object.entries(parsed)) {
            if (!S._matAllTextures[k]) S._matAllTextures[k] = v;
        }
    }

    // Cache mémoire session — skip si objText fourni (MTL corrigé)
    let rawObj = (cacheKey && !objText) ? rawModelCache.get(cacheKey) : null;
    if (!rawObj) {
        const matTexMap = parseMtlTextures(mtlText);
        if (mtlText && mtlText.trim()) {
            const mtlLoader = new MTLLoader(loadingManager);
            const materials = mtlLoader.parse(mtlText, '');
            materials.preload();
            objLoader.setMaterials(materials);
        } else {
            objLoader.setMaterials(null);
        }
        rawObj = objLoader.parse(objText);

        rawObj.traverse(child => {
            if (child.isMesh && child.geometry?.attributes?.uv) {
                const uv = child.geometry.attributes.uv;
                for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
                uv.needsUpdate = true;
            }
        });

        let totalVerts = 0;
        rawObj.traverse(c => { if (c.isMesh && c.geometry) totalVerts += c.geometry.attributes.position.count; });
        const r = Math.random();
        const defMat = new THREE.MeshPhongMaterial({
            color: new THREE.Color(0.5 + r * 0.5, 0.5 + Math.sin(r * 10) * 0.5, 0.5 + Math.cos(r * 10) * 0.5),
            side: THREE.DoubleSide, flatShading: totalVerts > 100000, shininess: 30,
            userData: { isDefault: true }
        });
        rawObj.traverse(child => {
            if (child.isMesh) {
                if (child.material?.name) child.userData.originalMaterialName = child.material.name;
                const mn0 = (child.material?.name || '').toLowerCase();
                if (HIDDEN_MATERIALS.has(mn0)) {
                    child.visible = false;
                    return;
                }
                if (child.material?.map) {
                    child.material.color.set(0xffffff);
                } else {
                    child.material = defMat;
                }
                if (ALPHA_CUTOUT_MATERIALS.has(mn0) && child.material?.map) {
                    child.material.transparent = true;
                    child.material.alphaTest = 0.5;
                    child.material.depthWrite = true;
                    child.material.side = THREE.DoubleSide;
                }
                if (ADDITIVE_GLOW_MATERIALS.has(mn0) && child.material?.map) { applyAdditiveGlow(child.material); child.userData.isGlowMesh = true; }
                if (child.geometry && totalVerts < 100000) child.geometry.computeVertexNormals();
            }
        });

        if (cacheKey) rawModelCache.set(cacheKey, rawObj);
        // Sauvegarder la géométrie binaire en IDB pour les prochaines sessions (fire-and-forget)
        if (geomKey) TMNFeditorCache.set(geomKey, serializeRawObj(rawObj, matTexMap));
    }

    const CELL_H = 32, CELL_V = 8;
    const dirToRad = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

    for (const p of placements) {
        const d = (p.dir || 0) & 3;
        const sizeX = (p.sx || 1) * CELL_H;
        const sizeZ = (p.sz || 1) * CELL_H;
        let offX = 0, offZ = 0;
        if      (d === 1) { offX = sizeZ; }
        else if (d === 2) { offX = sizeX; offZ = sizeZ; }
        else if (d === 3) { offZ = sizeX; }
        const clone = rawObj.clone(true);
        clone.position.set(p.x * CELL_H + offX, (p.y - (p.h || 0)) * CELL_V, p.z * CELL_H + offZ);
        clone.rotation.y = dirToRad[d];
        clone.userData.blockName = p.blockName || '';
        clone.userData.terrainAt = p.terrainAt || 'Grass';
        clone.userData.blockPos = { x: p.x, y: p.y, z: p.z };
        if (p.helperType) clone.userData.helperType = p.helperType;
        if (p.isClip) patchClipGroundIfNeeded(clone);
        if (!p.skipTerrainMesh && p.terrainMod) {
            // p.terrainMod absent = aucun terrain modifier détecté à cette position : on ne touche à RIEN,
            // quel que soit le matériau natif du mesh (certains blocks ont du StadiumDirt par défaut, pas du grass).
            // "fabric" = vrai terrain modifier du jeu (unit.TerrainModifierId). "dirt" = colonne (X,Z) où un
            // block StadiumDirt existe à n'importe quelle hauteur (logique TerrainAt fidèle à Aide/BlockLister).
            const remapMat = p.terrainMod === 'dirt' ? 'stadiumdirt' : 'stadiumfabricfloornoocc';
            const fallbackColor = p.terrainMod === 'dirt' ? 0x8a6a3a : 0x5a5a6a;
            const remapTo = (c) => {
                const tex = loadGroundTexture(remapMat);
                c.material = c.material.clone();
                c.material.name = remapMat;
                c.userData.originalMaterialName = remapMat;
                if (tex) { c.material.map = tex; c.material.color.set(0xffffff); }
                else { c.material.map = null; c.material.color.set(fallbackColor); }
                c.material.needsUpdate = true;
            };
            clone.traverse(c => {
                if (!c.isMesh) return;
                const mn = (c.material?.name || '').toLowerCase();
                const isGrassMesh = mn === 'stadiumgrass' || mn === 'stadiumgrassocc' || mn === 'stadiumsculptgrassocc';
                const isDirtMesh = mn === 'stadiumdirt';
                const needsChange = p.terrainMod === 'dirt' ? isGrassMesh : (isGrassMesh || isDirtMesh);
                if (!needsChange) return;

                // Si le mesh est déjà le bon matériau pour ce terrain, on ne touche à rien. Sinon on remplace.
                remapTo(c);
            });
        }
        if (p.color) {
            const col = new THREE.Color(p.color);
            clone.traverse(child => {
                if (child.isMesh) {
                    child.material = child.material.clone();
                    child.material.color.set(col);
                    child.material.map = null;
                }
            });
        }
        S.mapGroup.add(clone);
    }
}

// grassCells/dirtCells/fabricCells : listes explicites calculées côté C# (fidèle à BlockLister [Reconstitue])
// nonZoneColumns : colonnes occupées par un bloc réel → empêche les zone faces de se superposer
export function finalizeMap(grassCells, dirtCells, fabricCells, zoneFaces, nonZoneColumns) {
    if (!S.mapGroup) return;
    S.mapGroup.position.set(S.mapOffset.x, S.mapOffset.y, S.mapOffset.z);
    scene.add(S.mapGroup);

    const box = new THREE.Box3().setFromObject(S.mapGroup);
    const center = new THREE.Vector3(); box.getCenter(center);
    const size = box.getSize(new THREE.Vector3()).length();
    if (!isFinite(size) || size === 0) return;

    camera.far = Math.max(2000, size * 3);
    scene.fog = new THREE.Fog(0x2a2a3a, size * 0.6, size * 2);
    camera.updateProjectionMatrix();
    camera.position.set(center.x + size * 0.7, center.y + size * 0.5, center.z + size * 0.7);
    camera.lookAt(center); controls.target.copy(center); controls.update();

    const CELL_H = 32, CELL_V = 8;

    function createGroundMesh(cells, matName, fallbackColor) {
        if (!cells?.length) return;
        const tex = loadGroundTexture(matName);
        const mat = new THREE.MeshPhongMaterial({
            name: matName,
            color: tex ? 0xffffff : fallbackColor,
            map: tex || null,
            shininess: 30,
        });
        const planeGeo = new THREE.PlaneGeometry(CELL_H, CELL_H);
        planeGeo.rotateX(-Math.PI / 2);
        const mesh = new THREE.InstancedMesh(planeGeo, mat, cells.length);
        mesh.frustumCulled = false;
        mesh.userData.isTerrainTile = true;
        mesh.userData.originalMaterialName = matName;
        const dummy = new THREE.Object3D();
        cells.forEach((c, i) => {
            dummy.position.set(c.x * CELL_H + CELL_H / 2, 9, c.z * CELL_H + CELL_H / 2);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        S.mapGroup.add(mesh);
    }

    createGroundMesh(grassCells,  'stadiumgrass',            0x4a7a3a);
    createGroundMesh(dirtCells,   'stadiumdirt',             0x8a6a3a);
    createGroundMesh(fabricCells, 'stadiumfabricfloornoocc', 0x5a5a6a);

    // Zone faces : StadiumDirt/StadiumGrass placés en hauteur (ex: au sommet des collines)
    const nonZoneSet = new Set((nonZoneColumns || []).map(c => `${c.x},${c.z}`));
    const zfByType = {};
    for (const zf of (zoneFaces || [])) {
        if (nonZoneSet.has(`${zf.x},${zf.z}`)) continue;
        const key = zf.type || 'grass';
        if (!zfByType[key]) zfByType[key] = [];
        zfByType[key].push(zf);
    }
    for (const [type, faces] of Object.entries(zfByType)) {
        if (faces.length === 0) continue;
        const matName = type === 'dirt' ? 'stadiumdirt' : type === 'fabric' ? 'stadiumfabricfloornoocc' : 'stadiumgrass';
        const fallback = type === 'dirt' ? 0x8a6a3a : type === 'fabric' ? 0x5a5a6a : 0x4a7a3a;
        const tex = loadGroundTexture(matName);
        const mat = new THREE.MeshPhongMaterial({ name: matName, color: tex ? 0xffffff : fallback, map: tex || null, shininess: 30 });
        const geo = new THREE.PlaneGeometry(CELL_H, CELL_H);
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.InstancedMesh(geo, mat, faces.length);
        mesh.frustumCulled = false;
        mesh.userData.isTerrainTile = true;
        mesh.userData.originalMaterialName = matName;
        const dummy = new THREE.Object3D();
        faces.forEach((zf, i) => {
            dummy.position.set(zf.x * CELL_H + CELL_H / 2, 9 + zf.y * CELL_V, zf.z * CELL_H + CELL_H / 2);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        S.mapGroup.add(mesh);
    }
}

export function setMapOffset(x, y, z) {
    S.mapOffset.x = x; S.mapOffset.y = y; S.mapOffset.z = z;
    if (S.mapGroup) S.mapGroup.position.set(x, y, z);
}

export function setRenderSettings(showEditorHelper, showEditorHelperArrow, showGlow) {
    if (!S.mapGroup) return;
    S.mapGroup.traverse(c => {
        if (c.userData.helperType === 'helper') c.visible = showEditorHelper;
        else if (c.userData.helperType === 'arrow') c.visible = showEditorHelperArrow;
        if (c.userData.isGlowMesh) c.visible = showGlow;
    });
}

// Charge en parallèle la géométrie binaire depuis IDB et peuple rawModelCache.
// Retourne bool[] : true si l'entrée était dans IDB (rawModelCache maintenant prêt).
// À appeler APRÈS setBlobUrlMap (pour que deserializeRawObj trouve les blob URLs).
export async function populateRawModelCacheFromIDB(entries) {
    return Promise.all(entries.map(async e => {
        if (rawModelCache.has(e.cacheKey)) return true;
        try {
            const cached = await TMNFeditorCache.get(e.geomKey);
            if (!cached?.meshes?.length) return false;
            rawModelCache.set(e.cacheKey, deserializeRawObj(cached));
            return true;
        } catch { return false; }
    }));
}

// Enregistre le mapping {filename.dds → blobUrl} pour que DDSLoader charge les textures via blob
export function setBlobUrlMap(blobUrlMap) {
    S.currentBlobUrlMap = blobUrlMap || {};
    if (blobUrlMap && Object.keys(blobUrlMap).length > 0) {
        loadingManager.setURLModifier(url => {
            const filename = url.split('/').pop().split('\\').pop();
            return blobUrlMap[filename] || url;
        });
    } else {
        loadingManager.setURLModifier(null);
    }
}

// Vide le cache d'objets THREE.js (à appeler au changement de dossier de jeu)
export function clearModelCache() {
    for (const rawObj of rawModelCache.values()) {
        rawObj.traverse(c => {
            if (c instanceof THREE.Mesh) {
                c.geometry?.dispose();
                if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                else c.material?.dispose();
            }
        });
    }
    rawModelCache.clear();
}
