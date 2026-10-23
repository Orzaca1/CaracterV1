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
let beneficiaryLookupGlobalId = null;

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
    $('correctionPdfSelect').addEventListener('change', renderCorrectionItems);
    $('remediationItems').addEventListener('input', updateCorrectionSummary);
    $('remediationItems').addEventListener('change', updateCorrectionSummary);
    $('saveCorrectionBtn').addEventListener('click', saveCorrectionProposal);
    $('exportCorrectionBtn').addEventListener('click', exportCorrectionProposal);

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
    $('beneficiaryClose').addEventListener('click', closeBeneficiaryLookup);
    $('beneficiaryModal').addEventListener('click', e => { if (e.target.id === 'beneficiaryModal') closeBeneficiaryLookup(); });
    $('beneficiarySearch').addEventListener('input', renderBeneficiaryResults);
    $('beneficiaryResults').addEventListener('click', e => {
        const button = e.target.closest('[data-beneficiary-index]');
        if (button) confirmBeneficiaryRecord(Number(button.dataset.beneficiaryIndex));
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !$('beneficiaryModal').classList.contains('hidden')) { closeBeneficiaryLookup(); return; }
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
        if (e.target.closest('[data-action="beneficiaries"]')) {
            openBeneficiaryLookup(card.dataset.itemId);
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
    initChecklist();
    initInforme();
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
        if (!selectedImageFiles.length && !unavailableImageCount) {
            $('uploadStatus').classList.add('hidden');
            $('processPdfBtn').disabled = true;
            updateStatusBadge('idle', 'Sin archivos');
            return;
        }
        $('statusTitle').textContent = 'Carpeta de imágenes cargada';
        $('statusMessage').textContent = `${selectedImageFiles.length} imagen(es) listas${unavailableImageCount ? ` · ${unavailableImageCount} vacías o sin sincronizar` : ''} · Selecciona los PDFs para iniciar la revisión`;
        $('uploadStatus').classList.remove('hidden');
        $('processPdfBtn').disabled = true;
        updateStatusBadge('ready', 'Imágenes listas');
        return;
    }

    $('statusTitle').textContent = 'Archivos seleccionados';
    const sizeMb = pdfs.reduce((sum, e) => sum + e.file.size, 0) / (1024 * 1024);
    let message = `${pdfs.length} PDF(s) · ${sizeMb.toFixed(1)} MB · listo(s) para procesar`;
    if (selectedImageFiles.length) message += ` · ${selectedImageFiles.length} imagen(es) de respaldo`;
    if (unavailableImageCount) message += ` · ${unavailableImageCount} imagen(es) vacías o sin sincronizar`;
    $('statusMessage').textContent = message;
    $('uploadStatus').classList.remove('hidden');
    $('processPdfBtn').disabled = false;
    updateStatusBadge('ready', '✓ Listo');
}

