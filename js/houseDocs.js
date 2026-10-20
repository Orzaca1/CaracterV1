/**
 * LECTURA DE DOCUMENTOS EN LA CARPETA DE IMÁGENES DE CADA VIVIENDA (OCR local, alta resolución)
 *
 *  - Recibo de energía: NIC, NIU, dirección de suministro y consumos (mes actual, mes anterior, promedio).
 *  - Cédula: número y nombre del propietario.
 *  - Certificado de libertad y tradición: matrícula inmobiliaria (debe iniciar con 040).
 *
 * Se cruza con lo diligenciado en el formulario. Si el OCR no logra leer un dato no se marca error:
 * solo se deja una nota. Si lee un dato claramente distinto, el ítem pasa a NO CUMPLE o REVISAR.
 */
const HOUSE_DOCS = { maxPerKind: 2, maxCandidates: 8, ocrMaxSide: 2400, clipSide: 448 };

async function houseFilePx(file, maxSide) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { rgba: data.data, width: canvas.width, height: canvas.height };
}

/** OCR de la foto original en escala de grises con contraste (lee mejor la letra pequeña del recibo).
 *  crop = [x0, y0, x1, y1] en fracciones de la imagen ya rotada; se amplía para leer números pequeños. */
async function houseOcr(file, degrees = 0, crop = null, psm = '11') {
    if (!(await initOcr())) return null;
    const worker = await acquireOcr();
    try {
        const bmp = await createImageBitmap(file);
        const w = degrees % 180 ? bmp.height : bmp.width;
        const h = degrees % 180 ? bmp.width : bmp.height;
        const scale = Math.min(1, HOUSE_DOCS.ocrMaxSide / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.filter = 'grayscale(1) contrast(1.4)';
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.drawImage(bmp, -bmp.width * scale / 2, -bmp.height * scale / 2, bmp.width * scale, bmp.height * scale);
        if (bmp.close) bmp.close();
        let target = canvas;
        if (crop) {
            const sx = canvas.width * crop[0], sy = canvas.height * crop[1];
            const sw = canvas.width * (crop[2] - crop[0]), sh = canvas.height * (crop[3] - crop[1]);
            const k = Math.min(3, 3000 / sw);
            target = document.createElement('canvas');
            target.width = Math.round(sw * k);
            target.height = Math.round(sh * k);
            const tctx = target.getContext('2d');
            tctx.filter = 'contrast(1.6)';
            tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, target.width, target.height);
        }
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        return (await worker.recognize(target)).data.text || '';
    } finally {
        try { await worker.setParameters({ tessedit_pageseg_mode: '3' }); } catch (e) { /* el worker se libera igual */ }
        releaseOcr(worker);
    }
}

/* ============ LECTORES ============ */

function houseMostCommon(list) {
    const counts = {};
    list.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || b.length - a.length)[0] || '';
}

function houseDistance(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[m][n];
}

/** ok = igual · close = 1 dígito de diferencia (probable error del OCR) · diff = distinto */
function houseCompareNumber(expected, readValues) {
    const exp = String(expected || '').replace(/\D/g, '');
    const list = readValues.filter(Boolean);
    if (exp.length < 4 || !list.length) return null;
    if (list.some(v => v === exp)) return 'ok';
    if (list.some(v => Math.abs(v.length - exp.length) <= 1 && houseDistance(v, exp) <= 1)) return 'close';
    return 'diff';
}

function houseAddressKey(text) {
    return fold(String(text || '').split(/dpl/i)[0])
        .replace(/\b(cl|cll|calle|cr|cra|kr|carrera|dg|tv|casa|mz|manzana|barranquilla|atlantico)\b/g, ' ')
        .replace(/(sur|norte)/g, ' ')
        .replace(/\b[sn]\b/g, ' ')
        .replace(/\b0+(\d)/g, '$1')
        .replace(/[^a-z0-9]/g, '')
        .replace(/[br]/g, '8').replace(/o/g, '0');
}

function houseAddressSimilarity(a, b) {
    const x = houseAddressKey(a), y = houseAddressKey(b);
    if (!x || !y) return 0;
    return 1 - houseDistance(x, y) / Math.max(x.length, y.length);
}

