/**
 * VISOR DE EVIDENCIA: muestra en un modal el recorte del PDF donde está el ítem.
 * Mejoras: el PDF abierto se cachea (no se vuelve a parsear en cada clic), el recorte se
 * renderiza directamente (sin canvas de página completa) y el PDF completo se pinta bajo demanda.
 */
let evidenceToken = 0;
let evidenceObserver = null;
const pdfCache = { file: null, promise: null };

function itemNeedsEvidence(item) {
    return Boolean(pdfDocuments[item.globalId.split('::')[0]]);
}

/** Devuelve el PDF abierto del archivo (reutiliza el último abierto) */
function getCachedPdf(file) {
    if (pdfCache.file === file && pdfCache.promise) return pdfCache.promise;
    releasePdfCache();
    pdfCache.file = file;
    pdfCache.promise = file.arrayBuffer()
        .then(data => pdfjsLib.getDocument({ data }).promise)
        .catch(err => { releasePdfCache(); throw err; });
    return pdfCache.promise;
}

function releasePdfCache() {
    const pending = pdfCache.promise;
    pdfCache.file = null;
    pdfCache.promise = null;
    if (pending) pending.then(pdf => pdf.destroy()).catch(() => {});
}

function stopEvidenceObserver() {
    if (evidenceObserver) { evidenceObserver.disconnect(); evidenceObserver = null; }
}

/** Muestra todas las páginas del PDF; cada una se dibuja solo al acercarse a la pantalla */
async function openFullPdf(globalId) {
    const item = allItemsData.find(i => i.globalId === globalId);
    if (!item) return;
    const doc = pdfDocuments[globalId.split('::')[0]];
    const body = document.getElementById('evidenceBody');
    const token = ++evidenceToken;
    stopEvidenceObserver();

    document.getElementById('evidenceTitle').textContent = `PDF completo — ${item.pdfName}`;
    document.getElementById('evidenceDesc').textContent = `Item #${item.id}: ${item.description}`;
    document.getElementById('evidenceNote').textContent = '';
    body.innerHTML = '<p class="evidence-msg">Cargando PDF…</p>';
    document.getElementById('evidenceModal').classList.remove('hidden');
    if (!doc || !doc.file) {
        body.innerHTML = '<p class="evidence-msg">El PDF no está disponible.</p>';
        return;
    }

    try {
        const pdf = await getCachedPdf(doc.file);
        if (token !== evidenceToken) return;
        const target = (item.evidence && item.evidence.page) || 1;
        const scale = 1.5;
        const slots = [];

        for (let n = 1; n <= pdf.numPages; n++) {
            const page = await pdf.getPage(n);
            if (token !== evidenceToken) return;
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            canvas.className = 'evidence-canvas pending';
            canvas.dataset.page = n;
            slots.push({ canvas, page, viewport, done: false });
        }

        body.replaceChildren(...slots.map(s => s.canvas));
        const renderSlot = async slot => {
            if (slot.done) return;
            slot.done = true;
            try {
                await slot.page.render({ canvasContext: slot.canvas.getContext('2d'), viewport: slot.viewport }).promise;
                slot.canvas.classList.remove('pending');
                slot.page.cleanup();
            } catch (err) { console.warn('Página no renderizada', err); }
        };

        evidenceObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                evidenceObserver.unobserve(entry.target);
                renderSlot(slots[Number(entry.target.dataset.page) - 1]);
            });
        }, { rootMargin: '800px 0px' });
        slots.forEach(s => evidenceObserver.observe(s.canvas));

        const targetSlot = slots[Math.min(target, slots.length) - 1];
        if (targetSlot) { renderSlot(targetSlot); targetSlot.canvas.scrollIntoView({ block: 'start' }); }
    } catch (err) {
        if (token === evidenceToken) body.innerHTML = '<p class="evidence-msg">No se pudo mostrar el PDF.</p>';
        console.error(err);
    }
}

async function openEvidence(globalId) {
    const item = allItemsData.find(i => i.globalId === globalId);
    if (!item) return;
    const doc = pdfDocuments[globalId.split('::')[0]];
    const modal = document.getElementById('evidenceModal');
    const body = document.getElementById('evidenceBody');
    const token = ++evidenceToken;
    stopEvidenceObserver();

    document.getElementById('evidenceTitle').textContent = `Item #${item.id} — ${item.pdfName}`;
    document.getElementById('evidenceDesc').textContent = item.description;
    document.getElementById('evidenceNote').textContent = item.observation || item.imageNote || item.autoReason || '';
    body.innerHTML = '<p class="evidence-msg">Cargando evidencia…</p>';
    modal.classList.remove('hidden');

    if (!doc || !doc.file) {
        body.innerHTML = '<p class="evidence-msg">No hay evidencia disponible para este ítem.</p>';
        return;
    }
    const ev = item.evidence || (item.evidence = { page: 1, full: true });

    try {
        const pdf = await getCachedPdf(doc.file);
        const page = await pdf.getPage(ev.page || 1);
        if (token !== evidenceToken) return;
        const scale = 1.8;
        const viewport = page.getViewport({ scale });

        // Recorte: coordenadas PDF (origen abajo) -> píxeles; se dibuja solo la franja necesaria
        let sy = 0, sh = viewport.height;
        if (!ev.full && typeof ev.top === 'number') {
            const pad = 12 * scale;
            sy = Math.max(0, (ev.pageHeight - ev.top) * scale - pad);
            const ey = Math.min(viewport.height, (ev.pageHeight - ev.bottom) * scale + pad);
            sh = Math.max(40, ey - sy);
        }
        const crop = document.createElement('canvas');
        crop.width = Math.ceil(viewport.width);
        crop.height = Math.round(sh);
        crop.className = 'evidence-canvas';
        await page.render({
            canvasContext: crop.getContext('2d'),
            viewport,
            transform: [1, 0, 0, 1, 0, -sy]
        }).promise;
        if (token !== evidenceToken) return;

        body.innerHTML = '';
        body.appendChild(crop);
        if (!ev.full) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'btn btn-secondary';
            more.textContent = '📄 Ver página completa';
            more.addEventListener('click', async () => {
                more.disabled = true;
                const full = document.createElement('canvas');
                full.width = Math.ceil(viewport.width);
                full.height = Math.ceil(viewport.height);
                full.className = 'evidence-canvas';
                try {
                    await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;
                    if (token === evidenceToken) body.replaceChildren(full);
                } catch (err) { console.error(err); more.disabled = false; }
            });
            body.appendChild(more);
        }
    } catch (err) {
        if (token === evidenceToken) body.innerHTML = '<p class="evidence-msg">No se pudo mostrar el PDF.</p>';
        console.error(err);
    }
}

function closeEvidence() {
    evidenceToken++;
    stopEvidenceObserver();
    document.getElementById('evidenceModal').classList.add('hidden');
    document.getElementById('evidenceBody').innerHTML = '';
    releasePdfCache();
}
