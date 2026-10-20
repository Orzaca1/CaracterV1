/**
 * PERSISTENCIA LOCAL (IndexedDB): conserva los PDFs revisados aunque se cierre o reinicie el navegador
 */
const DB_NAME = 'caracter-auditoria';
const DB_STORE = 'docs';
let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'key' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

async function dbRun(mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const result = action(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** Guarda (o actualiza) un PDF ya procesado con sus ítems y el archivo original */
async function saveDocument(key) {
    const doc = pdfDocuments[key];
    if (!doc) return;
    try {
        await dbRun('readwrite', store => store.put({ key, ...doc }));
        if (typeof syncReport === 'function') syncReport(key);
    } catch (err) {
        console.warn('No se pudo guardar', key, err);
        if (!saveDocument.warned) {
            saveDocument.warned = true;
            showToast('No se pudo guardar el avance en el navegador (¿almacenamiento lleno?)', 'warning', 8000);
        }
    }
}

async function deleteStoredDocument(key) {
    try { await dbRun('readwrite', store => store.delete(key)); } catch (err) { console.warn(err); }
}

async function clearStoredDocuments() {
    try { await dbRun('readwrite', store => store.clear()); } catch (err) { console.warn(err); }
}

async function loadStoredDocuments() {
    try {
        return await dbRun('readonly', store => store.getAll());
    } catch (err) {
        console.warn('No se pudo leer el avance guardado', err);
        return [];
    }
}

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
