// Unit tests for the v2.1 additions: new formulas, number formats, Impress
// notes/groups and the backup CSV. Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/formula.js');
global.Formula = F;
global.Util = require('../js/storage.js').Util;
const { Backup } = require('../js/storage.js');
const I = require('../js/impress.js');

const ev = (raw, cells = {}) => {
  const data = Object.create(null);
  for (const [k, r] of Object.entries(cells)) data[k] = { raw: r };
  return F.evalFormula(raw, data);
};

test('SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS', () => {
  const cells = { A1: 'x', B1: '1', C1: '10', A2: 'x', B2: '2', C2: '20', A3: 'y', B3: '3', C3: '30' };
  assert.equal(ev('=SUMIFS(C1:C3,A1:A3,"x",B1:B3,">1")', cells), 20);
  assert.equal(ev('=SUMIFS(C1:C3,A1:A3,"x")', cells), 30);
  assert.equal(ev('=COUNTIFS(A1:A3,"x",B1:B3,"<2")', cells), 1);
  assert.equal(ev('=AVERAGEIFS(C1:C3,A1:A3,"x")', cells), 15);
  assert.equal(ev('=MAXIFS(C1:C3,A1:A3,"x")', cells), 20);
  assert.equal(ev('=MINIFS(C1:C3,B1:B3,">=2")', cells), 20);
  assert.equal(ev('=AVERAGEIFS(C1:C3,A1:A3,"z")', cells), '#DIV/0!');
  assert.equal(ev('=SUMIFS(C1:C3,A1:A2,"x")', cells), '#VALUE!');
});

test('IFS and SWITCH', () => {
  assert.equal(ev('=IFS(1>2,"a",2>1,"b")'), 'b');
  assert.equal(ev('=IFS(1>2,"a")'), '#N/A');
  assert.equal(ev('=IFS(TRUE,"ok",TRUE,1/0)'), 'ok');
  assert.equal(ev('=SWITCH(2,1,"one",2,"two","other")'), 'two');
  assert.equal(ev('=SWITCH(9,1,"one","other")'), 'other');
  assert.equal(ev('=SWITCH(9,1,"one",2,"two")'), '#N/A');
});

test('XLOOKUP', () => {
  const cells = { A1: '10', B1: 'lo', A2: '20', B2: 'mid', A3: '30', B3: 'hi', D1: 'apple', E1: '1', D2: 'banana', E2: '2' };
  assert.equal(ev('=XLOOKUP(20,A1:A3,B1:B3)', cells), 'mid');
  assert.equal(ev('=XLOOKUP(25,A1:A3,B1:B3)', cells), '#N/A');
  assert.equal(ev('=XLOOKUP(25,A1:A3,B1:B3,"none")', cells), 'none');
  assert.equal(ev('=XLOOKUP(25,A1:A3,B1:B3,"none",-1)', cells), 'mid');
  assert.equal(ev('=XLOOKUP(25,A1:A3,B1:B3,"none",1)', cells), 'hi');
  assert.equal(ev('=XLOOKUP("ban*",D1:D2,E1:E2,"none",2)', cells), 2);
});

test('dates: DATE, EOMONTH, EDATE, WEEKDAY, DATEDIF, ISO text dates', () => {
  assert.equal(ev('=DATE(2026,9,23)'), 46288);
  assert.equal(ev('=DATE(2026,13,1)'), ev('=DATE(2027,1,1)'));
  assert.equal(ev('=YEAR("2026-09-23")'), 2026);
  assert.equal(ev('=TEXT(EOMONTH("2026-01-15",1),"yyyy-mm-dd")'), '2026-02-28');
  assert.equal(ev('=TEXT(EOMONTH("2024-01-15",1),"yyyy-mm-dd")'), '2024-02-29');
  assert.equal(ev('=TEXT(EDATE("2026-01-31",1),"yyyy-mm-dd")'), '2026-02-28');
  assert.equal(ev('=WEEKDAY("2026-11-11")'), 4);
  assert.equal(ev('=WEEKDAY("2026-11-11",2)'), 3);
  assert.equal(ev('=DAYS("2026-03-01","2026-02-01")'), 28);
  assert.equal(ev('=DATEDIF("2020-02-29","2026-02-28","Y")'), 5);
  assert.equal(ev('=DATEDIF("2026-01-31","2026-03-01","M")'), 1);
  assert.equal(ev('=DATEVALUE("not a date")'), '#VALUE!');
  assert.equal(ev('=HOUR(0.75)'), 18);
});

