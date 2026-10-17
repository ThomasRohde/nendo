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

test('alignment is written when it changes, alone; a value the field does not offer reads as none, and a block without one writes none', () => {
  const m = readManuscript(items);
  assert.ok(m.nodes.every(n => n.align === null));
  const centred = m.nodes.map(n => ({ ...n, changed: false, align: n.id === 'p2' ? 'Centre' : null }));
  assert.deepEqual(planWrites({ saved: m.saved, current: centred, root: m.root }),
    [{ op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: { [F.align]: 'Centre' }, refs: {} }]);
  // Left is kept as chosen; a value the field does not offer reads as none and writes nothing.
  const left = readManuscript([...items.slice(0, 3), { ...items[3], record: { ...items[3].record, values: { ...items[3].record.values, [F.align]: 'Left' } } }, ...items.slice(4)]);
  assert.equal(left.saved.get('p2').align, 'Left');
  assert.deepEqual(planWrites({ saved: left.saved, current: left.nodes.map(n => ({ ...n, changed: false })), root: left.root }), []);
  const odd = readManuscript([...items.slice(0, 3), { ...items[3], record: { ...items[3].record, values: { ...items[3].record.values, [F.align]: 'Diagonal' } } }, ...items.slice(4)]);
  assert.equal(odd.saved.get('p2').align, null);
  assert.deepEqual(planWrites({ saved: odd.saved, current: odd.nodes.map(n => ({ ...n, changed: false })), root: odd.root }), []);
  const back = readManuscript([...items.slice(0, 3), { ...items[3], record: { ...items[3].record, values: { ...items[3].record.values, [F.align]: 'Justify' } } }, ...items.slice(4)]);
  assert.deepEqual(planWrites({ saved: back.saved, current: back.nodes.map(n => ({ ...n, changed: false, align: null })), root: back.root })[0].values, { [F.align]: null });
  const added = [...m.nodes.map(n => ({ ...n, changed: false })), { id: 'r1', kind: 'Paragraph', text: 'Signed', role: null, align: 'Right', changed: true }];
  assert.equal(planWrites({ saved: m.saved, current: added, root: m.root })[0].values[F.align], 'Right');
  assert.ok(!(F.align in planWrites({ saved: m.saved, current: [...m.nodes.map(n => ({ ...n, changed: false })), { id: 'r2', kind: 'Paragraph', text: 'Plain', changed: true }], root: m.root })[0].values));
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

test('a list item is a paragraph with List and Level: written alone when they change, level 0 stored as none', () => {
  const m = readManuscript(items);
  const listed = m.nodes.map(n => ({ ...n, changed: false, list: n.id === 'p1' || n.id === 'p2' ? 'Numbered' : null, level: n.id === 'p2' ? 1 : 0 }));
  assert.deepEqual(planWrites({ saved: m.saved, current: listed, root: m.root }), [
    { op: 'update', entityId: BLOCK, recordId: 'p1', version: 1, values: { [F.list]: 'Numbered' }, refs: {} },
    { op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: { [F.list]: 'Numbered', [F.level]: 1 }, refs: {} },
  ]);
  // Read back as saved, nothing more is written; a level without a list is no level.
  const saved = readManuscript(items.map(i => i.record.recordId === 'p2' ? { ...i, record: { ...i.record, values: { ...i.record.values, [F.list]: 'Bulleted', [F.level]: 2 } } }
    : i.record.recordId === 'p1' ? { ...i, record: { ...i.record, values: { ...i.record.values, [F.level]: 3 } } } : i));
  assert.deepEqual([saved.saved.get('p1').level, saved.saved.get('p2').list, saved.saved.get('p2').level], [null, 'Bulleted', 2]);
  assert.deepEqual(planWrites({ saved: saved.saved, current: saved.nodes.map(n => ({ ...n, changed: false })), root: saved.root }), []);
  // Taken out of the list: both cleared.
  assert.deepEqual(planWrites({ saved: saved.saved, current: saved.nodes.map(n => ({ ...n, changed: false, list: null, level: 0 })), root: saved.root })[0].values,
    { [F.list]: null, [F.level]: null });
});

test('a table owns its rows and a row its cells, each a block in order; misplaced ones are read as paragraphs after the table', () => {
  const table = [
    item('t', 'Table', 'ch1', 4096, 2, ''),
    item('r1', 'Row', 't', 1024, 3), item('c11', 'Cell', 'r1', 1024, 4, 'Post'), item('c12', 'Cell', 'r1', 2048, 4, 'Depth'),
    item('r2', 'Row', 't', 2048, 3), item('c21', 'Cell', 'r2', 1024, 4, '*4*'), item('c22', 'Cell', 'r2', 2048, 4, '2 m'),
  ];
  const m = readManuscript([...items, ...table]);
  assert.deepEqual(m.nodes.map(n => `${n.kind}:${n.id}`), ['Chapter:ch1', 'Paragraph:p1', 'Paragraph:p2', 'Table:t', 'Row:r1', 'Cell:c11', 'Cell:c12', 'Row:r2', 'Cell:c21', 'Cell:c22']);
  assert.deepEqual(planWrites({ saved: m.saved, current: m.nodes.map(n => ({ ...n, changed: false })), root: m.root }), []);
  // A new row with two cells, after the first: rows and cells are created under their table and row.
  const added = [...m.nodes.slice(0, 7), { id: 'rn', kind: 'Row', text: '', changed: true }, { id: 'cn1', kind: 'Cell', text: 'New', changed: true }, { id: 'cn2', kind: 'Cell', text: '', changed: true }, ...m.nodes.slice(7)]
    .map(n => ({ changed: false, ...n }));
  const writes = planWrites({ saved: m.saved, current: added, root: m.root });
  assert.deepEqual(writes.map(w => [w.op, w.recordId, w.values[F.parent], w.values[F.kind], w.values[F.order]]),
    [['create', 'rn', 't', 'Row', 1536], ['create', 'cn1', 'rn', 'Cell', 1024], ['create', 'cn2', 'rn', 'Cell', 2048]]);
  assert.equal(writes[1].values[F.text], 'New');
  // The whole table removed: cells first, then rows, then the table.
  const gone = planWrites({ saved: m.saved, current: m.nodes.slice(0, 3).map(n => ({ ...n, changed: false })), root: m.root });
  assert.deepEqual(gone.map(w => `${w.op}:${w.recordId}`), ['delete:c11', 'delete:c12', 'delete:c21', 'delete:c22', 'delete:r1', 'delete:r2', 'delete:t']);
  // A paragraph Studio put inside a row, and a cell straight under a chapter, come after the table as paragraphs.
  const odd = readManuscript([...items, ...table, item('stray', 'Paragraph', 'r1', 4096, 4, 'Lost'), item('loose', 'Cell', 'ch1', 9999, 2, 'Loose')]);
  assert.deepEqual(odd.nodes.map(n => `${n.kind}:${n.id}`).slice(3), ['Table:t', 'Row:r1', 'Cell:c11', 'Cell:c12', 'Row:r2', 'Cell:c21', 'Cell:c22', 'Paragraph:stray', 'Paragraph:loose']);
  const fixed = planWrites({ saved: odd.saved, current: odd.nodes.map(n => ({ ...n, changed: false })), root: odd.root });
  assert.deepEqual(fixed.filter(w => w.recordId === 'stray' || w.recordId === 'loose').map(w => [w.recordId, w.values[F.parent] ?? null, w.values[F.kind] ?? null]),
    [['stray', 'ch1', null], ['loose', null, 'Paragraph']]);
});