function setSelectedFiles(entries, preserveImages = false) {
    const imageEntries = entries.filter(entry => isImageFile(entry.file) && isInImageFolder(entry));
    if (imageEntries.length) addSelectedImages(imageEntries, preserveImages);

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
    IMAGE_VERIFY.houseDocs = $('optHouseDocs').checked;
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
    for (const rec of stored) {
        const { key, ...doc } = rec;
        let matriculaActualizada = false;
        let fotoTechoActualizada = false;
        let consumosActualizados = false;
        let breakerActualizado = false;
        let imagenesFaltantesActualizadas = false;
        let observacionesActualizadas = false;
        let autorizacionActualizada = false;
        let discapacidadActualizada = false;
        (doc.items || []).forEach(item => {
            const observation = compactImageObservation(item, item.observation);
            const imageNote = compactImageObservation(item, item.imageNote);
            if (observation !== item.observation) {
                item.observation = observation;
                observacionesActualizadas = true;
            }
            if (imageNote !== item.imageNote) {
                item.imageNote = imageNote;
                observacionesActualizadas = true;
            }
        });
        const relacion = doc.items && doc.items.find(item => item.id === 20);
        if (relacion && normalizeText(relacion.actualValue).startsWith('PROPIETARIO')) {
            [22, 23, 34].forEach(id => {
                const item = doc.items.find(candidate => candidate.id === id);
                if (!item) return;
                const reason = 'No aplica porque quien atiende la visita es el propietario';
                if (!item.notApplicable || item.status !== 'compliant' || item.observation || item.imageNote || item.autoReason !== reason) {
                    item.notApplicable = true;
                    item.notApplicableReason = reason;
                    item.status = 'compliant';
                    item.reasonCode = '';
                    item.observation = '';
                    item.imageNote = '';
                    item.autoReason = reason;
                    autorizacionActualizada = true;
                }
            });
        }
        const discapacidad = doc.items && doc.items.find(item => item.id === 52);
        if (discapacidad && normalizeText(discapacidad.actualValue) === 'NO') {
            [53, 54].forEach(id => {
                const foto = doc.items.find(item => item.id === id);
                if (!foto) return;
                const reason = 'No aplica porque no hay miembros con discapacidad';
                if (!foto.notApplicable || foto.status !== 'compliant' || foto.observation || foto.imageNote || foto.autoReason !== reason) {
                    foto.notApplicable = true;
                    foto.notApplicableReason = reason;
                    foto.status = 'compliant';
                    foto.reasonCode = '';
                    foto.observation = '';
                    foto.imageNote = '';
                    foto.autoReason = reason;
                    discapacidadActualizada = true;
                }
            });
        }
        const matricula = doc.items && doc.items.find(item => item.id === 30 && !item.notApplicable);
        if (matricula && !isValidMatricula(matricula.actualValue)) {
            matricula.status = 'non-compliant';
            matricula.reasonCode = 'format';
            matricula.observation = `La matrícula debe tener el formato 040-000000 o 040000000 · Encontrado: ${matricula.actualValue || 'vacío'}`;
            matriculaActualizada = true;
        }
        const fotoTecho = doc.items && doc.items.find(item => item.id === 106 && !item.notApplicable);
        if (fotoTecho && !looksLikeFile(fotoTecho.actualValue)) {
            fotoTecho.status = 'non-compliant';
            fotoTecho.reasonCode = 'missing_file';
            fotoTecho.observation = 'Falta la foto obligatoria del techo y su estructura adjunta en el PDF';
            fotoTecho.autoReason = '';
            fotoTechoActualizada = true;
        }
        const recibo = doc.items && doc.items.find(item => item.id === 104);
        if (!recibo || !recibo.receiptConsumptionVerified) {
            [119, 120, 121].forEach(id => {
                const consumo = doc.items && doc.items.find(item => item.id === id);
                if (!consumo || consumo.notApplicable) return;
                if (!consumo.receiptComparison) {
                    consumo.receiptComparison = {
                        formValue: String(consumo.actualValue || '').trim() || 'Sin respuesta',
                        receiptValue: 'Sin lectura guardada',
                        status: 'unknown'
                    };
                    consumosActualizados = true;
                }
                if (consumo.status === 'compliant') {
                    consumo.status = 'review';
                    consumo.reasonCode = 'review';
                    consumo.observation = 'No se confirmó este consumo contra el recibo de energía; procesar el recibo para verificar coincidencia exacta.';
                    consumosActualizados = true;
                }
            });
        }
        const breaker = doc.items && doc.items.find(item => item.id === 103);
        const meterConfidence = breaker && String(breaker.imageNote || '').match(/clasificador:\s*parece un contador \((\d+)%\)/i);
        if (breaker && breaker.status === 'compliant' && meterConfidence && Number(meterConfidence[1]) >= 50) {
            breaker.status = 'review';
            breaker.reasonCode = 'review';
            breaker.observation = `Parece contador (${meterConfidence[1]}%); revisar si la foto muestra el tablero.`;
            breakerActualizado = true;
        }
        (doc.items || []).forEach(item => {
            const missingImage = !item.notApplicable && missingImageFile(item.actualValue);
            if (!missingImage) return;
            item.status = 'non-compliant';
            item.reasonCode = 'missing_file';
            item.observation = `No se encontró el archivo de imagen ${missingImage}`;
            item.autoReason = '';
            imagenesFaltantesActualizadas = true;
        });
        pdfDocuments[key] = doc;
        if (doc.items) allItemsData.push(...doc.items);
        if (matriculaActualizada || fotoTechoActualizada || consumosActualizados || breakerActualizado || imagenesFaltantesActualizadas || observacionesActualizadas || discapacidadActualizada || autorizacionActualizada) await saveDocument(key);
    }
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
    $('summaryCards').classList.remove('hidden');
    $('complianceSection').classList.remove('hidden');
    $('reviewStats').textContent = `${stats.total} items evaluados de ${pdfCount} PDF(s) · ${stats.notApplicable} no aplican`;
    populatePdfFilter();
    applyFilters();
}

