// Unit tests for the pure helpers in js/docexport.js. Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/docexport.js');

// --- parseColor ---

test('parseColor: rgb() standard', () => {
  assert.deepEqual(D.parseColor('rgb(255, 0, 0)'), [255, 0, 0]);
  assert.deepEqual(D.parseColor('rgb(10, 20, 30)'), [10, 20, 30]);
});

test('parseColor: rgba() with opaque alpha', () => {
  assert.deepEqual(D.parseColor('rgba(0, 128, 255, 1)'), [0, 128, 255]);
  assert.deepEqual(D.parseColor('rgba(50, 50, 50, 0.8)'), [50, 50, 50]);
});

test('parseColor: rgba() with alpha 0 is transparent', () => {
  assert.equal(D.parseColor('rgba(0, 0, 0, 0)'), null);
});

test('parseColor: invalid / empty input returns null', () => {
  assert.equal(D.parseColor(''), null);
  assert.equal(D.parseColor(null), null);
  assert.equal(D.parseColor(undefined), null);
  assert.equal(D.parseColor('red'), null);
  assert.equal(D.parseColor('#ff0000'), null);
  assert.equal(D.parseColor('hsl(0, 100%, 50%)'), null);
});

test('parseColor: fractional values', () => {
  const c = D.parseColor('rgb(12.5, 200.3, 99.9)');
  assert.ok(Math.abs(c[0] - 12.5) < 0.01);
  assert.ok(Math.abs(c[1] - 200.3) < 0.01);
  assert.ok(Math.abs(c[2] - 99.9) < 0.01);
});

// --- hex ---

test('hex: basic colors', () => {
  assert.equal(D.hex([255, 0, 0]), 'FF0000');
  assert.equal(D.hex([0, 128, 255]), '0080FF');
  assert.equal(D.hex([0, 0, 0]), '000000');
  assert.equal(D.hex([255, 255, 255]), 'FFFFFF');
});

test('hex: rounds fractional values', () => {
  assert.equal(D.hex([12.4, 200.6, 99.1]), '0CC963');
});

test('hex: single-digit values are zero-padded', () => {
  assert.equal(D.hex([1, 2, 3]), '010203');
});