/**
 * VISOR DE EVIDENCIA: muestra en un modal el recorte del PDF donde está el ítem
 */
let evidenceToken = 0;

function itemNeedsEvidence(item) {
    if (!item.evidence || item.notApplicable) return false;
    return item.status === 'non-compliant' || item.status === 'review';
}

async function openEvidence(globalId) {
    const item = allItemsData.find(i => i.globalId === globalId);
    if (!item) return;
    const doc = pdfDocuments[globalId.split('::')[0]];
    const modal = document.getElementById('evidenceModal');
    const body = document.getElementById('evidenceBody');
    const token = ++evidenceToken;

    document.getElementById('evidenceTitle').textContent = `Item #${item.id} — ${item.pdfName}`;
    document.getElementById('evidenceDesc').textContent = item.description;
    document.getElementById('evidenceNote').textContent = item.observation || item.imageNote || '';
    body.innerHTML = '<p class="evidence-msg">Cargando evidencia…</p>';
    modal.classList.remove('hidden');

    if (!doc || !doc.file || !item.evidence) {
        body.innerHTML = '<p class="evidence-msg">No hay evidencia disponible para este ítem.</p>';
        return;
    }

    let pdf;
    try {
        pdf = await pdfjsLib.getDocument({ data: await doc.file.arrayBuffer() }).promise;
        const ev = item.evidence;
        const page = await pdf.getPage(ev.page || 1);
        const scale = 1.8;
        const viewport = page.getViewport({ scale });

        const full = document.createElement('canvas');
        full.width = Math.ceil(viewport.width);
        full.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;
        if (token !== evidenceToken) return;

        // Recorte: coordenadas PDF (origen abajo) -> píxeles del canvas
        let sy = 0, sh = full.height;
        if (!ev.full && typeof ev.top === 'number') {
            const pad = 12 * scale;
            sy = Math.max(0, (ev.pageHeight - ev.top) * scale - pad);
            const ey = Math.min(full.height, (ev.pageHeight - ev.bottom) * scale + pad);
            sh = Math.max(40, ey - sy);
        }
        const crop = document.createElement('canvas');
        crop.width = full.width;
        crop.height = Math.round(sh);
        crop.getContext('2d').drawImage(full, 0, sy, full.width, sh, 0, 0, full.width, sh);

        body.innerHTML = '';
        crop.className = 'evidence-canvas';
        body.appendChild(crop);
        if (!ev.full) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'btn btn-secondary';
            more.textContent = '📄 Ver página completa';
            more.addEventListener('click', () => {
                full.className = 'evidence-canvas';
                body.replaceChildren(full);
            });
            body.appendChild(more);
        }
    } catch (err) {
        if (token === evidenceToken) body.innerHTML = '<p class="evidence-msg">No se pudo mostrar el PDF.</p>';
        console.error(err);
    } finally {
        if (pdf) pdf.destroy();
    }
}

function closeEvidence() {
    evidenceToken++;
    document.getElementById('evidenceModal').classList.add('hidden');
    document.getElementById('evidenceBody').innerHTML = '';
}
