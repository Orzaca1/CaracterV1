/**
 * VERIFICACIÓN DEL CONTENIDO DE LAS IMÁGENES (todo ocurre en el navegador: no se envía nada a internet)
 *
 *  - Presencia: la resuelve pdfReader.js (imagen incrustada o nombre de archivo).
 *  - Calidad: imagen en blanco / de un solo color / muy pequeña.
 *  - Firmas: debe haber trazos de tinta.
 *  - Documentos (cédula, recibo, certificado, autorización...): OCR local con Tesseract.js;
 *    se buscan palabras propias del documento y se cruzan números (cédula, NIC, matrícula).
 *  - Fotografías (fachada, techo, patio...): se rechazan si en realidad son un documento.
 *
 * Resultado por imagen: ok | review (no se pudo confirmar) | fail (no corresponde).
 * Limitación: sin un modelo de visión no se puede distinguir, por ejemplo, un patio de un techo.
 */
const OCR_CONFIG = {
    lang: 'spa',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa@1.0.0/4.0.0_best_int',
    gzip: true,
    workers: 2,        // procesos de OCR en paralelo
    maxSide: 1800,     // se reduce la imagen si es más grande (velocidad)
    toInput: (rgba, w, h) => rgbaToCanvas(rgba, w, h)
};

/** Qué debe contener la imagen de cada ítem */
const IMAGE_EXPECT = {
    23:  { kind: 'doc', doc: 'autorizacion' },
    28:  { kind: 'signature' },
    29:  { kind: 'photo', what: 'una fotografía de la persona' },
    32:  { kind: 'doc', doc: 'certificado' },
    33:  { kind: 'doc', doc: 'certificado' },
    34:  { kind: 'doc', doc: 'autorizacion' },
    35:  { kind: 'doc', doc: 'cedula', side: 'anverso' },
    36:  { kind: 'doc', doc: 'cedula', side: 'reverso' },
    53:  { kind: 'doc', doc: 'discapacidad' },
    54:  { kind: 'doc', doc: 'discapacidad' },
    100: { kind: 'photo', what: 'una fotografía del frente de la casa' },
    101: { kind: 'photo', what: 'una fotografía de las construcciones aledañas' },
    102: { kind: 'meter' },
    103: { kind: 'breaker' },
    104: { kind: 'doc', doc: 'recibo' },
    106: { kind: 'photo', what: 'una fotografía del techo y su estructura' },
    107: { kind: 'photo', what: 'una fotografía del patio' },
    108: { kind: 'photo', what: 'una fotografía del antejardín' },
    109: { kind: 'photo', what: 'una fotografía del espacio disponible para la instalación' },
    129: { kind: 'signature' },
    133: { kind: 'signature' }
};

/** Palabras propias de cada documento (en minúsculas y sin tildes) + ítem cuyo número debe aparecer */
const DOC_FAMILIES = {
    cedula: {
        label: 'un documento de identidad (cédula)', min: 2, idItems: [17, 40],
        sides: {
            anverso: ['republica de colombia', 'identificacion personal', 'cedula de ciudadania', 'apellidos', 'nombres'],
            reverso: ['fecha y lugar de expedicion', 'indice derecho', 'registrador nacional', 'grupo sanguineo', 'fecha de nacimiento']
        },
        words: ['republica de colombia', 'identificacion personal', 'cedula de ciudadania', 'apellidos', 'nombres',
                'fecha de nacimiento', 'estatura', 'lugar de nacimiento', 'fecha y lugar de expedicion',
                'registrador nacional', 'indice derecho', 'sexo']
    },
    recibo: {
        label: 'un recibo de energía', min: 2, idItems: [86],
        words: ['nic', 'air e', 'factura', 'energia', 'consumo', 'lectura', 'total a pagar', 'kwh', 'medidor',
                'periodo', 'vencimiento', 'paga facil', 'novedad', 'tarifa', 'comercializador']
    },
    certificado: {
        label: 'un certificado de tradición y libertad', min: 2, idItems: [30],
        words: ['superintendencia de notariado', 'certificado de tradicion', 'matricula inmobiliaria', 'oficina de registro',
                'instrumentos publicos', 'tradicion y libertad', 'folio de matricula', 'naturaleza juridica', 'registro', 'notariado']
    },
    autorizacion: {
        label: 'una carta de autorización', min: 2, idItems: [17, 40],
        words: ['autorizo', 'autorizacion', 'identificado con', 'cedula de ciudadania', 'entregar informacion',
                'colombia solar', 'propietario', 'cordialmente', 'atentamente']
    },
    discapacidad: {
        label: 'un certificado de discapacidad', min: 2, idItems: [],
        words: ['discapacidad', 'certificado de discapacidad', 'registro para la localizacion', 'ministerio de salud', 'caracterizacion']
    }
};

