import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK, NOTE, LINK, F, GAP, assignOrders, deriveTree, readManuscript, manuscriptsOf, planWrites, withoutAsRead, valuesOf, sortDraft, forceDraft, planFootnotes, withFootnotes, withLinkReviews, wordDiff, chunkWrites, withTargetVersions, countWords, askMessage, ASK_MODES, ASK_PASSAGE_CHARACTERS } from '../../extensions/manuscript/model.mjs';

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
  const plan = planWrites({ saved: m.saved, current, root: m.root, notes, links, merged: new Map([['p2', 'p1']]) });
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

test('a deleted or moved paragraph is a write to make, so it counts as unsaved', () => {
  const m = readManuscript(items);
  const unchanged = m.nodes.map(n => ({ ...n, changed: false }));
  assert.deepEqual(planWrites({ saved: m.saved, current: unchanged, root: m.root }), []);
  const deleted = unchanged.filter(n => n.id !== 'p1');
  assert.deepEqual(planWrites({ saved: m.saved, current: deleted, root: m.root }).map(w => `${w.op}:${w.recordId}`), ['delete:p1']);
  const moved = [unchanged[0], unchanged[2], unchanged[1]];
  assert.deepEqual(planWrites({ saved: m.saved, current: moved, root: m.root }).map(w => `${w.op}:${w.recordId}`), ['update:p2']);
});

test('a block out of place is left as stored until the person changes it', () => {
  const table = [item('t', 'Table', 'ch1', 4096, 2, ''), item('r1', 'Row', 't', 1024, 3), item('c11', 'Cell', 'r1', 1024, 4, 'Post')];
  const odd = readManuscript([...items, ...table, item('stray', 'Paragraph', 'r1', 4096, 4, 'Lost'), item('loose', 'Cell', 'ch1', 9999, 2, 'Loose')]);
  const asRead = planWrites({ saved: odd.saved, current: odd.nodes.map(n => ({ ...n, changed: false })), root: odd.root });
  assert.ok(asRead.some(w => w.recordId === 'stray'), 'the read alone would move the stray paragraph');
  // Nothing edited: nothing to write.
  assert.deepEqual(withoutAsRead(asRead, asRead), []);
  // The stray paragraph's words edited: its text is written, its place is not.
  const typed = odd.nodes.map(n => ({ ...n, changed: n.id === 'stray', text: n.id === 'stray' ? 'Found' : n.text }));
  const plan = withoutAsRead(planWrites({ saved: odd.saved, current: typed, root: odd.root }), asRead);
  assert.deepEqual(plan.map(w => [w.recordId, Object.keys(w.values)]), [['stray', [F.text]]]);
  // Made a heading, it is the person's change of kind, and its place goes with it.
  const heading = odd.nodes.map(n => ({ ...n, changed: n.id === 'loose', kind: n.id === 'loose' ? 'Section' : n.kind }));
  const moved = withoutAsRead(planWrites({ saved: odd.saved, current: heading, root: odd.root }), asRead).find(w => w.recordId === 'loose');
  assert.deepEqual(moved.values, { [F.kind]: 'Section' });
  // A row the read made for an empty table is written once something is typed into its cell.
  const made = [{ op: 'create', entityId: BLOCK, recordId: 'rx', values: { [F.kind]: 'Row', [F.parent]: 't' } },
    { op: 'create', entityId: BLOCK, recordId: 'cx', values: { [F.kind]: 'Cell', [F.parent]: 'rx', [F.text]: null }, refs: { [F.parent]: 'rx' } }];
  const typedCell = [made[0], { ...made[1], values: { ...made[1].values, [F.text]: 'Tide' } }];
  assert.deepEqual(withoutAsRead(made, made), []);
  assert.deepEqual(withoutAsRead(typedCell, made).map(w => w.recordId), ['rx', 'cx']);
});

