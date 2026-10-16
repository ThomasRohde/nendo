import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// One bar: a Use screen's toolbar shares the address row where the row's free middle holds it.
const { oneBarPlace, minimumWidth } = await bundleOf('src/one-bar.ts');

const box = (left, right) => ({ left, right, width: right - left, top: 0, bottom: 32 });

test('the toolbar sits between the breadcrumb and the command box, with a gap on each side', () => {
  assert.deepEqual(oneBarPlace(box(300, 1600), box(400, 620), box(1240, 1580)), { left: 328, right: 368 });
});

test('a middle narrower than the minimum keeps the toolbar on a row of its own', () => {
  const layer = box(0, 1000), identity = box(0, 400);
  const controls = box(400 + 8 + minimumWidth + 8 - 1, 1000);
  assert.equal(oneBarPlace(layer, identity, controls), null);
  assert.notEqual(oneBarPlace(layer, identity, box(controls.left + 1, 1000)), null);
});

test('a toolbar that needs more than the middle holds keeps its own row, whatever the minimum', () => {
  const layer = box(0, 1200), identity = box(0, 400), controls = box(800, 1200);
  assert.notEqual(oneBarPlace(layer, identity, controls, 300), null);
  assert.equal(oneBarPlace(layer, identity, controls, 500), null);
});
