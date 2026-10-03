import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  analyzeNestingChange, applyNestingChange, applyWrites, automaticRelationshipSettings, buildMirror, createModelStore,
  generatedViewModel, geometry, layoutModel, setAutomaticRelationshipSetting, toRecords, useElkWorkerFactory, validRelationshipTypes, writesFor,
} from '../../extensions/archi/canvas.js';

// W-115: Archi's automation in the workbench is archi-online's own code. What these tests hold is
// that each comes through Nendo's write path whole: the writes taken from the model the operation
// leaves, applied to the records and read back, are that model; and that each does what
// archi-online's own tests say it does, on Archisurance's records.
const { records } = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
// Node has no Worker: elkjs's own stand-in runs the vendored worker in this thread.
const { Worker: ElkWorker } = require('../../extensions/archi/vendor/elkjs/elk-worker.min.js');
useElkWorkerFactory(url => new ElkWorker(url));

const base = buildMirror(records);
const arm = automaticRelationshipSettings();
const defaults = Object.fromEntries(arm.rows.map(row => [row.key, row.initial]));
const bit = Object.fromEntries(arm.types.map(entry => [entry.type, entry.bit]));

/** The records after the writes, read back: the model the workbench would show. */
const readBack = (after, before = base) => buildMirror(applyWrites(records, writesFor(records, before, after)));
/** Two models the same, as the records each would store. */
const sameRecords = (actual, expected, message) => {
  const plain = model => [...toRecords(model)].map(([id, planned]) => [id, planned.values]).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.deepEqual(plain(actual), plain(expected), message);
};
const storeOf = model => createModelStore({ model: structuredClone(model) });
const typeOf = id => base.elements[id]?.type;
const related = (model, a, b) => Object.values(model.relationships).some(r => (r.sourceId === a && r.targetId === b) || (r.sourceId === b && r.targetId === a));
const topBoxes = (model, viewId) => model.views[viewId].childIds.map(id => model.nodes[id]).filter(node => node?.nodeType === 'element');
const inside = parent => ({ x: 20, y: 30, width: 120, height: 55, parent });

/** Two element boxes at the top of a view whose elements are unrelated, and that a default-mask relationship may join, container first. */
function unrelatedPair() {
  for (const view of Object.values(base.views)) {
    const boxes = topBoxes(base, view.id);
    for (const container of boxes) for (const child of boxes) {
      if (container === child || container.elementId === child.elementId || related(base, container.elementId, child.elementId)) continue;
      if (Object.values(base.nodes).some(node => node.parentId === container.id)) continue;
      const allowed = validRelationshipTypes(typeOf(container.elementId), typeOf(child.elementId));
      if (['CompositionRelationship', 'AggregationRelationship', 'AssignmentRelationship'].some(type => allowed.includes(type))) return { viewId: view.id, container, child };
    }
  }
  throw new Error('Archisurance has no two unrelated boxes that a relationship could join.');
}
const move = (viewId, node, parentId, bounds = { x: 20, y: 30, width: node.bounds.width, height: node.bounds.height }) =>
  ({ viewId, trigger: 'move', entries: [{ kind: 'move', nodeId: node.id, parentId, bounds }] });

test("the automatic relationships settings are Archi's, with its defaults: six types offered, none reversed, every type hidden while nested", () => {
  assert.deepEqual(arm.rows.map(row => row.key), ['useNestedConnections', 'createRelationWhenAddingNewElementToContainer',
    'createRelationWhenAddingModelTreeElementToContainer', 'createRelationWhenMovingElementToContainer', 'newRelationsTypes', 'newReverseRelationsTypes', 'hiddenRelationsTypes']);
  assert.equal(arm.types.length, 11);
  const offered = arm.types.filter(entry => defaults.newRelationsTypes & entry.bit).map(entry => entry.type).sort();
  assert.deepEqual(offered, ['AccessRelationship', 'AggregationRelationship', 'AssignmentRelationship', 'CompositionRelationship', 'RealizationRelationship', 'SpecializationRelationship']);
  assert.equal(defaults.newReverseRelationsTypes, 0);
  assert.equal(defaults.hiddenRelationsTypes, arm.types.reduce((mask, entry) => mask | entry.bit, 0));
  assert.equal(defaults.useNestedConnections, true);
  assert.throws(() => setAutomaticRelationshipSetting('gridSize', 5), /not an automatic relationships setting/);
});

