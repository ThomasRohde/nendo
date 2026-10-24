import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, resolveTheme, contrast, normalHex, webFonts, sizeOf } from '../../extensions/deck/themes.mjs';

// Kits that try to break a template: a yellow primary on white, a black kit on a light template, a
// kit of one pale colour, a full kit, and none.
const KITS = [
  null,
  { name: 'Yellow', colors: { primary: '#FFE600', background: '#FFFFFF', ink: '#111111' } },
  { name: 'Full', colors: { primary: '#0B6E4F', secondary: '#F2A541', accent: '#E4572E', background: '#FFFDF8', surface: '#F3EFE6', ink: '#1D2A26', muted: '#5E6B66' }, fonts: { heading: 'Fraunces', body: 'Inter' } },
  { name: 'Black', colors: { primary: '#222222', background: '#000000', ink: '#FFFFFF', muted: '#333333', accent: '#FFFFFF' } },
  { name: 'Pale', colors: { primary: '#88CCFF' } },
];

test('six templates, each with seven colours and two fonts', () => {
  assert.deepEqual(TEMPLATES.map(t => t.id), ['keynote', 'editorial', 'swiss', 'boardroom', 'studio', 'minimal']);
  for (const t of TEMPLATES) {
    for (const role of ['bg', 'surface', 'ink', 'muted', 'primary', 'secondary', 'accent']) assert.ok(normalHex(t.colors[role]), `${t.id} ${role}`);
    assert.ok(t.fonts.heading && t.fonts.body, t.id);
  }
});

test('every template with every kit stays legible on its own background', () => {
  for (const template of TEMPLATES) for (const kit of KITS) {
    const c = resolveTheme(template, kit).colors, where = `${template.id} with ${kit?.name ?? 'no kit'}`;
    assert.ok(contrast(c.ink, c.bg) >= 7, `${where}: text ${contrast(c.ink, c.bg).toFixed(2)}`);
    assert.ok(contrast(c.muted, c.bg) >= 4.5, `${where}: muted ${contrast(c.muted, c.bg).toFixed(2)}`);
    assert.ok(contrast(c.primaryText, c.bg) >= 3, `${where}: primary as text ${contrast(c.primaryText, c.bg).toFixed(2)}`);
    assert.ok(contrast(c.accentText, c.bg) >= 3, `${where}: accent as text ${contrast(c.accentText, c.bg).toFixed(2)}`);
    assert.ok(contrast(c.onPrimary, c.primary) >= 4.5, `${where}: text on primary ${contrast(c.onPrimary, c.primary).toFixed(2)}`);
    assert.ok(contrast(c.onSurface, c.surface) >= 7, `${where}: text on surface ${contrast(c.onSurface, c.surface).toFixed(2)}`);
  }
});

test('a kit sets the colours and fonts; a dark template keeps its dark stage', () => {
  const full = KITS[2];
  const light = resolveTheme(TEMPLATES[1], full);
  assert.equal(light.colors.bg, '#FFFDF8');
  assert.equal(light.colors.primary, '#0B6E4F');
  assert.equal(light.fonts.heading, 'Fraunces');
  assert.equal(light.brand.name, 'Full');
  const dark = resolveTheme(TEMPLATES[0], full);
  assert.ok(contrast(dark.colors.bg, '#000000') < 2, `Keynote keeps a dark stage under a light kit: ${dark.colors.bg}`);
  assert.equal(dark.colors.primary, '#0B6E4F');
});

test('a light template keeps its light stage under a dark kit', () => {
  const black = KITS[3];
  for (const template of TEMPLATES.filter(t => t.mode === 'light')) {
    const { colors } = resolveTheme(template, black);
    assert.ok(contrast(colors.bg, '#FFFFFF') < 2, `${template.id} keeps a light stage under a dark kit: ${colors.bg}`);
    assert.equal(colors.ink, '#000000', `${template.id} writes in the kit's background colour`);
  }
  // A kit with no light colour of its own stands on its primary, lightened.
  const { colors } = resolveTheme(TEMPLATES[1], { colors: { primary: '#0B6E4F', background: '#111111', ink: '#222222' } });
  assert.ok(contrast(colors.bg, '#FFFFFF') < 1.2, `a stage from the primary: ${colors.bg}`);
});

test('a template record overrides its family; fonts not on the machine come from the web', () => {
  const theme = resolveTheme({ id: 'mine', family: 'swiss', name: 'Mine', colors: { primary: '#123456', bg: '' }, fonts: { heading: 'Space Grotesk' } });
  assert.equal(theme.family, 'swiss');
  assert.equal(theme.colors.primary, '#123456');
  assert.equal(theme.colors.bg, TEMPLATES[2].colors.bg);
  assert.match(webFonts(theme) ?? '', /^https:\/\/fonts\.googleapis\.com\/css2\?family=Space\+Grotesk/);
  assert.deepEqual([sizeOf('16:9'), sizeOf('4:3')], [{ W: 1280, H: 720 }, { W: 960, H: 720 }]);
});
