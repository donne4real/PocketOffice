/* ==========================================================================
   calc.js — Calc: the spreadsheet UI. The formula engine itself lives in
   formula.js (pure, unit-tested). Features: 1000x100 grid built lazily as
   you scroll, click-to-edit, charts, multi-sheet .xlsx + .csv import/export
   (SheetJS, loaded on demand), autosave, fill-down, keyboard nav.
   ========================================================================== */

const Calc = (() => {
  const COLS = 100;       // A..CV
  const ROWS = 1000;
  // Multi-sheet: each sheet owns { id, name, data, charts, activeCell }.
  // The live `data`/`charts`/`activeCell` bindings point at the active sheet;
  // all mutations go through them, so the sheet objects stay in sync.
  const sheets = [];
  let activeSheetId = null;
  let sheetSeq = 1;
  const closedSheets = [];     // recently closed, for Ctrl+Shift+T reopen
  let tabs = null;
  // cell key = "A1" etc.  data[key] = { raw: string typed, value: computed }
  let data = Object.create(null);
  let activeCell = 'A1';
  let editingCell = null;
  let switchingSheet = false;   // suppresses the fx blur-commit during a sheet switch
  let dirty = false;
  let autosaveTimer = null;

  const $ = (id) => document.getElementById(id);

  function activeSheet() { return sheets.find(s => s.id === activeSheetId); }
  function sheetKey() { return 'calc:' + activeSheetId; }
  function sheetHasContent(s) {
    return Object.keys(s.data).length > 0 || (s.charts && s.charts.length > 0);
  }

  // ---------- Formula engine (js/formula.js) ----------
  const { colName, colIndex, keyOf, parseAddr, formatNumber } = Formula;

  // Recompute every formula on the active sheet in one memoized pass.
  function recalcAll() {
    Formula.recalcSheet(data, resolverFor(activeSheet()));
    if (charts.length) refreshChartData();
  }
  // Sheet names in formulas ('Sheet 2'!A1, Data!B3). A name first matches a
  // sibling imported from the same workbook, then any open tab of that name.
  function resolverFor(sheet) {
    return (name) => {
      const want = String(name).toLowerCase();
      const cellsOf = (s) => s.id === activeSheetId ? data : s.data;
      if (sheet && sheet.book) {
        const sib = sheets.find(s => s.book === sheet.book && (s.sheetName || '').toLowerCase() === want);
        if (sib) return cellsOf(sib);
      }
      const hit = sheets.find(s => s.name.toLowerCase() === want || (s.sheetName || '').toLowerCase() === want);
      return hit ? cellsOf(hit) : null;
    };
  }
  // Re-render chart data without rebuilding the panels (keeps position).
  function refreshChartData() {
    if (!Libs.isReady('chart')) return;
    for (const chart of charts) {
      const layer = $('calcChartLayer');
      const panel = layer && layer.querySelector(`.calc-chart-panel[data-id="${chart.id}"]`);
      if (panel) {
        const canvas = panel.querySelector('canvas');
        if (canvas) drawChart(canvas, chart);
      }
    }
  }

  // ---------- DOM grid ----------
  const ROW_CHUNK = 100;
  let renderedRows = 0;
  let gridBody = null;
  const cellEls = new Map();    // address -> cell element (rendered rows only)
  let activeEl = null;

  function buildGrid() {
    const wrap = $('calcContent');
    wrap.innerHTML = '';
    document.documentElement.style.setProperty('--calc-cols', COLS);
    // Top-left corner + column header row
    const corner = document.createElement('div');
    corner.className = 'calc-corner';
    corner.textContent = '◢';
    wrap.appendChild(corner);

    const colHeader = document.createElement('div');
    colHeader.className = 'calc-colheader';
    let chHtml = '<div class="calc-spacer"></div>';
    for (let c = 0; c < COLS; c++) chHtml += `<div class="calc-colhead" data-col="${c}">${colName(c)}</div>`;
    colHeader.innerHTML = chHtml;
    wrap.appendChild(colHeader);

    // Row gutter + cells. Rows are created in chunks as the user scrolls
    // down (v1 built all 100,000 cells at startup).
    const scrollBody = document.createElement('div');
    scrollBody.className = 'calc-body';
    wrap.appendChild(scrollBody);
    gridBody = scrollBody;
    ensureRows(ROW_CHUNK);

    // Click + double-click + keyboard handlers
    scrollBody.addEventListener('click', onCellClick);
    scrollBody.addEventListener('dblclick', onCellDblClick);
    scrollBody.addEventListener('keydown', onCellKey);
    // Grow the grid when the user nears the bottom.
    wrap.addEventListener('scroll', () => {
      if (wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 600) ensureRows(renderedRows + ROW_CHUNK);
    });

    // Floating chart overlay layer (sits above the grid, scrolls with content).
    const chartLayer = document.createElement('div');
    chartLayer.id = 'calcChartLayer';
    chartLayer.className = 'calc-chart-layer';
    wrap.appendChild(chartLayer);

    return scrollBody;
  }

  // Make sure rows 0..n-1 exist in the DOM, painting any data they hold.
  function ensureRows(n) {
    n = Math.min(ROWS, n);
    if (!gridBody || n <= renderedRows) return;
    const from = renderedRows;
    const frag = document.createDocumentFragment();
    for (let r = from; r < n; r++) {
      const rowHead = document.createElement('div');
      rowHead.className = 'calc-rowhead';
      rowHead.textContent = r + 1;
      frag.appendChild(rowHead);
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        const addr = keyOf(c, r);
        cell.className = 'calc-cell';
        cell.dataset.addr = addr;
        cell.tabIndex = -1;
        cellEls.set(addr, cell);
        frag.appendChild(cell);
      }
    }
    gridBody.appendChild(frag);
    renderedRows = n;
    for (const addr of Object.keys(data)) {
      const a = parseAddr(addr);
      if (a && a.row >= from && a.row < n) renderCell(addr);
    }
  }

  // ---------- Charts ----------
  // Each chart: { id, type: 'bar'|'line'|'pie', range, title, x, y, w, h }
  let charts = [];
  let chartSeq = 1;

  function addChartDialog(editChart = null) {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:360px';
    body.innerHTML = `
      <div class="row"><label>Type</label>
        <select id="chType">
          <option value="bar">Bar</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
        </select></div>
      <div class="row"><label>Data range</label><input type="text" id="chRange" placeholder="e.g. A1:B5"></div>
      <div class="row"><label>Title</label><input type="text" id="chTitle" placeholder="(optional)"></div>
      <p class="muted small" style="margin:4px 0 0 90px">Range should include a header row/column. First column = labels (for bar/line) or categories (pie); remaining columns = numeric series.</p>`;
    if (editChart) {
      body.querySelector('#chType').value = editChart.type;
      body.querySelector('#chRange').value = editChart.range;
      body.querySelector('#chTitle').value = editChart.title || '';
    } else if (activeCell) {
      // Default the range to the active cell as a hint.
      body.querySelector('#chRange').value = activeCell;
    }
    UI.dialog({
      title: editChart ? 'Edit chart' : 'New chart', body, okText: editChart ? 'Update' : 'Create',
      onOk: () => {
        const type = body.querySelector('#chType').value;
        const range = body.querySelector('#chRange').value.trim();
        const title = body.querySelector('#chTitle').value.trim();
        if (!range) { UI.toast('Enter a data range', 'warn'); return false; }
        if (!parseRangeSpec(range)) { UI.toast('Invalid range (use A1:B5)', 'err'); return false; }
        if (editChart) {
          snapshot();
          Object.assign(editChart, { type, range, title });
        } else {
          snapshot();
          const c = { id: 'ch' + (chartSeq++), type, range, title,
                      x: 55, y: 15, w: 40, h: 45 };   // default off to the right
          charts.push(c);
        }
        renderCharts();
        markDirty();
      },
    });
  }

  // Parse "A1:B5" into {c1,r1,c2,r2} cell indices, or null if invalid.
  function parseRangeSpec(spec) {
    const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(spec.trim());
    if (!m) return null;
    const c1 = colIndex(m[1].toUpperCase()), r1 = +m[2] - 1;
    const c2 = colIndex(m[3].toUpperCase()), r2 = +m[4] - 1;
    if (c1 < 0 || c2 < 0 || r1 < 0 || r2 < 0) return null;
    return {
      c1: Math.min(c1, c2), c2: Math.max(c1, c2),
      r1: Math.min(r1, r2), r2: Math.max(r1, r2),
    };
  }

  // Read the data range into Chart.js-ready {labels, datasets}.
  function readChartData(chart) {
    const rng = parseRangeSpec(chart.range);
    if (!rng) return { labels: [], datasets: [] };
    // First column (or row, if single-column) are labels; the rest are series.
    const labels = [];
    const rows = [];
    for (let r = rng.r1; r <= rng.r2; r++) {
      const row = [];
      for (let c = rng.c1; c <= rng.c2; c++) {
        const cell = data[keyOf(c, r)];
        let v = cell ? cell.value : '';
        if (Formula.isErr(v)) v = 0;
        row.push(v);
      }
      rows.push(row);
    }
    // Decide orientation: if 2+ columns, first column = labels, each remaining column = a series.
    const width = rng.c2 - rng.c1 + 1;
    if (width >= 2) {
      for (const row of rows) labels.push('' + (row[0] ?? ''));
      const palette = ['#1668e6','#e63946','#06a77d','#f4a261','#8338ec','#00b4d8'];
      const datasets = [];
      for (let s = 1; s < width; s++) {
        datasets.push({
          label: '' + (rows[0] ? (rows[0][s] ?? `Series ${s}`) : `Series ${s}`),
          data: rows.slice(1).map(row => Number(row[s]) || 0),
          backgroundColor: chart.type === 'pie'
            ? rows.slice(1).map((_, i) => palette[i % palette.length])
            : palette[(s - 1) % palette.length],
        });
      }
      // For pie, labels come from the first column of data rows (skip header).
      if (chart.type === 'pie') {
        return { labels: labels.slice(1), datasets: [{ data: datasets[0].data, backgroundColor: datasets[0].backgroundColor }] };
      }
      return { labels: labels.slice(1), datasets };
    }
    // Single column: treat each cell as a value, labels = row addresses.
    for (let r = rng.r1; r <= rng.r2; r++) labels.push(keyOf(rng.c1, r));
    const palette = ['#1668e6'];
    return {
      labels,
      datasets: [{ label: '', data: rows.map(row => Number(row[0]) || 0), backgroundColor: palette[0] }],
    };
  }

  function renderCharts() {
    const layer = $('calcChartLayer');
    if (!layer) return;
    if (charts.length && !Libs.isReady('chart')) {
      // Chart.js loads on first use; draw once it's here.
      Libs.need('chart').then(renderCharts).catch(e => UI.toast(e.message, 'error'));
      return;
    }
    // Remove panels that no longer exist; rebuild the rest.
    layer.innerHTML = '';
    for (const chart of charts) {
      const panel = document.createElement('div');
      panel.className = 'calc-chart-panel';
      panel.style.left = chart.x + '%';
      panel.style.top = chart.y + '%';
      panel.style.width = chart.w + '%';
      panel.style.height = chart.h + '%';
      panel.dataset.id = chart.id;
      panel.innerHTML = `
        <div class="calc-chart-head">
          <span class="calc-chart-title"></span>
          <span style="flex:1"></span>
          <button class="tb-btn icon-only" data-act="edit" title="Edit">⚙</button>
          <button class="tb-btn icon-only" data-act="close" title="Remove">✕</button>
        </div>
        <canvas></canvas>`;
      panel.querySelector('.calc-chart-title').textContent = chart.title || chart.type + ' chart';
      layer.appendChild(panel);
      // Render the chart
      const canvas = panel.querySelector('canvas');
      drawChart(canvas, chart);
      // Wire head buttons
      panel.querySelector('[data-act=edit]').onclick = (e) => { e.stopPropagation(); addChartDialog(chart); };
      panel.querySelector('[data-act=close]').onclick = (e) => {
        e.stopPropagation();
        snapshot();
        const idx = charts.findIndex(c => c.id === chart.id);
        if (idx >= 0) charts.splice(idx, 1);
        renderCharts(); markDirty();
      };
      // Dragging (move) by the head, resizing by a bottom-right handle
      wireChartDrag(panel, chart);
    }
  }

  function drawChart(canvas, chart) {
    if (typeof Chart === 'undefined') return;
    const { labels, datasets } = readChartData(chart);
    if (canvas._chart) canvas._chart.destroy();
    canvas._chart = new Chart(canvas.getContext('2d'), {
      type: chart.type,
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: getCssVar('--text') } } },
        scales: chart.type === 'pie' ? {} : {
          x: { ticks: { color: getCssVar('--text-dim') }, grid: { color: getCssVar('--border-soft') } },
          y: { ticks: { color: getCssVar('--text-dim') }, grid: { color: getCssVar('--border-soft') } },
        },
      },
    });
  }
  function getCssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || '#333';
  }

  function wireChartDrag(panel, chart) {
    const head = panel.querySelector('.calc-chart-head');
    const layer = $('calcChartLayer');
    let drag = null;
    // Document-level listeners live only for the duration of one drag. (v1
    // attached them once per render and removed them on the first mouseup
    // anywhere, so after any click a chart could no longer be dragged.)
    const begin = (d, e) => {
      drag = d;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };
    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const rect = layer.getBoundingClientRect();
      begin({ mode: 'move', startMx: e.clientX, startMy: e.clientY, startX: chart.x, startY: chart.y, rect, snapped: false }, e);
    });
    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'calc-chart-resize';
    panel.appendChild(resizeHandle);
    resizeHandle.addEventListener('mousedown', (e) => {
      const rect = layer.getBoundingClientRect();
      e.stopPropagation();
      begin({ mode: 'resize', startMx: e.clientX, startMy: e.clientY, startW: chart.w, startH: chart.h, rect, snapped: false }, e);
    });
    const onMove = (e) => {
      if (!drag) return;
      if (!drag.snapped) { snapshot(); drag.snapped = true; }
      if (drag.mode === 'move') {
        const dx = (e.clientX - drag.startMx) / drag.rect.width * 100;
        const dy = (e.clientY - drag.startMy) / drag.rect.height * 100;
        chart.x = Math.max(-30, Math.min(95, drag.startX + dx));
        chart.y = Math.max(0, Math.min(90, drag.startY + dy));
      } else {
        chart.w = Math.max(15, drag.startW + (e.clientX - drag.startMx) / drag.rect.width * 100);
        chart.h = Math.max(15, drag.startH + (e.clientY - drag.startMy) / drag.rect.height * 100);
      }
      panel.style.left = chart.x + '%';
      panel.style.top = chart.y + '%';
      panel.style.width = chart.w + '%';
      panel.style.height = chart.h + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const moved = drag && drag.snapped;
      drag = null;
      if (moved) markDirty();
    };
  }


  // Paint one cell. Skips the DOM write when the text and style are
  // unchanged, so a recalc only touches cells whose display changed.
  function renderCell(addr) {
    const el = cellEls.get(addr);
    if (!el) return;
    const cell = data[addr];
    let text = '', kind = '';
    if (cell && cell.raw !== '' && cell.raw != null) {
      const v = cell.value;
      if (typeof v === 'number') { text = formatNumber(v); kind = 'calc-num'; }
      else if (typeof v === 'boolean') { text = v ? 'TRUE' : 'FALSE'; kind = 'calc-bool'; }
      else if (Formula.isErr(v)) { text = v; kind = 'calc-err'; }
      else { text = v == null ? '' : '' + v; kind = 'calc-str'; }
    }
    if (el._shown === text && el._kind === kind) return;
    el.textContent = text;
    el.classList.remove('calc-num', 'calc-str', 'calc-bool', 'calc-err');
    if (kind) el.classList.add(kind);
    el._shown = text;
    el._kind = kind;
  }
  const forgetPaint = (el) => { if (el) { el._shown = undefined; el._kind = undefined; } };

  function renderAll() {
    for (const addr of Object.keys(data)) renderCell(addr);
  }

  // ---------- Editing ----------
  function setActive(addr) {
    if (activeEl) activeEl.classList.remove('active');
    activeCell = addr;
    const pos = parseAddr(addr);
    if (pos) ensureRows(pos.row + 1 + 20);
    const el = cellEls.get(addr);
    activeEl = el || null;
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // Focus the cell so keyboard events (typing, arrows, Enter, Delete)
      // reach the grid handler. tabIndex=-1 allows programmatic focus only.
      if (!editingCell) el.focus({ preventScroll: true });
    }
    // formula bar shows raw content
    $('calcFx').value = (data[addr] && data[addr].raw) || '';
    $('calcAddr').textContent = addr;
  }

  function onCellClick(e) {
    const el = e.target.closest('.calc-cell');
    if (!el) return;
    // If currently editing this cell, keep editor.
    if (editingCell === el.dataset.addr) return;
    finishEdit(true);
    setActive(el.dataset.addr);
  }
  function onCellDblClick(e) {
    const el = e.target.closest('.calc-cell');
    if (!el) return;
    setActive(el.dataset.addr);
    startEdit();
  }
  function onCellKey(e) {
    if (editingCell) {
      // Movement keys while editing
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); moveActive(0, 1); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      else if (e.key === 'Tab') { e.preventDefault(); finishEdit(true); moveActive(e.shiftKey ? -1 : 1, 0); }
      return;
    }
    // Ctrl+D: fill down (was advertised in the tooltip but never wired).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      fillDown();
      return;
    }
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':    moveActive(0, -1); break;
      case 'ArrowDown':  moveActive(0, 1); break;
      case 'ArrowLeft':  moveActive(-1, 0); break;
      case 'ArrowRight': moveActive(1, 0); break;
      case 'Enter':      startEdit(); break;
      case 'Tab':        moveActive(e.shiftKey ? -1 : 1, 0); break;
      case 'Delete': case 'Backspace':
        if (data[activeCell]) {
          snapshot();
          delete data[activeCell];
          recalcAll(); renderCell(activeCell); renderAll();
          $('calcFx').value = ''; markDirty();
        }
        break;
      case 'F2':         startEdit(); break;
      default:
        // If a printable char, start editing with it
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          startEdit(e.key);
        } else handled = false;
    }
    if (handled) e.preventDefault();
  }
  function moveActive(dc, dr) {
    const a = parseAddr(activeCell);
    const c = Math.max(0, Math.min(COLS - 1, a.col + dc));
    const r = Math.max(0, Math.min(ROWS - 1, a.row + dr));
    setActive(keyOf(c, r));
  }

  function startEdit(initialChar = null) {
    if (editingCell) finishEdit(true);
    const addr = activeCell;
    editingCell = addr;
    const el = cellEls.get(addr);
    if (!el) return;
    forgetPaint(el);
    const inp = document.createElement('input');
    inp.className = 'calc-edit';
    inp.value = initialChar != null ? initialChar : ((data[addr] && data[addr].raw) || '');
    el.innerHTML = '';
    el.appendChild(inp);
    el.classList.add('editing');
    inp.focus();
    if (initialChar == null) inp.select(); else inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.addEventListener('blur', () => finishEdit(true));
    inp.addEventListener('keydown', (e) => {
      // stop the parent grid handler from double-handling
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); moveActive(0, 1); }
      else if (e.key === 'Tab') { e.preventDefault(); finishEdit(true); moveActive(e.shiftKey?-1:1, 0); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
  }
  function finishEdit(commit) {
    if (!editingCell) return;
    const addr = editingCell;
    const el = cellEls.get(addr);
    const inp = el && el.querySelector('input.calc-edit');
    const raw = inp ? inp.value : '';
    editingCell = null;
    if (el) { el.classList.remove('editing'); el.innerHTML = ''; forgetPaint(el); }
    if (commit) {
      snapshot();
      if (raw === '') {
        delete data[addr];
      } else {
        if (!data[addr]) data[addr] = {};
        data[addr].raw = raw;
      }
      recalcAll(); renderAll();
      $('calcFx').value = raw;
      markDirty();
    }
    renderCell(addr);
  }
  function cancelEdit() {
    const el = cellEls.get(editingCell);
    editingCell = null;
    if (el) { el.classList.remove('editing'); el.innerHTML = ''; forgetPaint(el); }
    renderCell(activeCell);
    focusActiveCell();
  }

  // Formula bar editing
  function commitFormulaBar(fromEnter = false) {
    const v = $('calcFx').value;
    if (!activeCell) return;
    // Skip when unchanged — avoids spurious undo entries on every blur.
    const cur = (data[activeCell] && data[activeCell].raw) || '';
    if (cur === v) {
      if (fromEnter) focusActiveCell();
      return;
    }
    snapshot();
    if (v === '') delete data[activeCell];
    else { if (!data[activeCell]) data[activeCell] = {}; data[activeCell].raw = v; }
    recalcAll(); renderAll(); renderCell(activeCell); markDirty();
    if (fromEnter) focusActiveCell();
  }
  function focusActiveCell() {
    if (activeEl) activeEl.focus({ preventScroll: true });
  }

  // ---------- Fill / clear ----------
  // Copy the active cell into the one below and move there. Formulas are
  // adjusted like Excel's: =A1*2 becomes =A2*2, $A$1 stays put.
  function fillDown() {
    if (editingCell) finishEdit(true);
    const a = parseAddr(activeCell);
    if (!a || a.row + 1 >= ROWS) return;
    const src = data[activeCell];
    const below = keyOf(a.col, a.row + 1);
    snapshot();
    if (src) data[below] = { raw: Formula.shiftRefs(src.raw, 1, 0) };
    else delete data[below];
    recalcAll(); renderAll(); renderCell(below); markDirty();
    setActive(below);
  }
  function clearSheet() {
    UI.confirm({ title: 'Clear sheet?', message: 'Erase all cells in this sheet.', okText: 'Clear', danger: true })
      .then(ok => {
        if (!ok) return;
        snapshot();
        wipeData();
        charts.length = 0;
        renderCharts();
        markDirty();
      });
  }

  // Delete every cell and clear their on-screen text. renderAll() only walks
  // keys still present in `data`, so wiped cells must be re-rendered explicitly
  // or their stale display lingers.
  function wipeData() {
    const wiped = Object.keys(data);
    for (const k of wiped) delete data[k];
    wiped.forEach(renderCell);
    return wiped;
  }

  // Start a fresh sheet in a new tab (nothing is discarded).
  function newSheet() {
    addSheet();
  }

  // ---------- Multi-sheet lifecycle ----------
  // book/sheetName: set for sheets imported from one multi-sheet workbook,
  // so their cross-sheet formulas (Sheet2!A1) resolve to each other.
  function addSheetRaw({ name = null, data: d = null, charts: c = [], book = null, sheetName = null } = {}) {
    const n = sheetSeq++;
    const id = 's' + n;
    if (!name) name = 'Sheet-' + n;
    const sheet = { id, name, data: d || Object.create(null), charts: c, activeCell: 'A1', book, sheetName };
    sheets.push(sheet);
    return sheet;
  }
  function addSheet(opts) {
    const s = addSheetRaw(opts);
    activateSheet(s.id);
    markDirty();   // persist the new tab in the session manifest soon
    return s;
  }

  function activateSheet(id) {
    if (id === activeSheetId) { renderTabs(); return; }
    // The fx blur-commit must not fire mid-switch: focusing the new active
    // cell happens before the bar is refreshed, and would otherwise commit
    // the previous sheet's bar text into this one.
    switchingSheet = true;
    try {
      const cur = activeSheet();
      const oldAddrs = Object.keys(data);
      if (cur) cur.activeCell = activeCell;
      activeSheetId = id;
      const s = activeSheet();
      data = s.data; charts = s.charts;
      activeCell = s.activeCell || 'A1';
      editingCell = null;
      $('calcFx').value = '';
      // renderCell reads the live `data`; re-rendering the old sheet's addresses
      // against the new binding is what clears their stale display.
      oldAddrs.forEach(renderCell);
      recalcAll(); renderAll(); renderCharts();
      setActive(activeCell);
      const key = 'calc:' + id;
      if (!s.historyReady) {
        History.reset(key);
        History.registerCurrentSnapshot(key, captureCalcState, restoreCalcState);
        s.historyReady = true;
      }
      renderTabs();
    } finally {
      switchingSheet = false;
    }
  }

  function closeSheet(id) {
    const i = sheets.findIndex(s => s.id === id);
    if (i < 0) return;
    const s = sheets[i];
    const doClose = () => {
      // Park the closed sheet for Ctrl+Shift+T reopen. For the active sheet
      // the live bindings ARE its data (shared references), so snapshot as-is.
      closedSheets.unshift({ id: s.id, name: s.name, data: s.data, charts: s.charts, activeCell: s.activeCell, book: s.book, sheetName: s.sheetName });
      if (closedSheets.length > 10) closedSheets.length = 10;
      sheets.splice(i, 1);
      if (activeSheetId === id) {
        activeSheetId = null;
        if (sheets.length) activateSheet(sheets[Math.max(0, i - 1)].id);
        else addSheet();
      } else {
        renderTabs();
      }
      markDirty();
    };
    if (sheetHasContent(s)) {
      UI.confirm({ title: `Close ${s.name}?`, message: 'The sheet contents will be lost.', okText: 'Close anyway', danger: true })
        .then(ok => { if (ok) doClose(); });
    } else {
      doClose();
    }
  }

  // Reopen the most recently closed sheet (Ctrl+Shift+T).
  function reopenSheet() {
    if (!closedSheets.length) { UI.toast('No recently closed sheets', 'info'); return; }
    const s = closedSheets.shift();
    sheets.push({ id: s.id, name: s.name, data: s.data, charts: s.charts, activeCell: s.activeCell, book: s.book, sheetName: s.sheetName });
    activateSheet(s.id);
    markDirty();
    UI.toast(`Reopened ${s.name}`, 'success');
  }

  function renderTabs() {
    if (!tabs) return;
    tabs.render(sheets.map(s => ({ id: s.id, name: s.name, dirty: sheetHasContent(s) })), activeSheetId);
  }

  // Drag-to-reorder callback from the shared tab strip.
  function reorderSheets(fromId, toId) {
    const from = sheets.findIndex(s => s.id === fromId);
    const to = sheets.findIndex(s => s.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = sheets.splice(from, 1);
    sheets.splice(to, 0, moved);
    renderTabs();
    markDirty();
  }

  // ---------- Import / Export ----------
  // Every worksheet in the file is imported (v1 took only the first): the
  // first lands in the active sheet if it is empty, the rest open as tabs.
  async function importFile() {
    try {
      const f = await FS.open({
        accept: [
          { description: 'Spreadsheet', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'text/csv': ['.csv'], 'application/vnd.ms-excel': ['.xls'] } }
        ],
      });
      await Libs.need('xlsx');
      const wb = XLSX.read(f.bytes, { type: 'array' });
      const names = wb.SheetNames.filter(n => wb.Sheets[n]);
      if (!names.length) { UI.toast('No sheets in file', 'warn'); return; }
      const base = f.name.replace(/\.[^.]+$/, '');
      const multi = names.length > 1;
      const book = multi ? 'b' + Date.now().toString(36) : null;
      let clipped = false;
      let firstId = null;
      for (const sn of names) {
        const res = readWorksheet(wb.Sheets[sn]);
        clipped = clipped || res.clipped;
        const name = multi ? base + ' – ' + sn : base;
        const cur = activeSheet();
        if (!firstId && cur && !sheetHasContent(cur)) {
          // Pristine active sheet: load in place (single undo step).
          snapshot();
          for (const k of Object.keys(res.cells)) data[k] = res.cells[k];
          Object.assign(cur, { name, book, sheetName: sn });
          firstId = cur.id;
        } else {
          const sheet = addSheetRaw({ name, data: res.cells, book, sheetName: sn });
          if (!firstId) firstId = sheet.id;
        }
      }
      if (firstId === activeSheetId) { recalcAll(); renderAll(); renderTabs(); }
      else activateSheet(firstId);
      markDirty();
      UI.toast(`Imported ${f.name}${multi ? ` (${names.length} sheets)` : ''}`, 'success');
      if (clipped) UI.toast(`Only the first ${ROWS} rows × ${COLS} columns fit in Calc; the rest was not imported.`, 'warn', 6000);
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Import failed: ' + e.message, 'error');
    }
  }

  function readWorksheet(ws) {
    const cells = Object.create(null);
    if (!ws['!ref']) return { cells, clipped: false };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const clipped = range.e.r > ROWS - 1 || range.e.c > COLS - 1;
    for (let r = range.s.r; r <= Math.min(range.e.r, ROWS - 1); r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, COLS - 1); c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (cell == null) continue;
        let raw;
        if (cell.f) raw = '=' + cell.f;
        else if (cell.t === 'n') raw = '' + cell.v;
        else if (cell.t === 'b') raw = cell.v ? 'TRUE' : 'FALSE';
        else raw = '' + (cell.w ?? cell.v ?? '');
        if (raw !== '') cells[addr] = { raw };
      }
    }
    return { cells, clipped };
  }

  // SheetJS error-cell codes.
  const XL_ERRORS = { '#NULL!': 0x00, '#DIV/0!': 0x07, '#VALUE!': 0x0F, '#REF!': 0x17, '#NAME?': 0x1D, '#NUM!': 0x24, '#N/A': 0x2A };

  // scope 'one' = the active sheet; 'all' = every open sheet as one workbook.
  // .xlsx keeps formulas (v1 wrote only their values). CSV is values only.
  async function exportFile(fmt, scope = 'one') {
    try {
      await Libs.need('xlsx');
      const list = scope === 'all' ? sheets : [activeSheet()];
      const wb = XLSX.utils.book_new();
      const used = new Set();
      for (const sh of list) {
        const cellsOf = sh.id === activeSheetId ? data : sh.data;
        if (sh.id !== activeSheetId) Formula.recalcSheet(cellsOf, resolverFor(sh));
        const ws = {};
        let maxR = -1, maxC = -1;
        for (const addr of Object.keys(cellsOf)) {
          const cell = cellsOf[addr];
          const a = parseAddr(addr);
          if (!a || cell.raw == null || cell.raw === '') continue;
          maxR = Math.max(maxR, a.row); maxC = Math.max(maxC, a.col);
          const v = cell.value;
          let out;
          if (typeof v === 'number') out = { t: 'n', v };
          else if (typeof v === 'boolean') out = { t: 'b', v };
          else if (Formula.isErr(v)) out = fmt === 'csv' ? { t: 's', v } : { t: 'e', v: XL_ERRORS[v] ?? 0x0F, w: v };
          else out = { t: 's', v: v == null ? '' : '' + v };
          if (fmt === 'xlsx' && String(cell.raw)[0] === '=') out.f = cell.raw.slice(1);
          ws[addr] = out;
        }
        if (maxR < 0) continue;
        ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
        // Worksheet names: max 31 chars, no []:*?/\, unique.
        const baseName = ((sh.sheetName || sh.name).replace(/[\[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
        let wsName = baseName, k = 2;
        while (used.has(wsName.toLowerCase())) wsName = baseName.slice(0, 28) + ' ' + (k++);
        used.add(wsName.toLowerCase());
        XLSX.utils.book_append_sheet(wb, ws, wsName);
      }
      if (!wb.SheetNames.length) { UI.toast('Nothing to export', 'warn'); return; }
      const cur = activeSheet();
      const stem = (cur.book ? cur.name.split(' – ')[0] : cur.name).replace(/[\\/:*?"<>|]/g, ' ').trim() || 'sheet';
      const name = stem + '.' + fmt;
      const out = XLSX.write(wb, { bookType: fmt, type: 'array' });
      const mime = fmt === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const res = await FS.save({ name, mime, bytes: new Uint8Array(out), handle: null });
      UI.toast(`Exported ${(res.handle && res.handle.name) || name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Export failed: ' + e.message, 'error');
    }
  }

  // ---------- Print ----------
  // Build a hidden HTML table of populated cells, print it, then remove it.
  let lastPrintAt = 0;
  function printDoc() {
    // Guard against double-click firing window.print() twice (2nd call closes the dialog).
    const now = Date.now();
    if (now - lastPrintAt < 1000) return;
    lastPrintAt = now;
    // Find the populated range.
    let maxR = 0, maxC = 0;
    for (const addr of Object.keys(data)) {
      const a = parseAddr(addr); if (!a) continue;
      maxR = Math.max(maxR, a.row); maxC = Math.max(maxC, a.col);
    }
    if (maxR === 0 && maxC === 0 && !data['A1']) { UI.toast('Nothing to print', 'warn'); return; }
    const tbl = document.createElement('table');
    tbl.style.cssText = 'border-collapse:collapse;font-family:var(--font-ui);font-size:12px;width:100%';
    // Optional header row + col? Keep it simple: just the data, with borders.
    for (let r = 0; r <= maxR; r++) {
      const tr = document.createElement('tr');
      let rowHasData = false;
      for (let c = 0; c <= maxC; c++) {
        const cell = data[keyOf(c, r)];
        const td = document.createElement('td');
        td.style.cssText = 'border:1px solid #999;padding:3px 6px';
        if (cell) {
          let v = cell.value;
          if (v instanceof Error) v = v.message;
          td.textContent = (v == null) ? '' : ('' + v);
          rowHasData = true;
        }
        tr.appendChild(td);
      }
      if (rowHasData) tbl.appendChild(tr);
    }
    const wrap = document.createElement('div');
    wrap.id = 'calcPrint';
    wrap.style.cssText = 'display:none';
    wrap.appendChild(tbl);
    document.body.appendChild(wrap);
    // Reveal only for print, then clean up.
    const cleanup = () => { wrap.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    // Temporarily show it and hide everything else via a class on <body>.
    document.body.classList.add('printing-calc');
    wrap.style.display = 'block';
    // Use the @media print rules: we need a selector. Add a style that hides
    // everything except #calcPrint when body.printing-calc.
    const st = document.createElement('style');
    st.id = 'calcPrintStyle';
    st.textContent = '@media print { body.printing-calc > *:not(#calcPrint){display:none!important} #calcPrint{display:block!important} }';
    document.head.appendChild(st);
    window.print();
    // Fallback cleanup in case afterprint doesn't fire.
    setTimeout(() => {
      document.body.classList.remove('printing-calc');
      wrap.remove();
      st.remove();
    }, 1000);
  }

  // ---------- Undo ----------
  // Snapshot the pre-mutation state (cell map + charts) so it can be restored.
  function captureCalcState() {
    const dump = {};
    for (const k of Object.keys(data)) dump[k] = data[k].raw;
    return { cells: dump, charts: Util.deepClone(charts) };
  }
  function restoreCalcState(s) {
    wipeData();
    for (const k of Object.keys(s.cells)) data[k] = { raw: s.cells[k] };
    charts.length = 0;
    if (Array.isArray(s.charts)) charts.push(...Util.deepClone(s.charts));
    recalcAll(); renderAll(); renderCharts();
  }
  function snapshot() {
    History.snapshot(sheetKey(), captureCalcState(), restoreCalcState);
  }
  function doUndo() { History.undo(sheetKey()); }
  function doRedo() { History.redo(sheetKey()); }

  // ---------- Dirty + autosave ----------
  function markDirty() {
    dirty = true;
    renderTabs();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 800);
  }
  async function autosaveNow() {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    try {
      // Save every open sheet: { addr: raw } cells plus charts per sheet.
      const dumpSheets = sheets.map(s => {
        const cells = {};
        for (const k of Object.keys(s.data)) cells[k] = s.data[k].raw;
        return {
          id: s.id, name: s.name, cells, charts: s.charts,
          book: s.book || null, sheetName: s.sheetName || null,
          activeCell: s.id === activeSheetId ? activeCell : s.activeCell,
        };
      });
      await Storage.save('calc:sheets', { sheets: dumpSheets, active: activeSheetId });
      dirty = false;
    } catch (e) { /* ignore */ }
  }
  // Page is being hidden/closed: write any pending autosave now.
  function flush() {
    if (autosaveTimer) autosaveNow();
  }

  // ---------- Boot ----------
  async function boot() {
    buildToolbar();
    buildGrid();

    // Formula bar handlers
    $('calcFx').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitFormulaBar(true); }
    });
    $('calcFx').addEventListener('blur', () => { if (!switchingSheet) commitFormulaBar(false); });

    // Register undo + tabs. Per-sheet history keys are initialized lazily by
    // activateSheet(), which also binds the live data/charts to the sheet.
    tabs = Tabs.create({
      mount: $('calcTabs'),
      onActivate: activateSheet,
      onClose: closeSheet,
      onNew: newSheet,
      onReorder: reorderSheets,
      newTitle: 'New sheet',
    });

    // Restore the last session's open sheets.
    try {
      const saved = await Storage.load('calc:sheets');
      if (saved && Array.isArray(saved.sheets) && saved.sheets.length) {
        const seen = new Set();
        for (const s of saved.sheets) {
          const d = Object.create(null);
          const cells = s.cells || {};
          for (const k of Object.keys(cells)) d[k] = { raw: cells[k] };
          const ch = Array.isArray(s.charts) ? s.charts : [];
          for (const c of ch) chartSeq = Math.max(chartSeq, (parseInt(String(c.id || 'ch0').slice(2), 10) || 0) + 1);
          const id = (typeof s.id === 'string' && !seen.has(s.id)) ? s.id : null;
          if (id) seen.add(id);
          sheets.push({
            id, name: s.name || 'Sheet', data: d, charts: ch,
            activeCell: s.activeCell || 'A1',
            book: s.book || null, sheetName: s.sheetName || null,
          });
        }
        // Continue numbering after the highest id in use (not the tab count).
        sheetSeq = Util.nextSeq([...seen], 's');
        sheets.forEach(sh => { if (!sh.id) sh.id = 's' + (sheetSeq++); });
        activateSheet(saved.active && sheets.some(s => s.id === saved.active) ? saved.active : sheets[0].id);
      } else {
        // Migrate the pre-tabs single-sheet autosave (v1.2.x).
        const legacy = await Storage.load('calc:sheet');
        if (legacy && typeof legacy === 'object' && (Object.keys(legacy.cells || legacy).length || (legacy.charts || []).length)) {
          const cells = legacy.cells || legacy;
          const d = Object.create(null);
          for (const k of Object.keys(cells)) d[k] = { raw: cells[k] };
          const ch = Array.isArray(legacy.charts) ? legacy.charts : [];
          for (const c of ch) chartSeq = Math.max(chartSeq, parseInt((c.id || 'ch0').slice(2)) + 1);
          sheets.push({ id: 's1', name: 'Sheet-1', data: d, charts: ch, activeCell: 'A1' });
          sheetSeq = 2;
          activateSheet('s1');
        } else {
          addSheet();
        }
      }
    } catch (e) {
      if (!sheets.length) addSheet();
    }
  }

  function buildToolbar() {
    const tb = $('calcToolbar');
    tb.innerHTML = '';
    const btn = (label, fn, title, primary=false) => {
      const b = document.createElement('button');
      b.className = 'tb-btn' + (primary?' primary':'');
      b.innerHTML = label; b.title = title || '';
      b.onclick = fn; return b;
    };
    tb.appendChild(btn('＋ New', newSheet, 'New blank sheet'));
    tb.appendChild(btn('📂 Open', importFile, 'Import .xlsx / .csv'));
    tb.appendChild(btn('💾 Export ▾', () => exportMenu(), 'Export'));
    tb.appendChild(btn('🖨️', () => printDoc(), 'Print'));
    const sep = () => { const s = document.createElement('span'); s.className='tb-sep'; return s; };
    tb.appendChild(sep());
    tb.appendChild(btn('↶', doUndo, 'Undo (Ctrl+Z)'));
    tb.appendChild(btn('↷', doRedo, 'Redo (Ctrl+Y)'));
    tb.appendChild(sep());
    tb.appendChild(btn('⬇ Fill down', fillDown, 'Fill value down (Ctrl+D)'));
    tb.appendChild(btn('🧹 Clear sheet', clearSheet, 'Erase all cells', ));
    tb.appendChild(sep());
    tb.appendChild(btn('📉 Chart', () => addChartDialog(), 'Create a chart from a cell range'));
    tb.appendChild(sep());
    // formula bar
    const addr = document.createElement('span');
    addr.className = 'tb-label';
    addr.id = 'calcAddr';
    addr.style.minWidth = '50px';
    addr.textContent = 'A1';
    tb.appendChild(addr);
    const fx = document.createElement('span');
    fx.className = 'tb-label';
    fx.textContent = 'fx';
    tb.appendChild(fx);
    const inp = document.createElement('input');
    inp.className = 'tb-input';
    inp.id = 'calcFx';
    inp.style.flex = '1';
    inp.style.minWidth = '180px';
    inp.placeholder = 'Type a value or formula (e.g. =SUM(A1:A10))';
    tb.appendChild(inp);
  }

  function exportMenu() {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:240px';
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="tb-btn" data-x="xlsx" data-scope="one" style="justify-content:flex-start">📊 Excel (.xlsx) — this sheet</button>
        ${sheets.length > 1 ? `<button class="tb-btn" data-x="xlsx" data-scope="all" style="justify-content:flex-start">📚 Excel (.xlsx) — all ${sheets.length} open sheets</button>` : ''}
        <button class="tb-btn" data-x="csv" data-scope="one" style="justify-content:flex-start">📄 CSV (.csv) — this sheet, values only</button>
      </div>`;
    const d = UI.dialog({ title: 'Export spreadsheet', body, okText: 'Close', cancelText: null });
    d.el.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); exportFile(b.dataset.x, b.dataset.scope); });
  }

  function onActivate() {
    setTimeout(() => {
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 0);
  }

  return { boot, onActivate, flush, undo: doUndo, redo: doRedo, reopen: reopenSheet };
})();