test('a draft from before writes only its own changes: done ones dropped, changed-since ones held', () => {
  const m = readManuscript(items);
  const current = (entityId, id) => { const b = m.saved.get(id); return b ? { version: b.version, values: valuesOf(b) } : null; };
  // The draft edited p1 and created p9 at version 1; since then p2 changed elsewhere (it is not in the draft).
  const draft = [
    { op: 'update', entityId: BLOCK, recordId: 'p1', version: 1, values: { [F.text]: 'The tide table hung by the back door.' } },
    { op: 'create', entityId: BLOCK, recordId: 'p9', values: { [F.text]: 'New.', [F.kind]: 'Paragraph', [F.parent]: 'ch1', [F.order]: 1536 } },
    { op: 'update', entityId: BLOCK, recordId: 'ch1', version: 0, values: { [F.text]: 'Tides' } },
    { op: 'update', entityId: BLOCK, recordId: 'p2', version: 0, values: { [F.text]: 'She took the ledger down.' } },
    { op: 'delete', entityId: BLOCK, recordId: 'gone', version: 3 },
  ];
  const { fresh, stale } = sortDraft(draft, current);
  assert.deepEqual(fresh.map(w => w.recordId), ['p1', 'p9']);
  // ch1 changed since; p2 already reads as the draft says; 'gone' is gone.
  assert.deepEqual(stale.map(w => w.recordId), ['ch1']);
  assert.deepEqual(forceDraft(stale, current), [{ ...draft[2], version: 1 }]);
  // A create that was saved before the view stopped, then typed on, goes in as an update.
  const saved = (e, id) => id === 'p9' ? { version: 4, values: { [F.text]: 'New' } } : current(e, id);
  const again = sortDraft([draft[1]], saved);
  assert.deepEqual(again.stale.map(w => w.recordId), ['p9']);
  assert.deepEqual(forceDraft(again.stale, saved).map(w => [w.op, w.version]), [['update', 4]]);
});

test('lineage comes from the editor, never from matching text: a repeated line cannot take another\'s note', () => {
  const twins = [...items.slice(0, 4), item('p3', 'Paragraph', 'ch1', 3072, 2, 'She took the ledger down.')];
  const m = readManuscript(twins);
  const notes = [{ entityId: NOTE, recordId: 'n1', version: 1, values: { [F.noteBlock]: 'p2' } }];
  // p2 deleted outright; p3 holds the same words and was edited. Its note goes with p2.
  const current = m.nodes.filter(n => n.id !== 'p2').map(n => ({ ...n, changed: n.id === 'p3', text: n.id === 'p3' ? 'She took the ledger down. Again.' : n.text }));
  const plan = planWrites({ saved: m.saved, current, root: m.root, notes });
  assert.deepEqual(plan.filter(w => w.entityId === NOTE).map(w => w.op), ['delete']);
  // Joined into p1 by the editor, a chain of joins included, the note follows the join.
  const joined = planWrites({ saved: m.saved, current, root: m.root, notes, merged: new Map([['p2', 'gone'], ['gone', 'p1']]) });
  assert.equal(joined.find(w => w.recordId === 'n1').values[F.noteBlock], 'p1');
});

test('a block cut whole moves into the Cuttings with its notes, and pasted back it moves home', () => {
  const m = readManuscript(items);
  const notes = [{ entityId: NOTE, recordId: 'n1', version: 1, values: { [F.noteBlock]: 'p2' } }];
  const current = m.nodes.filter(n => n.id !== 'p2').map(n => ({ ...n, changed: false }));
  const plan = planWrites({ saved: m.saved, current, root: m.root, notes, cut: new Set(['p2']), cuttings: 'cuttings' });
  assert.deepEqual(plan.map(w => [w.op, w.recordId, w.values?.[F.parent] ?? null]), [['update', 'p2', 'cuttings']]);
  assert.equal(plan[0].values[F.order], 2048, 'after the cutting already there');
  // A manuscript without Cuttings gets one, before the move.
  const none = new Map([...m.saved].filter(([id]) => id !== 'cuttings' && id !== 'c1'));
  const made = planWrites({ saved: none, current, root: m.root, cut: new Set(['p2']), cuttings: null, newCuttings: 'b-cuttings-new' });
  assert.deepEqual(made.map(w => [w.op, w.recordId]), [['create', 'b-cuttings-new'], ['update', 'p2']]);
  // Pasted back after the save: the same record moves home.
  const cutSaved = new Map(m.saved); cutSaved.set('p2', { ...m.saved.get('p2'), parent: 'cuttings', order: 2048, visible: false });
  const back = planWrites({ saved: cutSaved, current: m.nodes.map(n => ({ ...n, changed: false })), root: m.root });
  assert.deepEqual(back.map(w => [w.op, w.recordId, w.values[F.parent]]), [['update', 'p2', 'ch1']]);
});

