// W-078: the Capability Atlas export (extensions/bcm-atlas/export.js). The browser lane
// (tools/Gate-BcmAtlas.mjs) measures the exported files in the view; these measure the
// document itself: its cards, its size, its escaping and what a slide editor would meet in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { mapSvg, printPalette, hex, wrap, cssFont } from '../../extensions/bcm-atlas/export.js';
import { bindAtlas, hierarchy, projectHierarchy } from '../../extensions/bcm-atlas/model.js';
import { layoutCapabilities } from '../../extensions/bcm-atlas/layout-profile.js';
import { bcmFixture } from './fixtures.mjs';
import { engineTree } from './engine-tree.mjs';

// Wide enough to wrap like Segoe UI: about 0.6 em a character.
const measure = (text, font) => text.length * Number(/(\d+)px/.exec(font)[1]) * 0.6;
const cards = [
  { x: 8, y: 8, width: 336, height: 96, isLeaf: false, title: 'R&D <core> "systems"', meta: '', score: '', tone: 'grey' },
  { x: 16, y: 32, width: 160, height: 56, isLeaf: true, title: 'Payroll calculation and statutory reporting for every country', meta: 'CAP-6.2.1', score: '3 / 5', tone: 'amber' },
  { x: 184, y: 32, width: 160, height: 56, isLeaf: true, title: 'Ledger', meta: '', score: '—', tone: 'not-a-tone' },
];
const legend = [['Initial', 'red'], ['Defined', 'amber']];
const build = (palette = printPalette) => mapSvg({ cards, title: 'Capability map', subtitle: 'Enterprise · 2 levels', note: 'NORTHSTAR', legend, palette, measure });

test('the document holds every card, sized to the cards and not to anything around them', () => {
  const file = build();
  assert.equal(file.cards, 3);
  assert.equal((file.svg.match(/<g class="card">/g) ?? []).length, 3);
  // The cards span 336 by 96 from (8, 8); a 24px margin, a 78px title band with a note, a 34px legend.
  assert.equal(file.width, 336 + 48);
  assert.equal(file.height, 78 + 96 + 34 + 48);
  assert.match(file.svg, new RegExp(`<svg xmlns="http://www.w3.org/2000/svg" width="${file.width}" height="${file.height}" viewBox="0 0 ${file.width} ${file.height}">`));
  assert.match(file.svg, /<g class="map" transform="translate\(16 94\)">/, 'The map is not moved to sit inside the margin under the title band.');
});

test('text is escaped, wrapped to two lines and ellipsised, and stays text', () => {
  const { svg } = build();
  assert.ok(svg.includes('R&amp;D &lt;core&gt; &quot;systems&quot;'), 'A title was not escaped.');
  assert.ok(!svg.includes('<core>'), 'Markup in a title reached the document.');
  const lines = [...svg.matchAll(/<tspan x="28" y="(\d+)">([^<]*)<\/tspan>/g)].map(match => match[2]);
  assert.equal(lines.length, 2, 'A long leaf title is not set on two lines.');
  assert.ok(lines[1].endsWith('…'), 'The second line of an overlong title is not ellipsised.');
  assert.deepEqual(wrap('A B', 1000, 2, { size: 13, weight: 500, family: 'x' }, measure), ['A B']);
  assert.ok(svg.includes('<title>Payroll calculation and statutory reporting for every country</title>'), 'A card does not carry its whole name.');
});

test('a slide editor meets only plain shapes, hex colours and presentation attributes', () => {
  const { svg } = build();
  for (const banned of ['var(', '<style', 'style=', 'foreignObject', 'filter', 'color-mix', 'text-anchor', 'dominant-baseline']) {
    assert.ok(!svg.includes(banned), `The document uses ${banned}, which a slide editor may not keep.`);
  }
  const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map(match => match[1]);
  assert.ok(colours.length > 10);
  assert.deepEqual(colours.filter(colour => !/^#[0-9a-f]{6}$/.test(colour)), [], 'A colour is not #rrggbb.');
});

test('colours come from the palette given: the theme, or light on white for print', () => {
  assert.match(build().svg, /<rect class="background"[^>]* fill="#ffffff"\/>/);
  const dark = { ...printPalette, canvas: 'rgb(15, 17, 21)', surface: '#14171c', 'tone-amber': '#e8c15a' };
  const svg = build(dark).svg;
  assert.match(svg, /<rect class="background"[^>]* fill="#0f1115"\/>/, 'An rgb() canvas was not written as hex.');
  // A leaf is its tone at 9% over the surface, as view.css mixes it: #e8c15a over #14171c.
  assert.ok(svg.includes('fill="#272622"'), 'A leaf is not its tone at 9% over the surface.');
  // A tone the palette does not know is drawn grey rather than black: #677080 over #14171c.
  assert.ok(svg.includes('fill="#1b1f25"'), 'A leaf of an unknown tone is not drawn grey.');
  assert.equal(hex('rgba(15, 17, 21, 0.5)'), '#0f1115');
  assert.throws(() => mapSvg({ cards: [], title: 't', subtitle: 's', palette: printPalette, measure }), /no capabilities/);
  assert.equal(cssFont({ size: 12, weight: 600, family: 'Segoe UI, Arial, sans-serif' }), '600 12px Segoe UI, Arial, sans-serif');
});

test('the Northstar map at two levels exports its 48 cards from the layout', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../../extensions/bcm-atlas/layout.js', import.meta.url), 'utf8'), context);
  const { context: view, schema, records } = bcmFixture();
  const bound = bindAtlas(view, schema);
  const model = hierarchy(engineTree(records['bcm.capability']), bound.title);
  const layout = layoutCapabilities(context.window.BcmLayout, projectHierarchy(model, null, 2).tree);
  const drawn = layout.nodes.filter(node => !node.synthetic);
  const file = mapSvg({
    cards: drawn.map(node => ({ ...node, title: bound.title(model.byId.get(node.id)), meta: '', score: '', tone: 'grey' })),
    title: 'Capability map', subtitle: 'Enterprise', legend: [], palette: printPalette, measure,
  });
  assert.equal(file.cards, 48);
  const right = Math.max(...drawn.map(node => node.x + node.width)), left = Math.min(...drawn.map(node => node.x));
  assert.equal(file.width, Math.ceil(right - left + 48));
});
