import test from 'node:test';
import assert from 'node:assert/strict';
import { overview, excerpt, whenTended, findNotes, PINNED, TAGS } from '../../extensions/garden/home-data.mjs';
import { handOver, takeHandover, HANDOVER_KEY } from '../../extensions/garden/handover.mjs';
import { fixture } from './definition.mjs';

const note = (recordId, values) => ({ recordId, version: 1, values: { 'gd.note.title': recordId, 'gd.note.pinned': false, ...values } });
const link = (from, to) => ({ recordId: `${from}>${to}`, values: { 'gd.link.from': from, 'gd.link.to': to, 'gd.link.source': 'Body' } });
const stages = [{ id: 'Seed', displayName: 'Seed' }, { id: 'Growing', displayName: 'Growing' }, { id: 'Evergreen', displayName: 'Evergreen' }];

test('the Overview counts notes, links as the graph draws them, stages in their order and the unlinked notes', () => {
  const notes = [note('a', { 'gd.note.stage': 'Evergreen' }), note('b', { 'gd.note.stage': 'Growing' }), note('c', { 'gd.note.stage': 'Seed' }), note('d', { 'gd.note.stage': 'Growing' })];
  // Two records say a links to b: one line on the graph. A link to itself is none.
  const view = overview({ notes, links: [link('a', 'b'), link('a', 'b'), link('b', 'a'), link('c', 'a'), link('d', 'd')] }, { stages });
  assert.deepEqual(view.counts, { notes: 4, links: 3, unlinked: 1 });
  assert.deepEqual(view.stages.map(s => [s.id, s.count]), [['Seed', 1], ['Growing', 2], ['Evergreen', 1]]);
  assert.deepEqual(view.unlinked, ['d']);
});

test('pinned notes come by title, with their links in and out', () => {
  const notes = [
    note('p2', { 'gd.note.title': 'Zebra', 'gd.note.pinned': true, 'gd.note.touched': '2026-10-07' }),
    note('p1', { 'gd.note.title': 'Apple', 'gd.note.pinned': true }),
    ...['2026-10-01', '2026-10-06', '2026-10-03', '2026-10-05', '2026-10-02'].map((day, i) => note(`n${i}`, { 'gd.note.touched': day })),
    note('never', {}),
  ];
  const view = overview({ notes, links: [link('n1', 'p2'), link('n2', 'p2')] });
  assert.deepEqual(view.pinned.map(c => c.title), ['Apple', 'Zebra']);
  assert.deepEqual([view.pinned[1].linksIn, view.pinned[1].linksOut], [2, 0]);
  assert.equal(view.pinned.length, 2, 'only what is pinned is a card');
});

test('tags by how many notes carry them, sized one to four', () => {
  const tags = ['x', 'y', 'z', 'empty'].map(id => ({ recordId: id, values: { 'gd.tag.name': id } }));
  const noteTags = [['a', 'x'], ['b', 'x'], ['c', 'x'], ['a', 'x'], ['a', 'y'], ['b', 'y'], ['c', 'z']].map(([n, t], i) => ({ recordId: `nt${i}`, values: { 'gd.noteTag.note': n, 'gd.noteTag.tag': t } }));
  const view = overview({ tags, noteTags });
  assert.deepEqual(view.tags.map(t => [t.name, t.count, t.size]), [['x', 3, 4], ['y', 2, 3], ['z', 1, 1]]);
});

test('every pinned note and every tag in use comes back, for the page to count and show all (G-014)', () => {
  const notes = Array.from({ length: PINNED + 1 }, (_, i) => note(`p${i}`, { 'gd.note.title': `Pin ${String.fromCharCode(73 - i)}`, 'gd.note.pinned': true }));
  const view = overview({ notes });
  assert.equal(view.pinned.length, PINNED + 1, 'a ninth pin is a card too');
  assert.equal(view.pinned[0].title, 'Pin A', 'by title');
  const tags = Array.from({ length: TAGS + 1 }, (_, i) => ({ recordId: `t${i}`, values: { 'gd.tag.name': `tag${String(i).padStart(2, '0')}` } }));
  const noteTags = tags.flatMap((tag, i) => Array.from({ length: TAGS + 1 - i }, (_, n) => ({ recordId: `${tag.recordId}-${n}`, values: { 'gd.noteTag.note': `n${n}`, 'gd.noteTag.tag': tag.recordId } })));
  const tagged = overview({ tags, noteTags });
  assert.equal(tagged.tags.length, TAGS + 1);
  assert.deepEqual([tagged.tags[0].size, tagged.tags[TAGS - 1].size, tagged.tags[TAGS].size], [4, 1, 1], 'sized by the tags shown first');
});

