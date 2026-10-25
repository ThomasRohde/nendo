import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSlide, approxMeasure, fit, wrap, textHeight } from '../../extensions/deck/layout.mjs';
import { LAYOUTS, CHARTS } from '../../extensions/deck/model.mjs';
import { TEMPLATES, resolveTheme } from '../../extensions/deck/themes.mjs';
import { slideHtml } from '../../extensions/deck/render.mjs';
import { EXAMPLE_SLIDES } from './example.mjs';

const slideOf = s => ({ layout: s.layout, title: s.title ?? '', kicker: s.kicker ?? '', body: s.body ?? '', body2: s.body2 ?? '', image: null, imageAlt: s.imageAlt ?? '', chart: s.chart ?? 'Column' });
const brand = { name: 'Kit', colors: { primary: '#0B6E4F' }, logo: 'media:logo', logoDark: null };

test('the example deck covers twenty of the twenty-one layouts, each once', () => {
  const used = new Set(EXAMPLE_SLIDES.map(s => s.layout));
  assert.equal(used.size, 20);
  assert.equal(EXAMPLE_SLIDES.length, 20);
  assert.deepEqual(LAYOUTS.map(l => l.id).filter(id => !used.has(id)), ['Image left']);
});

test('every example slide fits, in every template, in both shapes, with and without a logo', () => {
  for (const template of TEMPLATES) for (const aspect of ['16:9', '4:3']) for (const kit of [null, brand]) {
    const theme = resolveTheme(template, kit, { aspect, footer: 'A footer', slideNumbers: true });
    EXAMPLE_SLIDES.forEach((s, i) => {
      const laid = layoutSlide(slideOf(s), theme, { measure: approxMeasure, number: i + 1, total: EXAMPLE_SLIDES.length });
      const where = `${template.id} ${aspect}${kit ? ' with a logo' : ''}, slide ${i + 1} (${s.layout})`;
      const over = laid.items.filter(p => p.type === 'text' && p.overflow);
      assert.equal(over.length, 0, `${where}: ${over.map(p => p.role).join(', ')} runs over`);
      for (const p of laid.items.filter(p => p.type === 'text' || p.type === 'image')) {
        assert.ok(p.x >= -0.5 && p.y >= -0.5 && p.x + p.w <= laid.W + 0.5 && p.y + p.h <= laid.H + 0.5, `${where}: ${p.role} leaves the slide at ${[p.x, p.y, p.w, p.h].map(Math.round)}`);
      }
    });
  }
});

test('every layout draws an empty slide, and shows hints only while editing', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  for (const layout of LAYOUTS) {
    const empty = { layout: layout.id, title: '', kicker: '', body: '', body2: '', image: null, imageAlt: '', chart: 'Column' };
    const editing = layoutSlide(empty, theme, { measure: approxMeasure, editing: true });
    const shown = layoutSlide(empty, theme, { measure: approxMeasure, editing: false });
    assert.ok(editing.items.length > 0, layout.id);
    assert.equal(shown.items.filter(p => p.ghost).length, 0, `${layout.id}: a hint shows outside editing`);
    assert.ok(slideHtml(shown).startsWith('<div class="dk-slide'), layout.id);
  }
});

test('a negative value is drawn below nought with its own sign, and a doughnut of noughts says nought', () => {
  const theme = resolveTheme({ template: TEMPLATES[0] });
  const chartOf = (chart, body) => layoutSlide({ layout: 'Chart', title: 'Margin', body, body2: '', chart, image: null }, theme, { measure: approxMeasure });
  const body = '| Year | Margin |\n|---|---:|\n| 2024 | 40 |\n| 2025 | -25 |';
  for (const chart of ['Column', 'Bar']) {
    const items = chartOf(chart, body).items;
    const labels = items.filter(p => p.role === 'chart').map(p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '');
    assert.ok(labels.some(t => /^[-\u2212]25$/.test(t)), `${chart} labels: ${labels}`);
    const bars = items.filter(p => p.type === 'rect' && p.h > 2 && p.w > 2 && p.radius !== undefined && p.role === undefined);
    const [up, down] = chart === 'Column' ? bars.slice(-2).map(b => [b.y, b.y + b.h]) : bars.slice(-2).map(b => [b.x, b.x + b.w]);
    // The positive bar ends where the negative one starts: both meet at nought.
    assert.ok(Math.abs((chart === 'Column' ? up[1] : up[0]) - (chart === 'Column' ? down[0] : down[1])) < 0.5, `${chart} bars meet at nought: ${JSON.stringify({ up, down })}`);
  }
  const ring = chartOf('Doughnut', '| Part | Share |\n|---|---:|\n| A | 0 |\n| B | 0 |').items;
  const middle = ring.filter(p => p.role === 'chart').map(p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '');
  assert.ok(middle.includes('0') && !middle.includes('1'), `the middle says the total: ${middle}`);
});

