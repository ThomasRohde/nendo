import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';

// W-134. The front page's recent and ranked panels asked for var(--border), which no
// stylesheet declares. A var() naming an undeclared property with no fallback makes the
// whole declaration invalid, so both panels drew no border at all and nothing said so.
// This reads every stylesheet and refuses a var() without a fallback unless the property
// is declared in a stylesheet or set by the Workbench's own code, as an inline style is.
const styles = new URL('../src/styles/', import.meta.url);
const sources = new URL('../src/', import.meta.url);
const sheets = readdirSync(styles).filter((name) => name.endsWith('.css'))
  // Comments go, their line breaks stay, so a refusal names the line it is on.
  .map((name) => ({ name, text: readFileSync(new URL(name, styles), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, '')) }));
const code = readdirSync(sources, { recursive: true })
  .filter((name) => typeof name === 'string' && name.endsWith('.ts'))
  .map((name) => readFileSync(new URL(name.replaceAll('\\', '/'), sources), 'utf8'))
  .join('\n');

const declared = new Set(sheets.flatMap(({ text }) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])));
const setByCode = (name) => new RegExp(`${name}(?![\\w-])`).test(code);

test('every custom property a stylesheet reads without a fallback exists', () => {
  const missing = [];
  for (const { name, text } of sheets) {
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      const [, property, fallback] = match;
      if (fallback !== undefined || declared.has(property) || setByCode(property)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      missing.push(`${name}:${line} reads ${property}`);
    }
  }
  assert.deepEqual(missing, [], 'A var() with no fallback names a property nothing declares');
});
