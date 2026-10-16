import assert from 'node:assert/strict';
import test from 'node:test';
import { exportPlan } from '../../extensions/manuscript/export.mjs';
import { previewBlocks, figureWidths, PAGES } from '../../extensions/manuscript/preview.mjs';

const P = (id, text, role = null) => ({ id, kind: 'Paragraph', text, role });
const C = (id, text, role = null) => ({ id, kind: 'Chapter', text, role });

test('book preview: a title page with subtitle and author, a dedication page, chapters on new pages', () => {
  const blocks = previewBlocks(exportPlan({ title: 'Low Water', nodes: [
    P('s', 'A novel', 'Subtitle'), P('a', '[Author]', 'Author'), P('d', 'For the keepers', 'Dedication'),
    C('c1', 'One'), P('e', 'The sea keeps its own hours.', 'Epigraph'), P('p1', 'It rained.'), P('p2', 'It rained again.'),
    C('c2', 'Two'), P('p3', 'Morning.'),
  ] }), 'book');
  const by = text => blocks.find(b => b.text === text);
  assert.equal(blocks[0].kind, 'title'); assert.ok(blocks[0].titlePage);
  assert.ok(by('A novel').titlePage && !by('A novel').breakBefore);
  assert.ok(by('For the keepers').breakBefore, 'the dedication starts a page');
  assert.ok(by('One').breakBefore && by('Two').breakBefore, 'each chapter starts a page');
  assert.equal(by('It rained.').indent, false, 'text after an epigraph starts flush');
  assert.equal(by('It rained again.').indent, true);
});

test('paper preview: front matter centred, abstract and references set apart, pictures in one row with a caption', () => {
  const address = `media:${'ab'.repeat(32)}`;
  const blocks = previewBlocks(exportPlan({ title: 'A Paper', nodes: [
    P('a', '[Authors]'), C('h0', 'Abstract'), P('b', 'We describe it.'), C('h1', '1 Introduction'), P('c', 'First.'), P('d', 'Second.'),
    P('p1', `![One](${address})`), P('p2', `![Two](${address})`), P('f', '*Figure 1.* Two panels.'), C('r', 'References'), P('r1', '[1] A work.'),
  ] }), 'paper');
  const by = text => blocks.find(b => b.text === text);
  assert.ok(by('[Authors]').front);
  assert.equal(by('Abstract').centred, true);
  assert.equal(by('We describe it.').role, 'Abstract');
  assert.equal(by('First.').indent, false); assert.equal(by('Second.').indent, true);
  const figure = blocks.find(b => b.kind === 'figure');
  assert.equal(figure.pictures.length, 2);
  assert.deepEqual(figureWidths(figure, 'paper'), [300, 300]);
  const caption = blocks.find(b => b.kind === 'caption');
  assert.equal(caption.label, 'Figure 1:'); assert.equal(caption.text, 'Two panels.');
  assert.equal(by('[1] A work.').indent, false);
  assert.ok(!blocks.some(b => b.breakBefore), 'an article runs on without page breaks');
});

test('page sizes are the Word layouts’: 6 by 9 inches and Letter', () => {
  assert.deepEqual([PAGES.book.width, PAGES.book.height], [576, 864]);
  assert.deepEqual([PAGES.paper.width, PAGES.paper.height], [816, 1056]);
});

test('book preview: with parts, each part and each chapter starts a page, sections do not', () => {
  const blocks = previewBlocks(exportPlan({ title: 'T', nodes: [
    { id: 'p', kind: 'Part', text: 'Part One' }, { id: 'c1', kind: 'Chapter', text: 'One' }, P('a', 'Text.'),
    { id: 's', kind: 'Section', text: 'A section' }, P('b', 'More.'), { id: 'c2', kind: 'Chapter', text: 'Two' },
  ] }), 'book');
  const by = text => blocks.find(b => b.text === text);
  assert.ok(by('Part One').breakBefore && by('One').breakBefore && by('Two').breakBefore);
  assert.ok(!by('A section').breakBefore);
});