test('moving a box within its parent offers nothing and writes only its place', () => {
  const { viewId, child } = unrelatedPair();
  const plan = analyzeNestingChange(base, move(viewId, child, viewId, { ...child.bounds, x: child.bounds.x + 16 }), defaults);
  assert.equal(plan.children.filter(entry => entry.candidates.length > 0).length, 0);
  const store = storeOf(base);
  applyNestingChange(plan, {}, store);
  const writes = writesFor(records, base, store.getState().model);
  assert.deepEqual(writes.map(write => [write.op, write.recordId, Object.keys(write.values)]), [['update', child.id, ['ar.item.x']]]);
});

test('nesting a box offers only the default types parent to child, and the one chosen is a new relationship whose line is hidden while nested', () => {
  const { viewId, container, child } = unrelatedPair();
  const plan = analyzeNestingChange(base, move(viewId, child, container.id), defaults);
  const candidates = plan.children[0].candidates;
  assert.ok(candidates.length > 0, 'Nesting offered no relationship.');
  for (const candidate of candidates) {
    assert.equal(candidate.direction, 'normal');
    assert.ok(defaults.newRelationsTypes & bit[candidate.relationshipType], `${candidate.relationshipType} is not offered by default.`);
    // Specialization runs child to parent, as in archi-online's tests: the nested box is the special kind.
    assert.deepEqual([candidate.sourceElementId, candidate.targetElementId], candidate.relationshipType === 'SpecializationRelationship'
      ? [child.elementId, container.elementId] : [container.elementId, child.elementId]);
  }
  const chosen = candidates.find(candidate => candidate.relationshipType !== 'SpecializationRelationship');
  const store = storeOf(base);
  const undoDepth = store.getState().undoStack.length;
  applyNestingChange(plan, { [child.id]: chosen.id }, store);
  const after = store.getState().model;
  assert.equal(store.getState().undoStack.length, undoDepth + 1, 'The nesting was not one Undo step.');

  const writes = writesFor(records, base, after);
  const created = writes.filter(write => write.op === 'create');
  assert.deepEqual(created.map(write => write.values['ar.concept.category'] ?? write.values['ar.item.kind']), ['Relationship', 'Relationship connection']);
  const relationship = created[0], connection = created[1];
  assert.deepEqual([relationship.values['ar.concept.source'], relationship.values['ar.concept.target'], relationship.values['ar.concept.type']],
    [container.elementId, child.elementId, `ar.type.r.${chosen.relationshipType}`]);
  assert.deepEqual([connection.values['ar.item.source'], connection.values['ar.item.target'], connection.values['ar.item.concept']], [container.id, child.id, relationship.recordId]);
  const moved = writes.find(write => write.recordId === child.id);
  assert.equal(moved.values['ar.item.parent'], container.id);

  const back = readBack(after);
  sameRecords(back, after, 'The nesting read back is not the model archi-online left.');
  assert.ok(!geometry(back, viewId).routes.has(connection.recordId), 'The line a nesting stands for is drawn.');
  setAutomaticRelationshipSetting('useNestedConnections', false);
  try {
    assert.ok(geometry(back, viewId).routes.has(connection.recordId), 'With nested connections off, the line is still hidden.');
  } finally { setAutomaticRelationshipSetting('useNestedConnections', true); }
});

test('with reverse types configured, nesting offers them child to parent and the relationship runs that way', () => {
  const { viewId, container, child } = unrelatedPair();
  const settings = { ...defaults, newRelationsTypes: 0, newReverseRelationsTypes: arm.types.reduce((mask, entry) => mask | entry.bit, 0) };
  const plan = analyzeNestingChange(base, move(viewId, child, container.id), settings);
  const candidates = plan.children[0].candidates;
  assert.ok(candidates.length > 0, 'Nesting offered no reverse relationship.');
  assert.ok(candidates.every(candidate => candidate.direction === 'reverse'));
  const chosen = candidates.find(candidate => candidate.relationshipType !== 'SpecializationRelationship') ?? candidates[0];
  assert.deepEqual([chosen.sourceElementId, chosen.targetElementId], [child.elementId, container.elementId]);
  const store = storeOf(base);
  applyNestingChange(plan, { [child.id]: chosen.id }, store);
  const writes = writesFor(records, base, store.getState().model);
  const relationship = writes.find(write => write.values?.['ar.concept.category'] === 'Relationship');
  const connection = writes.find(write => write.values?.['ar.item.kind'] === 'Relationship connection');
  assert.deepEqual([relationship.values['ar.concept.source'], relationship.values['ar.concept.target']], [child.elementId, container.elementId]);
  assert.deepEqual([connection.values['ar.item.source'], connection.values['ar.item.target']], [child.id, container.id]);
  sameRecords(readBack(store.getState().model), store.getState().model, 'The reverse nesting read back is not the model archi-online left.');
});

