/**
 * LECTURA DE PDFs Y VALIDACIÓN AUTOMÁTICA
 *
 * Formatos soportados (se detectan solos):
 *   A) KoboToolbox: tabla "Pregunta | Respuesta" con imágenes incrustadas.
 *   B) "Colombia Solar - Registro de envío": ficha en dos columnas, sin imágenes.
 * Ambos se leen por posición (columna izquierda = pregunta, derecha = respuesta)
 * y cada pregunta se enlaza con su item de AUDIT_ITEMS mediante PDF_LABELS.
 *
 * Estado global compartido: pdfDocuments, allItemsData
 */
let pdfDocuments = {};   // clave única de archivo -> { status, items | error, format }
let allItemsData = [];   // todos los items de todos los PDFs

const PDF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MIN_TEXT_LENGTH = 30;   // menos que esto = PDF escaneado / sin texto
const MATCH_WINDOW = 30;      // bloques hacia adelante al buscar cada pregunta
const MARGIN_TOP = 30;        // puntos ignorados arriba (encabezado)
const ROW_GAP_FACTOR = 1.7;   // separación entre filas / altura de letra

const FORMATS = {
    A: { name: 'KoboToolbox', marginBottom: 30 },
    B: { name: 'Colombia Solar - Registro de envío', qx: 57, rx: 247, marginBottom: 45 }
};

const FILE_RE = /\.(jpe?g|png|gif|webp|bmp|heic|pdf|webm|mp3|m4a|wav|mp4)$/i;
const IMG_TOKEN = '[imagen adjunta]';   // valor de un archivo detectado solo por su imagen incrustada
const NUMBER_RE = /^-?\d+(?:[.,]\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Opciones que controla la interfaz */
const IMAGE_VERIFY = { enabled: true };

/** Correos: no son obligatorios, pero si faltan o tienen mal formato -> REVISAR */
const REVIEW_ONLY = { 18: true, 41: true };

/**
 * Formato B no trae imágenes. Qué hacer con los ítems de foto/firma obligatorios:
 * 'review' = marcar REVISAR | 'non-compliant' = marcar NO CUMPLE
 */
const FORMAT_B_FILES_STATUS = 'review';

if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
}

function looksLikeFile(value) {
    const v = String(value || '');
    return FILE_RE.test(v.trim()) || v.includes(IMG_TOKEN);
}

/* ============ NORMALIZACIÓN ============ */

