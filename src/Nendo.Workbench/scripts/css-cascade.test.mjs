import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pageSources, sliceNames, sliceText, stylesheetIndex, stylesheetRules } from './css-slices.mjs';

// The stylesheet's slices read as one cascade, and a cascade can say things the page never does.
// These hold the slices to what the page emits and draws.
const rules = stylesheetRules();
const sources = pageSources();
const repository = new URL('../../../', import.meta.url);

// Rules for classes no source emits linger unless something says so.
test('every class a stylesheet styles is one the page can emit', () => {
  const classes = new Set(rules.flatMap((rule) => rule.selectors.flatMap((selector) => [...selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))));
  const named = (name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(sources);
  // A class built in a template, as class="diff-${line.kind}" or `is-${status}` in a class list,
  // is named by its prefix, but only where a class is written: a key such as `view-${id}` names
  // no class.
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const built = (name) => [...name.matchAll(/-/g)].some((match) => new RegExp(
    `(class="[^"]*|className\\s*\\+?=\\s*[^;\\n]*|classList\\.\\w+\\([^)]*)(?<![\\w-])${escape(name.slice(0, match.index + 1))}\\$\\{`).test(sources));
  // AG Grid draws its own DOM, and these are its class names.
  const grid = (name) => name.startsWith('ag-');
  // The Markdown editor's ProseMirror draws these in its own DOM, as AG Grid draws its own.
  const editor = (name) => name.startsWith('ProseMirror-') || name === 'tableWrapper';
  const unemitted = [...classes].filter((name) => !named(name) && !built(name) && !grid(name) && !editor(name)).sort();
  assert.deepEqual(unemitted, [], 'The stylesheet styles classes that no .ts source or index.html emits, so those rules are dead');
});

// Narrow-window rules a later rule with the same selector always beat: a maintainer edits
// them and nothing changes on screen, which is how the compact-rail and recovery defects survived.
const longhands = {
  padding: /^padding-/, margin: /^margin-/, border: /^border-(?!radius|collapse|spacing)/, overflow: /^overflow-[xy]$/,
  background: /^background-/, inset: /^(top|right|bottom|left)$/, gap: /^(row|column)-gap$/, font: /^(font-|line-height$)/,
  flex: /^flex-(grow|shrink|basis)$/, 'grid-template': /^grid-template-/, 'place-items': /^(align|justify)-items$/,
  'border-radius': /^border-.*-radius$/, outline: /^outline-(?!offset)/,
};
const beats = (later, earlier) => later === earlier || (longhands[later]?.test(earlier) ?? false);

test('no declaration under a media or container query is always beaten by a later rule for the same selector', () => {
  const shadowed = [];
  for (const rule of rules.filter((candidate) => candidate.conditions.length > 0)) {
    for (const selector of rule.selectors) {
      for (const declaration of rule.declarations.filter((candidate) => !candidate.important)) {
        const later = rules.find((other) => other.order > rule.order && other.conditions.length === 0 && other.selectors.includes(selector)
          && other.declarations.some((candidate) => beats(candidate.property, declaration.property)));
        if (later !== undefined) shadowed.push(`${rule.file}:${declaration.line} ${selector} { ${declaration.property} } under ${rule.conditions.join(' ')}, beaten by ${later.file}:${later.line}`);
      }
    }
  }
  assert.deepEqual(shadowed, [], 'A conditional declaration can never win, because a later unconditional rule sets the same property for the same selector');
});

// The Mica radius scale and the stylesheet's own colour tokens, not literals.
const onRoot = (rule) => rule.selectors.every((selector) => /^:root(\[[^\]]+\])?$/.test(selector));

test('every corner radius is a token or one of the small fixed marks', () => {
  const literals = [];
  for (const rule of rules.filter((candidate) => !onRoot(candidate))) {
    for (const declaration of rule.declarations.filter((candidate) => /radius$/.test(candidate.property) && !candidate.property.startsWith('--'))) {
      const off = declaration.value.split(/\s+/).filter((part) => !/^(0|2px|3px|50%|999px|inherit|var\(--radius-[\w-]+\))$/.test(part));
      if (off.length > 0) literals.push(`${rule.file}:${declaration.line} ${rule.selectors[0]} ${declaration.property}: ${declaration.value}`);
    }
  }
  assert.deepEqual(literals, [], 'A corner radius is written as a literal instead of a --radius-* token (21-native.css, mica-direction.md)');
});

