/* ==========================================================================
   impress.js — Impress: slide editor with text boxes, shapes, images;
   drag/resize, per-slide editing, present mode (fullscreen), and export
   to .pptx (PptxGenJS) and .pdf (jsPDF).
   ========================================================================== */

const Impress = (() => {
  // Each slide: { bg: '#ffffff', elements: [...] }
  // element: { id, kind:'text'|'rect'|'ellipse'|'image', x,y,w,h (in % of slide),
  //            text?, fontSize?, color?, fill?, bold?, italic?, align?, dataUrl? }
  let slides = [];
  let current = 0;
  let selected = null;
  let seq = 1;
  let dirty = false;
  let autosaveTimer = null;

  // Slide canvas dimensions (16:9). The on-screen canvas keeps this aspect.
  const SLIDE_W = 960;
  const SLIDE_H = 540;

  const $ = (id) => document.getElementById(id);

  function boot() {
    injectStyles();
    buildToolbar();
    buildLayout();
    wireCanvas();
    // Restore
    Storage.load('impress:deck').then(saved => {
      if (saved && Array.isArray(saved.slides) && saved.slides.length) {
        slides = saved.slides;
        current = 0;
        renderSlideList();
        renderCanvas();
      } else {
        newDeck();
      }
    }).catch(() => newDeck());
  }

  function newDeck() {
    slides = [{
      bg: '#ffffff',
      elements: [{
        id: 'e' + (seq++),
        kind: 'text',
        x: 10, y: 40, w: 80, h: 15,
        text: 'Click to edit title',
        fontSize: 40, bold: true, color: '#1a3a6c', align: 'center',
      }],
    }];
    current = 0;
    selected = null;
    renderSlideList();
    renderCanvas();
    markDirty();
  }

  // ---------- Layout ----------
  function buildLayout() {
    const root = $('impressContent');
    root.innerHTML = `
      <div class="impress-sidebar" id="impSidebar">
        <div class="impress-sidehead">
          <span>Slides</span>
          <button class="tb-btn icon-only" id="impAddSlide" title="Add slide">＋</button>
        </div>
        <div class="impress-slidelist" id="impSlideList"></div>
      </div>
      <div class="impress-stage" id="impStage">
        <div class="impress-canvas" id="impCanvas" tabindex="0"></div>
      </div>
      <div class="impress-inspector" id="impInspector"></div>
    `;
    $('impAddSlide').onclick = addSlide;
    $('impSlideList').addEventListener('click', (e) => {
      const it = e.target.closest('.impress-slideitem');
      if (!it) return;
      if (e.target.classList.contains('dup')) { duplicateSlide(+it.dataset.idx); return; }
      if (e.target.classList.contains('del')) { deleteSlide(+it.dataset.idx); return; }
      if (e.target.classList.contains('up'))  { moveSlide(+it.dataset.idx, -1); return; }
      if (e.target.classList.contains('down')){ moveSlide(+it.dataset.idx, 1); return; }
      current = +it.dataset.idx; selected = null;
      renderSlideList(); renderCanvas();
    });
  }

  function buildToolbar() {
    const tb = $('impressToolbar');
    tb.innerHTML = '';
    const btn = (label, fn, title, primary=false) => {
      const b = document.createElement('button');
      b.className = 'tb-btn' + (primary?' primary':'');
      b.innerHTML = label; b.title = title || ''; b.onclick = fn; return b;
    };
    const sep = () => { const s=document.createElement('span'); s.className='tb-sep'; return s; };

    tb.appendChild(btn('＋ Slide', addSlide, 'Add slide'));
    tb.appendChild(btn('Duplicate', () => duplicateSlide(current), 'Duplicate current'));
    tb.appendChild(sep());
    // Insert element buttons
    tb.appendChild(btn('📝 Text', () => addElement('text'), 'Add text box'));
    tb.appendChild(btn('▭ Rect', () => addElement('rect'), 'Add rectangle'));
    tb.appendChild(btn('◯ Ellipse', () => addElement('ellipse'), 'Add ellipse'));
    tb.appendChild(btn('🖼️ Image', addImage, 'Add image'));
    tb.appendChild(sep());
    // Background
    const bg = document.createElement('input');
    bg.type = 'color'; bg.value = '#ffffff'; bg.title = 'Slide background';
    bg.style.width = '34px'; bg.style.height = '30px'; bg.style.padding = '0'; bg.style.border = '1px solid var(--border)'; bg.style.borderRadius = '6px';
    bg.onchange = () => { slides[current].bg = bg.value; renderCanvas(); renderSlideList(); markDirty(); };
    tb.appendChild(bg);
    tb.appendChild(sep());
    tb.appendChild(btn('▶ Present', startPresent, 'Present (Esc to exit)', true));
    tb.appendChild(btn('💾 Export ▾', exportMenu, 'Export'));
  }

  // ---------- Slide list (thumbnails) ----------
  function renderSlideList() {
    const list = $('impSlideList');
    list.innerHTML = '';
    slides.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'impress-slideitem' + (i === current ? ' active' : '');
      item.dataset.idx = i;
      item.innerHTML = `
        <div class="impress-thumb" style="background:${s.bg || '#fff'}"></div>
        <div class="impress-slidemeta">
          <span class="num">${i + 1}</span>
          <span style="flex:1"></span>
          <button class="up" title="Move up">▲</button>
          <button class="down" title="Move down">▼</button>
          <button class="dup" title="Duplicate">⧉</button>
          <button class="del" title="Delete">🗑</button>
        </div>`;
      // Render thumbnail content
      const thumb = item.querySelector('.impress-thumb');
      thumb.style.position = 'relative';
      s.elements.forEach(el => thumb.appendChild(thumbEl(el)));
      list.appendChild(item);
    });
    // Update bg color picker
    const bg = $('impressToolbar') && $('impressToolbar').querySelector('input[type=color]');
    if (bg && slides[current]) bg.value = slides[current].bg || '#ffffff';
  }
  function thumbEl(el) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${el.h}%;`;
    if (el.kind === 'text') {
      d.style.display = 'flex'; d.style.alignItems = 'center'; d.style.justifyContent = el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start';
      d.style.color = el.color || '#000'; d.style.fontWeight = el.bold ? '700' : '400';
      d.style.fontSize = Math.max(4, (el.fontSize || 18) / 6) + 'px';
      d.style.padding = '0 2px'; d.style.overflow = 'hidden'; d.style.whiteSpace = 'pre-wrap';
      d.textContent = el.text || '';
    } else if (el.kind === 'rect') {
      d.style.background = el.fill || '#4a90e2'; d.style.border = '1px solid rgba(0,0,0,.1)';
    } else if (el.kind === 'ellipse') {
      d.style.background = el.fill || '#4a90e2'; d.style.borderRadius = '50%';
    } else if (el.kind === 'image' && el.dataUrl) {
      d.style.background = `url(${el.dataUrl}) center/cover`;
    }
    return d;
  }

  // ---------- Canvas ----------
  function renderCanvas() {
    const c = $('impCanvas');
    c.innerHTML = '';
    const slide = slides[current];
    c.style.background = slide.bg || '#ffffff';
    slide.elements.forEach(el => {
      const node = makeElementNode(el);
      c.appendChild(node);
    });
    renderInspector();
  }

  function makeElementNode(el) {
    const node = document.createElement('div');
    node.className = 'imp-el' + (selected === el.id ? ' selected' : '');
    node.dataset.id = el.id;
    node.style.left = el.x + '%';
    node.style.top = el.y + '%';
    node.style.width = el.w + '%';
    node.style.height = el.h + '%';
    if (el.kind === 'text') {
      node.classList.add('imp-text');
      node.style.color = el.color || '#000';
      node.style.fontWeight = el.bold ? '700' : '400';
      node.style.fontStyle = el.italic ? 'italic' : '';
      node.style.fontSize = (el.fontSize || 18) + 'px';
      node.style.textAlign = el.align || 'left';
      node.style.display = 'flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start';
      node.style.whiteSpace = 'pre-wrap';
      node.style.overflow = 'hidden';
      node.textContent = el.text || '';
      node.title = 'Double-click to edit text';
    } else if (el.kind === 'rect') {
      node.classList.add('imp-shape');
      node.style.background = el.fill || '#4a90e2';
    } else if (el.kind === 'ellipse') {
      node.classList.add('imp-shape');
      node.style.background = el.fill || '#4a90e2';
      node.style.borderRadius = '50%';
    } else if (el.kind === 'image') {
      node.classList.add('imp-image');
      if (el.dataUrl) node.style.background = `url(${el.dataUrl}) center/cover`;
    }
    if (selected === el.id) {
      // Resize handle (bottom-right)
      const rh = document.createElement('div');
      rh.className = 'imp-resize';
      node.appendChild(rh);
    }
    return node;
  }

  function wireCanvas() {
    const c = $('impCanvas');
    let drag = null;

    c.addEventListener('mousedown', (e) => {
      const elNode = e.target.closest('.imp-el');
      if (elNode) {
        const el = slides[current].elements.find(x => x.id === elNode.dataset.id);
        if (!el) return;
        // Click on resize handle?
        if (e.target.classList.contains('imp-resize')) {
          const rect = c.getBoundingClientRect();
          drag = { mode: 'resize', el, rect };
        } else {
          selected = el.id;
          const rect = c.getBoundingClientRect();
          drag = {
            mode: 'move', el, rect,
            startMx: e.clientX, startMy: e.clientY,
            startEx: el.x, startEy: el.y,
          };
          renderCanvas();
        }
        e.preventDefault();
      } else {
        // Click on empty canvas — deselect
        selected = null;
        renderCanvas();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const { el, rect } = drag;
      if (drag.mode === 'move') {
        const dxPct = (e.clientX - drag.startMx) / rect.width * 100;
        const dyPct = (e.clientY - drag.startMy) / rect.height * 100;
        el.x = Math.max(-50, Math.min(100, drag.startEx + dxPct));
        el.y = Math.max(-50, Math.min(100, drag.startEy + dyPct));
      } else if (drag.mode === 'resize') {
        const wPct = (e.clientX - (rect.left + el.x/100*rect.width)) / rect.width * 100;
        const hPct = (e.clientY - (rect.top + el.y/100*rect.height)) / rect.height * 100;
        el.w = Math.max(2, wPct);
        el.h = Math.max(2, hPct);
      }
      // live update the node
      const node = c.querySelector(`.imp-el[data-id="${el.id}"]`);
      if (node) {
        node.style.left = el.x + '%';
        node.style.top = el.y + '%';
        node.style.width = el.w + '%';
        node.style.height = el.h + '%';
      }
    });
    document.addEventListener('mouseup', () => {
      if (drag) { drag = null; markDirty(); renderSlideList(); renderInspector(); }
    });

    // Double-click to edit text
    c.addEventListener('dblclick', (e) => {
      const elNode = e.target.closest('.imp-el');
      if (!elNode) return;
      const el = slides[current].elements.find(x => x.id === elNode.dataset.id);
      if (!el) return;
      if (el.kind === 'text') editText(el);
    });

    // Keyboard: delete selected, arrow keys nudge
    c.addEventListener('keydown', (e) => {
      if (!selected) return;
      const el = slides[current].elements.find(x => x.id === selected);
      if (!el) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        slides[current].elements = slides[current].elements.filter(x => x.id !== selected);
        selected = null; renderCanvas(); renderSlideList(); markDirty();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const d = e.shiftKey ? 5 : 1;
        if (e.key === 'ArrowLeft') el.x -= d;
        if (e.key === 'ArrowRight') el.x += d;
        if (e.key === 'ArrowUp') el.y -= d;
        if (e.key === 'ArrowDown') el.y += d;
        renderCanvas(); markDirty();
      }
    });
  }

  function editText(el) {
    const v = prompt_full('Edit text', el.text || '', 'Type text (Ctrl+Enter for newline)');
    if (v === null) return;
    el.text = v;
    renderCanvas(); renderSlideList(); markDirty();
  }
  // A multiline text editor dialog
  function prompt_full(title, value, placeholder) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      const ta = document.createElement('textarea');
      ta.value = value; ta.placeholder = placeholder || '';
      ta.style.cssText = 'width:420px;max-width:80vw;height:140px;font-family:inherit;font-size:13px;padding:8px;border:1px solid var(--border);border-radius:6px;resize:vertical;background:var(--surface);color:var(--text)';
      body.appendChild(ta);
      const d = UI.dialog({ title, body, okText: 'OK', cancelText: 'Cancel',
        onOk: () => resolve(ta.value), onCancel: () => resolve(null) });
      ta.focus();
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); d.close(); resolve(ta.value); }
        if (e.key === 'Escape') { d.close(); resolve(null); }
      });
    });
  }

  // ---------- Inspector (right panel) ----------
  function renderInspector() {
    const ins = $('impInspector');
    if (!selected) {
      ins.innerHTML = `<div class="imp-noinspect">No element selected.<br><br>Click an element to edit it, or use the toolbar to add text, shapes, or images.</div>`;
      return;
    }
    const el = slides[current].elements.find(x => x.id === selected);
    if (!el) { selected = null; renderInspector(); return; }
    ins.innerHTML = `
      <div class="imp-inspecthead">${el.kind.toUpperCase()}</div>
      <div class="imp-field"><label>Left</label><input type="number" id="iX" value="${el.x.toFixed(1)}"></div>
      <div class="imp-field"><label>Top</label><input type="number" id="iY" value="${el.y.toFixed(1)}"></div>
      <div class="imp-field"><label>Width</label><input type="number" id="iW" value="${el.w.toFixed(1)}"></div>
      <div class="imp-field"><label>Height</label><input type="number" id="iH" value="${el.h.toFixed(1)}"></div>
      ${el.kind === 'text' ? `
        <div class="imp-field"><label>Font size</label><input type="number" id="iFS" value="${el.fontSize || 18}"></div>
        <div class="imp-field"><label>Color</label><input type="color" id="iCol" value="${el.color || '#000000'}"></div>
        <div class="imp-field"><label>Align</label><select id="iAlign">
          <option value="left" ${el.align==='left'?'selected':''}>Left</option>
          <option value="center" ${el.align==='center'?'selected':''}>Center</option>
          <option value="right" ${el.align==='right'?'selected':''}>Right</option>
        </select></div>
        <div class="imp-field"><label>Style</label>
          <label class="imp-check"><input type="checkbox" id="iBold" ${el.bold?'checked':''}> Bold</label>
          <label class="imp-check"><input type="checkbox" id="iItalic" ${el.italic?'checked':''}> Italic</label>
        </div>
        <button class="tb-btn" id="iEditText" style="width:100%">✏ Edit text</button>
      ` : ''}
      ${(el.kind === 'rect' || el.kind === 'ellipse') ? `
        <div class="imp-field"><label>Fill</label><input type="color" id="iFill" value="${el.fill || '#4a90e2'}"></div>
      ` : ''}
      <button class="tb-btn" id="iDelete" style="width:100%;color:var(--danger)">🗑 Delete element</button>
    `;
    const bindNum = (id, prop) => { const e = ins.querySelector(id); if (e) e.onchange = () => { el[prop] = +e.value; renderCanvas(); renderSlideList(); markDirty(); }; };
    bindNum('#iX','x'); bindNum('#iY','y'); bindNum('#iW','w'); bindNum('#iH','h');
    const iFS = ins.querySelector('#iFS'); if (iFS) iFS.onchange = () => { el.fontSize = +iFS.value; renderCanvas(); markDirty(); };
    const iCol = ins.querySelector('#iCol'); if (iCol) iCol.oninput = () => { el.color = iCol.value; renderCanvas(); renderSlideList(); markDirty(); };
    const iAlign = ins.querySelector('#iAlign'); if (iAlign) iAlign.onchange = () => { el.align = iAlign.value; renderCanvas(); markDirty(); };
    const iBold = ins.querySelector('#iBold'); if (iBold) iBold.onchange = () => { el.bold = iBold.checked; renderCanvas(); markDirty(); };
    const iItalic = ins.querySelector('#iItalic'); if (iItalic) iItalic.onchange = () => { el.italic = iItalic.checked; renderCanvas(); markDirty(); };
    const iFill = ins.querySelector('#iFill'); if (iFill) iFill.oninput = () => { el.fill = iFill.value; renderCanvas(); renderSlideList(); markDirty(); };
    const iEditText = ins.querySelector('#iEditText'); if (iEditText) iEditText.onclick = () => editText(el);
    ins.querySelector('#iDelete').onclick = () => {
      slides[current].elements = slides[current].elements.filter(x => x.id !== selected);
      selected = null; renderCanvas(); renderSlideList(); markDirty();
    };
  }

  // ---------- Add elements ----------
  function addElement(kind) {
    const el = { id: 'e' + (seq++), kind, x: 25, y: 25, w: 50, h: 25 };
    if (kind === 'text') { el.text = 'New text'; el.fontSize = 24; el.color = '#222'; el.align = 'left'; }
    if (kind === 'rect' || kind === 'ellipse') el.fill = '#4a90e2';
    slides[current].elements.push(el);
    selected = el.id;
    renderCanvas(); renderSlideList(); markDirty();
  }
  async function addImage() {
    try {
      const f = await FS.open({ accept: [{ description: 'Image', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg','.jpeg'] } }] });
      const b64 = bytesToBase64(f.bytes, f.name);
      const el = { id: 'e' + (seq++), kind: 'image', x: 20, y: 20, w: 60, h: 50, dataUrl: b64 };
      slides[current].elements.push(el);
      selected = el.id;
      renderCanvas(); renderSlideList(); markDirty();
    } catch (e) { if (e.name !== 'AbortError') UI.toast('Image failed: ' + e.message, 'error'); }
  }
  function bytesToBase64(bytes, name) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const ext = (name.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return 'data:' + mime + ';base64,' + btoa(bin);
  }

  // ---------- Slide operations ----------
  function addSlide() {
    slides.splice(current + 1, 0, { bg: '#ffffff', elements: [] });
    current = current + 1;
    selected = null;
    renderSlideList(); renderCanvas(); markDirty();
  }
  function duplicateSlide(i) {
    const copy = JSON.parse(JSON.stringify(slides[i]));
    copy.elements.forEach(e => e.id = 'e' + (seq++));
    slides.splice(i + 1, 0, copy);
    current = i + 1;
    renderSlideList(); renderCanvas(); markDirty();
  }
  function deleteSlide(i) {
    if (slides.length <= 1) { UI.toast('Need at least one slide', 'warn'); return; }
    slides.splice(i, 1);
    if (current >= slides.length) current = slides.length - 1;
    selected = null;
    renderSlideList(); renderCanvas(); markDirty();
  }
  function moveSlide(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= slides.length) return;
    [slides[i], slides[j]] = [slides[j], slides[i]];
    if (current === i) current = j; else if (current === j) current = i;
    renderSlideList(); renderCanvas(); markDirty();
  }

  // ---------- Present ----------
  function startPresent() {
    const overlay = document.createElement('div');
    overlay.id = 'impPresent';
    overlay.innerHTML = `<div class="imp-pres-slide"></div>
      <div class="imp-pres-controls">
        <button id="presPrev">◀</button>
        <span id="presCount"></span>
        <button id="presNext">▶</button>
        <button id="presExit">✕ Exit</button>
      </div>`;
    document.body.appendChild(overlay);
    let idx = current;
    const slideEl = overlay.querySelector('.imp-pres-slide');
    const countEl = overlay.querySelector('#presCount');
    function show() {
      const s = slides[idx];
      slideEl.style.background = s.bg || '#fff';
      slideEl.innerHTML = '';
      s.elements.forEach(el => slideEl.appendChild(presentEl(el)));
      countEl.textContent = (idx + 1) + ' / ' + slides.length;
    }
    function nav(d) { idx = Math.max(0, Math.min(slides.length - 1, idx + d)); show(); }
    overlay.querySelector('#presPrev').onclick = () => nav(-1);
    overlay.querySelector('#presNext').onclick = () => nav(1);
    overlay.querySelector('#presExit').onclick = close;
    function onKey(e) {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') nav(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') nav(-1);
      else if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (overlay.requestFullscreen && document.fullscreenElement) document.exitFullscreen().catch(()=>{});
    }
    show();
    if (overlay.requestFullscreen) overlay.requestFullscreen().catch(()=>{});
  }
  function presentEl(el) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${el.h}%;`;
    if (el.kind === 'text') {
      d.style.display = 'flex'; d.style.alignItems = 'center';
      d.style.justifyContent = el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start';
      d.style.color = el.color || '#000'; d.style.fontWeight = el.bold ? '700' : '400';
      d.style.fontStyle = el.italic ? 'italic' : '';
      d.style.fontSize = ((el.fontSize || 18) * 2) + 'px';
      d.style.whiteSpace = 'pre-wrap'; d.style.padding = '0 8px';
      d.textContent = el.text || '';
    } else if (el.kind === 'rect') {
      d.style.background = el.fill || '#4a90e2';
    } else if (el.kind === 'ellipse') {
      d.style.background = el.fill || '#4a90e2'; d.style.borderRadius = '50%';
    } else if (el.kind === 'image' && el.dataUrl) {
      d.style.background = `url(${el.dataUrl}) center/cover`;
    }
    return d;
  }

  // ---------- Export ----------
  function exportMenu() {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:240px';
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="tb-btn" data-x="pptx" style="justify-content:flex-start">📽️ PowerPoint (.pptx)</button>
        <button class="tb-btn" data-x="pdf"  style="justify-content:flex-start">📕 PDF (.pdf)</button>
      </div>`;
    const d = UI.dialog({ title: 'Export presentation', body, okText: 'Close', cancelText: null });
    d.el.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); doExport(b.dataset.x); });
  }
  async function doExport(fmt) {
    if (fmt === 'pptx') return exportPptx();
    if (fmt === 'pdf')  return exportPdf();
  }
  async function exportPptx() {
    try {
      if (typeof window.PptxGenJS === 'undefined') { UI.toast('pptx library not loaded', 'error'); return; }
      const P = window.PptxGenJS;
      const p = new P();
      // 13.33 x 7.5 inches = 16:9 widescreen
      p.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
      p.layout = 'WIDE';
      const IN = (pct) => pct / 100 * 13.333;
      const INH = (pct) => pct / 100 * 7.5;
      for (const s of slides) {
        const slide = p.addSlide();
        slide.background = { color: hexNo(s.bg || '#ffffff') };
        for (const el of s.elements) {
          const opts = { x: IN(el.x), y: INH(el.y), w: IN(el.w), h: INH(el.h) };
          if (el.kind === 'text') {
            Object.assign(opts, {
              fontSize: (el.fontSize || 18) * 1.0,
              bold: !!el.bold, italic: !!el.italic,
              color: hexNo(el.color || '#000000'),
              align: el.align || 'left',
              valign: 'middle',
              wrap: true,
            });
            slide.addText(el.text || '', opts);
          } else if (el.kind === 'rect') {
            Object.assign(opts, { fill: { color: hexNo(el.fill || '#4a90e2') }, line: { color: hexNo(el.fill || '#4a90e2') } });
            slide.addShape(p.ShapeType.rect, opts);
          } else if (el.kind === 'ellipse') {
            Object.assign(opts, { fill: { color: hexNo(el.fill || '#4a90e2') }, line: { color: hexNo(el.fill || '#4a90e2') } });
            slide.addShape(p.ShapeType.ellipse, opts);
          } else if (el.kind === 'image' && el.dataUrl) {
            try { slide.addImage({ data: el.dataUrl, ...opts }); } catch (e) { /* ignore */ }
          }
        }
      }
      const b64 = await p.write({ outputType: 'base64' });
      const bytes = base64ToBytes(b64);
      await FS.save({ name: 'presentation.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes, handle: null });
      UI.toast('Exported presentation.pptx', 'success');
    } catch (e) {
      UI.toast('PPTX export failed: ' + (e.message || e), 'error');
    }
  }
  async function exportPdf() {
    try {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [SLIDE_W, SLIDE_H] });
      slides.forEach((s, idx) => {
        if (idx > 0) pdf.addPage([SLIDE_W, SLIDE_H], 'landscape');
        // background
        pdf.setFillColor(...hexToRgb(s.bg || '#ffffff'));
        pdf.rect(0, 0, SLIDE_W, SLIDE_H, 'F');
        for (const el of s.elements) {
          const x = el.x/100*SLIDE_W, y = el.y/100*SLIDE_H, w = el.w/100*SLIDE_W, h = el.h/100*SLIDE_H;
          if (el.kind === 'text') {
            pdf.setFontSize(el.fontSize || 18);
            pdf.setFont('helvetica', (el.bold?'bold':'') + (el.italic?'italic':'') || 'normal');
            pdf.setTextColor(...hexToRgb(el.color || '#000000'));
            const lines = pdf.splitTextToSize(el.text || '', w);
            // vertical centering-ish
            pdf.text(lines, el.align === 'center' ? x + w/2 : el.align === 'right' ? x + w : x,
                     y + h/2, { align: el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left', baseline: 'middle' });
          } else if (el.kind === 'rect') {
            pdf.setFillColor(...hexToRgb(el.fill || '#4a90e2'));
            pdf.rect(x, y, w, h, 'F');
          } else if (el.kind === 'ellipse') {
            pdf.setFillColor(...hexToRgb(el.fill || '#4a90e2'));
            pdf.ellipse(x + w/2, y + h/2, w/2, h/2, 'F');
          } else if (el.kind === 'image' && el.dataUrl) {
            try {
              const fmt = el.dataUrl.indexOf('image/png') >= 0 ? 'PNG' : 'JPEG';
              pdf.addImage(el.dataUrl, fmt, x, y, w, h);
            } catch (e) { /* ignore */ }
          }
        }
      });
      const ab = pdf.output('arraybuffer');
      await FS.save({ name: 'presentation.pdf', mime: 'application/pdf', bytes: new Uint8Array(ab), handle: null });
      UI.toast('Exported presentation.pdf', 'success');
    } catch (e) {
      UI.toast('PDF export failed: ' + (e.message || e), 'error');
    }
  }
  function hexNo(s) { return (s || '').replace('#','').toUpperCase(); }
  function hexToRgb(s) {
    const h = (s || '#000').replace('#','');
    return [parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16)];
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---------- Dirty + autosave ----------
  function markDirty() {
    dirty = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try { await Storage.save('impress:deck', { slides }); dirty = false; } catch (e) { /* ignore */ }
    }, 800);
  }

  // ---------- Styles ----------
  function injectStyles() {
    if (document.getElementById('impress-styles')) return;
    const s = document.createElement('style');
    s.id = 'impress-styles';
    s.textContent = `
      .impress-wrap { display: flex; flex: 1; min-height: 0; }
      .impress-sidebar {
        width: 180px; flex-shrink: 0;
        background: var(--surface-2);
        border-right: 1px solid var(--border);
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      .impress-sidehead {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px;
        font-size: 12px; font-weight: 600; color: var(--text-dim);
        border-bottom: 1px solid var(--border);
        text-transform: uppercase; letter-spacing: .5px;
      }
      .impress-slidelist { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
      .impress-slideitem {
        background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
        padding: 4px; cursor: pointer; transition: border-color .12s;
      }
      .impress-slideitem:hover { border-color: var(--accent); }
      .impress-slideitem.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
      .impress-thumb {
        width: 100%; aspect-ratio: 16/9;
        background: #fff; border: 1px solid var(--border-soft); border-radius: 3px;
        position: relative; overflow: hidden;
      }
      .impress-slidemeta {
        display: flex; align-items: center; gap: 2px; margin-top: 4px; font-size: 11px;
      }
      .impress-slidemeta .num { font-weight: 600; color: var(--text-dim); padding: 0 4px; }
      .impress-slidemeta button {
        background: transparent; border: 0; color: var(--text-faint); cursor: pointer;
        font-size: 11px; padding: 2px 3px; border-radius: 3px;
      }
      .impress-slidemeta button:hover { background: var(--surface-3); color: var(--text); }
      .impress-slidemeta .del:hover { color: var(--danger); }

      .impress-stage {
        flex: 1; min-width: 0; padding: 24px;
        display: grid; place-items: center;
        background: var(--bg);
        overflow: auto;
      }
      .impress-canvas {
        width: min(960px, 100%); aspect-ratio: 16/9;
        background: #fff; box-shadow: var(--shadow);
        border-radius: 3px; position: relative;
        outline: none;
      }
      .imp-el {
        position: absolute; cursor: move; user-select: none;
        box-sizing: border-box;
      }
      .imp-el.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
      .imp-text { padding: 4px 6px; }
      .imp-shape { border: 1px solid rgba(0,0,0,.06); }
      .imp-resize {
        position: absolute; right: -6px; bottom: -6px;
        width: 12px; height: 12px;
        background: var(--accent); border: 2px solid #fff; border-radius: 50%;
        cursor: nwse-resize;
      }

      .impress-inspector {
        width: 220px; flex-shrink: 0;
        background: var(--surface);
        border-left: 1px solid var(--border);
        padding: 12px; overflow-y: auto;
      }
      .imp-noinspect { color: var(--text-dim); font-size: 13px; line-height: 1.5; padding: 20px 4px; }
      .imp-inspecthead {
        font-size: 11px; font-weight: 600; letter-spacing: .5px;
        color: var(--text-dim); text-transform: uppercase; margin-bottom: 10px;
        padding-bottom: 6px; border-bottom: 1px solid var(--border-soft);
      }
      .imp-field { margin-bottom: 8px; }
      .imp-field label { display: block; font-size: 11px; color: var(--text-dim); margin-bottom: 3px; }
      .imp-field input, .imp-field select {
        width: 100%; height: 28px; padding: 0 6px;
        border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text);
        font-size: 12px;
      }
      .imp-field input[type=color] { padding: 0; height: 30px; }
      .imp-check { font-size: 12px; color: var(--text-dim); margin-right: 10px; cursor: pointer; }
      .imp-check input { margin-right: 4px; }

      #impPresent {
        position: fixed; inset: 0; z-index: 5000;
        background: #000; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
      }
      .imp-pres-slide {
        position: relative;
        width: min(100vw, calc(100vh * 16/9));
        height: min(100vh, calc(100vw * 9/16));
        background: #fff; overflow: hidden;
      }
      .imp-pres-controls {
        position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 12px;
        background: rgba(0,0,0,.6); color: #fff;
        padding: 8px 16px; border-radius: 24px; font-size: 14px;
      }
      .imp-pres-controls button {
        background: rgba(255,255,255,.15); border: 0; color: #fff;
        width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-size: 14px;
      }
      .imp-pres-controls button:hover { background: rgba(255,255,255,.3); }
    `;
    document.head.appendChild(s);
  }

  function onActivate() {
    setTimeout(() => $('impCanvas') && $('impCanvas').focus(), 0);
  }

  return { boot, onActivate };
})();
