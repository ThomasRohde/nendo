import test from 'node:test';
import assert from 'node:assert/strict';
import { roleOf, parseTokensJson, parseCss, readReadme, importBrandFile, kitValues, emptyKit } from '../../extensions/deck/brand-import.mjs';
import { zip } from '../../extensions/deck/zip.mjs';

const file = (name, data) => ({ name, arrayBuffer: async () => (typeof data === 'string' ? new TextEncoder().encode(data) : data).buffer });

test('a token path names its role; text roles win over brand roles', () => {
  const cases = { 'color.brand.primary': 'primary', 'color.text.secondary': 'muted', 'colors.text': 'ink', 'neutral.background': 'background', 'bg': 'background',
    'color.surface': 'surface', 'accent': 'accent', 'highlight': 'accent', 'brand': 'primary', 'font.size.body': null, 'radius.card': null, 'spacing.4': null };
  for (const [path, role] of Object.entries(cases)) assert.equal(roleOf(path), role, path);
});

test('design tokens in the W3C form, and in a flat form', () => {
  const kit = parseTokensJson(JSON.stringify({ name: 'Acme', voice: ['Plain.', 'Kind.'],
    color: { primary: { $value: '#ff5500', $type: 'color' }, secondary: { $value: '#05f' }, background: { $value: '#FFFFFF' }, text: { default: { $value: '#111' } } },
    font: { heading: { $value: ['Fraunces', 'serif'], $type: 'fontFamily' }, body: { $value: 'Inter, sans-serif', $type: 'fontFamily' }, mono: { $value: 'JetBrains Mono' } } }));
  assert.equal(kit.name, 'Acme');
  assert.equal(kit.voice, 'Plain.\nKind.');
  assert.deepEqual(kit.colors, { primary: '#FF5500', secondary: '#0055FF', background: '#FFFFFF', ink: '#111111' });
  assert.deepEqual(kit.fonts, { heading: 'Fraunces', body: 'Inter', mono: 'JetBrains Mono' });
  const flat = parseTokensJson(JSON.stringify({ colors: ['#123456', '#abcdef', '#00ff00'] }));
  assert.deepEqual(flat.colors, { primary: '#123456', secondary: '#ABCDEF', accent: '#00FF00' });
});

test('CSS variables', () => {
  const kit = parseCss(':root { --brand-primary: #0B6E4F; --color-accent:#E4572E; --text-muted: #5E6B66; --font-heading: "Fraunces", serif; --radius: 8px; }');
  assert.deepEqual(kit.colors, { primary: '#0B6E4F', accent: '#E4572E', muted: '#5E6B66' });
  assert.equal(kit.fonts.heading, 'Fraunces');
});

test('a README gives the name, the voice and the tagline', () => {
  const kit = readReadme('# Northwind brand kit\n\n**Tagline:** Goods that travel well\n\n## Voice and tone\n\nWarm and direct.\n\nShort sentences.\n\n## Colours\n\nGreen.', { name: '', voice: '', tagline: '' });
  assert.deepEqual(kit, { name: 'Northwind', voice: 'Warm and direct.\n\nShort sentences.', tagline: 'Goods that travel well' });
});

test('a Claude Design bundle: tokens, CSS, README and both logos', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const bytes = zip([
    { name: 'kit/README.md', data: '# Northwind brand kit\n\n## Voice\n\nWarm.\n' },
    { name: 'kit/tokens/tokens.json', data: JSON.stringify({ color: { brand: { primary: { $value: '#0B6E4F' } } } }) },
    { name: 'kit/tokens/brand.css', data: ':root{--color-accent:#E4572E;--color-primary:#000000}' },
    { name: 'kit/assets/logos/logo-primary.svg', data: svg },
    { name: 'kit/assets/logos/logo-reverse.svg', data: svg },
    { name: '__MACOSX/kit/._logo.svg', data: 'junk' },
  ]);
  const kit = await importBrandFile(file('northwind.zip', bytes));
  assert.equal(kit.name, 'Northwind');
  assert.equal(kit.voice, 'Warm.');
  assert.deepEqual(kit.colors, { primary: '#0B6E4F', accent: '#E4572E' }, 'the tokens win over the CSS for a role both name');
  assert.deepEqual([kit.logos.light.name, kit.logos.light.type, kit.logos.dark.name], ['logo-primary.svg', 'image/svg+xml', 'logo-reverse.svg']);
});

test('a kit names only the fields its file holds, so an import again keeps the rest', () => {
  const kit = parseCss(':root { --brand-primary: #0B6E4F; }', { ...emptyKit(), name: 'Harbour' });
  assert.deepEqual(kitValues(kit), { source: 'Brandkits', name: 'Harbour', tokens: ':root { --brand-primary: #0B6E4F; }', primary: '#0B6E4F' });
  const full = { ...emptyKit(), name: 'Harbour', voice: 'Plain.', tagline: 'Out to sea', tokens: '{}', fonts: { heading: 'Inter', body: 'Inter' }, colors: { primary: '#0B6E4F', ink: '#111111' } };
  assert.deepEqual(kitValues(full), { source: 'Brandkits', name: 'Harbour', voice: 'Plain.', tagline: 'Out to sea', tokens: '{}', headingFont: 'Inter', bodyFont: 'Inter', primary: '#0B6E4F', ink: '#111111' });
});

test('a kit that names its roles gets no others from its loose colours', () => {
  const kit = parseTokensJson(JSON.stringify({ name: 'Existing', colors: { primary: '#112233', border: '#dddddd' } }));
  assert.deepEqual(kit.colors, { primary: '#112233' }, `colours: ${JSON.stringify(kit.colors)}`);
  const loose = parseTokensJson(JSON.stringify({ name: 'Loose', palette: { one: '#112233', two: '#445566' } }));
  assert.equal(loose.colors.primary, '#112233');
  assert.equal(loose.colors.secondary, '#445566');
});

test('a single logo, and a file that is no kit', async () => {
  const logo = await importBrandFile(file('acme-white.png', new Uint8Array([137, 80, 78, 71])));
  assert.deepEqual(Object.keys(logo.logos), ['dark']);
  await assert.rejects(importBrandFile(file('notes.txt', 'hello')), /is not a brand kit Deck can read/);
  await assert.rejects(importBrandFile(file('empty.json', '{"spacing":{"1":"4px"}}')), /names no colours/);
});