/** Minúsculas, sin tildes ni signos (para comparar etiquetas y buscar) */
function fold(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Mayúsculas sin tildes (para comparar respuestas: SÍ == SI) */
function normalizeText(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
}

function imageMatchTokens(value) {
    let normalized = fold(String(value || '').replace(/\.(pdf|jpe?g|png|webp)$/i, ''));
    normalized = normalized
        .replace(/\b(siete de abril|villas de san pablo|colombia solar|corregido)\b/g, ' ')
        .replace(/\b(calle|cll?)\b/g, ' cl ')
        .replace(/\b(carrera|cra|cr|car)\b/g, ' cr ')
        .replace(/\b(manzana)\b/g, ' mz ')
        .replace(/\b(casa)\b/g, ' cs ');
    return normalized.split(/\s+/).filter(Boolean);
}

function matchImageFolderScore(pdfName, folderName) {
    const left = imageMatchTokens(pdfName);
    const right = imageMatchTokens(folderName);
    const a = new Set(left);
    const b = new Set(right);
    const common = [...a].filter(token => b.has(token));
    const numericMatches = common.filter(token => /^\d+$/.test(token)).length;
    const dice = (2 * common.length) / Math.max(1, a.size + b.size);
    const coverage = common.length / Math.max(1, Math.min(a.size, b.size));
    return { score: Math.max(dice, coverage * 0.9), numericMatches };
}

function findRelatedImages(pdfPath, imageEntries) {
    const parts = String(pdfPath || '').split(/[\\/]/);
    const pdfName = parts.pop().replace(/\.pdf$/i, '');
    const folders = new Map();
    imageEntries.forEach(entry => {
        const imagePath = String(entry.path || '').split(/[\\/]/);
        imagePath.pop();
        const folderName = imagePath[imagePath.length - 1];
        if (!folderName) return;
        const folderPath = imagePath.join('/');
        if (!folders.has(folderPath)) folders.set(folderPath, { name: folderName, entries: [] });
        folders.get(folderPath).entries.push(entry);
    });

    const pdfTokens = imageMatchTokens(pdfName).join(' ');
    const exact = [...folders.values()].filter(folder => imageMatchTokens(folder.name).join(' ') === pdfTokens);
    if (exact.length === 1) return sortImagesByCaptureTime(exact[0].entries);
    if (exact.length > 1) return [];

    const ranked = [...folders.values()].map(folder => ({
        entries: folder.entries,
        ...matchImageFolderScore(pdfName, folder.name)
    })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const next = ranked[1];
    if (!best || best.score < 0.68 || best.numericMatches < 2) return [];
    if (next && best.score - next.score < 0.12) return [];
    return sortImagesByCaptureTime(best.entries);
}

function sortImagesByCaptureTime(entries) {
    return [...entries].sort((a, b) => {
        const captureTime = entry => {
            const match = entry.file.name.match(/-(\d{1,2})_(\d{1,2})_(\d{1,2})\.(?:jpe?g|png|webp)$/i);
            return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : Infinity;
        };
        const timeDiff = captureTime(a) - captureTime(b);
        return Number.isFinite(timeDiff) && timeDiff !== 0
            ? timeDiff
            : a.file.name.localeCompare(b.file.name);
    });
}

/* ============ CONFIGURACIÓN DEL FORMULARIO ============ */

/**
 * ID del item -> expresión que identifica su pregunta en el PDF
 * (se aplica sobre el texto normalizado con fold()).
 * Si cambia el formulario de Kobo, se ajusta aquí.
 */
const PDF_LABELS = {
    1: /^fecha y hora de visita/,
    2: /^id o codigo unico/,
    3: /^departamento$/,
    4: /^municipio$/,
    5: /^barrio/,
    6: /^direccion de la vivienda/,
    7: /^la direccion es consistente/,
    12: /^numero de visita/,
    13: /^la casa esta cerrada/,
    14: /^nombres de la persona que atiende/,
    15: /^apellidos de la persona que atiende/,
    16: /^tipo de identificacion la persona que atiende/,
    17: /^numero de identificacion de la persona que atiende/,
    18: /^correo electronico de la persona que atiende/,
    19: /^no telefono o celular de la persona que atiende/,
    20: /^relacion con el propietario de la vivienda/,
    21: /^si responde otro a relacion con el propietario/,
    22: /^si no es propietario de la vivienda cuenta con autorizacion/,
    23: /^si la respuesta es si y cuenta con la autorizacion/,
    24: /^lectura del texto de tratamiento/,
    25: /^acepto el usuario el tratamiento/,
    26: /^quiere participar en el programa/,
    27: /^tipo de sistema en el que esta interesado/,
    28: /^firma$/,
    29: /^fotografia$/,
    30: /^numero de la matricula inmobiliaria/,
    32: /^foto 1 certificado de tradicion/,
    33: /^foto 2 certificado de tradicion/,
    34: /^si la persona que atiende la visita no es el propietari/,
    35: /^fotografia del documento de identificacion .*anverso/,
    36: /^fotografia del documento de identificacion .*reverso/,
    37: /^nombres del propietario/,
    38: /^apellidos del propietario/,
    39: /^tipo de identificacion del propietario/,
    40: /^numero de identificacion del propietario/,
    41: /^correo electronico (en|del) propietario/,
    42: /^numero de telefono o celular del propietario/,
    43: /^la persona que atendio la visita es el jefe del hogar/,
    44: /^en caso de responder no quien nombres y apellidos/,
    45: /^tipo de identificacion$/,
    46: /^numero de identificacion$/,
    47: /^la jefatura del hogar es monoparental/,
    48: /^si la jefatura del hogar es monoparental/,
    49: /^nivel educativo del jefe/,
    50: /^ocupacion principal del jefe del hogar/,
    51: /^rango de ingresos del hogar/,
    52: /^algun miembro con discapacidad/,
    53: /^si la respuesta es si por favor tome foto del certificado de discapacidad cara 1/,
    54: /^si la respuesta es si por favor tome foto del certificado de discapacidad cara 2/,
    55: /^que tipo de discapacidad presenta/,
    56: /^personas con registro como victima del conflicto/,
    57: /^si la respuesta es si por favor escriba el numero de registro/,
    58: /^cuantas personas del hogar estan registradas en el ruv/,
    59: /^hace parte de algun grupo etnico/,
    60: /^si la respuesta es si a cual/,
    61: /^si la respuesta es si a cual/,
    62: /^algunas personas del hogar que tienen participacion/,
    63: /^si la respuesta es si que personas del hogar tienen participacion/,
    64: /^numero de familias por medidor/,
    65: /^numero personas por medidor/,
    66: /^numero de medidores por predio/,
    67: /^numero de menores por medidor/,
    68: /^numero de adultos mayores por medidor/,
    69: /^otros ingresos de la familia/,
    70: /^numero de miembros de la familia en condiciones de discapacidad/,
    71: /^equipos medicos dependientes de energia/,
    72: /^si la respuesta es si nombre de los equipos medicos/,
    73: /^recepcion de subsidios/,
    74: /^si la respuesta es si cual o cuales subsidios/,
    75: /^si la respuesta es otro s especifique/,
    76: /^actividades productivas que dependan de energia/,
    77: /^actividades productivas de la vivienda/,
    78: /^identificacion de riesgos sociales/,
    79: /^conflictos entre vecinos/,
    80: /^presencia de disputas/,
    81: /^desconfianza hacia entidades/,
    82: /^problemas de orden publico/,
    83: /^resistencia al uso de tecnologias solares/,
    84: /^alta vulnerabilidad economica/,
    85: /^niu$/,
    86: /^nic$/,
    87: /^estrato$/,
    88: /^tipo de vivienda$/,
    89: /^si responde otro cual$/,
    90: /^numero de pisos del inmueble/,
    91: /^tiempo de construccion/,
    92: /^nivel de tension de conexion/,
    93: /^tipo de sistema electrico actual/,
    94: /^cuenta con un sistema solar fotovoltaico actualmente/,
    95: /^clasificacion/,
    96: /^combustible principal utilizado para cocinar/,
    97: /^si la respuesta es otro cual$/,
    98: /^la vivienda cuenta con area disponible/,
    99: /^si la respuesta es otro cual$/,
    100: /^panoramica del frente de la casa/,
    101: /^panoramica del frente de las construcciones/,
    102: /^ubicacion del medidor/,
    103: /^tablero electrico/,
    104: /^recibo de energia$/,
    105: /^riesgos electricos o estructurales/,
    106: /^techo y de la estructura/,
    107: /^patio$/,
    108: /^antejardin$/,
    109: /^espacio disponible para la instalacion/,
    110: /^ubicacion en zona de riesgo de desastre/,
    111: /^uso informal de la energia/,
    112: /^falta de vias de acceso/,
    113: /^riesgo de colapso de la vivienda/,
    114: /^uso del inmueble para actividades incompatibles/,
    115: /^areas limitadas para el desarrollo del programa/,
    116: /^viviendas construidas con materiales no aptos/,
    117: /^operador de red/,
    118: /^comercializador de red/,
    119: /^consumos? actual/,
    120: /^consumos? mes anterior/,
    121: /^promedio de consumo/,
    122: /^cartera en mora$/,
    123: /^estado del medidor/,
    124: /^tipo de conexion/,
    125: /^lectura visible/,
    126: /^valor cartera en mora/,
    127: /^meses de la cartera en mora/,
    128: /^meses de la cartera en mora/,
    129: /^firma de la persona encuestada/,
    130: /^observaciones$/,
    131: /^nombre del encuestador/,
    132: /^rol$/,
    133: /^firma del encuestador/
};

/** Items 8-11: la ubicación viene en una tabla "Punto" (lat, lon, altitud, precisión) */
const GEO_FIELDS = { 8: 0, 9: 1, 10: 2, 11: 3 };

/** Items sin pregunta propia en el PDF: se deducen de otros (según el formato) */
const DERIVED = {
    // Certificado de tradición disponible
    31: (values, format) => {
        if (format === 'B') {
            const m = normalizeText(values[30]);
            return m && m !== 'NO TIENE' ? 'SI' : '';
        }
        return looksLikeFile(values[32] || '') ? 'SI' : '';   // existe la Foto 1 del certificado
    }
};

function applyApplicabilityRules(values, found) {
    const reasons = {};
    if (normalizeText(values[26]) === 'NO') {
        AUDIT_ITEMS.filter(def => def.id > 26).forEach(def => {
            values[def.id] = 'NO APLICA';
            found[def.id] = true;
            reasons[def.id] = 'No aplica porque no desea participar en el Programa Colombia Solar';
        });
    } else if (normalizeText(values[105]) === 'NO') {
        values[106] = 'NO APLICA';
        found[106] = true;
        reasons[106] = 'No aplica porque no se identificaron riesgos eléctricos o estructurales';
    }
    return reasons;
}

/**
 * Items condicionales: obligatorios SOLO si la respuesta del item "parent" cumple "when".
 * optional: nunca se exige (segundas respuestas).
 */
const isYes = v => v === 'SI';
const isNo = v => v === 'NO';
const hasOtro = v => v.includes('OTRO');

const CONDITIONS = {
    106: { parent: 105, when: isYes, why: 'se identificaron riesgos eléctricos o estructurales' },
    22:  { parent: 20,  when: v => v !== '' && !v.startsWith('PROPIETARIO'), why: 'quien atiende la visita no es el propietario' },
    21:  { parent: 20,  when: hasOtro, why: 'la relación con el propietario es "OTRO"' },
    23:  { parent: 22,  when: isYes,   why: 'indicó contar con autorización para entregar información' },
    34:  { parent: 20,  when: v => v !== '' && !v.startsWith('PROPIETARIO'), why: 'quien atiende la visita no es el propietario' },
    44:  { parent: 43,  when: isNo,    why: 'quien atiende la visita no es el jefe del hogar' },
    45:  { parent: 43,  when: isNo,    why: 'quien atiende la visita no es el jefe del hogar' },
    46:  { parent: 43,  when: isNo,    why: 'quien atiende la visita no es el jefe del hogar' },
    48:  { parent: 47,  when: isYes,   why: 'la jefatura del hogar es monoparental' },
    53:  { parent: 52,  when: isYes,   why: 'hay miembros con discapacidad' },
    54:  { parent: 52,  when: isYes,   why: 'hay miembros con discapacidad' },
    55:  { parent: 52,  when: isYes,   why: 'hay miembros con discapacidad' },
    57:  { parent: 56,  when: isYes,   why: 'hay víctimas del conflicto (RUV) en el hogar' },
    58:  { parent: 56,  when: isYes,   why: 'hay víctimas del conflicto (RUV) en el hogar' },
    60:  { parent: 59,  when: isYes,   why: 'pertenece a un grupo étnico' },
    61:  { optional: true },
    63:  { parent: 62,  when: isYes,   why: 'hay participación en organizaciones comunitarias' },
    72:  { parent: 71,  when: isYes,   why: 'hay equipos médicos dependientes de energía' },
    74:  { parent: 73,  when: isYes,   why: 'recibe subsidios' },
    75:  { parent: 74,  when: hasOtro, why: 'el subsidio es "OTRO(S)"' },
    89:  { parent: 88,  when: hasOtro, why: 'el tipo de vivienda es "OTRO"' },
    97:  { parent: 96,  when: hasOtro, why: 'el combustible es "OTRO"' },
    99:  { parent: 98,  when: hasOtro, why: 'el área disponible es "OTRO"' },
    126: { parent: 122, when: isYes,   why: 'tiene cartera en mora' },
    127: { parent: 122, when: isYes,   why: 'tiene cartera en mora' },
    128: { optional: true }
};

/** Categorías de incumplimiento (para agrupar y para el filtro) */
const REASON_LABELS = {
    empty: 'Campos obligatorios sin diligenciar',
    missing_file: 'Fotos / archivos faltantes',
    conditional: 'Campos requeridos según respuestas previas',
    format: 'Dato con formato inválido',
    mismatch: 'Respuesta distinta a la esperada',
    wrong_attachment: 'Archivo adjunto en lugar de una respuesta',
    wrong_image: 'Imagen que no corresponde a la pregunta',
    image_quality: 'Imagen en blanco o ilegible',
    not_found: 'Preguntas no encontradas en el PDF',
    niu_list: 'NIU / dirección no coinciden con el listado',
    invalid_form: 'Formulario No valido',
    manual: 'Marcados manualmente'
};

/* ============ ESTADÍSTICAS Y RESUMEN ============ */

/** Estadísticas de un conjunto de items */
function computeStats(items) {
    let compliant = 0, nonCompliant = 0, review = 0, pending = 0, notApplicable = 0;
    for (const item of items) {
        if (item.notApplicable) { notApplicable++; continue; }
        if (item.status === 'compliant') compliant++;
        else if (item.status === 'non-compliant') nonCompliant++;
        else if (item.status === 'review') review++;
        else pending++;
    }
    const total = items.length - notApplicable;
    return { total, compliant, nonCompliant, review, pending, notApplicable, pct: total ? (compliant / total) * 100 : 0 };
}

/** Viñetas "• Ítem: comentario" de los items con ese estado */
function bulletLines(items, status, fallback) {
    return items
        .filter(i => i.status === status)
        .map(i => `• ${i.description}: ${i.observation || fallback}`);
}

/** Resumen de por qué un PDF NO CUMPLE: una viñeta por ítem (sin conteos) */
function summarizeNonCompliance(items) {
    const lines = bulletLines(items, 'non-compliant', 'No cumple');
    return { count: lines.length, lines, text: lines.join('\n') };
}

/** Ítems marcados para REVISAR (correos, imágenes dudosas, formato sin fotos) */
function summarizeReview(items) {
    const lines = bulletLines(items, 'review', 'Revisar');
    return { count: lines.length, lines, text: lines.join('\n') };
}

/* ============ LECTURA DEL PDF ============ */

/** Agrupa celdas de texto en líneas (misma altura) */
function clusterLines(cells) {
    const sorted = [...cells].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const c of sorted) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - c.y) <= 3) last.cells.push(c);
        else lines.push({ y: c.y, cells: [c] });
    }
    lines.forEach(l => {
        l.cells.sort((a, b) => a.x - b.x);
        l.text = l.cells.map(c => c.str).join(' ');
    });
    return lines;
}

