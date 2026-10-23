/**
 * CALIDAD Y APRENDIZAJE (AuditQuality)
 *  1) Registra cada corrección humana (lo que la app dijo vs. lo que decidió el auditor).
 *  2) Evalúa la app contra una "verdad" (JSON) y reporta precisión por ítem, falsos "Cumple", etc.
 *  3) Exporta el estado actual revisado como verdad para futuras evaluaciones.
 *
 * Formato de la verdad:  { "ruta/archivo.pdf": { "6": "compliant", "85": "non-compliant", "40": "na" } }
 * Valores: compliant | non-compliant | review | na
 */
const AuditQuality = (() => {
    const LOG_KEY = 'auditoria-correcciones-v1';
    const MAX_LOG = 5000;

    const readLog = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (_) { return []; } };
    const writeLog = log => { try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-MAX_LOG))); } catch (_) {} };

    const effectiveStatus = item => (item.notApplicable ? 'na' : item.status);
    const LABEL = { compliant: 'Cumple', 'non-compliant': 'No cumple', review: 'Revisar', na: 'No aplica', pending: 'Pendiente' };

    /** Llamado por app.js al guardar un ítem editado */
    function recordCorrection(item, previous) {
        if (!previous || previous.status === item.status) return;
        const log = readLog();
        log.push({
            t: new Date().toISOString(), pdf: item.pdfName, id: item.id,
            app: previous.status, human: item.status, reason: previous.reasonCode || '', value: String(previous.actualValue || '').slice(0, 80)
        });
        writeLog(log);
    }

    function download(name, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = Object.assign(document.createElement('a'), { href: url, download: name });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Verdad = estado actual (ya revisado por una persona) */
    function exportTruth() {
        const truth = {};
        allItemsData.forEach(i => { (truth[i.pdfName] = truth[i.pdfName] || {})[i.id] = effectiveStatus(i); });
        download('verdad-auditoria.json', JSON.stringify(truth, null, 2), 'application/json');
    }

    function evaluate(truth) {
        const byPdf = new Map();
        allItemsData.forEach(i => { (byPdf.get(i.pdfName) || byPdf.set(i.pdfName, new Map()).get(i.pdfName)).set(String(i.id), i); });
        const perItem = {}, confusion = {}, errors = [];
        let total = 0, hits = 0, falseCompliant = 0, falseNonCompliant = 0, missingPdf = 0;

        Object.entries(truth).forEach(([name, expected]) => {
            const key = [...byPdf.keys()].find(k => k === name || k.endsWith('/' + name) || name.endsWith('/' + k));
            if (!key) { missingPdf++; return; }
            Object.entries(expected).forEach(([id, want]) => {
                const item = byPdf.get(key).get(String(id));
                if (!item) return;
                const got = effectiveStatus(item);
                total++;
                const stat = perItem[id] = perItem[id] || { total: 0, hits: 0, desc: item.description };
                stat.total++;
                confusion[`${want}→${got}`] = (confusion[`${want}→${got}`] || 0) + 1;
                if (got === want) { hits++; stat.hits++; return; }
                if (got === 'compliant' && want === 'non-compliant') falseCompliant++;
                if (got === 'non-compliant' && want === 'compliant') falseNonCompliant++;
                errors.push({ pdf: key, id, want, got, desc: item.description, value: item.actualValue });
            });
        });
        return { total, hits, accuracy: total ? hits / total : 0, falseCompliant, falseNonCompliant, missingPdf, perItem, confusion, errors };
    }

    function toCsv(rows) {
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        return '\ufeff' + rows.map(r => r.map(esc).join(';')).join('\n');
    }

    /* ---------------- Interfaz ---------------- */
    function el(tag, attrs = {}, html = '') {
        const node = Object.assign(document.createElement(tag), attrs);
        if (html) node.innerHTML = html;
        return node;
    }

    function openPanel() {
        let panel = document.getElementById('qualityPanel');
        if (!panel) {
            panel = el('div', { id: 'qualityPanel', className: 'modal hidden', role: 'dialog' });
            panel.setAttribute('aria-modal', 'true');
            panel.innerHTML = `
                <div class="modal-content quality-content">
                    <div class="modal-header"><h3>📊 Calidad del auditor automático</h3>
                        <button type="button" class="btn-close" data-q="close" aria-label="Cerrar">×</button></div>
                    <div class="quality-body">
                        <p class="quality-help">Carga una <strong>verdad</strong> (JSON) para medir la precisión de la app, o exporta tus PDFs ya revisados como verdad.</p>
                        <div class="quality-actions">
                            <label class="btn btn-primary">📂 Cargar verdad<input type="file" accept=".json" hidden data-q="truth"></label>
                            <button type="button" class="btn btn-secondary" data-q="export-truth">💾 Exportar estado actual como verdad</button>
                            <button type="button" class="btn btn-secondary" data-q="export-log">📜 Exportar correcciones</button>
                            <button type="button" class="btn btn-secondary" data-q="clear-log">🧹 Borrar registro</button>
                        </div>
                        <div id="qualityResult" class="quality-result"></div>
                    </div>
                </div>`;
            document.body.appendChild(panel);
            panel.addEventListener('click', e => {
                const act = e.target.closest('[data-q]');
                if (e.target === panel || (act && act.dataset.q === 'close')) panel.classList.add('hidden');
                if (!act) return;
                if (act.dataset.q === 'export-truth') exportTruth();
                if (act.dataset.q === 'export-log') {
                    const log = readLog();
                    download('correcciones-auditoria.csv', toCsv([['fecha', 'pdf', 'item', 'app', 'humano', 'motivo', 'valor'],
                        ...log.map(l => [l.t, l.pdf, l.id, l.app, l.human, l.reason, l.value])]), 'text/csv');
                }
                if (act.dataset.q === 'clear-log') { writeLog([]); renderLogSummary(); }
            });
            panel.querySelector('[data-q="truth"]').addEventListener('change', async e => {
                const file = e.target.files[0]; if (!file) return;
                try { renderReport(evaluate(JSON.parse(await file.text()))); }
                catch (err) { document.getElementById('qualityResult').innerHTML = '<p class="quality-bad">JSON inválido.</p>'; }
                e.target.value = '';
            });
        }
        panel.classList.remove('hidden');
        renderLogSummary();
    }

    function renderLogSummary() {
        const box = document.getElementById('qualityResult');
        const log = readLog();
        if (!box) return;
        if (!log.length) { box.innerHTML = '<p class="quality-help">Aún no hay correcciones registradas.</p>'; return; }
        const byItem = {};
        log.forEach(l => { byItem[l.id] = (byItem[l.id] || 0) + 1; });
        const top = Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 8);
        box.innerHTML = `<h4>Ítems que más corrige el auditor (${log.length} correcciones)</h4>
            <table class="excel-table"><thead><tr><th>Ítem</th><th>Correcciones</th></tr></thead><tbody>
            ${top.map(([id, n]) => `<tr><td>#${escapeHtml(id)}</td><td>${n}</td></tr>`).join('')}</tbody></table>`;
    }

    function renderReport(r) {
        const pct = v => `${(v * 100).toFixed(1)}%`;
        const worst = Object.entries(r.perItem).map(([id, s]) => ({ id, ...s, acc: s.hits / s.total }))
            .sort((a, b) => a.acc - b.acc).slice(0, 12);
        const box = document.getElementById('qualityResult');
        box.innerHTML = `
            <div class="summary-cards">
                <div class="card ${r.accuracy >= 0.99 ? 'success' : 'warning'}"><div class="card-value">${pct(r.accuracy)}</div><div class="card-label">Precisión (${r.hits}/${r.total})</div></div>
                <div class="card ${r.falseCompliant ? 'error' : 'success'}"><div class="card-value">${r.falseCompliant}</div><div class="card-label">Falsos “Cumple”</div></div>
                <div class="card"><div class="card-value">${r.falseNonCompliant}</div><div class="card-label">Falsos “No cumple”</div></div>
                <div class="card"><div class="card-value">${r.missingPdf}</div><div class="card-label">PDF sin procesar</div></div>
            </div>
            <h4>Ítems con menor precisión</h4>
            <table class="excel-table"><thead><tr><th>Ítem</th><th>Descripción</th><th>Acierto</th></tr></thead><tbody>
            ${worst.map(w => `<tr><td>#${escapeHtml(w.id)}</td><td>${escapeHtml(String(w.desc).slice(0, 80))}</td><td>${pct(w.acc)} (${w.hits}/${w.total})</td></tr>`).join('')}</tbody></table>
            <div class="quality-actions"><button type="button" class="btn btn-secondary" id="qualityErrorsBtn">⬇️ Descargar errores (CSV)</button></div>`;
        document.getElementById('qualityErrorsBtn').addEventListener('click', () =>
            download('errores-evaluacion.csv', toCsv([['pdf', 'item', 'esperado', 'app', 'descripcion', 'valor'],
                ...r.errors.map(e => [e.pdf, e.id, LABEL[e.want] || e.want, LABEL[e.got] || e.got, e.desc, e.value])]), 'text/csv'));
    }

    function mountButton() {
        if (document.getElementById('qualityFab')) return;
        const fab = el('button', { id: 'qualityFab', type: 'button', className: 'quality-fab', title: 'Calidad y precisión' }, '📊 Calidad');
        fab.addEventListener('click', openPanel);
        document.body.appendChild(fab);
    }
    document.addEventListener('DOMContentLoaded', mountButton);

    return { recordCorrection, evaluate, exportTruth, openPanel };
})();
window.AuditQuality = AuditQuality;
