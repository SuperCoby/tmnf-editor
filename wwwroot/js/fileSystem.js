// File System Access API — interop pour Blazor WASM
// Fallback <input type="file"> pour Firefox / Safari
window.TMNFeditorFS = (function () {

    let dirHandle = null;
    // Fallback: stocke les fichiers indexés par chemin relatif
    let fallbackFiles = null; // Map<relativePath, File>
    let fallbackFolderName = null;

    const hasNativeFS = typeof window.showDirectoryPicker === 'function';

    // ── Helpers fallback ──────────────────────────────────────────────────

    function _createHiddenInput(attrs) {
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
        document.body.appendChild(input);
        return input;
    }

    function _pickViaInput(attrs) {
        return new Promise(resolve => {
            const input = _createHiddenInput(attrs);
            input.addEventListener('change', () => {
                resolve(input.files);
                input.remove();
            });
            input.addEventListener('cancel', () => { resolve(null); input.remove(); });
            input.click();
        });
    }

    // ── selectGameFolder ──────────────────────────────────────────────────

    async function selectGameFolder() {
        if (hasNativeFS) {
            try {
                dirHandle = await window.showDirectoryPicker({ mode: 'read' });
                fallbackFiles = null;
                return dirHandle.name;
            } catch (e) {
                if (e.name === 'AbortError') return null;
                throw e;
            }
        }
        // Fallback: <input webkitdirectory>
        const files = await _pickViaInput({ webkitdirectory: '', multiple: '' });
        if (!files || files.length === 0) return null;
        const tempMap = new Map();
        let rootName = null;
        for (const f of files) {
            const rel = f.webkitRelativePath;
            if (!rootName) rootName = rel.split('/')[0];
            const sub = rel.substring(rootName.length + 1);
            if (sub) tempMap.set(sub.toLowerCase(), f);
        }
        fallbackFiles = tempMap;
        dirHandle = null;
        fallbackFolderName = rootName;
        return rootName;
    }

    function getGameFolderName() {
        if (dirHandle) return dirHandle.name;
        return fallbackFolderName || null;
    }

    // ── listPakFiles ──────────────────────────────────────────────────────

    async function listPakFiles() {
        if (dirHandle) {
            let packsDir = null;
            for await (const [name, handle] of dirHandle.entries()) {
                if (handle.kind === 'directory' &&
                    (name.toLowerCase() === 'packs' || name.toLowerCase() === 'pack')) {
                    packsDir = handle;
                    break;
                }
            }
            if (!packsDir) return [];
            const paks = [];
            for await (const [name] of packsDir.entries()) {
                if (name.toLowerCase().endsWith('.pak'))
                    paks.push(name.slice(0, -4));
            }
            return paks.sort();
        }
        if (!fallbackFiles) return [];
        const paks = new Set();
        for (const path of fallbackFiles.keys()) {
            const m = path.match(/^packs?\/([^/]+)\.pak$/i);
            if (m) paks.add(m[1]);
        }
        return [...paks].sort();
    }

    // ── readPakBytes ──────────────────────────────────────────────────────

    async function readPakBytes(pakName) {
        if (dirHandle) {
            let packsDir = null;
            for await (const [name, handle] of dirHandle.entries()) {
                if (handle.kind === 'directory' &&
                    (name.toLowerCase() === 'packs' || name.toLowerCase() === 'pack')) {
                    packsDir = handle;
                    break;
                }
            }
            if (!packsDir) throw new Error('Dossier Packs introuvable');
            const fileHandle = await packsDir.getFileHandle(pakName + '.pak');
            const file = await fileHandle.getFile();
            const buffer = await file.arrayBuffer();
            return new Uint8Array(buffer);
        }
        if (!fallbackFiles) throw new Error('Aucun dossier de jeu sélectionné');
        const key = `packs/${pakName}.pak`;
        const f = _fallbackFind(key);
        if (!f) throw new Error('Fichier .pak introuvable: ' + pakName);
        const buffer = await f.arrayBuffer();
        return new Uint8Array(buffer);
    }

    function _fallbackFind(relPath) {
        if (!fallbackFiles) return null;
        return fallbackFiles.get(relPath.toLowerCase()) || null;
    }

    // ── Textures ──────────────────────────────────────────────────────────

    const blobUrlCache = new Map();
    const TEXTURE_PATHS = [
        null,
        ['GameData', 'Clouds',    'Media', 'Texture', 'Image'],
        ['GameData', 'Garage',    'Media', 'Texture', 'Image'],
        ['GameData', 'Interface', 'Advertising'],
        ['GameData', 'Interface', 'Media', 'Texture', 'Image'],
        ['GameData', 'Vehicles',  'Media', 'Texture', 'Image'],
    ];

    async function getTextureBlobUrl(pakName, filename) {
        const cacheKey = `${pakName}/${filename}`;
        if (blobUrlCache.has(cacheKey)) return blobUrlCache.get(cacheKey);

        const paths = [
            ['GameData', pakName, 'Media', 'Texture', 'Image'],
            ...TEXTURE_PATHS.slice(1),
        ];

        if (dirHandle) {
            for (const segments of paths) {
                try {
                    let handle = dirHandle;
                    for (const seg of segments) handle = await handle.getDirectoryHandle(seg);
                    const fileHandle = await handle.getFileHandle(filename);
                    const file = await fileHandle.getFile();
                    const headerBuf = await file.slice(0, 4).arrayBuffer();
                    if (new Uint32Array(headerBuf)[0] !== 0x20534444) continue;
                    const url = URL.createObjectURL(file);
                    blobUrlCache.set(cacheKey, url);
                    return url;
                } catch { }
            }
        } else if (fallbackFiles) {
            for (const segments of paths) {
                const rel = segments.join('/') + '/' + filename;
                const file = _fallbackFind(rel);
                if (!file) continue;
                try {
                    const headerBuf = await file.slice(0, 4).arrayBuffer();
                    if (new Uint32Array(headerBuf)[0] !== 0x20534444) continue;
                    const url = URL.createObjectURL(file);
                    blobUrlCache.set(cacheKey, url);
                    return url;
                } catch { }
            }
        }
        return null;
    }

    function revokeBlobUrls() {
        for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
        blobUrlCache.clear();
    }

    async function buildTextureBlobUrlMap(mtlText, pakName) {
        const filenames = [];
        const seen = new Set();
        for (const line of mtlText.split('\n')) {
            const t = line.trim();
            if (t.startsWith('map_Kd ') || t.startsWith('map_Ks ') || t.startsWith('bump ')) {
                const filename = t.substring(t.indexOf(' ') + 1).trim();
                if (filename && !seen.has(filename)) { seen.add(filename); filenames.push(filename); }
            }
        }
        return buildTextureBlobUrlMapForNames(filenames, pakName);
    }

    // Comme buildTextureBlobUrlMap mais reçoit directement la liste de noms de fichiers
    // (évite de re-parser le MTL pour chaque block — un seul appel pour tous les blocks d'un pak).
    async function buildTextureBlobUrlMapForNames(filenames, pakName) {
        const urls = await Promise.all(filenames.map(f => getTextureBlobUrl(pakName, f)));
        const map = {};
        for (let i = 0; i < filenames.length; i++)
            if (urls[i]) map[filenames[i]] = urls[i];
        return map;
    }

    function createTextureBlobUrlsFromBytes(textures, pakName) {
        const map = {};
        for (const [filename, data] of Object.entries(textures)) {
            try {
                let arr;
                if (typeof data === 'string') {
                    const raw = atob(data);
                    arr = new Uint8Array(raw.length);
                    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
                } else if (data instanceof Uint8Array) {
                    arr = data;
                } else {
                    arr = new Uint8Array(Object.values(data));
                }
                const blob = new Blob([arr], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                blobUrlCache.set(filename, url);
                if (pakName) blobUrlCache.set(`${pakName}/${filename}`, url);
                map[filename] = url;
            } catch { }
        }
        return map;
    }

    // ── pickChallengeFile ─────────────────────────────────────────────────

    async function pickChallengeFile() {
        if (hasNativeFS) {
            try {
                const [fh] = await window.showOpenFilePicker({
                    types: [{ description: 'Carte GBX', accept: { 'application/octet-stream': ['.Gbx', '.gbx'] } }],
                    multiple: false
                });
                const file = await fh.getFile();
                const buffer = await file.arrayBuffer();
                return { name: file.name, bytes: new Uint8Array(buffer) };
            } catch (e) {
                if (e.name === 'AbortError') return null;
                throw e;
            }
        }
        // Fallback: <input accept=".gbx">
        const files = await _pickViaInput({ accept: '.gbx,.Gbx' });
        if (!files || files.length === 0) return null;
        const file = files[0];
        const buffer = await file.arrayBuffer();
        return { name: file.name, bytes: new Uint8Array(buffer) };
    }

    return { selectGameFolder, getGameFolderName, listPakFiles, readPakBytes, buildTextureBlobUrlMap, buildTextureBlobUrlMapForNames, createTextureBlobUrlsFromBytes, revokeBlobUrls, pickChallengeFile };
})();
