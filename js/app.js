/**
 * CONTROLADOR PRINCIPAL DE LA APLICACIÓN
 */
let selectedFiles = [];   // [{ file, path }]
let selectedImageFiles = [];
let unavailableImageCount = 0;
let isProcessing = false;
let hasUnsavedEdits = false;
let cancelRequested = false;
let lastFocusedElement = null;

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', init);

function init() {
    initializeEventListeners();
    restoreSavedSession();

    if (typeof pdfjsLib === 'undefined') {
        showToast('No se pudo cargar pdf.js. Revisa tu conexión a internet y recarga la página.', 'error', 8000);
        $('processPdfBtn').disabled = true;
        updateStatusBadge('error', 'Sin pdf.js');
    }
    if (typeof ExcelJS === 'undefined') {
        showToast('No se pudo cargar la librería de Excel. La exportación no estará disponible.', 'warning', 8000);
    }
}

/* ============ EVENTOS ============ */
function initializeEventListeners() {
    // Navegación
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => navigateToSection(btn.dataset.section));
    });

    // Carga de archivos (los inputs están ocultos: los botones los abren)
    $('pickFileBtn').addEventListener('click', () => $('pdfFile').click());
    $('pickFolderBtn').addEventListener('click', () => $('pdfFolder').click());
    $('pickImagesBtn').addEventListener('click', () => $('imageFolder').click());
    $('pdfFile').addEventListener('change', handleFileInput);
    $('pdfFolder').addEventListener('change', handleFileInput);
    $('imageFolder').addEventListener('change', handleFileInput);
    initDropZone();

    // Procesar
    $('processPdfBtn').addEventListener('click', processPDFs);
    $('cancelProcessBtn').addEventListener('click', () => { cancelRequested = true; showToast('Cancelando al terminar el PDF actual…', 'info'); });

    // Exportar
    $('exportExcelBtn').addEventListener('click', async () => {
        const btn = $('exportExcelBtn');
        btn.disabled = true;
        try { await exportToExcel(); } finally { btn.disabled = false; }
    });
    $('previewExcelBtn').addEventListener('click', previewExcelInPlatform);
    $('closeExcelPreviewBtn').addEventListener('click', closeExcelPreview);

    // Modal
    $('closeModal').addEventListener('click', closeItemModal);
    $('cancelBtn').addEventListener('click', closeItemModal);
    $('itemForm').addEventListener('submit', e => { e.preventDefault(); if (saveCurrentItem()) closeItemModal(); });
    $('saveNextBtn').addEventListener('click', saveAndNext);
    $('itemStatus').addEventListener('change', updateObservationVisibility);
    $('itemModal').addEventListener('click', e => { if (e.target.id === 'itemModal') closeItemModal(); });
    $('evidenceClose').addEventListener('click', closeEvidence);
    $('evidenceModal').addEventListener('click', e => { if (e.target.id === 'evidenceModal') closeEvidence(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('evidenceModal').classList.contains('hidden')) { closeEvidence(); return; }
        if (e.key === 'Escape' && !$('itemModal').classList.contains('hidden')) closeItemModal();
    });

    // Filtros (búsqueda con debounce)
    let searchTimer;
    $('searchItems').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applyFilters, 200);
    });
    ['filterStatus', 'filterPriority', 'filterPdf'].forEach(id => $(id).addEventListener('change', applyFilters));

    // Lista de items (delegación: evita onclick inline y problemas con nombres de archivo)
    const list = $('itemsList');
    list.addEventListener('click', e => {
        const card = e.target.closest('.item-card');
        if (!card) return;
        if (e.target.closest('[data-action="fullpdf"]')) {
            openFullPdf(card.dataset.itemId);
            return;
        }
        if (e.target.closest('[data-action="evidence"]')) {
            openEvidence(card.dataset.itemId);
            return;
        }
        openItemModal(card.dataset.itemId);
    });
    list.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('item-card')) {
            e.preventDefault();
            openItemModal(e.target.dataset.itemId);
        }
    });
    $('loadMoreBtn').addEventListener('click', appendItems);
    $('clearSavedBtn').addEventListener('click', clearSavedSession);

}

