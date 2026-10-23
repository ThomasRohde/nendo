import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, LAYOUT_IDS, layoutOf, slideFrom, sortSlides, reorder, inline, paragraphs, plainText, rows, table, numberIn, chartData, formatNumber, niceScale, F } from '../../extensions/deck/model.mjs';

test('seventeen layouts, each named once, each saying the fields it reads', () => {
  assert.equal(LAYOUTS.length, 17);
  assert.equal(new Set(LAYOUT_IDS).size, 17);
  const fields = new Set(['title', 'kicker', 'body', 'body2', 'image', 'chart']);
  for (const layout of LAYOUTS) {
    assert.ok(layout.uses.length > 0 && layout.uses.every(u => fields.has(u)), layout.id);
    assert.ok(layout.hint.length > 10, `${layout.id} has a hint`);
  }
  assert.equal(layoutOf('Nonsense').id, 'Bullets');
});

test('a record becomes a slide, and an unknown layout or chart falls back', () => {
  const slide = slideFrom({ recordId: 's1', version: 3, values: { [F.slide.layout]: 'Odd', [F.slide.chart]: 'Pie', [F.slide.title]: 'T', [F.slide.order]: 20, [F.slide.hidden]: true } });
  assert.deepEqual([slide.layout, slide.chart, slide.title, slide.order, slide.hidden, slide.body], ['Bullets', 'Column', 'T', 20, true, '']);
});

test('slides sort by order, ties by ID; a move renumbers only what changed', () => {
  const s = [{ id: 'b', order: 10 }, { id: 'a', order: 10 }, { id: 'c', order: 5 }];
  assert.deepEqual(sortSlides(s).map(x => x.id), ['c', 'a', 'b']);
  const list = [10, 20, 30, 40].map((order, i) => ({ id: `s${i}`, order, version: 1 }));
  assert.deepEqual(reorder(list, 3, 1), [{ id: 's3', version: 1, order: 20, changed: true }, { id: 's1', version: 1, order: 30, changed: true }, { id: 's2', version: 1, order: 40, changed: true }]);
  assert.deepEqual(reorder(list, 1, 1), []);
});

test('inline marks: bold, italic, code and links', () => {
  const runs = inline('A **bold** and *italic* `code` [link](https://example.com)');
  assert.equal(plainText(runs), 'A bold and italic code link');
  assert.ok(runs.find(r => r.text === 'bold').b);
  assert.ok(runs.find(r => r.text === 'italic').i);
  assert.ok(runs.find(r => r.text === 'code').code);
  assert.equal(runs.find(r => r.text === 'link').link, 'https://example.com');
});

test('paragraphs: bullets, a second level, numbers, headings, and plain lines joined', () => {
  const p = paragraphs('### Head\n- one\n  - two\n1. first\nplain\ncontinued\n\nnext');
  assert.deepEqual(p.map(x => [x.heading ?? false, x.bullet ?? null, x.level, plainText(x.runs)]), [
    [true, null, 0, 'Head'], [false, 'bullet', 0, 'one'], [false, 'bullet', 1, 'two'], [false, 'number', 0, 'first'], [false, null, 0, 'plain continued'], [false, null, 0, 'next'],
  ]);
});

test('rows split on bars; tables keep their width and alignment', () => {
  assert.deepEqual(rows('- 42% | counted | source\n### skip\n2. b | c'), [['42%', 'counted', 'source'], ['b', 'c']]);
  const t = table('| A | B | C |\n| :-- | --: | :-: |\n| 1 | 2 |\n| x | y | z |');
  assert.deepEqual(t.head, ['A', 'B', 'C']);
  assert.deepEqual(t.align, ['left', 'right', 'center']);
  assert.deepEqual(t.rows, [['1', '2', ''], ['x', 'y', 'z']]);
  assert.equal(table('no table here'), null);
});

test('chart data reads numbers out of cells', () => {
  assert.deepEqual([numberIn('€3,400.5m'), numberIn('12%'), numberIn('n/a')], [3400.5, 12, null]);
  const d = chartData('| Quarter | Sales | Cost |\n| --- | --- | --- |\n| Q1 | 10% | 4 |\n| Q2 | 12% | x |');
  assert.deepEqual(d, { labels: ['Q1', 'Q2'], series: [{ name: 'Sales', values: [10, 12] }, { name: 'Cost', values: [4, 0] }], unit: '%' });
  assert.equal(chartData('| one |\n| --- |\n| a |'), null);
});

test('numbers on axes are tidy', () => {
  assert.deepEqual([formatNumber(1500000), formatNumber(25000), formatNumber(3.25), formatNumber(40, '%')], ['1.5M', '25k', '3.3', '40%']);
  assert.deepEqual(niceScale(87), { max: 100, step: 25 });
  assert.deepEqual(niceScale(0), { max: 1, step: 0.25 });
});
