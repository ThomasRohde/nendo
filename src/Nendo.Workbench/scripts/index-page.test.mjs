import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// index.html is static markup no SSR test reaches, so it is read here as text.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// A name on an element that cannot carry one -- a div with no role, or a footer inside main,
// which is generic -- is dropped by assistive technology. Every aria-label in the page has to sit on an element that takes a name.
const namedByTag = new Set(['a', 'aside', 'button', 'dialog', 'form', 'img', 'input', 'main', 'nav', 'section', 'select', 'summary', 'textarea']);
const unnamedRoles = new Set(['generic', 'presentation', 'none']);

test('every aria-label in index.html is on an element that takes a name', () => {
  const labelled = [...html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\saria-label="([^"]*)"[^>]*)>/g)];
  assert.ok(labelled.length >= 15, `read ${labelled.length} labelled elements; the scan reads nothing`);
  const dropped = labelled.filter(([, tag, attributes]) => {
    const role = /\srole="([^"]+)"/.exec(attributes)?.[1] ?? null;
    return role === null ? !namedByTag.has(tag) : unnamedRoles.has(role);
  }).map(([, tag, , label]) => `<${tag}> "${label}"`);
  assert.deepEqual(dropped, [], 'these names are never announced: the element they are on takes no name');
});

// The module that themes the page runs only after the whole bundle has loaded, so a page that
// starts as data-theme="light" paints a dark window light first. A classic script in the head
// sets the theme before the body paints.
test('the head themes the page before the first paint, with nothing hard-coded light', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.doesNotMatch(html.slice(0, html.indexOf('>', html.indexOf('<html'))), /data-theme="/, 'the document is hard-coded to one theme');
  const boot = /<script src="\/theme-boot\.js"><\/script>/.exec(head);
  assert.notEqual(boot, null, 'the head has no script that themes the page before the first paint');
  assert.ok(!/<link[^>]+stylesheet|<script[^>]+type="module"/.test(head.slice(0, boot.index)), 'something loads ahead of the theme');
});

function boot({ stored, dark, refuses = false }) {
  const attributes = {};
  const window = {
    localStorage: { getItem: (key) => { if (refuses) throw new Error('refused'); return key === 'nendo.appearance' ? stored : null; } },
    matchMedia: (query) => ({ matches: query === '(prefers-color-scheme: dark)' && dark }),
  };
  const document = { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } };
  vm.runInNewContext(readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8'), { window, document });
  return attributes;
}

test('the boot script themes the page as the window will', () => {
  assert.equal(boot({ stored: null, dark: true })['data-theme'], 'dark', 'Windows in dark mode paints light first');
  assert.equal(boot({ stored: null, dark: false })['data-theme'], 'light');
  assert.equal(boot({ stored: 'dark', dark: false })['data-theme'], 'dark', 'the Dark override paints light first');
  assert.equal(boot({ stored: 'light', dark: true })['data-theme'], 'light');
  assert.equal(boot({ stored: 'system', dark: true })['data-theme-preference'], 'system');
  assert.equal(boot({ stored: null, dark: true, refuses: true })['data-theme'], 'dark', 'storage that refuses leaves the page light in dark mode');
});