function parseReceipt(text) {
    const flat = String(text || '');
    const nic = houseMostCommon([...flat.matchAll(/N[I1l]C\D{0,6}(\d{6,8})/gi)].map(m => m[1]));
    const niu = houseMostCommon([...flat.matchAll(/N[I1l]U\D{0,6}(\d{7,9})/gi)].map(m => m[1]));

    let address = '';
    const supply = flat.match(/suministro[\s\S]{0,60}?\b((?:CL|CLL|CR|CRA|KR|CALLE|CARRERA|DG|TV)\s?\d[^\n]{2,40})/i);
    if (supply) address = supply[1];
    else {
        const any = flat.match(/\b((?:CL|CLL|CR|CRA|KR|CALLE|CARRERA)\s?\d[^\n]{3,40})/i);
        if (any) address = any[1];
    }

    // gráfico de barras: seis meses anteriores + consumo actual
    let series = null;
    let run = [];
    flat.split(/\n+/).forEach(line => {
        line.trim().split(/\s+/).forEach(tok => {
            if (/^\d{1,4}$/.test(tok) && Number(tok) < 3000) run.push(Number(tok));
            else if (tok) {
                if (run.length >= 7 && !series) series = run.slice(-7);
                run = [];
            }
        });
    });
    if (run.length >= 7 && !series) series = run.slice(-7);

    const actual = new Set();
    const previous = new Set();
    const average = new Set();
    [...flat.matchAll(/(\d{1,5})[,.]00\b/g)].forEach(m => actual.add(Number(m[1])));
    if (series) {
        actual.add(series[6]);
        previous.add(series[5]);
        const sum6 = series.slice(0, 6).reduce((a, b) => a + b, 0);
        average.add(Math.round(sum6 / 6));
        average.add(Math.round((sum6 + series[6]) / 7));
    }
    [...flat.matchAll(/promedio[^\d\n]{0,40}(\d{2,4})\b/gi)].forEach(m => average.add(Number(m[1])));
    [...flat.matchAll(/actual\s+(\d{2,3})\s/gi)].forEach(m => average.add(Number(m[1])));

    return { nic, niu, address, series, actual: [...actual], previous: [...previous], average: [...average] };
}

/** Fila de números del gráfico de barras leída en el recorte: el último es el mes actual y el penúltimo el anterior.
 *  El OCR a veces corta el último dígito, por eso se aceptan tokens de 1 a 3 cifras. */
function parseChartRow(text) {
    let best = [];
    String(text || '').split('\n').forEach(line => {
        const tokens = line.trim().split(/\s+/).filter(t => /^\d{1,3}$/.test(t));
        if (tokens.filter(t => t.length >= 2).length >= 3 && tokens.length >= best.length) best = tokens;
    });
    return best;
}

function parseIdCard(text) {
    const numbers = new Set();
    [...String(text || '').matchAll(/\b\d{1,3}(?:[.,\s]\d{3}){1,3}\b|\b\d{6,10}\b/g)]
        .forEach(m => { const d = m[0].replace(/\D/g, ''); if (d.length >= 6 && d.length <= 10) numbers.add(d); });
    return [...numbers];
}

function parseMatricula(text) {
    const flat = String(text || '');
    const found = [];
    [...flat.matchAll(/(\d{3})\s?[-–—]\s?(\d{3,8})/g)].forEach(m => found.push(`${m[1]}-${m[2]}`));
    const labelled = flat.match(/MATR[ÍI]CULA[^\d]{0,40}(\d{3})\s?[-–—]\s?(\d{3,8})/i);
    return { labelled: labelled ? `${labelled[1]}-${labelled[2]}` : '', all: found };
}

/* ============ APLICAR RESULTADOS ============ */

function houseNote(item, text) {
    if (!item) return;
    item.imageNote = item.imageNote ? `${item.imageNote} · ${text}` : text;
}

function houseIssue(item, status, code, text) {
    if (!item || item.notApplicable) return;
    if (item.status === 'non-compliant' && status !== 'non-compliant') { houseNote(item, text); return; }
    if (item.status === 'non-compliant' && item.reasonCode !== 'empty') { houseNote(item, text); return; }
    item.status = status;
    item.reasonCode = code;
    item.observation = text;
}

