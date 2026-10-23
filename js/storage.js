/**
 * PERSISTENCIA LOCAL (IndexedDB) v2
 *  - 'docs'  : ítems y metadatos de cada PDF (se reescribe en cada edición, es liviano)
 *  - 'files' : el PDF original (se guarda una sola vez, no en cada edición)
 * Compatible con registros v1 (que traían el archivo dentro de 'docs').
 */
const DB_NAME = 'caracter-auditoria';
const DB_STORE = 'docs';
const FILE_STORE = 'files';
const DB_VERSION = 2;
let dbPromise = null;

const storedFileRefs = new Map();   // key -> File ya guardado (evita reescribir el binario)
let lastQuotaCheck = 0;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'key' });
                if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'key' });
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { db.close(); dbPromise = null; };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

/** Ejecuta `action(stores)` en una transacción sobre uno o varios stores */
async function dbRun(mode, action, stores = [DB_STORE]) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        const objs = stores.map(name => tx.objectStore(name));
        const result = action(...objs);
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** Avisa una sola vez cuando el almacenamiento supera el 85 % de la cuota */
async function checkStorageQuota() {
    const now = Date.now();
    if (now - lastQuotaCheck < 20000 || !navigator.storage || !navigator.storage.estimate) return;
    lastQuotaCheck = now;
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (quota && usage / quota > 0.85 && !checkStorageQuota.warned) {
            checkStorageQuota.warned = true;
            showToast(`Almacenamiento del navegador al ${Math.round(usage / quota * 100)}%. Exporta y limpia sesiones antiguas.`, 'warning', 9000);
        }
    } catch (_) { /* opcional */ }
}

/** Guarda (o actualiza) un PDF ya procesado: ítems siempre, archivo solo si cambió */
async function saveDocument(key) {
    const doc = pdfDocuments[key];
    if (!doc) return;
    const { file, ...meta } = doc;
    try {
        const writeFile = Boolean(file) && storedFileRefs.get(key) !== file;
        await dbRun('readwrite', (docs, files) => {
            docs.put({ key, ...meta, hasFile: Boolean(file) });
            if (writeFile) files.put({ key, file });
        }, [DB_STORE, FILE_STORE]);
        if (writeFile) storedFileRefs.set(key, file);
        if (typeof syncReport === 'function') syncReport(key);
        checkStorageQuota();
    } catch (err) {
        console.warn('No se pudo guardar', key, err);
        if (!saveDocument.warned) {
            saveDocument.warned = true;
            showToast('No se pudo guardar el avance en el navegador (¿almacenamiento lleno?)', 'warning', 8000);
        }
    }
}

async function deleteStoredDocument(key) {
    storedFileRefs.delete(key);
    try {
        await dbRun('readwrite', (docs, files) => { docs.delete(key); files.delete(key); }, [DB_STORE, FILE_STORE]);
    } catch (err) { console.warn(err); }
}

async function clearStoredDocuments() {
    storedFileRefs.clear();
    try {
        await dbRun('readwrite', (docs, files) => { docs.clear(); files.clear(); }, [DB_STORE, FILE_STORE]);
    } catch (err) { console.warn(err); }
}

async function loadStoredDocuments() {
    try {
        const db = await openDb();
        const [docs, files] = await new Promise((resolve, reject) => {
            const tx = db.transaction([DB_STORE, FILE_STORE], 'readonly');
            const a = tx.objectStore(DB_STORE).getAll();
            const b = tx.objectStore(FILE_STORE).getAll();
            tx.oncomplete = () => resolve([a.result, b.result]);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        const fileMap = new Map(files.map(f => [f.key, f.file]));
        return docs.map(rec => {
            if (!rec.file && fileMap.has(rec.key)) rec.file = fileMap.get(rec.key);
            if (rec.file) storedFileRefs.set(rec.key, rec.file);
            return rec;
        });
    } catch (err) {
        console.warn('No se pudo leer el avance guardado', err);
        return [];
    }
}

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