/** Une líneas de un mismo bloque (los nombres de archivo cortan en "-") */
function joinLines(lines) {
    let out = '';
    for (const l of lines) {
        if (!out) out = l.text;
        else if (out.endsWith('-') && !/\s/.test(l.text)) out += l.text;
        else out += ' ' + l.text;
    }
    return out.trim();
}

/** Agrupa líneas consecutivas en bloques (una pregunta/respuesta = un bloque) */
function toBlocks(lines, gap) {
    const blocks = [];
    for (const l of lines) {
        const b = blocks[blocks.length - 1];
        if (b && b.bottom - l.y <= gap) {
            b.lines.push(l);
            b.bottom = l.y;
        } else {
            blocks.push({ lines: [l], top: l.y, bottom: l.y });
        }
    }
    blocks.forEach(b => { b.text = joinLines(b.lines); });
    return blocks;
}

function median(values) {
    if (!values.length) return 10;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

/** Detecta el formato del PDF a partir del texto de la primera página */
function detectFormat(strings) {
    const joined = strings.join(' ');
    if (/ficha de la vivienda|Colombia Solar - Registro de env[ií]o(?!s)/i.test(joined)) return 'B';
    return 'A';
}

/** Imágenes incrustadas de una página con su posición (x0,x1,y0,y1) */
async function collectPageImages(page) {
    const OPS = pdfjsLib.OPS;
    const ops = await page.getOperatorList();
    const mul = (m, t) => [
        m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
        m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
        m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]
    ];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const images = [];

    ops.fnArray.forEach((fn, i) => {
        const args = ops.argsArray[i];
        if (fn === OPS.save) stack.push(ctm.slice());
        else if (fn === OPS.restore) ctm = stack.pop() || ctm;
        else if (fn === OPS.transform) ctm = mul(ctm, args);
        else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintInlineImageXObject) {
            const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) =>
                [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
            const xs = pts.map(p => p[0]);
            const ys = pts.map(p => p[1]);
            images.push({
                objId: typeof args[0] === 'string' ? args[0] : null,
                inline: typeof args[0] === 'string' ? null : args[0],
                x0: Math.min(...xs), x1: Math.max(...xs),
                y0: Math.min(...ys), y1: Math.max(...ys),
                px: null
            });
        }
    });
    return images;
}