/* ============ CARGA DE ARCHIVOS ============ */
function handleFileInput(event) {
    const entries = Array.from(event.target.files).map(f => ({
        file: f,
        path: f.webkitRelativePath || f.name
    }));
    const inputId = event.target.id;
    event.target.value = ''; // permite volver a elegir los mismos archivos
    if (inputId === 'imageFolder') {
        addSelectedImages(entries);
        updateUploadSelection();
    } else {
        setSelectedFiles(entries, inputId === 'pdfFile');
    }
}

function initDropZone() {
    const area = $('uploadArea');
    ['dragenter', 'dragover'].forEach(evt => area.addEventListener(evt, e => {
        e.preventDefault();
        area.classList.add('dragover');
    }));
    ['dragleave', 'dragend'].forEach(evt => area.addEventListener(evt, () => area.classList.remove('dragover')));
    area.addEventListener('drop', async e => {
        e.preventDefault();
        area.classList.remove('dragover');

        const items = e.dataTransfer.items;
        let entries = [];
        if (items && items.length && items[0].webkitGetAsEntry) {
            // Debe resolverse de forma síncrona antes de cualquier await
            const roots = Array.from(items).map(i => i.webkitGetAsEntry()).filter(Boolean);
            for (const root of roots) entries.push(...await readEntry(root));
        } else {
            entries = Array.from(e.dataTransfer.files).map(f => ({ file: f, path: f.name }));
        }
        setSelectedFiles(entries);
    });
}

/** Lee archivos y carpetas soltados (recursivo) */
async function readEntry(entry, base = '') {
    if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        return [{ file, path: base + entry.name }];
    }
    if (entry.isDirectory) {
        const reader = entry.createReader();
        const out = [];
        let batch;
        do {
            batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            for (const child of batch) out.push(...await readEntry(child, `${base}${entry.name}/`));
        } while (batch.length);
        return out;
    }
    return [];
}

function isPdf(file) {
    return file.name.toLowerCase().endsWith('.pdf');
}

function isImageFile(file) {
    return /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(file.name);
}

function isInImageFolder(entry) {
    return entry.path.split(/[\\/]/).some(part => /^IMAGENES(?:\s|$)/i.test(part.trim()));
}

function addSelectedImages(entries, merge = true) {
    const images = entries.filter(entry => isImageFile(entry.file));
    unavailableImageCount = merge ? unavailableImageCount : 0;
    const available = images.filter(entry => entry.file.size > 0);
    unavailableImageCount += images.length - available.length;

    if (!merge) selectedImageFiles = [];
    const byPath = new Map(selectedImageFiles.map(entry => [entry.path, entry]));
    available.forEach(entry => byPath.set(entry.path, entry));
    selectedImageFiles = [...byPath.values()];
}

function updateUploadSelection() {
    const pdfs = selectedFiles;
    if (pdfs.length === 0) {
        $('uploadStatus').classList.add('hidden');
        updateStatusBadge('idle', 'Sin PDFs');
        if (selectedImageFiles.length) {
            showToast('Carpeta de imágenes cargada. Selecciona los PDFs que quieres revisar.', 'info');
        }
        return;
    }

    const sizeMb = pdfs.reduce((sum, e) => sum + e.file.size, 0) / (1024 * 1024);
    let message = `${pdfs.length} PDF(s) · ${sizeMb.toFixed(1)} MB · listo(s) para procesar`;
    if (selectedImageFiles.length) message += ` · ${selectedImageFiles.length} imagen(es) de respaldo`;
    if (unavailableImageCount) message += ` · ${unavailableImageCount} imagen(es) vacías o sin sincronizar`;
    $('statusMessage').textContent = message;
    $('uploadStatus').classList.remove('hidden');
    updateStatusBadge('ready', '✓ Listo');
}