test('a logo at the top right keeps clear of the title beside a picture, from either side', () => {
  for (const template of TEMPLATES) for (const kit of [brand, { ...brand, logo: null, logoDark: 'media:dark' }]) for (const layout of ['Image left', 'Image right']) {
    const theme = resolveTheme(template, kit);
    const laid = layoutSlide({ layout, title: 'A title long enough to run the whole width of its half of the slide', kicker: '', body: 'Words', body2: '', image: null, imageAlt: '', chart: 'Column' }, theme, { measure: approxMeasure });
    const logo = laid.items.find(p => p.role === 'logo'), heading = laid.items.find(p => p.role === 'title');
    if (!logo) continue;
    const overlaps = heading.x < logo.x + logo.w && logo.x < heading.x + heading.w && heading.y < logo.y + logo.h && logo.y < heading.y + heading.h;
    assert.ok(!overlaps, `${template.id} ${layout}: title ${heading.x}..${heading.x + heading.w}, logo ${logo.x}..${logo.x + logo.w}`);
  }
});

test('a chart table with no rows draws no chart and no number that is not one', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  for (const chart of CHARTS) for (const editing of [true, false]) {
    const laid = layoutSlide({ layout: 'Chart', title: 'Nothing yet', body: '| Year | Sales |\n|---|---:|', body2: '', chart, image: null }, theme, { measure: approxMeasure, editing });
    const numbers = JSON.stringify(laid.items, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? `NOT A NUMBER ${k}` : v);
    assert.ok(!numbers.includes('NOT A NUMBER'), `${chart}: ${numbers.match(/NOT A NUMBER \w+/)}`);
  }
});

test('a doughnut of two columns names the one it draws and advertises no other', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  const body = '| Part | Plan | Actual |\n|---|---:|---:|\n| A | 3 | 4 |\n| B | 5 | 6 |';
  const textOf = items => items.filter(p => p.role === 'chart').map(p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '');
  const shown = layoutSlide({ layout: 'Chart', title: 'Split', body, body2: '', chart: 'Doughnut', image: null }, theme, { measure: approxMeasure });
  assert.ok(textOf(shown.items).includes('Plan') && !textOf(shown.items).includes('Actual'), `the doughnut says Plan and not Actual: ${textOf(shown.items)}`);
  const editing = layoutSlide({ layout: 'Chart', title: 'Split', body, body2: '', chart: 'Doughnut', image: null }, theme, { measure: approxMeasure, editing: true });
  assert.ok(editing.items.some(p => p.role === 'hint' && /Actual is not drawn/.test(p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '')), 'the editor says Actual is not drawn');
});

test('a chart slide draws each kind from its table', () => {
  const theme = resolveTheme(TEMPLATES[3]);
  const body = '| Year | Revenue | Cost |\n| --- | --- | --- |\n| 2024 | 12 | 8 |\n| 2025 | 18 | 9 |\n| 2026 | 25 | 11 |';
  for (const chart of CHARTS) {
    const laid = layoutSlide({ layout: 'Chart', title: 'Growth', body, body2: 'Revenue doubles.', chart, image: null }, theme, { measure: approxMeasure });
    const marks = laid.items.filter(p => p.role === 'chart' || p.type === 'path' || p.type === 'arc');
    assert.ok(marks.length >= (chart === 'Line' ? 2 : 3), `${chart} draws ${marks.length} marks`);
  }
});

test('a word wider than its box breaks across lines, as the renderer breaks it', () => {
  const title = { type: 'text', x: 0, y: 0, w: 1120, h: 110, size: 42, weight: 700, font: 'Segoe UI', lineHeight: 1.1, paragraphs: [{ runs: [{ text: 'https://example.com/' + 'a'.repeat(280) }], level: 0 }] };
  assert.ok(wrap(title, approxMeasure)[0].lines > 1, `an unbroken 300-character title wraps to ${wrap(title, approxMeasure)[0].lines} line`);
  fit(title, approxMeasure, 14);
  assert.ok(title.size < 42 || title.overflow === true, `it shrinks or says it overflows: size ${title.size}, overflow ${title.overflow}`);
});

test('a table cell shrinks to its row, or says it overflows', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  const long = 'A long description that runs on and on, well past what one row of a table can hold at its size, '.repeat(3);
  const laid = layoutSlide({ layout: 'Table', title: 'Terms', body: `| Term | Meaning |\n|---|---|\n| One | ${long} |\n| Two | Short |`, body2: '', image: null, chart: 'Column' }, theme, { measure: approxMeasure });
  const cells = laid.items.filter(p => p.role === 'body' && p.type === 'text');
  const bad = cells.filter(p => textHeight(p, approxMeasure) > p.h + 0.5 && !p.overflow);
  assert.equal(bad.length, 0, `cells taller than their row with no overflow: ${bad.map(p => `${Math.round(textHeight(p, approxMeasure))}/${p.h} at ${p.size}px`)}`);
});