test('a box made from the palette inside another is its element, the relationship, the hidden line and the box, in one Undo step and one set of writes', () => {
  const { viewId, container } = unrelatedPair();
  const type = typeOf(container.elementId);
  const input = { viewId, trigger: 'palette', entries: [{ kind: 'create-element', nodeId: 'ar-id-newbox', elementId: 'ar-id-newelement',
    elementType: type, name: 'Nested', profileIds: [], parentId: container.id, bounds: { x: 20, y: 30, width: 120, height: 55 } }] };
  const plan = analyzeNestingChange(base, input, defaults);
  const chosen = plan.children[0].candidates[0];
  assert.ok(chosen, `Nothing is offered for a ${type} inside a ${type}.`);
  const store = storeOf(base);
  applyNestingChange(plan, { 'ar-id-newbox': chosen.id }, store);
  assert.equal(store.getState().undoStack.length, 1);
  const writes = writesFor(records, base, store.getState().model);
  assert.ok(writes.every(write => write.op === 'create'), 'Something besides creates was written.');
  const order = writes.map(write => write.recordId);
  const box = writes.find(write => write.recordId === 'ar-id-newbox');
  assert.equal(box.values['ar.item.parent'], container.id);
  assert.ok(order.indexOf('ar-id-newelement') < order.indexOf('ar-id-newbox'), 'The box is written before its element.');
  const line = writes.find(write => write.values['ar.item.kind'] === 'Relationship connection');
  assert.ok(order.indexOf(line.values['ar.item.concept']) < order.indexOf(line.recordId), 'The line is written before its relationship.');
  assert.equal(writes.length, 4);
  const back = readBack(store.getState().model);
  sameRecords(back, store.getState().model, 'The palette nesting read back is not the model archi-online left.');
  assert.ok(!geometry(back, viewId).routes.has(line.recordId));
});

test('a box taken out of its parent gets the line its nesting stood for, reusing the relationship', () => {
  // A box nested in another whose element is related to it, with no line between them on the view.
  let found = null;
  for (const node of Object.values(base.nodes)) {
    const parent = base.nodes[node.parentId];
    if (node.nodeType !== 'element' || parent?.nodeType !== 'element') continue;
    const relationship = Object.values(base.relationships).find(r => r.sourceId === parent.elementId && r.targetId === node.elementId
      && arm.types.some(entry => entry.type === r.type && defaults.hiddenRelationsTypes & entry.bit));
    if (!relationship) continue;
    const drawn = Object.values(base.connections).some(c => c.relationshipId === relationship.id && c.sourceId === parent.id && c.targetId === node.id);
    if (!drawn) { found = { node, parent, relationship }; break; }
  }
  assert.ok(found, 'Archisurance has no box nested for a relationship without its line.');
  const { node, parent, relationship } = found;
  const plan = analyzeNestingChange(base, move(node.viewId, node, node.viewId, { x: 2000, y: 2000, width: node.bounds.width, height: node.bounds.height }), defaults);
  assert.ok(plan.missingOccurrences.some(o => o.relationshipId === relationship.id && o.sourceNodeId === parent.id && o.targetNodeId === node.id),
    `No line is planned for ${relationship.id}: ${JSON.stringify(plan.missingOccurrences)}.`);
  const store = storeOf(base);
  applyNestingChange(plan, {}, store);
  const writes = writesFor(records, base, store.getState().model);
  const created = writes.filter(write => write.op === 'create');
  assert.deepEqual(created.map(write => [write.values['ar.item.kind'], write.values['ar.item.concept'], write.values['ar.item.source'], write.values['ar.item.target']]),
    [['Relationship connection', relationship.id, parent.id, node.id]]);
  const back = readBack(store.getState().model);
  sameRecords(back, store.getState().model, 'The unnesting read back is not the model archi-online left.');
  assert.ok(geometry(back, node.viewId).routes.has(created[0].recordId), 'The line of the unnested box is not drawn.');
});

