import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMirror, geometry, archiOnlineCommit, toRecords, writesFor, isNodeGhosted, isConnectableGhosted, VIEWPOINTS } from '../../extensions/archi/canvas.js';

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

// W-111: the editor writes the difference between two models. The mirror's inverse has to be
// exact, or opening a view and committing nothing would write.
const storedById = new Map(Object.values(records).flat().map(record => [record.recordId, record]));

test('the mirror turned back into records is the records: every owned field of all 778, and no writes', () => {
  const mirror = buildMirror(records);
  const planned = toRecords(mirror, storedById);
  assert.equal(planned.size, 778);
  const differ = [];
  for (const [id, { values }] of planned) {
    for (const [field, value] of Object.entries(values)) {
      const kept = storedById.get(id).values[field];
      if (!((kept ?? '') === '' && (value ?? '') === '') && kept !== value) differ.push([id, field, kept, value]);
    }
  }
  assert.deepEqual(differ.slice(0, 5), []);
  assert.deepEqual(writesFor(records, mirror, buildMirror(records)), []);
});

test('moving a box writes its x and y and nothing else, with the version it was read at', () => {
  const before = buildMirror(records), after = structuredClone(before);
  const node = Object.values(after.nodes).find(candidate => candidate.nodeType === 'element');
  node.bounds.x += 24; node.bounds.y -= 12;
  const writes = writesFor(records, before, after);
  const kept = storedById.get(node.id);
  assert.deepEqual(writes, [{ op: 'update', entityId: 'ar.item', recordId: node.id, version: kept.version,
    values: { 'ar.item.x': kept.values['ar.item.x'] + 24, 'ar.item.y': kept.values['ar.item.y'] - 12 } }]);
});

test('a new element on a view is created before its box, and the box names the element and the view', () => {
  const before = buildMirror(records), after = structuredClone(before);
  const view = Object.values(after.views)[0];
  const folder = Object.values(after.folders).find(candidate => candidate.folderType === 'business');
  after.elements['ar-id-new-element'] = { id: 'ar-id-new-element', kind: 'element', type: 'BusinessActor', name: 'Broker', documentation: '',
    properties: [], profileIds: [], folderId: folder.id };
  folder.itemIds.push('ar-id-new-element');
  after.nodes['ar-id-new-box'] = { id: 'ar-id-new-box', viewId: view.id, parentId: view.id, nodeType: 'element', elementId: 'ar-id-new-element',
    bounds: { x: 10, y: 10, width: 120, height: 55 }, childIds: [], sourceConnectionIds: [], targetConnectionIds: [] };
  view.childIds.push('ar-id-new-box');
  const writes = writesFor(records, before, after);
  assert.deepEqual(writes.map(write => [write.op, write.recordId]), [['create', 'ar-id-new-element'], ['create', 'ar-id-new-box']]);
  assert.equal(writes[0].values['ar.concept.archiId'], 'id-new-element');
  assert.equal(writes[1].values['ar.item.concept'], 'ar-id-new-element');
  assert.equal(writes[1].targetVersions['ar.item.view'], storedById.get(view.id).version);
  assert.equal(writes[1].targetVersions['ar.item.concept'], undefined, 'A target created in the same batch was given a version.');
  const last = Math.max(...view.childIds.slice(0, -1).map(id => storedById.get(id)?.values['ar.item.order'] ?? 0));
  assert.ok(writes[1].values['ar.item.order'] > last, 'The new box was not ordered after its siblings.');
});

