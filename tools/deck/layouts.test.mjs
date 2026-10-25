import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSlide, approxMeasure } from '../../extensions/deck/layout.mjs';
import { slideFrom, F } from '../../extensions/deck/model.mjs';
import { TEMPLATES, resolveTheme } from '../../extensions/deck/themes.mjs';
import { slideHtml } from '../../extensions/deck/render.mjs';
import { buildPptx } from '../../extensions/deck/pptx.mjs';
import { unzip } from '../../extensions/deck/zip.mjs';
import { checkDeck } from '../../extensions/deck/check.mjs';

// Title only, Picture grid, Process and Cycle, and the Pie, Area and Stacked charts.

const blank = { title: '', kicker: '', body: '', body2: '', image: null, image2: null, image3: null, image4: null, imageAlt: '', chart: 'Column' };
const lay = (slide, theme = resolveTheme(TEMPLATES[0]), ctx = {}) => layoutSlide({ ...blank, ...slide }, theme, { measure: approxMeasure, ...ctx });
const words = p => p.paragraphs?.map(q => q.runs.map(r => r.text).join('')).join('') ?? '';
const SALES = '| Quarter | North | South |\n| --- | --- | --- |\n| Q1 | 12 | 9 |\n| Q2 | 15 | -4 |\n| Q3 | 19 | 14 |';
const FULL = [
  { layout: 'Title only', title: 'How the parts fit together', kicker: 'Architecture', image: 'media:a' },
  { layout: 'Picture grid', title: 'What we saw', kicker: 'Field trip', body: '- The harbour at dawn\n- The market\n- The old mill\n- The quay', image: 'media:a', image2: 'media:b', image3: 'media:c', image4: 'media:d' },
  { layout: 'Process', title: 'From idea to launch', kicker: 'How we work', body: '- Discover | Talk to ten customers first\n- Shape | One page: what and why\n- Build | Small steps, shown each week\n- Test | With five real users\n- Launch | One market first\n- Learn | What to keep, change or stop' },
  { layout: 'Cycle', title: 'The learning loop', kicker: 'Each sprint', body: '- Build | The smallest test of the idea\n- Measure | What people do, not say\n- Learn | Keep, change or stop\n- Plan | The next test\n- Share | What we found\n- Rest | A day off' },
  { layout: 'Chart', chart: 'Pie', title: 'Where sales come from', body: SALES, body2: 'North brings half.' },
  { layout: 'Chart', chart: 'Area', title: 'Growth by region', body: SALES },
  { layout: 'Chart', chart: 'Stacked', title: 'Sales by quarter', body: SALES, body2: 'South dipped in Q2.' },
];

test('the new layouts and charts fit at their fullest, in every template, in both shapes, with and without a logo', () => {
  const brand = { name: 'Kit', colors: { primary: '#0B6E4F' }, logo: 'media:logo', logoDark: null };
  for (const template of TEMPLATES) for (const aspect of ['16:9', '4:3']) for (const kit of [null, brand]) {
    const theme = resolveTheme(template, kit, { aspect, footer: 'A footer', slideNumbers: true });
    for (const s of FULL) {
      const l = lay(s, theme, { number: 4 });
      const where = `${template.id} ${aspect}${kit ? ' with a logo' : ''}, ${s.layout} ${s.chart ?? ''}`;
      const over = l.items.filter(p => p.type === 'text' && p.overflow);
      assert.equal(over.length, 0, `${where}: ${over.map(p => `${p.role} "${words(p)}"`).join(', ')} runs over`);
      for (const p of l.items.filter(p => p.type === 'text' || p.type === 'image')) {
        assert.ok(p.x >= -0.5 && p.y >= -0.5 && p.x + p.w <= l.W + 0.5 && p.y + p.h <= l.H + 0.5, `${where}: ${p.role} "${words(p)}" leaves the slide at ${[p.x, p.y, p.w, p.h].map(Math.round)}`);
      }
      // Words beside one another never lie over each other.
      const boxes = l.items.filter(p => p.type === 'text' && p.role === 'body');
      for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
        const across = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), down = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        assert.ok(across <= 0.5 || down <= 0.5, `${where}: "${words(a)}" and "${words(b)}" overlap`);
      }
      // A cycle's arrows stand clear of its words.
      for (const arrow of l.items.filter(p => p.type === 'path' && p.points.length === 3)) for (const box of boxes) {
        const inside = arrow.points.some(([x, y]) => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h);
        assert.ok(!inside, `${where}: an arrow lies in "${words(box)}" at ${arrow.points.map(q => q.map(Math.round).join(',')).join(' ')}`);
      }
    }
  }
});

