import * as THREE from 'three';
import { OrbitControls }    from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { Font, FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

// ─── Suppress duplicate texture warnings from Three.js ───────────────────────
const _warnedTextures = new Set();
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
    const msg = args.join(' ');
    if (msg.includes('404') || msg.includes('texture') || msg.includes('.dds') || msg.includes('ResponseURL')) {
        if (_warnedTextures.has(msg)) return;
        _warnedTextures.add(msg);
    }
    _origWarn(...args);
};

// ─── Scene ────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a3a);
scene.fog = new THREE.Fog(0x2a2a3a, 200, 800);

const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
camera.position.set(50, 50, 50);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight1.position.set(50, 100, 50); dirLight1.castShadow = true; scene.add(dirLight1);
const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight2.position.set(-50, 50, -50); scene.add(dirLight2);
scene.add(new THREE.GridHelper(1024, 32, 0x444444, 0x222222));
scene.add(new THREE.AxesHelper(30));

// ─── State ────────────────────────────────────────────────────────────────────
let currentMesh = null;
let currentMeshCacheKey = null;  // non-null si currentMesh est un clone de rawModelCache
let importMeshGroups = new Map(); // tabIdx → THREE.Group (modèles importés, persistent dans la scène)
let activeImportIdx  = 0;        // onglet actif pour les outils (translate/rotate/scale/mirror/visible)
let mainDotNetRef    = null;     // référence C# pour callbacks JS→Blazor (sélection, import...)
let selectionBox     = null;     // BoxHelper discret autour du modèle importé sélectionné
let originDot        = null;     // sphère jaune transparente au point d'origine
let _originDotVisible = false;
let _currentTransformMode = 'none'; // mode actif ('translate'|'rotate'|'scale'|'none')
let importOriginOffsets = new Map(); // tabIdx → THREE.Vector3 (offset pivot courant)
let tri3dMeshes = [];                // tableau de THREE.Mesh pour les Triangles3D MediaTracker
let _tri3dIs2D = [];                 // true/false par index: est-ce un Triangles2D (overlay)
const overlayScene = new THREE.Scene();
const overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
overlayCam.position.set(0, 0, 2);
function _updateOverlayCam() {
    if (!renderer) return;
    const s = renderer.getSize(new THREE.Vector2());
    const aspect = s.x / s.y;
    overlayCam.left = -aspect;
    overlayCam.right = aspect;
    overlayCam.top = 1;
    overlayCam.bottom = -1;
    overlayCam.updateProjectionMatrix();
}
let _gridCross = null;
let _gridCursorEl = null;
let _gridVisible = false;
function _createGridCross() {
    const mat = new THREE.LineBasicMaterial({ color: 0x888888, depthTest: false });
    const group = new THREE.Group();
    const hGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-10, 0, 0), new THREE.Vector3(10, 0, 0)]);
    group.add(new THREE.Line(hGeo, mat));
    const vGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -10, 0), new THREE.Vector3(0, 10, 0)]);
    group.add(new THREE.Line(vGeo, mat));
    const tick = 0.015;
    for (let i = -10; i <= 10; i++) {
        const v = i * 0.1;
        if (Math.abs(v) < 0.001) continue;
        const thGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(v, -tick, 0), new THREE.Vector3(v, tick, 0)]);
        group.add(new THREE.Line(thGeo, mat));
        const tvGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-tick, v, 0), new THREE.Vector3(tick, v, 0)]);
        group.add(new THREE.Line(tvGeo, mat));
    }
    group.position.z = 0.001;
    group.visible = false;
    group.userData._overlay = true;
    overlayScene.add(group);
    return group;
}

const _fontLoader = new FontLoader();
const _fontCache = new Map();
const _text3dIndices = new Set();
let _activeTri3DIdx = -1;            // index du tri3d sélectionné (-1 = aucun)
let transformCtrl   = null;      // TransformControls pour Rotate/Scale de l'import
let transformCtrl2D = null;      // TransformControls pour overlay 2D
let selectionOutline = null;
let selectedMesh = null;

function _apply2DGizmoMode(mode) {
    if (!transformCtrl2D) return;
    transformCtrl2D.setMode(mode);
    transformCtrl2D.showZ = (mode === 'rotate');
}

const _typefaceMap = {
    'helvetiker':          'helvetiker_regular.typeface.json',
    'helvetiker_bold':     'helvetiker_bold.typeface.json',
    'optimer':             'optimer_regular.typeface.json',
    'optimer_bold':        'optimer_bold.typeface.json',
    'gentilis':            'gentilis_regular.typeface.json',
    'gentilis_bold':       'gentilis_bold.typeface.json',
    'droid_sans':          'droid/droid_sans_regular.typeface.json',
    'droid_sans_bold':     'droid/droid_sans_bold.typeface.json',
    'droid_serif':         'droid/droid_serif_regular.typeface.json',
    'droid_serif_bold':    'droid/droid_serif_bold.typeface.json',
    'droid_sans_mono':     'droid/droid_sans_mono_regular.typeface.json',
};
const _fontsourceFonts = new Set([
    'roboto','inter','open-sans','noto-sans','ubuntu','fira-sans','cantarell',
    'arimo','tinos','courier-prime','comic-neue','anton',
    'raleway','libre-franklin','eb-garamond','lora',
    'montserrat','poppins','oswald','playfair-display','merriweather','source-code-pro'
]);
const _noBoldFonts = new Set(['anton','droid_sans_mono']);
const _ttfLoader = new TTFLoader();

async function _loadFont(fontName) {
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

function _buildTextGroup(text, font, thickness, letterSpacing, italic, underline, strike) {
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

function _groupToObjMtl(group) {
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

// ─── Playback ────────────────────────────────────────────────────────────────
let _pbTargets = [];   // [{obj, transKf, scaleKf, rotKf, orbitKf, startPos, startScale, startRot}]
let _pbPlaying = false;
let _pbRepeat = false;
let _pbTime = 0;
let _pbLastTs = 0;

function _pbApplyTime(t) {
    for (const tgt of _pbTargets) {
        const { obj, is2D, sc2D, transKf, scaleKf, rotKf, orbitKf, startPos, startScale, startRot } = tgt;
        if (!obj || !startPos) continue;

        let ox = 0, oy = 0, oz = 0;
        if (transKf.length > 0) {
            for (const kf of transKf) {
                if (t < kf.time) break;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) { ox += kf.x; oy += kf.y; oz += kf.z; continue; }
                const p = Math.min(1, (t - kf.time) / dur);
                ox += kf.x * p; oy += kf.y * p; oz += kf.z * p;
            }
        }

        if (orbitKf && orbitKf.length > 0) {
            for (const kf of orbitKf) {
                if (kf.radius === 0 || t < kf.time) continue;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) continue;
                const p = Math.min(1, (t - kf.time) / dur);
                const angle = kf.degrees * Math.PI / 180 * p;
                ox += kf.radius * (Math.cos(angle) - 1);
                if (is2D)
                    oz += kf.radius * Math.sin(angle);
                else
                    oz += kf.radius * Math.sin(angle);
            }
        }

        if (transKf.length > 0 || (orbitKf && orbitKf.length > 0)) {
            if (is2D)
                obj.position.set(startPos.x + ox * sc2D, startPos.y + oz * sc2D, startPos.z);
            else
                obj.position.set(startPos.x + ox, startPos.y + oy, startPos.z + oz);
        }

        if (scaleKf.length > 0 && startScale) {
            let sx = 1, sy = 1, sz = 1;
            for (let i = 0; i < scaleKf.length; i++) {
                const kf = scaleKf[i];
                if (t < kf.time) break;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) { sx = kf.x; sy = kf.y; sz = kf.z; continue; }
                const p = Math.min(1, (t - kf.time) / dur);
                const prev = i > 0 ? scaleKf[i - 1] : { x: 1, y: 1, z: 1 };
                sx = prev.x + (kf.x - prev.x) * p;
                sy = prev.y + (kf.y - prev.y) * p;
                sz = prev.z + (kf.z - prev.z) * p;
            }
            if (is2D)
                obj.scale.set(startScale.x * sx, startScale.y * sz, startScale.z);
            else
                obj.scale.set(startScale.x * sx, startScale.y * sy, startScale.z * sz);
        }

        if (rotKf.length > 0 && startRot) {
            let rx = 0, ry = 0, rz = 0;
            for (const kf of rotKf) {
                if (t < kf.time) break;
                const dur = kf.endTime - kf.time;
                if (dur <= 0) { rx += kf.x; ry += kf.y; rz += kf.z; continue; }
                const p = Math.min(1, (t - kf.time) / dur);
                rx += kf.x * p; ry += kf.y * p; rz += kf.z * p;
            }
            if (is2D)
                obj.rotation.set(0, 0, startRot.z + rx);
            else
                obj.rotation.set(startRot.x + rx, startRot.y + ry, startRot.z + rz);
        }
    }
    _tri3dApplyTime(t);
}

