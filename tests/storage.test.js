// Unit tests for the pure helpers in js/storage.js. Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Util, History } = require('../js/storage.js');

test('nextSeq continues after the highest id, not the count', () => {
  // v1 bug: restoring [w2, w3] set the counter to 3 and minted a second 'w3'.
  assert.equal(Util.nextSeq(['w2', 'w3'], 'w'), 4);
  assert.equal(Util.nextSeq([], 'w'), 1);
  assert.equal(Util.nextSeq(['s10', 's2', 'x99', null], 's'), 11);
});

test('safeColor only passes #hex colors', () => {
  assert.equal(Util.safeColor('#1a3a6c', '#000'), '#1a3a6c');
  assert.equal(Util.safeColor('#fff', '#000'), '#fff');
  assert.equal(Util.safeColor('"><img src=x onerror=alert(1)>', '#000'), '#000');
  assert.equal(Util.safeColor('red;background:url(x)', '#000'), '#000');
  assert.equal(Util.safeColor(undefined, '#abc'), '#abc');
});

test('safeNum rejects non-finite input', () => {
  assert.equal(Util.safeNum('12.5', 0), 12.5);
  assert.equal(Util.safeNum('x', 7), 7);
  assert.equal(Util.safeNum(Infinity, 7), 7);
});

test('History undo/redo round trip', () => {
  let doc = 'a';
  const key = 't1';
  History.reset(key);
  History.registerCurrentSnapshot(key, () => doc, (s) => { doc = s; });
  History.snapshot(key, doc, (s) => { doc = s; });
  doc = 'ab';
  assert.equal(History.undo(key), true);
  assert.equal(doc, 'a');
  assert.equal(History.redo(key), true);
  assert.equal(doc, 'ab');
});

test('History redo works for an empty-string document', () => {
  let doc = '';
  const key = 't2';
  History.reset(key);
  History.registerCurrentSnapshot(key, () => doc, (s) => { doc = s; });
  History.snapshot(key, doc, (s) => { doc = s; });
  doc = 'x';
  History.undo(key);
  assert.equal(doc, '');
  assert.equal(History.can(key).redo, true);
});

test('History drops the oldest string snapshots past the memory budget', () => {
  const key = 't3';
  History.reset(key);
  const big = 'x'.repeat(10e6);   // 10M chars each; budget is 25M
  for (let i = 0; i < 5; i++) History.snapshot(key, big + i, () => {});
  let n = 0;
  while (History.undo(key)) n++;
  assert.ok(n >= 1 && n <= 2, `expected 1-2 entries kept, got ${n}`);
});
