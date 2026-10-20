/**
 * INFORME DE INTERVENTORÍA
 *
 *  - Cada PDF procesado (o corregido a mano) se guarda en IndexedDB con sus hallazgos NO CUMPLE y REVISAR
 *    y el recorte del PDF que sirve de evidencia. Persiste aunque se reinicie el navegador.
 *  - Con lo guardado se arma un informe con gráficos y análisis, que se puede exportar solo en HTML.
 *  - El informe guardado es independiente del avance de revisión: se elimina con su propio botón.
 */
const REPORT_DB = 'caracter-informe';
const REPORT_STORE = 'pdfs';
const REPORT_SCALE = 1.2;
const REPORT_QUALITY = 0.62;
const REPORT_FULL_PAGE_WIDTH = 640;

const REPORT_REASON_EXTRA = {
    review: 'Pendiente de verificación manual (el sistema no pudo confirmar)'
};

const REPORT_ACTIONS = {
    empty: 'Exigir el diligenciamiento completo del formulario y devolver el PDF para subsanación antes de aprobar la caracterización.',
    missing_file: 'Solicitar al contratista las fotografías y soportes faltantes, y verificar su carga en KoboToolbox.',
    conditional: 'Revisar la lógica condicional del formulario: hay campos requeridos según respuestas previas que quedaron vacíos.',
    format: 'Corregir los datos con formato inválido (cédulas, matrículas, teléfonos, fechas) con el beneficiario o la fuente.',
    mismatch: 'Verificar en campo las respuestas que difieren de lo esperado (por ejemplo NIC, NIU, matrícula distinta de 040).',
    wrong_attachment: 'Reemplazar el archivo adjunto que se cargó en lugar de la respuesta solicitada.',
    wrong_image: 'Reponer las fotos que no corresponden a la pregunta; reforzar la capacitación del personal de campo en la toma de evidencias.',
    image_quality: 'Repetir las fotos en blanco o ilegibles; exigir evidencia nítida y completa.',
    not_found: 'Confirmar por qué las preguntas no están en el PDF (versión de formulario o exportación incompleta).',
    niu_list: 'Validar con el listado de beneficiarios el NIU y la dirección; descartar visitas a viviendas distintas a las asignadas.',
    invalid_form: 'Rechazar los formularios que no son del formato KoboToolbox válido y solicitar su nueva exportación.',
    manual: 'Atender las observaciones registradas manualmente por el interventor.',
    review: 'Verificar visualmente la evidencia señalada; el sistema no pudo confirmar el dato con certeza.'
};

const REPORT_PRIORITY_ORDER = { critico: 0, alto: 1, medio: 2, bajo: 3 };

/* ============ BASE DE DATOS ============ */
let reportDbPromise = null;

