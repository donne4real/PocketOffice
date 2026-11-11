// Unit tests for the pure page-range parser in js/pdftools.js. Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/pdftools.js');

test('parseRange: single pages', () => {
  assert.deepEqual(P.parseRange('1, 3, 5', 10), [1, 3, 5]);
});

test('parseRange: a dash range', () => {
  assert.deepEqual(P.parseRange('1-3', 10), [1, 2, 3]);
});

test('parseRange: reversed dash range is swapped', () => {
  assert.deepEqual(P.parseRange('5-3', 10), [3, 4, 5]);
});

test('parseRange: mixed ranges and singles, like the UI placeholder', () => {
  assert.deepEqual(P.parseRange('1-3, 5, 8-10', 10), [1, 2, 3, 5, 8, 9, 10]);
});

test('parseRange: out-of-bounds pages are dropped, not clamped', () => {
  assert.deepEqual(P.parseRange('0, 1, 10, 11', 10), [1, 10]);
});

test('parseRange: duplicates across overlapping parts collapse once', () => {
  assert.deepEqual(P.parseRange('1-3, 2-4', 10), [1, 2, 3, 4]);
});

test('parseRange: garbage input yields no pages, not a crash', () => {
  assert.deepEqual(P.parseRange('', 10), []);
  assert.deepEqual(P.parseRange('abc', 10), []);
  assert.deepEqual(P.parseRange('--', 10), []);
});
