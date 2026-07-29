/* ==========================================================================
   calc.js — Calc: a spreadsheet with a hand-written formula engine.
   Features: 1000x100 grid, click-to-edit, formula recalc, ranges,
     SUM/AVERAGE/MIN/MAX/COUNT/IF/ROUND/ABS/INT/AND/OR/NOT/CONCAT/UPPER/LOWER/LEN
     .xlsx + .csv import/export (SheetJS), autosave, fill-down, keyboard nav.
   ========================================================================== */

const Calc = (() => {
  const COLS = 100;       // A..CV
  const ROWS = 1000;
  // cell key = "A1" etc.  data[key] = { raw: string typed, value: computed }
  const data = Object.create(null);
  // Dependencies for incremental recalc (kept simple): we just re-eval all formulas.
  let activeCell = 'A1';
  let editingCell = null;
  let dirty = false;
  let autosaveTimer = null;

  const $ = (id) => document.getElementById(id);

  // ---------- Address helpers ----------
  function colName(idx) {   // 0 -> A, 25 -> Z, 26 -> AA
    let s = '';
    idx = +idx;
    do { s = String.fromCharCode(65 + (idx % 26)) + s; idx = Math.floor(idx / 26) - 1; } while (idx >= 0);
    return s;
  }
  function colIndex(name) {
    let n = 0;
    for (let i = 0; i < name.length; i++) n = n * 26 + (name.charCodeAt(i) - 64);
    return n - 1;
  }
  function keyOf(col, row) { return colName(col) + (row + 1); }
  function parseAddr(s) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(s);
    if (!m) return null;
    return { col: colIndex(m[1].toUpperCase()), row: +m[2] - 1 };
  }

  // ---------- Formula engine ----------
  // Tokenizer for expressions inside =...
  const TOKEN_RE = /(\s+)|(\d+\.\d+|\d+)|([A-Za-z_][A-Za-z0-9_\.]*)|(<=|>=|<>|!=|[:+\-*/^(),&<>=])|"((?:[^"\\]|\\.)*)"|('([^']*)')/g;

  function tokenize(expr) {
    const toks = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(expr))) {
      if (m[1]) continue;                                  // whitespace
      if (m[2] !== undefined) toks.push({ t: 'num', v: parseFloat(m[2]) });
      else if (m[3] !== undefined) {
        const s = m[3];
        // Could be a function name, a cell ref (A1), or a range (A1:B2)
        toks.push({ t: 'name', v: s });
      } else if (m[4] !== undefined) toks.push({ t: 'op', v: m[4] });
      else if (m[5] !== undefined) toks.push({ t: 'str', v: m[5].replace(/\\"/g, '"').replace(/\\\\/g, '\\') }); // double-quoted content
      else if (m[6] !== undefined) toks.push({ t: 'str', v: m[6] }); // single-quoted content
    }
    return toks;
  }

  // Recursive-descent parser producing a small AST, then evaluator.
  // Grammar (precedence low→high):
  //   comparison := additive ( (=|<>|<=|>=|<|>) additive )*
  //   additive   := multiplicative ( (+|-) multiplicative )*
  //   multiplicative := power ( (*|/|&) power )*
  //   power      := unary ( ^ unary )*
  //   unary      := (-|+) unary | postfix
  //   postfix    := primary ( ':' primary )*   // range
  //   primary    := number | string | name ( '(' args ')' )? | '(' comparison ')'

  let _tok, _pos;
  function peek() { return _tok[_pos]; }
  function next() { return _tok[_pos++]; }
  function expectOp(op) {
    const t = peek();
    if (!t || t.t !== 'op' || t.v !== op) throw new Error('expected ' + op);
    _pos++;
  }

  function parseExpr() { return parseComparison(); }
  function parseComparison() {
    let left = parseAdditive();
    while (peek() && peek().t === 'op' && ['=','<>','!=','<','>','<=','>='].includes(peek().v)) {
      const op = next().v;
      const right = parseAdditive();
      left = { t: 'binop', op, left, right };
    }
    return left;
  }
  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v;
      const right = parseMultiplicative();
      left = { t: 'binop', op, left, right };
    }
    return left;
  }
  function parseMultiplicative() {
    let left = parsePower();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '&')) {
      const op = next().v;
      const right = parsePower();
      left = { t: 'binop', op, left, right };
    }
    return left;
  }
  function parsePower() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && peek().v === '^') {
      next();
      const right = parseUnary();
      left = { t: 'binop', op: '^', left, right };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = next().v;
      const operand = parseUnary();
      return { t: 'unary', op, operand };
    }
    return parseRange();
  }
  function parseRange() {
    let left = parsePrimary();
    while (peek() && peek().t === 'op' && peek().v === ':') {
      next();
      const right = parsePrimary();
      left = { t: 'range', left, right };
    }
    return left;
  }
  function parsePrimary() {
    const t = next();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') return { t: 'num', v: t.v };
    if (t.t === 'str') return { t: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = parseExpr();
      expectOp(')');
      return e;
    }
    if (t.t === 'name') {
      // function call?
      if (peek() && peek().t === 'op' && peek().v === '(') {
        next();
        const args = [];
        if (!(peek() && peek().t === 'op' && peek().v === ')')) {
          args.push(parseExpr());
          while (peek() && peek().t === 'op' && peek().v === ',') { next(); args.push(parseExpr()); }
        }
        expectOp(')');
        return { t: 'call', name: t.v.toUpperCase(), args };
      }
      // bare name — cell ref or named constant
      return { t: 'name', v: t.v };
    }
    throw new Error('unexpected token ' + (t.v || t.t));
  }

  // ---------- Function library ----------
  const FUNCS = {
    SUM: (...a) => flattenNums(a).reduce((x, y) => x + y, 0),
    AVERAGE: (...a) => { const n = flattenNums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : 0; },
    PRODUCT:(...a) => flattenNums(a).reduce((x, y) => x * y, 1),
    MIN: (...a) => { const n = flattenNums(a); return n.length ? Math.min(...n) : 0; },
    MAX: (...a) => { const n = flattenNums(a); return n.length ? Math.max(...n) : 0; },
    COUNT: (...a) => flattenNums(a).length,
    COUNTA:(...a) => flatten(a).filter(x => x !== '' && x != null).length,
    ABS: (x) => Math.abs(x),
    INT: (x) => Math.floor(x),
    ROUND: (x, d = 0) => { const p = Math.pow(10, d); return Math.round(x * p) / p; },
    ROUNDUP:(x, d=0) => { const p = Math.pow(10, d); return (x<0?-1:1)*Math.ceil(Math.abs(x)*p)/p; },
    ROUNDDOWN:(x,d=0) => { const p = Math.pow(10, d); return (x<0?-1:1)*Math.floor(Math.abs(x)*p)/p; },
    SQRT: (x) => Math.sqrt(x),
    POWER:(x, y) => Math.pow(x, y),
    MOD: (x, y) => x - y * Math.floor(x / y),
    PI: () => Math.PI,
    SIN: (x) => Math.sin(x), COS: (x) => Math.cos(x), TAN: (x) => Math.tan(x),
    ASIN:(x)=>Math.asin(x), ACOS:(x)=>Math.acos(x), ATAN:(x)=>Math.atan(x),
    ATAN2:(y,x)=>Math.atan2(y,x),
    EXP:(x)=>Math.exp(x), LN:(x)=>Math.log(x), LOG10:(x)=>Math.log10(x),
    LOG:(x,b=10)=>Math.log(x)/Math.log(b),
    IF: (cond, t, f) => truthy(cond) ? t : f,
    IFERROR:(v, fb) => (v instanceof Error) ? fb : v,
    AND: (...a) => flatten(a).every(truthy),
    OR: (...a) => flatten(a).some(truthy),
    NOT: (x) => !truthy(x),
    TRUE: () => true, FALSE: () => false,
    CONCAT: (...a) => flatten(a).map(x => x == null ? '' : '' + x).join(''),
    CONCATENATE:(...a)=>FUNCS.CONCAT(...a),
    LEN: (x) => ('' + (x ?? '')).length,
    UPPER: (x) => ('' + (x ?? '')).toUpperCase(),
    LOWER: (x) => ('' + (x ?? '')).toLowerCase(),
    TRIM: (x) => ('' + (x ?? '')).replace(/^ +| +$/g, '').replace(/ +/g, ' '),
    LEFT: (x, n = 1) => ('' + (x ?? '')).slice(0, n),
    RIGHT: (x, n = 1) => ('' + (x ?? '')).slice(-n),
    MID: (x, s, n) => ('' + (x ?? '')).substr(s - 1, n),
    REPLACE:(o,s,n,r)=>(''+o).slice(0,s-1)+r+(''+o).slice(s-1+n),
    SUBSTITUTE:(t,a,b)=>(''+t).split(a).join(b),
    TEXT:(x,fmt)=>''+x,
    VALUE:(x)=>{const n=parseFloat(x);return isNaN(n)?0:n;},
    NOW: () => Date.now()/86400000 + 25569,  // Excel serial
    TODAY: () => Math.floor(Date.now()/86400000 + 25569),
    YEAR:(s)=>new Date((s-25569)*86400000).getFullYear(),
    MONTH:(s)=>new Date((s-25569)*86400000).getMonth()+1,
    DAY:(s)=>new Date((s-25569)*86400000).getDate(),
    ISBLANK:(x)=>x===''||x==null,
    ISNUMBER:(x)=>typeof x==='number',
    ISTEXT:(x)=>typeof x==='string',
    ISERROR:(x)=>x instanceof Error,
    ROW:(...a)=>{ return a.length?0:0; }, // placeholder, ROW() really wants a ref
    MEDIAN:(...a)=>{const n=flattenNums(a).sort((x,y)=>x-y);const m=Math.floor(n.length/2);return n.length%2?n[m]:(n[m-1]+n[m])/2;},
    VLOOKUP:(value, range, colIndex, exact)=>{
      // range is a 2D array (rows of values). Search the first column for `value`;
      // return the value from column `colIndex` (1-based) of the matching row.
      // 4th arg (range_lookup): TRUE/omitted = approximate, FALSE/0 = exact.
      const rows = Array.isArray(range) ? range : [range];
      const approx = exact === undefined ? true : truthy(exact);
      let best = null;
      for (const r of rows) {
        const first = Array.isArray(r) ? r[0] : r;
        if (looseEq(first, value)) return (Array.isArray(r) ? r[+colIndex - 1] : r);
        if (approx && typeof first === 'number' && typeof value === 'number' && first <= value) {
          if (!best || first > best[0]) best = [first, Array.isArray(r) ? r[+colIndex - 1] : r];
        }
      }
      if (approx && best) return best[1];
      throw error('#N/A');
    },
    HLOOKUP:(value, range, rowIndex, exact)=>{
      const rows = Array.isArray(range) ? range : [range];
      if (!rows.length) throw error('#N/A');
      const cols = Array.isArray(rows[0]) ? rows[0] : [rows[0]];
      const approx = exact === undefined ? true : truthy(exact);
      let bestCol = -1;
      for (let c = 0; c < cols.length; c++) {
        const v = cols[c];
        if (looseEq(v, value)) { bestCol = c; break; }
        if (approx && typeof v === 'number' && typeof value === 'number' && v <= value) bestCol = c;
      }
      if (bestCol < 0) throw error('#N/A');
      const row = rows[+rowIndex - 1];
      return Array.isArray(row) ? row[bestCol] : row;
    },
    INDEX:(range, row, col)=>{
      const rows = Array.isArray(range) ? range : [range];
      const r = (+row || 1) - 1, c = (+col || 1) - 1;
      const target = rows[r];
      if (!Array.isArray(target)) return target;
      return target[c];
    },
    MATCH:(value, range, type)=>{
      const flat = flatten(Array.isArray(range) ? range : [range]);
      const t = type === undefined ? 1 : +type;
      if (t === 0) { for (let i=0;i<flat.length;i++) if (looseEq(flat[i], value)) return i+1; throw error('#N/A'); }
      if (t === 1) { let last=0; for (let i=0;i<flat.length;i++) if (typeof flat[i]==='number' && flat[i]<=value) last=i+1; else break; if (!last) throw error('#N/A'); return last; }
      // t === -1
      let last=0; for (let i=0;i<flat.length;i++) if (typeof flat[i]==='number' && flat[i]>=value) last=i+1; else break; if (!last) throw error('#N/A'); return last;
    },
    RANK:(value, range, order)=>{
      const n = flattenNums(Array.isArray(range)?range:[range]);
      const asc = order && truthy(order);
      const sorted = [...n].sort((a,b)=>asc?a-b:b-a);
      const idx = sorted.indexOf(value);
      if (idx < 0) throw error('#N/A');
      return idx + 1;
    },
    RANDBETWEEN:(lo,hi)=>Math.floor(Math.random()*(+hi-+lo+1))+ +lo,
    STDEV:(...a)=>{const n=flattenNums(a);if(n.length<2)return 0;const m=n.reduce((x,y)=>x+y,0)/n.length;const v=n.reduce((x,y)=>x+(y-m)**2,0)/(n.length-1);return Math.sqrt(v);},
    VAR:(...a)=>{const n=flattenNums(a);if(n.length<2)return 0;const m=n.reduce((x,y)=>x+y,0)/n.length;return n.reduce((x,y)=>x+(y-m)**2,0)/(n.length-1);},
  };

  function flatten(args) {
    // Flatten ranges (arrays) and scalar args into one array.
    const out = [];
    for (const a of args) {
      if (Array.isArray(a)) out.push(...a.flat());
      else out.push(a);
    }
    return out;
  }
  function flattenNums(args) {
    return flatten(args).map(x => {
      if (typeof x === 'number') return x;
      if (typeof x === 'string' && x.trim() !== '' && !isNaN(x)) return parseFloat(x);
      return NaN;
    }).filter(x => !isNaN(x));
  }
  function truthy(v) {
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'false' || s === '' || s === '0') return false;
      return true;
    }
    return !!v;
  }

  // ---------- Evaluator ----------
  const ERRORS = new Set(['#REF!','#NAME?','#DIV/0!','#VALUE!','#NUM!','#N/A','#NULL!']);
  function error(kind) { return new Error(kind); }

  function evalNode(node, ctx) {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'name': {
        // Bare name: maybe a cell ref (A1) or a named constant (TRUE/FALSE/PI...).
        const up = node.v.toUpperCase();
        if (up === 'TRUE') return true;
        if (up === 'FALSE') return false;
        if (/^[A-Z]+\d+$/.test(up)) {
          return readCellValue(ctx, up);
        }
        throw error('#NAME?');
      }
      case 'unary': {
        const v = evalNode(node.operand, ctx);
        if (node.op === '-') return -v;
        return +v;
      }
      case 'range': {
        // produce a 2D array of values between the two corners
        const a = resolveRef(node.left), b = resolveRef(node.right);
        const c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col);
        const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
        const out = [];
        for (let r = r1; r <= r2; r++) {
          const row = [];
          for (let c = c1; c <= c2; c++) row.push(readCellValue(ctx, keyOf(c, r)));
          out.push(row);
        }
        return out; // array of arrays
      }
      case 'binop': {
        const l = evalNode(node.left, ctx);
        const r = evalNode(node.right, ctx);
        switch (node.op) {
          case '+': return (+l) + (+r);
          case '-': return (+l) - (+r);
          case '*': return (+l) * (+r);
          case '/': if ((+r) === 0) throw error('#DIV/0!'); return (+l) / (+r);
          case '^': return Math.pow(+l, +r);
          case '&': return '' + (l ?? '') + (r ?? '');
          case '=':  return looseEq(l, r);
          case '<>': case '!=': return !looseEq(l, r);
          case '<':  return +l < +r;
          case '>':  return +l > +r;
          case '<=': return +l <= +r;
          case '>=': return +l >= +r;
        }
        throw error('#VALUE!');
      }
      case 'call': {
        const fn = FUNCS[node.name];
        if (!fn) throw error('#NAME?');
        const args = node.args.map(a => evalNode(a, ctx));
        return fn(...args);
      }
    }
  }
  function looseEq(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    return ('' + a) === ('' + b);
  }
  function resolveRef(node) {
    if (node.t === 'name' && /^[A-Za-z]+\d+$/.test(node.v)) return parseAddr(node.v);
    throw error('#REF!');
  }

  // ctx.active is the cell currently being computed (for cycle detection)
  function readCellValue(ctx, addr) {
    if (ctx.stack.has(addr)) throw error('#CYCLE!');
    const cell = data[addr];
    if (!cell) return '';
    // If we're recomputing a different cell, ensure this one is fresh.
    if (addr !== ctx.root && cell.raw && cell.raw[0] === '=' && !cell._fresh) {
      ctx.stack.add(addr);
      try {
        cell.value = evaluateRaw(cell.raw, addr, ctx);
      } catch (e) { cell.value = e.message && ERRORS.has(e.message) ? e.message : '#ERROR!'; }
      ctx.stack.delete(addr);
      cell._fresh = true;
    }
    const v = cell.value;
    if (v instanceof Error || (typeof v === 'string' && ERRORS.has(v))) return v;
    return v;
  }

  function evaluateRaw(raw, rootAddr, ctx) {
    const expr = raw.slice(1); // drop '='
    const toks = tokenize(expr);
    _tok = toks; _pos = 0;
    const ast = parseExpr();
    const c = ctx || { root: rootAddr, stack: new Set([rootAddr]) };
    c.root = rootAddr;
    c.stack = c.stack || new Set([rootAddr]);
    return evalNode(ast, c);
  }

  // Recompute all formula cells. Two passes; the second handles dependencies
  // that resolved to errors only because their inputs weren't fresh yet.
  function recalcAll() {
    const ctx = { root: null, stack: new Set() };
    for (const addr of Object.keys(data)) data[addr]._fresh = false;
    for (let pass = 0; pass < 3; pass++) {
      for (const addr of Object.keys(data)) {
        const cell = data[addr];
        if (!cell.raw || cell.raw[0] !== '=') {
          // raw literal
          cell.value = parseLiteral(cell.raw);
          continue;
        }
        if (cell._fresh) continue;
        ctx.root = addr; ctx.stack = new Set([addr]);
        try {
          cell.value = evaluateRaw(cell.raw, addr, ctx);
        } catch (e) {
          cell.value = (e && ERRORS.has(e.message)) ? e.message : '#ERROR!';
        }
        cell._fresh = true;
      }
    }
  }
  function parseLiteral(s) {
    if (s === '' || s == null) return '';
    const n = parseFloat(s);
    if (!isNaN(n) && /^[\s\d.,eE+-]+$/.test(s)) return n;
    if (s.toLowerCase() === 'true') return true;
    if (s.toLowerCase() === 'false') return false;
    return s;
  }

  // ---------- DOM grid ----------
  function buildGrid() {
    const wrap = $('calcContent');
    wrap.innerHTML = '';
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

    // Row gutter + cells
    const scrollBody = document.createElement('div');
    scrollBody.className = 'calc-body';
    for (let r = 0; r < ROWS; r++) {
      const rowHead = document.createElement('div');
      rowHead.className = 'calc-rowhead';
      rowHead.textContent = r + 1;
      scrollBody.appendChild(rowHead);
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'calc-cell';
        cell.dataset.addr = keyOf(c, r);
        cell.tabIndex = -1;
        scrollBody.appendChild(cell);
      }
    }
    wrap.appendChild(scrollBody);

    // Click + double-click + keyboard handlers
    scrollBody.addEventListener('click', onCellClick);
    scrollBody.addEventListener('dblclick', onCellDblClick);
    scrollBody.addEventListener('keydown', onCellKey);
    // Sync scroll for sticky headers
    scrollBody.addEventListener('scroll', () => {
      colHeader.scrollLeft = scrollBody.scrollLeft;
      // row headers sticky via CSS position; we just translate
    });
    return scrollBody;
  }

  function renderCell(addr) {
    const el = document.querySelector(`.calc-cell[data-addr="${addr}"]`);
    if (!el) return;
    const cell = data[addr];
    if (!cell || cell.raw === '' || cell.raw == null) {
      el.textContent = '';
      el.classList.remove('calc-num','calc-str','calc-bool','calc-err');
      return;
    }
    let v = cell.value;
    if (v instanceof Error) v = v.message;
    if (typeof v === 'number') {
      el.textContent = formatNumber(v);
      el.className = 'calc-cell calc-num';
    } else if (typeof v === 'boolean') {
      el.textContent = v ? 'TRUE' : 'FALSE';
      el.className = 'calc-cell calc-bool';
    } else if (typeof v === 'string' && ERRORS.has(v)) {
      el.textContent = v;
      el.className = 'calc-cell calc-err';
    } else {
      el.textContent = v ?? '';
      el.className = 'calc-cell calc-str';
    }
  }
  function formatNumber(n) {
    if (!isFinite(n)) return n > 0 ? '#NUM!' : '#DIV/0!';
    // Keep reasonable precision; avoid float noise like 0.30000000000000004
    const r = Math.round(n * 1e10) / 1e10;
    return '' + r;
  }

  function renderAll() {
    for (const addr of Object.keys(data)) renderCell(addr);
  }

  // ---------- Editing ----------
  function setActive(addr) {
    document.querySelectorAll('.calc-cell.active').forEach(e => e.classList.remove('active'));
    activeCell = addr;
    const el = document.querySelector(`.calc-cell[data-addr="${addr}"]`);
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    const a = parseAddr(activeCell);
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':    moveActive(0, -1); break;
      case 'ArrowDown':  moveActive(0, 1); break;
      case 'ArrowLeft':  moveActive(-1, 0); break;
      case 'ArrowRight': moveActive(1, 0); break;
      case 'Enter':      moveActive(0, 1); break;
      case 'Tab':        moveActive(e.shiftKey ? -1 : 1, 0); break;
      case 'Delete': case 'Backspace':
        delete data[activeCell];
        recalcAll(); renderCell(activeCell); renderAll();
        $('calcFx').value = ''; markDirty(); break;
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
    const el = document.querySelector(`.calc-cell[data-addr="${addr}"]`);
    if (!el) return;
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
    const el = document.querySelector(`.calc-cell[data-addr="${addr}"]`);
    const inp = el && el.querySelector('input.calc-edit');
    const raw = inp ? inp.value : '';
    editingCell = null;
    if (el) { el.classList.remove('editing'); el.innerHTML = ''; }
    if (commit) {
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
    editingCell = null;
    renderCell(activeCell);
  }

  // Formula bar editing
  function commitFormulaBar() {
    const v = $('calcFx').value;
    if (!activeCell) return;
    if (v === '') delete data[activeCell];
    else { if (!data[activeCell]) data[activeCell] = {}; data[activeCell].raw = v; }
    recalcAll(); renderAll(); markDirty();
  }

  // ---------- Fill / clear ----------
  function fillDown() {
    const a = parseAddr(activeCell);
    // Find selection? Just fill the value from current cell to all cells below until blank stop? simpler: fill one down.
    const src = data[activeCell];
    const below = keyOf(a.col, a.row + 1);
    if (src) { data[below] = { raw: src.raw }; }
    else delete data[below];
    recalcAll(); renderAll(); markDirty();
    setActive(below);
  }
  function clearSheet() {
    UI.confirm({ title: 'Clear sheet?', message: 'Erase all cells in this sheet. This cannot be undone.', okText: 'Clear', danger: true })
      .then(ok => {
        if (!ok) return;
        for (const k of Object.keys(data)) delete data[k];
        renderAll(); markDirty();
      });
  }

  // ---------- Import / Export ----------
  async function importFile() {
    try {
      const f = await FS.open({
        accept: [
          { description: 'Spreadsheet', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'text/csv': ['.csv'], 'application/vnd.ms-excel': ['.xls'] } }
        ],
      });
      const wb = XLSX.read(f.bytes, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) { UI.toast('No sheets in file', 'warn'); return; }
      // Wipe current data
      for (const k of Object.keys(data)) delete data[k];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      for (let r = range.s.r; r <= Math.min(range.e.r, ROWS - 1); r++) {
        for (let c = range.s.c; c <= Math.min(range.e.c, COLS - 1); c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          if (cell == null) continue;
          const key = keyOf(c, r);
          let raw;
          if (cell.f) raw = '=' + cell.f;
          else if (cell.t === 'n') raw = '' + cell.v;
          else if (cell.t === 'b') raw = cell.v ? 'TRUE' : 'FALSE';
          else raw = '' + (cell.w ?? cell.v ?? '');
          data[key] = { raw };
        }
      }
      recalcAll(); renderAll(); markDirty();
      UI.toast(`Imported ${f.name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Import failed: ' + e.message, 'error');
    }
  }

  async function exportFile(fmt) {
    // Build a worksheet from current data
    const aoa = [];
    let maxR = 0, maxC = 0;
    for (const addr of Object.keys(data)) {
      const a = parseAddr(addr); if (!a) continue;
      maxR = Math.max(maxR, a.row); maxC = Math.max(maxC, a.col);
    }
    if (maxR === 0 && maxC === 0 && !data['A1']) { UI.toast('Nothing to export', 'warn'); return; }
    for (let r = 0; r <= maxR; r++) {
      const row = [];
      for (let c = 0; c <= maxC; c++) {
        const cell = data[keyOf(c, r)];
        if (!cell) { row.push(null); continue; }
        let v = cell.value;
        if (v instanceof Error) v = v.message;
        if (typeof v === 'string' && ERRORS.has(v)) v = v;
        row.push(v ?? null);
      }
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const name = (sheetName() || 'sheet') + '.' + fmt;
    // xlsx.write returns an ArrayBuffer when type='array'
    const out = XLSX.write(wb, { bookType: fmt, type: 'array' });
    const bytes = new Uint8Array(out);
    const mime = fmt === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    try {
      await FS.save({ name, mime, bytes, handle: null });
      UI.toast(`Exported ${name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Export failed: ' + e.message, 'error');
    }
  }
  function sheetName() { return 'Sheet1'; }

  // ---------- Dirty + autosave ----------
  function markDirty() {
    dirty = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 800);
  }
  async function autosaveNow() {
    try {
      // Save a compact JSON of { addr: raw }
      const dump = {};
      for (const k of Object.keys(data)) dump[k] = data[k].raw;
      await Storage.save('calc:sheet', dump);
      dirty = false;
    } catch (e) { /* ignore */ }
  }

  // ---------- Boot ----------
  async function boot() {
    injectStyles();
    buildToolbar();
    buildGrid();

    // Formula bar handlers
    $('calcFx').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitFormulaBar(); }
    });
    $('calcFx').addEventListener('blur', commitFormulaBar);

    // Restore
    try {
      const saved = await Storage.load('calc:sheet');
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(saved)) data[k] = { raw: saved[k] };
        recalcAll(); renderAll();
      }
    } catch (e) { /* ignore */ }

    setActive('A1');
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
    tb.appendChild(btn('📂 Open', importFile, 'Import .xlsx / .csv'));
    tb.appendChild(btn('💾 Export ▾', () => exportMenu(), 'Export'));
    const sep = () => { const s = document.createElement('span'); s.className='tb-sep'; return s; };
    tb.appendChild(sep());
    tb.appendChild(btn('⬇ Fill down', fillDown, 'Fill value down (Ctrl+D)'));
    tb.appendChild(btn('🧹 Clear sheet', clearSheet, 'Erase all cells', ));
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
        <button class="tb-btn" data-x="xlsx" style="justify-content:flex-start">📊 Excel (.xlsx)</button>
        <button class="tb-btn" data-x="csv"  style="justify-content:flex-start">📄 CSV (.csv)</button>
      </div>`;
    const d = UI.dialog({ title: 'Export spreadsheet', body, okText: 'Close', cancelText: null });
    d.el.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); exportFile(b.dataset.x); });
  }

  function injectStyles() {
    if (document.getElementById('calc-styles')) return;
    const s = document.createElement('style');
    s.id = 'calc-styles';
    s.textContent = `
      .calc-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
      .calc-content {
        flex: 1; min-height: 0; overflow: auto;
        position: relative;
        background: var(--surface);
        font-family: var(--font-ui);
        font-size: 13px;
      }
      .calc-corner {
        position: sticky; top: 0; left: 0; z-index: 5;
        width: 44px; height: 26px;
        background: var(--surface-2); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
        display: grid; place-items: center; color: var(--text-faint);
      }
      .calc-colheader {
        position: sticky; top: 0; z-index: 4;
        display: flex; align-items: center;
        height: 26px;
        background: var(--surface-2);
        border-bottom: 1px solid var(--border);
      }
      .calc-colheader .calc-spacer { width: 44px; flex-shrink: 0; border-right: 1px solid var(--border); height: 100%; }
      .calc-colhead {
        width: 92px; flex-shrink: 0;
        text-align: center; line-height: 26px;
        color: var(--text-dim); font-weight: 500;
        border-right: 1px solid var(--border-soft);
      }
      .calc-body { display: grid; grid-template-columns: 44px repeat(${COLS}, 92px); align-content: start; }
      .calc-rowhead {
        position: sticky; left: 0; z-index: 3;
        background: var(--surface-2);
        border-right: 1px solid var(--border);
        border-bottom: 1px solid var(--border-soft);
        text-align: center; line-height: 26px;
        color: var(--text-dim); font-size: 12px;
        height: 26px;
      }
      .calc-cell {
        height: 26px; padding: 0 6px;
        border-right: 1px solid var(--border-soft);
        border-bottom: 1px solid var(--border-soft);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        line-height: 26px;
        outline: none;
        cursor: cell;
        user-select: none;
      }
      .calc-cell.calc-num { text-align: right; color: #111; }
      body.theme-dark .calc-cell.calc-num { color: var(--text); }
      .calc-cell.calc-bool { text-align: center; color: var(--text-dim); font-style: italic; }
      .calc-cell.calc-err { color: var(--danger); text-align: center; font-weight: 600; }
      .calc-cell.calc-str { color: var(--text); }
      .calc-cell.active { outline: 2px solid var(--accent); outline-offset: -2px; }
      .calc-cell.editing { padding: 0; }
      .calc-edit {
        width: 100%; height: 26px;
        border: 0; outline: 2px solid var(--accent); outline-offset: -2px;
        padding: 0 6px;
        background: var(--surface); color: var(--text);
        font: inherit;
      }
    `;
    document.head.appendChild(s);
  }

  function onActivate() {
    setTimeout(() => {
      const el = document.querySelector('.calc-cell.active');
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 0);
  }

  return { boot, onActivate };
})();