/* ============ ANÁLISIS DE PÍXELES ============ */

/** Media, desviación y proporción de "tinta" (píxeles oscuros) sobre una muestra */
function imageStats(px) {
    const { width: w, height: h, rgba } = px;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
    let n = 0, opaque = 0, sum = 0, sum2 = 0, ink = 0;
    for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
            const o = (y * w + x) * 4;
            n++;
            if (rgba[o + 3] < 20) continue;                      // transparente (fondo de firma)
            const lum = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
            opaque++;
            sum += lum;
            sum2 += lum * lum;
            if (lum < 140) ink++;
        }
    }
    const mean = opaque ? sum / opaque : 0;
    const std = opaque ? Math.sqrt(Math.max(0, sum2 / opaque - mean * mean)) : 0;
    return { w, h, mean, std, inkRatio: n ? ink / n : 0, opaqueRatio: n ? opaque / n : 0 };
}

async function imageQualityFromFile(file) {
    const bitmap = await createImageBitmap(file);
    try {
        const scale = Math.min(1, 700 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        return judgeQuality(imageStats({
            width: pixels.width,
            height: pixels.height,
            rgba: pixels.data
        }));
    } finally {
        bitmap.close();
    }
}

/* ============ OCR ============ */

let ocrIdle = [];
const ocrWaiters = [];
let ocrInitPromise = null;

function rgbaToCanvas(rgba, w, h) {
    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    const scale = Math.min(1, OCR_CONFIG.maxSide / Math.max(w, h));
    if (scale === 1) return src;
    const dst = document.createElement('canvas');
    dst.width = Math.round(w * scale);
    dst.height = Math.round(h * scale);
    dst.getContext('2d').drawImage(src, 0, 0, dst.width, dst.height);
    return dst;
}

/** Crea los procesos de OCR una sola vez. false si Tesseract no está disponible */
function initOcr() {
    if (typeof Tesseract === 'undefined') return Promise.resolve(false);
    if (!ocrInitPromise) {
        ocrInitPromise = (async () => {
            for (let i = 0; i < OCR_CONFIG.workers; i++) {
                ocrIdle.push(await Tesseract.createWorker(OCR_CONFIG.lang, 1, {
                    langPath: OCR_CONFIG.langPath,
                    gzip: OCR_CONFIG.gzip
                }));
            }
            return true;
        })().catch(error => {
            console.error('No se pudo iniciar el OCR:', error);
            return false;
        });
    }
    return ocrInitPromise;
}

function acquireOcr() {
    return ocrIdle.length ? Promise.resolve(ocrIdle.pop()) : new Promise(resolve => ocrWaiters.push(resolve));
}

function releaseOcr(worker) {
    const next = ocrWaiters.shift();
    if (next) next(worker);
    else ocrIdle.push(worker);
}

/** Segunda pasada para fotos con mucho ruido (recibos): imagen ×2 y modo de texto disperso */
function upscaleCanvas(source, factor, maxSide) {
    const k = Math.min(factor, maxSide / Math.max(source.width, source.height));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(source.width * k));
    out.height = Math.max(1, Math.round(source.height * k));
    out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
    return out;
}

