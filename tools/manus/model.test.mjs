import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK, NOTE, LINK, F, GAP, assignOrders, deriveTree, readManuscript, planWrites, chunkWrites, withTargetVersions, countWords } from '../../extensions/manuscript/model.mjs';

const item = (id, kind, parent, order, depth, text = '', version = 1) =>
  ({ record: { entityId: BLOCK, recordId: id, version, values: { [F.kind]: kind, [F.parent]: parent, [F.order]: order, [F.text]: text } }, parentRecordId: parent, depth });
// root > ch1 > p1, p2 ; root > cuttings > c1
const items = [
  item('root', 'Manuscript', null, 1024, 0, 'Low Water'),
  item('ch1', 'Chapter', 'root', 1024, 1, 'The Tide Table'),
  item('p1', 'Paragraph', 'ch1', 1024, 2, 'The tide table hung by the door.'),
  item('p2', 'Paragraph', 'ch1', 2048, 2, 'She took the ledger down.'),
  item('cuttings', 'Cuttings', 'root', 1073741824, 1, 'Cuttings'),
  item('c1', 'Paragraph', 'cuttings', 1024, 2, 'A cut line.'),
];

test('the sheet is everything under the root but the Cuttings', () => {
  const m = readManuscript(items);
  assert.equal(m.root, 'root'); assert.equal(m.cuttings, 'cuttings'); assert.equal(m.title, 'Low Water');
  assert.deepEqual(m.nodes.map(n => n.id), ['ch1', 'p1', 'p2']);
  assert.equal(m.saved.get('c1').visible, false);
  assert.equal(m.saved.get('p1').visible, true);
});

test('a heading holds what follows it until a heading at its level or above', () => {
  const nodes = [{ id: 'a', kind: 'Paragraph' }, { id: 'P', kind: 'Part' }, { id: 'b', kind: 'Paragraph' }, { id: 'C', kind: 'Chapter' },
    { id: 'c', kind: 'Paragraph' }, { id: 'S', kind: 'Section' }, { id: 'd', kind: 'Paragraph' }, { id: 'C2', kind: 'Chapter' }, { id: 'e', kind: 'Paragraph' },
    { id: 'P2', kind: 'Part' }, { id: 'f', kind: 'Paragraph' }];
  const { parent } = deriveTree(nodes, 'root');
  assert.deepEqual(Object.fromEntries(parent), { a: 'root', P: 'root', b: 'P', C: 'P', c: 'C', S: 'C', d: 'S', C2: 'P', e: 'C2', P2: 'root', f: 'P2' });
});

test('order numbers: kept where already in order, fitted between, renumbered only without room', () => {
  assert.deepEqual(assignOrders([null, null]), [GAP, 2 * GAP]);
  assert.deepEqual(assignOrders([1024, null, 2048]), [1024, 1536, 2048]);
  assert.deepEqual(assignOrders([1024, 2048, null]), [1024, 2048, 3072]);
  assert.deepEqual(assignOrders([null, 1024]), [0, 1024]);
  // A move: 3072 now stands first. Two of three keep their numbers, the moved one gets a new one.
  const moved = assignOrders([3072, 1024, 2048]);
  assert.deepEqual(moved.slice(1), [1024, 2048]); assert.ok(moved[0] < 1024);
  assert.deepEqual(assignOrders([1, null, 2]), [GAP, 2 * GAP, 3 * GAP]);
});

test('typing in a paragraph writes its text and nothing else', () => {
  const m = readManuscript(items);
  const current = m.nodes.map(n => ({ ...n, changed: n.id === 'p2', text: n.id === 'p2' ? 'She took the ledger down anyway.' : n.text }));
  assert.deepEqual(planWrites({ saved: m.saved, current, root: m.root }),
    [{ op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: { [F.text]: 'She took the ledger down anyway.' }, refs: {} }]);
});

test('a split keeps the leading paragraph and creates the rest between its neighbours', () => {
  const m = readManuscript(items);
  const current = [m.nodes[0], { id: 'p1', kind: 'Paragraph', text: 'The tide table', changed: true },
    { id: 'p9', kind: 'Paragraph', text: 'hung by the door.', changed: true }, m.nodes[2]];
  const plan = planWrites({ saved: m.saved, current, root: m.root });
  assert.deepEqual(plan.map(w => [w.op, w.recordId]), [['create', 'p9'], ['update', 'p1']]);
  assert.equal(plan[0].values[F.parent], 'ch1'); assert.equal(plan[0].values[F.order], 1536);
});

test('a merge hands the removed paragraph\'s notes and links to the paragraph holding its text', () => {
  const m = readManuscript(items);
  const notes = [{ entityId: NOTE, recordId: 'n1', version: 2, values: { [F.noteBlock]: 'p2' } }];
  const links = [{ entityId: LINK, recordId: 'l1', version: 1, values: { [F.linkFrom]: 'p2', [F.linkTo]: 'p1' } },
    { entityId: LINK, recordId: 'l2', version: 1, values: { [F.linkFrom]: 'ch1', [F.linkTo]: 'p2' } }];
  const current = [m.nodes[0], { id: 'p1', kind: 'Paragraph', text: 'The tide table hung by the door. She took the ledger down.', changed: true }];
  const plan = planWrites({ saved: m.saved, current, root: m.root, notes, links });
  assert.deepEqual(plan.map(w => [w.op, w.recordId]), [['update', 'p1'], ['update', 'n1'], ['delete', 'l1'], ['update', 'l2'], ['delete', 'p2']]);
  assert.equal(plan[1].values[F.noteBlock], 'p1');
  assert.equal(plan[3].values[F.linkTo], 'p1'); assert.equal(plan[3].values[F.linkReview], 'Needs review');
});

test('a deleted paragraph takes its notes with it; a new heading takes the paragraphs after it', () => {
  const m = readManuscript(items);
  const notes = [{ entityId: NOTE, recordId: 'n1', version: 1, values: { [F.noteBlock]: 'p1' } }];
  const current = [m.nodes[0], { id: 's1', kind: 'Section', text: 'Ebb', changed: true }, m.nodes[2]];
  const plan = planWrites({ saved: m.saved, current, root: m.root, notes });
  assert.deepEqual(plan.map(w => [w.op, w.recordId]), [['create', 's1'], ['update', 'p2'], ['delete', 'n1'], ['delete', 'p1']]);
  assert.equal(plan[1].values[F.parent], 's1');
});

test('batches pass reference versions except for records written earlier in the same batch', () => {
  const plan = [
    { op: 'create', entityId: BLOCK, recordId: 's1', values: {}, refs: { [F.parent]: 'ch1' } },
    { op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: {}, refs: { [F.parent]: 's1' } },
  ];
  const versions = { ch1: 4, s1: 1 };
  assert.deepEqual(withTargetVersions(plan, id => versions[id]).map(w => w.targetVersions), [{ [F.parent]: 4 }, undefined]);
  const [first, second] = chunkWrites(plan, { maxWrites: 1 });
  assert.deepEqual(withTargetVersions(second, id => versions[id])[0].targetVersions, { [F.parent]: 1 });
  assert.equal(first.length, 1);
});

test('words are counted as a writer counts them', () => {
  assert.equal(countWords('She didn’t take the well-worn ledger.'), 6);
  assert.equal(countWords(''), 0);
});
