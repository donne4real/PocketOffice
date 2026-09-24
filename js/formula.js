/* ==========================================================================
   formula.js — Calc's formula engine: tokenizer, parser, evaluator and
   recalculation. Pure logic with no DOM access, so it runs in Node for the
   unit tests (tests/formula.test.js) as well as in the browser.

   Cells are { raw, value } objects in a map keyed by address ("A1").
   recalcSheet(data, resolveSheet) recomputes every value in one memoized
   pass: each formula is evaluated at most once, and a cell that is read
   before its turn is evaluated on demand.
   ========================================================================== */

const Formula = (() => {
  const ERRORS = new Set(['#REF!', '#NAME?', '#DIV/0!', '#VALUE!', '#NUM!', '#N/A', '#NULL!', '#CYCLE!', '#ERROR!']);
  function error(code) { const e = new Error(code); e.formulaError = true; return e; }
  function codeOf(e) { return e && ERRORS.has(e.message) ? e.message : '#ERROR!'; }
  const isErr = (v) => typeof v === 'string' && ERRORS.has(v);

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
    const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(s);
    if (!m) return null;
    return { col: colIndex(m[1].toUpperCase()), row: +m[2] - 1 };
  }

  // ---------- Literals ----------
  // What a typed (non-formula) cell holds. Only whole-string numbers become
  // numbers; "2026-09-23" or "12 apples" stay text instead of being cut
  // down to their leading digits.
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const THOUSANDS_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  const PERCENT_RE = /^[+-]?(\d+\.?\d*|\.\d+)%$/;
  function parseLiteral(s) {
    if (s === '' || s == null) return '';
    const t = String(s).trim();
    if (NUM_RE.test(t)) return parseFloat(t);
    if (THOUSANDS_RE.test(t)) return parseFloat(t.replace(/,/g, ''));
    if (PERCENT_RE.test(t)) return parseFloat(t) / 100;
    const low = t.toLowerCase();
    if (low === 'true') return true;
    if (low === 'false') return false;
    return s;
  }

  // ---------- Tokenizer ----------
  // Tokens: num, str, ref { sheet, v, colAbs, rowAbs, rs, re }, name, op.
  // rs/re are the source span of a reference (without its sheet prefix);
  // shiftRefs() uses them to rewrite formulas in place.
  // Any character the grammar doesn't know is a syntax error — the old
  // regex tokenizer skipped it, so =50% quietly evaluated to 50.
  const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

  function tokenize(expr) {
    const toks = [];
    const n = expr.length;
    let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';

    function readRef(sheet) {
      const m = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(expr.slice(i));
      if (!m) throw error('#REF!');
      const tok = refToken(m[0], sheet, i);
      i += m[0].length;
      return tok;
    }

    while (i < n) {
      const c = expr[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

      if (isDigit(c) || (c === '.' && isDigit(expr[i + 1] || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(expr.slice(i));
        toks.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }

      if (c === '"') {
        let s = '';
        i++;
        let closed = false;
        while (i < n) {
          const ch = expr[i];
          if (ch === '\\' && (expr[i + 1] === '"' || expr[i + 1] === '\\')) { s += expr[i + 1]; i += 2; continue; }
          if (ch === '"') {
            if (expr[i + 1] === '"') { s += '"'; i += 2; continue; }   // Excel-style "" escape
            closed = true; i++; break;
          }
          s += ch; i++;
        }
        if (!closed) throw error('#ERROR!');
        toks.push({ t: 'str', v: s });
        continue;
      }

      if (c === "'") {
        // 'Sheet name'!A1  — or a legacy single-quoted string literal.
        let s = '';
        i++;
        let closed = false;
        while (i < n) {
          if (expr[i] === "'") {
            if (expr[i + 1] === "'") { s += "'"; i += 2; continue; }
            closed = true; i++; break;
          }
          s += expr[i]; i++;
        }
        if (!closed) throw error('#ERROR!');
        if (expr[i] === '!') { i++; toks.push(readRef(s)); }
        else toks.push({ t: 'str', v: s });
        continue;
      }

      if (/[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(expr.slice(i));
        const word = m[0];
        const start = i;
        i += word.length;
        if (expr[i] === '!') { i++; toks.push(readRef(word)); continue; }
        // A word followed by "(" is always a function name — LOG10( must not
        // be mistaken for the cell LOG10.
        let j = i;
        while (j < n && expr[j] === ' ') j++;
        if (expr[j] !== '(' && REF_RE.test(word)) { toks.push(refToken(word, null, start)); continue; }
        if (word.includes('$')) throw error('#NAME?');
        toks.push({ t: 'name', v: word });
        continue;
      }

      const two = expr.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
        toks.push({ t: 'op', v: two }); i += 2; continue;
      }
      if ('+-*/^&(),:<>=%'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }

      throw error('#ERROR!');
    }
    return toks;
  }

  function refToken(text, sheet, start) {
    const m = REF_RE.exec(text);
    return {
      t: 'ref', sheet: sheet || null,
      v: m[2].toUpperCase() + m[4],
      colAbs: m[1] === '$', rowAbs: m[3] === '$',
      rs: start, re: start + text.length,
    };
  }

  // ---------- Parser ----------
  // Precedence, low to high (matches Excel):
  //   comparison  = <> < > <= >=
  //   concat      &
  //   additive    + -
  //   multiplicative * /
  //   power       ^
  //   unary       - +
  //   percent     postfix %
  //   range       :
  function parse(expr) {
    const toks = tokenize(expr);
    let pos = 0;
    const peek = () => toks[pos];
    const isOp = (...vs) => { const t = toks[pos]; return !!t && t.t === 'op' && vs.includes(t.v); };
    const expectOp = (v) => { if (!isOp(v)) throw error('#ERROR!'); pos++; };

    function comparison() {
      let left = concat();
      while (isOp('=', '<>', '!=', '<', '>', '<=', '>=')) {
        const op = toks[pos++].v;
        left = { t: 'binop', op, left, right: concat() };
      }
      return left;
    }
    function concat() {
      let left = additive();
      while (isOp('&')) { pos++; left = { t: 'binop', op: '&', left, right: additive() }; }
      return left;
    }
    function additive() {
      let left = multiplicative();
      while (isOp('+', '-')) {
        const op = toks[pos++].v;
        left = { t: 'binop', op, left, right: multiplicative() };
      }
      return left;
    }
    function multiplicative() {
      let left = power();
      while (isOp('*', '/')) {
        const op = toks[pos++].v;
        left = { t: 'binop', op, left, right: power() };
      }
      return left;
    }
    function power() {
      let left = unary();
      while (isOp('^')) { pos++; left = { t: 'binop', op: '^', left, right: unary() }; }
      return left;
    }
    function unary() {
      if (isOp('-', '+')) {
        const op = toks[pos++].v;
        return { t: 'unary', op, operand: unary() };
      }
      return percent();
    }
    function percent() {
      let node = range();
      while (isOp('%')) { pos++; node = { t: 'pct', operand: node }; }
      return node;
    }
    function range() {
      const left = primary();
      if (!isOp(':')) return left;
      pos++;
      const right = primary();
      if (left.t !== 'ref' || right.t !== 'ref') throw error('#REF!');
      if (right.sheet && right.sheet !== left.sheet) throw error('#REF!');
      return { t: 'range', sheet: left.sheet, a: left, b: right };
    }
    function primary() {
      const t = toks[pos++];
      if (!t) throw error('#ERROR!');
      if (t.t === 'num' || t.t === 'str') return { t: t.t, v: t.v };
      if (t.t === 'ref') {
        const a = parseAddr(t.v);
        return { t: 'ref', sheet: t.sheet, col: a.col, row: a.row };
      }
      if (t.t === 'op' && t.v === '(') {
        const e = comparison();
        expectOp(')');
        return e;
      }
      if (t.t === 'name') {
        if (isOp('(')) {
          pos++;
          const args = [];
          if (!isOp(')')) {
            args.push(comparison());
            while (isOp(',')) { pos++; args.push(comparison()); }
          }
          expectOp(')');
          return { t: 'call', name: t.v.toUpperCase(), args };
        }
        return { t: 'name', v: t.v };
      }
      throw error('#ERROR!');
    }

    const ast = comparison();
    if (pos < toks.length) throw error('#ERROR!');   // leftovers, e.g. "=1 2"
    return ast;
  }

  // ---------- Relative-reference shifting (fill down) ----------
  // Returns the formula with every relative reference moved by (dRow, dCol);
  // $-anchored parts stay put. A reference pushed off the sheet becomes #REF!.
  function shiftRefs(raw, dRow, dCol) {
    if (typeof raw !== 'string' || raw[0] !== '=') return raw;
    let toks;
    try { toks = tokenize(raw.slice(1)); } catch (e) { return raw; }
    let expr = raw.slice(1);
    const refs = toks.filter(t => t.t === 'ref').sort((a, b) => b.rs - a.rs);
    for (const r of refs) {
      const a = parseAddr(r.v);
      const col = r.colAbs ? a.col : a.col + dCol;
      const row = r.rowAbs ? a.row : a.row + dRow;
      const text = (col < 0 || row < 0) ? '#REF!'
        : (r.colAbs ? '$' : '') + colName(col) + (r.rowAbs ? '$' : '') + (row + 1);
      expr = expr.slice(0, r.rs) + text + expr.slice(r.re);
    }
    return '=' + expr;
  }

  // ---------- Coercion + comparison ----------
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === '' || v == null) return 0;
    if (Array.isArray(v)) throw error('#VALUE!');
    if (isErr(v)) throw error(v);
    const lit = parseLiteral(v);
    if (typeof lit === 'number') return lit;
    throw error('#VALUE!');
  }
  function toText(v) {
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return formatNumber(v);
    return '' + v;
  }
  function truthy(v) {
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return !(s === 'false' || s === '' || s === '0');
    }
    return !!v;
  }
  // Excel ordering across types: numbers < text < booleans; text compares
  // case-insensitively. Blank behaves as 0 against numbers and "" against text.
  function typeRank(v) { return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2; }
  function compare(a, b) {
    if (a === '' || a == null) a = typeof b === 'number' ? 0 : typeof b === 'boolean' ? false : '';
    if (b === '' || b == null) b = typeof a === 'number' ? 0 : typeof a === 'boolean' ? false : '';
    const ra = typeRank(a), rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) {
      const x = a.toLowerCase(), y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    }
    const x = +a, y = +b;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const looseEq = (a, b) => compare(a, b) === 0;

  // ---------- Function library ----------
  function flatten(args) {
    const out = [];
    for (const a of args) {
      if (Array.isArray(a)) { for (const row of a) { if (Array.isArray(row)) out.push(...row); else out.push(row); } }
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
  const as2D = (range) => Array.isArray(range) ? range : [[range]];

  // COUNTIF-style criteria: 5, ">5", "<>x", "=", "a*", "?b".
  function makeCriterion(crit) {
    if (typeof crit === 'number' || typeof crit === 'boolean') return (v) => looseEq(v, crit);
    const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(String(crit ?? ''));
    const op = m[1] || '=';
    const rhs = m[2];
    const rhsNum = rhs.trim() !== '' && !isNaN(rhs) ? parseFloat(rhs) : null;
    if (rhsNum !== null) {
      return (v) => {
        const x = typeof v === 'number' ? v
          : (typeof v === 'string' && v.trim() !== '' && !isNaN(v)) ? parseFloat(v) : null;
        if (x === null) return op === '<>';
        switch (op) {
          case '=': return x === rhsNum;
          case '<>': return x !== rhsNum;
          case '<': return x < rhsNum;
          case '>': return x > rhsNum;
          case '<=': return x <= rhsNum;
          case '>=': return x >= rhsNum;
        }
        return false;
      };
    }
    const blank = (v) => v === '' || v == null;
    if (op === '=' || op === '<>') {
      const re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const match = (v) => rhs === '' ? blank(v) : re.test(toText(v));
      return op === '=' ? match : (v) => !match(v);
    }
    return (v) => {
      if (typeof v !== 'string' || blank(v)) return false;
      const c = compare(v, rhs);
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    };
  }
  function pairs(range, other) {
    const a = flatten([as2D(range)]);
    const b = other === undefined ? a : flatten([as2D(other)]);
    return a.map((v, i) => [v, b[i]]);
  }

  const serialToDate = (s) => new Date((toNum(s) - 25569) * 86400000);

  const FUNCS = {
    SUM: (...a) => flattenNums(a).reduce((x, y) => x + y, 0),
    AVERAGE: (...a) => { const n = flattenNums(a); if (!n.length) throw error('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
    PRODUCT: (...a) => flattenNums(a).reduce((x, y) => x * y, 1),
    MIN: (...a) => { const n = flattenNums(a); return n.length ? Math.min(...n) : 0; },
    MAX: (...a) => { const n = flattenNums(a); return n.length ? Math.max(...n) : 0; },
    COUNT: (...a) => flattenNums(a.map(x => Array.isArray(x) ? x : [[x]])).length,
    COUNTA: (...a) => flatten(a).filter(x => x !== '' && x != null).length,
    COUNTBLANK: (r) => flatten([as2D(r)]).filter(x => x === '' || x == null).length,
    COUNTIF: (range, crit) => { const f = makeCriterion(crit); return flatten([as2D(range)]).filter(f).length; },
    SUMIF: (range, crit, sumRange) => {
      const f = makeCriterion(crit);
      return pairs(range, sumRange).reduce((s, [v, w]) => s + (f(v) && typeof w === 'number' ? w : 0), 0);
    },
    AVERAGEIF: (range, crit, avgRange) => {
      const f = makeCriterion(crit);
      const vals = pairs(range, avgRange).filter(([v, w]) => f(v) && typeof w === 'number').map(p => p[1]);
      if (!vals.length) throw error('#DIV/0!');
      return vals.reduce((s, x) => s + x, 0) / vals.length;
    },
    ABS: (x) => Math.abs(toNum(x)),
    INT: (x) => Math.floor(toNum(x)),
    ROUND: (x, d = 0) => { const p = Math.pow(10, toNum(d)); return Math.round(toNum(x) * p) / p; },
    ROUNDUP: (x, d = 0) => { x = toNum(x); const p = Math.pow(10, toNum(d)); return (x < 0 ? -1 : 1) * Math.ceil(Math.abs(x) * p) / p; },
    ROUNDDOWN: (x, d = 0) => { x = toNum(x); const p = Math.pow(10, toNum(d)); return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * p) / p; },
    SQRT: (x) => Math.sqrt(toNum(x)),
    POWER: (x, y) => Math.pow(toNum(x), toNum(y)),
    MOD: (x, y) => { x = toNum(x); y = toNum(y); if (y === 0) throw error('#DIV/0!'); return x - y * Math.floor(x / y); },
    PI: () => Math.PI,
    SIN: (x) => Math.sin(toNum(x)), COS: (x) => Math.cos(toNum(x)), TAN: (x) => Math.tan(toNum(x)),
    ASIN: (x) => Math.asin(toNum(x)), ACOS: (x) => Math.acos(toNum(x)), ATAN: (x) => Math.atan(toNum(x)),
    ATAN2: (x, y) => Math.atan2(toNum(y), toNum(x)),   // Excel order: ATAN2(x, y)
    EXP: (x) => Math.exp(toNum(x)), LN: (x) => Math.log(toNum(x)), LOG10: (x) => Math.log10(toNum(x)),
    LOG: (x, b = 10) => Math.log(toNum(x)) / Math.log(toNum(b)),
    AND: (...a) => flatten(a).filter(x => x !== '').every(truthy),
    OR: (...a) => flatten(a).filter(x => x !== '').some(truthy),
    NOT: (x) => !truthy(x),
    TRUE: () => true, FALSE: () => false,
    CONCAT: (...a) => flatten(a).map(toText).join(''),
    CONCATENATE: (...a) => flatten(a).map(toText).join(''),
    LEN: (x) => toText(x).length,
    UPPER: (x) => toText(x).toUpperCase(),
    LOWER: (x) => toText(x).toLowerCase(),
    TRIM: (x) => toText(x).replace(/^ +| +$/g, '').replace(/ +/g, ' '),
    LEFT: (x, n = 1) => toText(x).slice(0, toNum(n)),
    RIGHT: (x, n = 1) => { n = toNum(n); return n <= 0 ? '' : toText(x).slice(-n); },
    MID: (x, s, n) => toText(x).substr(toNum(s) - 1, toNum(n)),
    REPLACE: (o, s, n, r) => { o = toText(o); s = toNum(s); n = toNum(n); return o.slice(0, s - 1) + toText(r) + o.slice(s - 1 + n); },
    SUBSTITUTE: (t, a, b) => toText(t).split(toText(a)).join(toText(b)),
    TEXT: (x) => toText(x),
    VALUE: (x) => toNum(x),
    NOW: () => Date.now() / 86400000 + 25569,   // Excel serial
    TODAY: () => Math.floor(Date.now() / 86400000 + 25569),
    YEAR: (s) => serialToDate(s).getUTCFullYear(),
    MONTH: (s) => serialToDate(s).getUTCMonth() + 1,
    DAY: (s) => serialToDate(s).getUTCDate(),
    ISBLANK: (x) => x === '' || x == null,
    ISNUMBER: (x) => typeof x === 'number',
    ISTEXT: (x) => typeof x === 'string' && !isErr(x),
    ISLOGICAL: (x) => typeof x === 'boolean',
    ISERROR: (x) => isErr(x),
    ISERR: (x) => isErr(x) && x !== '#N/A',
    ISNA: (x) => x === '#N/A',
    MEDIAN: (...a) => {
      const n = flattenNums(a).sort((x, y) => x - y);
      if (!n.length) throw error('#NUM!');
      const m = Math.floor(n.length / 2);
      return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
    },
    VLOOKUP: (value, range, colIdx, exact) => {
      // 4th arg (range_lookup): TRUE/omitted = approximate, FALSE/0 = exact.
      const rows = as2D(range);
      const ci = toNum(colIdx);
      if (ci < 1 || ci > (rows[0] || []).length) throw error('#REF!');
      const approx = exact === undefined ? true : truthy(exact);
      let best = null;
      for (const r of rows) {
        const first = r[0];
        if (looseEq(first, value)) return r[ci - 1];
        if (approx && typeof first === 'number' && typeof value === 'number' && first <= value) {
          if (!best || first > best[0]) best = [first, r[ci - 1]];
        }
      }
      if (approx && best) return best[1];
      throw error('#N/A');
    },
    HLOOKUP: (value, range, rowIdx, exact) => {
      const rows = as2D(range);
      const ri = toNum(rowIdx);
      if (ri < 1 || ri > rows.length) throw error('#REF!');
      const cols = rows[0];
      const approx = exact === undefined ? true : truthy(exact);
      let bestCol = -1;
      for (let c = 0; c < cols.length; c++) {
        const v = cols[c];
        if (looseEq(v, value)) { bestCol = c; break; }
        if (approx && typeof v === 'number' && typeof value === 'number' && v <= value) bestCol = c;
      }
      if (bestCol < 0) throw error('#N/A');
      return rows[ri - 1][bestCol];
    },
    INDEX: (range, row, col) => {
      const rows = as2D(range);
      let r = (toNum(row ?? 1) || 1) - 1, c = (toNum(col ?? 1) || 1) - 1;
      if (rows.length === 1 && col === undefined) { c = r; r = 0; }   // INDEX(A1:E1, 3)
      if (!rows[r] || rows[r][c] === undefined) throw error('#REF!');
      return rows[r][c];
    },
    MATCH: (value, range, type) => {
      const flat = flatten([as2D(range)]);
      const t = type === undefined ? 1 : toNum(type);
      if (t === 0) {
        for (let i = 0; i < flat.length; i++) if (looseEq(flat[i], value)) return i + 1;
        throw error('#N/A');
      }
      let last = 0;
      for (let i = 0; i < flat.length; i++) {
        const c = compare(flat[i], value);
        if (t > 0 ? c <= 0 : c >= 0) last = i + 1; else break;
      }
      if (!last) throw error('#N/A');
      return last;
    },
    RANK: (value, range, order) => {
      const n = flattenNums([as2D(range)]);
      const asc = order !== undefined && truthy(order);
      const sorted = [...n].sort((a, b) => asc ? a - b : b - a);
      const idx = sorted.indexOf(toNum(value));
      if (idx < 0) throw error('#N/A');
      return idx + 1;
    },
    RANDBETWEEN: (lo, hi) => { lo = Math.ceil(toNum(lo)); hi = Math.floor(toNum(hi)); return Math.floor(Math.random() * (hi - lo + 1)) + lo; },
    STDEV: (...a) => {
      const n = flattenNums(a);
      if (n.length < 2) throw error('#DIV/0!');
      const m = n.reduce((x, y) => x + y, 0) / n.length;
      return Math.sqrt(n.reduce((x, y) => x + (y - m) ** 2, 0) / (n.length - 1));
    },
    VAR: (...a) => {
      const n = flattenNums(a);
      if (n.length < 2) throw error('#DIV/0!');
      const m = n.reduce((x, y) => x + y, 0) / n.length;
      return n.reduce((x, y) => x + (y - m) ** 2, 0) / (n.length - 1);
    },
  };
  // Functions that look at error values instead of failing on them.
  const ERROR_TOLERANT = new Set(['COUNT', 'COUNTA', 'COUNTBLANK', 'ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISLOGICAL', 'ISERROR', 'ISERR', 'ISNA']);

  // ---------- Evaluator ----------
  // env: { row, col, read(sheet|null, addr) -> value }
  function evaluate(node, env) {
    switch (node.t) {
      case 'num': case 'str': return node.v;
      case 'name': {
        const up = node.v.toUpperCase();
        if (up === 'TRUE') return true;
        if (up === 'FALSE') return false;
        throw error('#NAME?');
      }
      case 'ref': return env.read(node.sheet, keyOf(node.col, node.row));
      case 'range': {
        const c1 = Math.min(node.a.col, node.b.col), c2 = Math.max(node.a.col, node.b.col);
        const r1 = Math.min(node.a.row, node.b.row), r2 = Math.max(node.a.row, node.b.row);
        const out = [];
        for (let r = r1; r <= r2; r++) {
          const row = [];
          for (let c = c1; c <= c2; c++) row.push(env.read(node.sheet, keyOf(c, r)));
          out.push(row);
        }
        return out;
      }
      case 'pct': return toNum(scalar(evaluate(node.operand, env))) / 100;
      case 'unary': {
        const v = toNum(scalar(evaluate(node.operand, env)));
        return node.op === '-' ? -v : v;
      }
      case 'binop': {
        const l = scalar(evaluate(node.left, env));
        const r = scalar(evaluate(node.right, env));
        if (isErr(l)) throw error(l);
        if (isErr(r)) throw error(r);
        switch (node.op) {
          case '+': return toNum(l) + toNum(r);
          case '-': return toNum(l) - toNum(r);
          case '*': return toNum(l) * toNum(r);
          case '/': { const d = toNum(r); if (d === 0) throw error('#DIV/0!'); return toNum(l) / d; }
          case '^': return Math.pow(toNum(l), toNum(r));
          case '&': return toText(l) + toText(r);
          case '=': return compare(l, r) === 0;
          case '<>': case '!=': return compare(l, r) !== 0;
          case '<': return compare(l, r) < 0;
          case '>': return compare(l, r) > 0;
          case '<=': return compare(l, r) <= 0;
          case '>=': return compare(l, r) >= 0;
        }
        throw error('#VALUE!');
      }
      case 'call': return callFn(node, env);
    }
    throw error('#ERROR!');
  }
  // A range used where one value is expected: 1x1 collapses, larger is #VALUE!.
  function scalar(v) {
    if (!Array.isArray(v)) return v;
    if (v.length === 1 && v[0].length === 1) return v[0][0];
    throw error('#VALUE!');
  }

  function callFn(node, env) {
    const { name, args } = node;
    // Lazy / reference-aware functions first.
    if (name === 'IF') {
      if (args.length < 2) throw error('#VALUE!');
      const cond = scalar(evaluate(args[0], env));
      if (isErr(cond)) throw error(cond);
      if (truthy(cond)) return evaluate(args[1], env);
      return args.length > 2 ? evaluate(args[2], env) : false;
    }
    if (name === 'IFERROR' || name === 'IFNA') {
      let v;
      try { v = evaluate(args[0], env); } catch (e) { v = codeOf(e); }
      const failed = name === 'IFERROR' ? isErr(v) : v === '#N/A';
      return failed ? (args[1] ? evaluate(args[1], env) : '') : v;
    }
    if (name === 'ROW' || name === 'COLUMN') {
      const a = args[0];
      const pick = (n) => name === 'ROW' ? n.row + 1 : n.col + 1;
      if (!a) return name === 'ROW' ? env.row + 1 : env.col + 1;
      if (a.t === 'ref') return pick(a);
      if (a.t === 'range') return name === 'ROW' ? Math.min(a.a.row, a.b.row) + 1 : Math.min(a.a.col, a.b.col) + 1;
      throw error('#VALUE!');
    }
    const fn = FUNCS[name];
    if (!fn) throw error('#NAME?');
    let vals;
    if (ERROR_TOLERANT.has(name)) {
      vals = args.map(a => { try { return evaluate(a, env); } catch (e) { return codeOf(e); } });
    } else {
      vals = args.map(a => evaluate(a, env));
      for (const v of flatten(vals)) if (isErr(v)) throw error(v);
    }
    const out = fn(...vals);
    if (out === undefined) throw error('#REF!');
    if (typeof out === 'number' && !isFinite(out)) throw error('#NUM!');
    return out;
  }

  // ---------- Recalculation ----------
  // resolveSheet(name) -> another sheet's cell map, or null if unknown.
  function makeEvaluator(resolveSheet) {
    const memo = new Map();       // cell map -> Map(addr -> value)
    const active = new Set();     // cells being evaluated, for cycle detection
    const ids = new WeakMap();
    let nextId = 1;
    const idOf = (d) => { if (!ids.has(d)) ids.set(d, nextId++); return ids.get(d); };

    function valueOf(data, addr) {
      let m = memo.get(data);
      if (!m) { m = new Map(); memo.set(data, m); }
      if (m.has(addr)) return m.get(addr);
      const cell = data[addr];
      let v;
      if (!cell || cell.raw == null || cell.raw === '') v = '';
      else if (String(cell.raw)[0] !== '=') v = parseLiteral(cell.raw);
      else {
        const key = idOf(data) + '!' + addr;
        if (active.has(key)) return '#CYCLE!';
        active.add(key);
        try { v = evalCell(cell, data, addr); } catch (e) { v = codeOf(e); }
        active.delete(key);
      }
      m.set(addr, v);
      return v;
    }

    function evalCell(cell, data, addr) {
      if (cell._astRaw !== cell.raw) {
        cell._astRaw = cell.raw;
        try { cell._ast = parse(cell.raw.slice(1)); cell._astErr = null; }
        catch (e) { cell._ast = null; cell._astErr = codeOf(e); }
      }
      if (!cell._ast) throw error(cell._astErr);
      const at = parseAddr(addr) || { row: 0, col: 0 };
      const env = {
        row: at.row, col: at.col,
        read: (sheet, a) => {
          if (!sheet) return valueOf(data, a);
          const other = resolveSheet ? resolveSheet(sheet) : null;
          if (!other) throw error('#REF!');
          return valueOf(other, a);
        },
      };
      const v = scalar(evaluate(cell._ast, env));
      return v == null ? '' : v;
    }
    return valueOf;
  }

  function recalcSheet(data, resolveSheet) {
    const valueOf = makeEvaluator(resolveSheet);
    for (const addr of Object.keys(data)) data[addr].value = valueOf(data, addr);
  }

  // Value of one expression (without a sheet), for tests and quick checks.
  function evalFormula(raw, data = {}, resolveSheet = null) {
    const tmp = Object.assign(Object.create(null), data);
    tmp.__probe__ = { raw };
    return makeEvaluator(resolveSheet)(tmp, '__probe__');
  }

  // ---------- Display ----------
  function formatNumber(n) {
    if (!isFinite(n)) return '#NUM!';
    // Keep reasonable precision; avoid float noise like 0.30000000000000004
    const r = Math.round(n * 1e10) / 1e10;
    return '' + r;
  }

  return {
    ERRORS, isErr,
    colName, colIndex, keyOf, parseAddr,
    parseLiteral, tokenize, parse, evaluate, shiftRefs,
    recalcSheet, evalFormula, formatNumber, FUNCS,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Formula;