function _removeSelectionBox() {
    if (!selectionBox) return;
    (selectionBox.userData._overlay ? overlayScene : scene).remove(selectionBox);
    selectionBox.dispose?.();
    selectionBox = null;
}

function _tri3dApplyTime(t) {
    for (const mesh of tri3dMeshes) {
        const kfs = mesh.userData.tri3dKeyframes;
        if (!kfs || kfs.length < 2) continue;
        const vertCount = mesh.userData.tri3dVertCount;

        let kfA = kfs[0], kfB = kfs[0];
        for (let i = 0; i < kfs.length - 1; i++) {
            if (t >= kfs[i].time && t <= kfs[i + 1].time) {
                kfA = kfs[i]; kfB = kfs[i + 1]; break;
            }
            if (t > kfs[i + 1].time) { kfA = kfs[i + 1]; kfB = kfs[i + 1]; }
        }

        const dur = kfB.time - kfA.time;
        const p = dur > 0 ? Math.min(1, (t - kfA.time) / dur) : 0;
        const posAttr = mesh.geometry.getAttribute('position');
        const posA = kfA.positions, posB = kfB.positions;

        if (mesh.userData.is2D) {
            for (let i = 0; i < vertCount; i++) {
                const i3 = i * 3;
                const x = posA[i3]     + (posB[i3]     - posA[i3])     * p;
                const y = posA[i3 + 1] + (posB[i3 + 1] - posA[i3 + 1]) * p;
                posAttr.setXYZ(i, -x, y, 0);
            }
            posAttr.needsUpdate = true;
        } else {
            const initPos = mesh.userData.tri3dInitPos;
            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < vertCount; i++) {
                const i3 = i * 3;
                const x = posA[i3]     + (posB[i3]     - posA[i3])     * p;
                const y = posA[i3 + 1] + (posB[i3 + 1] - posA[i3 + 1]) * p;
                const z = posA[i3 + 2] + (posB[i3 + 2] - posA[i3 + 2]) * p;
                cx += x; cy += y; cz += z;
                posAttr.setXYZ(i, x - initPos.x, y - initPos.y, z - initPos.z);
            }
            cx /= vertCount; cy /= vertCount; cz /= vertCount;
            mesh.position.set(cx, cy, cz);
            for (let i = 0; i < vertCount; i++) {
                posAttr.setXYZ(i, posAttr.getX(i) - cx + initPos.x, posAttr.getY(i) - cy + initPos.y, posAttr.getZ(i) - cz + initPos.z);
            }
            posAttr.needsUpdate = true;
            mesh.geometry.computeVertexNormals();
        }
    }
}

function _tri3dMaxTime() {
    let d = 0;
    for (const mesh of tri3dMeshes) {
        const kfs = mesh.userData.tri3dKeyframes;
        if (kfs && kfs.length > 0) d = Math.max(d, kfs[kfs.length - 1].time);
    }
    return d;
}

function _pbTotalDur() {
    let d = _tri3dMaxTime();
    for (const tgt of _pbTargets) {
        if (tgt.transKf.length > 0) d = Math.max(d, tgt.transKf[tgt.transKf.length - 1].endTime);
        if (tgt.scaleKf.length > 0) d = Math.max(d, tgt.scaleKf[tgt.scaleKf.length - 1].endTime);
        if (tgt.rotKf.length > 0) d = Math.max(d, tgt.rotKf[tgt.rotKf.length - 1].endTime);
        if (tgt.orbitKf && tgt.orbitKf.length > 0) d = Math.max(d, tgt.orbitKf[tgt.orbitKf.length - 1].endTime);
    }
    return d;
}

function _pbUpdateTimer(t) {
    const el = document.getElementById('playback-timer');
    if (!el) return;
    const total = Math.floor(t * 100);
    const cs = total % 100;
    const secs = Math.floor(total / 100) % 60;
    const mins = Math.floor(total / 6000);
    el.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0') + ':' + String(cs).padStart(2, '0');
}

function _pbTick(ts) {
    if (!_pbPlaying) return;
    if (_pbLastTs === 0) { _pbLastTs = ts; requestAnimationFrame(_pbTick); return; }
    const dt = (ts - _pbLastTs) / 1000;
    _pbLastTs = ts;
    _pbTime += dt;
    const totalDur = _pbTotalDur();
    if (_pbTime >= totalDur) {
        if (_pbRepeat) {
            _pbTime = 0;
        } else {
            _pbTime = totalDur;
            _pbPlaying = false;
        }
    }
    _pbApplyTime(_pbTime);
    _pbUpdateTimer(_pbTime);
    if (_pbPlaying) requestAnimationFrame(_pbTick);
}

function _getImportGroup(idx) {
    if (idx === undefined) idx = activeImportIdx;
    return importMeshGroups.get(idx) ?? importMeshGroups.get(`2d_${idx}`) ?? null;
}

function _getActiveObject() {
    if (_activeTri3DIdx >= 0 && _activeTri3DIdx < tri3dMeshes.length)
        return tri3dMeshes[_activeTri3DIdx];
    return _getImportGroup() ?? null;
}