test('Title only leaves the space under the title free, and a picture fills it whole', () => {
  const free = lay({ layout: 'Title only', title: 'T' });
  assert.deepEqual(free.items.filter(p => p.role !== 'title' && p.role !== 'number' && p.role !== 'footer').length, 0, 'nothing but the title when shown');
  assert.ok(lay({ layout: 'Title only', title: 'T' }, undefined, { editing: true }).items.some(p => p.role === 'hint' && p.ghost), 'a hint while editing');
  const [picture] = lay({ layout: 'Title only', title: 'T', image: 'media:a', imageAlt: 'The parts' }).items.filter(p => p.type === 'image');
  assert.deepEqual([picture.fit, picture.align, picture.alt, picture.slot], ['contain', 'center', 'The parts', 0]);
});

test('a Picture grid draws as many places as its last picture or caption, two to four, each with its own slot', () => {
  const places = s => lay({ layout: 'Picture grid', title: 'T', ...s }).items.filter(p => p.role === 'image').map(p => [p.slot, p.type === 'image' ? p.src : null]);
  assert.deepEqual(places({}), [[0, null], [1, null]]);
  assert.deepEqual(places({ image3: 'media:c' }), [[0, null], [1, null], [2, 'media:c']]);
  assert.deepEqual(places({ body: '- a\n- b\n- c\n- d\n- e' }).map(p => p[0]), [0, 1, 2, 3]);
  const grid = lay({ layout: 'Picture grid', title: 'T', body: '- Harbour\n- Market', image: 'media:a', image2: 'media:b' });
  assert.deepEqual(grid.items.filter(p => p.type === 'image').map(p => p.alt), ['Harbour', 'Market'], 'a caption is its picture\'s text');
  const html = slideHtml(grid);
  assert.ok(html.includes('data-slot="0"') && html.includes('data-slot="1"'), 'the stage can tell the places apart');
  // Built, each picture comes with its caption on a click of its own.
  const built = lay({ layout: 'Picture grid', title: 'T', body: '- Harbour\n- Market\n- Mill', build: 'One by one' });
  assert.equal(built.steps, 3);
  const caption = built.items.find(p => words(p) === 'Mill');
  assert.ok(caption.step === 3 && built.items.filter(p => p.role === 'image' && p.slot === 2).every(p => p.step === 3));
  // Four at 4:3 are two rows of two.
  const square = lay({ layout: 'Picture grid', title: 'T', body: '- a\n- b\n- c\n- d' }, resolveTheme(TEMPLATES[0], null, { aspect: '4:3' }));
  assert.equal(new Set(square.items.filter(p => p.role === 'image' && p.type === 'rect').map(p => Math.round(p.y))).size, 2);
});

test('a Process is nested chevrons left to right, and a Cycle is its steps round a ring with an arrow to each next one', () => {
  const process = lay({ layout: 'Process', title: 'T', body: '- Plan | a\n- Make | b\n- Ship | c', build: 'One by one' });
  const chevrons = process.items.filter(p => p.type === 'path' && p.closed);
  assert.equal(chevrons.length, 3);
  assert.deepEqual(chevrons.map(p => p.points.length), [5, 6, 6], 'the first has no notch');
  // Each one's point reaches into the next one's notch, so the steps read as one line.
  for (let i = 1; i < chevrons.length; i++) assert.ok(Math.max(...chevrons[i - 1].points.map(q => q[0])) > Math.min(...chevrons[i].points.map(q => q[0])));
  assert.equal(process.steps, 3);
  assert.deepEqual(['Plan', 'Make', 'Ship'].map(w => process.items.find(p => words(p) === w).step), [1, 2, 3]);

  const cycle = lay({ layout: 'Cycle', title: 'T', body: '- Plan | a\n- Do | b\n- Check | c\n- Act | d', build: 'One by one' });
  const nodes = cycle.items.filter(p => p.type === 'ellipse' && p.fill);
  const ring = cycle.items.find(p => p.type === 'ellipse' && !p.fill);
  const middle = [ring.x + ring.w / 2, ring.y + ring.h / 2], r = ring.w / 2;
  assert.equal(nodes.length, 4);
  for (const n of nodes) assert.ok(Math.abs(Math.hypot(n.x + n.w / 2 - middle[0], n.y + n.h / 2 - middle[1]) - r) < 0.5, 'each step sits on the ring');
  assert.ok(nodes[0].y < middle[1] - r + 1, 'the first step is at the top');
  const arrows = cycle.items.filter(p => p.type === 'path' && p.points.length === 3);
  assert.equal(arrows.length, 4);
  assert.deepEqual(arrows.map(a => a.step), [2, 3, 4, 4], 'an arrow comes with the step it leads to; the one back to the first, with the last');
  assert.equal(lay({ layout: 'Cycle', title: 'T' }).items.filter(p => p.type === 'ellipse').length, 0, 'no steps, no ring');
});

