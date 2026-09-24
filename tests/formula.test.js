// Unit tests for the Calc formula engine. Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/formula.js');

// Build a cell map from { A1: '5', B1: '=A1*2' } and recalc it.
function sheet(cells, resolve) {
  const data = Object.create(null);
  for (const [k, raw] of Object.entries(cells)) data[k] = { raw };
  F.recalcSheet(data, resolve);
  const out = {};
  for (const k of Object.keys(data)) out[k] = data[k].value;
  return out;
}
const ev = (raw, cells = {}) => {
  const data = Object.create(null);
  for (const [k, r] of Object.entries(cells)) data[k] = { raw: r };
  return F.evalFormula(raw, data);
};

test('literals: whole-string numbers only', () => {
  assert.equal(F.parseLiteral('42'), 42);
  assert.equal(F.parseLiteral(' -3.5 '), -3.5);
  assert.equal(F.parseLiteral('1e3'), 1000);
  assert.equal(F.parseLiteral('1,000'), 1000);
  assert.equal(F.parseLiteral('1,234.5'), 1234.5);
  assert.equal(F.parseLiteral('50%'), 0.5);
  assert.equal(F.parseLiteral('2026-09-23'), '2026-09-23');
  assert.equal(F.parseLiteral('1,5'), '1,5');
  assert.equal(F.parseLiteral('12 apples'), '12 apples');
  assert.equal(F.parseLiteral('TRUE'), true);
  assert.equal(F.parseLiteral(''), '');
});

test('arithmetic and precedence', () => {
  assert.equal(ev('=1+2*3'), 7);
  assert.equal(ev('=(1+2)*3'), 9);
  assert.equal(ev('=-2^2'), 4);          // Excel: unary minus binds tighter
  assert.equal(ev('=2^3^2'), 64);        // left-associative like Excel
  assert.equal(ev('="a"&1+2'), 'a3');    // & is below + in Excel
  assert.equal(ev('=1/0'), '#DIV/0!');
});

test('percent operator', () => {
  assert.equal(ev('=50%'), 0.5);
  assert.equal(ev('=200*10%'), 20);
  assert.equal(ev('=A1%', { A1: '25' }), 0.25);
});

test('syntax errors are reported, not silently truncated', () => {
  assert.equal(ev('=1 2'), '#ERROR!');
  assert.equal(ev('=1+'), '#ERROR!');
  assert.equal(ev('=SUM(1,2'), '#ERROR!');
  assert.equal(ev('=5 # 3'), '#ERROR!');
  assert.equal(ev('="open'), '#ERROR!');
});

test('absolute references', () => {
  const v = sheet({ A1: '10', B1: '=$A$1+1', C1: '=A$1*2', D1: '=$A1*3' });
  assert.equal(v.B1, 11);
  assert.equal(v.C1, 20);
  assert.equal(v.D1, 30);
});

test('function names that look like cells', () => {
  assert.equal(ev('=LOG10(100)'), 2);
  assert.equal(ev('=ATAN2(1,1)'), Math.PI / 4);
});

test('ranges and aggregates', () => {
  const cells = { A1: '1', A2: '2', A3: '3', A4: 'x', B1: '=SUM(A1:A4)', B2: '=AVERAGE(A1:A3)', B3: '=COUNT(A1:A4)', B4: '=COUNTA(A1:A4)' };
  const v = sheet(cells);
  assert.equal(v.B1, 6);
  assert.equal(v.B2, 2);
  assert.equal(v.B3, 3);
  assert.equal(v.B4, 4);
});

test('dependency order does not matter (single memoized pass)', () => {
  const v = sheet({ A1: '=A2+1', A2: '=A3+1', A3: '=A4+1', A4: '1' });
  assert.equal(v.A1, 4);
});

test('cycles are detected', () => {
  const v = sheet({ A1: '=B1', B1: '=A1' });
  assert.equal(v.A1, '#CYCLE!');
  assert.equal(v.B1, '#CYCLE!');
});

