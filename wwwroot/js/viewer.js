import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import {
    S, scene, camera, renderer, controls,
    overlayScene, overlayCam, _updateOverlayCam, _createGridCross,
} from './state.js';
import {
    _getTri3DAvgColor,
} from './materials.js';
import {
    _removeSelectionBox, _getImportGroup, _getActiveObject,
    clearMesh, downloadFile, downloadFileBytes,
} from './helpers.js';
import {
    playbackStartAll, playbackPause, playbackSeek,
} from './playback.js';
import {
    loadModel, addModelToMap, appendModelToCurrentBlock,
    clearMap, beginMap, finalizeMap, setMapOffset, setRenderSettings,
    populateRawModelCacheFromIDB, setBlobUrlMap, clearModelCache,
    selectMesh, toggleMesh,
} from './mapLoader.js';
import {
    clearTri3DKeyframes, clearTriangles3D, addTriangles3D,
    setTri3DVisible, setTri3DPosition, selectTri3DMesh,
    getTri3DTransform,
} from './triangles.js';
import {
    sendImportToMainScene, _sendImport2D,
    getActiveImportExportData, getImportExportDataByIndex, getImportMaterialsByIndex,
    selectImportMesh, setImportVisibleByIndex, setImportVisible, setImportPosition,
    setImportMaterialColor, resetImportMaterials, setImportOrigin, centerImportOrigin,
    mirrorImport, removeImportModel, removeText3D,
    switchImportTab,
} from './importExport.js';
import {
    createText3D, createText2D, selectText3D, updateText3D,
} from './textEditor.js';
import { importPrev } from './importPreview.js';
import {
    showBlockView, showTrianglesView, setTransformMode, setOriginDotVisible,
    handlePointerUp,
} from './viewModes.js';
import './cache.js';

// ─── Blur panels (outside tick-mark zone in 2D mode) ─────────────────────────
function _updateBlurPanels(visible) {
    if (!S._blurLeft || !S._blurRight) return;
    if (!visible) {
        S._blurLeft.style.display = 'none';
        S._blurRight.style.display = 'none';
        return;
    }
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const aspect = w / h;
    const pct = Math.max(0, (aspect - 1) / (2 * aspect) * 100).toFixed(2) + '%';
    S._blurLeft.style.width = pct;
    S._blurRight.style.width = pct;
    S._blurLeft.style.display = 'block';
    S._blurRight.style.display = 'block';
}

