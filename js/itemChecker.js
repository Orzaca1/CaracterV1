/**
 * RENDERIZADO DE LA LISTA DE ITEMS (con paginación para no congelar la página)
 */
const PAGE_SIZE = 60;

const STATUS_META = {
    'compliant':     { emoji: '✅', text: 'Cumple' },
    'non-compliant': { emoji: '❌', text: 'No Cumple' },
    'review':        { emoji: '🔎', text: 'Revisar' },
    'pending':       { emoji: '⏳', text: 'Pendiente' }
};

const PRIORITY_LABEL = { critico: 'Crítico', alto: 'Alto', medio: 'Medio', bajo: 'Bajo' };

let currentList = [];
let renderedCount = 0;

/** Escapa HTML (acepta cualquier tipo) */
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text ?? '').replace(/[&<>"']/g, m => map[m]);
}

/** Renderiza la lista desde cero */
function renderItems(items = allItemsData) {
    currentList = items;
    renderedCount = 0;

    const list = document.getElementById('itemsList');
    list.innerHTML = '';

    if (items.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🗂️</div>
                <p>No hay items para mostrar</p>
                <small>Procesa PDFs o ajusta los filtros</small>
            </div>`;
        updateLoadMore();
        return;
    }

    appendItems();
}

/** Agrega la siguiente página de items */
function appendItems() {
    const list = document.getElementById('itemsList');
    const next = currentList.slice(renderedCount, renderedCount + PAGE_SIZE);
    const fragment = document.createDocumentFragment();

    next.forEach(item => {
        const card = document.createElement('article');
        card.className = `item-card ${item.status}`;
        card.dataset.itemId = item.globalId;
        card.tabIndex = 0;
        card.innerHTML = itemCardHTML(item);
        fragment.appendChild(card);
    });

    list.appendChild(fragment);
    renderedCount += next.length;
    updateLoadMore();
}

function itemCardHTML(item) {
    const meta = item.notApplicable
        ? { emoji: '➖', text: 'No aplica' }
        : STATUS_META[item.status] || STATUS_META.pending;
    const value = item.actualValue ? String(item.actualValue) : '';
    const shortValue = value.length > 100 ? value.slice(0, 100) + '…' : value;
    const note = (item.status === 'non-compliant' || item.status === 'review') ? item.observation : (item.imageNote || item.autoReason);

    return `
        <div class="item-header">
            <div class="item-title">
                <span class="item-number">Item #${escapeHtml(item.id)}</span>
                <span class="chip priority-${escapeHtml(item.priority)}">${escapeHtml(PRIORITY_LABEL[item.priority] || item.priority)}</span>
            </div>
            <span class="item-status ${item.status}">${meta.emoji} ${meta.text}</span>
        </div>
        <div class="item-description">${escapeHtml(item.description)}</div>
        <div class="item-meta">
            <span title="Archivo">📄 ${escapeHtml(item.pdfName)}</span>
            <span title="Sección">📁 ${escapeHtml(item.section)}</span>
        </div>
        ${shortValue ? `<div class="item-value">📝 ${escapeHtml(shortValue)}</div>` : ''}
        ${note ? `<div class="item-note ${item.status}">${escapeHtml(note)}</div>` : ''}
        <div class="item-actions">
            ${itemNeedsEvidence(item) ? '<button type="button" class="btn btn-secondary" data-action="evidence">🖼️ Ver evidencia</button>' : ''}
            <button type="button" class="btn btn-primary" data-action="edit">✏️ Revisar / Editar</button>
        </div>`;
}

/** Muestra u oculta el botón "Mostrar más" y el contador */
function updateLoadMore() {
    const wrap = document.getElementById('loadMoreWrap');
    const total = currentList.length;
    if (total === 0) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    document.getElementById('resultsInfo').textContent = `Mostrando ${renderedCount} de ${total}`;
    document.getElementById('loadMoreBtn').classList.toggle('hidden', renderedCount >= total);
}

/** Tabla de resultados por PDF (resultado + viñetas "• Ítem: comentario") */
function renderPdfTable() {
    const wrap = document.getElementById('pdfResults');
    const body = document.getElementById('pdfResultsBody');
    const names = Object.keys(pdfDocuments);
    if (names.length === 0) {
        wrap.classList.add('hidden');
        return;
    }

    const MAX_LINES = 5;
    const rows = names.map(name => {
        const doc = pdfDocuments[name];
        if (doc.status === 'error') {
            return `<tr><td class="pdf-name">${escapeHtml(name)}</td>
                <td><span class="result-badge error">ERROR</span></td><td>–</td><td>–</td>
                <td class="pdf-summary">${escapeHtml(doc.error)}</td></tr>`;
        }
        const bad = summarizeNonCompliance(doc.items);
        const rev = summarizeReview(doc.items);
        const result = bad.count ? ['bad', 'NO CUMPLE'] : rev.count ? ['warn', 'REVISAR'] : ['ok', 'CUMPLE'];
        const shown = bad.lines.slice(0, MAX_LINES);
        const more = bad.lines.length > MAX_LINES ? `\n… y ${bad.lines.length - MAX_LINES} más (ver Excel)` : '';
        return `<tr class="pdf-row" data-pdf="${escapeHtml(name)}" tabindex="0" title="Ver los ítems de este PDF">
            <td class="pdf-name">${escapeHtml(name)}</td>
            <td><span class="result-badge ${result[0]}">${result[1]}</span></td>
            <td class="pdf-count">${bad.count}</td>
            <td class="pdf-count">${rev.count}</td>
            <td class="pdf-summary">${escapeHtml(shown.join('\n') + more) || '—'}</td></tr>`;
    });

    body.innerHTML = rows.join('');
    wrap.classList.remove('hidden');
}