function _getTri3DAvgColor(mesh) {
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

function _getTri3DUniqueColors(mesh) {
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
let mapGroup = null;
const rawModelCache = new Map();  // cacheKey → rawObj THREE.js parsé (template pour clones)
const MAP_OFFSET_DEFAULT = { x: -512, y: -9, z: -512 };
let mapOffset = { ...MAP_OFFSET_DEFAULT };
let currentBlobUrlMap = {};  // filename.dds → blobUrl (mis à jour par setBlobUrlMap)

const loadingManager = new THREE.LoadingManager();
// DDSLoader doit recevoir le même loadingManager pour que le URL modifier s'applique
loadingManager.addHandler(/\.dds$/i, new DDSLoader(loadingManager));
const _missingTextures = new Set();
loadingManager.onError = url => {
    if (_missingTextures.has(url)) return;
    _missingTextures.add(url);
    console.error('[TMNFeditor] Texture manquante:', url);
};
const objLoader = new OBJLoader();

THREE.Cache.enabled = true;

// Meshes dont le matériau doit être masqué (noms exacts, comparaison insensible à la casse)
const HIDDEN_MATERIALS = new Set(['stadiumgrassfence']);

// Matériaux avec shader procédural
const WATER_MATERIALS = new Set(['stadiumwater']);
let _waterMaterial = null;

function getWaterMaterial() {
    if (_waterMaterial) return _waterMaterial;
    _waterMaterial = new THREE.ShaderMaterial({
        uniforms: {
            camPos: { value: new THREE.Vector3() },
        },
        vertexShader: /* glsl */`
            varying vec3 vWorldNormal;
            varying vec3 vWorldPos;

            void main() {
                vWorldNormal = normalize(mat3(modelMatrix) * normal);
                vWorldPos    = (modelMatrix * vec4(position, 1.0)).xyz;
                gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform vec3 camPos;
            varying vec3 vWorldNormal;
            varying vec3 vWorldPos;

            void main() {
                vec3 N = normalize(vWorldNormal);
                vec3 V = normalize(camPos - vWorldPos);
                float NdotV   = clamp(dot(N, V), 0.0, 1.0);
                float fresnel = pow(1.0 - NdotV, 3.0);

                vec3 deepColor    = vec3(0.20, 0.50, 0.82);
                vec3 shallowColor = vec3(0.38, 0.72, 0.92);
                vec3 skyColor     = vec3(0.78, 0.92, 1.00);
                vec3 color = mix(mix(deepColor, shallowColor, fresnel * 0.6), skyColor, fresnel * 0.55);

                // Spéculaire soleil (world-space)
                vec3 L = normalize(vec3(1.0, 2.0, 1.0));
                vec3 H = normalize(L + V);
                float spec = pow(clamp(dot(N, H), 0.0, 1.0), 256.0) * 0.9;
                color += vec3(1.0, 0.97, 0.88) * spec;

                gl_FragColor = vec4(color, 0.88);
            }
        `,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    return _waterMaterial;
}

// ─── Helpers cache géométrie IDB ─────────────────────────────────────────────
// Extrait le mapping matName → texFilename depuis le texte MTL
function parseMtlTextures(mtlText) {
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

// Sérialise un rawObj Three.js en format binaire stockable dans IDB (TypedArrays natifs)
function serializeRawObj(rawObj, matTexMap) {
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
function deserializeRawObj(cached) {
    const group = new THREE.Group();
    const rr = Math.random();
    const defMatBase = { side: THREE.DoubleSide, flatShading: false, shininess: 30, userData: { isDefault: true } };
    for (const m of cached.meshes) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
        if (m.normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
        if (m.uvs)     geo.setAttribute('uv',     new THREE.Float32BufferAttribute(m.uvs,     2));
        if (m.indices) geo.setIndex(new THREE.Uint32BufferAttribute(m.indices, 1));

        let mat;
        if (WATER_MATERIALS.has(m.matName)) {
            mat = getWaterMaterial();
        } else if (HIDDEN_MATERIALS.has(m.matName)) {
            mat = new THREE.MeshBasicMaterial({ name: m.matName });
        } else {
            // Vérifie que le blob URL existe dans la map courante avant de charger
            const blobUrl = m.texFilename
                ? (currentBlobUrlMap[m.texFilename] || currentBlobUrlMap[m.texFilename.toLowerCase()] || null)
                : null;
            if (blobUrl) {
                // Passe m.texFilename (ex: "StadiumRoadD.dds") et non le blobUrl directement :
                // loadingManager.getHandler détecte .dds → DDSLoader,
                // puis le URL modifier convertit le nom en blob URL au moment du fetch.
                const handler = loadingManager.getHandler(m.texFilename) || new THREE.TextureLoader(loadingManager);
                const tex = handler.load(m.texFilename);
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
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = m.name;
        mesh.visible = m.visible && !HIDDEN_MATERIALS.has(m.matName);
        mesh.userData.originalMaterialName = m.matName;
        group.add(mesh);
    }
    return group;
}

// ─── Import Preview (mini scène isolée, multi-modèles) ───────────────────────
const importPrev = (() => {
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
        if (gi < 0) return;
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

// ─── Init — attaché au conteneur DOM passé par Blazor ────────────────────────
window.TMNFeditorScene = {
    init(container) {
        if (!container) return;
        const w = container.clientWidth || window.innerWidth - 350;
        const h = container.clientHeight || window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        _updateOverlayCam();
        container.appendChild(renderer.domElement);

        _gridCursorEl = document.createElement('div');
        _gridCursorEl.id = 'grid-cursor-pos';
        _gridCursorEl.style.cssText = 'position:absolute;top:8px;right:8px;color:#4c4;font-size:12px;font-family:monospace;pointer-events:none;display:none;z-index:5;text-shadow:0 0 3px #000;';
        container.appendChild(_gridCursorEl);

        renderer.domElement.addEventListener('mousemove', e => {
            if (!_gridVisible || !_gridCursorEl) return;
            const rect = renderer.domElement.getBoundingClientRect();
            const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
            const gx = ndcX * overlayCam.right;
            const gy = ndcY;
            _gridCursorEl.textContent = `X: ${gx.toFixed(2)}  Y: ${gy.toFixed(2)}`;
        });

        window.addEventListener('resize', () => {
            const nw = container.clientWidth;
            const nh = container.clientHeight;
            camera.aspect = nw / nh;
            camera.updateProjectionMatrix();
            renderer.setSize(nw, nh);
            _updateOverlayCam();
        });

        transformCtrl = new TransformControls(camera, renderer.domElement);
        transformCtrl.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
        scene.add(transformCtrl);

        transformCtrl2D = new TransformControls(overlayCam, renderer.domElement);
        transformCtrl2D.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
        transformCtrl2D.showX = true;
        transformCtrl2D.showY = true;
        transformCtrl2D.showZ = false;
        transformCtrl2D.size = 0.4;
        transformCtrl2D.enabled = false;
        overlayScene.add(transformCtrl2D);

        // Push position en direct (throttle 50 ms pour limiter les appels interop)
        let _posTimer = null;
        function _pushPosition() {
            const g = _getImportGroup();
            if (!g || !mainDotNetRef) return;
            const is2D = importMeshGroups.has(`2d_${activeImportIdx}`);
            if (is2D) {
                const sc = g.userData._2dScale || 1;
                mainDotNetRef.invokeMethodAsync('OnImportPositionChanged', g.position.x / sc, 0, g.position.y / sc);
            } else
                mainDotNetRef.invokeMethodAsync('OnImportPositionChanged', g.position.x, g.position.y, g.position.z);
        }
        function _pushTri3DPosition() {
            const obj = transformCtrl?.object;
            if (!obj || !mainDotNetRef) return;
            const idx = tri3dMeshes.indexOf(obj);
            if (idx >= 0) {
                const init = obj.userData.tri3dInitPos || { x: 0, y: 0, z: 0 };
                mainDotNetRef.invokeMethodAsync('OnTri3DPositionChanged',
                    obj.position.x - init.x, obj.position.y - init.y, obj.position.z - init.z);
            }
        }
        transformCtrl.addEventListener('objectChange', () => {
            if (_posTimer) return;
            _posTimer = setTimeout(() => {
                _posTimer = null;
                const obj = transformCtrl?.object;
                if (obj && tri3dMeshes.includes(obj)) _pushTri3DPosition();
                else _pushPosition();
            }, 50);
        });
        transformCtrl2D.addEventListener('objectChange', () => {
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
            if (!active || !mainDotNetRef) return;
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
            mainDotNetRef.invokeMethodAsync('OnImportMaterialsChanged', result);
        }
        window._pushImportMaterials = _pushMaterials;

        function _pushOrigin() {
            if (!mainDotNetRef) return;
            const o = importOriginOffsets.get(activeImportIdx) ?? new THREE.Vector3();
            mainDotNetRef.invokeMethodAsync('OnImportOriginChanged', o.x, o.y, o.z);
        }
        window._pushImportOrigin = _pushOrigin;

        // Sélection d'un modèle importé au clic dans le grand rendu
        const _ray = new THREE.Raycaster();
        const _rm  = new THREE.Vector2();
        let _rdx = 0, _rdy = 0;

        function _setSelectionBox(group) {
            _removeSelectionBox();
            if (!group) return;
            selectionBox = new THREE.BoxHelper(group, 0x4488ff);
            selectionBox.material.transparent = true;
            selectionBox.material.opacity = 0.35;
            selectionBox.material.linewidth = 1;
            scene.add(selectionBox);
        }

        renderer.domElement.addEventListener('pointerdown', e => { _rdx = e.clientX; _rdy = e.clientY; });
        renderer.domElement.addEventListener('pointerup', e => {
            if (transformCtrl?.dragging || transformCtrl2D?.dragging) return;
            const dx = e.clientX - _rdx, dy = e.clientY - _rdy;
            if (dx * dx + dy * dy > 25) return;

            const rect = renderer.domElement.getBoundingClientRect();
            _rm.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            _rm.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

            // Raycast overlay (Triangles2D + imports 2D) first — they render on top
            const tri2dTargets = [];
            tri3dMeshes.forEach((mesh, idx) => {
                if (mesh.visible && mesh.userData.is2D) tri2dTargets.push({ mesh, idx, type: 'tri' });
            });
            const import2dTargets = [];
            importMeshGroups.forEach((mesh, key) => {
                if (typeof key === 'string' && key.startsWith('2d_') && mesh.visible) {
                    import2dTargets.push({ mesh, key, type: 'import2d' });
                }
            });
            const allOverlay = [...tri2dTargets, ...import2dTargets];
            if (allOverlay.length) {
                _ray.setFromCamera(_rm, overlayCam);
                const hits2d = _ray.intersectObjects(allOverlay.map(t => t.mesh), true);
                if (hits2d.length) {
                    const hitObj2d = hits2d[0].object;
                    const foundTri2d = tri2dTargets.find(t => t.mesh === hitObj2d);
                    if (foundTri2d) {
                        activeImportIdx = -1;
                        _activeTri3DIdx = foundTri2d.idx;
                        _removeSelectionBox();
                        selectionBox = new THREE.BoxHelper(foundTri2d.mesh, 0x4488ff);
                        selectionBox.material.transparent = true;
                        selectionBox.material.opacity = 0.35;
                        selectionBox.material.depthTest = false;
                        selectionBox.userData._overlay = true;
                        overlayScene.add(selectionBox);
                        if (transformCtrl?.object) transformCtrl.detach();
                        const m = foundTri2d.mesh.material;
                        const mats = m.vertexColors ? _getTri3DUniqueColors(foundTri2d.mesh) : [
                            { key: m.uuid, name: m.name || 'Material', hex: '#' + (m.color?.getHexString() ?? 'ffffff') }
                        ];
                        mainDotNetRef?.invokeMethodAsync('OnImportMaterialsChanged', mats);
                        mainDotNetRef?.invokeMethodAsync('OnTri3DSelected', foundTri2d.idx);
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
                        _activeTri3DIdx = -1;
                        const impIdx = parseInt(foundImp2d.key.substring(3));
                        activeImportIdx = impIdx;
                        importPrev.switchTab(impIdx);
                        _removeSelectionBox();
                        selectionBox = new THREE.BoxHelper(foundImp2d.mesh, 0x4488ff);
                        selectionBox.material.transparent = true;
                        selectionBox.material.opacity = 0.35;
                        selectionBox.material.depthTest = false;
                        selectionBox.userData._overlay = true;
                        overlayScene.add(selectionBox);
                        if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = false; }
                        if (_currentTransformMode !== 'none' && transformCtrl2D) {
                            transformCtrl2D.enabled = true;
                            transformCtrl2D.attach(foundImp2d.mesh);
                            _apply2DGizmoMode(_currentTransformMode);
                        }
                        mainDotNetRef?.invokeMethodAsync('OnSwitchImportMode', '2D');
                        mainDotNetRef?.invokeMethodAsync('OnImportSelected', impIdx);
                        window._pushImportMaterials?.();
                        return;
                    }
                }
            }

            // Raycast main scene
            _ray.setFromCamera(_rm, camera);

            // Imports
            const targets = [];
            importMeshGroups.forEach((group, idx) => {
                if (!group.visible) return;
                group.traverse(c => { if (c.isMesh) targets.push({ mesh: c, idx }); });
            });

            // Triangles3D (not 2D)
            const tri3dTargets = [];
            tri3dMeshes.forEach((mesh, idx) => {
                if (mesh.visible && !mesh.userData.is2D) tri3dTargets.push({ mesh, idx });
            });

            const allMeshes = [...targets.map(t => t.mesh), ...tri3dTargets.map(t => t.mesh)];

            const hits = allMeshes.length ? _ray.intersectObjects(allMeshes, false) : [];
            if (!hits.length) {
                activeImportIdx = -1;
                _activeTri3DIdx = -1;
                _removeSelectionBox();
                if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = true; }
                if (transformCtrl2D) { transformCtrl2D.detach(); transformCtrl2D.enabled = false; }
                mainDotNetRef?.invokeMethodAsync('OnSceneDeselected');
                return;
            }

            const hitObj = hits[0].object;

            // Check import hit
            const foundImport = targets.find(t => t.mesh === hitObj);
            if (foundImport) {
                _activeTri3DIdx = -1;
                activeImportIdx = foundImport.idx;
                _setSelectionBox(_getImportGroup());
                importPrev.switchTab(foundImport.idx);
                if (transformCtrl2D) { transformCtrl2D.detach(); transformCtrl2D.enabled = false; }
                if (_currentTransformMode !== 'none' && transformCtrl) { transformCtrl.enabled = true; transformCtrl.attach(_getImportGroup()); transformCtrl.setMode(_currentTransformMode); }
                mainDotNetRef?.invokeMethodAsync('OnSwitchImportMode', '3D');
                mainDotNetRef?.invokeMethodAsync('OnImportSelected', foundImport.idx);
                if (_text3dIndices.has(foundImport.idx)) {
                    mainDotNetRef?.invokeMethodAsync('OnText3DSelected', foundImport.idx);
                }
                window._pushImportPosition?.();
                window._pushImportMaterials?.();
                window._pushImportOrigin?.();
                return;
            }

            // Check tri3d hit
            const foundTri = tri3dTargets.find(t => t.mesh === hitObj);
            if (foundTri) {
                _activeTri3DIdx = foundTri.idx;
                _setSelectionBox(foundTri.mesh);
                if (transformCtrl2D) { transformCtrl2D.detach(); transformCtrl2D.enabled = false; }
                if (_currentTransformMode !== 'none' && transformCtrl) {
                    transformCtrl.enabled = true;
                    transformCtrl.attach(foundTri.mesh);
                    transformCtrl.setMode(_currentTransformMode);
                }
                const m = foundTri.mesh.material;
                const mats = m.vertexColors ? _getTri3DUniqueColors(foundTri.mesh) : [
                    { key: m.uuid, name: m.name || 'Material', hex: '#' + (m.color?.getHexString() ?? 'ffffff') }
                ];
                mainDotNetRef?.invokeMethodAsync('OnImportMaterialsChanged', mats);
                mainDotNetRef?.invokeMethodAsync('OnSwitchImportMode', '3D');
                mainDotNetRef?.invokeMethodAsync('OnTri3DSelected', foundTri.idx);
            }
        });

        (function animate() {
            requestAnimationFrame(animate);
            controls.update();
            if (_waterMaterial) _waterMaterial.uniforms.camPos.value.copy(camera.position);
            if (selectionBox) selectionBox.update();
            if (originDot && _originDotVisible) {
                const _og = _getActiveObject();
                if (_og) {
                    _og.getWorldPosition(originDot.position);
                    const is2D = _og.userData?.is2D || importMeshGroups.has(`2d_${activeImportIdx}`);
                    if (is2D) {
                        originDot.scale.setScalar(0.02);
                    } else {
                        const _d = camera.position.distanceTo(originDot.position);
                        originDot.scale.setScalar(_d * 0.02);
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

    // Enregistre le mapping {filename.dds → blobUrl} pour que DDSLoader charge les textures via blob
    setBlobUrlMap(blobUrlMap) {
        currentBlobUrlMap = blobUrlMap || {};
        if (blobUrlMap && Object.keys(blobUrlMap).length > 0) {
            loadingManager.setURLModifier(url => {
                const filename = url.split('/').pop().split('\\').pop();
                return blobUrlMap[filename] || url;
            });
        } else {
            loadingManager.setURLModifier(null);
        }
    },

    // Charge un modèle — OBJ + MTL avec textures DDS via URL modifier
    // geomKey : clé IDB pour la géométrie binaire (persistante). Vide = pas de cache IDB.
    async loadModel(objText, mtlText, pakName, cacheKey, geomKey) {
        clearMesh();
        importMeshGroups.forEach(g => { g.visible = false; });
        if (selectionBox) { _removeSelectionBox(); }

        // 1. Cache mémoire session (instantané)
        let rawObj = cacheKey ? rawModelCache.get(cacheKey) : null;

        // 2. Cache IDB géométrie binaire (persistant, ~1ms, évite OBJLoader)
        if (!rawObj && geomKey) {
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
        currentMeshCacheKey = cacheKey || null;

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
            meshCount++;
        });

        if (!obj || obj.children.length === 0) return { vertices: 0, triangles: 0, meshes: 0 };

        currentMesh = obj;
        scene.add(currentMesh);

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
    },

    selectMesh(name, materialName) {
        if (selectionOutline) { scene.remove(selectionOutline); selectionOutline.geometry.dispose(); selectionOutline.material.dispose(); selectionOutline = null; }
        if (!currentMesh || !name) return;
        const mesh = findMesh(currentMesh, name, materialName);
        if (!mesh || !(mesh instanceof THREE.Mesh) || !mesh.visible) return;
        selectedMesh = mesh;
        const wireGeo = new THREE.WireframeGeometry(mesh.geometry);
        const wireMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
        selectionOutline = new THREE.LineSegments(wireGeo, wireMat);
        mesh.updateMatrixWorld(true);
        selectionOutline.matrix.copy(mesh.matrixWorld);
        selectionOutline.matrixAutoUpdate = false;
        scene.add(selectionOutline);
    },

    toggleMesh(name, materialName) {
        if (!currentMesh) return false;
        const mesh = findMesh(currentMesh, name, materialName);
        if (mesh instanceof THREE.Mesh) {
            mesh.visible = !mesh.visible;
            if (!mesh.visible && mesh === selectedMesh && selectionOutline) {
                scene.remove(selectionOutline); selectionOutline.geometry.dispose(); selectionOutline.material.dispose(); selectionOutline = null;
            }
            return mesh.visible;
        }
        return true;
    },

    // Ajoute un model sur le currentMesh existant sans effacer la scène.
    // Utilisé pour EditorHelper/EditorHelperArrow des blocs Checkpoint/Start/Finish.
    async appendModelToCurrentBlock(objText, mtlText, pakName, cacheKey, geomKey, color) {
        if (!currentMesh) return;

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
            if (child.material?.map) child.material.color.set(0xffffff);
            else child.material = defMat;
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
        currentMesh.add(obj);
    },

    // ─── Map mode ─────────────────────────────────────────────────────────────
    clearMap() {
        if (mapGroup) {
            scene.remove(mapGroup);
            mapGroup.traverse(c => {
                if (c instanceof THREE.Mesh) {
                    c.geometry?.dispose();
                    (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m?.dispose());
                }
            });
            mapGroup = null;
        }
        mapOffset = { ...MAP_OFFSET_DEFAULT };
        for (const m of tri3dMeshes) {
            if (m.userData.is2D) overlayScene.remove(m);
            m.geometry?.dispose();
            m.material?.dispose();
        }
        tri3dMeshes = [];
        _tri3dIs2D = [];
    },

    beginMap() {
        this.clearMap();
        clearMesh();
        mapGroup = new THREE.Group();
    },

    // geomKey : clé IDB pour sauvegarder la géométrie binaire (fire-and-forget, sessions suivantes)
    addModelToMap(objText, mtlText, pakName, placements, cacheKey, geomKey) {
        if (!mapGroup || !placements?.length) return;

        // Cache mémoire session (rawModelCache hit = instant, pas de parsing)
        let rawObj = cacheKey ? rawModelCache.get(cacheKey) : null;
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
                    if (HIDDEN_MATERIALS.has((child.material?.name || '').toLowerCase())) {
                        child.visible = false;
                        return;
                    }
                    if (child.material?.map) {
                        child.material.color.set(0xffffff);
                    } else {
                        child.material = defMat;
                    }
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
            mapGroup.add(clone);
        }
    },

    finalizeMap(mapSizeX, mapSizeZ, groundBlocks) {
        if (!mapGroup) return;
        mapGroup.position.set(mapOffset.x, mapOffset.y, mapOffset.z);
        scene.add(mapGroup);

        const box = new THREE.Box3().setFromObject(mapGroup);
        const center = new THREE.Vector3(); box.getCenter(center);
        const size = box.getSize(new THREE.Vector3()).length();
        if (!isFinite(size) || size === 0) return;

        camera.far = Math.max(2000, size * 3);
        scene.fog = new THREE.Fog(0x2a2a3a, size * 0.6, size * 2);
        camera.updateProjectionMatrix();
        camera.position.set(center.x + size * 0.7, center.y + size * 0.5, center.z + size * 0.7);
        camera.lookAt(center); controls.target.copy(center); controls.update();

        // ── Herbe sur les cellules vides au sol ──────────────────────────────
        const CELL_H = 32;
        const occupied = new Set();
        for (const b of (groundBlocks || [])) {
            const d = (b.dir || 0) & 3;
            const rotated = (d === 1 || d === 3);
            const sx = rotated ? (b.sz || 1) : (b.sx || 1);
            const sz = rotated ? (b.sx || 1) : (b.sz || 1);
            for (let dx = 0; dx < sx; dx++)
                for (let dz = 0; dz < sz; dz++)
                    occupied.add(`${b.x + dx},${b.z + dz}`);
        }

        const emptyCells = [];
        for (let cx = 0; cx < (mapSizeX || 0); cx++)
            for (let cz = 0; cz < (mapSizeZ || 0); cz++)
                if (!occupied.has(`${cx},${cz}`))
                    emptyCells.push([cx, cz]);

        if (emptyCells.length === 0) return;

        // Chercher la texture StadiumGrass dans les blocs déjà rendus
        let grassTexture = null;
        mapGroup.traverse(child => {
            if (grassTexture || !child.isMesh) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats)
                if (m?.name?.toLowerCase() === 'stadiumgrass' && m.map) { grassTexture = m.map; break; }
        });

        const grassMat = new THREE.MeshPhongMaterial({
            color: grassTexture ? 0xffffff : 0x4a7a3a,
            map: grassTexture || null,
            shininess: 30,
        });
        if (!grassTexture) {
            // Texture chargée en async — relancer jusqu'à ce qu'elle soit disponible
            const tryApply = () => {
                if (grassMat.map) return;
                mapGroup?.traverse(child => {
                    if (grassMat.map || !child.isMesh) return;
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    for (const m of mats)
                        if (m?.name?.toLowerCase() === 'stadiumgrass' && m.map) {
                            grassMat.map = m.map; grassMat.color.set(0xffffff); grassMat.needsUpdate = true; break;
                        }
                });
                if (!grassMat.map) setTimeout(tryApply, 500);
            };
            setTimeout(tryApply, 500);
        }

        const planeGeo = new THREE.PlaneGeometry(CELL_H, CELL_H);
        planeGeo.rotateX(-Math.PI / 2);
        const grassMesh = new THREE.InstancedMesh(planeGeo, grassMat, emptyCells.length);
        grassMesh.frustumCulled = false;
        const dummy = new THREE.Object3D();
        emptyCells.forEach(([cx, cz], i) => {
            dummy.position.set(cx * CELL_H + CELL_H / 2, 9, cz * CELL_H + CELL_H / 2);
            dummy.updateMatrix();
            grassMesh.setMatrixAt(i, dummy.matrix);
        });
        grassMesh.instanceMatrix.needsUpdate = true;
        mapGroup.add(grassMesh);
    },

    setMapOffset(x, y, z) {
        mapOffset.x = x; mapOffset.y = y; mapOffset.z = z;
        if (mapGroup) mapGroup.position.set(x, y, z);
    },

    // Charge en parallèle la géométrie binaire depuis IDB et peuple rawModelCache.
    // Retourne bool[] : true si l'entrée était dans IDB (rawModelCache maintenant prêt).
    // À appeler APRÈS setBlobUrlMap (pour que deserializeRawObj trouve les blob URLs).
    async populateRawModelCacheFromIDB(entries) {
        return Promise.all(entries.map(async e => {
            if (rawModelCache.has(e.cacheKey)) return true;
            try {
                const cached = await TMNFeditorCache.get(e.geomKey);
                if (!cached?.meshes?.length) return false;
                rawModelCache.set(e.cacheKey, deserializeRawObj(cached));
                return true;
            } catch { return false; }
        }));
    },

    clearScene() { clearMesh(); },

    // ─── Import Preview ───────────────────────────────────────────────────────
    initImportPreview(canvasId)        { importPrev.init(canvasId); },
    initImportDropZone(zoneId, ref)    { mainDotNetRef = ref; importPrev.initDropZone(zoneId, ref); },
    initImportFileInput(inputId)       { importPrev.initFileInput(inputId); },
    toggleGridOverlay(visible) {
        if (!_gridCross) _gridCross = _createGridCross();
        _gridCross.visible = visible;
        _gridVisible = visible;
        if (_gridCursorEl) _gridCursorEl.style.display = visible ? '' : 'none';
    },

    setImportTopView(on) {
        importPrev.setTopView(on);
        const modeActive = importPrev.getModeActiveIdx?.() ?? 0;
        this.switchImportTab(modeActive, on);
        if (!on) {
            if (_gridCross) _gridCross.visible = false;
            _gridVisible = false;
            if (_gridCursorEl) _gridCursorEl.style.display = 'none';
        }
    },
    triggerFileInput(inputId) { document.getElementById(inputId)?.click(); },
    switchImportTab(idx, is2DMode = false) {
        importPrev.switchTab(idx);
        let group = null;
        if (is2DMode) {
            const keys2d = [...importMeshGroups.keys()].filter(k => typeof k === 'string' && k.startsWith('2d_'));
            if (idx >= 0 && idx < keys2d.length) {
                group = importMeshGroups.get(keys2d[idx]);
                activeImportIdx = parseInt(keys2d[idx].replace('2d_', ''), 10);
            }
        } else {
            const keys3d = [...importMeshGroups.keys()].filter(k => typeof k === 'number');
            if (idx >= 0 && idx < keys3d.length) {
                group = importMeshGroups.get(keys3d[idx]);
                activeImportIdx = keys3d[idx];
            }
        }
        const is2D = is2DMode;
        // Met à jour le BoxHelper de sélection
        if (selectionBox) { _removeSelectionBox(); }
        if (group) {
            selectionBox = new THREE.BoxHelper(group, 0x4488ff);
            selectionBox.material.transparent = true;
            selectionBox.material.opacity = 0.35;
            if (is2D) {
                selectionBox.material.depthTest = false;
                selectionBox.userData._overlay = true;
                overlayScene.add(selectionBox);
            } else {
                scene.add(selectionBox);
            }
        }
        // Re-attache le bon gizmo
        if (is2D) {
            if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = false; }
            if (_currentTransformMode !== 'none' && group && transformCtrl2D) {
                transformCtrl2D.enabled = true;
                transformCtrl2D.attach(group);
                _apply2DGizmoMode(_currentTransformMode);
            } else if (transformCtrl2D) {
                transformCtrl2D.detach();
            }
        } else {
            if (transformCtrl2D) { transformCtrl2D.detach(); transformCtrl2D.enabled = false; }
            if (transformCtrl) {
                if (_currentTransformMode !== 'none' && group) {
                    transformCtrl.enabled = true;
                    transformCtrl.attach(group);
                    transformCtrl.setMode(_currentTransformMode);
                } else {
                    transformCtrl.detach();
                }
            }
        }
        mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', !!group);
        if (group) {
            window._pushImportPosition?.();
            window._pushImportMaterials?.();
            window._pushImportOrigin?.();
        } else {
            mainDotNetRef?.invokeMethodAsync('OnImportMaterialsChanged', []);
        }
    },

    showBlockView() {
        if (currentMesh) currentMesh.visible = true;
        if (mapGroup) mapGroup.visible = false;
        importMeshGroups.forEach(g => { g.visible = false; });
        tri3dMeshes.forEach(m => { m.visible = false; });
        if (selectionBox) selectionBox.visible = false;
        if (_gridCross) _gridCross.visible = false;
        _gridVisible = false;
        if (_gridCursorEl) _gridCursorEl.style.display = 'none';
        if (originDot)    originDot.visible    = false;
        transformCtrl?.detach();
    },

    showTrianglesView() {
        if (currentMesh) currentMesh.visible = false;
        if (mapGroup) mapGroup.visible = true;
        importMeshGroups.forEach(g => { g.visible = true; });
        tri3dMeshes.forEach(m => { m.visible = true; });
        if (selectionBox) selectionBox.visible = true;
        if (originDot)    originDot.visible    = _originDotVisible;
        if (_currentTransformMode !== 'none' && transformCtrl) {
            const active = _getActiveObject();
            if (active) { transformCtrl.attach(active); transformCtrl.setMode(_currentTransformMode); }
        }
    },

    setTransformMode(mode) {
        _currentTransformMode = mode;
        const active = _getActiveObject();
        if (mode === 'none' || !active) {
            if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = true; }
            if (transformCtrl2D) { transformCtrl2D.detach(); transformCtrl2D.enabled = false; }
            return;
        }
        const is2D = active.userData?.is2D || importMeshGroups.has(`2d_${activeImportIdx}`);
        if (is2D) {
            if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = false; }
            if (transformCtrl2D) { transformCtrl2D.enabled = true; transformCtrl2D.attach(active); _apply2DGizmoMode(mode); }
        } else {
            if (transformCtrl2D) { transformCtrl2D.detach(); transformCtrl2D.enabled = false; }
            if (transformCtrl) { transformCtrl.enabled = true; transformCtrl.attach(active); transformCtrl.setMode(mode); }
        }
    },

    mirrorImport() {
        const active = _getImportGroup();
        if (active) active.scale.x *= -1;
    },

    setOriginDotVisible(visible) {
        _originDotVisible = visible;
        if (!visible) { if (originDot) originDot.visible = false; return; }
        const obj = _getActiveObject();
        if (!obj) return;
        const is2D = obj.userData?.is2D || importMeshGroups.has(`2d_${activeImportIdx}`);
        if (!originDot) {
            const geo = new THREE.SphereGeometry(1, 16, 10);
            const mat = new THREE.MeshBasicMaterial({ color: 0xffee00, transparent: true, opacity: 0.65, depthTest: false });
            originDot = new THREE.Mesh(geo, mat);
            originDot.renderOrder = 999;
        }
        if (originDot.parent) originDot.parent.remove(originDot);
        if (is2D) {
            originDot.scale.setScalar(0.02);
            overlayScene.add(originDot);
        } else {
            scene.add(originDot);
        }
        obj.getWorldPosition(originDot.position);
        originDot.visible = true;
    },

    centerImportOrigin() {
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
            if (selectionBox) selectionBox.update();
            if (_activeTri3DIdx >= 0 && mainDotNetRef)
                mainDotNetRef.invokeMethodAsync('OnTri3DPositionChanged', 0, 0, 0);
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
        const cur = importOriginOffsets.get(activeImportIdx) ?? new THREE.Vector3();
        importOriginOffsets.set(activeImportIdx, cur.clone().add(delta));
        if (selectionBox) selectionBox.update();
        window._pushImportPosition?.();
        window._pushImportOrigin?.();
    },

    setImportOrigin(x, y, z) {
        const obj = _getActiveObject();
        if (!obj) return;
        if (obj.isMesh && _activeTri3DIdx >= 0) {
            // Tri3D mesh
            const delta = new THREE.Vector3(x, y, z);
            obj.geometry.translate(-delta.x, -delta.y, -delta.z);
            obj.geometry.computeBoundingBox?.();
            obj.geometry.computeBoundingSphere?.();
            obj.position.x += delta.x;
            obj.position.y += delta.y;
            obj.position.z += delta.z;
            obj.userData.tri3dInitPos = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
            if (selectionBox) selectionBox.update();
            if (mainDotNetRef)
                mainDotNetRef.invokeMethodAsync('OnTri3DPositionChanged', 0, 0, 0);
            return;
        }
        // Import group
        const group = obj;
        const is2D = importMeshGroups.has(`2d_${activeImportIdx}`);
        const cur = importOriginOffsets.get(activeImportIdx) ?? new THREE.Vector3();
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
        importOriginOffsets.set(activeImportIdx, new THREE.Vector3(x, y, z));
        if (selectionBox) selectionBox.update();
        window._pushImportPosition?.();
    },

    setImportMaterialColor(uuid, hexColor) {
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
    },

    resetImportMaterials() {
        const active = _getImportGroup();
        if (!active) return;
        const data = importPrev.getModelData(activeImportIdx);
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
    },

    setImportPosition(x, y, z) {
        const active = _getImportGroup();
        if (!active) return;
        const is2D = importMeshGroups.has(`2d_${activeImportIdx}`);
        if (is2D) {
            const sc = active.userData._2dScale || 1;
            active.position.set(x * sc, z * sc, 0);
        } else
            active.position.set(x, y, z);
        if (selectionBox) selectionBox.update();
    },

    setImportVisible(visible) {
        const active = _getImportGroup();
        if (active) active.visible = visible;
    },

    setImportVisibleByIndex(idx, visible) {
        const g = importMeshGroups.get(idx);
        if (g) g.visible = visible;
    },

    async sendImportToMainScene(idx, is2D = false) {
        if (is2D) {
            await this._sendImport2D(idx);
            return;
        }

        // Si le mesh existe déjà, le réutiliser sans re-parser
        if (importMeshGroups.has(idx)) {
            const group = importMeshGroups.get(idx);
            group.visible = true;
            if (currentMesh) currentMesh.visible = false;
            activeImportIdx = idx;
            if (selectionBox) { _removeSelectionBox(); }
            selectionBox = new THREE.BoxHelper(group, 0x4488ff);
            selectionBox.material.transparent = true;
            selectionBox.material.opacity = 0.35;
            scene.add(selectionBox);
            if (_currentTransformMode !== 'none' && transformCtrl) {
                transformCtrl.attach(group);
                transformCtrl.setMode(_currentTransformMode);
            }
            mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
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

        if (currentMesh) currentMesh.visible = false;
        scene.add(group);
        importMeshGroups.set(idx, group);
        activeImportIdx = idx;
        if (selectionBox) { _removeSelectionBox(); }
        selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        selectionBox.material.transparent = true;
        selectionBox.material.opacity = 0.35;
        scene.add(selectionBox);
        if (_currentTransformMode !== 'none' && transformCtrl) {
            transformCtrl.attach(group);
            transformCtrl.setMode(_currentTransformMode);
        }
        importOriginOffsets.delete(idx);
        mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
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
    },

    async _sendImport2D(idx) {
        const key = `2d_${idx}`;
        if (importMeshGroups.has(key)) {
            const group = importMeshGroups.get(key);
            group.visible = true;
            activeImportIdx = idx;
            if (selectionBox) { _removeSelectionBox(); }
            selectionBox = new THREE.BoxHelper(group, 0x4488ff);
            selectionBox.material.transparent = true;
            selectionBox.material.opacity = 0.35;
            selectionBox.material.depthTest = false;
            selectionBox.userData._overlay = true;
            overlayScene.add(selectionBox);
            mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
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
        importMeshGroups.set(key, group);
        activeImportIdx = idx;

        if (selectionBox) { _removeSelectionBox(); }
        selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        selectionBox.material.transparent = true;
        selectionBox.material.opacity = 0.35;
        selectionBox.material.depthTest = false;
        selectionBox.userData._overlay = true;
        overlayScene.add(selectionBox);

        if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = false; }
        if (_currentTransformMode !== 'none' && transformCtrl2D) {
            transformCtrl2D.enabled = true;
            transformCtrl2D.attach(group);
            _apply2DGizmoMode(_currentTransformMode);
        }
        mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
        window._pushImportMaterials?.();
    },

    // ─── Triangles3D MediaTracker ───────────────────────────────────────────
    clearTri3DKeyframes(index) {
        if (index >= 0 && index < tri3dMeshes.length) {
            delete tri3dMeshes[index].userData.tri3dKeyframes;
        }
    },

    clearTriangles3D() {
        for (const m of tri3dMeshes) {
            m.geometry?.dispose();
            if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
            else m.material?.dispose();
            if (m.userData.is2D) overlayScene.remove(m);
            else scene.remove(m);
        }
        tri3dMeshes = [];
        _tri3dIs2D = [];
        _activeTri3DIdx = -1;
        if (selectionBox) { _removeSelectionBox(); }
    },

    addTriangles3D(blocks) {
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

                tri3dMeshes.push(mesh);
                _tri3dIs2D.push(true);
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

                tri3dMeshes.push(mesh);
                _tri3dIs2D.push(false);
                if (mapGroup) mapGroup.add(mesh);
                else scene.add(mesh);
            }
        }
    },

    setTri3DVisible(index, visible) {
        if (index >= 0 && index < tri3dMeshes.length)
            tri3dMeshes[index].visible = visible;
    },


    setTri3DPosition(index, x, y, z) {
        if (index >= 0 && index < tri3dMeshes.length) {
            const mesh = tri3dMeshes[index];
            const init = mesh.userData.tri3dInitPos;
            if (init) mesh.position.set(init.x + x, init.y + y, init.z + z);
            else mesh.position.set(x, y, z);
            if (selectionBox) selectionBox.update();
        }
    },

    selectTri3DMesh(index) {
        if (index < 0 || index >= tri3dMeshes.length) {
            _activeTri3DIdx = -1;
            if (selectionBox) { _removeSelectionBox(); }
            if (transformCtrl?.object) transformCtrl.detach();
            if (originDot) originDot.visible = false;
            return;
        }
        _activeTri3DIdx = index;
        const mesh = tri3dMeshes[index];

        if (selectionBox) { _removeSelectionBox(); }

        if (mesh.userData.is2D) {
            if (transformCtrl?.object) transformCtrl.detach();
            selectionBox = new THREE.BoxHelper(mesh, 0x4488ff);
            selectionBox.material.transparent = true;
            selectionBox.material.opacity = 0.35;
            selectionBox.material.depthTest = false;
            selectionBox.userData._overlay = true;
            overlayScene.add(selectionBox);
        } else {
            selectionBox = new THREE.BoxHelper(mesh, 0x4488ff);
            selectionBox.material.transparent = true;
            selectionBox.material.opacity = 0.35;
            scene.add(selectionBox);

            if (_currentTransformMode !== 'none' && transformCtrl) {
                transformCtrl.attach(mesh);
                transformCtrl.setMode(_currentTransformMode);
            }
        }

        if (mainDotNetRef) {
            const m = mesh.material;
            const mats = m.vertexColors ? _getTri3DUniqueColors(mesh) : [
                { key: m.uuid, name: m.name || 'Material', hex: '#' + (m.color?.getHexString() ?? 'ffffff') }
            ];
            mainDotNetRef.invokeMethodAsync('OnImportMaterialsChanged', mats);
        }

        if (originDot && _originDotVisible) {
            originDot.position.copy(mesh.position);
            originDot.visible = true;
        }
    },

    selectImportMesh(idx) {
        const group = importMeshGroups.get(idx);
        if (!group) {
            if (selectionBox) { _removeSelectionBox(); }
            if (transformCtrl?.object) transformCtrl.detach();
            if (originDot) originDot.visible = false;
            return;
        }
        activeImportIdx = idx;
        if (selectionBox) { _removeSelectionBox(); }
        selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        selectionBox.material.transparent = true;
        selectionBox.material.opacity = 0.35;
        scene.add(selectionBox);
        if (_currentTransformMode !== 'none' && transformCtrl) {
            transformCtrl.attach(group);
            transformCtrl.setMode(_currentTransformMode);
        }
        if (originDot && _originDotVisible) {
            originDot.position.copy(group.position);
            originDot.visible = true;
        }
    },

    playbackStartAll(allAnims, repeat) {
        _pbPlaying = false;
        if (_pbTargets.length > 0 && _pbTime > 0) {
            for (const tgt of _pbTargets) {
                if (tgt.startPos) tgt.obj.position.copy(tgt.startPos);
                if (tgt.startScale) tgt.obj.scale.copy(tgt.startScale);
                if (tgt.startRot) tgt.obj.rotation.set(tgt.startRot.x, tgt.startRot.y, tgt.startRot.z);
            }
        }
        _pbTargets = [];
        for (const a of (allAnims || [])) {
            const key2D = `2d_${a.idx}`;
            let obj = importMeshGroups.get(key2D) || importMeshGroups.get(a.idx);
            let is2D = importMeshGroups.has(key2D);
            if (!obj && a.idx >= 0 && a.idx < tri3dMeshes.length) {
                obj = tri3dMeshes[a.idx];
                is2D = _tri3dIs2D[a.idx] || false;
            }
            if (!obj) continue;
            _pbTargets.push({
                obj,
                is2D,
                sc2D: obj.userData?._2dScale || 1,
                transKf: a.transKf || [],
                scaleKf: a.scaleKf || [],
                rotKf: a.rotKf || [],
                orbitKf: a.orbitKf || [],
                startPos: obj.position.clone(),
                startScale: obj.scale.clone(),
                startRot: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z }
            });
        }
        _pbRepeat = repeat;
        _pbTime = 0;
        _pbLastTs = 0;
        _pbPlaying = true;
        _pbUpdateTimer(0);
        requestAnimationFrame(_pbTick);
    },

    playbackPause() {
        _pbPlaying = false;
    },

    playbackSeek(time) {
        _pbTime = time;
        _pbPlaying = false;
        if (time === 0) {
            for (const tgt of _pbTargets) {
                if (tgt.startPos) tgt.obj.position.copy(tgt.startPos);
                if (tgt.startScale) tgt.obj.scale.copy(tgt.startScale);
                if (tgt.startRot) tgt.obj.rotation.set(tgt.startRot.x, tgt.startRot.y, tgt.startRot.z);
            }
            _tri3dApplyTime(0);
        }
        _pbApplyTime(_pbTime);
        _pbUpdateTimer(_pbTime);
    },

    async createText3D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
        const actualFont = bold ? fontName + '_bold' : fontName;
        const font = await _loadFont(actualFont);
        const group = _buildTextGroup(text, font, thickness, letterSpacing, italic, underline, strike);
        scene.add(group);

        if (currentMesh) currentMesh.visible = false;
        const idx = importMeshGroups.size;
        importMeshGroups.set(idx, group);
        activeImportIdx = idx;

        if (selectionBox) { _removeSelectionBox(); }
        selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        selectionBox.material.transparent = true;
        selectionBox.material.opacity = 0.35;
        scene.add(selectionBox);

        if (_currentTransformMode !== 'none' && transformCtrl) {
            transformCtrl.attach(group);
            transformCtrl.setMode(_currentTransformMode);
        }

        _text3dIndices.add(idx);
        mainDotNetRef?.invokeMethodAsync('OnModelImported', idx + 1, idx);
        mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
        window._pushImportMaterials?.();
        return idx;
    },

    async createText2D(text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
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

        const idx = importMeshGroups.size;
        const key = `2d_${idx}`;
        group.userData._importIdx2D = idx;
        importMeshGroups.set(key, group);
        overlayScene.add(group);
        activeImportIdx = idx;

        if (selectionBox) { _removeSelectionBox(); }
        selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        selectionBox.material.transparent = true;
        selectionBox.material.opacity = 0.35;
        selectionBox.material.depthTest = false;
        selectionBox.userData._overlay = true;
        overlayScene.add(selectionBox);

        if (_currentTransformMode !== 'none' && transformCtrl2D) {
            transformCtrl2D.enabled = true;
            transformCtrl2D.attach(group);
            _apply2DGizmoMode(_currentTransformMode);
        }
        if (transformCtrl) { transformCtrl.detach(); transformCtrl.enabled = false; }

        _text3dIndices.add(idx);
        mainDotNetRef?.invokeMethodAsync('OnImportTabInScene', true);
        window._pushImportMaterials?.();
        return idx;
    },

    async updateText3D(idx, text, fontName, thickness, letterSpacing, bold, italic, underline, strike) {
        const group = importMeshGroups.get(idx);
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

        if (selectionBox) selectionBox.update();
    },

    selectText3D(idx) {
        const group = importMeshGroups.get(idx);
        if (!group) return;
        activeImportIdx = idx;
        if (selectionBox) { _removeSelectionBox(); }
        selectionBox = new THREE.BoxHelper(group, 0x4488ff);
        selectionBox.material.transparent = true;
        selectionBox.material.opacity = 0.35;
        scene.add(selectionBox);
        if (_currentTransformMode !== 'none' && transformCtrl) {
            transformCtrl.attach(group);
            transformCtrl.setMode(_currentTransformMode);
        }
    },

    removeText3D(idx) {
        const group = importMeshGroups.get(idx);
        if (!group) return;
        group.traverse(c => {
            if (c instanceof THREE.Mesh) {
                c.geometry?.dispose();
                if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                else c.material?.dispose();
            }
        });
        scene.remove(group);
        importMeshGroups.delete(idx);
        _text3dIndices.delete(idx);
        if (activeImportIdx === idx) {
            if (selectionBox) { _removeSelectionBox(); }
            if (transformCtrl) transformCtrl.detach();
        }
    },

    removeImportModel(idx) {
        const key2D = `2d_${idx}`;
        const is2D = importMeshGroups.has(key2D);
        const key = is2D ? key2D : idx;
        const group = importMeshGroups.get(key);
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
            importMeshGroups.delete(key);
        }
        _text3dIndices.delete(idx);
        if (selectionBox) { _removeSelectionBox(); }
        if (transformCtrl?.object) transformCtrl.detach();
        if (transformCtrl2D?.object) transformCtrl2D.detach();
        if (originDot) originDot.visible = false;
        activeImportIdx = -1;

        const newCount = importPrev.removeModel(idx);
        return newCount ?? 0;
    },

    // Vide le cache d'objets THREE.js (à appeler au changement de dossier de jeu)
    clearModelCache() {
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
    },

    downloadFile(filename, content) {
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    downloadFileBytes(filename, base64) {
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
    },

    getActiveImportExportData() {
        return this.getImportExportDataByIndex(activeImportIdx);
    },

    getImportExportDataByIndex(idx) {
        const is2D = importMeshGroups.has(`2d_${idx}`);
        const obj = is2D ? importMeshGroups.get(`2d_${idx}`) : importMeshGroups.get(idx);
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
        let data = importPrev.getModelData(idx);
        const baked = !data?.objText;
        if (baked) data = _groupToObjMtl(obj);
        if (!data?.objText) return null;
        return {
            objText: data.objText,
            mtlText: data.mtlText || '',
            posX: obj.position.x - mapOffset.x,
            posY: obj.position.y - mapOffset.y,
            posZ: obj.position.z - mapOffset.z,
            rotX: baked ? 0 : obj.rotation.x,
            rotY: baked ? 0 : obj.rotation.y,
            rotZ: baked ? 0 : obj.rotation.z,
            scaleX: baked ? 1 : obj.scale.x,
            scaleY: baked ? 1 : obj.scale.y,
            scaleZ: baked ? 1 : obj.scale.z
        };
    },

    getImportMaterialsByIndex(idx) {
        const group = importMeshGroups.get(idx) ?? importMeshGroups.get(`2d_${idx}`);
        if (!group) return [];
        const seen = new Set();
        const result = [];
        group.traverse(child => {
            if (!child.isMesh) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => {
                if (!m || seen.has(m.uuid)) return;
                seen.add(m.uuid);
                result.push({ key: m.uuid, name: m.name || '(sans nom)', hex: '#' + (m.color?.getHexString() ?? 'ffffff') });
            });
        });
        return result;
    },

    getTri3DTransform(index) {
        if (index < 0 || index >= tri3dMeshes.length) return null;
        const mesh = tri3dMeshes[index];
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
};

function clearMesh() {
    if (currentMesh) {
        scene.remove(currentMesh);
        if (!currentMeshCacheKey) {
            // Mesh non-caché : disposal complet
            currentMesh.traverse(c => {
                if (c instanceof THREE.Mesh) {
                    c.geometry?.dispose();
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material?.dispose();
                }
            });
        } else {
            // Clone d'un objet caché : dispose uniquement les materials non-partagés (defaultMat)
            currentMesh.traverse(c => {
                if (c instanceof THREE.Mesh) {
                    const mats = Array.isArray(c.material) ? c.material : [c.material].filter(Boolean);
                    mats.forEach(m => { if (m?.userData?.isDefault) m.dispose(); });
                }
            });
        }
        currentMesh = null;
        currentMeshCacheKey = null;
    }
    if (selectionOutline) { scene.remove(selectionOutline); selectionOutline.geometry.dispose(); selectionOutline.material.dispose(); selectionOutline = null; selectedMesh = null; }
}

// ─── Cache persistant IndexedDB ──────────────────────────────────────────────
// Stocke OBJ/MTL par clé "{gameFolderKey}|{pakName}:{index}".
// 1ère session : GBX parsing (lent). Sessions suivantes : lecture IDB (~1ms).
;(function () {
    const IDB_NAME = 'TMNFeditor', IDB_VER = 1, IDB_STORE = 'models';
    let _db = null;
    function openDB() {
        if (_db) return Promise.resolve(_db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VER);
            req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
            req.onsuccess = e => { _db = e.target.result; resolve(_db); };
            req.onerror = () => reject(req.error);
        });
    }
    window.TMNFeditorCache = {
        async get(key) {
            try {
                const db = await openDB();
                return new Promise(r => {
                    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
                    req.onsuccess = () => r(req.result ?? null);
                    req.onerror = () => r(null);
                });
            } catch { return null; }
        },
        async set(key, value) {
            try {
                const db = await openDB();
                return new Promise(r => {
                    const tx = db.transaction(IDB_STORE, 'readwrite');
                    tx.objectStore(IDB_STORE).put(value, key);
                    tx.oncomplete = r; tx.onerror = r;
                });
            } catch {}
        },
        async clear() {
            try {
                const db = await openDB();
                return new Promise(r => {
                    const tx = db.transaction(IDB_STORE, 'readwrite');
                    tx.objectStore(IDB_STORE).clear();
                    tx.oncomplete = r; tx.onerror = r;
                });
            } catch {}
        }
    };
})();

function findMesh(obj, name, materialName) {
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