// ─── Init — attaché au conteneur DOM passé par Blazor ────────────────────────
window.TMNFeditorScene = {
    init(container, dotNetRef) {
        if (!container) return;
        if (dotNetRef) S.mainDotNetRef = dotNetRef;
        const w = container.clientWidth || window.innerWidth - 350;
        const h = container.clientHeight || window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        _updateOverlayCam();
        container.appendChild(renderer.domElement);

        S._gridCursorEl = document.createElement('div');
        S._gridCursorEl.id = 'grid-cursor-pos';
        S._gridCursorEl.style.cssText = 'position:absolute;top:8px;right:8px;color:#4c4;font-size:12px;font-family:monospace;pointer-events:none;display:none;z-index:5;text-shadow:0 0 3px #000;';
        container.appendChild(S._gridCursorEl);

        S._blockMatInfoEl = document.createElement('div');
        S._blockMatInfoEl.className = 'block-mat-info';
        S._blockMatInfoEl.style.display = 'none';
        container.appendChild(S._blockMatInfoEl);

        S._blurLeft = document.createElement('div');
        S._blurLeft.style.cssText = 'position:absolute;top:0;bottom:0;left:0;display:none;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);background:rgba(0,0,0,0.18);pointer-events:none;z-index:4;';
        container.appendChild(S._blurLeft);
        S._blurRight = document.createElement('div');
        S._blurRight.style.cssText = 'position:absolute;top:0;bottom:0;right:0;display:none;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);background:rgba(0,0,0,0.18);pointer-events:none;z-index:4;';
        container.appendChild(S._blurRight);

        renderer.domElement.addEventListener('mousemove', e => {
            if (!S._gridVisible || !S._gridCursorEl) return;
            const rect = renderer.domElement.getBoundingClientRect();
            const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
            const gx = ndcX * overlayCam.right;
            const gy = ndcY;
            S._gridCursorEl.textContent = `X: ${gx.toFixed(2)}  Y: ${gy.toFixed(2)}`;
        });

        const _doResize = () => {
            const nw = container.clientWidth;
            const nh = container.clientHeight;
            if (nw <= 0 || nh <= 0) return;
            camera.aspect = nw / nh;
            camera.updateProjectionMatrix();
            renderer.setSize(nw, nh);
            _updateOverlayCam();
            if (S._gridVisible) _updateBlurPanels(true);
        };
        window.addEventListener('resize', _doResize);
        new ResizeObserver(_doResize).observe(container);

        S.transformCtrl = new TransformControls(camera, renderer.domElement);
        S.transformCtrl.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
        scene.add(S.transformCtrl);

        S.transformCtrl2D = new TransformControls(overlayCam, renderer.domElement);
        S.transformCtrl2D.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
        S.transformCtrl2D.showX = true;
        S.transformCtrl2D.showY = true;
        S.transformCtrl2D.showZ = false;
        S.transformCtrl2D.size = 0.4;
        S.transformCtrl2D.enabled = false;
        overlayScene.add(S.transformCtrl2D);

        // Push position en direct (throttle 50 ms pour limiter les appels interop)
        let _posTimer = null;
        function _pushPosition() {
            const g = _getImportGroup();
            if (!g || !S.mainDotNetRef) return;
            const is2D = S.importMeshGroups.has(`2d_${S.activeImportIdx}`);
            if (is2D) {
                const sc = g.userData._2dScale || 1;
                S.mainDotNetRef.invokeMethodAsync('OnImportPositionChanged', g.position.x / sc, 0, g.position.y / sc);
            } else
                S.mainDotNetRef.invokeMethodAsync('OnImportPositionChanged', g.position.x, g.position.y, g.position.z);
        }
        function _pushTri3DPosition() {
            const obj = S.transformCtrl?.object;
            if (!obj || !S.mainDotNetRef) return;
            const idx = S.tri3dMeshes.indexOf(obj);
            if (idx >= 0) {
                const init = obj.userData.tri3dInitPos || { x: 0, y: 0, z: 0 };
                S.mainDotNetRef.invokeMethodAsync('OnTri3DPositionChanged',
                    obj.position.x - init.x, obj.position.y - init.y, obj.position.z - init.z);
            }
        }
        S.transformCtrl.addEventListener('objectChange', () => {
            if (_posTimer) return;
            _posTimer = setTimeout(() => {
                _posTimer = null;
                const obj = S.transformCtrl?.object;
                if (obj && S.tri3dMeshes.includes(obj)) _pushTri3DPosition();
                else _pushPosition();
            }, 50);
        });
        S.transformCtrl2D.addEventListener('objectChange', () => {
            if (_posTimer) return;
            _posTimer = setTimeout(() => {
                _posTimer = null;
                _pushPosition();
            }, 50);
        });
        window._pushImportPosition = _pushPosition;

        // Push liste de matériaux du modèle actif vers Blazor
        function _pushMaterials() {
            const active = _getImportGroup();
            if (!active || !S.mainDotNetRef) return;
            const seen = new Set();
            const result = [];
            const pushMesh = (mesh) => {
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                mats.forEach(m => {
                    if (!m || seen.has(m.uuid)) return;
                    seen.add(m.uuid);
                    const hex = m.vertexColors ? _getTri3DAvgColor(mesh) : '#' + (m.color?.getHexString() ?? 'ffffff');
                    result.push({ key: m.uuid, name: m.vertexColors ? 'Vertex Colors' : (m.name || '(sans nom)'), hex });
                });
            };
            if (active.isMesh) {
                pushMesh(active);
            } else {
                active.traverse(child => { if (child.isMesh) pushMesh(child); });
            }
            S.mainDotNetRef.invokeMethodAsync('OnImportMaterialsChanged', result);
        }
        window._pushImportMaterials = _pushMaterials;

        function _pushOrigin() {
            if (!S.mainDotNetRef) return;
            const o = S.importOriginOffsets.get(S.activeImportIdx) ?? new THREE.Vector3();
            S.mainDotNetRef.invokeMethodAsync('OnImportOriginChanged', o.x, o.y, o.z);
        }
        window._pushImportOrigin = _pushOrigin;

        // Sélection d'un modèle importé au clic dans le grand rendu
        const _ray = new THREE.Raycaster();
        const _rm  = new THREE.Vector2();
        let _rdx = 0, _rdy = 0;

        function _setSelectionBox(group) {
            _removeSelectionBox();
            if (!group) return;
            S.selectionBox = new THREE.BoxHelper(group, 0x4488ff);
            S.selectionBox.material.transparent = true;
            S.selectionBox.material.opacity = 0.35;
            S.selectionBox.material.linewidth = 1;
            scene.add(S.selectionBox);
        }

        renderer.domElement.addEventListener('pointerdown', e => { _rdx = e.clientX; _rdy = e.clientY; });
        renderer.domElement.addEventListener('pointerup', e => {
            handlePointerUp(e, _rdx, _rdy, _ray, _rm, camera, _setSelectionBox);
        });

        (function animate() {
            requestAnimationFrame(animate);
            controls.update();
            if (S._waterMaterial) S._waterMaterial.uniforms.camPos.value.copy(camera.position);
            if (S.selectionBox?.update) S.selectionBox.update();
            if (S.originDot && S._originDotVisible) {
                const _og = _getActiveObject();
                if (_og) {
                    _og.getWorldPosition(S.originDot.position);
                    const is2D = _og.userData?.is2D || S.importMeshGroups.has(`2d_${S.activeImportIdx}`);
                    if (is2D) {
                        S.originDot.scale.setScalar(0.02);
                    } else {
                        const _d = camera.position.distanceTo(S.originDot.position);
                        S.originDot.scale.setScalar(_d * 0.02);
                    }
                }
            }
            renderer.render(scene, camera);
            if (overlayScene.children.some(c => c.visible)) {
                renderer.autoClear = false;
                renderer.clearDepth();
                renderer.render(overlayScene, overlayCam);
                renderer.autoClear = true;
            }
        })();
    },

    // ─── Map / model loading (mapLoader.js) ─────────────────────────────────
    setBlobUrlMap(blobUrlMap) { setBlobUrlMap(blobUrlMap); },
    loadModel(objText, mtlText, pakName, cacheKey, geomKey) { return loadModel(objText, mtlText, pakName, cacheKey, geomKey); },
    selectMesh(name, materialName) { selectMesh(name, materialName); },
    toggleMesh(name, materialName) { return toggleMesh(name, materialName); },
    appendModelToCurrentBlock(objText, mtlText, pakName, cacheKey, geomKey, color) { return appendModelToCurrentBlock(objText, mtlText, pakName, cacheKey, geomKey, color); },
    clearMap() { clearMap(); },
    beginMap() { beginMap(); },
    addModelToMap(objText, mtlText, pakName, placements, cacheKey, geomKey) { addModelToMap(objText, mtlText, pakName, placements, cacheKey, geomKey); },
    finalizeMap(grassCells, dirtCells, fabricCells, zoneFaces, nonZoneColumns) { finalizeMap(grassCells, dirtCells, fabricCells, zoneFaces, nonZoneColumns); },
    setMapOffset(x, y, z) { setMapOffset(x, y, z); },
    setRenderSettings(showEditorHelper, showEditorHelperArrow, showGlow) { setRenderSettings(showEditorHelper, showEditorHelperArrow, showGlow); },
    populateRawModelCacheFromIDB(entries) { return populateRawModelCacheFromIDB(entries); },
    clearModelCache() { clearModelCache(); },

    clearScene() { clearMesh(); },

    // ─── Import Preview ───────────────────────────────────────────────────────
    initImportPreview(canvasId)        { importPrev.init(canvasId); },
    initImportDropZone(zoneId, ref)    { S.mainDotNetRef = ref; importPrev.initDropZone(zoneId, ref); },
    initImportFileInput(inputId)       { importPrev.initFileInput(inputId); },
    toggleGridOverlay(visible) {
        if (!S._gridCross) S._gridCross = _createGridCross();
        S._gridCross.visible = visible;
        S._gridVisible = visible;
        if (S._gridCursorEl) S._gridCursorEl.style.display = visible ? '' : 'none';
        _updateBlurPanels(visible);
    },

    updateMaterialSlots(slots) {
        for (const [matName, texMap] of Object.entries(slots)) {
            S._matAllTextures[matName.toLowerCase()] = texMap;
        }
    },

    setImportTopView(on) {
        importPrev.setTopView(on);
        const modeActive = importPrev.getModeActiveIdx?.() ?? 0;
        switchImportTab(modeActive, on);
        if (!on) {
            if (S._gridCross) S._gridCross.visible = false;
            S._gridVisible = false;
            if (S._gridCursorEl) S._gridCursorEl.style.display = 'none';
            _updateBlurPanels(false);
        }
    },
    triggerFileInput(inputId) { document.getElementById(inputId)?.click(); },
    switchImportTab(idx, is2D) { switchImportTab(idx, is2D); },

    showBlockView() { showBlockView(); },
    showTrianglesView() { showTrianglesView(); },
    setTransformMode(mode) { setTransformMode(mode); },
    setOriginDotVisible(visible) { setOriginDotVisible(visible); },

    // ─── Import / Export (importExport.js) ──────────────────────────────────
    mirrorImport() { mirrorImport(); },
    centerImportOrigin() { centerImportOrigin(); },
    setImportOrigin(x, y, z) { setImportOrigin(x, y, z); },
    setImportMaterialColor(uuid, hexColor) { setImportMaterialColor(uuid, hexColor); },
    resetImportMaterials() { resetImportMaterials(); },
    setImportPosition(x, y, z) { setImportPosition(x, y, z); },
    setImportVisible(visible) { setImportVisible(visible); },
    setImportVisibleByIndex(idx, visible, is2D) { setImportVisibleByIndex(idx, visible, is2D ?? false); },
    sendImportToMainScene(idx, is2D = false) { return sendImportToMainScene(idx, is2D); },
    _sendImport2D(idx) { return _sendImport2D(idx); },
    selectImportMesh(idx, is2D) { selectImportMesh(idx, is2D ?? false); },
    getActiveImportExportData() { return getActiveImportExportData(); },
    getImportExportDataByIndex(idx, forceIs2D) { return getImportExportDataByIndex(idx, forceIs2D ?? null); },
    getImportMaterialsByIndex(idx, forceIs2D) { return getImportMaterialsByIndex(idx, forceIs2D ?? null); },
    removeImportModel(idx) { return removeImportModel(idx); },
    removeText3D(idx) { removeText3D(idx); },

    // ─── Triangles3D MediaTracker (triangles.js) ────────────────────────────
    clearTri3DKeyframes(index) { clearTri3DKeyframes(index); },
    clearTriangles3D() { clearTriangles3D(); },
    addTriangles3D(blocks) { addTriangles3D(blocks); },
    setTri3DVisible(index, visible) { setTri3DVisible(index, visible); },
    setTri3DPosition(index, x, y, z) { setTri3DPosition(index, x, y, z); },
    selectTri3DMesh(index) { selectTri3DMesh(index); },
    getTri3DTransform(index) { return getTri3DTransform(index); },

    // ─── Playback (playback.js) ─────────────────────────────────────────────
    playbackStartAll(allAnims, repeat) { playbackStartAll(allAnims, repeat); },
    playbackPause() { playbackPause(); },
    playbackSeek(time) { playbackSeek(time); },

    // ─── Text editor (textEditor.js) ────────────────────────────────────────
    createText3D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
        return createText3D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike);
    },
    createText2D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
        return createText2D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike);
    },
    selectText3D(idx) { selectText3D(idx); },
    updateText3D(idx, text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
        return updateText3D(idx, text, fontName, thickness, letterSpacing, bold, italic, underline, strike);
    },

    setBlockSelectMode(on) { S._blockSelectMode = on; },

    // ─── Downloads (helpers.js) ─────────────────────────────────────────────
    downloadFile(filename, content) { downloadFile(filename, content); },
    downloadFileBytes(filename, base64) { downloadFileBytes(filename, base64); },

    scanBlockUnits() {
        if (!S.mainDotNetRef) { console.log('Ouvrez le site d\'abord'); return; }
        console.log('Scan des BlockInfo... (peut prendre 1-2 min)');
        S.mainDotNetRef.invokeMethodAsync('ScanBlockUnits').then(json => {
            console.log('Scan terminé! Téléchargement...');
            downloadFile('Stadium_block_units.json', json);
        });
    },
};
