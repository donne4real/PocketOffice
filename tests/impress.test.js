// Unit tests for the pure deck-sanitizing helpers in js/impress.js. These
// guard against a crafted/corrupted .json deck injecting markup or breaking
// rendering when opened — previously only covered by a slow e2e browser test.
// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
// In the browser, classic <script> tags share one global scope, so impress.js
// can call the Util.safeColor/safeNum helpers defined in storage.js without
// importing them. Node's CommonJS modules don't share scope, so we recreate
// that one global binding before loading impress.js.
global.Util = require('../js/storage.js').Util;
const I = require('../js/impress.js');

test('normalizeSlides: keeps known element kinds and fields', () => {
  const out = I.normalizeSlides([{
    bg: '#eeeeee',
    elements: [{ kind: 'text', x: 10, y: 20, w: 30, h: 40, text: 'hi', fontSize: 24, bold: true, align: 'center' }],
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].bg, '#eeeeee');
  assert.equal(out[0].elements.length, 1);
  const el = out[0].elements[0];
  assert.equal(el.kind, 'text');
  assert.equal(el.text, 'hi');
  assert.equal(el.fontSize, 24);
  assert.equal(el.bold, true);
  assert.equal(el.align, 'center');
});

test('normalizeSlides: drops elements with an unknown kind', () => {
  const out = I.normalizeSlides([{
    elements: [
      { kind: 'text', text: 'keep me' },
      { kind: 'script', text: 'alert(1)' },
      { kind: 'iframe', src: 'evil.html' },
    ],
  }]);
  assert.equal(out[0].elements.length, 1);
  assert.equal(out[0].elements[0].text, 'keep me');
});

test('normalizeSlides: a crafted deck cannot inject markup via fontFamily', () => {
  const out = I.normalizeSlides([{
    elements: [{ kind: 'text', fontFamily: '</style><img src=x onerror=alert(1)>' }],
  }]);
  assert.ok(!/[<>"'{};\\]/.test(out[0].elements[0].fontFamily));
});

test('normalizeSlides: only data: image URLs with a known image MIME type survive', () => {
  const out = I.normalizeSlides([{
    elements: [
      { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      { kind: 'image', dataUrl: 'javascript:alert(1)' },
      { kind: 'image', dataUrl: 'data:text/html;base64,AAAA' },
    ],
  }]);
  assert.equal(out[0].elements[0].dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(out[0].elements[1].dataUrl, undefined);
  assert.equal(out[0].elements[2].dataUrl, undefined);
});

test('normalizeSlides: an invalid align value is dropped rather than kept as-is', () => {
  const out = I.normalizeSlides([{ elements: [{ kind: 'text', align: 'justify; evil' }] }]);
  assert.equal(out[0].elements[0].align, undefined);
});

test('normalizeSlides: non-array input becomes an empty deck, not a crash', () => {
  assert.deepEqual(I.normalizeSlides(null), []);
  assert.deepEqual(I.normalizeSlides(undefined), []);
  assert.deepEqual(I.normalizeSlides('not an array'), []);
});

test('normalizeSlides: non-object slides are dropped, non-array elements default to empty', () => {
  // null and a bare string aren't slide objects and are dropped entirely;
  // { elements: 'nope' } and {} are slide objects, so they're kept with
  // their non-array elements defaulted to [].
  const out = I.normalizeSlides([null, 'nope', { elements: 'nope' }, {}]);
  assert.equal(out.length, 2);
  for (const s of out) assert.deepEqual(s.elements, []);
});

test('ensureElementIds: every element gets a unique, non-empty id', () => {
  const slides = [
    { elements: [{ kind: 'text', id: '' }, { kind: 'text', id: '' }] },
    { elements: [{ kind: 'text', id: '' }] },
  ];
  I.ensureElementIds(slides);
  const ids = slides.flatMap(s => s.elements.map(e => e.id));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.ok(id);
});

test('ensureElementIds: a duplicate id from a crafted deck is replaced, not kept', () => {
  const slides = [{ elements: [{ kind: 'text', id: 'dup' }, { kind: 'text', id: 'dup' }] }];
  I.ensureElementIds(slides);
  const [a, b] = slides[0].elements;
  assert.notEqual(a.id, b.id);
});

test('ensureElementIds: a unique existing id is kept as-is', () => {
  const slides = [{ elements: [{ kind: 'text', id: 'keep-me' }] }];
  I.ensureElementIds(slides);
  assert.equal(slides[0].elements[0].id, 'keep-me');
});