/** Pixeles RGBA de una imagen incrustada (null si no se puede leer) */
async function readImagePixels(page, rec) {
    try {
        let img = rec.inline;
        if (!img) {
            img = await Promise.race([
                new Promise(resolve => page.objs.get(rec.objId, resolve)),
                new Promise(resolve => setTimeout(() => resolve(null), 8000))
            ]);
        }
        if (!img) return null;

        if (img.bitmap) {                                   // navegador: ImageBitmap
            const canvas = document.createElement('canvas');
            canvas.width = img.bitmap.width;
            canvas.height = img.bitmap.height;
            const g = canvas.getContext('2d');
            g.drawImage(img.bitmap, 0, 0);
            return { width: canvas.width, height: canvas.height, rgba: g.getImageData(0, 0, canvas.width, canvas.height).data };
        }

        const { width, height, data, kind } = img;
        const n = width * height;
        const rgba = new Uint8ClampedArray(n * 4);
        if (kind === 3) {                                   // RGBA
            rgba.set(data.subarray(0, n * 4));
        } else if (kind === 2) {                            // RGB
            for (let p = 0; p < n; p++) {
                rgba[p * 4] = data[p * 3]; rgba[p * 4 + 1] = data[p * 3 + 1]; rgba[p * 4 + 2] = data[p * 3 + 2]; rgba[p * 4 + 3] = 255;
            }
        } else if (kind === 1) {                            // 1 bit por píxel
            const rowBytes = (width + 7) >> 3;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
                    const o = (y * width + x) * 4;
                    rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255;
                }
            }
        } else {
            return null;
        }
        return { width, height, rgba };
    } catch (error) {
        console.warn('No se pudo leer una imagen del PDF:', error);
        return null;
    }
}