function setSelectedFiles(entries, preserveImages = false) {
    const imageEntries = entries.filter(entry => isImageFile(entry.file) && isInImageFolder(entry));
    if (!preserveImages) addSelectedImages(imageEntries, false);

    const allPdfs = entries.filter(e => isPdf(e.file));
    const isInPdfFolder = entry => entry.path
        .split(/[\\/]/)
        .some(part => /^PDFS(?:\s|$)/i.test(part.trim()));
    const hasPackagePdfFolders = allPdfs.some(isInPdfFolder);
    const outsidePdfFolders = hasPackagePdfFolders
        ? allPdfs.filter(entry => !isInPdfFolder(entry)).length
        : 0;
    const candidates = hasPackagePdfFolders
        ? allPdfs.filter(isInPdfFolder)
        : allPdfs;
    const emptyPdfs = candidates.filter(entry => entry.file.size === 0).length;
    const pdfs = candidates.filter(entry => entry.file.size > 0);
    const ignoredNonPdfs = entries.length - allPdfs.length;

    if (pdfs.length === 0) {
        selectedFiles = [];
        updateUploadSelection();
        if (!selectedImageFiles.length) {
            showToast(
                emptyPdfs
                    ? `Se encontraron ${emptyPdfs} PDF(s), pero están vacíos. Verifica que se hayan sincronizado o vuelve a exportarlos.`
                    : 'No se encontraron archivos PDF en la selección',
                'warning'
            );
        }
        return;
    }

    selectedFiles = pdfs;
    updateUploadSelection();
    if (outsidePdfFolders > 0) showToast(`${outsidePdfFolders} PDF(s) fuera de las carpetas PDFS se omitieron`, 'info');
    if (emptyPdfs > 0) showToast(`${emptyPdfs} PDF(s) vacíos se omitieron`, 'warning');
    if (ignoredNonPdfs > 0 && !selectedImageFiles.length) {
        $('statusMessage').textContent += ` · ${ignoredNonPdfs} archivo(s) no PDF ignorados`;
    }
}

/* ============ PROCESAMIENTO ============ */
async function processPDFs() {
    if (isProcessing) return;
    if (selectedFiles.length === 0) {
        showToast('Selecciona archivos PDF primero', 'warning');
        return;
    }
    if (typeof pdfjsLib === 'undefined') {
        showToast('pdf.js no está disponible', 'error');
        return;
    }

    isProcessing = true;
    cancelRequested = false;
    IMAGE_VERIFY.enabled = $('optVerifyImages').checked;
    $('processPdfBtn').disabled = true;
    updateStatusBadge('loading', '⏳ Procesando');
    showLoading(true, `Procesando ${selectedFiles.length} PDF(s)...`);
    setProgress(0);

    const failed = [];
    let processedNow = 0;
    let ocrWarningShown = false;
    let unmatchedImageFolders = 0;

    try {
        for (let i = 0; i < selectedFiles.length; i++) {
            if (cancelRequested) break;
            const entry = selectedFiles[i];
            const label = `Procesando ${i + 1}/${selectedFiles.length}: ${entry.path}`;
            showLoading(true, label);
            setProgress((i / selectedFiles.length) * 100);
            await new Promise(r => setTimeout(r, 0)); // deja respirar a la interfaz

            const relatedImages = findRelatedImages(entry.path, selectedImageFiles);
            if (selectedImageFiles.length && relatedImages.length === 0) unmatchedImageFolders++;
            const result = await processPDF(entry, {
                folderImages: relatedImages,
                status: text => showLoading(true, `${label} · ${text}`),
                warning: text => {
                    if (ocrWarningShown) return;
                    ocrWarningShown = true;
                    showToast(text, 'warning', 10000);
                }
            });
            if (!result.ok) failed.push(result);
            processedNow++;
            await saveDocument(result.key);
        }
        setProgress(100);

        if (processedNow === 0) {
            updateStatusBadge('idle', 'Cancelado');
            return;
        }
        if (failed.length === processedNow) {
            updateStatusBadge('error', '✗ Error');
            showToast(`No se pudo leer ningún PDF. ${failed[0].error}`, 'error', 8000);
            updateReviewSection();
            return;
        }

        resetFilters();
        if (allItemsData.some(i => i.status === 'non-compliant')) $('filterStatus').value = 'non-compliant';
        else if (allItemsData.some(i => i.status === 'review')) $('filterStatus').value = 'review';
        hasUnsavedEdits = false;
        updateReviewSection();
        navigateToSection('review');
        updateStatusBadge('success', '✓ Completado');
        const doneCount = processedNow - failed.length;
        showToast(`${doneCount} PDF(s) procesado(s) y guardado(s) · ${Object.keys(pdfDocuments).length} en total${cancelRequested ? ' (proceso cancelado)' : ''}`, 'success');

        if (failed.length) {
            const names = failed.map(f => `${f.key} (${f.error})`).join('; ');
            showToast(`${failed.length} PDF(s) con error: ${names}`, 'warning', 10000);
        }
        if (unmatchedImageFolders) {
            showToast(
                `${unmatchedImageFolders} PDF(s) no se pudieron asociar con seguridad a una carpeta de imágenes; sus evidencias externas no se usaron.`,
                'warning',
                10000
            );
        }
    } catch (error) {
        console.error('Error procesando PDFs:', error);
        showToast('Error: ' + error.message, 'error', 8000);
        updateStatusBadge('error', '✗ Error');
    } finally {
        isProcessing = false;
        $('processPdfBtn').disabled = false;
        showLoading(false);
    }
}