const overlapping = boxes => boxes.some((a, i) => boxes.slice(i + 1).some(b =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));

test('Generate View For makes a view of the element and its related elements, laid out by ELK without overlaps, as one set of creates read back whole', async () => {
  // The element related to the most others, so the view is more than one box.
  const degree = new Map();
  for (const r of Object.values(base.relationships)) for (const end of [r.sourceId, r.targetId]) if (base.elements[end]) degree.set(end, (degree.get(end) ?? 0) + 1);
  const [focus] = [...degree].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const { result, model } = await generatedViewModel(base, { focusIds: [focus], name: 'Generated', depth: 1, direction: 'both', allInternalRelationships: false });
  const neighbours = new Set([focus]);
  for (const r of Object.values(base.relationships)) {
    if (r.sourceId === focus && base.elements[r.targetId]) neighbours.add(r.targetId);
    if (r.targetId === focus && base.elements[r.sourceId]) neighbours.add(r.sourceId);
  }
  assert.deepEqual([...result.elementIds].sort(), [...neighbours].sort(), 'The view does not hold the element and those related to it.');
  const view = model.views[result.viewId];
  assert.equal(view.name, 'Generated');
  const boxes = view.childIds.map(id => model.nodes[id]);
  assert.deepEqual(boxes.map(node => node.elementId).sort(), [...neighbours].sort());
  assert.ok(!overlapping(boxes.map(node => node.bounds)), 'Two generated boxes overlap.');
  assert.ok(result.connectionIds.length > 0);

  const writes = writesFor(records, base, model);
  assert.ok(writes.every(write => write.op === 'create'), 'Generating a view changed something that was there.');
  assert.equal(writes.length, 1 + result.nodeIds.length + result.connectionIds.length);
  assert.ok(writes.length <= 200, 'The generated view needs more than one batch.');
  assert.equal(writes[0].entityId, 'ar.view');
  const back = readBack(model);
  sameRecords(back, model, 'The generated view read back is not the model archi-online left.');
  assert.equal(geometry(back, result.viewId).bounds.size, result.nodeIds.length);
});

test("auto-layout places a view's top boxes by ELK without overlaps, as updates only, and the whole of it read back", async () => {
  // The Archisurance view with the most boxes at the top.
  const viewId = Object.keys(base.views).sort((a, b) => topBoxes(base, b).length - topBoxes(base, a).length)[0];
  for (const direction of ['right', 'down']) {
    const { refusal, model } = await layoutModel(base, viewId, [], direction);
    assert.equal(refusal, null);
    const top = base.views[viewId].childIds.map(id => model.nodes[id].bounds);
    assert.ok(!overlapping(top), `Laid out ${direction}, two boxes overlap.`);
    const writes = writesFor(records, base, model);
    assert.ok(writes.length > 0 && writes.every(write => write.op === 'update'), `Laying out ${direction} did more than move: ${JSON.stringify(writes.map(write => write.op))}.`);
    assert.ok(writes.every(write => Object.keys(write.values).every(field => ['ar.item.x', 'ar.item.y', 'ar.item.bendpoints'].includes(field))),
      'Laying out changed something besides places and bends.');
    assert.ok(writes.every(write => base.nodes[write.recordId]?.viewId === viewId || base.connections[write.recordId]?.viewId === viewId), 'Laying out reached another view.');
    sameRecords(readBack(model), model, `The layout ${direction} read back is not the model archi-online left.`);
  }
  // Two boxes selected: only they move.
  const [first, second] = topBoxes(base, viewId);
  const { model } = await layoutModel(base, viewId, [first.id, second.id], 'right');
  const moved = writesFor(records, base, model).filter(write => base.nodes[write.recordId]).map(write => write.recordId).sort();
  assert.ok(moved.every(id => id === first.id || id === second.id), `Laying out two boxes moved others: ${moved}.`);
});