function pdfKpiAnswer(items, id) {
    const item = items.find(candidate => candidate.id === id);
    if (!item) return 'No detectado';
    if (item.notApplicable) return 'No aplica';
    const value = String(item.actualValue || '').trim();
    if (!value) return item.found ? 'Sin respuesta' : 'No detectado';
    const normalized = normalizeText(value);
    if (normalized === 'SI') return 'Sí';
    if (normalized === 'NO') return 'No';
    return value;
}

function setAnswerKpi(id, value, redOnYes = false) {
    const element = $(id);
    element.textContent = value;
    element.classList.remove('kpi-negative', 'kpi-positive', 'kpi-neutral');
    if (value !== 'Sí' && value !== 'No') {
        element.classList.add('kpi-neutral');
        return;
    }
    const negative = redOnYes ? value === 'Sí' : value === 'No';
    element.classList.add(negative ? 'kpi-negative' : 'kpi-positive');
}

function mixHexColors(start, end, amount) {
    const channel = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16);
    const mixed = [1, 3, 5].map(offset => Math.round(
        channel(start, offset) + (channel(end, offset) - channel(start, offset)) * amount
    ));
    return `#${mixed.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function complianceColor(percentage) {
    const value = Math.max(0, Math.min(100, percentage));
    return value <= 50
        ? mixHexColors('#ff6b6b', '#ffc24b', value / 50)
        : mixHexColors('#ffc24b', '#34d98b', (value - 50) / 50);
}

function updateSelectedPdfKpis() {
    const pdfName = $('filterPdf').value;
    const doc = pdfName && pdfDocuments[pdfName];
    const values = doc && doc.items || [];
    const selected = Boolean(doc && doc.status === 'processed');

    setAnswerKpi('kpiHouseClosed', selected ? pdfKpiAnswer(values, 13) : '—', true);
    setAnswerKpi('kpiDataConsent', selected ? pdfKpiAnswer(values, 25) : '—');
    setAnswerKpi('kpiParticipation', selected ? pdfKpiAnswer(values, 26) : '—');

    const certificate = values.find(item => item.id === 31);
    const certificatePhoto = values.find(item => item.id === 32);
    let certificateAnswer = '—';
    if (selected && certificate && certificate.notApplicable) {
        certificateAnswer = 'No aplica';
    } else if (selected && certificatePhoto) {
        if (certificatePhoto.status === 'non-compliant') certificateAnswer = 'No';
        else if (certificatePhoto.status === 'compliant') certificateAnswer = 'Sí';
        else certificateAnswer = 'Revisar';
    } else if (selected && certificate) {
        const response = normalizeText(certificate.actualValue);
        certificateAnswer = response === 'SI' ? 'Sí' : response === 'NO' ? 'No' : 'Revisar';
    }
    setAnswerKpi('kpiCertificate', certificateAnswer);

    if (!selected) {
        $('kpiPdfCompliance').textContent = '—';
        $('kpiPdfCompliance').style.color = '';
        $('compliancePercent').textContent = '—';
        $('compliancePercent').style.color = '';
        $('complianceFill').style.width = '0%';
        if (allItemsData.length) $('reviewStats').textContent = 'Selecciona un PDF para ver sus respuestas e indicadores';
        return;
    }

    const stats = computeStats(values);
    const percentage = `${stats.pct.toFixed(1)}%`;
    const color = complianceColor(stats.pct);
    $('kpiPdfCompliance').textContent = percentage;
    $('kpiPdfCompliance').style.color = color;
    $('compliancePercent').textContent = percentage;
    $('compliancePercent').style.color = color;
    $('complianceFill').style.width = percentage;
    $('reviewStats').textContent = `${pdfName} · ${stats.total} items evaluados · ${stats.notApplicable} no aplican`;
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
    renderChecklist();
}

/* ============ CHECKLIST DE PDFs (barra lateral) ============ */
const CHECKLIST_KEY = 'caracter-pdfs-revisados';
let checklistMode = 'all';

function loadReviewedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(CHECKLIST_KEY) || '[]')); }
    catch (e) { return new Set(); }
}

function saveReviewedSet(set) {
    try { localStorage.setItem(CHECKLIST_KEY, JSON.stringify([...set])); } catch (e) { console.warn(e); }
}

function renderChecklist() {
    const list = $('checklistItems');
    if (!list) return;
    const reviewed = loadReviewedSet();
    const names = Object.keys(pdfDocuments).filter(n => pdfDocuments[n].status === 'processed');
    const done = names.filter(n => reviewed.has(n)).length;
    $('checklistCount').textContent = `${done}/${names.length}`;

    const shown = names.filter(n => checklistMode === 'all' || (checklistMode === 'done') === reviewed.has(n));
    list.innerHTML = '';
    if (!shown.length) {
        list.innerHTML = '<li class="checklist-empty">Sin PDFs</li>';
        return;
    }
    const fragment = document.createDocumentFragment();
    shown.forEach(name => {
        const li = document.createElement('li');
        li.className = 'checklist-row' + (reviewed.has(name) ? ' done' : '');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = reviewed.has(name);
        box.title = 'Marcar como revisado';
        box.dataset.name = name;
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'checklist-name';
        label.dataset.name = name;
        label.title = name;
        label.textContent = name.replace(/\.pdf$/i, '');
        li.append(box, label);
        fragment.appendChild(li);
    });
    list.appendChild(fragment);
}

function initChecklist() {
    $('checklistItems').addEventListener('change', e => {
        if (!e.target.matches('input[type=checkbox]')) return;
        const set = loadReviewedSet();
        if (e.target.checked) set.add(e.target.dataset.name); else set.delete(e.target.dataset.name);
        saveReviewedSet(set);
        renderChecklist();
    });
    $('checklistItems').addEventListener('click', e => {
        const btn = e.target.closest('.checklist-name');
        if (!btn) return;
        navigateToSection('review');
        $('searchItems').value = '';
        $('filterStatus').value = '';
        $('filterPriority').value = '';
        $('filterPdf').value = btn.dataset.name;
        applyFilters();
    });
    document.querySelectorAll('.chk-filter').forEach(b => b.addEventListener('click', () => {
        checklistMode = b.dataset.chk;
        document.querySelectorAll('.chk-filter').forEach(x => x.classList.toggle('active', x === b));
        renderChecklist();
    }));
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
    updateSelectedPdfKpis();
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
    const previous = { status: item.status, reasonCode: item.reasonCode, actualValue: item.actualValue };

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
    if (window.AuditQuality) AuditQuality.recordCorrection(item, previous);

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
    if (sectionId === 'informe') renderInforme();
    if (sectionId === 'subsanar') updateCorrectionPdfOptions();

    document.querySelectorAll('.nav-item').forEach(item => {
        const active = item.dataset.section === sectionId;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
}

function updateCorrectionPdfOptions() {
    const select = $('correctionPdfSelect');
    const current = select.value || $('filterPdf').value;
    const names = Object.keys(pdfDocuments).filter(name => pdfDocuments[name].status === 'processed');
    select.innerHTML = '';

    if (!names.length) {
        select.add(new Option('No hay PDFs procesados', ''));
        select.disabled = true;
        renderCorrectionItems();
        return;
    }

    names.forEach(name => select.add(new Option(name, name)));
    select.disabled = false;
    select.value = names.includes(current) ? current : names[0];
    renderCorrectionItems();
}

function remediationItemsFor(doc) {
    return (doc && doc.items || []).filter(item =>
        ['non-compliant', 'review'].includes(item.status) &&
        !item.notApplicable &&
        item.type !== 'file' &&
        !looksLikeFile(item.actualValue)
    );
}

function renderCorrectionItems() {
    const key = $('correctionPdfSelect').value;
    const doc = pdfDocuments[key];
    const list = $('remediationItems');
    const actions = $('remediationActions');
    const items = remediationItemsFor(doc);
    list.innerHTML = '';

    if (!doc) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>Selecciona un PDF procesado</p><small>La propuesta no modifica el PDF original.</small></div>';
        actions.classList.add('hidden');
        $('correctionCount').textContent = '0 cambios propuestos';
        return;
    }
    if (!items.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div><p>No hay campos de texto por subsanar</p><small>Los campos de imágenes no se incluyen en este flujo.</small></div>';
        actions.classList.add('hidden');
        $('correctionCount').textContent = '0 cambios propuestos';
        return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const correction = Object.prototype.hasOwnProperty.call(doc.corrections || {}, item.id)
            ? doc.corrections[item.id]
            : item.actualValue || '';
        const statusLabel = item.status === 'non-compliant' ? 'No cumple' : 'Revisar';
        const correctionValue = String(correction);
        const options = item.options && item.options.length
            ? [...new Set([...(correctionValue ? [correctionValue] : []), ...item.options])]
            : [];
        const correctionControl = options.length
            ? `<select class="correction-field" id="correction-${escapeHtml(item.id)}" data-correction-id="${escapeHtml(item.id)}" data-original="${escapeHtml(item.actualValue || '')}">
                <option value="">Selecciona una respuesta</option>
                ${options.map(option => `<option value="${escapeHtml(option)}"${String(option) === correctionValue ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
            </select>`
            : `<textarea class="correction-field" id="correction-${escapeHtml(item.id)}" rows="2" data-correction-id="${escapeHtml(item.id)}" data-original="${escapeHtml(item.actualValue || '')}">${escapeHtml(correction)}</textarea>`;
        const card = document.createElement('article');
        card.className = `remediation-item ${item.status}`;
        card.innerHTML = `
            <div class="remediation-item-head">
                <div>
                    <span class="item-number">Ítem #${escapeHtml(item.id)}</span>
                    <span class="remediation-status ${item.status}">${statusLabel}</span>
                </div>
                <span class="remediation-section">${escapeHtml(item.section)}</span>
            </div>
            <h3>${escapeHtml(item.description)}</h3>
            <div class="remediation-original"><span>Respuesta original</span><strong>${escapeHtml(item.actualValue || 'Sin respuesta')}</strong></div>
            <label class="remediation-label" for="correction-${escapeHtml(item.id)}">Respuesta propuesta</label>
            ${correctionControl}
            ${item.observation ? `<p class="remediation-observation">${escapeHtml(item.observation)}</p>` : ''}`;
        fragment.appendChild(card);
    });
    list.appendChild(fragment);
    actions.classList.remove('hidden');
    updateCorrectionSummary();
}

