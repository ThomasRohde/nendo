import assert from 'node:assert/strict';
import test from 'node:test';
import { definitionOperations, screenOperations, seed, seedOperations, fixture, entities, VIEW_NODE, PACKAGE_ID } from './definition.mjs';
import { BLOCK, F, readManuscript } from '../../extensions/manuscript/model.mjs';

test('the schema declares the block hierarchy on its parent and order fields', () => {
  const ops = definitionOperations();
  const hierarchy = ops.find(o => o.operationType === 'schema.declareHierarchy');
  assert.deepEqual(hierarchy.payload, { entityId: BLOCK, parentFieldId: F.parent, orderFieldId: F.order });
  assert.equal(ops.filter(o => o.operationType === 'schema.createEntity').length, entities.length);
  assert.ok(ops.every(o => o.operationType !== 'schema.addField' || ['Text', 'Integer', 'Reference', 'Boolean'].includes(o.payload.storageKind)));
});

test('the view opens the file and the outline reaches the same blocks', () => {
  const ops = screenOperations();
  const view = ops.find(o => o.payload.nodeId === VIEW_NODE);
  assert.equal(view.payload.properties.packageId, PACKAGE_ID);
  assert.equal(view.payload.properties.opensFile, true);
  assert.ok(ops.some(o => o.payload.kind === 'outlineSurface' && o.payload.properties.entityId === BLOCK));
});

test('every seeded parent exists and is created before its children', () => {
  const seen = new Set();
  for (const r of seed) {
    const parent = r.values[F.parent];
    if (parent) assert.ok(seen.has(parent), `${r.recordId} names ${parent} before it exists`);
    seen.add(r.recordId);
  }
  assert.equal(seedOperations().length, seed.length);
});

test('the fixture reads as a manuscript with its Cuttings left out of the sheet', () => {
  const f = fixture();
  const items = [];
  const under = parent => f.records[BLOCK].filter(r => r.values[F.parent] === parent).sort((a, b) => a.values[F.order] - b.values[F.order]);
  const visit = (parent, depth) => { for (const r of under(parent)) { items.push({ record: r, parentRecordId: parent, depth }); visit(r.recordId, depth + 1); } };
  visit(null, 1);
  const m = readManuscript(items);
  assert.equal(m.root, 'b-root');
  assert.equal(m.cuttings, 'b-cuttings');
  assert.equal(m.nodes.length, 9);
});