function houseApplyReceipt(byId, values, data, file) {
    const receipt = byId[104];
    const where = `(${file})`;
    const checks = [];

    const nic = houseCompareNumber(values[86], [data.nic]);
    if (!data.nic) checks.push('no se pudo leer el NIC');
    else if (nic === 'ok') checks.push(`NIC ${data.nic} coincide`);
    else if (nic === 'close') {
        checks.push(`NIC leído ${data.nic} casi coincide con el formulario (${values[86]})`);
        houseIssue(byId[86], 'review', 'review', `El NIC del recibo (${data.nic}) difiere en un dígito del formulario (${values[86]}); confirmar visualmente ${where}`);
    } else if (nic === 'diff') {
        checks.push(`NIC leído ${data.nic} ≠ formulario ${values[86]}`);
        houseIssue(byId[86], 'non-compliant', 'mismatch', `El NIC del recibo (${data.nic}) no coincide con el del formulario (${values[86]}) ${where}`);
    }

    const niu = houseCompareNumber(values[85], [data.niu]);
    if (!data.niu) checks.push('no se pudo leer el NIU');
    else if (niu === 'ok') checks.push(`NIU ${data.niu} coincide`);
    else if (niu === 'close') {
        checks.push(`NIU leído ${data.niu} casi coincide con el formulario (${values[85]})`);
        houseIssue(byId[85], 'review', 'review', `El NIU del recibo (${data.niu}) difiere en un dígito del formulario (${values[85]}); confirmar visualmente ${where}`);
    } else if (niu === 'diff') {
        checks.push(`NIU leído ${data.niu} ≠ formulario ${values[85]}`);
        houseIssue(byId[85], 'non-compliant', 'mismatch', `El NIU del recibo (${data.niu}) no coincide con el del formulario (${values[85]}) ${where}`);
    }

    if (!data.address) checks.push('no se pudo leer la dirección');
    else if (values[6]) {
        const sim = houseAddressSimilarity(data.address, values[6]);
        if (sim >= 0.8) checks.push(`dirección del recibo coincide (${Math.round(sim * 100)}%)`);
        else {
            checks.push(`dirección del recibo «${data.address.trim()}» no coincide con la del formulario (${Math.round(sim * 100)}%)`);
            houseIssue(receipt, 'review', 'review', `La dirección leída en el recibo («${data.address.trim()}») no coincide con la del formulario («${values[6]}»); confirmar visualmente ${where}`);
        }
    }

    [[119, 'actual', 'consumo mes actual', 0], [120, 'previous', 'consumo mes anterior', 0], [121, 'average', 'promedio de consumo', 2]]
        .forEach(([id, key, label, tolerance]) => {
            const candidates = data[key];
            const formValue = parseFloat(String(values[id] || '').replace(',', '.'));
            if (!candidates.length) { checks.push(`no se pudo leer ${label}`); return; }
            if (Number.isNaN(formValue)) return;
            const match = candidates.some(c => Math.abs(c - formValue) <= tolerance);
            if (match) checks.push(`${label} coincide (${formValue})`);
            else {
                checks.push(`${label}: recibo ${candidates.join('/')} ≠ formulario ${formValue}`);
                houseIssue(byId[id], 'review', 'review', `El ${label} del recibo (${candidates.join(' o ')}) no coincide con el formulario (${formValue}); confirmar visualmente ${where}`);
            }
        });

    houseNote(receipt, `Recibo leído en carpeta ${where}: ${checks.join('; ')}`);
}

function houseApplyIdCard(byId, values, text, file) {
    const idItem = byId[35] || byId[36];
    const parts = [];
    const formId = values[40] || values[17];
    const status = houseCompareNumber(formId, parseIdCard(text));
    if (status === 'ok' || status === 'close') parts.push('el número de cédula coincide con el formulario');
    else if (status === 'diff') {
        parts.push('el número leído no coincide con el del formulario');
        houseIssue(byId[40], 'review', 'review', `El número de cédula leído en la imagen de la carpeta (${file}) no coincide con el formulario (${formId}); confirmar visualmente`);
    } else if (!formId) parts.push('el formulario no trae número de cédula para cruzar');
    else parts.push('no se pudo leer el número de cédula');
    const words = fold(text).split(' ').filter(w => w.length >= 2);
    const nm = nameCheck(words, values);
    if (nm) parts.push(nm.hits / nm.total >= 0.5 ? 'el nombre coincide con el formulario' : 'no se encontró el nombre del formulario');
    houseNote(idItem, `Cédula leída en carpeta (${file}): ${parts.join('; ')}`);
}