test('a footnote is a block under the paragraph that cites it, and not a block of the sheet', () => {
  const m = readManuscript([...items, item('f1', 'Footnote', 'p1', 1024, 3, 'A note at the foot.')]);
  assert.deepEqual(m.nodes.map(n => n.id), ['ch1', 'p1', 'p2']);
  assert.deepEqual([...m.footnotes.keys()], ['f1']);
  assert.equal(m.saved.get('f1').visible, false, 'a footnote is never deleted as a block gone from the sheet');
});

test('footnotes: created where first cited, moved with their citation, edited, and deleted when no longer cited', () => {
  const m = readManuscript([...items, item('f1', 'Footnote', 'p1', 1024, 3, 'Old words.'), item('f2', 'Footnote', 'p1', 2048, 3, 'Gone.')]);
  const notes = [{ entityId: NOTE, recordId: 'n9', version: 1, values: { [F.noteBlock]: 'f2' } }];
  const writes = planFootnotes({ saved: m.saved, footnotes: m.footnotes, notes,
    refs: [{ id: 'f1', block: 'p2' }, { id: 'f3', block: 'p1' }, { id: 'f1', block: 'p2' }], texts: new Map([['f1', 'New words.'], ['f3', 'Fresh.']]) });
  assert.deepEqual(writes.map(w => [w.op, w.recordId]), [['update', 'f1'], ['create', 'f3'], ['delete', 'n9'], ['delete', 'f2']]);
  assert.deepEqual(writes[0].values, { [F.text]: 'New words.', [F.parent]: 'p2', [F.order]: GAP });
  assert.deepEqual(writes[1].values, { [F.kind]: 'Footnote', [F.text]: 'Fresh.', [F.parent]: 'p1', [F.order]: GAP });
  // Cited where it is, with its words saved: nothing to write.
  assert.deepEqual(planFootnotes({ saved: m.saved, footnotes: new Map([['f1', m.footnotes.get('f1')]]), refs: [{ id: 'f1', block: 'p1' }] }), []);
  // They go before the plan's block deletes: a footnote leaves its paragraph before the paragraph goes.
  const plan = [{ op: 'update', entityId: BLOCK, recordId: 'p2' }, { op: 'delete', entityId: BLOCK, recordId: 'p1' }];
  assert.deepEqual(withFootnotes(plan, writes).map(w => w.recordId), ['p2', 'f1', 'f3', 'n9', 'f2', 'p1']);
});

test('a link whose end\'s words change is marked for review, keeping the words it had', () => {
  const m = readManuscript(items);
  const links = [
    { entityId: LINK, recordId: 'l1', version: 3, values: { [F.linkFrom]: 'p1', [F.linkTo]: 'p2', [F.linkReview]: 'Current' } },
    { entityId: LINK, recordId: 'l2', version: 1, values: { [F.linkFrom]: 'ch1', [F.linkTo]: 'p2', [F.linkReview]: 'Current', [F.linkFromSeen]: 'Kept.', [F.linkToSeen]: 'Kept too.' } },
    { entityId: LINK, recordId: 'l3', version: 1, values: { [F.linkFrom]: 'p1', [F.linkTo]: 'ch1', [F.linkReview]: 'Needs review' } },
  ];
  const plan = [{ op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: { [F.text]: 'She took it down.' } }, { op: 'delete', entityId: BLOCK, recordId: 'x', version: 1 }];
  const out = withLinkReviews(plan, { saved: m.saved, links, seen: true });
  assert.deepEqual(out.map(w => w.recordId), ['p2', 'l1', 'l2', 'x'], 'review writes before the block deletes; one already flagged is left');
  assert.deepEqual(out[1].values, { [F.linkReview]: 'Needs review', [F.linkFromSeen]: 'The tide table hung by the door.', [F.linkToSeen]: 'She took the ledger down.' });
  assert.deepEqual(out[2].values, { [F.linkReview]: 'Needs review' }, 'words already kept are not replaced');
  // A move, a kind or an order is not a change of words; a file without the fields keeps none.
  assert.deepEqual(withLinkReviews([{ op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: { [F.order]: 9 } }], { saved: m.saved, links }), [{ op: 'update', entityId: BLOCK, recordId: 'p2', version: 1, values: { [F.order]: 9 } }]);
  assert.deepEqual(withLinkReviews(plan, { saved: m.saved, links }).find(w => w.recordId === 'l1').values, { [F.linkReview]: 'Needs review' });
});

