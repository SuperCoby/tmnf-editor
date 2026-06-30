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
