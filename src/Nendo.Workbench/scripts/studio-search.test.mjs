import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Studio's search box waits for two letters, as the command palette and the @ menu do: one
// letter is a prefix of most of the index and about twenty times the work of two. The
// real studio-search.ts runs here against a stand-in box, and the requests it sends are counted.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [] };
globalThis.studioSearchHost = host;
const stubs = {
  './client': `export const client = { request: async (method, payload) => {
    globalThis.studioSearchHost.calls.push({ method, payload }); return { items: [], nextCursor: null }; } };`,
  './actions': 'export const buildSearchIndex = async () => {};',
  './app-state': `export const fileScopedClearable = (value) => value;
    export const state = { session: { capabilities: { mutate: true } } };`,
  './extension-ui': 'export const openRecordFromView = async () => {};',
  './format': `export const escapeAttribute = (value) => String(value); export const escapeHtml = (value) => String(value);
    export const messageFor = (error) => String(error);`,
  './host-types': 'export class WorkbenchHostError extends Error {}',
  './search-text': 'export const highlightedSnippet = (text) => text;',
  './shell': 'export const showError = () => {};',
};
const entry = `export { wireStudioSearch } from ${JSON.stringify(resolve(root, 'src/studio-search.ts'))};`;
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'studio-search-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('studio-search-entry')) return '\0studio-search-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0studio-search-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'studio-search-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const search = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

function box() {
  const listeners = {};
  return {
    value: '', isConnected: true, listeners,
    addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
    type(value) { this.value = value; for (const listener of listeners.input ?? []) listener(); },
    enter() { for (const listener of listeners.keydown ?? []) listener({ key: 'Enter', preventDefault() {} }); },
  };
}

const settle = () => new Promise((done) => setTimeout(done, 260));

test('Studio search waits for two letters, as the palette and the @ menu do', async () => {
  const input = box();
  const results = { innerHTML: '', hidden: true, querySelectorAll: () => [], querySelector: () => null };
  globalThis.document = { querySelector: (selector) => selector === '#studio-search' ? input : selector === '#studio-search-results' ? results : null };
  search.wireStudioSearch({ entityId: 'tasks', displayName: 'Tasks', fields: [] });

  input.type('a');
  await settle();
  input.enter();
  await settle();
  const searches = () => host.calls.filter((call) => call.method === 'data.searchRecords');
  assert.equal(searches().length, 0, `one letter sent ${searches().length} searches: ${JSON.stringify(searches())}`);
  assert.match(results.innerHTML, /at least two letters/, 'below the minimum the box says what it waits for');
  assert.equal(results.hidden, false);

  input.type('ab');
  await settle();
  assert.equal(searches().length, 1, 'two letters search');
  assert.equal(searches()[0].payload.text, 'ab');
});