/** Cada imagen pertenece a la pregunta que está a su altura (la pregunta va centrada en su fila) */
function assignImages(qBlocks, images, split, fs) {
    const assigned = [];
    for (const img of images) {
        if (img.x0 < split - 10 || img.x1 - img.x0 < 20 || img.y1 - img.y0 < 20) continue;
        const cy = (img.y0 + img.y1) / 2;
        let best = null;
        let bestDist = Infinity;
        for (const qb of qBlocks) {
            const qy = (qb.top + qb.bottom) / 2;
            if (qy >= img.y0 - fs && qy <= img.y1 + fs) {
                const dist = Math.abs(qy - cy);
                if (dist < bestDist) { best = qb; bestDist = dist; }
            }
        }
        if (best) { best.images.push(img); assigned.push(img); }
    }
    return assigned;
}

/** Lee una página: bloques de pregunta (izq.) y de respuesta (der.) + imágenes */
async function parsePage(page, layout) {
    const viewport = page.getViewport({ scale: 1 });
    const W = viewport.width;
    const H = viewport.height;
    const content = await page.getTextContent();

    const all = [];
    for (const it of content.items) {
        const str = (it.str || '').trim();
        if (!str) continue;
        all.push({ x: it.transform[4], y: it.transform[5], str, h: it.height || 10 });
    }

    if (!layout.format) layout.format = detectFormat(all.map(c => c.str));
    const fmt = FORMATS[layout.format];
    const cells = all.filter(c => c.y <= H - MARGIN_TOP && c.y >= fmt.marginBottom);   // sin encabezado/pie

    // Posición de las columnas
    if (!layout.ready) {
        if (layout.format === 'B') {
            layout.qx = fmt.qx; layout.rx = fmt.rx; layout.ready = true;
        } else {
            const hq = cells.find(c => c.str === 'Pregunta');
            const hr = cells.find(c => c.str === 'Respuesta');
            if (hq && hr) { layout.qx = hq.x; layout.rx = hr.x; layout.ready = true; }
        }
    }
    const qx = layout.qx ?? W * 0.208;
    const rx = layout.rx ?? W * 0.516;
    const split = rx - 10;

    const fs = median(cells.map(c => c.h));
    const gap = fs * ROW_GAP_FACTOR;   // renglones de una pregunta ~1.2-1.4x, entre filas >= 2.2x

    const qBlocks = toBlocks(clusterLines(cells.filter(c => c.x >= qx - 25 && c.x < split)), gap);
    const aBlocks = toBlocks(clusterLines(cells.filter(c => c.x >= split)), gap);
    qBlocks.forEach((b, k) => {
        b.texts = []; b.files = []; b.images = []; b.norm = fold(b.text);
        b.pageHeight = H;
        // Zona de la fila en la página: desde la pregunta hasta la siguiente
        b.rowTop = b.top + fs * 1.6;
        b.rowBottom = qBlocks[k + 1] ? qBlocks[k + 1].top + fs * 1.2 : fmt.marginBottom;
    });

    let images = [];
    if (layout.format !== 'B') {
        images = assignImages(qBlocks, await collectPageImages(page), split, fs);
    }

    return { qBlocks, aBlocks, fs, images, text: clusterLines(cells).map(l => l.text).join('\n') };
}