function reportOpenDb() {
    if (!reportDbPromise) {
        reportDbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB no disponible')); return; }
            const req = indexedDB.open(REPORT_DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(REPORT_STORE, { keyPath: 'key' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return reportDbPromise;
}

async function reportRun(mode, action) {
    const db = await reportOpenDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(REPORT_STORE, mode);
        const request = action(tx.objectStore(REPORT_STORE));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

const reportGet = key => reportRun('readonly', s => s.get(key));
const reportPut = rec => reportRun('readwrite', s => s.put(rec));
const reportAll = () => reportRun('readonly', s => s.getAll()).then(list => list || []);
const reportClear = () => reportRun('readwrite', s => s.clear());

/* ============ CAPTURA DE HALLAZGOS ============ */

function reportContext(path) {
    const parts = String(path || '').split(/[\\/]/);
    const lote = parts.find(p => /^lote\s*\d+/i.test(p.trim()));
    const barrioPart = parts.find(p => /^PDFS\s+/i.test(p.trim()));
    const barrio = barrioPart
        ? barrioPart.replace(/^PDFS\s+/i, '').replace(/\s*PAQUETE.*$/i, '').replace(/^BARRIO\s+/i, '').trim()
        : '';
    return { lote: lote ? lote.trim() : 'Sin lote', barrio: barrio || 'Sin barrio' };
}

function reportCropKey(ev) {
    const e = ev || { page: 1, full: true };
    return `${e.page || 1}|${e.full || typeof e.top !== 'number' ? 1 : 0}|${Math.round(e.top || 0)}|${Math.round(e.bottom || 0)}`;
}

async function reportRenderCrop(pdf, pages, ev) {
    const e = ev || { page: 1, full: true };
    const pageNo = Math.min(Math.max(1, e.page || 1), pdf.numPages);
    let full = pages[pageNo];
    if (!full) {
        const page = await pdf.getPage(pageNo);
        const viewport = page.getViewport({ scale: REPORT_SCALE });
        full = document.createElement('canvas');
        full.width = Math.ceil(viewport.width);
        full.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;
        full.pageHeight = viewport.height / REPORT_SCALE;
        pages[pageNo] = full;
    }
    const wholePage = e.full || typeof e.top !== 'number';
    let sy = 0, sh = full.height;
    if (!wholePage) {
        const pad = 12 * REPORT_SCALE;
        sy = Math.max(0, (e.pageHeight - e.top) * REPORT_SCALE - pad);
        const ey = Math.min(full.height, (e.pageHeight - e.bottom) * REPORT_SCALE + pad);
        sh = Math.max(40, ey - sy);
    }
    const k = wholePage ? Math.min(1, REPORT_FULL_PAGE_WIDTH / full.width) : 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(full.width * k));
    out.height = Math.max(1, Math.round(sh * k));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(full, 0, sy, full.width, sh, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', REPORT_QUALITY);
}

async function reportBuildRecord(key) {
    const doc = pdfDocuments[key];
    if (!doc || doc.status !== 'processed' || !doc.items) return null;
    const previous = await reportGet(key).catch(() => null);
    const stats = computeStats(doc.items);
    const sections = {};
    doc.items.forEach(item => {
        if (item.notApplicable) return;
        const s = sections[item.section] || (sections[item.section] = { total: 0, nc: 0, rev: 0 });
        s.total++;
        if (item.status === 'non-compliant') s.nc++;
        else if (item.status !== 'compliant') s.rev++;
    });

    const invalid = doc.format !== 'A';
    const flagged = doc.items.filter(i => !i.notApplicable && i.status !== 'compliant');
    const images = {};
    const items = [];
    let pdf = null;
    const pages = {};
    try {
        const wanted = invalid ? [{ evidence: { page: 1, full: true } }] : flagged;
        for (const item of wanted) {
            const cropKey = reportCropKey(item.evidence);
            if (!(cropKey in images)) {
                if (previous && previous.images && previous.images[cropKey]) images[cropKey] = previous.images[cropKey];
                else {
                    try {
                        if (!pdf && doc.file) pdf = await pdfjsLib.getDocument({ data: await doc.file.arrayBuffer() }).promise;
                        images[cropKey] = pdf ? await reportRenderCrop(pdf, pages, item.evidence) : '';
                    } catch (error) {
                        console.warn('No se pudo capturar la evidencia', key, error);
                        images[cropKey] = '';
                    }
                }
            }
            if (invalid) continue;
            items.push({
                id: item.id,
                description: item.description,
                section: item.section,
                priority: item.priority,
                status: item.status === 'non-compliant' ? 'non-compliant' : 'review',
                reasonCode: item.reasonCode || (item.status === 'non-compliant' ? 'manual' : 'review'),
                observation: item.observation || item.autoReason || '',
                notes: item.notes || '',
                imageNote: item.imageNote || '',
                actualValue: String(item.actualValue || '').slice(0, 240),
                cropKey
            });
        }
    } finally {
        if (pdf) pdf.destroy();
    }
    items.sort((a, b) => (REPORT_PRIORITY_ORDER[a.priority] ?? 9) - (REPORT_PRIORITY_ORDER[b.priority] ?? 9) || a.id - b.id);

    return {
        key,
        name: String(key).split(/[\\/]/).pop(),
        ...reportContext(key),
        format: doc.format,
        invalid,
        savedAt: new Date().toISOString(),
        stats,
        sections,
        items,
        images
    };
}

let reportQueue = Promise.resolve();

/** Guarda (o actualiza) el informe de un PDF; las llamadas se encolan para no saturar el navegador */
function syncReport(key) {
    reportQueue = reportQueue.then(async () => {
        const record = await reportBuildRecord(key);
        if (record) await reportPut(record);
        reportScheduleRefresh();
    }).catch(error => {
        console.warn('No se pudo guardar el informe de', key, error);
        if (!syncReport.warned) {
            syncReport.warned = true;
            showToast('No se pudo guardar el informe de interventoría (¿almacenamiento lleno?)', 'warning', 8000);
        }
    });
    return reportQueue;
}

/* ============ ANÁLISIS ============ */

const rpEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rpPct = (n, d) => (d ? (n / d) * 100 : 0);
const rpFmt = n => `${n.toFixed(1)}%`;
const rpNum = n => n.toLocaleString('es-CO');
const rpPriorityName = p => (typeof PRIORITY_LABEL !== 'undefined' && PRIORITY_LABEL[p]) || p || '';
const rpReasonName = code => (typeof REASON_LABELS !== 'undefined' && REASON_LABELS[code]) || REPORT_REASON_EXTRA[code] || code;

function rpAggregate(map, name) {
    return map[name] || (map[name] = { name, pdfs: 0, total: 0, ok: 0, nc: 0, rev: 0, clean: 0 });
}

function rpAnalyze(records) {
    const valid = records.filter(r => !r.invalid);
    const T = { pdfs: records.length, valid: valid.length, invalid: records.length - valid.length, total: 0, ok: 0, nc: 0, rev: 0, na: 0 };
    const lotes = {}, barrios = {}, sections = {}, itemMap = {}, reasons = {};
    const priorities = { critico: { nc: 0, rev: 0 }, alto: { nc: 0, rev: 0 }, medio: { nc: 0, rev: 0 }, bajo: { nc: 0, rev: 0 } };

    records.forEach(r => {
        const label = `${r.barrio} · ${r.lote}`;
        [[lotes, label], [barrios, r.barrio]].forEach(([map, name]) => {
            const g = rpAggregate(map, name);
            g.pdfs++;
            if (r.invalid) { g.invalid = (g.invalid || 0) + 1; return; }
            g.total += r.stats.total;
            g.ok += r.stats.compliant;
            g.nc += r.stats.nonCompliant;
            g.rev += r.stats.review + r.stats.pending;
            if (!r.stats.nonCompliant && !r.stats.review && !r.stats.pending) g.clean++;
        });
        if (r.invalid) { reasons.invalid_form = (reasons.invalid_form || 0) + 1; return; }
        T.total += r.stats.total;
        T.ok += r.stats.compliant;
        T.nc += r.stats.nonCompliant;
        T.rev += r.stats.review + r.stats.pending;
        T.na += r.stats.notApplicable;
        Object.entries(r.sections).forEach(([name, s]) => {
            const g = sections[name] || (sections[name] = { name, total: 0, nc: 0, rev: 0 });
            g.total += s.total; g.nc += s.nc; g.rev += s.rev;
        });
        r.items.forEach(it => {
            const g = itemMap[it.id] || (itemMap[it.id] = { id: it.id, description: it.description, section: it.section, priority: it.priority, nc: 0, rev: 0 });
            const bucket = priorities[it.priority] || (priorities[it.priority] = { nc: 0, rev: 0 });
            if (it.status === 'non-compliant') {
                g.nc++; bucket.nc++;
                reasons[it.reasonCode] = (reasons[it.reasonCode] || 0) + 1;
            } else {
                g.rev++; bucket.rev++;
                reasons.review = (reasons.review || 0) + 1;
            }
        });
    });

    const pdfRows = records.map(r => ({
        r,
        pct: r.invalid ? 0 : r.stats.pct,
        nc: r.stats.nonCompliant,
        rev: r.stats.review + r.stats.pending
    }));
    const hist = [
        { label: 'Menos de 50 %', min: -1, max: 50, color: '#c0392b' },
        { label: '50 – 69,9 %', min: 50, max: 70, color: '#e67e22' },
        { label: '70 – 84,9 %', min: 70, max: 85, color: '#f1c40f' },
        { label: '85 – 94,9 %', min: 85, max: 95, color: '#7cb342' },
        { label: '95 % o más', min: 95, max: 101, color: '#2e9e5b' }
    ].map(b => ({ ...b, value: pdfRows.filter(p => !p.r.invalid && p.pct >= b.min && p.pct < b.max).length }));

    const rankedItems = Object.values(itemMap).sort((a, b) => (b.nc + b.rev) - (a.nc + a.rev) || b.nc - a.nc);
    const ncTotal = rankedItems.reduce((a, i) => a + i.nc, 0);
    let acc = 0, pareto = 0;
    [...rankedItems].sort((a, b) => b.nc - a.nc).forEach(i => {
        if (ncTotal && acc < ncTotal * 0.8 && i.nc) { acc += i.nc; pareto++; }
    });

    return { T, valid, lotes: Object.values(lotes), barrios: Object.values(barrios), sections: Object.values(sections),
        rankedItems, reasons, priorities, pdfRows, hist, pareto, ncTotal, pct: rpPct(T.ok, T.total) };
}

function rpVerdict(pct) {
    if (pct >= 95) return { text: 'CONFORME', color: '#2e9e5b', detail: 'El nivel de cumplimiento es alto; los hallazgos son puntuales.' };
    if (pct >= 85) return { text: 'CONFORME CON OBSERVACIONES', color: '#7cb342', detail: 'Hay hallazgos recurrentes que deben subsanarse antes de la aprobación final.' };
    if (pct >= 70) return { text: 'NO CONFORME – REQUIERE PLAN DE MEJORA', color: '#e67e22', detail: 'El volumen de incumplimientos exige un plan de mejora y verificación posterior.' };
    return { text: 'NO CONFORME – CRÍTICO', color: '#c0392b', detail: 'El nivel de incumplimiento compromete la validez de la caracterización.' };
}

function rpNarrative(a) {
    const { T } = a;
    const out = { summary: [], findings: [], actions: [] };
    if (!T.pdfs) return out;
    const lotesTxt = a.lotes.length === 1 ? '1 lote' : `${a.lotes.length} lotes`;
    out.summary.push(`Se auditaron <b>${rpNum(T.pdfs)}</b> PDF(s) de ${lotesTxt}: ${rpNum(T.valid)} con formulario válido y ${rpNum(T.invalid)} rechazado(s) por no ser el formato KoboToolbox válido.`);
    if (T.valid) {
        out.summary.push(`Sobre los formularios válidos se evaluaron <b>${rpNum(T.total)}</b> ítems aplicables (${rpNum(T.na)} no aplican por reglas del programa). Cumplen <b>${rpNum(T.ok)}</b> (${rpFmt(a.pct)}), no cumplen <b>${rpNum(T.nc)}</b> (${rpFmt(rpPct(T.nc, T.total))}) y <b>${rpNum(T.rev)}</b> (${rpFmt(rpPct(T.rev, T.total))}) quedan en revisión.`);
    }
    if (T.invalid) out.findings.push(`<b>${rpNum(T.invalid)} PDF(s)</b> fueron rechazados por formulario no válido (${rpFmt(rpPct(T.invalid, T.pdfs))} del total). No se evalúan sus ítems individualmente.`);

    const top = a.rankedItems.slice(0, 3);
    if (top.length) {
        out.findings.push(`Los ítems con más hallazgos son: ${top.map(i => `<b>#${i.id}</b> «${rpEsc(i.description.slice(0, 90))}» (${i.nc} no cumple, ${i.rev} revisar)`).join('; ')}.`);
    }
    if (a.ncTotal) out.findings.push(`Concentración (Pareto): <b>${a.pareto}</b> ítem(s) distinto(s) explican el 80 % de los NO CUMPLE (${rpNum(a.ncTotal)} en total). Atacar esos ítems es la forma más rápida de mejorar el resultado.`);

    const reasons = Object.entries(a.reasons).filter(([code]) => code !== 'review' && code !== 'invalid_form').sort((x, y) => y[1] - x[1]);
    if (reasons.length) {
        const [code, n] = reasons[0];
        out.findings.push(`El motivo de incumplimiento predominante es «<b>${rpEsc(rpReasonName(code))}</b>» con ${rpNum(n)} caso(s) (${rpFmt(rpPct(n, a.ncTotal))} de los NO CUMPLE).`);
    }
    const sections = a.sections.filter(s => s.total).map(s => ({ ...s, rate: rpPct(s.nc + s.rev, s.total) })).sort((x, y) => y.rate - x.rate);
    if (sections.length) {
        const s = sections[0];
        out.findings.push(`La sección con mayor tasa de hallazgos es «<b>${rpEsc(s.name)}</b>»: ${rpFmt(s.rate)} de sus ítems no cumplen o requieren revisión.`);
    }
    const critical = a.priorities.critico;
    if (critical && (critical.nc || critical.rev)) {
        out.findings.push(`Hay <b>${rpNum(critical.nc)}</b> NO CUMPLE y <b>${rpNum(critical.rev)}</b> REVISAR en ítems de prioridad <b>crítica</b>; deben resolverse primero.`);
    }
    const lotes = a.lotes.filter(l => l.total).map(l => ({ ...l, pct: rpPct(l.ok, l.total) })).sort((x, y) => x.pct - y.pct);
    if (lotes.length > 1) {
        const worst = lotes[0], best = lotes[lotes.length - 1];
        out.findings.push(`Lote con menor cumplimiento: <b>${rpEsc(worst.name)}</b> (${rpFmt(worst.pct)}). Lote con mayor cumplimiento: <b>${rpEsc(best.name)}</b> (${rpFmt(best.pct)}).`);
    }
    const low = a.pdfRows.filter(p => !p.r.invalid && p.pct < 70).length;
    const clean = a.pdfRows.filter(p => !p.r.invalid && !p.nc && !p.rev).length;
    out.findings.push(`<b>${rpNum(low)}</b> PDF(s) tienen cumplimiento inferior al 70 % y <b>${rpNum(clean)}</b> no presentan ningún hallazgo.`);
    if (T.rev) out.findings.push(`Los <b>${rpNum(T.rev)}</b> ítem(s) en REVISAR no son incumplimientos confirmados: el sistema no pudo validar el dato o la imagen con certeza y requieren verificación visual por parte del interventor (se adjunta la evidencia).`);

    reasons.slice(0, 5).forEach(([code]) => { if (REPORT_ACTIONS[code]) out.actions.push(`<b>${rpEsc(rpReasonName(code))}:</b> ${rpEsc(REPORT_ACTIONS[code])}`); });
    if (a.reasons.invalid_form) out.actions.push(`<b>${rpEsc(rpReasonName('invalid_form'))}:</b> ${rpEsc(REPORT_ACTIONS.invalid_form)}`);
    if (T.rev) out.actions.push(`<b>Revisión manual:</b> ${rpEsc(REPORT_ACTIONS.review)}`);
    out.actions.push('Realizar una nueva auditoría de los PDFs corregidos y comparar contra este informe para verificar el cierre de hallazgos.');
    return out;
}

/* ============ GRÁFICOS ============ */

function rpDonut(parts, centerTop, centerBottom) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    const R = 70, C = 2 * Math.PI * R;
    let offset = 0;
    const arcs = total ? parts.filter(p => p.value > 0).map(p => {
        const len = (p.value / total) * C;
        const svg = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${p.color}" stroke-width="30" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 100 100)"/>`;
        offset += len;
        return svg;
    }).join('') : `<circle cx="100" cy="100" r="${R}" fill="none" stroke="#e3e8ef" stroke-width="30"/>`;
    const legend = parts.map(p => `<li><span class="dot" style="background:${p.color}"></span>${rpEsc(p.label)}: <b>${rpNum(p.value)}</b> (${rpFmt(rpPct(p.value, total))})</li>`).join('');
    return `<div class="donut"><svg viewBox="0 0 200 200" role="img"><circle cx="100" cy="100" r="${R}" fill="none" stroke="#eef1f6" stroke-width="30"/>${arcs}
        <text x="100" y="98" text-anchor="middle" class="d-top">${rpEsc(centerTop)}</text>
        <text x="100" y="118" text-anchor="middle" class="d-bot">${rpEsc(centerBottom)}</text></svg><ul class="legend">${legend}</ul></div>`;
}

function rpBars(rows, color, suffix = '') {
    const max = Math.max(1, ...rows.map(r => r.value));
    if (!rows.length) return '<p class="muted">Sin datos.</p>';
    return `<div class="bars">${rows.map(r => `<div class="bar-row"><div class="bar-label" title="${rpEsc(r.label)}">${rpEsc(r.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(r.value / max) * 100}%;background:${r.color || color}"></div></div>
        <div class="bar-value">${rpNum(r.value)}${suffix}</div></div>`).join('')}</div>`;
}

function rpStacked(rows) {
    if (!rows.length) return '<p class="muted">Sin datos.</p>';
    return `<div class="bars">${rows.map(r => {
        const t = r.ok + r.nc + r.rev || 1;
        return `<div class="bar-row"><div class="bar-label" title="${rpEsc(r.name)}">${rpEsc(r.name)}</div>
        <div class="bar-track stacked"><div style="width:${(r.ok / t) * 100}%;background:#2e9e5b" title="Cumple ${r.ok}"></div><div style="width:${(r.rev / t) * 100}%;background:#f1b92d" title="Revisar ${r.rev}"></div><div style="width:${(r.nc / t) * 100}%;background:#d64545" title="No cumple ${r.nc}"></div></div>
        <div class="bar-value">${rpFmt(rpPct(r.ok, t))}</div></div>`;
    }).join('')}</div>`;
}

/* ============ HTML DEL INFORME ============ */

const REPORT_CSS = `
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',Arial,sans-serif;color:#1c2536;background:#f3f5f9;line-height:1.5}
.wrap{max-width:1180px;margin:0 auto;padding:24px}
.cover{background:linear-gradient(135deg,#0f2447,#1f4e8c);color:#fff;border-radius:14px;padding:32px 36px}
.cover h1{margin:0 0 6px;font-size:28px}.cover p{margin:2px 0;opacity:.9}
.verdict{display:inline-block;margin-top:16px;padding:8px 16px;border-radius:8px;font-weight:700;color:#fff}
h2{margin:34px 0 12px;font-size:20px;color:#0f2447;border-bottom:3px solid #ffc24b;padding-bottom:6px}
h3{margin:0 0 10px;font-size:15px;color:#0f2447}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
.kpi{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 4px rgba(15,36,71,.1);border-left:5px solid #1f4e8c}
.kpi b{display:block;font-size:26px}.kpi span{font-size:12px;color:#5c6b86;text-transform:uppercase;letter-spacing:.04em}
.kpi.ok{border-color:#2e9e5b}.kpi.nc{border-color:#d64545}.kpi.rev{border-color:#f1b92d}.kpi.na{border-color:#8895ad}
.card{background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 1px 4px rgba(15,36,71,.1);margin-bottom:16px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
ul.text{margin:6px 0 0;padding-left:20px}ul.text li{margin:7px 0}
.donut{display:flex;align-items:center;gap:20px;flex-wrap:wrap}.donut svg{width:190px;height:190px}
.d-top{font-size:26px;font-weight:700;fill:#0f2447}.d-bot{font-size:11px;fill:#5c6b86}
.legend{list-style:none;margin:0;padding:0;font-size:13px}.legend li{margin:5px 0}.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:7px}
.bars{display:flex;flex-direction:column;gap:7px}.bar-row{display:grid;grid-template-columns:minmax(120px,32%) 1fr 62px;gap:10px;align-items:center;font-size:12.5px}
.bar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar-track{background:#eef1f6;border-radius:6px;height:16px;overflow:hidden;display:flex}
.bar-fill{height:100%;border-radius:6px}.bar-track.stacked div{height:100%}.bar-value{text-align:right;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}th{background:#0f2447;color:#fff;text-align:left;padding:8px 10px;position:sticky;top:0}
td{padding:7px 10px;border-bottom:1px solid #e3e8ef;vertical-align:top}tr:nth-child(even) td{background:#f8f9fc}
.tablebox{max-height:520px;overflow:auto;border-radius:10px;border:1px solid #e3e8ef}
.chip{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700;color:#fff}
.chip.nc{background:#d64545}.chip.rev{background:#d89b0a}.chip.ok{background:#2e9e5b}.chip.p-critico{background:#8e1b1b}.chip.p-alto{background:#d64545}.chip.p-medio{background:#d89b0a}.chip.p-bajo{background:#6b7a99}
details.pdf{background:#fff;border-radius:10px;margin-bottom:10px;box-shadow:0 1px 4px rgba(15,36,71,.1)}
details.pdf>summary{cursor:pointer;padding:12px 16px;font-weight:600;list-style:none;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
details.pdf>summary::before{content:'▸';color:#1f4e8c}details.pdf[open]>summary::before{content:'▾'}
.pdf-body{padding:4px 16px 16px}.finding-group{margin:14px 0 6px;font-weight:700}
.findings{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px}
.finding{border:1px solid #e3e8ef;border-radius:10px;overflow:hidden;background:#fff}.finding.nc{border-top:4px solid #d64545}.finding.rev{border-top:4px solid #f1b92d}
.finding .fh{padding:10px 12px}.finding .fh .meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;font-size:12px;color:#5c6b86;align-items:center}
.finding .desc{font-weight:600;font-size:13px}.finding .obs{font-size:12.5px;margin-top:6px}.finding .obs i{color:#5c6b86;font-style:normal}
.finding img{display:block;width:100%;border-top:1px solid #e3e8ef;cursor:zoom-in;background:#fff}
.finding img.zoom{position:fixed;inset:2vh 2vw;width:96vw;height:96vh;object-fit:contain;z-index:50;background:#000d;cursor:zoom-out;border:0}
.noimg{padding:10px 12px;font-size:12px;color:#8895ad;border-top:1px solid #e3e8ef}
.alert{background:#fdecea;border-left:5px solid #d64545;padding:10px 14px;border-radius:6px}
.muted{color:#6b7a99;font-size:13px}.toolbar{display:flex;gap:8px;margin:8px 0}
button{background:#1f4e8c;color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px}
footer{margin:36px 0 12px;font-size:12px;color:#6b7a99;text-align:center}
@media print{body{background:#fff}.toolbar{display:none}.card,.kpi,details.pdf{box-shadow:none;border:1px solid #ccd3e0}.finding{break-inside:avoid}.tablebox{max-height:none;overflow:visible}}
`;

function rpFindingCard(item, record) {
    const cls = item.status === 'non-compliant' ? 'nc' : 'rev';
    const img = record.images[item.cropKey];
    const note = item.observation || item.imageNote;
    return `<div class="finding ${cls}"><div class="fh"><div class="meta">
        <span class="chip ${cls}">${cls === 'nc' ? 'NO CUMPLE' : 'REVISAR'}</span>
        <span class="chip p-${rpEsc(item.priority)}">${rpEsc(rpPriorityName(item.priority))}</span>
        <span>Ítem #${item.id} · ${rpEsc(item.section)}</span></div>
        <div class="desc">${rpEsc(item.description)}</div>
        <div class="obs"><i>Motivo:</i> ${rpEsc(rpReasonName(item.reasonCode))}</div>
        ${note ? `<div class="obs"><i>Observación:</i> ${rpEsc(note)}</div>` : ''}
        ${item.actualValue ? `<div class="obs"><i>Valor registrado:</i> ${rpEsc(item.actualValue)}</div>` : ''}
        ${item.notes ? `<div class="obs"><i>Notas del interventor:</i> ${rpEsc(item.notes)}</div>` : ''}</div>
        ${img ? `<img src="${img}" alt="Evidencia ítem ${item.id}">` : '<div class="noimg">Evidencia no disponible</div>'}</div>`;
}

function rpPdfDetail(row, index) {
    const r = row.r;
    const nc = r.items.filter(i => i.status === 'non-compliant');
    const rev = r.items.filter(i => i.status !== 'non-compliant');
    const head = r.invalid
        ? '<span class="chip nc">FORMULARIO NO VÁLIDO</span>'
        : `<span class="chip ${row.nc ? 'nc' : row.rev ? 'rev' : 'ok'}">${rpFmt(row.pct)}</span><span class="muted">${row.nc} no cumple · ${row.rev} revisar</span>`;
    let body = '';
    if (r.invalid) {
        const img = Object.values(r.images)[0];
        body = `<div class="alert">El formulario no corresponde al formato KoboToolbox válido; se rechaza completo.</div>${img ? `<div class="findings"><div class="finding nc"><img src="${img}" alt="Primera página"></div></div>` : ''}`;
    } else {
        if (nc.length) body += `<div class="finding-group">NO CUMPLE (${nc.length})</div><div class="findings">${nc.map(i => rpFindingCard(i, r)).join('')}</div>`;
        if (rev.length) body += `<div class="finding-group">REVISAR (${rev.length})</div><div class="findings">${rev.map(i => rpFindingCard(i, r)).join('')}</div>`;
        if (!body) body = '<p class="muted">Sin hallazgos.</p>';
    }
    return `<details class="pdf" id="pdf-${index}"><summary>${rpEsc(r.name)} <span class="muted">${rpEsc(r.barrio)} · ${rpEsc(r.lote)}</span> ${head}</summary><div class="pdf-body">${body}</div></details>`;
}

function buildReportHtml(records) {
    const a = rpAnalyze(records);
    const { T } = a;
    const verdict = rpVerdict(a.pct);
    const story = rpNarrative(a);
    const date = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });

    const sortedRows = [...a.pdfRows].sort((x, y) =>
        `${x.r.barrio} ${x.r.lote}`.localeCompare(`${y.r.barrio} ${y.r.lote}`, 'es', { numeric: true }) ||
        x.r.name.localeCompare(y.r.name, 'es', { numeric: true }));

    const loteRows = a.lotes.filter(l => l.total).sort((x, y) => x.name.localeCompare(y.name, 'es', { numeric: true }));
    const sectionRows = a.sections.filter(s => s.total).map(s => ({ name: s.name, ok: s.total - s.nc - s.rev, nc: s.nc, rev: s.rev }))
        .sort((x, y) => (y.nc + y.rev) / (y.ok + y.nc + y.rev) - (x.nc + x.rev) / (x.ok + x.nc + x.rev));
    const reasonRows = Object.entries(a.reasons).sort((x, y) => y[1] - x[1])
        .map(([code, n]) => ({ label: rpReasonName(code), value: n, color: code === 'review' ? '#f1b92d' : '#d64545' }));
    const priorityRows = ['critico', 'alto', 'medio', 'bajo'].map(p => ({ label: rpPriorityName(p), nc: a.priorities[p].nc, rev: a.priorities[p].rev }));
    const maxPriority = Math.max(1, ...priorityRows.map(p => p.nc + p.rev));
    const topItems = a.rankedItems.slice(0, 15);

    const itemsTable = topItems.map((i, n) => `<tr><td>${n + 1}</td><td>#${i.id}</td><td>${rpEsc(i.description)}</td><td>${rpEsc(i.section)}</td>
        <td><span class="chip p-${rpEsc(i.priority)}">${rpEsc(rpPriorityName(i.priority))}</span></td><td>${i.nc}</td><td>${i.rev}</td><td>${rpFmt(rpPct(i.nc + i.rev, T.valid))}</td></tr>`).join('');

    const pdfTable = sortedRows.map((p, n) => `<tr><td><a href="#pdf-${n}">${rpEsc(p.r.name)}</a></td><td>${rpEsc(p.r.barrio)} · ${rpEsc(p.r.lote)}</td>
        <td>${p.r.invalid ? '<span class="chip nc">No válido</span>' : rpFmt(p.pct)}</td><td>${p.nc}</td><td>${p.rev}</td>
        <td><span class="chip ${p.r.invalid || p.nc ? 'nc' : p.rev ? 'rev' : 'ok'}">${p.r.invalid ? 'RECHAZADO' : p.nc ? 'CON INCUMPLIMIENTOS' : p.rev ? 'POR REVISAR' : 'SIN HALLAZGOS'}</span></td></tr>`).join('');

    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe de Interventoría – Colombia Solar</title><style>${REPORT_CSS}</style></head><body><div class="wrap">
<div class="cover"><h1>Informe de Interventoría</h1><p>Programa Colombia Solar · Caracterización de viviendas · Contrato OGE-17719</p>
<p>Generado: ${rpEsc(date)} · ${rpNum(T.pdfs)} PDF(s) auditados · ${a.lotes.length} lote(s)</p>
<span class="verdict" style="background:${verdict.color}">DICTAMEN SUGERIDO: ${rpEsc(verdict.text)}</span><p style="margin-top:8px">${rpEsc(verdict.detail)}</p></div>

<div class="kpis">
<div class="kpi"><b>${rpNum(T.pdfs)}</b><span>PDFs auditados</span></div>
<div class="kpi ok"><b>${rpFmt(a.pct)}</b><span>Cumplimiento global</span></div>
<div class="kpi ok"><b>${rpNum(T.ok)}</b><span>Ítems cumple</span></div>
<div class="kpi nc"><b>${rpNum(T.nc)}</b><span>Ítems no cumple</span></div>
<div class="kpi rev"><b>${rpNum(T.rev)}</b><span>Ítems por revisar</span></div>
<div class="kpi na"><b>${rpNum(T.na)}</b><span>No aplican</span></div>
<div class="kpi nc"><b>${rpNum(T.invalid)}</b><span>Formularios no válidos</span></div></div>

<h2>1. Resumen ejecutivo</h2><div class="card"><ul class="text">${story.summary.map(s => `<li>${s}</li>`).join('')}</ul></div>

<h2>2. Panorama general</h2><div class="grid2">
<div class="card"><h3>Estado de los ítems evaluados</h3>${rpDonut([
        { label: 'Cumple', value: T.ok, color: '#2e9e5b' }, { label: 'Revisar', value: T.rev, color: '#f1b92d' }, { label: 'No cumple', value: T.nc, color: '#d64545' }
    ], rpFmt(a.pct), 'cumplimiento')}</div>
<div class="card"><h3>PDFs según su nivel de cumplimiento</h3>${rpBars(a.hist.map(h => ({ label: h.label, value: h.value, color: h.color })), '#1f4e8c')}</div>
<div class="card"><h3>Hallazgos por prioridad del ítem</h3><div class="bars">${priorityRows.map(p => `<div class="bar-row"><div class="bar-label">${rpEsc(p.label)}</div>
<div class="bar-track stacked"><div style="width:${(p.nc / maxPriority) * 100}%;background:#d64545" title="No cumple ${p.nc}"></div><div style="width:${(p.rev / maxPriority) * 100}%;background:#f1b92d" title="Revisar ${p.rev}"></div></div>
<div class="bar-value">${p.nc + p.rev}</div></div>`).join('')}</div><p class="muted">Rojo: no cumple · Amarillo: revisar</p></div>
<div class="card"><h3>Hallazgos por motivo</h3>${rpBars(reasonRows, '#d64545')}</div></div>

<h2>3. Cumplimiento por lote y sección</h2><div class="grid2">
<div class="card"><h3>Por lote (verde cumple · amarillo revisar · rojo no cumple)</h3>${rpStacked(loteRows)}</div>
<div class="card"><h3>Por sección del formulario (de mayor a menor tasa de hallazgos)</h3>${rpStacked(sectionRows)}</div></div>

<h2>4. Ítems con más hallazgos</h2>
<div class="card"><div class="tablebox"><table><thead><tr><th>#</th><th>Ítem</th><th>Descripción</th><th>Sección</th><th>Prioridad</th><th>No cumple</th><th>Revisar</th><th>% PDFs afectados</th></tr></thead><tbody>${itemsTable || '<tr><td colspan="8">Sin hallazgos.</td></tr>'}</tbody></table></div></div>

<h2>5. Análisis de interventoría</h2><div class="grid2">
<div class="card"><h3>Hallazgos relevantes</h3><ul class="text">${story.findings.map(s => `<li>${s}</li>`).join('')}</ul></div>
<div class="card"><h3>Recomendaciones y acciones correctivas</h3><ul class="text">${story.actions.map(s => `<li>${s}</li>`).join('')}</ul></div></div>
<div class="card"><h3>Alcance y limitaciones</h3><p class="muted">La verificación es automática (lectura del PDF, reglas del programa, validación contra el listado de beneficiarios y OCR/clasificación local de imágenes). Los ítems en REVISAR no son incumplimientos confirmados. El dictamen es una referencia basada en el porcentaje de cumplimiento (≥95 % conforme; ≥85 % con observaciones; ≥70 % plan de mejora; &lt;70 % crítico) y no reemplaza el criterio del interventor. Informe informativo.</p></div>

<h2>6. Resultado por PDF</h2>
<div class="card"><div class="tablebox"><table><thead><tr><th>PDF</th><th>Lote</th><th>Cumplimiento</th><th>No cumple</th><th>Revisar</th><th>Estado</th></tr></thead><tbody>${pdfTable}</tbody></table></div></div>

<h2>7. Detalle de hallazgos con evidencia</h2>
<div class="toolbar"><button type="button" onclick="document.querySelectorAll('details.pdf').forEach(d=>d.open=true)">Expandir todo</button><button type="button" onclick="document.querySelectorAll('details.pdf').forEach(d=>d.open=false)">Contraer todo</button></div>
${sortedRows.map((p, n) => rpPdfDetail(p, n)).join('')}
<footer>Informe de Interventoría · Colombia Solar · generado automáticamente el ${rpEsc(date)}</footer></div>
<script>
document.addEventListener('click',function(e){var t=e.target;if(t.tagName==='IMG'&&t.closest('.finding')){t.classList.toggle('zoom');}
var l=t.closest&&t.closest('a[href^="#pdf-"]');if(l){var d=document.querySelector(l.getAttribute('href'));if(d)d.open=true;}});
window.addEventListener('beforeprint',function(){document.querySelectorAll('details.pdf').forEach(function(d){d.open=true;});});
</script></body></html>`;
}

/* ============ INTERFAZ ============ */

let reportRefreshTimer = null;

function reportScheduleRefresh() {
    clearTimeout(reportRefreshTimer);
    reportRefreshTimer = setTimeout(() => {
        if (document.getElementById('informeSection').classList.contains('active')) renderInforme();
        else updateInformeSummary();
    }, 600);
}

async function updateInformeSummary() {
    const records = await reportAll().catch(() => []);
    const findings = records.reduce((s, r) => s + r.items.length, 0);
    document.getElementById('informeSummary').textContent = records.length
        ? `${records.length} PDF(s) guardados en el informe · ${findings} hallazgo(s) con evidencia`
        : 'Aún no hay PDFs guardados en el informe. Se guardan automáticamente al procesar un lote.';
    return records;
}

async function renderInforme() {
    const records = await updateInformeSummary();
    const frame = document.getElementById('informeFrame');
    frame.srcdoc = records.length
        ? buildReportHtml(records)
        : '<body style="font-family:sans-serif;color:#556;padding:40px">Procesa un lote de PDFs: el informe se guarda y se construye automáticamente.</body>';
}

async function exportInformeHtml() {
    const records = await reportAll();
    if (!records.length) { showToast('No hay informe guardado para exportar', 'warning'); return; }
    const blob = new Blob([buildReportHtml(records)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Informe_Interventoria_${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Informe exportado en HTML', 'success');
}

async function clearInforme() {
    if (!confirm('¿Eliminar el informe de interventoría guardado? Los PDFs y el avance de revisión no se borran. Esta acción no se puede deshacer.')) return;
    await reportQueue;
    await reportClear();
    await renderInforme();
    showToast('Informe guardado eliminado', 'info');
}

async function includeLoadedInInforme() {
    const keys = Object.keys(pdfDocuments).filter(k => pdfDocuments[k].status === 'processed');
    if (!keys.length) { showToast('No hay PDFs cargados para incluir', 'warning'); return; }
    const btn = document.getElementById('informeRefreshBtn');
    btn.disabled = true;
    showToast(`Guardando ${keys.length} PDF(s) en el informe…`, 'info');
    try {
        keys.forEach(k => syncReport(k));
        await reportQueue;
        await renderInforme();
        showToast('Informe actualizado', 'success');
    } finally { btn.disabled = false; }
}

function initInforme() {
    document.getElementById('informeExportBtn').addEventListener('click', exportInformeHtml);
    document.getElementById('informeClearBtn').addEventListener('click', clearInforme);
    document.getElementById('informeRefreshBtn').addEventListener('click', includeLoadedInInforme);
    updateInformeSummary();
}