test('errors propagate through arithmetic', () => {
  const v = sheet({ A1: '=1/0', B1: '=A1+1', C1: '=SUM(A1,1)' });
  assert.equal(v.B1, '#DIV/0!');
  assert.equal(v.C1, '#DIV/0!');
});

test('IF is lazy and IFERROR catches', () => {
  assert.equal(ev('=IF(TRUE, 1, 1/0)'), 1);
  assert.equal(ev('=IF(1>2, "yes", "no")'), 'no');
  assert.equal(ev('=IFERROR(1/0, "fallback")'), 'fallback');
  assert.equal(ev('=IFERROR(5, "fallback")'), 5);
  assert.equal(ev('=ISERROR(1/0)'), true);
});

test('text comparison is case-insensitive', () => {
  assert.equal(ev('="abc"="ABC"'), true);
  assert.equal(ev('="a"<"b"'), true);
});

test('lookups', () => {
  const cells = { A1: 'apple', B1: '1', A2: 'pear', B2: '2', A3: 'plum', B3: '3' };
  assert.equal(ev('=VLOOKUP("pear", A1:B3, 2, FALSE)', cells), 2);
  assert.equal(ev('=VLOOKUP("kiwi", A1:B3, 2, FALSE)', cells), '#N/A');
  assert.equal(ev('=INDEX(A1:B3, 3, 1)', cells), 'plum');
  assert.equal(ev('=MATCH("plum", A1:A3, 0)', cells), 3);
});

test('conditional aggregates', () => {
  const cells = { A1: '5', A2: '10', A3: '15', B1: 'x', B2: 'y', B3: 'x' };
  assert.equal(ev('=COUNTIF(A1:A3, ">5")', cells), 2);
  assert.equal(ev('=SUMIF(B1:B3, "x", A1:A3)', cells), 20);
  assert.equal(ev('=AVERAGEIF(A1:A3, "<=10")', cells), 7.5);
  assert.equal(ev('=COUNTIF(B1:B3, "x*")', cells), 2);
});

test('ROW and COLUMN', () => {
  assert.equal(ev('=ROW(C7)'), 7);
  assert.equal(ev('=COLUMN(C7)'), 3);
  const v = sheet({ B5: '=ROW()' });
  assert.equal(v.B5, 5);
});

test('cross-sheet references', () => {
  const other = Object.create(null);
  other.A1 = { raw: '7' };
  other.A2 = { raw: '=A1*2' };
  const resolve = (name) => (name.toLowerCase() === 'data sheet' || name === 'Data') ? other : null;
  const v = sheet({ A1: "='Data sheet'!A2+1", B1: '=Data!A1', C1: '=SUM(Data!A1:A2)', D1: '=Nope!A1' }, resolve);
  assert.equal(v.A1, 15);
  assert.equal(v.B1, 7);
  assert.equal(v.C1, 21);
  assert.equal(v.D1, '#REF!');
});

test('shiftRefs moves relative references only', () => {
  assert.equal(F.shiftRefs('=A1+B2', 1, 0), '=A2+B3');
  assert.equal(F.shiftRefs('=$A$1+A$1+$A1', 1, 1), '=$A$1+B$1+$A2');
  assert.equal(F.shiftRefs('=SUM(A1:A3)', 2, 0), '=SUM(A3:A5)');
  assert.equal(F.shiftRefs('=Data!A1', 1, 0), '=Data!A2');
  assert.equal(F.shiftRefs('=A1', -1, 0), '=#REF!');
  assert.equal(F.shiftRefs('=LOG10(A1)', 1, 0), '=LOG10(A2)');
  assert.equal(F.shiftRefs('plain', 1, 0), 'plain');
});

test('address helpers', () => {
  assert.equal(F.colName(0), 'A');
  assert.equal(F.colName(26), 'AA');
  assert.equal(F.colIndex('CV'), 99);
  assert.deepEqual(F.parseAddr('$B$3'), { col: 1, row: 2 });
});