test('deleting a box takes its connections and properties, each before what it points at', () => {
  const before = buildMirror(records), after = structuredClone(before);
  const node = Object.values(after.nodes).find(candidate => candidate.sourceConnectionIds.length > 0 && candidate.childIds.length === 0);
  const lines = Object.values(after.connections).filter(line => line.sourceId === node.id || line.targetId === node.id).map(line => line.id);
  for (const id of lines) delete after.connections[id];
  const siblings = node.parentId === node.viewId ? after.views[node.viewId].childIds : after.nodes[node.parentId].childIds;
  siblings.splice(siblings.indexOf(node.id), 1);
  delete after.nodes[node.id];
  const writes = writesFor(records, before, after);
  assert.ok(writes.every(write => write.op === 'delete'));
  const order = writes.map(write => write.recordId);
  assert.deepEqual(new Set(order), new Set([node.id, ...lines, ...order.filter(id => storedById.get(id).entityId === 'ar.property')]));
  for (const id of lines) assert.ok(order.indexOf(id) < order.indexOf(node.id), `${id} is deleted after the box it points at.`);
});

test('committed later, collected edits write only what they changed: a field set elsewhere meanwhile keeps its value', () => {
  const before = buildMirror(records), after = structuredClone(before);
  const node = Object.values(after.nodes).find(candidate => candidate.nodeType === 'element');
  node.bounds.x += 40;
  const elsewhere = structuredClone(records);
  const all = Object.values(elsewhere).flat();
  const record = all.find(candidate => candidate.recordId === node.id);
  record.values['ar.item.fillColor'] = '#ff0000'; record.values['ar.item.y'] += 5; record.version += 1;
  const writes = writesFor(elsewhere, before, after);
  assert.deepEqual(writes, [{ op: 'update', entityId: 'ar.item', recordId: node.id, version: record.version,
    values: { 'ar.item.x': storedById.get(node.id).values['ar.item.x'] + 40 } }]);
});

// W-116: a view's viewpoint is the key its record stores, and what the canvas ghosts follows it.
test("a view's stored viewpoint reaches the mirror, and ghosts exactly the boxes whose type it leaves out, with their lines", () => {
  const view = records['ar.view'].find(record => record.values['ar.view.name'] === 'Organisation Tree View');
  assert.equal(view.values['ar.view.viewpoint'], 'organization');
  const typeKey = new Map(records['ar.type'].map(record => [record.recordId, record.values['ar.type.key']]));
  const conceptType = new Map(records['ar.concept'].map(record => [record.recordId, typeKey.get(record.values['ar.concept.type'])]));
  const boxes = records['ar.item'].filter(item => item.values['ar.item.view'] === view.recordId && item.values['ar.item.kind'] === 'Element');
  for (const [viewpoint, allowed] of [['organization', null], ['strategy', ['Resource', 'Capability', 'ValueStream', 'CourseOfAction', 'Outcome']], [null, null], ['no-such-viewpoint', null]]) {
    const changed = structuredClone(records);
    changed['ar.view'].find(record => record.recordId === view.recordId).values['ar.view.viewpoint'] = viewpoint;
    const mirror = buildMirror(changed);
    assert.equal(mirror.views[view.recordId].viewpoint, viewpoint ?? undefined);
    const expected = boxes.filter(item => {
      const key = conceptType.get(item.values['ar.item.concept']);
      return allowed !== null && !['Junction', 'Grouping', ...allowed].includes(key);
    }).map(item => item.recordId).sort();
    assert.deepEqual(boxes.filter(item => isNodeGhosted(mirror, item.recordId, mirror.views[view.recordId].viewpoint)).map(item => item.recordId).sort(), expected, `${viewpoint}: other boxes ghosted`);
    const ghostedLines = Object.values(mirror.connections).filter(line => line.viewId === view.recordId && isConnectableGhosted(mirror, line.id, mirror.views[view.recordId].viewpoint));
    const touching = Object.values(mirror.connections).filter(line => line.viewId === view.recordId && (expected.includes(line.sourceId) || expected.includes(line.targetId)));
    assert.deepEqual(ghostedLines.map(line => line.id).sort(), touching.map(line => line.id).sort(), `${viewpoint}: other lines ghosted`);
    if (viewpoint === 'strategy') assert.ok(expected.length > 10 && touching.length > 5, `strategy ghosts only ${expected.length} boxes and ${touching.length} lines`);
  }
  assert.equal(VIEWPOINTS.length, 25);
});