/** Pregunta más cercana POR ENCIMA de una respuesta (los archivos quedan debajo de su pregunta) */
function nearestAbove(qBlocks, ab, tol) {
    let best = null;
    let bestDiff = Infinity;
    for (const qb of qBlocks) {
        const diff = qb.bottom - ab.top;
        if (diff >= -tol && diff < bestDiff) { best = qb; bestDiff = diff; }
    }
    return best;
}

/** Pregunta que comparte altura con la respuesta (las respuestas van centradas en la fila) */
function bestOverlap(qBlocks, ab, tol) {
    let best = null;
    let bestDist = Infinity;
    for (const qb of qBlocks) {
        if (ab.top + tol >= qb.bottom && ab.bottom - tol <= qb.top) {
            const dist = Math.abs((ab.top + ab.bottom) / 2 - (qb.top + qb.bottom) / 2);
            if (dist < bestDist) { best = qb; bestDist = dist; }
        }
    }
    return best;
}

/** Asigna cada respuesta a su pregunta; "history" = bloques de páginas anteriores */
function assignAnswers(parsed, history) {
    const { qBlocks, aBlocks, fs } = parsed;
    for (const ab of aBlocks) {
        if (FILE_RE.test(ab.text)) {
            // Un archivo puede quedar al inicio de la página siguiente a su pregunta
            const target = nearestAbove(qBlocks, ab, fs) || history[history.length - 1];
            if (target) target.files.push(ab.text);
        } else {
            const target = bestOverlap(qBlocks, ab, fs);
            if (target) target.texts.push(ab.text);
        }
    }
    history.push(...qBlocks);
}

/** Enlaza cada item de AUDIT_ITEMS con su pregunta, respetando el orden del formulario */
function matchBlocks(blocks) {
    const matched = {};
    let pointer = 0;
    for (const def of AUDIT_ITEMS) {
        const label = PDF_LABELS[def.id];
        if (!label) continue;
        const end = Math.min(blocks.length, pointer + MATCH_WINDOW);
        for (let k = pointer; k < end; k++) {
            if (label.test(blocks[k].norm)) {
                matched[def.id] = blocks[k];
                pointer = k + 1;
                break;
            }
        }
    }
    return matched;
}

/** Zona de la página (coordenadas PDF) donde está la pregunta y su imagen, para mostrarla como evidencia */
function evidenceOf(block) {
    let bottom = block.rowBottom;
    let top = block.rowTop;
    for (const img of block.images) {
        if (typeof img.y0 === 'number') bottom = Math.min(bottom, img.y0 - 6);
        if (typeof img.y1 === 'number') top = Math.max(top, img.y1 + 6);
    }
    return { page: block.page, top, bottom, pageHeight: block.pageHeight };
}

/** Latitud, longitud, altitud y precisión (formato B: campos "_Localización geográfica_x"; A: tabla "Punto") */
function extractGeopoint(text) {
    const num = '(-?\\d+(?:\\.\\d+)?)';
    const b = ['latitude', 'longitude', 'altitude', 'precision']
        .map(k => text.match(new RegExp(`_Localizaci[oó]n geogr[aá]fica_${k}\\s+${num}`)));
    if (b.every(Boolean)) return b.map(m => m[1]);

    const tail = text.match(/(?:^|\s)P\s+((?:-?\d+(?:\.\d+)?\s*)+)/m)
              || text.match(/start-geopoint\s+((?:-?\d+(?:\.\d+)?\s*)+)/);
    if (!tail) return null;
    const nums = tail[1].trim().split(/\s+/);
    return nums.length >= 4 ? nums.slice(-4) : null;
}

/**
 * Procesa un PDF. Recibe { file, path } y opcionalmente hooks { status(text) }.
 * Devuelve { key, ok, error? } y registra el resultado en el estado global.
 */
