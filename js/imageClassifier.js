/**
 * CLASIFICADOR DE IMÁGENES (CLIP zero-shot con transformers.js, 100% en el navegador).
 * Se descarga una sola vez (~88 MB) y queda en la caché del navegador.
 * Mejoras: varios prompts por clase (ensamble), clase "other" para descartar fotos no relacionadas,
 * umbrales centralizados y caché de resultados por imagen.
 */
const CLASSIFIER_CONFIG = {
    lib: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
    model: 'Xenova/clip-vit-base-patch32',
    labels: {
        meter: ['a photo of an electricity meter', 'a close-up photo of an energy meter mounted on a wall', 'a photo of a utility meter with a digital display'],
        breaker: ['a photo of an electrical breaker panel with switches', 'a photo of a circuit breaker box'],
        id: ['a photo of an identity card document', 'a photo of a national id card'],
        bill: ['a photo of a printed electricity bill paper', 'a photo of a utility invoice'],
        letter: ['a photo of a handwritten letter or printed form', 'a photo of a typed document page'],
        house: ['a photo of the front of a house', 'a photo of the facade of a home'],
        roof: ['a photo of a roof', 'a photo of a house roof structure with tiles or metal sheets'],
        patio: ['a photo of a patio', 'a photo of a backyard of a house'],
        garden: ['a photo of a front garden of a house'],
        person: ['a photo of a person', 'a portrait photo of a person'],
        signature: ['a handwritten signature on white paper'],
        other: ['a photo of an unrelated object', 'a blurry dark photo']
    },
    // Umbrales (% de confianza). Calibrarlos con el módulo de calidad (evaluator.js).
    thresholds: {
        electricalOk: 45,      // contador/breaker confirmado
        breakerAsMeter: 50,    // foto de breaker que parece contador
        wrongImage: 60,        // documento/persona donde se pide equipo eléctrico
        personOk: 40,          // ítem 29: foto de la persona
        photoWrongDoc: 60,     // documento donde se pide una foto
        houseOk: 50            // ítem 100: foto de la casa
    },
    cacheSize: 300
};

let classifierPromise = null;
let classifierEnabled = true;
const classificationCache = new Map();

function setClassifierEnabled(value) { classifierEnabled = !!value; }

function loadClassifier() {
    if (!classifierPromise) {
        classifierPromise = (async () => {
            const { pipeline, env } = await import(CLASSIFIER_CONFIG.lib);
            env.allowLocalModels = false;
            return pipeline('zero-shot-image-classification', CLASSIFIER_CONFIG.model);
        })().catch(error => {
            console.warn('No se pudo cargar el clasificador de imágenes:', error);
            return null;
        });
    }
    return classifierPromise;
}

/** Huella barata de la imagen: tamaño + 96 muestras repartidas de los píxeles */
function imageFingerprint(px) {
    const data = px.rgba, step = Math.max(4, Math.floor(data.length / 96) & ~3);
    let h = 2166136261;
    for (let i = 0; i < data.length; i += step) h = Math.imul(h ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
    return `${px.width}x${px.height}:${h >>> 0}`;
}

/** { top, confidence (0-100), scores } o null si el clasificador no está disponible */
async function classifyImage(px) {
    if (!classifierEnabled || !px) return null;
    const cacheKey = imageFingerprint(px);
    if (classificationCache.has(cacheKey)) return classificationCache.get(cacheKey);

    const classifier = await loadClassifier();
    if (!classifier) return null;
    let url = null;
    try {
        const canvas = rgbaToCanvas(px.rgba, px.width, px.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        url = URL.createObjectURL(blob);

        const promptToKey = {};
        Object.entries(CLASSIFIER_CONFIG.labels).forEach(([key, prompts]) => prompts.forEach(p => { promptToKey[p] = key; }));
        const output = await classifier(url, Object.keys(promptToKey), { hypothesis_template: '{}' });

        const raw = {};
        output.forEach(o => { const key = promptToKey[o.label]; if (key) raw[key] = (raw[key] || 0) + o.score; });
        const scores = {};
        Object.keys(raw).forEach(k => { scores[k] = Math.round(raw[k] * 100); });
        const top = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
        const result = { top, confidence: scores[top], scores };

        if (classificationCache.size >= CLASSIFIER_CONFIG.cacheSize) classificationCache.delete(classificationCache.keys().next().value);
        classificationCache.set(cacheKey, result);
        return result;
    } catch (error) {
        console.warn('Error al clasificar la imagen:', error);
        return null;
    } finally {
        if (url) URL.revokeObjectURL(url);
    }
}

const CLASSIFIER_NAMES = {
    meter: 'un contador', breaker: 'un tablero de breakers', id: 'una cédula', bill: 'un recibo',
    letter: 'un documento o carta', house: 'una casa', roof: 'un techo', patio: 'un patio',
    garden: 'un antejardín', person: 'una persona', signature: 'una firma', other: 'otro objeto'
};
const CLASSIFIER_NOT_PHOTO = ['id', 'bill', 'letter', 'signature'];

/**
 * Refina el veredicto del OCR con la clasificación. Conservador:
 *  - Solo marca error si la imagen es claramente un documento/firma (o persona donde no se pide).
 *  - Confirma (ok) contador/breaker, casa y persona cuando coincide con buena confianza.
 *  - Si el clasificador no tiene certeza ("other"), no cambia el veredicto.
 */
function refineWithClassification(exp, id, result, cls) {
    if (!cls || (result.verdict === 'fail' && result.code === 'image_quality')) return result;
    const { top, confidence } = cls;
    const T = CLASSIFIER_CONFIG.thresholds;
    const seen = `${CLASSIFIER_NAMES[top] || top} (${confidence}%)`;
    const wrong = what => ({ verdict: 'fail', code: 'wrong_image', message: `Parece ${seen}; se requiere ${what}.` });

    if (exp.kind === 'meter' || exp.kind === 'breaker') {
        if (exp.kind === 'breaker' && top === 'meter' && confidence >= T.breakerAsMeter) {
            return { verdict: 'review', message: `Parece contador (${confidence}%); revisar si la foto muestra el tablero.` };
        }
        if (['meter', 'breaker'].includes(top) && confidence >= T.electricalOk) {
            if (result.verdict === 'ok') return result;
            return { verdict: 'ok', note: `Imagen verificada por clasificador: parece ${seen} (equipo eléctrico)` };
        }
        if ((CLASSIFIER_NOT_PHOTO.includes(top) || top === 'person') && confidence >= T.wrongImage) {
            return wrong(exp.kind === 'meter' ? 'el contador' : 'el tablero eléctrico');
        }
        return result;
    }

    if (exp.kind === 'photo') {
        if (id === 29) {
            if (top === 'person' && confidence >= T.personOk) return { verdict: 'ok', note: `Imagen verificada por clasificador: parece ${seen}` };
            if (CLASSIFIER_NOT_PHOTO.includes(top) && confidence >= T.photoWrongDoc) return wrong(exp.what);
            return result;
        }
        if (CLASSIFIER_NOT_PHOTO.includes(top) && confidence >= T.photoWrongDoc) return wrong(exp.what);
        if (id === 100 && top === 'house' && confidence >= T.houseOk && result.verdict !== 'ok') {
            return { verdict: 'ok', note: `Imagen verificada por clasificador: parece ${seen}` };
        }
        if (result.verdict === 'ok' && !(result.note || '').includes('clasificador')) {
            return { ...result, note: `${result.note ? result.note + '; ' : ''}el clasificador ve ${seen}` };
        }
    }
    return result;
}