/* ============ AVANCE GUARDADO ============ */
async function restoreSavedSession() {
    const stored = await loadStoredDocuments();
    if (!stored.length) return;
    stored.sort((a, b) => a.key.localeCompare(b.key, 'es', { numeric: true }));
    stored.forEach(rec => {
        const { key, ...doc } = rec;
        pdfDocuments[key] = doc;
        if (doc.items) allItemsData.push(...doc.items);
    });
    updateReviewSection();
    updateStatusBadge('success', `✓ ${stored.length} PDF(s) guardados`);
    showToast(`Se recuperó tu avance: ${stored.length} PDF(s)`, 'success');
}

async function clearSavedSession() {
    if (!confirm('¿Borrar todo el avance guardado (PDFs revisados y cambios manuales)? Esta acción no se puede deshacer.')) return;
    pdfDocuments = {};
    allItemsData = [];
    await clearStoredDocuments();
    hasUnsavedEdits = false;
    $('summaryCards').classList.add('hidden');
    $('complianceSection').classList.add('hidden');
    $('reviewStats').textContent = 'Procesa uno o más PDFs para ver los resultados';
    populatePdfFilter();
    applyFilters();
    updateStatusBadge('idle', 'Listo');
    showToast('Avance borrado', 'info');
}

/* ============ REVISIÓN ============ */
function updateReviewSection() {
    const stats = computeStats(allItemsData);
    const pdfCount = Object.values(pdfDocuments).filter(d => d.status === 'processed').length;
    const pct = stats.pct.toFixed(1);

    $('totalItems').textContent = stats.total;
    $('compliantCount').textContent = stats.compliant;
    $('nonCompliantCount').textContent = stats.nonCompliant;
    $('pendingCount').textContent = stats.review + stats.pending;
    $('notApplicableCount').textContent = stats.notApplicable;
    $('compliancePercent').textContent = `${pct}%`;
    $('complianceFill').style.width = `${pct}%`;
    $('summaryCards').classList.remove('hidden');
    $('complianceSection').classList.remove('hidden');
    $('reviewStats').textContent = `${stats.total} items evaluados de ${pdfCount} PDF(s) · ${stats.notApplicable} no aplican`;
    populatePdfFilter();
    applyFilters();
}

/** Llena el filtro de PDFs conservando la selección actual */
function populatePdfFilter() {
    const select = $('filterPdf');
    const current = select.value;
    select.innerHTML = '<option value="">Todos los PDFs</option>';

    Object.keys(pdfDocuments)
        .filter(name => pdfDocuments[name].status === 'processed')
        .forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        });

    if (current && pdfDocuments[current]) select.value = current;
}

function getFilteredItems() {
    const term = fold($('searchItems').value.trim());
    const status = $('filterStatus').value;
    const priority = $('filterPriority').value;
    const pdf = $('filterPdf').value;

    return allItemsData.filter(item =>
        (!status || item.status === status) &&
        (!priority || item.priority === priority) &&
        (!pdf || item.pdfName === pdf) &&
        (!term || item.searchKey.includes(term))
    );
}

function applyFilters() {
    renderItems(getFilteredItems());
}