test('text and maths additions', () => {
  assert.equal(ev('=TEXTJOIN(", ",TRUE,A1:A3)', { A1: 'a', A3: 'c' }), 'a, c');
  assert.equal(ev('=TEXTJOIN("-",FALSE,A1:A3)', { A1: 'a', A3: 'c' }), 'a--c');
  assert.equal(ev('=FIND("lo","hello")'), 4);
  assert.equal(ev('=FIND("LO","hello")'), '#VALUE!');
  assert.equal(ev('=SEARCH("LO","hello")'), 4);
  assert.equal(ev('=PROPER("hello wORLD")'), 'Hello World');
  assert.equal(ev('=REPT("ab",3)'), 'ababab');
  assert.equal(ev('=SUMPRODUCT(A1:A2,B1:B2)', { A1: '2', B1: '3', A2: '4', B2: '5' }), 26);
  assert.equal(ev('=CEILING(2.1,0.5)'), 2.5);
  assert.equal(ev('=FLOOR(2.9,0.5)'), 2.5);
  assert.equal(ev('=LARGE(A1:A3,2)', { A1: '5', A2: '9', A3: '7' }), 7);
});

test('formatValue: numbers', () => {
  const f = F.formatValue;
  assert.equal(f(1234.567, '#,##0.00'), '1,234.57');
  assert.equal(f(-1234.5, '$#,##0.00'), '-$1,234.50');
  assert.equal(f(0.5, '0%'), '50%');
  assert.equal(f(12345, '0.00E+00'), '1.23E+04');
  assert.equal(f(5, '000'), '005');
  assert.equal(f(-0.001, '0.00'), '0.00');
  assert.equal(f(1234.5, '#,##0 "units"'), '1,235 units');
  assert.equal(f(1234.5, '[$€-407]#,##0.00'), '€1,234.50');
  assert.equal(f(3, 'General'), '3');
  assert.equal(f('text', '0.00'), 'text');
});

test('formatValue: dates and times', () => {
  const f = F.formatValue;
  assert.equal(f(46288, 'yyyy-mm-dd'), '2026-09-23');
  assert.equal(f(46288, 'd mmm yyyy'), '23 Sep 2026');
  assert.equal(f(46288.5, 'yyyy-mm-dd hh:mm'), '2026-09-23 12:00');
  assert.equal(f(0.75, 'h:mm AM/PM'), '6:00 PM');
});

test('Impress: notes are kept as capped text, group ids must be g<number>', () => {
  const out = I.normalizeSlides([
    { elements: [], notes: 'Say hello' },
    { elements: [], notes: 'x'.repeat(50000) },
    { elements: [], notes: { not: 'a string' } },
    { elements: [{ kind: 'rect', group: 'g2' }, { kind: 'rect', group: '"><img src=x>' }] },
  ]);
  assert.equal(out[0].notes, 'Say hello');
  assert.equal(out[1].notes.length, 20000);
  assert.equal('notes' in out[2], false);
  assert.deepEqual(out[3].elements.map(e => e.group), ['g2', undefined]);
});

test('Backup.cellsToCsv writes raw cell text, quoting where needed', () => {
  assert.equal(Backup.cellsToCsv({ A1: 'Item', B1: 'Qty', A2: 'Cup, big', B2: '=B1*2', C3: 'say "hi"' }),
    'Item,Qty,\r\n"Cup, big",=B1*2,\r\n,,"say ""hi"""');
  assert.equal(Backup.cellsToCsv({}), '');
});