/** Texto de una imagen (null si el OCR no está disponible) */
async function ocrText(px) {
    if (!(await initOcr())) return null;
    const worker = await acquireOcr();
    try {
        const canvas = OCR_CONFIG.toInput(px.rgba, px.width, px.height);
        let text = (await worker.recognize(canvas)).data.text || '';
        const wordCount = (text.match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/g) || []).length;
        if (wordCount < 25) {
            await worker.setParameters({ tessedit_pageseg_mode: '11' });
            try {
                const sparse = (await worker.recognize(upscaleCanvas(canvas, 2, OCR_CONFIG.maxSide))).data.text || '';
                text = `${text}\n${sparse}`;
            } finally {
                await worker.setParameters({ tessedit_pageseg_mode: '3' });
            }
        }
        return text;
    } finally {
        releaseOcr(worker);
    }
}

/* Caché de OCR por archivo: una imagen nunca se lee dos veces (ni sus rotaciones) */
const ocrFileCache = new Map();
const ocrFileKey = file => `${file.name}|${file.size}|${file.lastModified}`;

function ocrFile(file) {
    const key = ocrFileKey(file);
    if (ocrFileCache.has(key)) return ocrFileCache.get(key);
    const job = (async () => {
        if (!(await initOcr())) return null;
        const worker = await acquireOcr();
        try {
            const result = await worker.recognize(file);
            return result.data.text || '';
        } finally {
            releaseOcr(worker);
        }
    })();
    ocrFileCache.set(key, job);
    job.then(text => { if (text === null) ocrFileCache.delete(key); }, () => ocrFileCache.delete(key));
    return job;
}

function ocrTextRotated(input, degrees) {
    if (!(typeof File !== 'undefined' && input instanceof File)) return ocrTextRotatedRaw(input, degrees);
    const key = `${ocrFileKey(input)}|r${degrees}`;
    if (ocrFileCache.has(key)) return ocrFileCache.get(key);
    const job = ocrTextRotatedRaw(input, degrees);
    ocrFileCache.set(key, job);
    job.then(text => { if (text === null) ocrFileCache.delete(key); }, () => ocrFileCache.delete(key));
    return job;
}

async function ocrTextRotatedRaw(input, degrees) {
    const workerReady = await initOcr();
    if (!workerReady) return null;
    const worker = await acquireOcr();
    let source = null;
    try {
        if (input && input.rgba) {
            source = rgbaToCanvas(input.rgba, input.width, input.height);
        } else {
            source = await createImageBitmap(input);
        }
        const width = degrees % 180 ? source.height : source.width;
        const height = degrees % 180 ? source.width : source.height;
        const scale = Math.min(1, OCR_CONFIG.maxSide / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(degrees * Math.PI / 180);
        context.drawImage(source, -source.width * scale / 2, -source.height * scale / 2,
            source.width * scale, source.height * scale);
        let text = (await worker.recognize(canvas)).data.text || '';
        if ((text.match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/g) || []).length < 25) {
            await worker.setParameters({ tessedit_pageseg_mode: '11' });
            try {
                text += '\n' + ((await worker.recognize(upscaleCanvas(canvas, 2, OCR_CONFIG.maxSide))).data.text || '');
            } finally {
                await worker.setParameters({ tessedit_pageseg_mode: '3' });
            }
        }
        return text;
    } finally {
        if (source && typeof source.close === 'function') source.close();
        releaseOcr(worker);
    }
}

/** Libera los procesos de OCR (opcional) */
async function terminateOcr() {
    const workers = ocrIdle;
    ocrIdle = [];
    ocrInitPromise = null;
    ocrFileCache.clear();
    await Promise.all(workers.map(w => w.terminate().catch(() => {})));
}

/* ============ PALABRAS CLAVE ============ */

function editDistanceAtMostOne(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (a.length < b.length) j++;
        else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}

function hasWord(wordSet, wordList, token) {
    if (wordSet.has(token)) return true;
    if (token.length < 6) return false;                           // palabras cortas: solo exactas
    return wordList.some(w => editDistanceAtMostOne(w, token));    // tolera 1 error de OCR
}