function updateCorrectionSummary() {
    const doc = pdfDocuments[$('correctionPdfSelect').value];
    if (!doc) return;
    const saved = doc.corrections || {};
    const fields = [...$('remediationItems').querySelectorAll('.correction-field')];
    const pending = fields.filter(field => field.value !== (Object.prototype.hasOwnProperty.call(saved, field.dataset.correctionId)
        ? String(saved[field.dataset.correctionId])
        : field.dataset.original));
    const savedCount = Object.keys(saved).length;
    $('correctionCount').textContent = pending.length
        ? `${pending.length} cambio(s) sin guardar`
        : `${savedCount} cambio(s) guardado(s)`;
    $('saveCorrectionBtn').disabled = pending.length === 0;
    $('exportCorrectionBtn').disabled = savedCount === 0 || pending.length > 0;
}

async function saveCorrectionProposal() {
    const key = $('correctionPdfSelect').value;
    const doc = pdfDocuments[key];
    if (!doc) return;

    const corrections = {};
    $('remediationItems').querySelectorAll('.correction-field').forEach(field => {
        const value = field.value.trim();
        if (value !== field.dataset.original) corrections[field.dataset.correctionId] = value;
    });
    doc.corrections = corrections;
    await saveDocument(key);
    renderCorrectionItems();
    showToast('Propuesta de subsanación guardada; el PDF original no fue modificado.', 'success');
}

