/* ==========================================================================
   impress.js — Impress: slide editor with text boxes, shapes, images;
   drag/resize, per-slide editing, present mode (fullscreen), and export
   to .pptx (PptxGenJS) and .pdf (jsPDF).
   ========================================================================== */

const Impress = (() => {
  // Each slide: { bg: '#ffffff', elements: [...] }
  // element: { id, kind:'text'|'rect'|'ellipse'|'image', x,y,w,h (in % of slide),
  //            text?, fontSize?, fontFamily?, color?, fill?, bold?, italic?, align?, dataUrl? }
  // Multi-deck: each deck owns { id, name, slides, current }. The live
  // `slides`/`current` bindings point at the active deck; unlike Calc, Impress
  // REASSIGNS slides (newDeck, imports…), so decks are re-synced on switch.
  const decks = [];
  let activeDeckId = null;
  let deckSeq = 1;
  const closedDecks = [];      // recently closed, for Ctrl+Shift+T reopen
  let tabs = null;
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

  function activeDeck() { return decks.find(d => d.id === activeDeckId); }
  function deckKey() { return 'impress:' + activeDeckId; }
  function isFreshSlides(ss) {
    return ss.length === 1 &&
      ss[0].elements && ss[0].elements.length === 1 &&
      ss[0].elements[0].text === 'Click to edit title';
  }

  function boot() {
    injectStyles();
    buildToolbar();
    buildLayout();
    wireCanvas();
    // Restore the last session's open decks. Per-deck history keys are
    // initialized lazily by activateDeck().
    tabs = Tabs.create({
      mount: $('impressTabs'),
      onActivate: activateDeck,
      onClose: closeDeck,
      onNew: newPresentation,
      onReorder: reorderDecks,
      newTitle: 'New presentation',
    });
    Storage.load('impress:decks').then(saved => {
      if (saved && Array.isArray(saved.decks) && saved.decks.length) {
        for (const d of saved.decks) {
          decks.push({
            id: d.id || ('d' + (decks.length + 1)),
            name: d.name || 'Deck',
            slides: (Array.isArray(d.slides) && d.slides.length) ? d.slides : freshDeckSlides(),
            current: d.current || 0,
          });
        }
        deckSeq = decks.length + 1;
        activateDeck(saved.active && decks.some(d => d.id === saved.active) ? saved.active : decks[0].id);
      } else {
        // Migrate the pre-tabs single-deck autosave (v1.2.x).
        Storage.load('impress:deck').then(legacy => {
          if (legacy && Array.isArray(legacy.slides) && legacy.slides.length) {
            addDeck({ slides: legacy.slides });
          } else {
            addDeck();
          }
        }).catch(() => { if (!decks.length) addDeck(); });
      }
    }).catch(() => { if (!decks.length) addDeck(); });
  }

  function freshDeckSlides() {
    return [{
      bg: '#ffffff',
      elements: [{
        id: 'e' + (seq++),
        kind: 'text',
        x: 10, y: 40, w: 80, h: 15,
        text: 'Click to edit title',
        fontSize: 40, bold: true, color: '#1a3a6c', align: 'center',
      }],
    }];
  }

  function newDeck() {
    slides = freshDeckSlides();
    current = 0;
    selected = null;
    renderSlideList();
    renderCanvas();
    markDirty();
  }

  // Start a fresh presentation in a new tab (nothing is discarded).
  function newPresentation() {
    addDeck();
  }

  function addDeckRaw({ name = null, slides: sl = null } = {}) {
    const n = deckSeq++;
    const id = 'd' + n;
    if (!name) name = 'Deck-' + n;
    const deck = { id, name, slides: sl || freshDeckSlides(), current: 0 };
    decks.push(deck);
    return deck;
  }
  function addDeck(opts) {
    const d = addDeckRaw(opts);
    activateDeck(d.id);
    markDirty();   // persist the new tab in the session manifest soon
    return d;
  }

  function activateDeck(id) {
    if (id === activeDeckId) { renderTabs(); return; }
    const cur = activeDeck();
    if (cur) { cur.slides = slides; cur.current = current; }
    activeDeckId = id;
    const d = activeDeck();
    slides = d.slides; current = d.current || 0;
    selected = null;
    const key = 'impress:' + id;
    if (!d.historyReady) {
      History.reset(key);
      History.registerCurrentSnapshot(key,
        () => ({ slides: Util.deepClone(slides), current, selected }),
        (s) => { slides = s.slides; current = s.current; selected = s.selected; renderSlideList(); renderCanvas(); });
      d.historyReady = true;
    }
    renderSlideList();
    renderCanvas();
    renderTabs();
  }

  function closeDeck(id) {
    const i = decks.findIndex(d => d.id === id);
    if (i < 0) return;
    const d = decks[i];
    const live = d.id === activeDeckId ? slides : d.slides;
    const doClose = () => {
      // Park the closed deck for Ctrl+Shift+T reopen (live slides win: the
      // deck object's stored ref can be stale after in-place mutations).
      closedDecks.unshift({ id: d.id, name: d.name, slides: live, current: d.id === activeDeckId ? current : d.current });
      if (closedDecks.length > 10) closedDecks.length = 10;
      decks.splice(i, 1);
      if (activeDeckId === id) {
        activeDeckId = null;
        if (decks.length) activateDeck(decks[Math.max(0, i - 1)].id);
        else addDeck();
      } else {
        renderTabs();
      }
      markDirty();
    };
    if (!isFreshSlides(live)) {
      UI.confirm({ title: `Close ${d.name}?`, message: 'The deck contents will be lost.', okText: 'Close anyway', danger: true })
        .then(ok => { if (ok) doClose(); });
    } else {
      doClose();
    }
  }

  // Reopen the most recently closed deck (Ctrl+Shift+T).
  function reopenDeck() {
    if (!closedDecks.length) { UI.toast('No recently closed decks', 'info'); return; }
    const d = closedDecks.shift();
    decks.push({ id: d.id, name: d.name, slides: d.slides, current: d.current });
    activateDeck(d.id);
    markDirty();
    UI.toast(`Reopened ${d.name}`, 'success');
  }

  function renderTabs() {
    if (!tabs) return;
    tabs.render(decks.map(d => ({
      id: d.id, name: d.name,
      dirty: !isFreshSlides(d.id === activeDeckId ? slides : d.slides),
    })), activeDeckId);
  }

  // Drag-to-reorder callback from the shared tab strip.
  function reorderDecks(fromId, toId) {
    const from = decks.findIndex(d => d.id === fromId);
    const to = decks.findIndex(d => d.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = decks.splice(from, 1);
    decks.splice(to, 0, moved);
    renderTabs();
    markDirty();
  }

  // ---------- Layout ----------
  function buildLayout() {
    const root = $('impressContent');
    root.innerHTML = `
      <div id="impressTabs"></div>
      <div class="impress-row">
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
      </div>
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

    tb.appendChild(btn('＋ New', newPresentation, 'New presentation'));
    tb.appendChild(btn('📂 Open', openPresentation, 'Open .pptx or .json'));
    tb.appendChild(btn('＋ Slide', addSlide, 'Add slide'));
    tb.appendChild(btn('Duplicate', () => duplicateSlide(current), 'Duplicate current'));
    tb.appendChild(sep());
    tb.appendChild(btn('↶', doUndo, 'Undo (Ctrl+Z)'));
    tb.appendChild(btn('↷', doRedo, 'Redo (Ctrl+Y)'));
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
    tb.appendChild(btn('💾 Save', saveJson, 'Save deck (.json) — re-openable later'));
    tb.appendChild(btn('📥 Export ▾', exportMenu, 'Export to .pptx or .pdf'));
    tb.appendChild(btn('🖨️', printDoc, 'Print all slides'));
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
      d.style.fontFamily = el.fontFamily || '';
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
      node.style.fontFamily = el.fontFamily || '';
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
          drag = { mode: 'resize', el, rect, snapped: false };
        } else {
          selected = el.id;
          const rect = c.getBoundingClientRect();
          drag = {
            mode: 'move', el, rect,
            startMx: e.clientX, startMy: e.clientY,
            startEx: el.x, startEy: el.y,
            snapped: false,
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
      // Snapshot once at the first actual movement of this drag.
      if (!drag.snapped) { snapshot(); drag.snapped = true; }
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
    let nudgeCoalesce = 0;
    c.addEventListener('keydown', (e) => {
      if (!selected) return;
      const el = slides[current].elements.find(x => x.id === selected);
      if (!el) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        snapshot();
        slides[current].elements = slides[current].elements.filter(x => x.id !== selected);
        selected = null; renderCanvas(); renderSlideList(); markDirty();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        // Coalesce rapid arrow nudges into one undo entry (~800ms window).
        const now = Date.now();
        if (now - nudgeCoalesce > 800) { snapshot(); nudgeCoalesce = now; }
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
    snapshot();
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
        <div class="imp-field"><label>Font</label><select id="iFont">
          <option value="">Theme default</option>
          ${Fonts.options(el.fontFamily || '')}
        </select></div>
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
    const iFont = ins.querySelector('#iFont'); if (iFont) iFont.onchange = () => { el.fontFamily = iFont.value || undefined; renderCanvas(); renderSlideList(); markDirty(); };
    const iFS = ins.querySelector('#iFS'); if (iFS) iFS.onchange = () => { el.fontSize = +iFS.value; renderCanvas(); markDirty(); };
    const iCol = ins.querySelector('#iCol'); if (iCol) iCol.oninput = () => { el.color = iCol.value; renderCanvas(); renderSlideList(); markDirty(); };
    const iAlign = ins.querySelector('#iAlign'); if (iAlign) iAlign.onchange = () => { el.align = iAlign.value; renderCanvas(); markDirty(); };
    const iBold = ins.querySelector('#iBold'); if (iBold) iBold.onchange = () => { el.bold = iBold.checked; renderCanvas(); markDirty(); };
    const iItalic = ins.querySelector('#iItalic'); if (iItalic) iItalic.onchange = () => { el.italic = iItalic.checked; renderCanvas(); markDirty(); };
    const iFill = ins.querySelector('#iFill'); if (iFill) iFill.oninput = () => { el.fill = iFill.value; renderCanvas(); renderSlideList(); markDirty(); };
    const iEditText = ins.querySelector('#iEditText'); if (iEditText) iEditText.onclick = () => editText(el);
    ins.querySelector('#iDelete').onclick = () => {
      snapshot();
      slides[current].elements = slides[current].elements.filter(x => x.id !== selected);
      selected = null; renderCanvas(); renderSlideList(); markDirty();
    };
    // Snapshot once when any inspector input is focused, so a whole field edit
    // is a single undo entry regardless of which property changes.
    let insSnapped = false;
    ins.querySelectorAll('input, select').forEach(inp => {
      inp.addEventListener('focus', () => { if (!insSnapped) { snapshot(); insSnapped = true; } });
      inp.addEventListener('blur', () => { insSnapped = false; });
    });
  }

  // ---------- Add elements ----------
  function addElement(kind) {
    snapshot();
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
      const b64 = Util.bytesToBase64(f.bytes, f.name);
      snapshot();
      const el = { id: 'e' + (seq++), kind: 'image', x: 20, y: 20, w: 60, h: 50, dataUrl: b64 };
      slides[current].elements.push(el);
      selected = el.id;
      renderCanvas(); renderSlideList(); markDirty();
    } catch (e) { if (e.name !== 'AbortError') UI.toast('Image failed: ' + e.message, 'error'); }
  }

  // ---------- Open / import ----------
  // EMU (English Metric Units): 914400 per inch. Slide is 13.333" x 7.5" (16:9).
  const EMU_W = 12192000;   // 13.333 * 914400
  const EMU_H = 6858000;    // 7.5 * 914400
  const tag = (ns, local) => new RegExp('^[a-z]+:' + local + '$').test(ns);

  async function openPresentation() {
    try {
      const f = await FS.open({
        accept: [
          { description: 'Presentation', accept: {
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
            'application/json': ['.json'],
          } },
        ],
      });
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (ext === 'json') return openJson(f);
      if (ext === 'pptx') return openPptx(f);
      UI.toast('Unsupported file type', 'warn');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Open failed: ' + (e.message || e), 'error');
    }
  }

  // Load an opened deck into the pristine active tab, or a new tab.
  function openIntoDeck(name, sl) {
    seq = 1;
    sl.forEach(s => (s.elements || []).forEach(el => (el.id = 'e' + (seq++))));
    const cur = activeDeck();
    if (cur && isFreshSlides(slides)) {
      slides = sl; current = 0; selected = null;
      cur.slides = slides;
      cur.name = name;
      History.reset(deckKey());
      renderSlideList(); renderCanvas(); markDirty();
    } else {
      addDeck({ name, slides: sl });
    }
  }

  async function openJson(f) {
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.slides)) throw new Error('Not a PocketOffice deck');
      openIntoDeck(f.name.replace(/\.[^.]+$/, ''), data.slides);
      UI.toast(`Opened ${f.name} (${data.slides.length} slides)`, 'success');
    } catch (e) {
      UI.toast('Could not read deck: ' + (e.message || e), 'error');
    }
  }

  async function openPptx(f) {
    if (typeof window.JSZip === 'undefined') { UI.toast('JSZip not loaded', 'error'); return; }
    UI.toast(`Opening ${f.name}…`, 'info');
    try {
      const zip = await window.JSZip.loadAsync(f.bytes);
      // Find all slide XML files and sort by slide number.
      const slideFiles = Object.keys(zip.files)
        .filter(n => /ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
          const na = +a.match(/slide(\d+)\.xml/)[1];
          const nb = +b.match(/slide(\d+)\.xml/)[1];
          return na - nb;
        });
      if (!slideFiles.length) { UI.toast('No slides found in file', 'warn'); return; }

      // Build a relationship map for each slide (to resolve images).
      const slideRels = {};
      for (const sf of slideFiles) {
        const num = sf.match(/slide(\d+)\.xml/)[1];
        const relPath = `ppt/slides/_rels/slide${num}.xml.rels`;
        const relFile = zip.file(relPath);
        if (relFile) {
          const relXml = await relFile.async('string');
          const map = {};
          // Each Relationship: <Relationship Id="rId1" Target="media/image1.png"/>
          const re = /<Relationship\s+Id="([^"]+)"\s+Type="[^"]*"\s+Target="([^"]+)"/g;
          let m;
          while ((m = re.exec(relXml))) map[m[1]] = m[2];
          slideRels[num] = map;
        }
      }

      const parser = new DOMParser();
      const newSlides = [];
      for (const sf of slideFiles) {
        const xml = await zip.file(sf).async('string');
        const doc = parser.parseFromString(xml, 'application/xml');
        newSlides.push(parseSlide(doc, zip, slideRels[sf.match(/slide(\d+)/)[1]] || {}));
      }
      // Second pass: resolve image placeholders (need async reads).
      for (const s of newSlides) {
        for (const el of (s.elements || [])) {
          if (el.kind === 'image' && el._imgTarget) {
            try {
              const imgFile = zip.file(el._imgTarget);
              if (imgFile) {
                const bytes = new Uint8Array(await imgFile.async('uint8array'));
                const ext = (el._imgTarget.split('.').pop() || 'png').toLowerCase();
                el.dataUrl = Util.bytesToBase64(bytes, 'image.' + ext);
              }
            } catch (e) { /* skip unreadable image */ }
            delete el._imgTarget;
          }
        }
      }
      openIntoDeck(f.name.replace(/\.[^.]+$/, ''), newSlides);
      const skipped = newSlides.reduce((n, s) => n + (s.elements || []).filter(e => e._unsupported).length, 0);
      UI.toast(`Imported ${newSlides.length} slide${newSlides.length === 1 ? '' : 's'}${skipped ? ` (${skipped} item${skipped===1?'':'s'} skipped)` : ''}`, 'success');
    } catch (e) {
      UI.toast(`Could not read ${f.name}: ${e.message || e}`, 'error');
    }
  }

  function parseSlide(doc, zip, rels) {
    const slide = { bg: '#ffffff', elements: [] };
    // Manual walk of the namespaced XML (CSS selectors don't work well with namespaces).
    const find = (root, names) => {
      // names is an array of local-names; descend matching any-namespace.
      let node = root;
      for (const ln of names) {
        let next = null;
        for (const c of node.children) {
          if (c.localName === ln) { next = c; break; }
        }
        if (!next) return null;
        node = next;
      }
      return node;
    };
    const findAll = (root, ln) => {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.localName === ln) out.push(c); walk(c); } };
      walk(root);
      return out;
    };
    const attr = (el, name) => el ? el.getAttribute(name) : null;

    // Background: p:cSld/p:bg/p:bgPr/a:solidFill/a:srgbClr@val
    const bgClrEl = find(doc.documentElement, ['cSld','bg','bgPr','solidFill','srgbClr']);
    if (bgClrEl) slide.bg = '#' + attr(bgClrEl, 'val');

    // Shapes: every p:sp and p:pic in the spTree
    const spTree = find(doc.documentElement, ['cSld','spTree']);
    if (!spTree) return slide;
    for (const sp of findAll(spTree, 'sp').concat(findAll(spTree, 'pic'))) {
      const el = parseShape(sp, find, findAll, attr, rels, zip);
      if (el) slide.elements.push(el);
    }
    return slide;
  }

  function parseShape(sp, find, findAll, attr, rels, zip) {
    const isPic = sp.localName === 'pic';
    // Position + size from a:xfrm/a:off and a:ext (EMU). Some pics store it in pic/xfrm.
    const off = find(sp, ['spPr','xfrm','off']) || find(sp, ['xfrm','off']);
    const ext = find(sp, ['spPr','xfrm','ext']) || find(sp, ['xfrm','ext']);
    if (!off || !ext) return null;
    const x = +attr(off, 'x'), y = +attr(off, 'y');
    const cx = +attr(ext, 'cx'), cy = +attr(ext, 'cy');
    if (!cx || !cy) return null;
    const xp = x / EMU_W * 100, yp = y / EMU_H * 100;
    const wp = cx / EMU_W * 100, hp = cy / EMU_H * 100;

    // Image (p:pic): resolve via blip embed relationship
    if (isPic) {
      const blip = find(sp, ['blipFill','blip']);
      const embed = blip ? attr(blip, 'embed') : null;
      if (embed && rels[embed]) {
        const target = rels[embed].replace(/^\.\.\//, 'ppt/');
        const imgFile = zip.file(target);
        if (imgFile) {
          // We can't await inside this sync parser easily; resolve bytes synchronously via base64.
          // JSZip.file(...).async is async, but we can mark this element and resolve later.
          // Simpler: read as base64 here using the sync internals is not safe; instead push a
          // placeholder and resolve in a second pass. For now, read via async wrapper below.
          return { kind: 'image', x: xp, y: yp, w: wp, h: hp, _imgTarget: target };
        }
      }
      return null;
    }

    // Shape geometry from a:prstGeom prst
    const geom = find(sp, ['spPr','prstGeom']);
    const prst = geom ? attr(geom, 'prst') : 'rect';
    // Fill color
    const fillClr = find(sp, ['spPr','solidFill','srgbClr']);
    const fill = fillClr ? '#' + attr(fillClr, 'val') : null;
    const noFill = find(sp, ['spPr','noFill']);

    // Text body
    const txBody = find(sp, ['txBody']);
    let text = '', fontSize = 18, bold = false, italic = false, color = '#222222', align = 'left', fontFamily = '';
    if (txBody) {
      // Concatenate all <a:t> runs, joining paragraphs with \n
      const paras = findAll(txBody, 'p');
      const paraTexts = [];
      for (const p of paras) {
        const runs = findAll(p, 'r');
        let para = '';
        let firstRunFmt = null;
        for (const r of runs) {
          const t = find(r, ['t']);
          if (t) para += t.textContent;
          if (!firstRunFmt) {
            const rPr = find(r, ['rPr']);
            if (rPr) firstRunFmt = rPr;
          }
        }
        paraTexts.push(para);
        // Alignment from p:pPr@algn (first paragraph wins)
        const pPr = find(p, ['pPr']);
        if (pPr && paraTexts.length === 1) {
          const a = attr(pPr, 'algn');
          if (a === 'ctr') align = 'center';
          else if (a === 'r') align = 'right';
        }
      }
      text = paraTexts.join('\n');
      // Formatting from the first run's rPr
      const firstP = paras[0];
      if (firstP) {
        const firstR = find(firstP, ['r']);
        if (firstR) {
          const rPr = find(firstR, ['rPr']);
          if (rPr) {
            const sz = attr(rPr, 'sz');        // half-points
            if (sz) fontSize = Math.round(+sz / 100);
            if (attr(rPr, 'b') === '1') bold = true;
            if (attr(rPr, 'i') === '1') italic = true;
            const clrEl = find(rPr, ['solidFill','srgbClr']);
            if (clrEl) color = '#' + attr(clrEl, 'val');
            const latinEl = find(rPr, ['latin']);
            if (latinEl) fontFamily = attr(latinEl, 'typeface') || '';
          }
        }
      }
    }

    // Decide kind: ellipse/circle vs rectangle vs text box
    let kind = 'rect';
    if (prst === 'ellipse' || prst === 'ellipse') kind = 'ellipse';

    // If there is text and no explicit fill shape geometry, treat as a text box.
    if (text && (noFill || !fill)) {
      return { kind: 'text', x: xp, y: yp, w: wp, h: hp, text, fontSize, bold, italic, color, align, fontFamily: fontFamily || undefined };
    }
    if (text) {
      // A filled shape with text inside — keep as shape but carry the text.
      return { kind, x: xp, y: yp, w: wp, h: hp, fill: fill || '#4a90e2', text, fontSize, bold, italic, color, align, fontFamily: fontFamily || undefined };
    }
    return { kind, x: xp, y: yp, w: wp, h: hp, fill: fill || '#4a90e2' };
  }

  // ---------- Slide operations ----------
  function addSlide() {
    snapshot();
    slides.splice(current + 1, 0, { bg: '#ffffff', elements: [] });
    current = current + 1;
    selected = null;
    renderSlideList(); renderCanvas(); markDirty();
  }
  function duplicateSlide(i) {
    snapshot();
    const copy = JSON.parse(JSON.stringify(slides[i]));
    copy.elements.forEach(e => e.id = 'e' + (seq++));
    slides.splice(i + 1, 0, copy);
    current = i + 1;
    renderSlideList(); renderCanvas(); markDirty();
  }
  function deleteSlide(i) {
    if (slides.length <= 1) { UI.toast('Need at least one slide', 'warn'); return; }
    snapshot();
    slides.splice(i, 1);
    if (current >= slides.length) current = slides.length - 1;
    selected = null;
    renderSlideList(); renderCanvas(); markDirty();
  }
  function moveSlide(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= slides.length) return;
    snapshot();
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
      d.style.fontFamily = el.fontFamily || '';
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

  // ---------- Save (PocketOffice's own .json — fully re-editable) ----------
  async function saveJson() {
    try {
      // Strip transient fields, keep only editable props.
      const clean = slides.map(s => ({
        bg: s.bg || '#ffffff',
        elements: (s.elements || []).map(el => {
          const e = { id: el.id, kind: el.kind, x: el.x, y: el.y, w: el.w, h: el.h };
          if (el.text != null) e.text = el.text;
          if (el.fontFamily) e.fontFamily = el.fontFamily;
          if (el.fontSize != null) e.fontSize = el.fontSize;
          if (el.bold) e.bold = true;
          if (el.italic) e.italic = true;
          if (el.color) e.color = el.color;
          if (el.fill) e.fill = el.fill;
          if (el.align) e.align = el.align;
          if (el.dataUrl) e.dataUrl = el.dataUrl;
          return e;
        }),
      }));
      const bytes = new TextEncoder().encode(JSON.stringify({ slides: clean }, null, 2));
      await FS.save({
        name: 'presentation.json',
        mime: 'application/json',
        bytes,
        handle: null,
      });
      UI.toast('Saved presentation.json (re-openable in Impress)', 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Save failed: ' + (e.message || e), 'error');
    }
  }

  // ---------- Print ----------
  // Build a hidden container with all slides stacked one-per-page, print, remove.
  let lastPrintAt = 0;
  function printDoc() {
    // Guard against double-click firing window.print() twice (2nd call closes the dialog).
    const now = Date.now();
    if (now - lastPrintAt < 1000) return;
    lastPrintAt = now;
    // Remove any leftover print container.
    document.getElementById('impPrint')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'impPrint';
    wrap.style.display = 'none';
    slides.forEach((s) => {
      const slideEl = document.createElement('div');
      slideEl.className = 'imp-print-slide';
      slideEl.style.background = s.bg || '#fff';
      s.elements.forEach(el => slideEl.appendChild(presentEl(el)));
      wrap.appendChild(slideEl);
    });
    document.body.appendChild(wrap);
    const cleanup = () => { wrap.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    wrap.style.display = 'block';
    window.print();
    setTimeout(() => { wrap.remove(); }, 2000);   // fallback cleanup
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
            if (el.fontFamily) opts.fontFace = el.fontFamily;
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
      PdfFonts.register(pdf);   // bundled families become usable below
      slides.forEach((s, idx) => {
        if (idx > 0) pdf.addPage([SLIDE_W, SLIDE_H], 'landscape');
        // background
        pdf.setFillColor(...hexToRgb(s.bg || '#ffffff'));
        pdf.rect(0, 0, SLIDE_W, SLIDE_H, 'F');
        for (const el of s.elements) {
          const x = el.x/100*SLIDE_W, y = el.y/100*SLIDE_H, w = el.w/100*SLIDE_W, h = el.h/100*SLIDE_H;
          if (el.kind === 'text') {
            pdf.setFontSize(el.fontSize || 18);
            const { family, style } = PdfFonts.pick(el.fontFamily || null, !!el.bold, !!el.italic);
            pdf.setFont(family, style);
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

  // ---------- Undo ----------
  // Snapshot the deck (deep copy) + cursor before a mutation. seq stays monotonic.
  function snapshot() {
    const snap = { slides: Util.deepClone(slides), current, selected };
    History.snapshot(deckKey(), snap, (s) => {
      slides = s.slides; current = s.current; selected = s.selected;
      renderSlideList(); renderCanvas();
    });
  }
  function doUndo() { History.undo(deckKey()); }
  function doRedo() { History.redo(deckKey()); }

  // ---------- Dirty + autosave ----------
  function markDirty() {
    dirty = true;
    renderTabs();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try {
        const dumpDecks = decks.map(d => ({
          id: d.id, name: d.name,
          slides: d.id === activeDeckId ? slides : d.slides,
          current: d.id === activeDeckId ? current : d.current,
        }));
        await Storage.save('impress:decks', { decks: dumpDecks, active: activeDeckId });
        dirty = false;
      } catch (e) { /* ignore */ }
    }, 800);
  }

  // ---------- Styles ----------
  function injectStyles() {
    if (document.getElementById('impress-styles')) return;
    const s = document.createElement('style');
    s.id = 'impress-styles';
    s.textContent = `
      .impress-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .impress-row { display: flex; flex: 1; min-height: 0; }
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

  return { boot, onActivate, undo: doUndo, redo: doRedo, reopen: reopenDeck };
})();
