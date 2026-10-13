import { readFileSync, readdirSync } from 'node:fs';

// The Workbench stylesheet as its slices, in the order styles.css imports them, parsed into
// rules a test can reason about: each rule's selectors, the @media or @container conditions it
// sits under, and its declarations with their lines. Not a test itself: npm test runs
// scripts/*.test.mjs. It reads the plain CSS these slices are written in (no nesting), which is
// all a test of the cascade needs.
const source = new URL('../src/', import.meta.url);
const styles = new URL('styles/', source);

export const stylesheetIndex = readFileSync(new URL('styles.css', source), 'utf8');
export const sliceNames = [...stylesheetIndex.matchAll(/@import '\.\/styles\/([^']+)'/g)].map((match) => match[1]);

/** Comments go and their line breaks stay, so a line number still names the line. */
export const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''));

export const sliceText = (name) => readFileSync(new URL(name, styles), 'utf8');

/** Every TypeScript source and index.html, for what the page can emit. */
export const pageSources = () => [
  readFileSync(new URL('../index.html', source), 'utf8'),
  ...readdirSync(source, { recursive: true })
    .filter((name) => typeof name === 'string' && name.endsWith('.ts'))
    .map((name) => readFileSync(new URL(name.replaceAll('\\', '/'), source), 'utf8')),
].join('\n');

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function matching(text, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) { if (char === '\\') index++; else if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index;
  }
  throw Error(`Unbalanced braces from offset ${open}.`);
}

function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) { if (char === '\\') index++; else if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === separator && depth === 0) { parts.push({ text: text.slice(start, index), at: start }); start = index + 1; }
  }
  parts.push({ text: text.slice(start), at: start });
  return parts;
}

function parseBlock(file, text, from, to, conditions, rules, order) {
  let index = from;
  while (index < to) {
    const open = text.indexOf('{', index);
    const semicolon = text.indexOf(';', index);
    const prelude = text.slice(index, open === -1 ? to : open).trim();
    if (prelude === '' && (open === -1 || open >= to)) break;
    if (prelude.startsWith('@') && semicolon !== -1 && (open === -1 || semicolon < open)) { index = semicolon + 1; continue; }
    if (open === -1 || open >= to) break;
    const close = matching(text, open);
    if (prelude.startsWith('@media') || prelude.startsWith('@container') || prelude.startsWith('@supports')) {
      parseBlock(file, text, open + 1, close, [...conditions, prelude.replace(/\s+/g, ' ')], rules, order);
    } else if (!prelude.startsWith('@')) {
      const body = text.slice(open + 1, close);
      const declarations = splitTop(body, ';').map(({ text: part, at }) => {
        const colon = part.indexOf(':');
        if (colon === -1 || part.trim() === '') return null;
        let value = part.slice(colon + 1).trim();
        const important = /!important\s*$/.test(value);
        if (important) value = value.replace(/!important\s*$/, '').trim();
        return { property: part.slice(0, colon).trim().toLowerCase(), value, important, line: lineAt(text, open + 1 + at + colon) };
      }).filter((declaration) => declaration !== null);
      rules.push({
        file, line: lineAt(text, index + (text.slice(index, open).length - text.slice(index, open).trimStart().length)),
        selectors: splitTop(prelude, ',').map(({ text: selector }) => selector.trim().replace(/\s+/g, ' ')),
        conditions, declarations, order: order.next++,
      });
    }
    index = close + 1;
  }
}

/** Every rule of every slice, in cascade order. */
export function stylesheetRules() {
  const rules = [];
  const order = { next: 0 };
  for (const name of sliceNames) {
    const text = withoutComments(sliceText(name));
    parseBlock(name, text, 0, text.length, [], rules, order);
  }
  return rules;
}
