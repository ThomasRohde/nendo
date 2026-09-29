import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMirror, geometry, archiOnlineCommit } from '../../extensions/archi/canvas.js';

// W-110: the workbench draws from a mirror of Archi.nendo's records, through archi-online's own
// geometry. The reference is archi-online's geometry of its own parse of the same file
// (archisurance-geometry.json, from make-fixture.mjs), so a difference is the mirror's.
const { records } = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
const reference = JSON.parse(readFileSync(new URL('./archisurance-geometry.json', import.meta.url), 'utf8'));
const round = value => Math.round(value * 100) / 100;

test('the canvas names the archi-online commit it was built from', () => {
  assert.match(archiOnlineCommit, /^[0-9a-f]{40}$/);
});

test('every Archisurance view has the bounds and routes archi-online gives it, object by object and point by point', () => {
  const mirror = buildMirror(records);
  const views = Object.keys(reference);
  assert.equal(views.length, 17);
  let objects = 0, connections = 0;
  for (const viewId of views) {
    const { bounds, routes } = geometry(mirror, viewId);
    const expected = reference[viewId];
    assert.deepEqual([...bounds.keys()].sort(), Object.keys(expected.bounds).sort(), `${viewId}: not the same objects`);
    for (const [id, b] of bounds) {
      assert.deepEqual([b.x, b.y, b.width, b.height].map(round), expected.bounds[id], `${viewId}: ${id} is drawn elsewhere`);
      objects++;
    }
    assert.deepEqual([...routes.keys()].sort(), Object.keys(expected.routes).sort(), `${viewId}: not the same connections`);
    for (const [id, points] of routes) {
      assert.deepEqual(points.map(p => [round(p.x), round(p.y)]), expected.routes[id], `${viewId}: ${id} takes another route`);
      connections++;
    }
  }
  assert.equal(objects, 249);
  assert.equal(connections, 199);
});