test('a pie is a doughnut without its hole, an area is filled to nought, and a stack reaches its total', () => {
  const chart = (type, body = SALES) => lay({ layout: 'Chart', title: 'T', chart: type, body });
  const pie = chart('Pie'), doughnut = chart('Doughnut');
  assert.ok(pie.items.filter(p => p.type === 'arc').every(p => p.inner === 0) && doughnut.items.filter(p => p.type === 'arc').every(p => p.inner > 0));
  const said = l => l.items.filter(p => p.role === 'chart').map(words);
  assert.ok(said(doughnut).includes('46') && !said(pie).includes('46'), 'only the doughnut says its total in the middle');
  assert.ok(said(pie).includes('Q1  12'), 'a pie names its parts beside it');

  const area = chart('Area');
  const fills = area.items.filter(p => p.type === 'path' && p.closed);
  assert.equal(fills.length, 2);
  const lines = area.items.filter(p => p.type === 'path' && !p.closed);
  const zero = fills[0].points[0][1];
  assert.ok(fills.every(f => f.points[0][1] === zero && f.points.at(-1)[1] === zero && f.alpha < 1), 'each area closes along nought, see-through');
  assert.deepEqual(fills[1].points.slice(1, -1), lines[1].points, 'the area is under its own line');
  assert.equal(area.items.filter(p => p.type === 'ellipse').length, 0, 'an area has no dots');

  const stacked = chart('Stacked');
  const bars = stacked.items.filter(p => p.type === 'rect' && p.radius === 0);
  assert.equal(bars.length, 6);
  // Q1: 12 on 9 is one stack, its total over it; Q2's -4 goes below nought.
  const q1 = bars.filter(b => Math.abs(b.x - bars[0].x) < 0.5);
  assert.equal(q1.length, 2);
  assert.ok(Math.abs((q1[1].y + q1[1].h) - q1[0].y) <= 2.5, 'the second part stands on the first');
  assert.ok(said(stacked).includes('21') && said(stacked).includes('11') && said(stacked).includes('33'), `each stack says its total: ${said(stacked)}`);
  const q2 = bars.filter(b => Math.abs(b.x - bars[2].x) < 0.5);
  assert.ok(q2[1].y >= q2[0].y + q2[0].h - 0.5, 'a negative part hangs below nought');
  // The axis reaches the tallest stack, not only the tallest part.
  const top = Math.min(...bars.map(b => b.y));
  assert.ok(top >= stacked.items.filter(p => p.type === 'line' && p.dash).reduce((y, l) => Math.min(y, l.y1), Infinity) - 0.5, 'no stack rises past the top of the axis');
});

test('PowerPoint gets a pie as its own pie shape, and every new layout as shapes and text', async () => {
  const theme = resolveTheme(TEMPLATES[0]);
  const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const images = new Map(['media:a', 'media:b', 'media:c', 'media:d'].map(src => [src, { bytes: PNG, ext: 'png', width: 1, height: 1 }]));
  const slides = FULL.map((s, i) => ({ laid: lay(s, theme, { number: i + 1 }), hidden: false, notes: '' }));
  const entries = unzip(buildPptx({ deck: { title: 'T' }, theme, slides, images, now: new Date('2026-10-25T12:00:00Z') }));
  const xml = async n => new TextDecoder().decode(await entries.find(e => e.name === `ppt/slides/slide${n}.xml`).bytes());
  assert.equal(((await xml(2)).match(/<p:pic>/g) ?? []).length, 4, 'the grid\'s four pictures');
  assert.ok((await xml(3)).includes('<a:custGeom>') && (await xml(3)).includes('Discover'), 'the chevrons and their words');
  assert.ok((await xml(5)).includes('prst="pie"') && !(await xml(5)).includes('prst="blockArc"'), 'a pie');
});

test('the check finds a Picture grid\'s empty places and its pictures without words', () => {
  const s = (values, id) => ({ id, ...slideFrom({ recordId: id, values: Object.fromEntries(Object.entries(values).map(([k, x]) => [F.slide[k], x])) }) });
  const slides = [
    s({ layout: 'Picture grid', title: 'Grid', body: '- Harbour\n- \n- Mill', image: 'media:a', image2: 'media:b', notes: 'n' }, 'g'),
    s({ layout: 'Title only', title: 'Free', notes: 'n' }, 't'),
  ];
  const r = checkDeck(slides, { laid: x => lay(x) });
  const of = id => r.issues.filter(x => x.slideId === id).map(x => x.text);
  assert.deepEqual(of('g'), ['No picture yet in place 3 of the grid.', 'Picture 2 has no caption, which a screen reader says in its place.']);
  assert.deepEqual(of('t'), [], 'Title only needs no body and no picture');
});