async function processPDF({ file, path }, hooks = {}) {
    const key = uniqueFileKey(path || file.name);
    let pdfDoc = null;

    try {
        const data = await file.arrayBuffer();
        pdfDoc = await pdfjsLib.getDocument({ data }).promise;

        const layout = {};
        const blocks = [];
        let fullText = '';
        const readPixels = IMAGE_VERIFY.enabled && typeof verifyImages === 'function';

        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i);
            const parsed = await parsePage(page, layout);
            if (readPixels) {
                for (const img of parsed.images) img.px = await readImagePixels(page, img);
            }
            parsed.qBlocks.forEach(b => { b.page = i; });
            assignAnswers(parsed, blocks);
            fullText += parsed.text + '\n';
            page.cleanup();
        }

        if (fullText.replace(/\s/g, '').length < MIN_TEXT_LENGTH) {
            throw new Error('El PDF no tiene texto legible (posible escaneo)');
        }
        const format = layout.format || 'A';
        const annexMatch = fullText.match(/Se incorporan\s+(\d+)\s+im[aá]genes/i);
        const ctx = { format, annexCount: annexMatch ? Number(annexMatch[1]) : 0 };

        blocks.forEach(b => {
            b.answer = (b.texts.join(' ') || b.files.join(' ') || (b.images.length ? IMG_TOKEN : '')).trim();
        });

        // Valores por item
        const matched = matchBlocks(blocks);
        const geo = extractGeopoint(fullText);
        const values = {};
        const found = {};
        const imageMap = {};
        const evidence = {};
        AUDIT_ITEMS.forEach(def => {
            if (GEO_FIELDS[def.id] !== undefined) {
                values[def.id] = geo ? geo[GEO_FIELDS[def.id]] : '';
                found[def.id] = true;
            } else {
                values[def.id] = matched[def.id] ? matched[def.id].answer : '';
                found[def.id] = Boolean(matched[def.id]);
                if (matched[def.id] && matched[def.id].images.length) imageMap[def.id] = matched[def.id].images;
                if (matched[def.id]) evidence[def.id] = evidenceOf(matched[def.id]);
            }
        });
        Object.keys(DERIVED).forEach(id => {
            values[id] = DERIVED[id](values, format);
            found[id] = true;
        });

        const notApplicableReasons = applyApplicabilityRules(values, found);

        const items = AUDIT_ITEMS.map(def => {
            const item = {
                ...def,
                pdfName: key,
                globalId: `${key}::${def.id}`,
                status: 'pending',
                observation: '',
                notes: '',
                autoReason: '',
                imageNote: '',
                reasonCode: '',
                notApplicable: Boolean(notApplicableReasons[def.id]),
                notApplicableReason: notApplicableReasons[def.id] || '',
                found: found[def.id],
                evidence: evidence[def.id] || null,
                actualValue: values[def.id] || '',
                searchKey: fold(`${def.description} ${def.section} ${key}`)
            };
            validateItem(item, values, ctx);
            return item;
        });

        // Solo el formato A (KoboToolbox) es válido: cualquier otro se rechaza completo
        if (format !== 'A') {
            items.forEach(item => {
                item.notApplicable = false;
                item.notApplicableReason = '';
                item.status = 'non-compliant';
                item.reasonCode = 'invalid_form';
                item.observation = 'Formulario No valido';
                item.autoReason = '';
                item.evidence = { page: 1, full: true };
            });
            pdfDocuments[key] = { status: 'processed', format, items, file };
            allItemsData.push(...items);
            return { key, ok: true };
        }

        // Contenido de las imágenes (OCR local + análisis de píxeles)
        if (readPixels && (Object.keys(imageMap).length || (hooks.folderImages && hooks.folderImages.length))) {
            await verifyImages(items, imageMap, values, hooks, hooks.folderImages || []);
        }

        pdfDocuments[key] = { status: 'processed', format, items, file };
        allItemsData.push(...items);
        return { key, ok: true };

    } catch (error) {
        console.error(`Error procesando ${key}:`, error);
        pdfDocuments[key] = { status: 'error', error: error.message };
        return { key, ok: false, error: error.message };
    } finally {
        if (pdfDoc) pdfDoc.destroy().catch(() => {});
    }
}

/** Clave única por archivo (evita colisiones si hay mismo nombre en subcarpetas) */
function uniqueFileKey(path) {
    let key = path;
    let n = 2;
    while (key in pdfDocuments) key = `${path} (${n++})`;
    return key;
}

/* ============ NIU vs LISTA DE BENEFICIARIOS ============ */

let niuIndex = null;

function niuKey(niu) {
    const digits = String(niu || '').match(/\d+/g);
    return digits ? digits[digits.length - 1].replace(/^0+/, '') : '';
}

/** Números de la dirección sin el código de dispositivo (DPL BA1234, BC5551...) */
function addressNumbers(address) {
    const text = String(address || '').toUpperCase()
        .replace(/\bDPL\b.*$/, '')
        .replace(/\b[A-Z]{2}\s?\d{3,}\b/g, '');
    return (text.match(/\d+/g) || []).map(n => String(Number(n)));
}

function sameAddress(a, b) {
    const x = addressNumbers(a).sort().join(',');
    const y = addressNumbers(b).sort().join(',');
    return x !== '' && x === y;
}

