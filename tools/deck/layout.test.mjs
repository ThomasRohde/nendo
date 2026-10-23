import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSlide, approxMeasure, fit, wrap } from '../../extensions/deck/layout.mjs';
import { LAYOUTS, CHARTS } from '../../extensions/deck/model.mjs';
import { TEMPLATES, resolveTheme } from '../../extensions/deck/themes.mjs';
import { slideHtml } from '../../extensions/deck/render.mjs';
import { EXAMPLE_SLIDES } from './example.mjs';

const slideOf = s => ({ layout: s.layout, title: s.title ?? '', kicker: s.kicker ?? '', body: s.body ?? '', body2: s.body2 ?? '', image: null, imageAlt: s.imageAlt ?? '', chart: s.chart ?? 'Column' });
const brand = { name: 'Kit', colors: { primary: '#0B6E4F' }, logo: 'media:logo', logoDark: null };

test('the example deck covers sixteen of the seventeen layouts', () => {
  const used = new Set(EXAMPLE_SLIDES.map(s => s.layout));
  assert.equal(used.size, 16);
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

test('a chart slide draws each kind from its table', () => {
  const theme = resolveTheme(TEMPLATES[3]);
  const body = '| Year | Revenue | Cost |\n| --- | --- | --- |\n| 2024 | 12 | 8 |\n| 2025 | 18 | 9 |\n| 2026 | 25 | 11 |';
  for (const chart of CHARTS) {
    const laid = layoutSlide({ layout: 'Chart', title: 'Growth', body, body2: 'Revenue doubles.', chart, image: null }, theme, { measure: approxMeasure });
    const marks = laid.items.filter(p => p.role === 'chart' || p.type === 'path' || p.type === 'arc');
    assert.ok(marks.length >= (chart === 'Line' ? 2 : 3), `${chart} draws ${marks.length} marks`);
  }
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