/** Cuántas frases características de la familia aparecen en el texto */
function scoreFamily(familyKey, wordList) {
    const wordSet = new Set(wordList);
    let hits = 0;
    for (const phrase of DOC_FAMILIES[familyKey].words) {
        const tokens = phrase.split(' ');
        const found = tokens.filter(t => hasWord(wordSet, wordList, t)).length;
        if (found >= Math.ceil(tokens.length * 0.75)) hits++;
    }
    return hits;
}

function scorePhrases(phrases, wordList) {
    const wordSet = new Set(wordList);
    return phrases.reduce((hits, phrase) => {
        const tokens = phrase.split(' ');
        const found = tokens.filter(token => hasWord(wordSet, wordList, token)).length;
        return hits + (found >= Math.ceil(tokens.length * 0.75) ? 1 : 0);
    }, 0);
}

/** El número de cédula / NIC / matrícula del formulario aparece en la imagen = evidencia fuerte */
function numberBonus(familyKey, text, values) {
    const digits = String(text).replace(/\D/g, '');
    for (const id of DOC_FAMILIES[familyKey].idItems) {
        const expected = String(values[id] || '').replace(/\D/g, '');
        if (expected.length >= 6 && digits.includes(expected)) return 2;
    }
    return 0;
}

/* ============ VEREDICTOS ============ */

/** Nombres/apellidos del formulario (persona que atiende o propietario) que aparecen en el texto de la imagen */
function nameCheck(words, values) {
    const wordSet = new Set(words);
    let best = null;
    for (const [a, b] of [[37, 38], [14, 15]]) {
        const tokens = fold(`${values[a] || ''} ${values[b] || ''}`).split(' ').filter(t => t.length >= 3);
        if (!tokens.length) continue;
        const hits = tokens.filter(t => hasWord(wordSet, words, t)).length;
        if (!best || hits / tokens.length > best.hits / best.total) best = { hits, total: tokens.length };
    }
    return best;
}

