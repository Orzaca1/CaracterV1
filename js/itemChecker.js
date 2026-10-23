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

const compactCache = new Map();

function compactImageObservation(item, text) {
    const cacheKey = `${item.id}|${text}`;
    if (compactCache.has(cacheKey)) return compactCache.get(cacheKey);
    const out = compactImageObservationRaw(item, text);
    if (compactCache.size > 2000) compactCache.clear();
    compactCache.set(cacheKey, out);
    return out;
}

function compactImageObservationRaw(item, text) {
    const value = String(text || '').trim();
    if (!value) return value;
    if (/se encontr[oó] una imagen candidata en la carpeta/i.test(value) && /no est[aá] adjunta/i.test(value)) {
        if (item.id === 103) return 'Foto candidata de tablero/breakers; no está adjunta al PDF.';
        if (item.id === 102) return 'Foto candidata de contador/medidor; no está adjunta al PDF. No verifica la ubicación.';
    }
    if (/foto candidata del contador o medidor en la carpeta/i.test(value) && /no est[aá] adjunta/i.test(value)) {
        return 'Foto candidata de contador/medidor; no está adjunta al PDF. No verifica la ubicación.';
    }
    if (/la imagen solicitada sí existe|foto correcta encontrada en carpeta/i.test(value) &&
        /no está adjunta|falta adjuntarla/i.test(value)) {
        return 'No contiene la imagen correspondiente en el PDF.';
    }
    const subject = value.match(/no se pudo confirmar(?: que la imagen sea)?\s+(.+?)(?:[.;]|$)/i);
    if (subject && /se revisaron\s+\d+\s+imagen(?:\(es\)|es)/i.test(value)) {
        const detail = subject[1].replace(/\s+y que corresponda al\s+(?:anverso|reverso)/i, '').trim();
        const side = subject[1].match(/\b(anverso|reverso)\b/i);
        const label = /c[eé]dula/i.test(detail)
            ? 'Cédula'
            : detail.replace(/^(?:un|una|el|la|los|las)\s+/i, '').replace(/^\w/, letter => letter.toUpperCase());
        const feminine = /^(c[eé]dula|foto|imagen|carta)/i.test(label);
        return `${label}${side ? ` (${side[1].toLowerCase()})` : ''} no ${feminine ? 'confirmada' : 'confirmado'}.`;
    }
    const withoutCount = value
        .replace(/\b\d+\s+(?:fotos?|imágenes?)(?:\s+revisadas?)?\b/gi, '')
        .replace(/[ \t]{2,}/g, ' ');
    const withoutAction = withoutCount.replace(/[;,.:\s]+(?:revisar|verificar)(?:\s+manualmente)?\s+(?:el\s+)?(?:adjunto|foto(?:\s+correcta)?(?:\s+adjunta(?:\s+al\s+PDF)?)?)\.?$/i, '');
    const compact = withoutAction.replace(/\s*[;,.:]\s*[;,.:]+/g, '.').replace(/[;,.:\s]+$/g, '').trim();
    return compact || value;
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
    const answerLabel = value ? 'Respuesta detectada' : item.found ? 'Campo encontrado sin respuesta' : 'Pregunta no encontrada';
    const answerText = shortValue || (item.found
        ? 'El campo aparece en el PDF, pero no se detectó un valor.'
        : 'No se localizó esta pregunta en el PDF.');
    const comparison = item.receiptComparison;
    const comparisonLabel = comparison && comparison.status === 'match' ? 'Coincide'
        : comparison && comparison.status === 'mismatch' ? 'Difiere'
        : 'No confirmado';
    const confirmationNote = item.beneficiaryConfirmation ? item.beneficiaryConfirmation.message : '';
    const note = confirmationNote || ((item.status === 'non-compliant' || item.status === 'review') ? item.observation : (item.imageNote || item.autoReason));

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
        ${comparison ? `
        <div class="item-comparison ${escapeHtml(comparison.status)}">
            <div class="comparison-value"><span>Formulario</span><strong>${escapeHtml(comparison.formValue)}</strong></div>
            <div class="comparison-value"><span>Recibo de energía</span><strong>${escapeHtml(comparison.receiptValue)}</strong></div>
            <span class="comparison-result">${escapeHtml(comparisonLabel)}</span>
        </div>` : `<div class="item-answer">
            <span class="item-answer-label">${escapeHtml(answerLabel)}</span>
            <span class="item-answer-value">${escapeHtml(answerText)}</span>
        </div>`}
        ${note ? `<div class="item-note ${item.status}">${escapeHtml(note)}</div>` : ''}
        <div class="item-actions">
            ${itemNeedsEvidence(item) ? '<button type="button" class="btn btn-secondary" data-action="evidence" title="Ver el recorte del PDF">🖼️ Ver evidencia</button><button type="button" class="btn btn-secondary" data-action="fullpdf" title="Ver todo el PDF">📄 PDF completo</button>' : ''}
            ${item.id === 6 ? '<button type="button" class="btn btn-secondary" data-action="beneficiaries" title="Consultar y confirmar en el listado">📍 Listado de direcciones</button>' : ''}
            ${item.id === 85 && ['non-compliant', 'review'].includes(item.status) ? '<button type="button" class="btn btn-secondary" data-action="beneficiaries" title="Verificar el NIU contra el listado">🔎 Verificar NIU</button>' : ''}
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

