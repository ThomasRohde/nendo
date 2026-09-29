import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';

// W-096. A panel marked by a thick coloured stripe down its left edge read as generated
// filler, and it was on eight different things. Callouts now carry their tone in an icon
// and, when they ask for attention, a tint (.callout, .callout.is-tinted). This reads every
// stylesheet and refuses a thick left edge in any colour but a neutral line, so the stripe
// cannot come back one component at a time. A keyboard focus marker is not a callout.
const folder = new URL('../src/styles/', import.meta.url);
const sheets = readdirSync(folder).filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, text: readFileSync(new URL(name, folder), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));

// The whole colour must be a neutral line: var(--tone, var(--line-strong)) is a tone.
const neutral = /solid\s+var\(--line(-strong)?\)\s*;$/;
const thickLeft = /(?:border-left|border-inline-start)\s*:\s*([2-9]|\d{2,})px[^;]*;|border-left-width\s*:\s*([2-9]|\d{2,})px|box-shadow\s*:\s*inset\s+([2-9]|\d{2,})px\s+0\s+0[^;]*;/g;

test('no callout is marked by a coloured stripe down its left edge', () => {
  const offenders = [];
  for (const { name, text } of sheets) {
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/:focus-visible/.test(selector)) continue;
      for (const [declaration] of body.matchAll(thickLeft)) {
        if (/border-left-width/.test(declaration) || !neutral.test(declaration)) {
          offenders.push(`${name}: ${selector.trim()} { ${declaration.trim()} }`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `A coloured left stripe is back:\n${offenders.join('\n')}`);
});

test('the callout carries its tone in an icon and a tint, from one variable', () => {
  const controls = sheets.find((sheet) => sheet.name === '14-refinements-controls.css').text;
  assert.match(controls, /\.callout > \.callout-icon \{[^}]*color: var\(--callout-tone\)/);
  assert.match(controls, /\.callout\.is-tinted \{[^}]*background: color-mix\(in srgb, var\(--callout-tone\)/);
  assert.match(controls, /\.behaviour-approval\[data-approved="false"\] \{ --callout-tone: var\(--warning\); \}/);
});