test('a chart of small fractions labels them apart, not as nought', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  for (const chart of ['Column', 'Bar']) {
    const laid = layoutSlide({ layout: 'Chart', title: 'Small', body: '| Item | Share |\n|---|---:|\n| A | .01 |\n| B | .02 |', body2: '', chart, image: null }, theme, { measure: approxMeasure });
    const words = laid.items.filter(p => p.role === 'chart').map(p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '');
    const numbers = words.filter(t => /^[-\u2212]?\d[\d,.]*$/.test(t));
    assert.ok(numbers.includes('0.01') && numbers.includes('0.02'), `${chart}: the values are labelled: ${numbers}`);
    assert.equal(new Set(numbers.filter(t => t !== '0.01' && t !== '0.02')).size, numbers.filter(t => t !== '0.01' && t !== '0.02').length, `${chart}: axis ticks repeat: ${numbers}`);
  }
});

test('bars of several columns say their numbers on the axis', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  const laid = layoutSlide({ layout: 'Chart', title: 'Before and after', body: '| Team | Before | After |\n|---|---:|---:|\n| North | 100 | 300 |\n| South | 150 | 250 |', body2: '', chart: 'Bar', image: null }, theme, { measure: approxMeasure });
  const words = laid.items.filter(p => p.role === 'chart').map(p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '');
  const numbers = words.filter(t => /^[-\u2212]?\d[\d,.]*$/.test(t));
  assert.ok(numbers.length >= 2, `the chart says numbers: ${words}`);
});

test('a long comparison heading shrinks to its band, or says it overflows', () => {
  for (const template of TEMPLATES) {
    const theme = resolveTheme(template);
    const heading = '### A heading for this side that runs on well past the width of its column';
    const laid = layoutSlide({ layout: 'Comparison', title: 'Two sides', body: `${heading}\n- One`, body2: `${heading}\n- Two`, image: null, chart: 'Column' }, theme, { measure: approxMeasure });
    const heads = laid.items.filter(p => p.type === 'text' && (p.role === 'body' || p.role === 'body2') && p.weight >= 600);
    const bad = heads.filter(p => textHeight(p, approxMeasure) > p.h + 0.5 && !p.overflow);
    assert.equal(bad.length, 0, `${template.id}: headings taller than their box with no overflow: ${bad.map(p => `${Math.round(textHeight(p, approxMeasure))}/${p.h} at ${p.size}px`)}`);
  }
});

test('a column the person sized keeps its size; the other column keeps its own', () => {
  const theme = resolveTheme(TEMPLATES[0]);
  const sizes = format => {
    const laid = layoutSlide({ layout: 'Two columns', title: 'T', body: '- Short', body2: '- Short too', image: null, chart: 'Column', format }, theme, { measure: approxMeasure });
    const at = role => laid.items.find(p => p.type === 'text' && p.role === role).size;
    return [at('body'), at('body2')];
  };
  const [plain] = sizes('');
  assert.deepEqual(sizes('{"body":{"size":1.5}}'), [plain * 1.5, plain], 'larger');
  assert.deepEqual(sizes('{"body":{"size":0.5}}'), [plain * 0.5, plain], 'smaller, and the other column stays');
  const comparison = layoutSlide({ layout: 'Comparison', title: 'T', body: '- One', body2: '- Two', image: null, chart: 'Column', format: '{"body2":{"size":0.5}}' }, theme, { measure: approxMeasure });
  const [left, right] = ['body', 'body2'].map(role => comparison.items.filter(p => p.type === 'text' && p.role === role).at(-1).size);
  assert.equal(right * 2, left);
});

test('fit shrinks text to its box, and says when it cannot', () => {
  const long = { type: 'text', x: 0, y: 0, w: 300, h: 60, size: 40, weight: 400, font: 'Segoe UI', lineHeight: 1.2, paragraphs: [{ runs: [{ text: 'word '.repeat(40) }], level: 0 }] };
  fit(long, approxMeasure, 14);
  assert.ok(long.size === 14 && long.overflow === true, `smallest size ${long.size}, overflow ${long.overflow}`);
  const short = { ...long, size: 40, overflow: false, paragraphs: [{ runs: [{ text: 'Short' }], level: 0 }] };
  fit(short, approxMeasure, 14);
  assert.ok(short.size === 40 && !short.overflow);
  assert.equal(wrap(short, approxMeasure).length, 1);
});
