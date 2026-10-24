import test from 'node:test';
import assert from 'node:assert/strict';
import { kitDesign, kitRoles, familyFor, readChoices } from '../../extensions/brandkits/slides.js';
import { writeDesignPackage } from '../../extensions/brandkits/deck/design.mjs';
import { readDesignPackage, designSpecs } from '../../extensions/deck/design.mjs';
import { resolveTheme, contrast, mix, isDark } from '../../extensions/deck/themes.mjs';
import { layoutSlide } from '../../extensions/deck/layout.mjs';
import { FILE, EXAMPLE_KIT } from './definition.mjs';

// The example kit as the view hands it to slides.js.
const ex = FILE.example;
const k = ex.kit[0].values;
const EMBER = {
  recordId: EXAMPLE_KIT, version: 3, name: k.kitName, tagline: k.kitTagline, voice: k.kitVoice, personality: k.kitPersonality,
  colours: [...ex.colour].sort((a, b) => a.values.colourOrder - b.values.colourOrder).map(c => ({ role: c.values.colourRole, hex: c.values.colourHex })),
  typefaces: ex.typeface.map(t => ({ role: t.values.typeRole, family: t.values.typeFamily })),
  logos: ex.logo.map(l => ({ kind: l.values.logoKind, svg: l.values.logoSvg })), pictures: {},
};

test('a kit\'s colours become Deck\'s roles: its own roles first, the neutrals as surface and muted text', () => {
  const { colors, chart } = kitRoles(EMBER.colours);
  // Steam (#8A7B6E) reads at 3.5:1 on Cream, under the 4.5:1 muted text needs: Deck darkens its own muted instead.
  assert.deepEqual(colors, { primary: '#8B3A2B', secondary: '#2F4A3A', accent: '#9A4F1E', background: '#F6EDE0', ink: '#2B1A12', surface: '#E4D5C1' });
  assert.ok(!chart.includes('#F6EDE0'), 'the background is no chart colour');
  assert.equal(chart[0], '#8B3A2B');
  // A kit with no named roles still gets a background and text from its lightest and darkest colours.
  assert.deepEqual(kitRoles([{ role: 'Neutral', hex: '#111111' }, { role: 'Neutral', hex: '#FAFAFA' }]).colors, { background: '#FAFAFA', ink: '#111111' });
});

test('a kit with no slide choices gets a design from its personality, and the choices change it', () => {
  assert.equal(familyFor('Warm, Crafted, Plain-spoken, Unhurried'), 'editorial');
  assert.equal(familyFor('Joyful, Bold, Generous, Cheeky'), 'studio');
  assert.equal(familyFor(''), 'keynote');
  const plain = kitDesign(EMBER).design;
  assert.equal(plain.template.family, 'editorial');
  assert.equal(plain.template.mode, 'light');
  assert.equal(plain.fonts.heading, EMBER.typefaces.find(t => t.role === 'Heading' || t.role === 'Display').family);
  assert.equal(plain.source.kit, EXAMPLE_KIT);
  assert.equal(plain.backgrounds, undefined, 'no choice keeps the family\'s own backgrounds');
  const chosen = kitDesign(EMBER, readChoices(JSON.stringify({ family: 'swiss', mode: 'dark', radius: 12, kicker: 'pill', placement: 'bottom-left',
    backgrounds: { title: 'gradient:primary,secondary', section: 'role:accent', closing: 'picture' } }))).design;
  assert.equal(chosen.template.family, 'swiss');
  assert.equal(chosen.template.mode, 'dark');
  assert.deepEqual(chosen.template.style, { radius: 12, kicker: 'pill' });
  assert.equal(chosen.logos.placement, 'bottom-left');
  assert.deepEqual(chosen.backgrounds.title, { kind: 'gradient', angle: 135, stops: ['primary', 'secondary'] });
  assert.deepEqual(chosen.backgrounds.section, { kind: 'role', role: 'accent' });
  assert.equal(chosen.backgrounds.closing, undefined, 'a picture background with no picture on the kit is left out');
  assert.deepEqual(readChoices('not json'), {});
});

test('what Brandkits exports, Deck reads and draws as Brandkits previewed it', async () => {
  const kit = { ...EMBER, pictures: { section: { type: 'image/png' } } };
  const { design, pictures, pictureSlots } = kitDesign(kit, { backgrounds: { section: 'picture', title: 'role:secondary' } });
  assert.deepEqual(pictureSlots, { section: 'backgrounds/section.png' });
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  pictures.set(pictureSlots.section, png);
  const bytes = writeDesignPackage(design, pictures);
  const read = await readDesignPackage(bytes, 'Ember.deckdesign');
  assert.deepEqual(read.design, design);
  assert.deepEqual([...read.pictures.keys()].sort(), ['backgrounds/section.png', ...[...pictures.keys()].filter(p => p.startsWith('logos/'))].sort());
  // The preview and the import resolve the same theme, so a slide lays out the same in both apps.
  const preview = designSpecs(design, p => `url:${p}`), imported = designSpecs(read.design, p => `url:${p}`);
  const slide = { layout: 'Section', title: 'What we stand for', kicker: '01', body: '' };
  assert.deepEqual(layoutSlide(slide, resolveTheme(imported.template, imported.brand)), layoutSlide(slide, resolveTheme(preview.template, preview.brand)));
  assert.equal(layoutSlide(slide, resolveTheme(imported.template, imported.brand)).items[0].src, 'url:backgrounds/section.png');
});

test('Light and Dark choose the stage, whatever the kit\'s own background', () => {
  const night = { ...EMBER, colours: [{ role: 'Background', hex: '#111111' }, { role: 'Text', hex: '#EEEEEE' }, { role: 'Primary', hex: '#C2410C' }] };
  const stage = mode => {
    const { template, brand, deck } = designSpecs(kitDesign(night, { family: 'minimal', mode }).design, p => `url:${p}`);
    return resolveTheme(template, brand, deck).colors;
  };
  const light = stage('light'), dark = stage('dark');
  assert.ok(!isDark(light.bg), `Light gives a light stage: ${light.bg}`);
  assert.ok(isDark(dark.bg), `Dark gives a dark stage: ${dark.bg}`);
  assert.ok(contrast(light.ink, light.bg) >= 7, `text on the light stage: ${light.ink} on ${light.bg}`);
});

test('a picture behind a kind of slide keeps a white title readable, on a light stage or a dark one', () => {
  for (const mode of ['light', 'dark']) {
    const { design } = kitDesign({ ...EMBER, pictures: { section: { type: 'image/png' } } }, { mode, backgrounds: { section: 'picture' } });
    const { template, brand, deck } = designSpecs(design, p => `url:${p}`);
    const laid = layoutSlide({ layout: 'Section', title: 'What we stand for', kicker: '01', body: '' }, resolveTheme(template, brand, deck));
    const tint = laid.items.find(i => i.type === 'rect' && i.role === 'background');
    const title = laid.items.find(i => i.role === 'title');
    assert.ok(isDark(tint.fill), `the tint is dark on a ${mode} stage: ${tint.fill}`);
    // The worst picture is white: the title must still read at 3:1 on the tint over it.
    const ratio = contrast(title.color, mix('#FFFFFF', tint.fill, tint.alpha));
    assert.ok(ratio >= 3, `on a ${mode} stage the title reads at ${ratio.toFixed(2)}:1 over a white picture`);
  }
});