/** Cruza número (NIC / matrícula), nombre y dirección del formulario con el texto leído (solo informativo) */
function docDataNote(expected, text, words, values) {
    const label = expected === 'recibo' ? 'NIC' : 'matrícula';
    const parts = [];
    const bonus = numberBonus(expected, text, values);
    const hasNumber = DOC_FAMILIES[expected].idItems.some(id => String(values[id] || '').replace(/\D/g, '').length >= 6);
    if (hasNumber) parts.push(bonus ? `${label} coincide` : `${label} no confirmado`);

    const nm = nameCheck(words, values);
    if (nm) parts.push(nm.hits / nm.total >= 0.5 ? 'nombre coincide' : 'nombre no confirmado');

    const addr = fold(String(values[6] || '')).split(' ').filter(t => /\d/.test(t) && t.length >= 2);
    if (addr.length) {
        const wordSet = new Set(words);
        const found = addr.filter(t => hasWord(wordSet, words, t)).length;
        parts.push(found / addr.length >= 0.6 ? 'dirección coincide' : 'dirección no confirmada');
    }
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function judgeDocument(expected, text, values, side = '') {
    const words = fold(text).split(' ').filter(w => w.length >= 2);
    const family = DOC_FAMILIES[expected];
    const own = scoreFamily(expected, words) + numberBonus(expected, text, values);
    const sideScore = side && family.sides ? scorePhrases(family.sides[side] || [], words) : 0;
    if (own >= family.min && (!side || sideScore >= 2)) {
        let extra = '';
        if (expected === 'cedula' && side === 'anverso') {
            const nm = nameCheck(words, values);
            if (nm) extra = nm.hits / nm.total >= 0.5
                ? '; el nombre coincide con el formulario'
                : '; no se pudo leer el nombre del formulario en la cédula';
        }
        if (expected === 'recibo' || expected === 'certificado') extra = docDataNote(expected, text, words, values);
        return { verdict: 'ok', note: `Imagen verificada: ${family.label}${side ? ` (${side})` : ''}${extra}` };
    }
    if (side && family.sides) {
        const otherSide = side === 'anverso' ? 'reverso' : 'anverso';
        if (scorePhrases(family.sides[otherSide], words) >= 2 && sideScore === 0) {
            return {
                verdict: 'fail',
                code: 'wrong_image',
                message: `Cédula ${otherSide}; se requiere ${side}.`
            };
        }
    }

    let otherKey = null;
    let otherScore = 0;
    Object.keys(DOC_FAMILIES).forEach(key => {
        if (key === expected) return;
        const score = scoreFamily(key, words);
        if (score > otherScore) { otherKey = key; otherScore = score; }
    });
    // NO CUMPLE solo con evidencia fuerte de otro documento; si no, REVISAR (p. ej. cédula fotografiada sobre un recibo)
    if (otherKey && otherScore >= 4 && own === 0) {
        return { verdict: 'fail', code: 'wrong_image',
                 message: `Foto incorrecta: parece ${DOC_FAMILIES[otherKey].label}; se requiere ${family.label}.` };
    }
    const detected = otherKey && otherScore >= 2 ? `; parece ${DOC_FAMILIES[otherKey].label}` : '';
    return { verdict: 'review', message: `${family.label}${side ? ` (${side})` : ''} no confirmada${detected}. Revisar foto.` };
}

function judgePhoto(exp, text) {
    const words = fold(text).split(' ').filter(w => w.length >= 2);
    let bestKey = null;
    let bestScore = 0;
    Object.keys(DOC_FAMILIES).forEach(key => {
        const score = scoreFamily(key, words);
        if (score > bestScore) { bestKey = key; bestScore = score; }
    });
    if (bestKey && bestScore >= 4) {
        return { verdict: 'fail', code: 'wrong_image',
                 message: `Foto incorrecta: parece ${DOC_FAMILIES[bestKey].label}; se requiere ${exp.what}.` };
    }
    return { verdict: 'ok', note: 'Imagen verificada (calidad y tipo)' };
}

function judgeElectricalPhoto(exp, text) {
    const normalized = fold(text);
    if (exp.kind === 'meter' && judgeDocument('recibo', text, {}).verdict === 'ok') {
        return {
            verdict: 'fail',
            code: 'wrong_image',
            message: 'Foto incorrecta: es un recibo; se requiere el contador.'
        };
    }
    const cues = exp.kind === 'meter'
        ? ['medidor', 'contador', 'kwh', 'lectura actual', 'medidor electronico', 'numero de medidor']
        : ['breaker', 'interruptor', 'disyuntor', 'tablero electrico', 'interruptores', 'termomagnetico', 'voltaje'];
    const hits = cues.filter(cue => normalized.includes(cue)).length;
    const isConfirmed = exp.kind === 'meter'
        ? hits >= 2 || ['medidor electronico', 'contador de energia', 'lectura del medidor'].some(cue => normalized.includes(cue))
        : hits >= 2 || ['tablero de breakers', 'tablero electrico'].some(cue => normalized.includes(cue));
    if (isConfirmed) {
        return { verdict: 'ok', note: `Imagen verificada: ${exp.kind === 'meter' ? 'contador o medidor de energía' : 'breakers o tablero eléctrico'}` };
    }

    const words = normalized.split(' ').filter(w => w.length >= 2);
    const otherKey = Object.keys(DOC_FAMILIES).find(key =>
        scoreFamily(key, words) >= Math.max(4, DOC_FAMILIES[key].min)
    );
    if (otherKey) {
        return {
            verdict: 'fail',
            code: 'wrong_image',
            message: `Foto incorrecta: parece ${DOC_FAMILIES[otherKey].label}; se requiere ${exp.kind === 'meter' ? 'el contador' : 'el tablero eléctrico'}.`
        };
    }
    return {
        verdict: 'review',
        message: `${exp.kind === 'meter' ? 'Contador' : 'Tablero eléctrico'} no confirmado; revisar foto.`
    };
}

function judgeExpectedImage(exp, text, values) {
    if (exp.kind === 'doc') return judgeDocument(exp.doc, text, values, exp.side);
    if (exp.kind === 'meter' || exp.kind === 'breaker') return judgeElectricalPhoto(exp, text);
    return judgePhoto(exp, text);
}

function shouldTryRotation(exp, text) {
    if (exp.kind !== 'doc') return false;
    if (exp.doc === 'cedula' || exp.doc === 'recibo') return true;
    const words = fold(text).split(' ').filter(word => word.length >= 2);
    return scoreFamily(exp.doc, words) > 0;
}

function judgeSignature(st) {
    if (st.inkRatio < 0.002) return { verdict: 'fail', code: 'image_quality', message: 'La firma está en blanco (no hay trazos)' };
    if (st.inkRatio > 0.5) return { verdict: 'fail', code: 'wrong_image', message: 'La imagen no parece una firma (demasiado oscura)' };
    return { verdict: 'ok', note: 'Firma con trazos' };
}

function judgeQuality(st) {
    if (Math.min(st.w, st.h) < 100) return { verdict: 'fail', code: 'image_quality', message: `Imagen de muy baja resolución (${st.w}x${st.h})` };
    if (st.std < 6) return { verdict: 'fail', code: 'image_quality', message: 'La imagen está en blanco o es de un solo color' };
    return null;
}

/** Aplica el veredicto al ítem */
function applyVerdict(item, v) {
    if (v.verdict === 'ok') { item.imageNote = v.note || ''; return; }
    item.status = v.verdict === 'fail' ? 'non-compliant' : 'review';
    item.reasonCode = v.verdict === 'fail' ? v.code : 'review';
    item.observation = v.message;
}

async function verifyOne(item, exp, recs, values, items, deferReceiptConsumptionCheck = false) {
    const px = recs.map(r => r.px).find(Boolean);
    if (!px) return false;
    const st = imageStats(px);

    if (exp.kind === 'signature') {
        applyVerdict(item, judgeSignature(st));
        return true;
    }

    const quality = judgeQuality(st);
    if (quality) {
        applyVerdict(item, quality);
        return false;
    }

    let text = await ocrText(px);
    if (text === null) return false;
    let result = judgeExpectedImage(exp, text, values);
    if (result.verdict !== 'ok' && shouldTryRotation(exp, text)) {
        for (const degrees of [180, 90, 270]) {
            const rotatedText = await ocrTextRotated(px, degrees);
            if (rotatedText === null) break;
            const rotatedResult = judgeExpectedImage(exp, rotatedText, values);
            if (rotatedResult.verdict === 'ok') {
                text = rotatedText;
                result = rotatedResult;
                break;
            }
            if (result.verdict === 'fail' && rotatedResult.verdict === 'review') {
                text = rotatedText;
                result = rotatedResult;
            }
        }
    }
    if (!deferReceiptConsumptionCheck && exp.kind === 'doc' && exp.doc === 'recibo' && result.verdict === 'ok' &&
        typeof parseReceipt === 'function' && typeof houseApplyReceipt === 'function') {
        const byId = {};
        items.forEach(candidate => { byId[candidate.id] = candidate; });
        houseApplyReceipt(byId, values, parseReceipt(text), item.pdfName);
    }
    if (exp.kind !== 'doc' && typeof classifyImage === 'function') {
        result = refineWithClassification(exp, item.id, result, await classifyImage(px));
    }
    applyVerdict(item, result);
    return result.verdict === 'ok';
}

function markReceiptConsumptionReview(items) {
    [119, 120, 121].forEach(id => {
        const item = items.find(candidate => candidate.id === id);
        if (!item || item.notApplicable) return;
        if (!item.receiptComparison) {
            item.receiptComparison = {
                formValue: String(item.actualValue || '').trim() || 'Sin respuesta',
                receiptValue: 'Sin lectura confirmada',
                status: 'unknown'
            };
        }
        if (item.status === 'compliant') {
            item.status = 'review';
            item.reasonCode = 'review';
            item.observation = 'Consumo no confirmado contra recibo; revisar.';
        }
    });
}

/**
 * Verifica las imágenes de los ítems que la tienen.
 * imageMap: id del ítem -> imágenes incrustadas (con .px). hooks.status(texto) informa el avance.
 */
async function verifyFolderImages(targets, folderImages, values, hooks) {
    if (!targets.length || !folderImages.length) return;
    const unresolved = new Set(targets);
    const inspected = [];
    let done = 0;

    for (const [entryIndex, entry] of folderImages.entries()) {
        if (!unresolved.size) break;
        // Precarga: mientras se juzga esta imagen, los otros procesos de OCR leen las siguientes
        for (let ahead = 1; ahead < OCR_CONFIG.workers; ahead++) {
            const next = folderImages[entryIndex + ahead];
            if (next && next.file.size && !/^signature[-_]/i.test(next.file.name)) ocrFile(next.file).catch(() => {});
        }
        if (!entry.file.size || /^signature[-_]/i.test(entry.file.name)) continue;
        try {
            const text = await ocrFile(entry.file);
            done++;
            if (text === null) {
                if (hooks.warning) hooks.warning('No se pudo iniciar el OCR local; las imágenes externas requieren revisión manual.');
                return;
            }
            const texts = [text];
            const matchesAny = candidateText => [...unresolved].some(item =>
                judgeExpectedImage(IMAGE_EXPECT[item.id], candidateText, values).verdict === 'ok'
            );
            if (!matchesAny(text) && [...unresolved].some(item => shouldTryRotation(IMAGE_EXPECT[item.id], text))) {
                for (const degrees of [180, 90, 270]) {
                    const rotatedText = await ocrTextRotated(entry.file, degrees);
                    if (rotatedText === null) break;
                    texts.push(rotatedText);
                    if (matchesAny(rotatedText)) break;
                }
            }
            inspected.push({ entry, text: texts.find(candidateText =>
                judgeDocument('recibo', candidateText, values).verdict === 'ok'
            ) || text });

            for (const item of [...unresolved]) {
                const expected = IMAGE_EXPECT[item.id];
                const result = texts.map(candidateText =>
                    judgeExpectedImage(expected, candidateText, values)
                ).find(candidateResult => candidateResult.verdict === 'ok');
                if (!result) continue;
                item.folderImageMatch = entry.file.name;
                const note = item.id === 102
                    ? 'Foto del contador encontrada en carpeta, pero no adjunta al PDF; verificar ubicación.'
                    : 'No contiene la imagen correspondiente en el PDF.';
                if (item.id === 102) {
                    item.imageNote = note;
                    if (item.status !== 'compliant') {
                        item.observation = `${item.observation ? `${item.observation}. ` : ''}${note}`;
                    }
                } else {
                    item.status = 'non-compliant';
                    item.reasonCode = 'wrong_image';
                    item.observation = note;
                    item.imageNote = '';
                }
                unresolved.delete(item);
                break;
            }
            if (hooks.status) hooks.status(`buscando evidencia en carpeta ${done}/${folderImages.length}`);
        } catch (error) {
            console.warn(`No se pudo revisar la imagen externa ${entry.path}:`, error);
            if (hooks.warning) hooks.warning(`No se pudo leer una imagen de la carpeta (${entry.file.name}); se continuará con las demás.`);
        }
    }

    const receiptIndex = inspected.findIndex(candidate =>
        judgeDocument('recibo', candidate.text, values).verdict === 'ok'
    );
    if (receiptIndex > 0 && receiptIndex < inspected.length - 1) {
        const sequenceCandidates = {
            103: { candidate: inspected[receiptIndex - 1], label: 'tablero eléctrico o breakers (posición anterior al recibo)' },
            102: { candidate: inspected[receiptIndex + 1], label: 'contador o medidor (posición posterior al recibo)' }
        };
        for (const [id, match] of Object.entries(sequenceCandidates)) {
            const item = [...unresolved].find(candidate => candidate.id === Number(id));
            if (!item || !match.candidate || !match.candidate.entry.file.size) continue;
            let quality;
            try {
                quality = await imageQualityFromFile(match.candidate.entry.file);
            } catch (error) {
                console.warn(`No se pudo comprobar la calidad de ${match.candidate.entry.file.name}:`, error);
                if (hooks.warning) hooks.warning(`No se pudo comprobar la calidad de una imagen candidata (${match.candidate.entry.file.name}).`);
                continue;
            }
            if (quality) continue;
            item.folderImageMatch = match.candidate.entry.file.name;
            const note = item.id === 103
                ? 'Foto candidata de tablero/breakers; no está adjunta al PDF.'
                : 'Foto candidata de contador/medidor; no está adjunta al PDF. No verifica la ubicación.';
            if (item.id === 102) {
                item.imageNote = note;
                if (item.status !== 'compliant') {
                    item.observation = `${item.observation ? `${item.observation}. ` : ''}${item.imageNote}`;
                }
            } else {
                item.status = 'non-compliant';
                item.reasonCode = 'wrong_image';
                item.observation = note;
            }
            unresolved.delete(item);
        }
    }

    unresolved.forEach(item => {
        if (item.id === 102) {
            const note = 'Foto del medidor no confirmada; revisar ubicación.';
            item.imageNote = note;
            if (item.status !== 'compliant') {
                item.observation = `${item.observation ? `${item.observation}. ` : ''}${note}`;
            }
            return;
        }
        const expected = IMAGE_EXPECT[item.id];
        const labels = {
            cedula: 'Cédula', recibo: 'Recibo de energía', certificado: 'Certificado de tradición',
            autorizacion: 'Carta de autorización', discapacidad: 'Certificado de discapacidad'
        };
        const label = expected.kind === 'doc' ? labels[expected.doc]
            : expected.kind === 'meter' ? 'Contador'
            : expected.kind === 'breaker' ? 'Tablero eléctrico'
            : String(expected.what || 'Foto solicitada').replace(/^una fotografía\s+/i, 'Foto ');
        const side = expected.side ? ` (${expected.side})` : '';
        const feminine = /^(cédula|carta|foto)/i.test(label);
        item.observation = item.reasonCode === 'wrong_image'
            ? `Foto incorrecta para ${label.toLowerCase()}${side}; reemplazar adjunto.`
            : item.reasonCode === 'image_quality'
                ? `${label}${side} ilegible; reemplazar foto.`
                : `${label}${side} no ${feminine ? 'confirmada' : 'confirmado'}.`;
        if (item.status === 'compliant') {
            item.status = 'review';
            item.reasonCode = 'review';
        }
    });
}

async function verifyImages(items, imageMap, values, hooks = {}, folderImages = []) {
    const targets = [];
    const tasks = [];
    const preferFolderReceipt = IMAGE_VERIFY.houseDocs && folderImages.length > 0;
    items.forEach(item => {
        const exp = IMAGE_EXPECT[item.id];
        if (!exp || item.notApplicable) return;
        const recs = imageMap[item.id];
        if (recs && recs.length) {
            tasks.push({ item, run: async () => {
                const confirmed = await verifyOne(item, exp, recs, values, items, preferFolderReceipt);
                if (!confirmed) targets.push(item);
            } });
        } else if (item.type === 'file' || (item.id === 102 && folderImages.length)) {
            targets.push(item);
        }
    });
    const total = tasks.length;
    let done = 0;

    const runner = async () => {
        while (tasks.length) {
            const task = tasks.shift();
            try { await task.run(); } catch (error) {
                console.warn('No se pudo verificar una imagen del PDF:', error);
                if (hooks.warning) hooks.warning('No se pudo leer una imagen del PDF; se intentará contrastar con la carpeta de respaldo.');
                targets.push(task.item);
            }
            done++;
            if (hooks.status) hooks.status(`verificando imágenes ${done}/${total}`);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, OCR_CONFIG.workers) }, runner));
    await verifyFolderImages([...new Set(targets)], folderImages, values, hooks);
    if (IMAGE_VERIFY.houseDocs && folderImages.length && typeof verifyHouseDocs === 'function') {
        try { await verifyHouseDocs(items, values, folderImages, hooks); } catch (error) {
            console.warn('No se pudieron leer los documentos de la carpeta:', error);
        }
    }

    const receipt = items.find(item => item.id === 104);
    if (!receipt || !receipt.receiptConsumptionVerified) markReceiptConsumptionReview(items);

    Object.values(imageMap).forEach(list => list.forEach(r => { r.px = null; }));   // libera memoria
}