function houseApplyCertificate(byId, values, text, file) {
    const info = parseMatricula(text);
    const first = info.labelled || info.all.find(v => v.startsWith('040')) || '';
    const item = byId[32] || byId[33] || byId[30];
    if (!first) { houseNote(item, `Certificado en carpeta (${file}): no se pudo leer la matrícula`); return; }
    if (!first.startsWith('040')) {
        houseIssue(byId[30], 'non-compliant', 'mismatch', `La matrícula inmobiliaria del certificado (${first}) no inicia con 040 (${file})`);
        houseNote(item, `Matrícula leída ${first} no inicia con 040`);
        return;
    }
    const cmp = houseCompareNumber(values[30], [first.replace(/\D/g, '')]);
    if (cmp === 'diff') {
        houseIssue(byId[30], 'review', 'review', `La matrícula del certificado (${first}) no coincide con la del formulario (${values[30]}); confirmar visualmente (${file})`);
    }
    houseNote(item, `Matrícula ${first} inicia con 040${cmp === 'ok' || cmp === 'close' ? ' y coincide con el formulario' : cmp === 'diff' ? ' pero difiere del formulario' : ''}`);
}

/* ============ FLUJO PRINCIPAL ============ */

async function verifyHouseDocs(items, values, folderImages, hooks = {}) {
    const byId = {};
    items.forEach(i => { byId[i.id] = i; });
    if (!folderImages.length || (byId[104] && byId[104].notApplicable && byId[35] && byId[35].notApplicable)) return;

    const files = folderImages.filter(e => e.file.size && !/^signature[-_]/i.test(e.file.name));
    if (!files.length) return;

    // 1) preselección con CLIP (rápido); si no está disponible se usan las primeras fotos
    let ranked = files.map(entry => ({ entry, bill: 0, id: 0, letter: 0 }));
    if (typeof classifyImage === 'function') {
        let index = 0;
        for (const row of ranked) {
            index++;
            if (hooks.status) hooks.status(`clasificando fotos de la carpeta ${index}/${ranked.length}`);
            try {
                const cls = await classifyImage(await houseFilePx(row.entry.file, HOUSE_DOCS.clipSide));
                if (cls) { row.bill = cls.scores.bill || 0; row.id = cls.scores.id || 0; row.letter = cls.scores.letter || 0; row.cls = true; }
            } catch (error) { console.warn('No se pudo clasificar', row.entry.file.name, error); }
        }
    }
    const picked = new Map();
    ['bill', 'id', 'letter'].forEach(kind => {
        ranked.filter(r => r[kind] >= 10).sort((a, b) => b[kind] - a[kind]).slice(0, HOUSE_DOCS.maxPerKind)
            .forEach(r => picked.set(r.entry.file.name, r));
    });
    let candidates = [...picked.values()];
    if (!candidates.length) candidates = ranked.filter(r => !r.cls).slice(0, HOUSE_DOCS.maxCandidates);
    candidates = candidates.slice(0, HOUSE_DOCS.maxCandidates);

    // 2) OCR a resolución completa y lectura según el tipo de documento
    const seen = { recibo: false, cedula: false, certificado: false };
    let n = 0;
    for (const row of candidates) {
        n++;
        if (hooks.status) hooks.status(`leyendo documentos de la carpeta ${n}/${candidates.length}`);
        const file = row.entry.file;
        let text;
        try { text = await houseOcr(file); } catch (error) { console.warn('OCR de carpeta falló', file.name, error); continue; }
        if (text === null) return;

        const classify = t => ['recibo', 'cedula', 'certificado'].find(k => judgeDocument(k, t, values).verdict === 'ok') || '';
        let kind = classify(text);
        let degrees = 0;
        if (!kind && row.bill >= 25) {
            for (const deg of [180, 90, 270]) {
                const rotated = await houseOcr(file, deg);
                if (rotated && classify(rotated)) { text = rotated; kind = classify(rotated); degrees = deg; break; }
            }
        }
        if (!kind || seen[kind]) continue;
        seen[kind] = true;
        if (kind === 'recibo') {
            const data = parseReceipt(text);
            if (!data.previous.length) {
                try {
                    const rowNums = parseChartRow(await houseOcr(file, degrees, [0.04, 0.56, 0.46, 0.68], '6'));
                    if (rowNums.length >= 3) {
                        const last = rowNums[rowNums.length - 1];
                        if (last.length >= 2) data.actual.push(Number(last));
                        data.previous.push(Number(rowNums[rowNums.length - 2]));
                    }
                } catch (error) { console.warn('No se pudo leer el gráfico de consumo', error); }
            }
            houseApplyReceipt(byId, values, data, file.name);
        }
        else if (kind === 'cedula') houseApplyIdCard(byId, values, text, file.name);
        else houseApplyCertificate(byId, values, text, file.name);
    }
}
