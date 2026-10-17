/**
 * CLASIFICADOR DE IMÁGENES (CLIP zero-shot con transformers.js, 100% en el navegador).
 * Se descarga una sola vez (~88 MB) y queda en la caché del navegador.
 * Si no se puede cargar, devuelve null y la verificación sigue solo con OCR.
 */
const CLASSIFIER_CONFIG = {
    lib: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
    model: 'Xenova/clip-vit-base-patch32',
    labels: {
        meter: 'a photo of an electricity meter',
        breaker: 'a photo of an electrical breaker panel with switches',
        id: 'a photo of an identity card document',
        bill: 'a photo of a printed electricity bill paper',
        letter: 'a photo of a handwritten letter or printed form',
        house: 'a photo of the front of a house',
        roof: 'a photo of a roof',
        patio: 'a photo of a patio',
        garden: 'a photo of a front garden of a house',
        person: 'a photo of a person',
        signature: 'a handwritten signature on white paper'
    }
};

let classifierPromise = null;
let classifierEnabled = true;

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

/** { top, confidence (0-100), scores } o null si el clasificador no está disponible */
async function classifyImage(px) {
    if (!classifierEnabled || !px) return null;
    const classifier = await loadClassifier();
    if (!classifier) return null;
    let url = null;
    try {
        const canvas = rgbaToCanvas(px.rgba, px.width, px.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        url = URL.createObjectURL(blob);
        const keys = Object.keys(CLASSIFIER_CONFIG.labels);
        const output = await classifier(url, keys.map(k => CLASSIFIER_CONFIG.labels[k]), { hypothesis_template: '{}' });
        const scores = {};
        output.forEach(o => {
            const key = keys.find(k => CLASSIFIER_CONFIG.labels[k] === o.label);
            if (key) scores[key] = Math.round(o.score * 100);
        });
        const top = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
        return { top, confidence: scores[top], scores };
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
    garden: 'un antejardín', person: 'una persona', signature: 'una firma'
};
const CLASSIFIER_NOT_PHOTO = ['id', 'bill', 'letter', 'signature'];

/**
 * Refina el veredicto del OCR con la clasificación. Conservador:
 *  - Solo marca error si la imagen es claramente un documento/firma (o persona donde no se pide).
 *  - Confirma (ok) contador/breaker, casa y persona cuando coincide con buena confianza.
 */
function refineWithClassification(exp, id, result, cls) {
    if (!cls || result.verdict === 'fail' && result.code === 'image_quality') return result;
    const { top, confidence } = cls;
    const seen = `${CLASSIFIER_NAMES[top]} (${confidence}%)`;

    if (exp.kind === 'meter' || exp.kind === 'breaker') {
        if (['meter', 'breaker'].includes(top) && confidence >= 45) {
            if (result.verdict === 'ok') return result;
            return { verdict: 'ok', note: `Imagen verificada por clasificador: parece ${seen} (equipo eléctrico)` };
        }
        if ((CLASSIFIER_NOT_PHOTO.includes(top) || top === 'person') && confidence >= 60) {
            return { verdict: 'fail', code: 'wrong_image',
                     message: `La imagen parece ${seen}; se solicita ${exp.kind === 'meter' ? 'el contador o medidor' : 'los breakers o tablero eléctrico'}` };
        }
        return result;
    }

    if (exp.kind === 'photo') {
        if (id === 29) {
            if (top === 'person' && confidence >= 40) return { verdict: 'ok', note: `Imagen verificada por clasificador: parece ${seen}` };
            if (CLASSIFIER_NOT_PHOTO.includes(top) && confidence >= 60) {
                return { verdict: 'fail', code: 'wrong_image', message: `La imagen parece ${seen}; se solicita ${exp.what}` };
            }
            return result;
        }
        if (CLASSIFIER_NOT_PHOTO.includes(top) && confidence >= 60) {
            return { verdict: 'fail', code: 'wrong_image', message: `La imagen parece ${seen}; se solicita ${exp.what}` };
        }
        if (id === 100 && top === 'house' && confidence >= 50 && result.verdict !== 'ok') {
            return { verdict: 'ok', note: `Imagen verificada por clasificador: parece ${seen}` };
        }
        if (result.verdict === 'ok' && !result.note.includes('clasificador')) {
            return { ...result, note: `${result.note}; el clasificador ve ${seen}` };
        }
    }
    return result;
}
