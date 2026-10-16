/**
 * EXPORTACIÓN A EXCEL (ExcelJS: permite colores, filtros y paneles fijos)
 *
 * Hoja "Auditoría": una fila por PDF y una columna por ítem (encabezado = descripción),
 * con CUMPLE / NO CUMPLE / REVISAR / NO APLICA y una columna con viñetas "• Ítem: comentario" de por qué no cumple.
 * Los listeners de los botones se registran en app.js.
 */
const EXCEL_MAX_CELL = 32000;   // Excel admite 32.767 caracteres por celda

const XL = {
    headerBg: 'FF0F2A4A', headerText: 'FFFFFFFF', subBg: 'FFE8EEF9',
    okBg: 'FFD7F5E3', okText: 'FF0B6B3A',
    badBg: 'FFFFD9D9', badText: 'FF9B1C1C',
    warnBg: 'FFFFF1CC', warnText: 'FF8A5A00',
    naBg: 'FFE8E8E8', naText: 'FF555555'
};

const STATUS_LABEL_XL = { 'compliant': 'CUMPLE', 'non-compliant': 'NO CUMPLE', 'review': 'REVISAR', 'pending': 'PENDIENTE' };
const PRIORITY_LABEL_XL = { critico: 'CRÍTICO', alto: 'ALTO', medio: 'MEDIO', bajo: 'BAJO' };

function xlText(value) {
    const s = value == null ? '' : String(value);
    return s.length > EXCEL_MAX_CELL ? s.slice(0, EXCEL_MAX_CELL) + '…' : s;
}

/** Fecha local AAAA-MM-DD (toISOString usa UTC y puede dar el día siguiente) */
function localDateStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const fillOf = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function styleStatusCell(cell, status) {
    const palette = status === 'compliant' ? [XL.okBg, XL.okText]
                  : status === 'non-compliant' ? [XL.badBg, XL.badText]
                  : status === 'not-applicable' ? [XL.naBg, XL.naText]
                  : [XL.warnBg, XL.warnText];
    cell.fill = fillOf(palette[0]);
    cell.font = { bold: true, color: { argb: palette[1] }, size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function styleHeaderRow(row, height = 24) {
    row.height = height;
    row.eachCell(cell => {
        cell.fill = fillOf(XL.headerBg);
        cell.font = { bold: true, color: { argb: XL.headerText }, size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF5A6B8C' } } };
    });
}

/** Encabezados únicos: descripción del ítem (+ "(#id)" solo si la descripción se repite) */
function itemHeaders() {
    const counts = {};
    AUDIT_ITEMS.forEach(i => { counts[i.description] = (counts[i.description] || 0) + 1; });
    return AUDIT_ITEMS.map(i => counts[i.description] > 1 ? `${i.description} (#${i.id})` : i.description);
}

/** Exporta a Excel */
async function exportToExcel() {
    if (typeof ExcelJS === 'undefined') {
        showToast('La librería de Excel no está disponible. Revisa tu conexión y recarga.', 'error');
        return;
    }
    if (allItemsData.length === 0) {
        showToast('No hay items para exportar', 'warning');
        return;
    }

    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Auditoría Colombia Solar';
        wb.created = new Date();

        buildMatrixSheet(wb);
        buildDetailSheet(wb);
        buildFolderEvidenceSheet(wb);
        buildSummarySheet(wb);

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const fileName = `Auditoria_Colombia_Solar_${localDateStamp()}.xlsx`;

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);

        hasUnsavedEdits = false;
        showToast(`Excel descargado: ${fileName}`, 'success');
    } catch (error) {
        console.error('Error exportando Excel:', error);
        showToast('Error al exportar Excel: ' + error.message, 'error', 8000);
    }
}

/** Altura de fila según las viñetas (cada viñeta puede ocupar varias líneas) */
function bulletsHeight(...texts) {
    const lines = texts.join('\n').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 80)), 0);
    return Math.min(400, Math.max(20, lines * 13.5));
}

