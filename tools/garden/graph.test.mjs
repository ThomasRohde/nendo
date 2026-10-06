import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, radius } from '../../extensions/garden/graph-data.mjs';

const note = (id, stage = 'Seed') => ({ recordId: id, values: { 'gd.note.title': id.toUpperCase(), 'gd.note.stage': stage, 'gd.note.kind': 'Note' } });
const link = (from, to, source = 'Body', kind = 'Mentions') => ({ recordId: `${from}-${to}-${source}`, values: { 'gd.link.from': from, 'gd.link.to': to, 'gd.link.source': source, 'gd.link.kind': kind } });
const records = {
  notes: ['a', 'b', 'c', 'd', 'lonely'].map(id => note(id)),
  links: [link('a', 'b'), link('a', 'b', 'Manual', 'Supports'), link('b', 'a'), link('b', 'c'), link('c', 'd'), link('a', 'a'), link('a', 'gone')],
  tags: [{ recordId: 't1', values: { 'gd.tag.name': 'garden' } }, { recordId: 't2', values: { 'gd.tag.name': 'unused' } }],
  noteTags: [{ recordId: 'nt1', values: { 'gd.noteTag.note': 'a', 'gd.noteTag.tag': 't1' } }, { recordId: 'nt2', values: { 'gd.noteTag.note': 'd', 'gd.noteTag.tag': 't1' } }],
};

test('one edge per direction, no self-links, a link to a missing note counted as hidden', () => {
  const graph = buildGraph(records);
  assert.deepEqual(graph.links.map(l => l.id).sort(), ['a>b', 'b>a', 'b>c', 'c>d']);
  const ab = graph.links.find(l => l.id === 'a>b');
  assert.equal(ab.count, 2);
  assert.equal(ab.manual, true, 'a pair with a Manual link is drawn as manual');
  assert.equal(graph.hidden, 1);
  assert.deepEqual(Object.fromEntries(graph.nodes.map(n => [n.id, n.degree])), { a: 2, b: 3, c: 2, d: 1, lonely: 0 });
});

test('orphans can be left out, and tags join as nodes only when asked and only when used', () => {
  assert.equal(buildGraph(records, { showOrphans: false }).nodes.some(n => n.id === 'lonely'), false);
  assert.equal(buildGraph(records).nodes.some(n => n.type === 'tag'), false);
  const tagged = buildGraph(records, { showTags: true });
  assert.deepEqual(tagged.nodes.filter(n => n.type === 'tag').map(n => [n.id, n.title, n.degree]), [['t1', '#garden', 2]]);
  assert.deepEqual(tagged.links.filter(l => l.type === 'tag').map(l => l.id).sort(), ['a#t1', 'd#t1']);
});

test('a focus keeps what lies within depth steps, either way along a link', () => {
  assert.deepEqual(buildGraph(records, { focus: 'c', depth: 1 }).nodes.map(n => n.id).sort(), ['b', 'c', 'd']);
  assert.deepEqual(buildGraph(records, { focus: 'c', depth: 2 }).nodes.map(n => n.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(buildGraph(records, { focus: 'lonely' }).nodes.map(n => n.id), ['lonely'], 'an orphan in focus is still drawn');
  assert.deepEqual(buildGraph(records, { focus: 'c' }).links.map(l => l.id).sort(), ['b>c', 'c>d']);
  assert.deepEqual(buildGraph(records, { focus: 'd', showTags: true }).nodes.map(n => n.id).sort(), ['c', 'd', 't1'], 'a tag is a neighbour too');
});

test('a node grows with the root of its links, within bounds', () => {
  assert.equal(radius({ type: 'note', degree: 0 }), 5);
  assert.ok(radius({ type: 'note', degree: 9 }) > radius({ type: 'note', degree: 1 }));
  assert.equal(radius({ type: 'note', degree: 10000 }), 18);
  assert.equal(radius({ type: 'tag', degree: 40 }), 3.5);
});
