import assert from 'node:assert/strict';
import test from 'node:test';
import { exportPlan } from '../../extensions/manuscript/export.mjs';
import { previewBlocks, figureWidths, PAGES, paperStyle, softHyphens } from '../../extensions/manuscript/preview.mjs';
import { ARTICLE, article } from '../../extensions/manuscript/export.mjs';

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
  assert.equal(by('ABSTRACT').centred, true);
  assert.ok(by('[Authors]').across && by('We describe it.').across && !by('First.').across, 'the abstract runs across the page, the body in columns');
  assert.equal(by('1. INTRODUCTION').level, 1);
  assert.equal(by('We describe it.').indent, true, 'an article indents its abstract');
  assert.equal(by('We describe it.').role, 'Abstract');
  assert.equal(by('First.').indent, true, 'an article indents every paragraph, as AASTeX does'); assert.equal(by('Second.').indent, true);
  const figure = blocks.find(b => b.kind === 'figure');
  assert.equal(figure.pictures.length, 2);
  assert.deepEqual(figureWidths(figure, 'paper').map(w => Math.round(w * 10) / 10), [148.9, 148.9], 'two pictures share one column, 18 points apart');
  const caption = blocks.find(b => b.kind === 'caption');
  assert.equal(caption.label, 'Figure 1.'); assert.equal(caption.text, 'Two panels.');
  assert.equal(by('[1] A work.').indent, false);
  assert.ok(!blocks.some(b => b.breakBefore), 'an article runs on without page breaks');
});

test('page sizes are the Word layouts’: 6 by 9 inches and Letter', () => {
  assert.deepEqual([PAGES.book.width, PAGES.book.height], [576, 864]);
  assert.deepEqual([PAGES.paper.width, PAGES.paper.height], [816, 1056]);
  // Letter as AASTeX sets it: 7.1 inches of text, two columns and their gap filling it exactly.
  assert.ok(Math.abs(PAGES.paper.columns * PAGES.paper.column + PAGES.paper.gap - (PAGES.paper.width - PAGES.paper.margin - PAGES.paper.right)) < 1e-9);
  assert.ok(Math.abs(PAGES.paper.width - PAGES.paper.margin - PAGES.paper.right - 7.1 * 96) < 0.1);
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

test('paper preview: its CSS puts each baseline where the Word export and the reference put it', () => {
  // With a baseline 9.6 points below a 12.45-point line's top, a heading after text needs 21.45
  // points between baselines: 2.85 below the text's baseline, 9.6 into the heading's line.
  const css = paperStyle(article(), "'Times New Roman'", (line, size) => line / 2 + 0.3375 * size);
  const rule = selector => css.split('\n').find(line => line.includes(selector)) ?? '';
  assert.match(rule('.sheet-page {'), /width: 612pt; height: 792pt; padding: 65\.\d+pt 50\.06pt 0 50\.74pt;/);
  assert.match(rule('.pv-column { flex'), /flex: 0 0 241.361pt;/);
  assert.match(rule('.pv-columns {'), /gap: 28.477pt;/);
  const [, above, below] = /margin: ([\d.]+)pt 0 ([\d.]+)pt/.exec(rule(' :is(h2, h3, h4) { font-size')).map(Number);
  assert.ok(Math.abs(above - (ARTICLE.heading - ARTICLE.pitch)) < 0.01 && Math.abs(below - (ARTICLE.afterHeading - ARTICLE.pitch)) < 0.01, `${above} ${below}`);
});

test('soft hyphens where TeX breaks: its patterns, two letters in and three before the end, words after a space only', () => {
  const at = word => ({ regenerates: 're-gen-er-ates', malleability: 'mal-leabil-i-ty', programmers: 'pro-gram-mers' })[word] ?? word;
  const hyphenate = word => at(word).replace(/-/g, '\u00AD');
  assert.equal(softHyphens('regenerates malleability', hyphenate), 're\u00ADgen\u00ADer\u00ADates mal\u00ADleabil\u00ADity');
  assert.equal(softHyphens('host-programmers (programmers)', hyphenate), 'host-programmers (pro\u00ADgram\u00ADmers)');
});