test('an excerpt is the summary, or the first line of prose with its marks taken off', () => {
  assert.equal(excerpt({ 'gd.note.summary': 'In short.', 'gd.note.body': 'Long body.' }), 'In short.');
  assert.equal(excerpt({ 'gd.note.body': '# Title\n\n```\ncode\n```\n- [ ] A **bold** link to [[how-links-work|the links]] and #reading.' }), 'A bold link to the links and reading.');
  assert.equal(excerpt({ 'gd.note.body': '' }), '');
  const long = excerpt({ 'gd.note.body': 'word '.repeat(80) }, 40);
  assert.ok(long.length <= 40 && long.endsWith('…') && !long.includes('wor…'), long);
});

test('when a note was tended reads as a person says it', () => {
  assert.equal(whenTended('2026-10-07', '2026-10-07'), 'today');
  assert.equal(whenTended('2026-10-06', '2026-10-07'), 'yesterday');
  assert.equal(whenTended('2026-10-05', '2026-10-07'), 'Monday');
  assert.equal(whenTended('2026-09-20', '2026-10-07'), 'Sep 20');
  assert.equal(whenTended('2026-09-20', '2026-10-07', 'da'), '20. sep.');
  assert.equal(whenTended(null, '2026-10-07'), '');
});

test('find lists titles that start with the words first, by the index when it answered, and offers a new note unless one has the title', () => {
  const notes = [note('a', { 'gd.note.title': 'Reading list' }), note('b', { 'gd.note.title': 'Slow reading' }), note('c', { 'gd.note.title': 'Garden', 'gd.note.body': 'about reading' })];
  assert.deepEqual(findNotes(notes, 'reading').notes.map(n => n.id), ['a', 'b', 'c']);
  assert.equal(findNotes(notes, 'reading').exact, false);
  assert.equal(findNotes(notes, 'reading list').exact, true);
  assert.deepEqual(findNotes(notes, 'reading', new Set(['c'])).notes.map(n => n.id), ['a', 'b', 'c']);
  assert.deepEqual(findNotes(notes, 'garden', new Set()).notes.map(n => n.id), ['c']);
  assert.deepEqual(findNotes(notes, '  '), { notes: [], exact: false });
});

test('the seed garden gives the Overview something on every row', () => {
  const f = fixture(), r = f.records;
  const view = overview({ notes: r['gd.note'], links: r['gd.link'], tags: r['gd.tag'], noteTags: r['gd.noteTag'] },
    { stages: f.schema.entities[0].fields.find(x => x.fieldId === 'gd.note.stage').choices });
  assert.ok(view.counts.links > 0 && view.stages.length === 3 && view.pinned.length > 0 && view.tags.length > 0, JSON.stringify(view.counts));
  assert.ok(view.pinned.every(c => c.excerpt.length > 0), 'every seed card has a line to show');
});

test('a hand-over is taken once, only while fresh, and only when it asks for something', () => {
  const kept = new Map();
  const storage = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v), removeItem: k => kept.delete(k) };
  assert.equal(handOver({ open: 'gd.note.a' }, { storage, now: 1000 }), true);
  assert.deepEqual(takeHandover({ storage, now: 2000 }), { open: 'gd.note.a', at: 1000 });
  assert.equal(takeHandover({ storage, now: 2000 }), null, 'taken once');
  handOver({ plant: 'A new idea' }, { storage, now: 1000 });
  assert.equal(takeHandover({ storage, now: 1000 + 16_000 }), null, 'a stale request opens nothing');
  assert.equal(kept.has(HANDOVER_KEY), false, 'and is cleared');
  kept.set(HANDOVER_KEY, JSON.stringify({ at: 5, run: 'anything' }));
  assert.equal(takeHandover({ storage, now: 5 }), null);
  const refusing = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() {} };
  assert.equal(handOver({ daily: true }, { storage: refusing }), false);
  assert.equal(takeHandover({ storage: refusing }), null);
});