test('no rule writes a colour itself; colours are tokens declared on :root', () => {
  const literals = [];
  for (const rule of rules.filter((candidate) => !onRoot(candidate))) {
    for (const declaration of rule.declarations.filter((candidate) => !candidate.property.startsWith('--'))) {
      // A mask is drawn by its alpha alone: black there is "show", not a colour anyone sees.
      if (/mask-image$/.test(declaration.property)) continue;
      const found = declaration.value.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black)\b/g);
      if (found !== null) literals.push(`${rule.file}:${declaration.line} ${rule.selectors[0]} ${declaration.property}: ${declaration.value}`);
    }
  }
  assert.deepEqual(literals, [], 'A rule writes a colour literal instead of a token, so it cannot follow the theme');
});

// Text below 0.75rem only where mica-direction.md says so. The doc's list, by selector:
// key caps, the Activity card's count, the Agent page's launch command and
// its renamed note, and the conversation's tags, context line, option names, @ menu and the line
// under the box.
const smallLabels = new Set([
  '.status-keys kbd', '.agent-tab-count', '.launch-command-line', '.launch-renamed code',
  '.chat-you-context', '.chat-tag', '.chat-option-name', '.chat-under',
  '.mention-head', '.mention-detail', '.mention-keys', '.mention-keys kbd',
]);

test('text below 0.75rem is only the small labels mica-direction.md lists', () => {
  const small = [];
  for (const rule of rules) {
    for (const declaration of rule.declarations.filter((candidate) => candidate.property === 'font-size')) {
      const size = declaration.value.match(/^([\d.]+)(rem|px)$/);
      if (size === null) continue;
      const pixels = size[2] === 'px' ? Number(size[1]) : Number(size[1]) * 14;
      if (pixels >= 10.5) continue;
      const off = rule.selectors.filter((selector) => !smallLabels.has(selector));
      if (off.length > 0) small.push(`${rule.file}:${declaration.line} ${off.join(', ')} ${declaration.value}`);
    }
  }
  assert.deepEqual(small, [], 'Text is set below 0.75rem outside the small labels mica-direction.md allows');
  const doc = readFileSync(new URL('docs/design/mica-direction.md', repository), 'utf8');
  for (const label of ['key caps', 'launch command', '@ menu', 'line under the box']) {
    assert.ok(doc.includes(label), `mica-direction.md no longer lists ${label} among the small labels this test allows`);
  }
});

// The slices' comments say where they load and what the page allows; a contributor who
// trusted '15 loads last' put a narrow-window rule where 21-native.css silently beat it.
test('each slice names its own place in the load order, and only the last claims to load last', () => {
  const wrong = [];
  sliceNames.forEach((name, index) => {
    const text = sliceText(name);
    const slice = text.match(/Slice (\d+) of styles\.css/);
    if (slice !== null && Number(slice[1]) !== index + 1) wrong.push(`${name} says it is slice ${slice[1]}, but styles.css imports it ${index + 1}th`);
    if (index < sliceNames.length - 1 && /loads last|comes last/i.test(text)) wrong.push(`${name} claims to load last, but ${sliceNames.at(-1)} loads after it`);
  });
  const policy = readFileSync(new URL('../index.html', import.meta.url), 'utf8').match(/style-src ([^;"]+)/)[1].trim();
  const claimed = stylesheetIndex.match(/style-src ('[^']*'(?:\s+'[^']*')*)/);
  if (claimed !== null && claimed[1].trim() !== policy) wrong.push(`styles.css says the page's policy is style-src ${claimed[1]}, but index.html has style-src ${policy}`);
  const comment = (name, pattern) => pattern.test(sliceText(name));
  if (comment('20-title-bar.css', /more than 600px tall/)) wrong.push('20-title-bar.css still says the rail runs down the side in a short narrow window');
  assert.deepEqual(wrong, [], 'A slice comment describes a cascade the code no longer has');
});

test('mica-direction.md gives the control heights the stylesheet uses', () => {
  const doc = readFileSync(new URL('docs/design/mica-direction.md', repository), 'utf8');
  const field = rules.find((rule) => rule.selectors.includes('input') && rule.selectors.includes('select') && rule.conditions.length === 0
    && rule.declarations.some((declaration) => declaration.property === 'min-height'));
  const height = field.declarations.find((declaration) => declaration.property === 'min-height').value;
  const stated = doc.match(/text fields and selects are (\d+px)/);
  assert.ok(stated !== null && stated[1] === height, `mica-direction.md says text fields and selects are ${stated?.[1] ?? 'nothing'}, but 10-forms.css draws them at ${height}`);
});
