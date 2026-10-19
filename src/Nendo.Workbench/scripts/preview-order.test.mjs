import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// The preview host answers Studio's sort and filter itself, so it orders and compares as the
// native host does: RecordQuerySemantics.SortComparison and Compare.
const { previewMatches, previewOrder } = await bundleOf('src/host-preview.ts');

const sorted = (field, values, labels = {}) => [...values].sort(previewOrder(field, (id) => labels[id] ?? null));

test('a single choice sorts in its options’ order, a value no option holds after them', () => {
  const stage = { storageKind: 0, presentation: 'singleChoice', options: ['todo', 'doing', 'done'] };
  assert.deepEqual(sorted(stage, ['done', 'legacy', 'todo', 'doing']), ['todo', 'doing', 'done', 'legacy'], 'a choice sorted by its stored ID');
});

test('a reference sorts by its target’s label, a target without one after the rest', () => {
  const owner = { storageKind: 7, presentation: null, options: [], reference: { targetEntityId: 'people', labelFieldId: 'name' } };
  assert.deepEqual(sorted(owner, ['p1', 'p2', 'p3', 'p4'], { p1: 'Zoe', p2: 'Anna', p3: 'Mads' }), ['p2', 'p3', 'p1', 'p4']);
});

test('a UUID is one value in either case, in a filter and in a sort', () => {
  const uuid = 6;
  assert.equal(previewMatches('3F2A9C01-0000-4000-8000-00000000000A', 'eq', '3f2a9c01-0000-4000-8000-00000000000a', uuid), true);
  assert.equal(previewMatches('3F2A9C01-0000-4000-8000-00000000000A', 'ne', '3f2a9c01-0000-4000-8000-00000000000a', uuid), false);
  assert.equal(previewMatches('ABC', 'eq', 'abc', 0), false, 'text still compares exactly');
  assert.deepEqual(sorted({ storageKind: uuid, presentation: null, options: [] }, ['b0', 'A1', 'a0']), ['a0', 'A1', 'b0']);
});