/** Devuelve un mensaje de error, o '' si el NIU existe en el listado y su dirección coincide */
function checkNiuAgainstList(niu, address) {
    if (typeof BENEFICIARIOS === 'undefined') return '';
    if (!niuIndex) {
        niuIndex = new Map();
        BENEFICIARIOS.forEach(b => niuIndex.set(niuKey(b.niu), b));
    }
    const rec = niuIndex.get(niuKey(niu));
    if (!rec) {
        const suggested = BENEFICIARIOS.filter(b => sameAddress(address, b.direccion));
        if (suggested.length) {
            const list = suggested.slice(0, 3).map(b => `${b.niu} (${b.direccion})`).join(' · ');
            return `El NIU ${niu} no está en el listado de beneficiarios. NIU correcto según la dirección: ${list}`;
        }
        return `El NIU ${niu} no está en el listado de beneficiarios y no se encontró la dirección en el listado`;
    }
    if (!sameAddress(address, rec.direccion)) {
        return `La dirección no coincide con el listado para el NIU ${niu}. PDF: "${address}" · Listado: "${rec.direccion}"`;
    }
    return '';
}

/* ============ VALIDACIÓN ============ */

/**
 * Valida un item. Estados: 'compliant' (CUMPLE), 'non-compliant' (NO CUMPLE),
 * 'review' (REVISAR: dato no obligatorio/dudoso). 'pending' solo si se marca a mano.
 * values = respuestas de todos los items del mismo PDF (para los condicionales).
 * ctx = { format, annexCount }
 */
function validateItem(item, values, ctx = { format: 'A', annexCount: 0 }) {
    const value = (item.actualValue || '').trim();
    const cond = CONDITIONS[item.id];
    const isFileType = item.type === 'file';

    item.status = 'compliant';
    item.observation = '';
    item.autoReason = '';
    item.reasonCode = '';

    if (item.notApplicable) {
        item.autoReason = item.notApplicableReason;
        return;
    }

    // Riesgos eléctricos o estructurales: siempre CUMPLE
    if (item.id === 105) return;

    const fail = (code, message) => {
        item.status = 'non-compliant';
        item.reasonCode = code;
        item.observation = message;
    };
    const review = message => {
        item.status = 'review';
        item.reasonCode = 'review';
        item.observation = message;
    };

    // ---- Correos: no obligatorios; si faltan o tienen mal formato -> REVISAR ----
    if (REVIEW_ONLY[item.id]) {
        if (!value) return review('No se registró el correo electrónico');
        if (!EMAIL_RE.test(value)) return review('Formato de correo inválido');
        return;
    }

    // ---- Sin respuesta ----
    if (!value) {
        const parentValue = cond && cond.parent ? normalizeText(values[cond.parent]) : '';
        const required = cond && !cond.optional && parentValue && cond.when(parentValue);

        if (cond && !required) {
            item.autoReason = cond.optional ? 'Opcional: sin respuesta' : 'No aplica según las respuestas previas';
            return;
        }

        if (isFileType && ctx.format === 'B') {
            // El formato B no incluye imágenes: no se puede comprobar
            const note = ctx.annexCount > 0
                ? `El formato no indica a qué pregunta pertenece cada imagen (${ctx.annexCount} anexos): verificar manualmente`
                : 'El registro no incluye imágenes (0 anexos): verificar en Kobo';
            if (FORMAT_B_FILES_STATUS === 'non-compliant' && ctx.annexCount === 0) return fail('missing_file', 'Sin imágenes en el registro (0 anexos)');
            return review(note);
        }

        if (required) return fail('conditional', `Obligatorio porque ${cond.why}${isFileType ? ' (falta el archivo)' : ''}`);
        if (DERIVED[item.id]) return fail('missing_file', 'No hay certificado de tradición y libertad');
        if (!item.found && ctx.format !== 'B') return fail('not_found', 'La pregunta no aparece en el PDF');
        if (!item.mandatory) { item.autoReason = 'Opcional: sin respuesta'; return; }
        return isFileType
            ? fail('missing_file', 'Falta la foto / archivo adjunto')
            : fail('empty', 'Campo obligatorio vacío o sin respuesta');
    }

    // ---- Con respuesta ----
    const isFile = looksLikeFile(value);
    if (isFileType) {
        if (!isFile) fail('missing_file', 'No hay un archivo adjunto válido');
        return;
    }
    if (isFile) {
        return fail('wrong_attachment', 'Hay un archivo adjunto donde se esperaba una respuesta (SI/NO o texto)');
    }

    if (item.id === 85) {
        const check = checkNiuAgainstList(value, values[6]);
        if (check) return fail('niu_list', check);
        return;
    }

    const rule = item.validationRule || 'notEmpty';
    if ((rule === 'isNumber' || item.type === 'number') && !NUMBER_RE.test(value.replace(/\s/g, ''))) {
        return fail('format', 'No es un número válido');
    }
    if (rule.startsWith('equals:')) {
        const expected = rule.slice('equals:'.length);
        if (normalizeText(value) !== normalizeText(expected)) {
            return fail('mismatch', `Esperado: ${expected} · Encontrado: ${value}`);
        }
    }
}
