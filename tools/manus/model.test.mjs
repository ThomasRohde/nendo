import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK, NOTE, LINK, F, GAP, assignOrders, deriveTree, readManuscript, manuscriptsOf, planWrites, chunkWrites, withTargetVersions, countWords } from '../../extensions/manuscript/model.mjs';

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

test('a role is written when it changes, with nothing else, and a new block keeps its role', () => {
  const m = readManuscript(items);
  const current = m.nodes.map(n => ({ ...n, changed: n.id === 'p1', role: n.id === 'p1' ? 'Quotation' : n.role ?? null }));
  assert.deepEqual(planWrites({ saved: m.saved, current, root: m.root }),
    [{ op: 'update', entityId: BLOCK, recordId: 'p1', version: 1, values: { [F.role]: 'Quotation' }, refs: {} }]);
  const added = [...m.nodes.map(n => ({ ...n, changed: false, role: null })), { id: 'v1', kind: 'Paragraph', text: 'A line', role: 'Verse', changed: true }];
  assert.equal(planWrites({ saved: m.saved, current: added, root: m.root })[0].values[F.role], 'Verse');
});

const flat = (id, kind, parent, order, text = '') => ({ entityId: BLOCK, recordId: id, version: 1, values: { [F.kind]: kind, [F.parent]: parent, [F.order]: order, [F.text]: text } });

test('several manuscripts in one file: each reads apart, with its own Cuttings, and the first opens by default', () => {
  const records = [
    flat('m2', 'Manuscript', null, 2048, 'Field Notes'), flat('m1', 'Manuscript', null, 1024, 'Low Water'),
    flat('c1', 'Chapter', 'm1', 1024, 'One'), flat('p1', 'Paragraph', 'c1', 1024, 'Agnes.'), flat('x1', 'Cuttings', 'm1', 1073741824, 'Cuttings'),
    flat('c2', 'Chapter', 'm2', 1024, 'Spring'), flat('p2', 'Paragraph', 'c2', 1024, 'Swallows.'), flat('x2', 'Cuttings', 'm2', 1073741824, 'Cuttings'),
  ];
  assert.deepEqual(manuscriptsOf(records).map(m => m.title), ['Low Water', 'Field Notes']);
  const first = readManuscript(records);
  assert.equal(first.root, 'm1'); assert.equal(first.cuttings, 'x1'); assert.deepEqual(first.nodes.map(n => n.id), ['c1', 'p1']);
  const second = readManuscript(records, 'm2');
  assert.equal(second.title, 'Field Notes'); assert.equal(second.cuttings, 'x2'); assert.deepEqual(second.nodes.map(n => n.id), ['c2', 'p2']);
  assert.equal(second.saved.get('p1').visible, false, 'a block of another manuscript is not on this sheet');
  assert.equal(readManuscript(records, 'gone').root, 'm1');
});

test('a manuscript of 20,000 blocks reads from a flat read, past the 10,000 a hierarchy walk allows', () => {
  const records = [flat('m', 'Manuscript', null, 1024, 'Long'), flat('c', 'Chapter', 'm', 1024, 'All of it')];
  for (let i = 0; i < 20000; i++) records.push(flat(`p${i}`, 'Paragraph', 'c', (i + 1) * GAP, `Paragraph ${i}.`));
  records.reverse();
  const started = performance.now();
  const m = readManuscript(records);
  const ms = performance.now() - started;
  assert.equal(m.nodes.length, 20001);
  assert.equal(m.nodes[1].id, 'p0'); assert.equal(m.nodes.at(-1).id, 'p19999');
  assert.ok(ms < 1000, `reading 20,000 blocks took ${Math.round(ms)} ms`);
});

test('the view reads blocks flat, never through the bounded hierarchy walk', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../extensions/manuscript/view.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /records\.tree(All)?\(/, 'view.mjs reads blocks through records.tree, which refuses past 10,000 under a root');
  assert.match(source, /records\.queryAll\(\{ entityId: BLOCK \}/);
});