/** Hoja 1: matriz (PDF x ítems) */
function buildMatrixSheet(wb) {
    const FIXED = 6;
    const headers = [
        'Archivo PDF', 'Resultado', 'N° No Cumple', 'Resumen general: por qué no cumple',
        'N° Revisar', 'Ítems para REVISAR', ...itemHeaders()
    ];
    const ws = wb.addWorksheet('Auditoría', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });

    ws.columns = headers.map((h, i) => ({
        header: h,
        width: i === 0 ? 38 : i === 1 ? 14 : i === 2 ? 11 : i === 3 ? 80 : i === 4 ? 10 : i === 5 ? 60 : 17
    }));
    styleHeaderRow(ws.getRow(1), 78);

    Object.keys(pdfDocuments).forEach(name => {
        const doc = pdfDocuments[name];

        if (doc.status === 'error') {
            const row = ws.addRow([xlText(name), 'ERROR', '', xlText(doc.error)]);
            styleStatusCell(row.getCell(2), 'pending');
            row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
            return;
        }

        const byId = {};
        doc.items.forEach(i => { byId[i.id] = i; });
        const bad = summarizeNonCompliance(doc.items);
        const rev = summarizeReview(doc.items);
        const result = bad.count ? 'NO CUMPLE' : rev.count ? 'REVISAR' : 'CUMPLE';
        const resultStatus = bad.count ? 'non-compliant' : rev.count ? 'review' : 'compliant';

        const row = ws.addRow([
            xlText(name),
            result,
            bad.count,
            xlText(bad.text || 'Cumple todos los ítems'),
            rev.count,
            xlText(rev.text),
            ...AUDIT_ITEMS.map(def => byId[def.id].notApplicable
                ? 'NO APLICA'
                : STATUS_LABEL_XL[byId[def.id].status] || 'PENDIENTE')
        ]);

        styleStatusCell(row.getCell(2), resultStatus);
        [1, 4, 6].forEach(c => { row.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
        [3, 5].forEach(c => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'top' }; });
        row.height = bulletsHeight(bad.text, rev.text);

        AUDIT_ITEMS.forEach((def, idx) => {
            styleStatusCell(
                row.getCell(FIXED + 1 + idx),
                byId[def.id].notApplicable ? 'not-applicable' : byId[def.id].status
            );
        });
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

/** Hoja 2: detalle de lo que NO cumple o hay que REVISAR (lista para corregir con el encuestador) */
function buildDetailSheet(wb) {
    const ws = wb.addWorksheet('No cumple y revisar', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
        { header: 'Archivo PDF', width: 34 }, { header: 'ID', width: 6 },
        { header: 'Sección', width: 26 }, { header: 'Ítem', width: 46 },
        { header: 'Estado', width: 12 }, { header: 'Prioridad', width: 11 },
        { header: 'Valor encontrado', width: 30 }, { header: 'Motivo', width: 50 },
        { header: 'Notas', width: 30 }
    ];
    styleHeaderRow(ws.getRow(1));

    allItemsData.filter(i => i.status === 'non-compliant' || i.status === 'review').forEach(item => {
        const row = ws.addRow([
            xlText(item.pdfName), item.id, xlText(item.section), xlText(item.description),
            STATUS_LABEL_XL[item.status],
            PRIORITY_LABEL_XL[item.priority] || String(item.priority).toUpperCase(),
            xlText(item.actualValue), xlText(item.observation), xlText(item.notes)
        ]);
        row.eachCell(c => { c.alignment = { wrapText: true, vertical: 'top' }; });
        styleStatusCell(row.getCell(5), item.status);
        if (item.priority === 'critico') row.getCell(6).font = { bold: true, color: { argb: XL.badText } };
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };
}

/** Hoja 3: imágenes encontradas en la carpeta, pero no adjuntas al PDF */
function buildFolderEvidenceSheet(wb) {
    const ws = wb.addWorksheet('Evidencia en carpeta', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
        { header: 'Archivo PDF', width: 34 }, { header: 'ID', width: 6 },
        { header: 'Ítem', width: 46 }, { header: 'Imagen encontrada', width: 42 },
        { header: 'Estado del ítem', width: 16 }, { header: 'Comentario', width: 80 }
    ];
    styleHeaderRow(ws.getRow(1));

    allItemsData.filter(item => item.folderImageMatch).forEach(item => {
        const row = ws.addRow([
            xlText(item.pdfName), item.id, xlText(item.description),
            xlText(item.folderImageMatch), STATUS_LABEL_XL[item.status] || String(item.status).toUpperCase(),
            xlText(item.observation || item.imageNote)
        ]);
        row.eachCell(cell => { cell.alignment = { wrapText: true, vertical: 'top' }; });
        styleStatusCell(row.getCell(5), item.status);
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
}

/** Hoja 4: resumen del lote */
function buildSummarySheet(wb) {
    const ws = wb.addWorksheet('Resumen');
    ws.columns = [{ width: 46 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];

    const title = text => {
        const r = ws.addRow([text]);
        r.getCell(1).font = { bold: true, size: 12, color: { argb: XL.headerText } };
        for (let c = 1; c <= 5; c++) r.getCell(c).fill = fillOf(XL.headerBg);
        return r;
    };
    const head = labels => {
        const r = ws.addRow(labels);
        r.eachCell(c => { c.font = { bold: true }; c.fill = fillOf(XL.subBg); c.alignment = { horizontal: 'center' }; });
        r.getCell(1).alignment = { horizontal: 'left' };
        return r;
    };

    const s = computeStats(allItemsData);
    const docs = Object.values(pdfDocuments);
    const errorCount = docs.filter(d => d.status === 'error').length;
    const processed = docs.filter(d => d.status === 'processed');
    const pdfsOk = processed.filter(d => !d.items.some(i => i.status === 'non-compliant')).length;
    const pdfsReview = processed.filter(d => !d.items.some(i => i.status === 'non-compliant') && d.items.some(i => i.status === 'review')).length;

    title('AUDITORÍA COLOMBIA SOLAR - RESUMEN DEL LOTE');
    ws.addRow(['Fecha de generación', new Date().toLocaleString('es-CO')]);
    ws.addRow(['PDFs procesados', processed.length]);
    ws.addRow(['PDFs sin ningún NO CUMPLE', pdfsOk]);
    ws.addRow(['   de ellos, con ítems para REVISAR', pdfsReview]);
    ws.addRow(['PDFs con al menos un NO CUMPLE', processed.length - pdfsOk]);
    ws.addRow(['PDFs con error de lectura', errorCount]);
    ws.addRow([]);

    title('INDICADORES GENERALES (ítems)');
    ws.addRow(['Total de ítems evaluados', s.total]);
    ws.addRow(['CUMPLE', s.compliant]);
    ws.addRow(['NO CUMPLE', s.nonCompliant]);
    ws.addRow(['REVISAR', s.review]);
    if (s.pending) ws.addRow(['PENDIENTE (manual)', s.pending]);
    ws.addRow(['NO APLICA', s.notApplicable]);
    const pct = ws.addRow(['% de cumplimiento general', s.total ? s.compliant / s.total : 0]);
    pct.getCell(2).numFmt = '0.0%';
    pct.getCell(1).font = { bold: true };
    ws.addRow([]);

    title('POR PRIORIDAD');
    head(['Prioridad', 'Total', 'Cumple', 'No cumple', '% Cumple']);
    ['critico', 'alto', 'medio', 'bajo'].forEach(p => {
        const items = allItemsData.filter(i => i.priority === p);
        if (!items.length) return;
        const st = computeStats(items);
        const r = ws.addRow([PRIORITY_LABEL_XL[p], st.total, st.compliant, st.nonCompliant, st.pct / 100]);
        r.getCell(5).numFmt = '0.0%';
    });
    ws.addRow([]);

    title('POR SECCIÓN');
    head(['Sección', 'Total', 'Cumple', 'No cumple', '% Cumple']);
    [...new Set(allItemsData.map(i => i.section))].forEach(sec => {
        const st = computeStats(allItemsData.filter(i => i.section === sec));
        const r = ws.addRow([xlText(sec), st.total, st.compliant, st.nonCompliant, st.pct / 100]);
        r.getCell(5).numFmt = '0.0%';
    });
    ws.addRow([]);

    title('ÍTEMS QUE MÁS INCUMPLEN (top 15)');
    head(['Ítem', 'PDFs que fallan', '% de PDFs', '', '']);
    const fails = {};
    allItemsData.filter(i => i.status === 'non-compliant').forEach(i => {
        fails[i.id] = fails[i.id] || { description: i.description, n: 0 };
        fails[i.id].n++;
    });
    Object.values(fails).sort((a, b) => b.n - a.n).slice(0, 15).forEach(f => {
        const r = ws.addRow([xlText(f.description), f.n, processed.length ? f.n / processed.length : 0]);
        r.getCell(3).numFmt = '0.0%';
    });
    if (Object.keys(fails).length === 0) ws.addRow(['Ningún ítem incumple']);
}

/* ============ VISTA PREVIA ============ */
function previewExcelInPlatform() {
    if (allItemsData.length === 0) {
        showToast('No hay items para mostrar', 'warning');
        return;
    }

    const s = computeStats(allItemsData);
    const names = Object.keys(pdfDocuments);
    const LIMIT = 25;

    let html = `<h3>📊 Resumen</h3>
        <p class="preview-more">${names.length} PDF(s) · ${s.total} ítems evaluados · ${s.notApplicable} no aplican · ${s.compliant} cumplen · ${s.nonCompliant} no cumplen · ${s.review} por revisar · ${s.pct.toFixed(1)}% de cumplimiento</p>
        <h3 class="preview-subtitle">📋 Hoja "Auditoría" (primeros ${Math.min(LIMIT, names.length)} PDFs; cada ítem es una columna en el Excel)</h3>
        <div class="table-scroll"><table class="excel-table"><thead><tr>
        <th>Archivo PDF</th><th>Resultado</th><th>Resumen general: por qué no cumple</th><th>Ítems para REVISAR</th>
        </tr></thead><tbody>`;

    names.slice(0, LIMIT).forEach(name => {
        const doc = pdfDocuments[name];
        if (doc.status === 'error') {
            html += `<tr><td>${escapeHtml(name)}</td><td><span class="result-badge error">ERROR</span></td><td class="pdf-summary">${escapeHtml(doc.error)}</td><td></td></tr>`;
            return;
        }
        const bad = summarizeNonCompliance(doc.items);
        const rev = summarizeReview(doc.items);
        const result = bad.count ? ['bad', 'NO CUMPLE'] : rev.count ? ['warn', 'REVISAR'] : ['ok', 'CUMPLE'];
        html += `<tr><td>${escapeHtml(name)}</td>
            <td><span class="result-badge ${result[0]}">${result[1]}</span></td>
            <td class="pdf-summary">${escapeHtml(bad.text || 'Cumple todos los ítems')}</td>
            <td class="pdf-summary">${escapeHtml(rev.text)}</td></tr>`;
    });
    html += '</tbody></table></div>';
    if (names.length > LIMIT) html += `<p class="preview-more">… y ${names.length - LIMIT} PDF(s) más en el archivo Excel</p>`;

    document.getElementById('excelPreviewContent').innerHTML = html;
    document.getElementById('excelPreviewSection').classList.remove('hidden');
}

function closeExcelPreview() {
    document.getElementById('excelPreviewSection').classList.add('hidden');
}
