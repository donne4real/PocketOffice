/* ==========================================================================
   pdftools.js — PDF Tools: view + merge + split + reorder + rotate + delete
                 + add-text + sign (draw) + export. All via pdf.js (render)
                 and pdf-lib (manipulate), 100% offline.
   ========================================================================== */

const PdfTools = (() => {
  // ---- pdf.js setup ----
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.workerSrc = 'lib/pdf.worker.min.js';
    if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }
  const PL = () => window.PDFLib;   // pdf-lib exposes PDFLib global

  // ---- state ----
  let pdfBytes = null;          // Uint8Array of the currently loaded PDF
  let pdfDoc = null;            // pdf.js PDFDocumentProxy (for rendering)
  let fileName = 'document.pdf';
  let zoom = 1.0;
  // Working page order: array of indices into the original pdfBytes.
  // (Deletions and reorders mutate this list; saves flatten it.)
  let pageOrder = [];
  // Per-page overlays: annotations added on top. Each entry is an array
  // of { kind:'text'|'image'|'draw', ... }. We render them into the saved PDF.
  const overlays = {};          // overlays[origPageIndex] = [...]

  const $ = (id) => document.getElementById(id);

  function setControlsVisible(v) {
    for (const id of ['pdfClose','pdfNavSep','pdfPrev','pdfPageInfo','pdfNext','pdfZoomSep','pdfZoomOut','pdfZoomInfo','pdfZoomIn',
                      'pdfMergeBtn','pdfSplitBtn','pdfRotateBtn','pdfDeleteBtn','pdfTextBtn','pdfSignBtn','pdfSaveBtn','pdfSep2',
                      'pdfUndoBtn','pdfRedoBtn']) {
      const el = $(id); if (el) el.style.display = v ? '' : 'none';
    }
    const empty = $('pdfEmpty'); if (empty) empty.style.display = v ? 'none' : '';
    const pages = $('pdfPages'); if (pages) pages.style.display = v ? 'flex' : 'none';
    const docName = $('pdfDocName'); if (docName) { docName.style.display = v ? '' : 'none'; if (v) docName.textContent = fileName; }
    const hint = $('pdfHint'); if (hint) hint.style.display = v ? 'none' : '';
    // The merge button is useful both with and without a doc; show it always.
    if ($('pdfMergeBtn')) $('pdfMergeBtn').style.display = '';
  }

  // ---- Open ----
  async function openFile() {
    try {
      const f = await FS.open({
        accept: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
      });
      await loadBytes(f.bytes, f.name);
      UI.toast(`Opened ${f.name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('PDF open failed: ' + (e.message || e), 'error');
    }
  }

  async function loadBytes(bytes, name) {
    pdfBytes = bytes;
    fileName = name || 'document.pdf';
    const task = pdfjsLib.getDocument({ data: bytes.slice(0) });
    pdfDoc = await task.promise;
    pageOrder = pdfDoc.numPages ? Array.from({ length: pdfDoc.numPages }, (_, i) => i) : [];
    for (const k of Object.keys(overlays)) delete overlays[k];
    zoom = 1.0;
    setControlsVisible(true);
    await renderAll();
    updatePageInfo();
    History.reset('pdf');
  }

  function closeDoc() {
    pdfBytes = null; pdfDoc = null; pageOrder = [];
    for (const k of Object.keys(overlays)) delete overlays[k];
    setControlsVisible(false);
    $('pdfPages').innerHTML = '';
    History.reset('pdf');
  }

  // ---- Render ----
  async function renderAll() {
    if (!pdfDoc) return;
    const container = $('pdfPages');
    container.innerHTML = '';
    for (let display = 0; display < pageOrder.length; display++) {
      const origIdx = pageOrder[display];
      const wrap = document.createElement('div');
      wrap.className = 'pdf-pagewrap';
      wrap.dataset.display = display;
      const canvas = document.createElement('canvas');
      wrap.appendChild(canvas);
      const bar = document.createElement('div');
      bar.className = 'pdf-pagebar';
      bar.innerHTML = `<span class="pdf-pagelabel">Page ${display + 1}</span>
        <span style="flex:1"></span>
        <button class="tb-btn icon-only" data-act="up" title="Move up">▲</button>
        <button class="tb-btn icon-only" data-act="down" title="Move down">▼</button>
        <button class="tb-btn icon-only" data-act="rotate" title="Rotate 90°">⟳</button>
        <button class="tb-btn icon-only" data-act="delete" title="Delete page">🗑</button>`;
      wrap.appendChild(bar);
      container.appendChild(wrap);
      await renderPage(origIdx, canvas);
      // Wire bar buttons
      bar.querySelector('[data-act=up]').onclick = (e) => { e.stopPropagation(); movePage(display, -1); };
      bar.querySelector('[data-act=down]').onclick = (e) => { e.stopPropagation(); movePage(display, 1); };
      bar.querySelector('[data-act=rotate]').onclick = (e) => { e.stopPropagation(); rotatePage(display); };
      bar.querySelector('[data-act=delete]').onclick = (e) => { e.stopPropagation(); deletePage(display); };
      if (display < pageOrder.length - 1) await new Promise(r => setTimeout(r, 0));
    }
  }

  async function renderPage(origIdx, canvas) {
    const page = await pdfDoc.getPage(origIdx + 1);
    const viewport = page.getViewport({ scale: 1.2 * zoom });
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    await page.render({ canvasContext: ctx, viewport }).promise;
    // Render overlays on top (text + images + drawings)
    renderOverlays(canvas, origIdx);
  }

  function renderOverlays(canvas, origIdx) {
    const list = overlays[origIdx] || [];
    if (!list.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    // The canvas is rendered at 1.2*zoom scale of the PDF point size (612x792 for letter).
    // We store overlay coords in PDF points; convert to canvas px.
    const sx = w / pageWidthPt(), sy = h / pageHeightPt(origIdx);
    for (const o of list) {
      if (o.kind === 'text') {
        ctx.fillStyle = o.color || '#000000';
        ctx.font = `${(o.size || 14) * sx}px Helvetica`;
        ctx.textBaseline = 'top';
        ctx.fillText(o.text, o.x * sx, o.y * sy);
      } else if (o.kind === 'image') {
        try {
          const img = o._imgEl || (() => { const i = new Image(); i.src = o.dataUrl; o._imgEl = i; return i; })();
          ctx.drawImage(img, o.x * sx, o.y * sy, o.w * sx, o.h * sy);
        } catch (e) { /* ignore */ }
      } else if (o.kind === 'draw') {
        // o.points is array of {x,y} in PDF points; o.color, o.width
        if (o.points.length < 2) continue;
        ctx.strokeStyle = o.color || '#000000';
        ctx.lineWidth = (o.width || 2) * Math.min(sx, sy);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(o.points[0].x * sx, o.points[0].y * sy);
        for (let i = 1; i < o.points.length; i++) ctx.lineTo(o.points[i].x * sx, o.points[i].y * sy);
        ctx.stroke();
      }
    }
  }
  function pageWidthPt() { return (pdfDoc && pdfDoc.getPage) ? 612 : 612; }   // approximate; refined per page
  async function pageDimensions(origIdx) {
    const page = await pdfDoc.getPage(origIdx + 1);
    const vp = page.getViewport({ scale: 1 });
    return { w: vp.width, h: vp.height };
  }
  function pageHeightPt() { return 792; }

  // ---- Page operations (mutate pageOrder / overlays; re-render) ----
  // ---------- Undo ----------
  function pdfSnapshot() {
    const snap = { pageOrder: [...pageOrder], overlays: Util.deepClone(overlays) };
    History.snapshot('pdf', snap, (s) => {
      pageOrder.length = 0; pageOrder.push(...s.pageOrder);
      for (const k of Object.keys(overlays)) delete overlays[k];
      Object.assign(overlays, Util.deepClone(s.overlays));
      renderAll(); updatePageInfo();
    });
  }
  function doUndo() { History.undo('pdf'); }
  function doRedo() { History.redo('pdf'); }

  async function movePage(display, dir) {
    const j = display + dir;
    if (j < 0 || j >= pageOrder.length) return;
    pdfSnapshot();
    [pageOrder[display], pageOrder[j]] = [pageOrder[j], pageOrder[display]];
    await renderAll(); markDirty();
  }
  async function deletePage(display) {
    pdfSnapshot();
    pageOrder.splice(display, 1);
    await renderAll(); updatePageInfo(); markDirty();
    UI.toast(`Deleted page ${display + 1}`, 'success');
  }
  async function rotatePage(display) {
    pdfSnapshot();
    // Rotation is applied as an overlay-stored transform; we keep it on the
    // underlying original index so it survives reorder. Track via overlays metadata.
    const origIdx = pageOrder[display];
    const meta = overlays['__meta_' + origIdx] = overlays['__meta_' + origIdx] || { rotation: 0 };
    meta.rotation = (meta.rotation + 90) % 360;
    // pdf.js can re-render with rotation via viewport rotation
    await renderAll(); markDirty();
    UI.toast(`Rotated page ${display + 1} to ${meta.rotation}°`, 'success');
  }

  function updatePageInfo() {
    const el = $('pdfPageInfo');
    if (el) el.textContent = `${pageOrder.length} page${pageOrder.length === 1 ? '' : 's'}`;
  }

  function markDirty() {
    if ($('pdfSaveBtn')) $('pdfSaveBtn').classList.add('primary');
  }

  // ---- Merge ----
  async function mergePdfs() {
    try {
      const files = await FS.open({
        accept: [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }],
        multiple: true,
      });
      if (!files || !files.length) return;
      UI.toast(`Merging ${files.length} PDFs…`, 'info');
      const out = await PL().PDFDocument.create();
      for (const f of files) {
        const src = await PL().PDFDocument.load(f.bytes);
        const idxs = await out.copyPages(src, src.getPageIndices());
        idxs.forEach(p => out.addPage(p));
      }
      const saved = await out.save();
      await loadBytes(saved, 'merged.pdf');
      UI.toast(`Merged ${files.length} PDFs into ${pageOrder.length} pages`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Merge failed: ' + (e.message || e), 'error');
    }
  }

  // ---- Split (extract page range) ----
  async function splitPdf() {
    if (!pdfBytes) { UI.toast('Open a PDF first', 'warn'); return; }
    const body = document.createElement('div');
    body.style.minWidth = '320px';
    body.innerHTML = `
      <p class="muted" style="margin:0 0 10px">Extract pages into a new PDF. Enter ranges like 1-3, 5, 8-10.</p>
      <div class="row"><label>Pages</label><input type="text" id="splitRange" value="1-${pageOrder.length}"></div>
      <p class="muted small" style="margin:0">Total pages: ${pageOrder.length}</p>`;
    UI.dialog({
      title: 'Split / extract pages', body, okText: 'Extract',
      onOk: async () => {
        const spec = body.querySelector('#splitRange').value;
        const pages = parseRange(spec, pageOrder.length);
        if (!pages.length) { UI.toast('No valid pages in range', 'err'); return false; }
        const src = await PL().PDFDocument.load(pdfBytes);
        const out = await PL().PDFDocument.create();
        // Map display page -> original index
        const origIndices = pages.map(p => pageOrder[p - 1]).filter(i => i != null);
        const copied = await out.copyPages(src, origIndices);
        copied.forEach(p => out.addPage(p));
        const saved = await out.save();
        await FS.save({ name: fileName.replace(/\.pdf$/i, '') + '-extract.pdf', mime: 'application/pdf', bytes: saved, handle: null });
        UI.toast(`Extracted ${pages.length} page${pages.length === 1 ? '' : 's'}`, 'success');
      },
    });
  }
  function parseRange(spec, max) {
    const out = [];
    for (const part of spec.split(/[,\s]+/)) {
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
      if (m) {
        let a = +m[1], b = +m[2];
        if (a > b) [a, b] = [b, a];
        for (let i = a; i <= b; i++) if (i >= 1 && i <= max) out.push(i);
      } else if (/^\d+$/.test(part)) {
        const n = +part;
        if (n >= 1 && n <= max) out.push(n);
      }
    }
    return [...new Set(out)];
  }

  // ---- Add text overlay ----
  async function addTextOverlay() {
    if (!pdfBytes) { UI.toast('Open a PDF first', 'warn'); return; }
    const body = document.createElement('div');
    body.style.minWidth = '360px';
    body.innerHTML = `
      <div class="row"><label>Text</label><input type="text" id="atText" placeholder="Type to add…"></div>
      <div class="row"><label>Page</label><input type="number" id="atPage" value="1" min="1" max="${pageOrder.length}"></div>
      <div class="row"><label>X (pt)</label><input type="number" id="atX" value="72"></div>
      <div class="row"><label>Y (pt)</label><input type="number" id="atY" value="72"></div>
      <div class="row"><label>Size</label><input type="number" id="atSize" value="14"></div>
      <div class="row"><label>Color</label><input type="text" id="atColor" value="#000000"></div>
      <p class="muted small" style="margin:6px 0 0">Coordinates are from the top-left corner in points (1/72 inch). Letter page is 612×792.</p>`;
    UI.dialog({
      title: 'Add text', body, okText: 'Add',
      onOk: async () => {
        const text = body.querySelector('#atText').value;
        const page = +body.querySelector('#atPage').value;
        if (!text) return false;
        const origIdx = pageOrder[page - 1];
        if (origIdx == null) { UI.toast('Invalid page', 'err'); return false; }
        pdfSnapshot();
        overlays[origIdx] = overlays[origIdx] || [];
        overlays[origIdx].push({
          kind: 'text', text,
          x: +body.querySelector('#atX').value,
          y: +body.querySelector('#atY').value,
          size: +body.querySelector('#atSize').value,
          color: body.querySelector('#atColor').value,
        });
        await renderAll(); markDirty();
        UI.toast(`Added text to page ${page}`, 'success');
      },
    });
  }

  // ---- Sign by drawing ----
  async function signDraw() {
    if (!pdfBytes) { UI.toast('Open a PDF first', 'warn'); return; }
    const body = document.createElement('div');
    body.style.minWidth = '420px';
    body.innerHTML = `
      <p class="muted" style="margin:0 0 8px">Draw your signature below, then place it on a page.</p>
      <canvas id="sigCanvas" width="400" height="160" style="border:1px solid var(--border);border-radius:6px;background:#fff;cursor:crosshair;width:100%;touch-action:none"></canvas>
      <div class="row" style="margin-top:8px"><label>Page</label><input type="number" id="sigPage" value="1" min="1" max="${pageOrder.length}"></div>
      <div class="row"><label>X (pt)</label><input type="number" id="sigX" value="72"></div>
      <div class="row"><label>Y (pt)</label><input type="number" id="sigY" value="72"></div>
      <div class="row"><label>Width (pt)</label><input type="number" id="sigW" value="200"></div>`;
    const dlg = UI.dialog({ title: 'Sign (draw)', body, okText: 'Place signature', cancelText: 'Cancel' });
    // Drawing
    const canvas = body.querySelector('#sigCanvas');
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    let drawing = false, last = null;
    const pts = [];
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x: cx * canvas.width / r.width, y: cy * canvas.height / r.height };
    };
    const down = (e) => { e.preventDefault(); drawing = true; last = pos(e); pts.push(last); };
    const move = (e) => {
      if (!drawing) return; e.preventDefault();
      const p = pos(e); pts.push(p);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
    };
    const up = () => { drawing = false; };
    canvas.addEventListener('mousedown', down); canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', up); canvas.addEventListener('mouseleave', up);
    canvas.addEventListener('touchstart', down); canvas.addEventListener('touchmove', move); canvas.addEventListener('touchend', up);
    // Replace the OK handler
    dlg.el.querySelector('[data-act=ok]').onclick = async () => {
      if (!pts.length) { UI.toast('Draw a signature first', 'warn'); return; }
      const page = +body.querySelector('#sigPage').value;
      const origIdx = pageOrder[page - 1];
      if (origIdx == null) { UI.toast('Invalid page', 'err'); return; }
      // Convert canvas drawing into PDF-point-space strokes.
      // Canvas is 400x160; we'll scale to the chosen width and preserve aspect.
      const targetW = +body.querySelector('#sigW').value;
      const targetH = targetW * (canvas.height / canvas.width);
      const x0 = +body.querySelector('#sigX').value;
      const y0 = +body.querySelector('#sigY').value;
      const scale = targetW / canvas.width;
      // Y in PDF coords from top-left (we render overlays top-left origin)
      const stroke = pts.map(p => ({ x: x0 + p.x * scale, y: y0 + p.y * scale }));
      pdfSnapshot();
      overlays[origIdx] = overlays[origIdx] || [];
      overlays[origIdx].push({ kind: 'draw', points: stroke, color: '#111111', width: 1.5 });
      dlg.close();
      await renderAll(); markDirty();
      UI.toast(`Signature placed on page ${page}`, 'success');
    };
  }

  // ---- Save (flatten pageOrder + overlays into a new PDF) ----
  async function saveDoc() {
    if (!pdfBytes) { UI.toast('Nothing to save', 'warn'); return; }
    try {
      UI.toast('Building PDF…', 'info');
      const src = await PL().PDFDocument.load(pdfBytes);
      const out = await PL().PDFDocument.create();
      const helv = await out.embedFont(PL().StandardFonts.Helvetica);
      // For each page in display order, copy it then apply overlays.
      for (let display = 0; display < pageOrder.length; display++) {
        const origIdx = pageOrder[display];
        const [copied] = await out.copyPages(src, [origIdx]);
        const page = out.addPage(copied);
        // Apply rotation meta if any
        const meta = overlays['__meta_' + origIdx];
        if (meta && meta.rotation) {
          page.setRotation(PL().degrees((page.getRotation().angle + meta.rotation) % 360));
        }
        // Apply overlays (text, image, draw)
        const list = overlays[origIdx] || [];
        const { width: PW, height: PH } = page.getSize();
        for (const o of list) {
          if (o.kind === 'text') {
            const hex = (o.color || '#000000').replace('#','');
            const r = parseInt(hex.substr(0,2),16)/255;
            const g = parseInt(hex.substr(2,2),16)/255;
            const b = parseInt(hex.substr(4,2),16)/255;
            // pdf-lib uses bottom-left origin; our overlay uses top-left.
            page.drawText(o.text, {
              x: o.x, y: PH - o.y - (o.size || 14),
              size: o.size || 14, font: helv,
              color: PL().rgb(r, g, b),
            });
          } else if (o.kind === 'image') {
            try {
              const bytes = dataUrlToBytes(o.dataUrl);
              const img = o.dataUrl.indexOf('image/png') >= 0
                ? await out.embedPng(bytes)
                : await out.embedJpg(bytes);
              page.drawImage(img, { x: o.x, y: PH - o.y - o.h, width: o.w, height: o.h });
            } catch (e) { /* ignore unsupported */ }
          } else if (o.kind === 'draw' && o.points.length >= 2) {
            const hex = (o.color || '#000000').replace('#','');
            const r = parseInt(hex.substr(0,2),16)/255;
            const g = parseInt(hex.substr(2,2),16)/255;
            const b = parseInt(hex.substr(4,2),16)/255;
            // Draw a series of thin rectangles between consecutive points (polyline).
            for (let i = 1; i < o.points.length; i++) {
              const a = o.points[i-1], b2 = o.points[i];
              page.drawLine({
                start: { x: a.x, y: PH - a.y },
                end:   { x: b2.x, y: PH - b2.y },
                thickness: o.width || 1.5,
                color: PL().rgb(r, g, b),
              });
            }
          }
        }
      }
      const saved = await out.save();
      await FS.save({ name: fileName, mime: 'application/pdf', bytes: saved, handle: null });
      UI.toast(`Saved ${fileName} (${pageOrder.length} pages)`, 'success');
      // Reload from the saved bytes so further edits stack cleanly.
      await loadBytes(saved, fileName);
    } catch (e) {
      UI.toast('Save failed: ' + (e.message || e), 'error');
    }
  }

  function dataUrlToBytes(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---- Zoom ----
  function zoomBy(delta) {
    zoom = Math.max(0.25, Math.min(4, +(zoom + delta).toFixed(2)));
    renderAll();
    $('pdfZoomInfo').textContent = Math.round(zoom * 100) + '%';
  }

  // ---- Wire up ----
  function wire() {
    $('pdfOpen').onclick = openFile;
    $('pdfClose').onclick = closeDoc;
    $('pdfPrev').onclick = () => { const w = document.querySelector('.pdf-pagewrap'); if (w) w.scrollIntoView(); };
    $('pdfNext').onclick = () => { const ws = document.querySelectorAll('.pdf-pagewrap'); if (ws.length) ws[ws.length-1].scrollIntoView(); };
    $('pdfZoomIn').onclick = () => zoomBy(0.15);
    $('pdfZoomOut').onclick = () => zoomBy(-0.15);
    $('pdfMergeBtn').onclick = mergePdfs;
    $('pdfSplitBtn').onclick = splitPdf;
    $('pdfRotateBtn').onclick = () => {
      // rotate the first visible page as a quick action; full per-page via page bar
      if (!pdfBytes) { UI.toast('Open a PDF first', 'warn'); return; }
      rotatePage(0);
    };
    $('pdfDeleteBtn').onclick = () => {
      if (!pdfBytes) { UI.toast('Open a PDF first', 'warn'); return; }
      UI.prompt({ title: 'Delete page', label: 'Page #', value: '1' }).then(n => {
        if (n) { const p = +n; if (p >= 1 && p <= pageOrder.length) deletePage(p - 1); }
      });
    };
    $('pdfTextBtn').onclick = addTextOverlay;
    $('pdfSignBtn').onclick = signDraw;
    $('pdfSaveBtn').onclick = saveDoc;
    if ($('pdfUndoBtn')) $('pdfUndoBtn').onclick = doUndo;
    if ($('pdfRedoBtn')) $('pdfRedoBtn').onclick = doRedo;
  }

  function boot() {
    wire();
    History.registerCurrentSnapshot('pdf',
      () => ({ pageOrder: [...pageOrder], overlays: Util.deepClone(overlays) }),
      (s) => {
        pageOrder.length = 0; pageOrder.push(...s.pageOrder);
        for (const k of Object.keys(overlays)) delete overlays[k];
        Object.assign(overlays, Util.deepClone(s.overlays));
        renderAll(); updatePageInfo();
      });
    History.reset('pdf');
    setControlsVisible(false);
  }

  return { boot, undo: doUndo, redo: doRedo };
})();
