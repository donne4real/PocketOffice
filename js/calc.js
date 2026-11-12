/* ==========================================================================
   calc.js — Calc: the spreadsheet UI. The formula engine itself lives in
   formula.js (pure, unit-tested). Features: 1000x100 grid built lazily as
   you scroll, click-to-edit, range selection with copy/cut/paste, cell
   formatting and number formats, sort, filter, freeze top row, charts,
   multi-sheet .xlsx + .csv import/export (SheetJS, loaded on demand),
   autosave, fill-down, keyboard nav.

   A cell is { raw, value, fmt? }. fmt holds optional formatting:
   { b, i, u, al: 'l'|'c'|'r', bg, fg, nf } (nf = number-format code).
   ========================================================================== */

const Calc = (() => {
  const COLS = 100;       // A..CV
  const ROWS = 1000;
  const INITIAL_ROWS = 20;   // rows rendered at grid build; scroll loads more via ROW_CHUNK below
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
  // Selection: `sel` is the selected rectangle; activeCell is its anchor and
  // selEnd the corner that Shift+arrows and dragging move.
  let sel = { c1: 0, r1: 0, c2: 0, r2: 0 };
  let selEnd = 'A1';
  let selEl = null;             // overlay rectangle drawn over a multi-cell selection
  let dragSelecting = false;
  let clip = null;              // last copy/cut made here: { text, rows, c1, r1, cut }
  const rowHeads = [];          // row-number elements, by row index
  let hiddenRows = new Set();   // rows hidden by the active sheet's filter

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
    corner.title = 'Select all';
    corner.addEventListener('click', selectAll);
    wrap.appendChild(corner);

    const colHeader = document.createElement('div');
    colHeader.className = 'calc-colheader';
    let chHtml = '<div class="calc-spacer"></div>';
    for (let c = 0; c < COLS; c++) chHtml += `<div class="calc-colhead" data-col="${c}">${colName(c)}</div>`;
    colHeader.innerHTML = chHtml;
    colHeader.addEventListener('click', (e) => {
      const h = e.target.closest('.calc-colhead');
      if (!h) return;
      finishEdit(true);
      const c = +h.dataset.col;
      setActive(keyOf(c, 0), { scroll: false });
      selectRange(keyOf(c, 0), keyOf(c, ROWS - 1), { scroll: false });
    });
    wrap.appendChild(colHeader);

    // Row gutter + cells. Rows are created in chunks as the user scrolls
    // down (v1 built all 100,000 cells at startup).
    const scrollBody = document.createElement('div');
    scrollBody.className = 'calc-body';
    scrollBody.setAttribute('role', 'grid');
    scrollBody.setAttribute('aria-label', 'Spreadsheet grid');
    wrap.appendChild(scrollBody);
    gridBody = scrollBody;
    ensureRows(INITIAL_ROWS);

    // Mouse (click, drag-select, row headers) + keyboard + clipboard handlers
    scrollBody.addEventListener('mousedown', onCellMouseDown);
    scrollBody.addEventListener('mouseover', onCellMouseOver);
    scrollBody.addEventListener('click', onCellClick);
    scrollBody.addEventListener('copy', (e) => onCopy(e, false));
    scrollBody.addEventListener('cut', (e) => onCopy(e, true));
    scrollBody.addEventListener('paste', onPaste);
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

    selEl = document.createElement('div');
    selEl.className = 'calc-sel';
    wrap.appendChild(selEl);

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
      rowHead.setAttribute('role', 'rowheader');
      rowHead.dataset.row = r;
      rowHeads[r] = rowHead;
      frag.appendChild(rowHead);
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        const addr = keyOf(c, r);
        cell.className = 'calc-cell';
        cell.dataset.addr = addr;
        cell.tabIndex = -1;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', addr);
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
    if (from === 0) applyFreeze();
    for (let r = from; r < n; r++) if (hiddenRows.has(r)) setRowHidden(r, true);
    if (isMulti()) drawSel();
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
      <p class="muted small chart-hint">Range should include a header row/column. First column = labels (for bar/line) or categories (pie); remaining columns = numeric series.</p>`;
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

  // Destroy all Chart.js instances attached to canvases inside a container.
  // Chart.js holds internal references that outlive DOM removal, so this
  // must be called before clearing innerHTML or removing the container.
  function destroyChartInstances(container) {
    if (!container) return;
    container.querySelectorAll('canvas').forEach(c => {
      if (c._chart) { c._chart.destroy(); c._chart = null; }
    });
  }

  function renderCharts() {
    const layer = $('calcChartLayer');
    if (!layer) return;
    if (charts.length && !Libs.isReady('chart')) {
      // Chart.js loads on first use; draw once it's here.
      Libs.need('chart').then(renderCharts).catch(e => UI.toast(e.message, 'error'));
      return;
    }
    // Destroy existing Chart.js instances before clearing the layer to
    // prevent memory leaks (Chart.js holds references to canvas contexts).
    destroyChartInstances(layer);
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
          <span class="flex-spacer"></span>
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
  // What a cell shows: its value under the cell's number format.
  function displayOf(cell) {
    if (!cell || cell.raw === '' || cell.raw == null) return { text: '', kind: '' };
    const v = cell.value;
    if (typeof v === 'number') return { text: Formula.formatValue(v, cell.fmt && cell.fmt.nf), kind: 'calc-num' };
    if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', kind: 'calc-bool' };
    if (Formula.isErr(v)) return { text: v, kind: 'calc-err' };
    return { text: v == null ? '' : '' + v, kind: 'calc-str' };
  }
  const ALIGN = { l: 'left', c: 'center', r: 'right' };
  function paintFmt(el, fmt) {
    const st = el.style;
    const bg = fmt && fmt.bg ? Util.safeColor(fmt.bg, '') : '';
    const fg = fmt && fmt.fg ? Util.safeColor(fmt.fg, '') : '';
    st.fontWeight = fmt && fmt.b ? '700' : '';
    st.fontStyle = fmt && fmt.i ? 'italic' : '';
    st.textDecoration = fmt && fmt.u ? 'underline' : '';
    st.textAlign = (fmt && ALIGN[fmt.al]) || '';
    st.backgroundColor = bg;
    // A filled cell keeps dark text in dark mode, where the default is light.
    st.color = fg || (bg ? '#111' : '');
  }
  function renderCell(addr) {
    const el = cellEls.get(addr);
    if (!el) return;
    const cell = data[addr];
    const { text, kind } = displayOf(cell);
    const sig = cell && cell.fmt ? JSON.stringify(cell.fmt) : '';
    if (el._sig !== sig) { paintFmt(el, cell && cell.fmt); el._sig = sig; }
    if (el._shown === text && el._kind === kind) return;
    el.textContent = text;
    el.setAttribute('aria-label', text ? addr + ' ' + text : addr);
    el.classList.remove('calc-num', 'calc-str', 'calc-bool', 'calc-err');
    if (kind) el.classList.add(kind);
    el._shown = text;
    el._kind = kind;
  }

  // ---------- Cell model helpers ----------
  const rawOf = (addr) => (data[addr] && data[addr].raw) || '';
  // Set a cell's content. Clearing keeps the cell's formatting, like Excel.
  function setRaw(addr, raw) {
    const cell = data[addr];
    if (raw === '' || raw == null) {
      if (cell && cell.fmt) { cell.raw = ''; cell.value = ''; }
      else delete data[addr];
    } else if (cell) cell.raw = raw;
    else data[addr] = { raw };
  }
  // Keep only formatting we understand (loaded files are untrusted).
  function cleanFmt(f) {
    if (!f || typeof f !== 'object') return null;
    const out = {};
    if (f.b === true) out.b = true;
    if (f.i === true) out.i = true;
    if (f.u === true) out.u = true;
    if (ALIGN[f.al]) out.al = f.al;
    const bg = Util.safeColor(f.bg, ''), fg = Util.safeColor(f.fg, '');
    if (bg) out.bg = bg;
    if (fg) out.fg = fg;
    if (typeof f.nf === 'string' && f.nf && f.nf.length <= 80 && !/^general$/i.test(f.nf)) out.nf = f.nf;
    return Object.keys(out).length ? out : null;
  }
  function makeCell(raw, fmt) {
    const cell = { raw: raw == null ? '' : raw };
    const f = cleanFmt(fmt);
    if (f) cell.fmt = f;
    return cell;
  }
  // Addresses that exist in `data` inside a rectangle (cheap for huge selections).
  function cellsIn(g) {
    const out = [];
    for (const addr of Object.keys(data)) {
      const a = parseAddr(addr);
      if (a && a.col >= g.c1 && a.col <= g.c2 && a.row >= g.r1 && a.row <= g.r2) out.push(addr);
    }
    return out;
  }
  const hasRaw = (cell) => !!cell && cell.raw !== '' && cell.raw != null;
  function usedBounds() {
    let c1 = Infinity, r1 = Infinity, c2 = -1, r2 = -1;
    for (const addr of Object.keys(data)) {
      if (!hasRaw(data[addr])) continue;
      const a = parseAddr(addr);
      if (!a) continue;
      c1 = Math.min(c1, a.col); r1 = Math.min(r1, a.row);
      c2 = Math.max(c2, a.col); r2 = Math.max(r2, a.row);
    }
    return c2 < 0 ? null : { c1, r1, c2, r2 };
  }
  // Trim a (possibly whole-column) rectangle to the part that holds data.
  function clampToUsed(g) {
    const u = usedBounds();
    if (!u) return { c1: g.c1, r1: g.r1, c2: g.c1, r2: g.r1 };
    return { c1: g.c1, r1: g.r1, c2: Math.max(g.c1, Math.min(g.c2, u.c2)), r2: Math.max(g.r1, Math.min(g.r2, u.r2)) };
  }

  // ---------- Selection ----------
  const isMulti = () => sel.c1 !== sel.c2 || sel.r1 !== sel.r2;
  const rangeLabel = (g) => keyOf(g.c1, g.r1) + (g.c1 === g.c2 && g.r1 === g.r2 ? '' : ':' + keyOf(g.c2, g.r2));

  function selectRange(anchorAddr, endAddr, { scroll = true } = {}) {
    const a = parseAddr(anchorAddr), b = parseAddr(endAddr);
    if (!a || !b) return;
    sel = { c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row), c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row) };
    selEnd = endAddr;
    if (scroll) {
      ensureRows(b.row + 1 + 20);
      const el = cellEls.get(endAddr);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    drawSel();
  }
  function selectAll() {
    finishEdit(true);
    const u = usedBounds();
    setActive('A1', { scroll: false });
    selectRange('A1', u ? keyOf(u.c2, u.r2) : keyOf(COLS - 1, ROWS - 1), { scroll: false });
  }
  function drawSel() {
    updateSelStatus();
    if (!selEl) return;
    let top = sel.r1, bottom = Math.min(sel.r2, renderedRows - 1);
    while (top <= bottom && hiddenRows.has(top)) top++;
    while (bottom >= top && hiddenRows.has(bottom)) bottom--;
    const a = cellEls.get(keyOf(sel.c1, top)), b = cellEls.get(keyOf(sel.c2, bottom));
    if (!isMulti() || !a || !b || top > bottom) { selEl.style.display = 'none'; return; }
    selEl.style.display = 'block';
    selEl.style.left = a.offsetLeft + 'px';
    selEl.style.top = a.offsetTop + 'px';
    selEl.style.width = (b.offsetLeft + b.offsetWidth - a.offsetLeft) + 'px';
    selEl.style.height = (b.offsetTop + b.offsetHeight - a.offsetTop) + 'px';
  }
  // Status bar: range, and Sum / Average / Count like a desktop spreadsheet.
  function updateSelStatus() {
    const info = $('statusInfo');
    const panel = $('panel-calc');
    if (!info || !panel || !panel.classList.contains('active')) return;
    if (!isMulti()) { info.textContent = ''; return; }
    let sum = 0, nums = 0, count = 0;
    for (const addr of cellsIn(sel)) {
      const cell = data[addr];
      if (!hasRaw(cell)) continue;
      count++;
      if (typeof cell.value === 'number') { sum += cell.value; nums++; }
    }
    info.textContent = rangeLabel(sel) +
      (nums ? ' · Sum ' + formatNumber(sum) + ' · Average ' + formatNumber(sum / nums) : '') + ' · Count ' + count;
  }

  function onCellMouseDown(e) {
    if (e.button !== 0) return;
    const head = e.target.closest('.calc-rowhead');
    if (head) {
      finishEdit(true);
      const r = +head.dataset.row;
      setActive(keyOf(0, r), { scroll: false });
      selectRange(keyOf(0, r), keyOf(COLS - 1, r), { scroll: false });
      e.preventDefault();
      return;
    }
    const el = e.target.closest('.calc-cell');
    if (!el || editingCell === el.dataset.addr) return;
    // A pending formula-bar edit belongs to the cell that is still active.
    if (document.activeElement === $('calcFx')) commitFormulaBar(false);
    finishEdit(true);
    if (e.shiftKey) selectRange(activeCell, el.dataset.addr);
    else setActive(el.dataset.addr);
    dragSelecting = true;
    e.preventDefault();
  }
  function onCellMouseOver(e) {
    if (!dragSelecting) return;
    const el = e.target.closest('.calc-cell');
    if (el && el.dataset.addr !== selEnd) selectRange(activeCell, el.dataset.addr, { scroll: false });
  }

  // ---------- Clipboard ----------
  // Copy puts tab-separated display text on the system clipboard (so it
  // pastes into Excel, Word, e-mail…) and remembers the raw cells. A paste
  // of that same text uses the remembered cells, so formulas keep working
  // (relative references shift) and formatting comes along.
  const tsvField = (t) => /["\t\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  function parseTsv(text) {
    const rows = [[]];
    let i = 0, field = '';
    const n = text.length;
    const endField = () => { rows[rows.length - 1].push(field); field = ''; };
    while (i < n) {
      const c = text[i];
      if (c === '"' && field === '') {
        // Quoted field: may contain tabs/newlines; "" is an escaped quote.
        i++;
        while (i < n) {
          if (text[i] === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } i++; break; }
          field += text[i++];
        }
        continue;
      }
      if (c === '\t') { endField(); i++; continue; }
      if (c === '\n') { endField(); rows.push([]); i++; continue; }
      field += c; i++;
    }
    endField();
    return rows;
  }
  function copySelection(cut) {
    const g = clampToUsed(sel);
    const rows = [];
    for (let r = g.r1; r <= g.r2; r++) {
      const row = [];
      for (let c = g.c1; c <= g.c2; c++) {
        const cell = data[keyOf(c, r)];
        row.push(cell ? { raw: cell.raw || '', fmt: cell.fmt ? Object.assign({}, cell.fmt) : null, text: displayOf(cell).text } : null);
      }
      rows.push(row);
    }
    const text = rows.map(row => row.map(x => tsvField(x ? x.text : '')).join('\t')).join('\n');
    clip = { text, rows, c1: g.c1, r1: g.r1, cut };
    if (cut) {
      const addrs = cellsIn(g);
      if (addrs.length) {
        snapshot();
        addrs.forEach(a => { delete data[a]; });
        recalcAll(); renderAll(); addrs.forEach(renderCell);
        $('calcFx').value = rawOf(activeCell);
        markDirty();
      }
    }
    return text;
  }
  function onCopy(e, cut) {
    if (editingCell || !e.target.classList || !e.target.classList.contains('calc-cell')) return;
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', copySelection(cut));
    e.preventDefault();
  }
  function onPaste(e) {
    if (editingCell || !e.target.classList || !e.target.classList.contains('calc-cell')) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    pasteText(e.clipboardData.getData('text/plain'));
  }
  function pasteText(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const own = clip && (text === clip.text || text === clip.text + '\n');
    let rows;
    if (own) rows = clip.rows;
    else {
      if (text.endsWith('\n')) text = text.slice(0, -1);
      if (text === '') return;
      rows = parseTsv(text).map(row => row.map(t => t === '' ? null : { raw: t }));
    }
    const h = rows.length, w = Math.max(...rows.map(r => r.length));
    // One copied cell fills the whole selection; a block lands at its top-left.
    const fill = h === 1 && w === 1 && isMulti();
    const g = fill ? { c1: sel.c1, r1: sel.r1, c2: sel.c2, r2: Math.min(sel.r2, sel.r1 + 4999) }
                   : { c1: sel.c1, r1: sel.r1, c2: sel.c1 + w - 1, r2: sel.r1 + h - 1 };
    const clipped = g.c2 > COLS - 1 || g.r2 > ROWS - 1;
    g.c2 = Math.min(g.c2, COLS - 1); g.r2 = Math.min(g.r2, ROWS - 1);
    snapshot();
    const touched = [];
    for (let r = g.r1; r <= g.r2; r++) {
      for (let c = g.c1; c <= g.c2; c++) {
        const src = fill ? rows[0][0] : (rows[r - g.r1] || [])[c - g.c1];
        const addr = keyOf(c, r);
        touched.push(addr);
        if (own) {
          if (!src || (src.raw === '' && !src.fmt)) { delete data[addr]; continue; }
          // Cut moves formulas as they are; copy shifts relative references.
          const srcRow = fill ? clip.r1 : clip.r1 + (r - g.r1), srcCol = fill ? clip.c1 : clip.c1 + (c - g.c1);
          const raw = clip.cut ? src.raw : Formula.shiftRefs(src.raw, r - srcRow, c - srcCol);
          data[addr] = makeCell(raw, src.fmt);
        } else {
          setRaw(addr, src ? src.raw : '');
        }
      }
    }
    recalcAll(); renderAll(); touched.forEach(renderCell);
    markDirty();
    setActive(keyOf(g.c1, g.r1));
    selectRange(keyOf(g.c1, g.r1), keyOf(g.c2, g.r2), { scroll: false });
    if (clipped) UI.toast('Some pasted cells fell outside the sheet and were dropped.', 'warn');
  }

  // ---------- Formatting ----------
  const BIG_SELECTION = 5000;
  // Merge `patch` into the format of every selected cell. A null/false/''
  // value removes that property; patch === null clears all formatting.
  function formatSelection(patch) {
    if (editingCell) finishEdit(true);
    let g = sel;
    const size = (g.c2 - g.c1 + 1) * (g.r2 - g.r1 + 1);
    if (size > BIG_SELECTION) {
      g = clampToUsed(sel);
      UI.toast('Large selection: formatting was applied to the part that holds data.', 'info');
    }
    snapshot();
    for (let r = g.r1; r <= g.r2; r++) {
      for (let c = g.c1; c <= g.c2; c++) {
        const addr = keyOf(c, r);
        let cell = data[addr];
        const fmt = patch === null ? {} : Object.assign({}, cell && cell.fmt, patch);
        for (const k of Object.keys(fmt)) if (fmt[k] === null || fmt[k] === false || fmt[k] === '') delete fmt[k];
        if (Object.keys(fmt).length) {
          if (!cell) cell = data[addr] = { raw: '' };
          cell.fmt = fmt;
        } else if (cell) {
          delete cell.fmt;
          if (!hasRaw(cell)) delete data[addr];
        }
        renderCell(addr);
      }
    }
    markDirty();
    syncFormatBar();
    updateSelStatus();
  }
  const activeFmt = () => (data[activeCell] && data[activeCell].fmt) || {};
  function toggleFmt(key) { formatSelection({ [key]: !activeFmt()[key] }); }
  function setAlign(al) { formatSelection({ al: activeFmt().al === al ? null : al }); }

  // Add or remove one decimal place in a number-format code.
  function adjustDecimals(code, delta) {
    if (!code || /^general$/i.test(code)) code = '0';
    if (/[ymdhs]/i.test(code.replace(/"[^"]*"/g, '')) && !/[#0]/.test(code)) return code;   // date/time
    const m = /\.(0+)/.exec(code);
    if (m) {
      const n = Math.max(0, m[1].length + delta);
      return code.slice(0, m.index) + (n ? '.' + '0'.repeat(Math.min(n, 10)) : '') + code.slice(m.index + m[0].length);
    }
    if (delta < 0) return code;
    // No decimals yet: add ".0" after the last digit placeholder.
    const last = Math.max(code.lastIndexOf('0'), code.lastIndexOf('#'));
    return last < 0 ? code : code.slice(0, last + 1) + '.0' + code.slice(last + 1);
  }
  function changeDecimals(delta) {
    formatSelection({ nf: adjustDecimals(activeFmt().nf, delta) });
  }

  const NUMBER_FORMATS = [
    ['', 'General'],
    ['#,##0.00', 'Number  1,234.50'],
    ['#,##0', 'Whole number  1,235'],
    ['$#,##0.00', 'Currency  $1,234.50'],
    ['€#,##0.00', 'Currency  €1,234.50'],
    ['£#,##0.00', 'Currency  £1,234.50'],
    ['¥#,##0', 'Currency  ¥1,235'],
    ['₹#,##0.00', 'Currency  ₹1,234.50'],
    ['₦#,##0.00', 'Currency  ₦1,234.50'],
    ['0%', 'Percent  12%'],
    ['0.00%', 'Percent  12.34%'],
    ['yyyy-mm-dd', 'Date  2026-09-23'],
    ['dd/mm/yyyy', 'Date  23/09/2026'],
    ['mm/dd/yyyy', 'Date  09/23/2026'],
    ['d mmm yyyy', 'Date  23 Sep 2026'],
    ['hh:mm', 'Time  14:30'],
    ['0.00E+00', 'Scientific  1.23E+03'],
  ];

  // Reflect the active cell's formatting in the format bar.
  function syncFormatBar() {
    const bar = $('calcFormatBar');
    if (!bar) return;
    const f = activeFmt();
    bar.querySelectorAll('[data-fmt]').forEach(b => {
      const [k, v] = b.dataset.fmt.split(':');
      const on = v ? f[k] === v : !!f[k];
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const selNf = $('calcNumFmt');
    if (selNf) {
      const nf = f.nf || '';
      let custom = selNf.querySelector('option[data-custom]');
      if (NUMBER_FORMATS.some(x => x[0] === nf)) { if (custom) custom.remove(); }
      else {
        if (!custom) { custom = document.createElement('option'); custom.dataset.custom = '1'; selNf.appendChild(custom); }
        custom.value = nf; custom.textContent = 'Custom  ' + nf;
      }
      selNf.value = nf;
    }
    const sh = activeSheet();
    const fz = $('calcFreezeBtn'), fl = $('calcFilterBtn');
    if (fz) { fz.classList.toggle('active', !!(sh && sh.freeze)); fz.setAttribute('aria-pressed', sh && sh.freeze ? 'true' : 'false'); }
    if (fl) {
      fl.classList.toggle('active', !!(sh && sh.filter));
      fl.setAttribute('aria-pressed', sh && sh.filter ? 'true' : 'false');
      fl.textContent = sh && sh.filter ? '🔎 Clear filter' : '🔎 Filter';
    }
  }

  // ---------- Sort / filter / freeze ----------
  // The block a sort or filter works on: the selection if several cells are
  // selected, otherwise everything on the sheet that holds data.
  function dataRegion() {
    return isMulti() ? clampToUsed(sel) : usedBounds();
  }
  const valueAt = (c, r) => { const cell = data[keyOf(c, r)]; return hasRaw(cell) ? cell.value : ''; };
  // A first row of text above a number is taken to be a header.
  function guessHeader(g, col) {
    const sh = activeSheet();
    if (sh && sh.freeze && g.r1 === 0) return true;
    if (g.r2 <= g.r1) return false;
    for (let c = g.c1; c <= g.c2; c++) {
      if (typeof valueAt(c, g.r1) === 'string' && valueAt(c, g.r1) !== '' && typeof valueAt(c, g.r1 + 1) === 'number') return true;
    }
    return typeof valueAt(col, g.r1) === 'string' && valueAt(col, g.r1) !== '' && g.r2 - g.r1 >= 2;
  }
  function columnOptions(select, g, chosen) {
    for (let c = g.c1; c <= g.c2; c++) {
      const o = document.createElement('option');
      const head = valueAt(c, g.r1);
      o.value = c;
      o.textContent = 'Column ' + colName(c) + (typeof head === 'string' && head ? ' — ' + head.slice(0, 40) : '');
      if (c === chosen) o.selected = true;
      select.appendChild(o);
    }
  }
  // Excel ordering: numbers, then text (case-insensitive), then TRUE/FALSE,
  // then errors; blanks always sink to the bottom.
  function sortRank(v) {
    if (v === '' || v == null) return 4;
    if (typeof v === 'number') return 0;
    if (typeof v === 'boolean') return 2;
    return Formula.isErr(v) ? 3 : 1;
  }
  function sortCompare(a, b, asc) {
    const ra = sortRank(a), rb = sortRank(b);
    if (ra === 4 || rb === 4) return ra - rb;
    if (ra !== rb) return asc ? ra - rb : rb - ra;
    let c;
    if (ra === 1) c = a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    else c = a < b ? -1 : a > b ? 1 : 0;
    return asc ? c : -c;
  }
  function sortRange(g, col, asc, header) {
    const r0 = g.r1 + (header ? 1 : 0);
    if (r0 >= g.r2) return;
    const rows = [];
    for (let r = r0; r <= g.r2; r++) {
      const cells = [];
      for (let c = g.c1; c <= g.c2; c++) cells.push(data[keyOf(c, r)] || null);
      rows.push({ r, key: valueAt(col, r), cells });
    }
    rows.sort((x, y) => sortCompare(x.key, y.key, asc) || x.r - y.r);
    snapshot();
    rows.forEach((row, i) => {
      const r = r0 + i;
      row.cells.forEach((src, j) => {
        const addr = keyOf(g.c1 + j, r);
        // A moved formula keeps pointing at its own row.
        if (src) data[addr] = makeCell(Formula.shiftRefs(src.raw, r - row.r, 0), src.fmt);
        else delete data[addr];
      });
    });
    recalcAll(); renderAll();
    for (let r = r0; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) renderCell(keyOf(c, r));
    $('calcFx').value = rawOf(activeCell);
    applyFilter();
    markDirty();
  }
  function sortDialog() {
    if (editingCell) finishEdit(true);
    const g = dataRegion();
    if (!g || g.r2 <= g.r1) { UI.toast('Nothing to sort — enter some rows first.', 'warn'); return; }
    const a = parseAddr(activeCell);
    const col = a && a.col >= g.c1 && a.col <= g.c2 ? a.col : g.c1;
    const body = document.createElement('div');
    body.style.cssText = 'min-width:340px';
    body.innerHTML = `
      <p class="muted small">Sorting rows of <b></b>.</p>
      <div class="row"><label for="srtCol">Sort by</label><select id="srtCol"></select></div>
      <div class="row"><label for="srtDir">Order</label>
        <select id="srtDir"><option value="asc">A → Z, smallest first</option><option value="desc">Z → A, largest first</option></select></div>
      <div class="row"><label><input type="checkbox" id="srtHead"> First row is a header (keep it on top)</label></div>`;
    body.querySelector('b').textContent = rangeLabel(g);
    columnOptions(body.querySelector('#srtCol'), g, col);
    body.querySelector('#srtHead').checked = guessHeader(g, col);
    UI.dialog({
      title: 'Sort', body, okText: 'Sort',
      onOk: () => {
        sortRange(g, +body.querySelector('#srtCol').value, body.querySelector('#srtDir').value === 'asc', body.querySelector('#srtHead').checked);
        focusActiveCell();
      },
    });
  }

  const FILTER_OPS = [
    ['contains', 'contains'], ['notcontains', 'does not contain'], ['eq', 'equals'], ['ne', 'does not equal'],
    ['gt', 'is greater than'], ['lt', 'is less than'], ['notempty', 'is not empty'], ['empty', 'is empty'],
  ];
  function rowPasses(f, r) {
    const cell = data[keyOf(f.col, r)];
    const v = hasRaw(cell) ? cell.value : '';
    const text = displayOf(cell).text.toLowerCase();
    const want = String(f.value).trim().toLowerCase();
    const num = want !== '' && !isNaN(want) ? parseFloat(want) : null;
    const same = num !== null && typeof v === 'number' ? v === num : text === want;
    switch (f.op) {
      case 'contains': return text.includes(want);
      case 'notcontains': return !text.includes(want);
      case 'eq': return same;
      case 'ne': return !same;
      case 'gt': return num !== null ? typeof v === 'number' && v > num : text !== '' && text > want;
      case 'lt': return num !== null ? typeof v === 'number' && v < num : text !== '' && text < want;
      case 'empty': return text === '';
      case 'notempty': return text !== '';
    }
    return true;
  }
  function setRowHidden(r, hide) {
    if (!rowHeads[r]) return;
    rowHeads[r].classList.toggle('row-hidden', hide);
    for (let c = 0; c < COLS; c++) {
      const el = cellEls.get(keyOf(c, r));
      if (el) el.classList.toggle('row-hidden', hide);
    }
  }
  // Show/hide rows for the active sheet's filter (a view setting: rows are
  // hidden, never removed, and it is not saved with the sheet).
  function applyFilter() {
    const sh = activeSheet();
    const f = sh && sh.filter;
    const next = new Set();
    if (f) for (let r = f.r1 + (f.header ? 1 : 0); r <= f.r2; r++) if (!rowPasses(f, r)) next.add(r);
    for (let r = 0; r < renderedRows; r++) {
      const hide = next.has(r);
      if (hide !== hiddenRows.has(r)) setRowHidden(r, hide);
    }
    hiddenRows = next;
    if (gridBody) gridBody.classList.toggle('filtered', !!f);
    const a = parseAddr(activeCell);
    if (a && hiddenRows.has(a.row)) {
      let r = a.row;
      while (r < ROWS - 1 && hiddenRows.has(r)) r++;
      if (hiddenRows.has(r)) { r = a.row; while (r > 0 && hiddenRows.has(r)) r--; }
      setActive(keyOf(a.col, r));
    }
    drawSel();
    syncFormatBar();
    return f ? { shown: f.r2 - f.r1 - (f.header ? 1 : 0) + 1 - next.size, total: f.r2 - f.r1 - (f.header ? 1 : 0) + 1 } : null;
  }
  function filterDialog() {
    if (editingCell) finishEdit(true);
    const sh = activeSheet();
    if (sh.filter) { sh.filter = null; applyFilter(); UI.toast('Filter cleared — all rows shown.', 'info'); return; }
    const g = dataRegion();
    if (!g || g.r2 <= g.r1) { UI.toast('Nothing to filter — enter some rows first.', 'warn'); return; }
    const a = parseAddr(activeCell);
    const col = a && a.col >= g.c1 && a.col <= g.c2 ? a.col : g.c1;
    const body = document.createElement('div');
    body.style.cssText = 'min-width:340px';
    body.innerHTML = `
      <p class="muted small">Show only the rows of <b></b> where:</p>
      <div class="row"><label for="fltCol">Column</label><select id="fltCol"></select></div>
      <div class="row"><label for="fltOp">Condition</label><select id="fltOp"></select></div>
      <div class="row"><label for="fltVal">Value</label><input type="text" id="fltVal"></div>
      <div class="row"><label><input type="checkbox" id="fltHead"> First row is a header (always shown)</label></div>
      <p class="muted small">Hidden rows are kept. Click “Clear filter” to show everything again.</p>`;
    body.querySelector('b').textContent = rangeLabel(g);
    columnOptions(body.querySelector('#fltCol'), g, col);
    const opSel = body.querySelector('#fltOp');
    for (const [v, label] of FILTER_OPS) { const o = document.createElement('option'); o.value = v; o.textContent = label; opSel.appendChild(o); }
    body.querySelector('#fltHead').checked = guessHeader(g, col);
    UI.dialog({
      title: 'Filter rows', body, okText: 'Apply filter',
      onOk: () => {
        sh.filter = {
          c1: g.c1, r1: g.r1, c2: g.c2, r2: g.r2,
          col: +body.querySelector('#fltCol').value, op: opSel.value,
          value: body.querySelector('#fltVal').value, header: body.querySelector('#fltHead').checked,
        };
        const res = applyFilter();
        UI.toast(res.shown + ' of ' + res.total + ' rows shown', 'success');
        focusActiveCell();
      },
    });
    setTimeout(() => { const v = body.querySelector('#fltVal'); if (v) v.focus(); }, 0);
  }
  // Keep row 1 in view while scrolling (per sheet, saved with it).
  function applyFreeze() {
    const sh = activeSheet();
    const on = !!(sh && sh.freeze);
    if (rowHeads[0]) rowHeads[0].classList.toggle('frozen', on);
    for (let c = 0; c < COLS; c++) {
      const el = cellEls.get(keyOf(c, 0));
      if (el) el.classList.toggle('frozen', on);
    }
  }
  function toggleFreeze() {
    const sh = activeSheet();
    sh.freeze = !sh.freeze;
    applyFreeze();
    syncFormatBar();
    markDirty();
    UI.toast(sh.freeze ? 'Row 1 stays visible while you scroll.' : 'Row 1 unfrozen.', 'info');
  }
  const forgetPaint = (el) => { if (el) { el._shown = undefined; el._kind = undefined; } };

  function renderAll() {
    for (const addr of Object.keys(data)) renderCell(addr);
  }

  // ---------- Editing ----------
  // Make `addr` the active cell. Unless keepSel is set, the selection
  // collapses to it.
  function setActive(addr, { scroll = true, keepSel = false } = {}) {
    if (activeEl) { activeEl.classList.remove('active'); activeEl.removeAttribute('aria-selected'); }
    activeCell = addr;
    const pos = parseAddr(addr);
    if (pos) ensureRows(pos.row + 1 + 20);
    const el = cellEls.get(addr);
    activeEl = el || null;
    // The formula bar shows raw content. Refresh it before moving focus:
    // focusing the cell blurs the bar, and that blur-commit must find the
    // new cell's own text there, not the previous cell's.
    $('calcFx').value = rawOf(addr);
    $('calcAddr').textContent = addr;
    if (el) {
      el.classList.add('active');
      el.setAttribute('aria-selected', 'true');
      if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // Focus the cell so keyboard events (typing, arrows, Enter, Delete)
      // reach the grid handler. tabIndex=-1 allows programmatic focus only.
      if (!editingCell) el.focus({ preventScroll: true });
    }
    if (!keepSel && pos) {
      sel = { c1: pos.col, r1: pos.row, c2: pos.col, r2: pos.row };
      selEnd = addr;
      drawSel();
    }
    syncFormatBar();
  }

  // Real mouse clicks are handled on mousedown (so dragging can select);
  // this covers keyboard/assistive-technology activation, which has detail 0.
  function onCellClick(e) {
    if (e.detail > 0) return;
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
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      // Ctrl+D: fill down (was advertised in the tooltip but never wired).
      if (k === 'd') { e.preventDefault(); fillDown(); return; }
      if (k === 'a') { e.preventDefault(); selectAll(); return; }
      if (k === 'b' || k === 'i' || k === 'u') { e.preventDefault(); toggleFmt(k); return; }
    }
    // Shift+arrows grow or shrink the selection from the active cell.
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
      if (d) selectRange(activeCell, stepFrom(selEnd, d[0], d[1]));
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
        clearContents();
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
  // The cell one step from `addr`, skipping rows hidden by a filter.
  function stepFrom(addr, dc, dr) {
    const a = parseAddr(addr);
    const c = Math.max(0, Math.min(COLS - 1, a.col + dc));
    let r = Math.max(0, Math.min(ROWS - 1, a.row + dr));
    while (dr && hiddenRows.has(r) && r + dr >= 0 && r + dr <= ROWS - 1) r += dr;
    if (hiddenRows.has(r)) r = a.row;
    return keyOf(c, r);
  }
  function moveActive(dc, dr) {
    setActive(stepFrom(activeCell, dc, dr));
  }
  // Delete/Backspace: empty every selected cell (formatting stays).
  function clearContents() {
    const addrs = cellsIn(sel).filter(a => hasRaw(data[a]));
    if (!addrs.length) return;
    snapshot();
    addrs.forEach(a => setRaw(a, ''));
    recalcAll(); renderAll(); addrs.forEach(renderCell);
    $('calcFx').value = ''; markDirty();
    updateSelStatus();
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
      setRaw(addr, raw);
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
    setRaw(activeCell, v);
    recalcAll(); renderAll(); renderCell(activeCell); markDirty();
    if (fromEnter) focusActiveCell();
  }
  function focusActiveCell() {
    if (activeEl) activeEl.focus({ preventScroll: true });
  }

  // ---------- Fill / clear ----------
  // Copy the active cell into the one below and move there. Formulas are
  // adjusted like Excel's: =A1*2 becomes =A2*2, $A$1 stays put.
  // With several rows selected, the top row is copied down through the
  // selection instead (Excel's Ctrl+D).
  function fillDown() {
    if (editingCell) finishEdit(true);
    if (sel.r2 > sel.r1) {
      const g = { c1: sel.c1, r1: sel.r1, c2: sel.c2, r2: sel.r2 };
      if ((g.c2 - g.c1 + 1) * (g.r2 - g.r1 + 1) > 20000) { UI.toast('Selection is too large to fill — select fewer cells.', 'warn'); return; }
      snapshot();
      const touched = [];
      for (let c = g.c1; c <= g.c2; c++) {
        const src = data[keyOf(c, g.r1)];
        for (let r = g.r1 + 1; r <= g.r2; r++) {
          const addr = keyOf(c, r);
          touched.push(addr);
          if (src && (hasRaw(src) || src.fmt)) data[addr] = makeCell(Formula.shiftRefs(src.raw || '', r - g.r1, 0), src.fmt);
          else delete data[addr];
        }
      }
      recalcAll(); renderAll(); touched.forEach(renderCell); markDirty();
      updateSelStatus();
      return;
    }
    const a = parseAddr(activeCell);
    if (!a || a.row + 1 >= ROWS) return;
    const src = data[activeCell];
    const below = keyOf(a.col, a.row + 1);
    snapshot();
    if (src) data[below] = makeCell(Formula.shiftRefs(src.raw || '', 1, 0), src.fmt);
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
        activeSheet().filter = null;
        applyFilter();
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
    const sheet = { id, name, data: d || Object.create(null), charts: c, activeCell: 'A1', book, sheetName, freeze: false, filter: null };
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
      applyFreeze();
      applyFilter();
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
      // Destroy Chart.js instances for this sheet before removing it.
      destroyChartInstances($('calcChartLayer'));
      // Park the closed sheet for Ctrl+Shift+T reopen. For the active sheet
      // the live bindings ARE its data (shared references), so snapshot as-is.
      closedSheets.unshift({ id: s.id, name: s.name, data: s.data, charts: s.charts, activeCell: s.activeCell, book: s.book, sheetName: s.sheetName, freeze: !!s.freeze });
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
    sheets.push({ id: s.id, name: s.name, data: s.data, charts: s.charts, activeCell: s.activeCell, book: s.book, sheetName: s.sheetName, freeze: !!s.freeze, filter: null });
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
      const wb = XLSX.read(f.bytes, { type: 'array', cellNF: true });
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
      if (firstId === activeSheetId) { recalcAll(); renderAll(); renderTabs(); setActive(activeCell); }
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
        // Number formats (dates, currency, percent…) come along; SheetJS CE
        // does not read fonts or fills.
        if (raw !== '') cells[addr] = makeCell(raw, cell.t === 'n' && typeof cell.z === 'string' ? { nf: cell.z } : null);
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
          if (cell.fmt && cell.fmt.nf && out.t === 'n') {
            if (fmt === 'xlsx') out.z = cell.fmt.nf;                       // Excel shows the same format
            else out = { t: 's', v: Formula.formatValue(v, cell.fmt.nf) };   // CSV: what you see
          }
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
        if (hasRaw(cell)) {
          const shown = displayOf(cell);
          td.textContent = shown.text;
          if (shown.kind === 'calc-num') td.style.textAlign = 'right';
          const f = cell.fmt;
          if (f) {
            if (f.b) td.style.fontWeight = '700';
            if (f.i) td.style.fontStyle = 'italic';
            if (f.u) td.style.textDecoration = 'underline';
            if (ALIGN[f.al]) td.style.textAlign = ALIGN[f.al];
          }
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
    const dump = {}, fmts = {};
    for (const k of Object.keys(data)) {
      if (hasRaw(data[k])) dump[k] = data[k].raw;
      if (data[k].fmt) fmts[k] = Object.assign({}, data[k].fmt);
    }
    return { cells: dump, fmts, charts: Util.deepClone(charts) };
  }
  function restoreCalcState(s) {
    wipeData();
    const fmts = s.fmts || {};
    for (const k of Object.keys(s.cells)) data[k] = makeCell(s.cells[k], fmts[k]);
    for (const k of Object.keys(fmts)) if (!data[k]) data[k] = makeCell('', fmts[k]);
    charts.length = 0;
    if (Array.isArray(s.charts)) charts.push(...Util.deepClone(s.charts));
    recalcAll(); renderAll(); renderCharts();
    $('calcFx').value = rawOf(activeCell);
    applyFilter();
    syncFormatBar();
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
        const cells = {}, fmts = {};
        for (const k of Object.keys(s.data)) {
          if (hasRaw(s.data[k])) cells[k] = s.data[k].raw;
          if (s.data[k].fmt) fmts[k] = s.data[k].fmt;
        }
        return {
          id: s.id, name: s.name, cells, fmts, freeze: !!s.freeze, charts: s.charts,
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
    buildFormatBar();
    buildGrid();
    document.addEventListener('mouseup', () => { dragSelecting = false; });

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
          const fmts = (s.fmts && typeof s.fmts === 'object') ? s.fmts : {};
          for (const k of Object.keys(cells)) d[k] = makeCell(cells[k], fmts[k]);
          for (const k of Object.keys(fmts)) {
            if (!d[k] && parseAddr(k)) { const cell = makeCell('', fmts[k]); if (cell.fmt) d[k] = cell; }
          }
          const ch = Array.isArray(s.charts) ? s.charts : [];
          for (const c of ch) chartSeq = Math.max(chartSeq, (parseInt(String(c.id || 'ch0').slice(2), 10) || 0) + 1);
          const id = (typeof s.id === 'string' && !seen.has(s.id)) ? s.id : null;
          if (id) seen.add(id);
          sheets.push({
            id, name: s.name || 'Sheet', data: d, charts: ch,
            activeCell: s.activeCell || 'A1',
            book: s.book || null, sheetName: s.sheetName || null,
            freeze: !!s.freeze, filter: null,
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
    const btn = (label, fn, title, primary=false) => UI.button(label, { title, primary, onClick: fn });
    tb.appendChild(btn('＋ New', newSheet, 'New blank sheet'));
    tb.appendChild(btn('📂 Open', importFile, 'Import .xlsx / .csv'));
    tb.appendChild(btn('💾 Export ▾', () => exportMenu(), 'Export'));
    tb.appendChild(btn('🖨️', () => printDoc(), 'Print'));
    const sep = UI.sep;
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
    inp.setAttribute('aria-label', 'Formula bar');
    tb.appendChild(inp);
  }

  // Second toolbar row: cell formatting, number formats, sort/filter/freeze.
  function buildFormatBar() {
    const bar = document.createElement('div');
    bar.className = 'toolbar calc-formatbar';
    bar.id = 'calcFormatBar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Cell formatting');
    const toggle = (html, title, key, fn) => {
      const b = UI.button(html, { title, iconOnly: true, html: true, onClick: fn });
      b.dataset.fmt = key;
      b.setAttribute('aria-pressed', 'false');
      return b;
    };
    bar.appendChild(toggle('<b>B</b>', 'Bold (Ctrl+B)', 'b', () => toggleFmt('b')));
    bar.appendChild(toggle('<i>I</i>', 'Italic (Ctrl+I)', 'i', () => toggleFmt('i')));
    bar.appendChild(toggle('<u>U</u>', 'Underline (Ctrl+U)', 'u', () => toggleFmt('u')));
    bar.appendChild(UI.sep());
    bar.appendChild(toggle('⇤', 'Align left', 'al:l', () => setAlign('l')));
    bar.appendChild(toggle('↔', 'Align centre', 'al:c', () => setAlign('c')));
    bar.appendChild(toggle('⇥', 'Align right', 'al:r', () => setAlign('r')));
    bar.appendChild(UI.sep());
    const color = (label, title, key, initial) => {
      const wrap = document.createElement('label');
      wrap.className = 'tb-label tb-color-wrap';
      wrap.title = title;
      wrap.append(label + ' ');
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.className = 'tb-color';
      inp.value = initial;
      inp.setAttribute('aria-label', title);
      inp.addEventListener('change', () => { formatSelection({ [key]: inp.value }); focusActiveCell(); });
      wrap.appendChild(inp);
      return wrap;
    };
    bar.appendChild(color('Fill', 'Fill colour', 'bg', '#fff2a8'));
    bar.appendChild(color('Text', 'Text colour', 'fg', '#d83a3a'));
    bar.appendChild(UI.button('✕ Clear format', { title: 'Remove all formatting from the selected cells', onClick: () => formatSelection(null) }));
    bar.appendChild(UI.sep());
    const nf = document.createElement('select');
    nf.className = 'tb-select';
    nf.id = 'calcNumFmt';
    nf.title = 'Number format';
    nf.setAttribute('aria-label', 'Number format');
    for (const [code, label] of NUMBER_FORMATS) {
      const o = document.createElement('option');
      o.value = code; o.textContent = label;
      nf.appendChild(o);
    }
    nf.addEventListener('change', () => { formatSelection({ nf: nf.value }); focusActiveCell(); });
    bar.appendChild(nf);
    bar.appendChild(UI.button('.0+', { title: 'Show one more decimal place', onClick: () => changeDecimals(1) }));
    bar.appendChild(UI.button('.0−', { title: 'Show one less decimal place', onClick: () => changeDecimals(-1) }));
    bar.appendChild(UI.sep());
    bar.appendChild(UI.button('⇅ Sort', { title: 'Sort rows by a column', onClick: sortDialog }));
    const fl = UI.button('🔎 Filter', { title: 'Show only rows that match a condition', onClick: filterDialog });
    fl.id = 'calcFilterBtn';
    fl.setAttribute('aria-pressed', 'false');
    bar.appendChild(fl);
    const fz = UI.button('❄ Freeze row 1', { title: 'Keep row 1 visible while scrolling', onClick: toggleFreeze });
    fz.id = 'calcFreezeBtn';
    fz.setAttribute('aria-pressed', 'false');
    bar.appendChild(fz);
    // Buttons must not take focus from the grid, or keyboard use stops there.
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    $('calcToolbar').insertAdjacentElement('afterend', bar);
  }

  function exportMenu() {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:240px';
    body.innerHTML = `
      <div class="menu-col">
        <button class="tb-btn justify-start" data-x="xlsx" data-scope="one">📊 Excel (.xlsx) — this sheet</button>
        ${sheets.length > 1 ? `<button class="tb-btn justify-start" data-x="xlsx" data-scope="all">📚 Excel (.xlsx) — all ${sheets.length} open sheets</button>` : ''}
        <button class="tb-btn justify-start" data-x="csv" data-scope="one">📄 CSV (.csv) — this sheet, values only</button>
      </div>`;
    const d = UI.dialog({ title: 'Export spreadsheet', body, okText: 'Close', cancelText: null });
    d.el.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); exportFile(b.dataset.x, b.dataset.scope); });
  }

  function onActivate() {
    setTimeout(() => {
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      drawSel();
    }, 0);
  }

  return { boot, onActivate, flush, undo: doUndo, redo: doRedo, reopen: reopenSheet };
})();
