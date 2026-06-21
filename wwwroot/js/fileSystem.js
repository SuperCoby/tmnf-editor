// File System Access API — interop pour Blazor WASM
window.TMNFeditorFS = (function () {

    let dirHandle = null;

    // Demande à l'utilisateur de sélectionner le dossier racine du jeu
    // (le dossier qui contient Nadeo.ini, Packs\, GameData\)
    async function selectGameFolder() {
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'read' });
            return dirHandle.name;
        } catch (e) {
            if (e.name === 'AbortError') return null;
            throw e;
        }
    }

    // Retourne le nom du dossier sélectionné (ou null)
    function getGameFolderName() {
        return dirHandle ? dirHandle.name : null;
    }

    // Liste les fichiers .pak dans le sous-dossier Packs/
    async function listPakFiles() {
        if (!dirHandle) return [];
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
                paks.push(name.slice(0, -4)); // sans extension
        }
        return paks.sort();
    }

    // Lit un fichier .pak et retourne ses octets (Uint8Array → byte[] côté C#)
    async function readPakBytes(pakName) {
        if (!dirHandle) throw new Error('Aucun dossier de jeu sélectionné');
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

    // Résout un nom de texture DDS en blob URL — cherche dans plusieurs dossiers GameData
    const blobUrlCache = new Map();
    const TEXTURE_PATHS = [
        // pakName est inséré dynamiquement en premier
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
        if (!dirHandle) return null;

        const paths = [
            ['GameData', pakName, 'Media', 'Texture', 'Image'],
            ...TEXTURE_PATHS.slice(1),
        ];

        for (const segments of paths) {
            try {
                let handle = dirHandle;
                for (const seg of segments) handle = await handle.getDirectoryHandle(seg);
                const fileHandle = await handle.getFileHandle(filename);
                const file = await fileHandle.getFile();

                // Vérifie le magic DDS ("DDS " = 0x20534444 little-endian)
                const headerBuf = await file.slice(0, 4).arrayBuffer();
                if (new Uint32Array(headerBuf)[0] !== 0x20534444) continue;

                const url = URL.createObjectURL(file);
                blobUrlCache.set(cacheKey, url);
                return url;
            } catch { }
        }
        return null;
    }

    // Libère tous les blob URLs créés
    function revokeBlobUrls() {
        for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
        blobUrlCache.clear();
    }

    // Construit un mapping {filename.dds → blobUrl} pour les textures référencées dans un MTL
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
        // Toutes les textures en parallèle au lieu de les charger une par une
        const urls = await Promise.all(filenames.map(f => getTextureBlobUrl(pakName, f)));
        const map = {};
        for (let i = 0; i < filenames.length; i++)
            if (urls[i]) map[filenames[i]] = urls[i];
        return map;
    }

    // Crée des blob URLs depuis des octets bruts DDS (base64 depuis C#)
    function createTextureBlobUrlsFromBytes(textures, pakName) {
        const map = {};
        for (const [filename, data] of Object.entries(textures)) {
            try {
                let arr;
                if (typeof data === 'string') {
                    // Blazor sérialise byte[] en base64
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

    // Ouvre un sélecteur de fichier pour choisir un .Challenge.Gbx
    async function pickChallengeFile() {
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

    return { selectGameFolder, getGameFolderName, listPakFiles, readPakBytes, buildTextureBlobUrlMap, createTextureBlobUrlsFromBytes, revokeBlobUrls, pickChallengeFile };
})();