function exportCorrectionProposal() {
    const key = $('correctionPdfSelect').value;
    const doc = pdfDocuments[key];
    if (!doc || !Object.keys(doc.corrections || {}).length) return;
    const corrections = doc.items.filter(item => Object.prototype.hasOwnProperty.call(doc.corrections, item.id));
    const rows = corrections.map(item => `
        <tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.description)}</td>
        <td>${escapeHtml(item.actualValue || 'Sin respuesta')}</td><td>${escapeHtml(doc.corrections[item.id] || 'Sin respuesta')}</td></tr>`).join('');
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Propuesta de subsanación</title>
        <style>body{font:14px Arial,sans-serif;color:#202b33;margin:36px}h1{font-size:22px}p{line-height:1.5}.notice{padding:12px;background:#f0f3f5;border-left:4px solid #5aa7ff}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{padding:10px;border:1px solid #d7dfe3;text-align:left;vertical-align:top}th{background:#eef2f5}@media print{body{margin:18mm}}</style></head>
        <body><h1>Propuesta de subsanación</h1><p><strong>PDF de referencia:</strong> ${escapeHtml(key)}</p>
        <p><strong>Fecha:</strong> ${new Date().toLocaleDateString('es-CO')}</p>
        <p class="notice">Este documento contiene cambios propuestos en campos no asociados a imágenes. No reemplaza ni modifica el PDF fuente; las correcciones deben aplicarse en el formulario original y volver a exportarse.</p>
        <table><thead><tr><th>Ítem</th><th>Campo</th><th>Respuesta original</th><th>Respuesta propuesta</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `Subsanacion-${key.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*]+/g, '-')}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function openBeneficiaryLookup(globalId) {
    const item = allItemsData.find(candidate => candidate.globalId === globalId);
    if (!item || ![6, 85].includes(item.id)) return;
    if (typeof BENEFICIARIOS === 'undefined' || !BENEFICIARIOS.length) {
        showToast('El listado de beneficiarios no está disponible.', 'error');
        return;
    }

    beneficiaryLookupGlobalId = globalId;
    lastFocusedElement = document.activeElement;
    const addressItem = item.id === 85
        ? allItemsData.find(candidate => candidate.pdfName === item.pdfName && candidate.id === 6)
        : null;
    $('beneficiaryTitle').textContent = item.id === 85 ? 'Verificar NIU' : 'Listado de beneficiarios';
    $('beneficiaryDetectedAddress').textContent = item.id === 85
        ? `NIU del PDF: ${item.actualValue || 'Sin NIU detectado'} · Dirección: ${addressItem && addressItem.actualValue || 'No disponible'}`
        : `Dirección del PDF: ${item.actualValue || 'Sin dirección detectada'}`;
    $('beneficiarySearch').value = item.actualValue || '';
    $('beneficiaryModal').classList.remove('hidden');
    renderBeneficiaryResults();
    $('beneficiarySearch').focus();
}

function closeBeneficiaryLookup() {
    $('beneficiaryModal').classList.add('hidden');
    beneficiaryLookupGlobalId = null;
    if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
}

function renderBeneficiaryResults() {
    const list = $('beneficiaryResults');
    const item = allItemsData.find(candidate => candidate.globalId === beneficiaryLookupGlobalId);
    const isNiuLookup = item && item.id === 85;
    const rawQuery = $('beneficiarySearch').value.trim();
    const query = fold(rawQuery);
    const addressQuery = fold(canonAddress(rawQuery));
    const queryNiu = niuKey(rawQuery);
    const matches = BENEFICIARIOS.map((beneficiary, index) => {
        const address = fold(canonAddress(beneficiary.direccion));
        const other = fold(`${beneficiary.niu} ${beneficiary.barrio || ''}`);
        const exactNiu = Boolean(isNiuLookup && queryNiu && queryNiu === niuKey(beneficiary.niu));
        let score = 0;
        if (exactNiu) score = 1.1;
        else if (!query) score = 1;
        else if (addressQuery && address.includes(addressQuery)) score = 1;
        else if (other.includes(query)) score = 1;
        else if (addressQuery.length >= 4 && Math.abs(address.length - addressQuery.length) <= addressQuery.length * 0.5) {
            score = textSimilarity(addressQuery, address);
        }
        const itemNiuMatches = Boolean(isNiuLookup && niuKey(item.actualValue) && niuKey(item.actualValue) === niuKey(beneficiary.niu));
        return { beneficiary, index, score, exactNiu, itemNiuMatches };
    }).filter(row => !query || row.score >= 0.75)
        .sort((a, b) => Number(b.exactNiu) - Number(a.exactNiu) || b.score - a.score || a.beneficiary.direccion.localeCompare(b.beneficiary.direccion, 'es'));

    $('beneficiaryResultsCount').textContent = query
        ? `${matches.length} coincidencia(s) · mejores resultados primero`
        : `${BENEFICIARIOS.length} registros · escribe para filtrar`;
    const shown = matches.slice(0, 80);
    if (!shown.length) {
        list.innerHTML = '<div class="empty-state"><p>No se encontraron coincidencias</p><small>Prueba con una parte de la dirección, el NIU o el barrio.</small></div>';
        return;
    }

    list.innerHTML = shown.map(({ beneficiary, index, score, itemNiuMatches }) => `
        <article class="beneficiary-row">
            <div class="beneficiary-details">
                <strong>${escapeHtml(beneficiary.direccion)}</strong>
                <span>NIU ${escapeHtml(beneficiary.niu)} · ${escapeHtml(beneficiary.barrio || 'Barrio no registrado')}</span>
            </div>
            <span class="beneficiary-match">${Math.round(score * 100)}%</span>
            <button type="button" class="btn ${isNiuLookup && !itemNiuMatches ? 'btn-secondary' : 'btn-primary'}" data-beneficiary-index="${index}">${isNiuLookup ? itemNiuMatches ? 'Confirmar NIU' : 'Registrar discrepancia' : 'Confirmar dirección'}</button>
        </article>`).join('');
}

async function confirmBeneficiaryRecord(index) {
    const beneficiary = BENEFICIARIOS[index];
    const item = allItemsData.find(candidate => candidate.globalId === beneficiaryLookupGlobalId);
    if (!beneficiary || !item || ![6, 85].includes(item.id)) return;

    if (item.id === 85) {
        const matches = Boolean(niuKey(item.actualValue) && niuKey(item.actualValue) === niuKey(beneficiary.niu));
        const message = matches
            ? `NIU ${beneficiary.niu} confirmado en el listado para la dirección ${beneficiary.direccion}`
            : `NIU distinto: PDF ${item.actualValue || 'vacío'}, listado ${beneficiary.niu}. Dirección: ${beneficiary.direccion}.`;
        item.beneficiaryConfirmation = {
            type: 'niu', matched: matches, niu: beneficiary.niu,
            direccion: beneficiary.direccion, barrio: beneficiary.barrio || '',
            confirmedAt: new Date().toISOString(), message
        };
        item.status = matches ? 'compliant' : 'non-compliant';
        item.reasonCode = matches ? '' : 'niu_list';
        item.observation = matches ? '' : message;
        await saveDocument(item.pdfName);
        closeBeneficiaryLookup();
        if ($('filterStatus').value === (matches ? 'non-compliant' : 'compliant')) $('filterStatus').value = '';
        updateReviewSection();
        showToast(matches ? 'NIU confirmado contra el listado.' : 'El NIU no coincide; se mantiene No cumple.', matches ? 'success' : 'warning');
        return;
    }

    item.beneficiaryConfirmation = {
        type: 'address', matched: true,
        niu: beneficiary.niu,
        direccion: beneficiary.direccion,
        barrio: beneficiary.barrio || '',
        confirmedAt: new Date().toISOString(),
        message: `Dirección confirmada en listado: ${beneficiary.direccion} · NIU ${beneficiary.niu}`
    };
    item.status = 'compliant';
    item.reasonCode = '';
    item.observation = '';
    await saveDocument(item.pdfName);
    closeBeneficiaryLookup();
    if ($('filterStatus').value === 'non-compliant') $('filterStatus').value = '';
    updateReviewSection();
    showToast(`Dirección confirmada contra el listado (NIU ${beneficiary.niu}).`, 'success');
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
