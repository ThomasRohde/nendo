import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDesign, readDesignPackage, writeDesignPackage, designSpecs, designValues, templateSpecFrom, brandSpecFrom, IMAGE_FIELDS, sourceKey, designFileName } from '../../extensions/deck/design.mjs';
import { resolveTheme } from '../../extensions/deck/themes.mjs';
import { layoutSlide } from '../../extensions/deck/layout.mjs';
import { F } from '../../extensions/deck/model.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const NORRSKEN = {
  format: 'nendo.deck-design', version: 1, name: 'Norrsken', tagline: 'Made for the long night.', voice: 'Calm and exact.',
  source: { app: 'Brandkits', kit: 'k-norrsken', kitVersion: 7, exported: '2026-10-24T05:10:00Z' },
  template: { family: 'keynote', mode: 'dark', style: { titleWeight: 640, titleTracking: -0.02, radius: 12, kicker: 'pill', bullet: '›' } },
  colors: { primary: '#2F6F8F', secondary: '#14324A', accent: '#7CF2B0', background: '#0B1622', surface: '#13222F', ink: '#EAF2F7', muted: '#93A7B6' },
  chart: ['#E8C26A', '#C0392B', '#7CF2B0'],
  fonts: { heading: 'Space Grotesk', body: "'Inter', sans-serif", mono: 'JetBrains Mono' },
  logos: { light: 'logos/logo.svg', dark: 'logos/logo-dark.svg', mark: 'logos/mark.svg', placement: 'bottom-left' },
  backgrounds: {
    title: { kind: 'gradient', angle: 135, stops: ['primary', 'background'] },
    section: { kind: 'image', src: 'backgrounds/section.svg', tint: 'background', tintAlpha: 0.4, dark: true },
    closing: { kind: 'role', role: 'secondary' },
  },
  deck: { footer: 'Norrsken · Internal', slideNumbers: true },
};
const PICTURES = new Map([['logos/logo.svg', SVG], ['logos/logo-dark.svg', SVG], ['logos/mark.svg', SVG], ['backgrounds/section.svg', SVG]]);

test('a design is checked and cut down to what Deck knows, and refused in a sentence when it is not one', () => {
  const d = normalizeDesign({ ...NORRSKEN, template: { family: 'Baroque', style: { titleWeight: 2000, kicker: 'shout', bullet: 'X', radius: -4 } }, colors: { primary: 'red', ink: '#fff' } });
  assert.equal(d.template.family, 'keynote', 'an unknown family falls back to Keynote');
  assert.equal(d.template.mode, 'dark', 'the mode is the family\'s when the design names none');
  assert.deepEqual(d.template.style, { titleWeight: 900, radius: 0 });
  assert.deepEqual(d.colors, { ink: '#FFFFFF' });
  assert.equal(normalizeDesign(NORRSKEN).fonts.body, 'Inter');
  assert.throws(() => normalizeDesign({ name: 'x' }), /not a Deck design/);
  assert.throws(() => normalizeDesign({ ...NORRSKEN, version: 2 }), /version 2, made by a newer Brandkits/);
  assert.throws(() => normalizeDesign({ ...NORRSKEN, name: '  ' }), /no name/);
  // A path that climbs out of the package is no picture.
  assert.equal(normalizeDesign({ ...NORRSKEN, logos: { light: '../secret.svg' } }).logos, undefined);
  assert.equal(designFileName(NORRSKEN), 'Norrsken.deckdesign');
});

test('a .deckdesign file reads back what was written, and a picture it lacks is left out', async () => {
  const bytes = writeDesignPackage(NORRSKEN, PICTURES);
  const { design, pictures } = await readDesignPackage(bytes, 'Norrsken.deckdesign');
  assert.deepEqual(design, normalizeDesign(NORRSKEN));
  assert.equal(pictures.size, 4);
  assert.equal(pictures.get('logos/mark.svg').type, 'image/svg+xml');
  const partial = await readDesignPackage(writeDesignPackage(NORRSKEN, new Map([['logos/logo.svg', SVG]])), 'partial');
  assert.equal(partial.design.logos.mark, undefined);
  assert.equal(partial.design.backgrounds.section, undefined, 'a background picture the file lacks is not drawn as a hole');
  assert.equal(partial.design.backgrounds.title.kind, 'gradient');
  await assert.rejects(readDesignPackage(new TextEncoder().encode('{"format":"nendo.deck-design"}'), 'plain.json'), /not a Deck design file/);
});

