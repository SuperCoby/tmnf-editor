import * as THREE from 'three';
import { OrbitControls }    from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TTFLoader } from 'three/addons/loaders/TTFLoader.js';

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
export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a3a);
scene.fog = new THREE.Fog(0x2a2a3a, 200, 800);

export const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
camera.position.set(50, 50, 50);

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight1.position.set(50, 100, 50); dirLight1.castShadow = true; scene.add(dirLight1);
const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight2.position.set(-50, 50, -50); scene.add(dirLight2);
scene.add(new THREE.GridHelper(1024, 32, 0x444444, 0x222222));
scene.add(new THREE.AxesHelper(30));

// ─── Overlay scene/cam ────────────────────────────────────────────────────────
export const overlayScene = new THREE.Scene();
export const overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
overlayCam.position.set(0, 0, 2);

export function _updateOverlayCam() {
    if (!renderer) return;
    const s = renderer.getSize(new THREE.Vector2());
    const aspect = s.x / s.y;
    overlayCam.left = -aspect;
    overlayCam.right = aspect;
    overlayCam.top = 1;
    overlayCam.bottom = -1;
    overlayCam.updateProjectionMatrix();
}

export function _createGridCross() {
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

// ─── Font loaders / maps ──────────────────────────────────────────────────────
export const _fontLoader = new FontLoader();
export const _fontCache = new Map();
export const _ttfLoader = new TTFLoader();

export const _typefaceMap = {
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
export const _fontsourceFonts = new Set([
    'roboto','inter','open-sans','noto-sans','ubuntu','fira-sans','cantarell',
    'arimo','tinos','courier-prime','comic-neue','anton',
    'raleway','libre-franklin','eb-garamond','lora',
    'montserrat','poppins','oswald','playfair-display','merriweather','source-code-pro'
]);
export const _noBoldFonts = new Set(['anton','droid_sans_mono']);

// ─── Loading manager / loaders ────────────────────────────────────────────────
export const loadingManager = new THREE.LoadingManager();
// DDSLoader doit recevoir le même loadingManager pour que le URL modifier s'applique
loadingManager.addHandler(/\.dds$/i, new DDSLoader(loadingManager));
const _missingTextures = new Set();
loadingManager.onError = url => {
    if (_missingTextures.has(url)) return;
    _missingTextures.add(url);
    console.error('[TMNFeditor] Texture manquante:', url);
};
export const objLoader = new OBJLoader();

THREE.Cache.enabled = true;

// ─── Material constants ───────────────────────────────────────────────────────
// Meshes dont le matériau doit être masqué (noms exacts, comparaison insensible à la casse)
export const HIDDEN_MATERIALS = new Set(['stadiumgrassfence']);
export const CLIP_HIDDEN_MATERIALS = new Set(['stadiumgrass', 'stadiumgrassocc']);
// Matériaux avec un canal alpha volontaire (vitres, ventilateurs, glow) — rendu en cutout
export const ALPHA_CUTOUT_MATERIALS = new Set([
    'stadiumstructurealpha', 'stadiumsculptstructurealpha', 'stadiumstructuregeneric',
    'stadiumcontrolauventalpha', 'stadiumfabricauventalpha', 'stadiumplatformauventalpha',
    'stadiumwarpauventalpha', 'stadiumwarpauventalphabis',
    'stadiumturboalpha', 'stadiumcircuitscreen',
    'stadiumroadgrid', 'stadiumlooproadgrid', 'stadiumfan', 'stadiumdirtgrid',
]);
// Matériaux "glow" — pas de vrai cutout, blending additif (lumière qui s'ajoute, pas de découpe)
export const ADDITIVE_GLOW_MATERIALS = new Set(['stadiumwarpspotsglow', 'stadiumwarpspotsglowback']);
// Matériaux avec shader procédural
export const WATER_MATERIALS = new Set(['stadiumwater']);
export const WORLDUV_MATERIALS = new Set(['stadiumgrass', 'stadiumgrassocc', 'stadiumdirt', 'stadiumsculptgrassocc', 'stadiumwarpgrassprelightgen', 'stadiumwarpgrass']);

export const rawModelCache = new Map();  // cacheKey → rawObj THREE.js parsé (template pour clones)
export const MAP_OFFSET_DEFAULT = { x: -512, y: -9, z: -512 };

// ─── Mutable shared state ─────────────────────────────────────────────────────
// Toutes les variables réassignées passent par cet objet pour rester partagées
// entre modules (les bindings ES exportés ne peuvent pas être réassignés ailleurs).
export const S = {
    currentMesh: null,
    currentMeshCacheKey: null,        // non-null si currentMesh est un clone de rawModelCache
    importMeshGroups: new Map(),      // tabIdx → THREE.Group (modèles importés, persistent dans la scène)
    activeImportIdx: 0,               // onglet actif pour les outils (translate/rotate/scale/mirror/visible)
    _activeIs2D: false,              // true si l'import actif est un 2D
    mainDotNetRef: null,              // référence C# pour callbacks JS→Blazor (sélection, import...)
    selectionBox: null,               // BoxHelper discret autour du modèle importé sélectionné
    originDot: null,                  // sphère jaune transparente au point d'origine
    _originDotVisible: false,
    _currentTransformMode: 'none',    // mode actif ('translate'|'rotate'|'scale'|'none')
    importOriginOffsets: new Map(),   // tabIdx → THREE.Vector3 (offset pivot courant)
    tri3dMeshes: [],                  // tableau de THREE.Mesh pour les Triangles3D MediaTracker
    _tri3dIs2D: [],                   // true/false par index: est-ce un Triangles2D (overlay)
    _gridCross: null,
    _gridCursorEl: null,
    _gridVisible: false,
    _text3dIndices: new Set(),
    _activeTri3DIdx: -1,              // index du tri3d sélectionné (-1 = aucun)
    _blockWireframe: null,
    _matAllTextures: {},
    _blockMatInfoEl: null,
    transformCtrl: null,             // TransformControls pour Rotate/Scale de l'import
    transformCtrl2D: null,           // TransformControls pour overlay 2D
    selectionOutline: null,
    selectedMesh: null,
    _waterMaterial: null,
    _blockSelectMode: false,       // false = mesh/material mode, true = block mode
    mapGroup: null,
    mapOffset: { ...MAP_OFFSET_DEFAULT },
    currentBlobUrlMap: {},           // filename.dds → blobUrl (mis à jour par setBlobUrlMap)
    // Playback
    _pbTargets: [],                  // [{obj, transKf, scaleKf, rotKf, orbitKf, startPos, startScale, startRot}]
    _pbPlaying: false,
    _pbRepeat: false,
    _pbTime: 0,
    _pbLastTs: 0,
};

export function _apply2DGizmoMode(mode) {
    if (!S.transformCtrl2D) return;
    S.transformCtrl2D.setMode(mode);
    S.transformCtrl2D.showZ = (mode === 'rotate');
}

export function getWaterMaterial() {
    if (S._waterMaterial) return S._waterMaterial;
    S._waterMaterial = new THREE.ShaderMaterial({
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
    return S._waterMaterial;
}