function resetFilters() {
    $('searchItems').value = '';
    $('filterStatus').value = '';
    $('filterPriority').value = '';
    $('filterPdf').value = '';
}

/* ============ MODAL ============ */
function openItemModal(globalId) {
    const item = allItemsData.find(i => i.globalId === globalId);
    if (!item) return;

    lastFocusedElement = document.activeElement;
    $('modalItemId').textContent = item.id;
    $('modalItemPriority').textContent =
        `${item.section} · Prioridad: ${(PRIORITY_LABEL[item.priority] || item.priority).toUpperCase()} · ${item.pdfName}`;
    $('itemDescription').value = item.description;
    $('itemActual').value = item.actualValue || 'No encontrado';
    $('itemStatus').value = item.status;
    $('itemObservation').value = item.observation || '';
    $('itemNotes').value = item.notes || '';
    $('itemForm').dataset.itemId = globalId;

    updateObservationVisibility();
    $('itemModal').classList.remove('hidden');
    $('itemStatus').focus();
}

function closeItemModal() {
    $('itemModal').classList.add('hidden');
    if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
}

/** Muestra la observación solo si el estado es "No cumple" */
function updateObservationVisibility() {
    const status = $('itemStatus').value;
    const show = status === 'non-compliant' || status === 'review';
    $('observationGroup').classList.toggle('hidden', !show);
}

/** Guarda los cambios del modal. Devuelve true si se guardó */
function saveCurrentItem() {
    const item = allItemsData.find(i => i.globalId === $('itemForm').dataset.itemId);
    if (!item) return false;

    const status = $('itemStatus').value;
    const observation = $('itemObservation').value.trim();

    if (status === 'non-compliant' && !observation) {
        showToast('Indica por qué no cumple', 'warning');
        $('itemObservation').focus();
        return false;
    }

    if (status === 'non-compliant' || status === 'review') {
        if (status !== item.status || observation !== item.observation) item.reasonCode = status === 'review' ? 'review' : 'manual';
        item.observation = observation;
    } else {
        item.observation = '';
        item.reasonCode = '';
    }
    item.status = status;
    item.notes = $('itemNotes').value.trim();
    item.autoReason = '';
    item.imageNote = '';
    hasUnsavedEdits = true;
    saveDocument(item.pdfName);

    updateReviewSection();   // refresca cifras y mantiene los filtros activos
    showToast('Item actualizado', 'success', 1500);
    return true;
}

/** Guarda y abre el siguiente item de la lista filtrada (revisión rápida) */
function saveAndNext() {
    const idx = currentList.findIndex(i => i.globalId === $('itemForm').dataset.itemId);
    const nextId = idx >= 0 && currentList[idx + 1] ? currentList[idx + 1].globalId : null;
    if (!saveCurrentItem()) return;
    if (nextId) openItemModal(nextId);
    else { closeItemModal(); showToast('No hay más items en esta lista', 'info'); }
}

/** Desde la tabla por PDF: muestra los items que no cumplen de ese PDF */
function filterByPdf(name) {
    $('searchItems').value = '';
    $('filterPriority').value = '';
    $('filterPdf').value = name;
    const hasBad = pdfDocuments[name] && pdfDocuments[name].items.some(i => i.status === 'non-compliant');
    $('filterStatus').value = hasBad ? 'non-compliant' : '';
    applyFilters();
    $('itemsList').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============ UI AUXILIAR ============ */
function navigateToSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const target = $(sectionId + 'Section');
    target.classList.add('active');
    target.scrollTop = 0;

    document.querySelectorAll('.nav-item').forEach(item => {
        const active = item.dataset.section === sectionId;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
}

function updateStatusBadge(status, text) {
    const badge = $('statusBadge');
    badge.className = `status-badge ${status}`;
    badge.textContent = text;
}

function showLoading(show, text = 'Procesando...') {
    if (show) $('loadingText').textContent = text;
    $('loadingIndicator').classList.toggle('hidden', !show);
}

function setProgress(percent) {
    $('progressFill').style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

/** Notificación no bloqueante (reemplaza alert) */
function showToast(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toast.addEventListener('click', () => toast.remove());
    $('toastContainer').appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}