test('a design draws its own backgrounds, chart colours, mark and logo placement', () => {
  const { template, brand, deck } = designSpecs(normalizeDesign(NORRSKEN), p => `media:${p}`);
  const theme = resolveTheme(template, brand, { ...deck, aspect: '16:9' });
  assert.equal(theme.colors.bg, '#0B1622', 'a dark brand on a dark template keeps its own background');
  assert.equal(theme.style.kicker, 'pill');
  assert.equal(theme.style.radius, 12);

  const title = layoutSlide({ layout: 'Title', title: 'Made for the long night', kicker: '', body: '' }, theme);
  assert.equal(title.background.type, 'linear');
  assert.deepEqual(title.background.stops.map(s => s.color), ['#2F6F8F', '#0B1622']);

  const section = layoutSlide({ layout: 'Section', title: 'Two', kicker: '02', body: '' }, theme);
  assert.equal(section.items[0].type, 'image', 'the background picture is drawn first');
  assert.equal(section.items[0].src, 'media:backgrounds/section.svg');
  assert.equal(section.items[1].alpha, 0.4, 'its tint is drawn over it');
  assert.ok(section.dark);

  const closing = layoutSlide({ layout: 'Closing', title: 'Thanks', kicker: '', body: '' }, theme);
  assert.equal(closing.background, '#14324A');

  const chart = layoutSlide({ layout: 'Chart', title: 'Sales', kicker: '', body: '| Q | A | B |\n| --- | --- | --- |\n| 1 | 3 | 4 |\n| 2 | 5 | 6 |', body2: '', chart: 'Column' }, theme, { number: 4 });
  const fills = new Set(chart.items.filter(i => i.type === 'rect').map(i => i.fill));
  // Neither colour is a role of the kit, so only the chart colours can draw them.
  assert.ok(fills.has('#E8C26A') && fills.has('#C0392B'), 'the series take the design\'s chart colours in order');
  const logo = chart.items.find(i => i.role === 'logo');
  assert.equal(logo.src, 'media:logos/mark.svg', 'a content slide carries the mark');
  assert.equal(logo.x, 80, 'at the bottom left');
  assert.ok(logo.y > 600);
  const footer = chart.items.find(i => i.role === 'footer');
  assert.ok(footer.x >= logo.x + logo.w, 'the footer moves aside for the logo');
});

test('a design kept as Deck records draws the same as the design itself', () => {
  const design = normalizeDesign(NORRSKEN);
  const values = designValues(design);
  assert.equal(values.template[F.template.source], 'Brandkits:k-norrsken');
  assert.equal(sourceKey({ name: 'Plain' }), 'name:plain');
  // The pictures become media on the records; the backgrounds name them by slide kind.
  const media = { [F.brand.logo]: 'media:logos/logo.svg', [F.brand.logoDark]: 'media:logos/logo-dark.svg', [F.brand.mark]: 'media:logos/mark.svg' };
  const templateRecord = { ...values.template, [IMAGE_FIELDS.section]: 'media:backgrounds/section.svg' };
  const fromRecords = resolveTheme(templateSpecFrom(templateRecord, 'dk.template.x'), brandSpecFrom({ ...values.brand, ...media }), { aspect: '16:9' });
  const specs = designSpecs(design, p => `media:${p}`);
  const fromDesign = resolveTheme(specs.template, specs.brand, { aspect: '16:9' });
  for (const key of ['family', 'mode', 'fonts', 'colors', 'style', 'backgrounds', 'chart', 'logoPlacement', 'brand']) assert.deepEqual(fromRecords[key], fromDesign[key], key);
  // A second import names every field, so nothing of the first is left behind.
  const plain = designValues(normalizeDesign({ format: 'nendo.deck-design', version: 1, name: 'Plain' }));
  assert.equal(plain.template[F.template.backgrounds], null);
  assert.equal(plain.brand[F.brand.primary], null);
});
