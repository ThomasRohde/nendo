import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

const {
  clampInspectorWidth, defaultInspectorWidth, inspectorResizerMarkup, inspectorWidthStorageKey, keyedInspectorWidth,
  minimumInspectorWidth, minimumSurfaceWidth, readInspectorWidth, writeInspectorWidth,
} = await bundleOf('src/inspector-width.ts');

// The record page beside a list was a fixed 330 px, too narrow for its own header and
// buttons. It now opens wider and its edge can be dragged; the width is kept for the device.

const memory = (initial = {}) => {
  const items = new Map(Object.entries(initial));
  return { items, getItem: (key) => items.has(key) ? items.get(key) : null, setItem: (key, value) => { items.set(key, String(value)); }, removeItem: (key) => { items.delete(key); } };
};

test('the page opens wider than the old 330 px', () => {
  assert.ok(defaultInspectorWidth >= 400, `default is ${defaultInspectorWidth}`);
});

test('a width keeps both the page and the list usable', () => {
  assert.equal(clampInspectorWidth(500, 1400), 500);
  assert.equal(clampInspectorWidth(100, 1400), minimumInspectorWidth);
  // The list keeps its minimum: a remembered wide page narrows in a small window.
  assert.equal(clampInspectorWidth(1200, 1000), 1000 - minimumSurfaceWidth);
  // A window too small for both still draws the page at its minimum.
  assert.equal(clampInspectorWidth(500, 500), minimumInspectorWidth);
});

test('the remembered width survives a round trip and refuses junk', () => {
  const storage = memory();
  assert.equal(readInspectorWidth(storage), null);
  writeInspectorWidth(storage, 512.4);
  assert.equal(storage.items.get(inspectorWidthStorageKey), '512');
  assert.equal(readInspectorWidth(storage), 512);
  writeInspectorWidth(storage, null);
  assert.equal(readInspectorWidth(storage), null);
  assert.equal(readInspectorWidth(memory({ [inspectorWidthStorageKey]: 'wide' })), null);
  assert.equal(readInspectorWidth(memory({ [inspectorWidthStorageKey]: '12' })), null);
  assert.equal(readInspectorWidth(null), null);
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  assert.equal(readInspectorWidth(refusing), null);
  assert.doesNotThrow(() => writeInspectorWidth(refusing, 400));
});

test('the arrow keys move the edge the way it points', () => {
  // The edge is the page's left side: moving it left widens the page.
  assert.equal(keyedInspectorWidth('ArrowLeft', false, 420, 1400), 436);
  assert.equal(keyedInspectorWidth('ArrowRight', false, 420, 1400), 404);
  assert.equal(keyedInspectorWidth('ArrowLeft', true, 420, 1400), 484);
  assert.equal(keyedInspectorWidth('Home', false, 420, 1400), 1400 - minimumSurfaceWidth);
  assert.equal(keyedInspectorWidth('End', false, 420, 1400), minimumInspectorWidth);
  assert.equal(keyedInspectorWidth('Enter', false, 420, 1400), null);
});

test('the edge is a focusable, named separator', () => {
  assert.match(inspectorResizerMarkup, /role="separator"/);
  assert.match(inspectorResizerMarkup, /aria-orientation="vertical"/);
  assert.match(inspectorResizerMarkup, /tabindex="0"/);
  assert.match(inspectorResizerMarkup, /aria-label="Resize details pane"/);
});
