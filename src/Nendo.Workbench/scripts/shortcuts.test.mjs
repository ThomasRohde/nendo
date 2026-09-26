import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'vite';

// The keys the window answers to and how the command palette orders what was typed
// (W-067). What a key presses is main.ts's wiring over controls that already exist; what
// is held here is the table, the matcher and the ranking, which are pure.
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/shortcuts.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { shortcuts, shortcut, matchShortcut, rankCommands, shortcutsShownFrom, shortcutsStorageKey } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

const key = (value, modifiers = {}) => ({ key: value, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });

test('each shortcut in the table is one key, and the matcher answers every one it owns', () => {
  const ids = shortcuts.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(shortcuts.map(entry => entry.keys)).size, shortcuts.length);
  assert.equal(matchShortcut(key('k', { ctrlKey: true })), 'palette');
  assert.equal(matchShortcut(key('K', { ctrlKey: true })), 'palette');
  assert.equal(matchShortcut(key('b', { ctrlKey: true })), 'rail');
  assert.equal(matchShortcut(key('/', { ctrlKey: true })), 'hints');
  assert.equal(matchShortcut(key('f', { altKey: true })), 'file');
  assert.equal(matchShortcut(key('F1')), 'help');
  const routes = ['use', 'data', 'structure', 'surfaces', 'history', 'health', 'agent'];
  routes.forEach((id, index) => {
    assert.equal(matchShortcut(key(String(index + 1), { ctrlKey: true })), id);
    assert.equal(shortcut(id).keys, `Ctrl ${index + 1}`);
  });
});

test('a key with a modifier the table does not name is somebody else’s', () => {
  assert.equal(matchShortcut(key('k')), null, 'a bare letter types');
  assert.equal(matchShortcut(key('k', { ctrlKey: true, shiftKey: true })), null);
  assert.equal(matchShortcut(key('k', { ctrlKey: true, altKey: true })), null);
  assert.equal(matchShortcut(key('k', { metaKey: true, ctrlKey: true })), null);
  assert.equal(matchShortcut(key('8', { ctrlKey: true })), null);
  assert.equal(matchShortcut(key('F1', { shiftKey: true })), null);
  assert.equal(matchShortcut(key('f')), null);
  // Back and Forward stay where they were answered before the table existed.
  assert.equal(matchShortcut(key('ArrowLeft', { altKey: true })), null);
});

const commands = [
  { id: 'use', label: 'Use', group: 'Go to' },
  { id: 'structure', label: 'Structure', group: 'Go to' },
  { id: 'history', label: 'History', group: 'Go to' },
  { id: 'system', label: 'System theme', group: 'Appearance' },
  { id: 'backup', label: 'Create backup…', group: 'File' },
  { id: 'export', label: 'Export CSV…', group: 'File' },
].map(command => ({ ...command, run: () => {} }));
const ids = ranked => ranked.map(entry => entry.command.id);

test('the palette finds letters in order, puts a word start first, and marks what matched', () => {
  assert.deepEqual(ids(rankCommands('', commands)), commands.map(command => command.id));
  const stru = rankCommands('stru', commands);
  assert.deepEqual(ids(stru), ['structure']);
  assert.deepEqual(stru[0].matched, [0, 1, 2, 3]);
  // "st" is in Structure and System theme at a word start, and in History mid-word.
  const st = ids(rankCommands('st', commands));
  assert.ok(st.indexOf('structure') < st.indexOf('history'));
  assert.ok(st.indexOf('system') < st.indexOf('history'));
  assert.deepEqual(ids(rankCommands('ST', commands)), st, 'case does not matter');
  assert.deepEqual(ids(rankCommands('create b', commands)), ['backup'], 'spaces in the query are ignored');
  assert.deepEqual(ids(rankCommands('zz', commands)), []);
});

test('a group name finds the whole group', () => {
  assert.deepEqual(ids(rankCommands('file', commands)), ['backup', 'export']);
});

test('the hints are off unless the person turned them on, and live under their own key', () => {
  assert.equal(shortcutsStorageKey, 'nendo.shortcuts');
  assert.equal(shortcutsShownFrom(null), false);
  assert.equal(shortcutsShownFrom('hidden'), false);
  assert.equal(shortcutsShownFrom('something else'), false);
  assert.equal(shortcutsShownFrom('shown'), true);
});

test('the frame carries the palette, the toggle, and a hint on every route with a key', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<dialog id="command-palette"/);
  assert.match(html, /id="command-palette-input"[^>]*role="combobox"/);
  assert.match(html, /id="shortcuts-toggle"[^>]*aria-pressed="false"/);
  for (const [nav, keys] of [['use', 'Ctrl 1'], ['data', 'Ctrl 2'], ['structure', 'Ctrl 3'], ['surfaces', 'Ctrl 4'],
    ['history', 'Ctrl 5'], ['health', 'Ctrl 6'], ['agent', 'Ctrl 7'], ['help', 'F1']]) {
    const start = html.indexOf(`id="nav-${nav}"`);
    const button = html.slice(start, html.indexOf('</button>', start));
    assert.ok(button.includes(`<kbd class="kbd-hint" aria-hidden="true">${keys}</kbd>`), `nav-${nav} carries ${keys}`);
    assert.equal(shortcut(nav).keys, keys);
  }
  const css = await readFile(new URL('../src/styles/16-command-palette.css', import.meta.url), 'utf8');
  // Hidden by default and shown only by the root flag.
  assert.match(css, /\.kbd-hint \{\s*display: none;/);
  assert.match(css, /:root\[data-shortcuts="shown"\] \.kbd-hint \{\s*display: inline-flex;/);
});
