import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// A choice chip's text is its option's colour mixed with the theme's ink, on a tint of the
// same colour. For the hue derived for an option nobody coloured, 183 of 360 hues fell below
// 4.5:1 in Light (2.56:1 at a pale yellow). This resolves the chip's own CSS, as the stylesheet
// and the inline style choiceStyle writes declare it, for every named tone and every derived hue,
// in both themes, and requires 4.5:1.
const { CHOICE_TONES, choiceStyle } = await bundleOf('src/tones.ts');
const css = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');
const pages = css('13-refinements-pages.css');
const tokens = css('02-tokens.css');

const hex = (value) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
const hsl = (h, s, l) => {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};
const mix = (a, percent, b) => a.map((value, index) => value * percent / 100 + b[index] * (100 - percent) / 100);
const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// The two theme blocks of the tokens: Light first, then Dark.
const blocks = tokens.split(/:root\[data-theme="dark"\]|@media \(prefers-color-scheme: dark\)/);
const token = (block, name) => hex(block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))[1]);
const light = blocks[0];
const dark = blocks.slice(1).find((block) => /--tone-red:/.test(block));

// The chip's declarations, read from the stylesheet so a change there is what is measured.
const rule = (selector) => pages.slice(pages.indexOf(`${selector} {`), pages.indexOf('}', pages.indexOf(`${selector} {`)));
const lightRule = rule('.card-chip');
const darkRule = rule(':root[data-theme="dark"] .card-chip');
const share = (declaration, variable) => Number(declaration.match(new RegExp(`var\\(--${variable}, (\\d+)%\\)`))[1]);
const tint = (declaration) => Number(declaration.match(/background: color-mix\(in srgb, var\(--status-color, var\(--muted\)\) (\d+)%/)[1]);

const themes = [
  { name: 'Light', ink: token(light, 'ink'), surface: token(light, 'surface-raised'), tone: (name) => token(light, `tone-${name}`),
    text: share(lightRule, 'chip-share'), tint: tint(lightRule), inline: 'chip-share' },
  { name: 'Dark', ink: [255, 255, 255], surface: token(dark, 'surface-raised'), tone: (name) => token(dark, `tone-${name}`),
    text: share(darkRule, 'chip-share-dark'), tint: tint(darkRule), inline: 'chip-share-dark' },
];

test('every chip, named tone or derived hue, reads at 4.5:1 in both themes', () => {
  const failures = [];
  for (const theme of themes) {
    const measure = (label, colour, textShare) => {
      const ratio = contrast(mix(colour, textShare, theme.ink), mix(colour, theme.tint, theme.surface));
      if (ratio < 4.5) failures.push(`${theme.name} ${label} ${ratio.toFixed(2)}:1`);
    };
    for (const name of CHOICE_TONES) measure(name, theme.tone(name), theme.text);
    for (let value = 0; value < 2000; value++) {
      const style = choiceStyle(undefined, `option ${value}`);
      const [, hue] = style.match(/hsl\((\d+) 58% 49%\)/);
      const declared = style.match(new RegExp(`--${theme.inline}: (\\d+)%`));
      measure(`hue ${hue}`, hsl(Number(hue), 58, 49), declared === null ? theme.text : Number(declared[1]));
    }
  }
  assert.deepEqual([...new Set(failures)].slice(0, 12), [], `Chips below 4.5:1 (${new Set(failures).size} in all).`);
});

