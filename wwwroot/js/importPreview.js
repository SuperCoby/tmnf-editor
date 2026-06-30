import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

// ─── Import Preview (mini scène isolée, multi-modèles) ───────────────────────
export const importPrev = (() => {
    let rend2 = null, scene2 = null, cam2 = null, ctrl2 = null;
    let dotNetRef = null;
    // models[i] = { group: THREE.Group, camPos: Vector3, camTarget: Vector3, camNear, camFar }
    const models = [];
    let activeIdx = -1;

    function fitCanvas() {
        if (!rend2) return;
        const parent = rend2.domElement.parentElement;
        if (!parent) return;
        const w = parent.clientWidth, h = parent.clientHeight;
        if (!w || !h) return;
        rend2.setSize(w, h, false);
        cam2.aspect = w / h;
        cam2.updateProjectionMatrix();
    }

    function init(canvasId) {
        if (rend2) return;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        scene2 = new THREE.Scene();
        scene2.background = new THREE.Color(0x1e1e2e);

        rend2 = new THREE.WebGLRenderer({ canvas, antialias: true });
        rend2.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        cam2 = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
        cam2.position.set(14, 10, 14);

        ctrl2 = new OrbitControls(cam2, canvas);
        ctrl2.enableDamping = true;
        ctrl2.dampingFactor = 0.08;

        scene2.add(new THREE.AmbientLight(0xffffff, 0.9));
        const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
        dl1.position.set(5, 8, 5); scene2.add(dl1);
        const dl2 = new THREE.DirectionalLight(0xffffff, 0.5);
        dl2.position.set(-4, -2, -5); scene2.add(dl2);
        const dl3 = new THREE.DirectionalLight(0xffffff, 0.3);
        dl3.position.set(0, -5, 5); scene2.add(dl3);
        scene2.add(new THREE.GridHelper(20, 20, 0x2a2a44, 0x181828));

        new ResizeObserver(fitCanvas).observe(canvas.parentElement);
        fitCanvas();

        (function loop() { requestAnimationFrame(loop); ctrl2.update(); rend2.render(scene2, cam2); })();
    }

    function setActive(idx) {
        models.forEach((m, i) => { m.group.visible = (i === idx && m.is2D === _topView); });
        activeIdx = idx;
        if (idx < 0 || idx >= models.length) return;
        if (models[idx].is2D !== _topView) return;
        const { camPos, camTarget, camNear, camFar } = models[idx];
        cam2.near = camNear; cam2.far = camFar;
        cam2.position.copy(camPos);
        cam2.updateProjectionMatrix();
        ctrl2.target.copy(camTarget);
        ctrl2.update();
    }

    let _topView = false;
    function setTopView(on) {
        _topView = on;
        if (!cam2 || !ctrl2) return;
        models.forEach(m => { m.group.visible = false; });
        if (on) {
            cam2.up.set(0, 0, -1);
            ctrl2.enableRotate = false;
            const idx2d = models.findIndex(m => m.is2D);
            if (idx2d >= 0) {
                activeIdx = idx2d;
                models[idx2d].group.visible = true;
                const t = models[idx2d].camTarget;
                const d = models[idx2d].camFar * 0.01 || 20;
                cam2.position.set(t.x, t.y + d, t.z);
                cam2.near = models[idx2d].camNear;
                cam2.far = models[idx2d].camFar;
                ctrl2.target.copy(t);
            } else {
                cam2.position.set(0, 20, 0);
                ctrl2.target.set(0, 0, 0);
            }
            cam2.updateProjectionMatrix();
            ctrl2.update();
        } else {
            cam2.up.set(0, 1, 0);
            ctrl2.enableRotate = true;
            const idx3d = models.findIndex(m => !m.is2D);
            if (idx3d >= 0) {
                setActive(idx3d);
            } else {
                cam2.position.set(14, 10, 14);
                ctrl2.target.set(0, 0, 0);
                cam2.updateProjectionMatrix();
                ctrl2.update();
            }
        }
        const modeModels = models.filter(m => m.is2D === _topView);
        const modeActive = modeModels.length > 0 ? modeModels.length - 1 : 0;
        if (dotNetRef) dotNetRef.invokeMethodAsync('OnModelImported', modeModels.length, modeActive);
    }

    function switchTab(idx) {
        if (!scene2) return;
        const filtered = models.map((m, i) => ({ m, i })).filter(x => x.m.is2D === _topView);
        if (idx >= 0 && idx < filtered.length) {
            setActive(filtered[idx].i);
            if (_topView) {
                const t = models[filtered[idx].i].camTarget;
                const d = cam2.position.distanceTo(ctrl2.target) || 20;
                cam2.position.set(t.x, t.y + d, t.z);
                cam2.up.set(0, 0, -1);
                ctrl2.target.copy(t);
                ctrl2.enableRotate = false;
                ctrl2.update();
            }
        }
    }

    async function addModel(objText, mtlText) {
        if (!scene2) return;

        let materials = null;
        if (mtlText?.trim()) {
            const ml = new MTLLoader();
            materials = ml.parse(mtlText, '');
            materials.preload();
        }
        const ol = new OBJLoader();
        if (materials) ol.setMaterials(materials);
        const group = ol.parse(objText);

        const r = Math.random();
        const defMat = new THREE.MeshPhongMaterial({
            color: new THREE.Color(0.4 + r * 0.5, 0.35 + Math.abs(Math.sin(r * 8)) * 0.4, 0.45 + Math.abs(Math.cos(r * 8)) * 0.4),
            side: THREE.DoubleSide, shininess: 40
        });
        group.traverse(c => {
            if (!c.isMesh) return;
            const fixMat = m => { if (!m) return defMat; if (m.map) m.color?.set(0xffffff); return m; };
            if (Array.isArray(c.material)) c.material = materials ? c.material.map(fixMat) : c.material.map(() => defMat);
            else c.material = materials ? fixMat(c.material) : defMat;
        });

        const box    = new THREE.Box3().setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.01);

        const TARGET = 4;
        const scale  = TARGET / maxDim;
        group.scale.setScalar(scale);
        group.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

        group.visible = false;
        scene2.add(group);

        const dist = TARGET * 1.6;
        models.push({
            group,
            objText,
            mtlText: mtlText ?? '',
            is2D: _topView,
            camPos:    new THREE.Vector3(dist * 0.8, dist * 0.5, dist),
            camTarget: new THREE.Vector3(0, 0, 0),
            camNear:   TARGET * 0.001,
            camFar:    TARGET * 200,
        });

        setActive(models.length - 1);
        if (_topView) setTopView(true);

        const hint = document.getElementById('import-drop-hint');
        if (hint) hint.style.display = 'none';

        const modeCount = models.filter(m => m.is2D === _topView).length;
        if (dotNetRef) await dotNetRef.invokeMethodAsync('OnModelImported', modeCount, modeCount - 1);
    }

    const readText = f => new Promise((res, rej) => {
        const rd = new FileReader(); rd.onload = e => res(e.target.result); rd.onerror = rej; rd.readAsText(f);
    });

    async function handleFiles(files) {
        const arr  = Array.from(files);
        const objs = arr.filter(f => f.name.toLowerCase().endsWith('.obj'));
        const mtls = arr.filter(f => f.name.toLowerCase().endsWith('.mtl'));
        if (!objs.length) return;
        for (const objFile of objs) {
            const base    = objFile.name.slice(0, -4).toLowerCase();
            const mtlFile = mtls.find(f => f.name.slice(0, -4).toLowerCase() === base)
                         ?? (mtls.length === 1 ? mtls[0] : null);
            await addModel(await readText(objFile), mtlFile ? await readText(mtlFile) : null);
        }
    }

    function initDropZone(zoneId, ref) {
        dotNetRef = ref;
        const zone = document.getElementById(zoneId);
        if (!zone) return;
        const onDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; zone.classList.add('drag-over'); };
        const onDragLeave = e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); };
        const onDrop = async e => { e.preventDefault(); zone.classList.remove('drag-over'); await handleFiles(e.dataTransfer.files); };
        zone.addEventListener('dragover', onDragOver);
        zone.addEventListener('dragleave', onDragLeave);
        zone.addEventListener('drop', onDrop);
        const canvas = zone.querySelector('canvas');
        if (canvas) {
            canvas.addEventListener('dragover', e => { e.stopPropagation(); onDragOver(e); });
            canvas.addEventListener('dragleave', e => { e.stopPropagation(); onDragLeave(e); });
            canvas.addEventListener('drop', e => { e.stopPropagation(); onDrop(e); });
        }
    }

    function initFileInput(inputId) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.addEventListener('change', async e => { await handleFiles(e.target.files); e.target.value = ''; });
    }

    function _toGlobalIdx(idx) {
        const filtered = models.map((m, i) => ({ m, i })).filter(x => x.m.is2D === _topView);
        return (idx >= 0 && idx < filtered.length) ? filtered[idx].i : -1;
    }

    function getModelData(idx) {
        const gi = _toGlobalIdx(idx);
        if (gi >= 0) return { objText: models[gi].objText, mtlText: models[gi].mtlText };
        const otherFiltered = models.map((m, i) => ({ m, i })).filter(x => x.m.is2D !== _topView);
        if (idx >= 0 && idx < otherFiltered.length)
            return { objText: models[otherFiltered[idx].i].objText, mtlText: models[otherFiltered[idx].i].mtlText };
        return null;
    }

    function removeModel(idx) {
        const gi = _toGlobalIdx(idx);
        if (gi < 0) return models.filter(mm => mm.is2D === _topView).length;
        const m = models[gi];
        if (m.group) {
            m.group.traverse(c => {
                if (c instanceof THREE.Mesh) {
                    c.geometry?.dispose();
                    if (Array.isArray(c.material)) c.material.forEach(mt => mt.dispose());
                    else c.material?.dispose();
                }
            });
            scene2.remove(m.group);
        }
        models.splice(gi, 1);
        const modeModels = models.filter(mm => mm.is2D === _topView);
        const newCount = modeModels.length;
        if (newCount > 0) {
            const nextGi = models.findIndex(mm => mm.is2D === _topView);
            setActive(nextGi);
            if (_topView) setTopView(true);
        } else {
            activeIdx = -1;
            models.forEach(mm => { mm.group.visible = false; });
            const hint = document.getElementById('import-drop-hint');
            if (hint) hint.style.display = '';
        }
        return newCount;
    }

    function getModeActiveIdx() {
        const filtered = models.filter(m => m.is2D === _topView);
        const gi = activeIdx >= 0 && activeIdx < models.length ? activeIdx : -1;
        if (gi < 0) return 0;
        const fi = filtered.findIndex(m => m === models[gi]);
        return fi >= 0 ? fi : 0;
    }

    return { init, initDropZone, initFileInput, switchTab, getModelData, setTopView, addModel, removeModel, getModeActiveIdx };
})();
