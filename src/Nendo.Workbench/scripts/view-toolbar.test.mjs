import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// A custom view's controls in Nendo's own chrome (ADR-0013, 2026-09-28; W-090), through the
// real modules: the declaration as the broker rebuilds it, the markup the page draws from it,
// what Ctrl K lists, which keys run what, and the key table kept in step with Nendo's own.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const model = await bundleOf('src/view-toolbar-model.ts');
const markup = await bundleOf('src/view-toolbar-markup.ts');
const protocol = await bundleOf('src/extension-api/protocol.ts');
const shortcuts = await bundleOf('src/shortcuts.ts');

const toolbar = model.readToolbar({
  items: [
    { kind: 'choice', id: 'mode', label: 'Mode', hideLabel: true, value: 'map', options: [{ value: 'map', label: 'Map' }, { value: 'outline', label: 'Outline <i>' }] },
    { kind: 'button', id: 'raw', label: '<img src=x onerror=alert(1)>' },
    { kind: 'choice', id: 'levels', label: 'Levels', value: '2', options: ['1', '2', '3', 'All'].map((level) => ({ value: level, label: level })) },
    { kind: 'select', id: 'colour', label: 'Colour <b>', value: 'maturity', options: [{ value: 'maturity', label: 'Maturity' }, { value: 'gap', label: 'Maturity & gap' }] },
    { kind: 'spacer' },
    { kind: 'search', id: 'find', label: 'Find a capability', placeholder: 'Find a capability…', keys: 'Ctrl+F', value: '"quoted"' },
    { kind: 'separator' },
    { kind: 'toggle', id: 'pan', label: 'Pan', icon: 'pan', iconOnly: true, pressed: true },
    { kind: 'group', label: 'Zoom', items: [
      { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
      { kind: 'button', id: 'fit', label: 'Fit', keys: 'Ctrl+0' },
      { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus', disabled: true },
    ] },
    { kind: 'text', text: '115%', mono: true },
    { kind: 'menu', id: 'export', label: 'Export', icon: 'export', items: [
      { id: 'export-svg', label: 'SVG, to edit', detail: 'Plain <shapes> and text', keys: 'Ctrl+Shift+E' },
      { id: 'export-png', label: 'PNG <u>for a slide</u>' },
      { kind: 'separator' },
      { kind: 'label', label: 'Layout' },
      { kind: 'radio', id: 'layout', value: 'compact', label: 'Reference · compact', checked: true },
      { kind: 'radio', id: 'layout', value: 'ordered', label: 'Reference · ordered' },
      { kind: 'check', id: 'light', label: 'Light colours for print', checked: false },
    ] },
  ],
  add: 'add-capability',
});

test('G27: the strip is Nendo’s own controls, and every word a view sends lands as text', () => {
  const html = markup.viewToolbarMarkup(toolbar, { title: 'Capability <map>', compact: false, prefix: 'vt-1' });
  assert.match(html, /^<div class="view-toolbar" role="toolbar" aria-label="Capability &lt;map&gt;" data-view-toolbar>/);
  // The view switcher's own segmented control, pressed as Nendo presses it.
  assert.match(html, /<div class="view-switcher view-toolbar-choice" role="group" aria-label="Mode"><button type="button" aria-pressed="true" data-view-command="mode" data-view-value="map">Map<\/button><button type="button" aria-pressed="false" data-view-command="mode" data-view-value="outline">Outline &lt;i&gt;<\/button><\/div>/);
  assert.match(html, /data-view-command="raw" title="&lt;img src=x onerror=alert\(1\)&gt;"><span>&lt;img src=x onerror=alert\(1\)&gt;<\/span><\/button>/, 'A button’s label was not escaped where it lands.');
  // Short options make the tight segments, with the visible label tied to the group.
  assert.match(html, /<span class="view-toolbar-field"><span class="view-toolbar-label" id="vt-1-levels-label">Levels<\/span><div class="view-switcher view-toolbar-choice is-tight" role="group" aria-labelledby="vt-1-levels-label">/);
  // The labelled select every other Nendo toolbar uses; the words escaped where they land.
  assert.match(html, /<label class="select-field view-toolbar-select">Colour &lt;b&gt;<select data-view-command="colour"><option value="maturity" selected>Maturity<\/option><option value="gap">Maturity &amp; gap<\/option><\/select><\/label>/);
  assert.match(html, /<input type="search"[^>]* data-view-command="find" data-view-search value="&quot;quoted&quot;" placeholder="Find a capability…" aria-keyshortcuts="Control\+F">/);
  assert.match(html, /<kbd class="kbd-hint" aria-hidden="true">Ctrl F<\/kbd>/);
  assert.match(html, /<button type="button" class="view-toolbar-button is-icon" data-view-command="pan" aria-pressed="true" aria-label="Pan" title="Pan"><svg class="outline-icon"/);
  assert.match(html, /<div class="view-toolbar-joined" role="group" aria-label="Zoom">/);
  assert.match(html, /data-view-command="zoom-in" aria-label="Zoom in" aria-keyshortcuts="Control\+Plus" title="Zoom in \(Ctrl \+\)" disabled>/);
  assert.match(html, /<span class="view-toolbar-text is-mono">115%<\/span>/);
  assert.match(html, /<button type="button" class="view-toolbar-button" data-view-menu="export" aria-haspopup="menu" aria-expanded="false" title="Export">/);
  assert.match(html, /<span class="toolbar-spacer" aria-hidden="true"><\/span>/);
  assert.match(html, /<span class="view-toolbar-separator" role="separator" aria-orientation="vertical"><\/span>/);
  assert.doesNotMatch(html, /<b>|<i>|<img|style=/, 'A view’s words became markup.');
  assert.doesNotMatch(html, /<iframe|<script|href=/);
  // On a record page the same controls sit in the panel's header, compact.
  assert.match(markup.viewToolbarMarkup(toolbar, { title: 'Map', compact: true, prefix: 'vt-2' }), /^<div class="view-toolbar is-compact"/);
  assert.equal(markup.viewToolbarMarkup({ items: [], add: 'x' }, { title: 'Map', compact: false, prefix: 'vt-3' }), '', 'An empty toolbar drew a strip.');
});

test('G27: a menu is Nendo’s menu: items in order, checks and radios marked, keys shown, words as text', () => {
  const menu = toolbar.items.find((item) => item.kind === 'menu');
  const html = markup.viewMenuMarkup(menu.items, 'Export <now>');
  assert.match(html, /^<div class="view-menu" role="menu" aria-label="Export &lt;now&gt;" data-view-menu-open>/);
  assert.match(html, /<button type="button" class="view-menu-item is-rich" role="menuitem" tabindex="-1" data-menu-index="0"><span class="view-menu-glyph"><\/span><span class="view-menu-text"><strong>SVG, to edit<\/strong><small>Plain &lt;shapes&gt; and text<\/small><\/span><kbd class="view-menu-keys">Ctrl Shift E<\/kbd><\/button>/);
  assert.match(html, /<div class="view-menu-separator" role="separator"><\/div><div class="view-menu-label" role="presentation">Layout<\/div>/);
  assert.match(html, /data-menu-index="1"><span class="view-menu-glyph"><\/span><span class="view-menu-text">PNG &lt;u&gt;for a slide&lt;\/u&gt;<\/span><\/button>/, 'A menu item’s label was not escaped.');
  assert.doesNotMatch(html, /<u>|<shapes>/, 'A menu item’s words became markup.');
  assert.match(html, /role="menuitemradio" aria-checked="true" tabindex="-1" data-menu-index="4"><span class="view-menu-glyph"><svg/);
  assert.match(html, /role="menuitemradio" aria-checked="false" tabindex="-1" data-menu-index="5"><span class="view-menu-glyph"><\/span>/);
  assert.match(html, /role="menuitemcheckbox" aria-checked="false" tabindex="-1" data-menu-index="6">/);
});

test('G28: Ctrl K lists each command once, an entry per option and item, what it sends, and leaves out what is disabled', () => {
  const entries = model.paletteEntries(toolbar).map(({ label, keys, id, value, focus }) => [label, keys, id, value, focus]);
  assert.deepEqual(entries, [
    ['Mode: Outline <i>', null, 'mode', 'outline', false],
    ['<img src=x onerror=alert(1)>', null, 'raw', null, false],
    ['Levels: 1', null, 'levels', '1', false],
    ['Levels: 3', null, 'levels', '3', false],
    ['Levels: All', null, 'levels', 'All', false],
    ['Colour <b>: Maturity & gap', null, 'colour', 'gap', false],
    ['Find a capability', 'Ctrl+F', 'find', null, true],
    ['Turn off Pan', null, 'pan', false, false],
    ['Zoom out', 'Ctrl+-', 'zoom-out', null, false],
    ['Fit', 'Ctrl+0', 'fit', null, false],
    ['Export: SVG, to edit', 'Ctrl+Shift+E', 'export-svg', null, false],
    ['Export: PNG <u>for a slide</u>', null, 'export-png', null, false],
    ['Export: Reference · ordered', null, 'layout', 'ordered', false],
    ['Export: Turn on Light colours for print', null, 'light', true, false],
  ]);
  assert.deepEqual(model.declaredKeys(toolbar).map(({ keys, id, value, focus }) => [keys, id, value, focus]), [
    ['Ctrl+F', 'find', null, true], ['Ctrl+-', 'zoom-out', null, false], ['Ctrl+0', 'fit', null, false], ['Ctrl+Shift+E', 'export-svg', null, false],
  ], 'A disabled control kept its key, or a key went to the wrong control.');
});

test('G28: a press shows at once, before the view answers: a toggle, a choice, a radio, a check, a search', () => {
  let after = model.afterCommand(toolbar, 'pan', false);
  after = model.afterCommand(after, 'levels', 'All');
  after = model.afterCommand(after, 'layout', 'ordered');
  after = model.afterCommand(after, 'light', true);
  after = model.afterCommand(after, 'find', 'custom');
  after = model.afterCommand(after, 'colour', 'no-such-option');
  const item = (id) => after.items.find((entry) => entry.id === id);
  assert.equal(item('pan').pressed, false);
  assert.equal(item('levels').value, 'All');
  assert.equal(item('colour').value, 'maturity', 'An option the select does not have was chosen.');
  assert.equal(item('find').value, 'custom');
  const menu = item('export').items;
  assert.deepEqual(menu.filter((entry) => entry.kind === 'radio').map((entry) => entry.checked), [false, true]);
  assert.equal(menu.find((entry) => entry.kind === 'check').checked, true);
  assert.equal(toolbar.items.find((entry) => entry.id === 'pan').pressed, true, 'The declaration itself was changed.');
});

test('G30: keys are one spelling: a key event and a declaration meet, a symbol ignores its Shift, and Nendo’s keys are the shortcut table’s', () => {
  const key = (keyName, modifiers = {}) => protocol.chordOf({ key: keyName, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });
  assert.equal(key('k', { ctrlKey: true }), 'Ctrl+K');
  assert.equal(key('F', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+F');
  assert.equal(key('+', { ctrlKey: true, shiftKey: true }), 'Ctrl+Plus', 'Ctrl and + on a keyboard where + needs Shift is not Ctrl+Plus.');
  assert.equal(key('+', { ctrlKey: true }), 'Ctrl+Plus');
  assert.equal(key('/', { ctrlKey: true, shiftKey: true }), 'Ctrl+/');
  assert.equal(key('ArrowLeft', { altKey: true }), 'Alt+ArrowLeft');
  assert.equal(key(' ', { ctrlKey: true }), 'Ctrl+Space');
  assert.equal(key('Control', { ctrlKey: true }), null);
  assert.equal(key('k', { metaKey: true }), null);
  for (const [written, normal] of [['ctrl+f', 'Ctrl+F'], ['Shift+Control+f', 'Ctrl+Shift+F'], ['Alt+arrowup', 'Alt+ArrowUp'], ['F2', 'F2'], ['Ctrl+Shift+=', 'Ctrl+='], ['Ctrl+Plus', 'Ctrl+Plus']])
    assert.equal(protocol.normalizeKeys(written), normal, written);
  for (const refused of ['Q', 'Shift+Q', 'Enter', 'F1', 'Ctrl++', 'Ctrl+Ctrl+K', 'Hyper+K', 'Ctrl+Escape', '', 42])
    assert.equal(protocol.normalizeKeys(refused), null, String(refused));
  // Nendo's own keys, as a view hands them back, are exactly the shortcut table's.
  assert.deepEqual([...protocol.hostKeys].sort(), shortcuts.shortcuts.map((entry) => entry.aria.replace(/^Control\+/, 'Ctrl+')).sort());
  for (const keys of protocol.hostKeys) assert.notEqual(shortcuts.shortcutForKeys(keys), null, keys);
  assert.equal(shortcuts.shortcutForKeys('Ctrl+K'), 'palette');
  assert.equal(shortcuts.shortcutForKeys('Alt+ArrowLeft'), 'back');
  assert.equal(shortcuts.shortcutForKeys('Ctrl+0'), null);
  assert.equal(markup.keyDisplay('Ctrl+Shift+ArrowUp'), 'Ctrl Shift ↑');
  assert.equal(markup.keyAria('Ctrl+Plus'), 'Control+Plus');
});