test('words compared word by word', () => {
  assert.deepEqual(wordDiff('The lamp was left unlit.', 'The lamp was lit at dusk.'),
    [{ kind: 'same', text: 'The lamp was ' }, { kind: 'gone', text: 'left unlit.' }, { kind: 'new', text: 'lit at dusk.' }]);
  assert.deepEqual(wordDiff('Same.', 'Same.'), [{ kind: 'same', text: 'Same.' }]);
  assert.deepEqual(wordDiff('', 'New words.'), [{ kind: 'new', text: 'New words.' }]);
});

// ADR-0033: a question to the person's launched agent about a passage. The passage travels as one
// nendo:// item naming each block by its ID; notes only is the default and says not to change the
// text; the passage is cut to the view API's bound for one item and says so.
test('a question about a paragraph sends the block with its ID and keeps the text unchanged by default', () => {
  const message = askMessage({ request: '  Tighten it.  ', title: 'Low Water', blocks: [{ id: 'p1', text: 'The tide table\nhung by the door.' }] });
  assert.match(message.text, /^Tighten it\.\n/);
  assert.match(message.text, /a paragraph of the manuscript "Low Water"/);
  assert.match(message.text, /Do not change the manuscript\. Put each suggestion in a note: create a record of mn\.note with mn\.note\.block/);
  assert.deepEqual(message.context, [{ uri: 'nendo://application/entity/mn.block/records?recordId=p1', title: 'Paragraph: The tide table hung by the door.', text: 'p1: The tide table hung by the door.' }]);
  assert.deepEqual(ASK_MODES.map((mode) => mode.id), ['notes', 'rewrite', 'answer']);
  assert.match(askMessage({ request: '', blocks: [{ id: 'p1', text: 'x' }] }).text, /^Suggest how to improve this\./, 'An empty request asked nothing.');
});

test('a question about a heading is about its section, and each mode says what the agent may do', () => {
  const blocks = [{ id: 'ch1', text: 'The Tide Table' }, { id: 'p1', text: 'One.' }, { id: 'p2', text: 'Two.' }];
  const rewrite = askMessage({ request: 'Check it', mode: 'rewrite', heading: 'The Tide Table', blocks });
  assert.match(rewrite.text, /the section headed "The Tide Table"/);
  assert.match(rewrite.text, /set mn\.block\.text on each one you change, at the version you read/);
  assert.equal(rewrite.context[0].text, 'ch1: The Tide Table\np1: One.\np2: Two.');
  assert.equal(rewrite.context[0].title, 'Section: The Tide Table');
  assert.match(askMessage({ request: 'Why?', mode: 'answer', blocks }).text, /Do not change the file\. Answer only\./);
});

test('a long section is cut to the bound of one item and says where the rest is', () => {
  const blocks = [{ id: 'ch1', text: 'Long' }, ...Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, text: 'word '.repeat(60) }))];
  const message = askMessage({ request: 'Review', heading: 'Long', blocks });
  assert.ok(message.context[0].text.length <= ASK_PASSAGE_CHARACTERS, `the passage is ${message.context[0].text.length} characters`);
  assert.match(message.text, /The passage was cut short; read the rest/);
  assert.ok(askMessage({ request: 'x', blocks: [{ id: 'p', text: 'y'.repeat(20000) }] }).context[0].text.length <= ASK_PASSAGE_CHARACTERS, 'One long paragraph went past the bound.');
  assert.ok(askMessage({ request: 'x', blocks: [{ id: 'p', text: 'z'.repeat(400) }] }).context[0].title.length <= 120);
});
