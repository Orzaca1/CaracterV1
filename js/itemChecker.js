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
    const token = currentList;
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
    // Se muestran todos los ítems: el resto se agrega por tandas para no congelar la página
    if (renderedCount < currentList.length) {
        requestAnimationFrame(() => { if (token === currentList) appendItems(); });
    }
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
            ${itemNeedsEvidence(item) ? '<button type="button" class="btn btn-secondary" data-action="evidence" title="Ver el recorte del PDF">🖼️ Ver evidencia</button><button type="button" class="btn btn-secondary" data-action="fullpdf" title="Ver todo el PDF">📄 PDF completo</button>' : ''}
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
    document.getElementById('loadMoreBtn').classList.add('hidden');
}

