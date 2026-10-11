import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// WDV-01: opening Filter on a screen with a reference field read its targets and redrew the
// menu open; Chromium fires toggle on a details inserted open, so each redraw read and redrew
// again, without end. The real quick-filter.ts runs here against a stand-in page that does
// what Chromium does: every redraw puts a fresh menu in, and one drawn open reports a toggle.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], redraws: 0, menu: null, redrawMenu: null };
globalThis.quickOpenHost = host;
const stubs = {
  './client': `export const client = { mode: 'desktop', request: async (method, payload) => {
    globalThis.quickOpenHost.calls.push({ method, payload }); return { items: [], nextCursor: null }; } };`,
  './shell': `const h = () => globalThis.quickOpenHost;
    export const content = {
      querySelector: (selector) => selector === '[data-testid="quick-filter"]' ? h().menu : null,
      querySelectorAll: () => [] };
    export const rerender = () => { h().redraws += 1; if (h().redraws < 60) h().redrawMenu(); };
    export const setBusy = () => {}; export const showError = () => {}; export const interactionInProgress = () => false;`,
  './draft-guard': 'export const refuseWhileDirty = () => false;',
  './reads': 'export const loadSurfaceWindow = async () => {};',
};
const entry = [
  `export { wireQuickFilter, quickFilterMenu } from ${JSON.stringify(resolve(root, 'src/quick-filter.ts'))};`,
  `export { quickFilterTargets } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'quick-open-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('quick-open-entry')) return '\0quick-open-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0quick-open-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'quick-open-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const q = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const owner = { semanticId: 'owner', automationTarget: 'owner', storageKind: 7, displayName: 'Owner', required: false, retired: false,
  presentation: 'singleLine', options: [], reference: { targetEntityId: 'people', labelFieldId: 'name' } };
const list = { semanticId: 'list', automationTarget: 'list', kind: 'recordList', properties: { entityId: 'tasks' }, children: [] };
const plan = { entity: { semanticId: 'tasks', displayName: 'Tasks', fields: [owner], derivedFields: [] }, surfaces: [list], records: [] };

function details(open) {
  const listeners = [];
  return {
    open, listeners,
    addEventListener(type, listener) { if (type === 'toggle') listeners.push(listener); },
    querySelector: () => ({ focus() {} }),
    toggle() { for (const listener of listeners) listener(); },
  };
}

test('opening Filter reads each reference target once, however the redraw reports itself', async () => {
  host.redrawMenu = () => {
    // The markup decides whether the new menu is open, exactly as the page draws it.
    const open = /<details[^>]*\sopen[\s>]/.test(q.quickFilterMenu(plan, list));
    host.menu = details(open);
    q.wireQuickFilter(plan, list);
    if (open) setTimeout(() => host.menu.toggle(), 0);
  };
  host.menu = details(false);
  q.wireQuickFilter(plan, list);

  host.menu.open = true;
  host.menu.toggle();
  for (let tick = 0; tick < 20; tick++) await new Promise(done => setTimeout(done, 5));

  const reads = host.calls.filter(call => call.method === 'data.queryRecords');
  assert.equal(reads.length, 1, `one read of the people the Owner field offers, not ${reads.length} (${host.redraws} redraws)`);
  assert.ok(host.redraws <= 2, `the loading state and the result are two redraws, not ${host.redraws}`);

  // Closing and opening again reads again, so a record added since is offered.
  host.menu.open = false;
  host.menu.toggle();
  host.menu.open = true;
  host.menu.toggle();
  for (let tick = 0; tick < 20; tick++) await new Promise(done => setTimeout(done, 5));
  assert.equal(host.calls.filter(call => call.method === 'data.queryRecords').length, 2, 'a second opening reads again');
});

test('a menu that comes back open with its targets forgotten reads them once', async () => {
  // The previous test left the menu open. Resetting the file view forgets the targets but not
  // that the menu was open, so the next draw puts it in open with nothing read.
  q.quickFilterTargets.clear();
  host.calls.length = 0;
  host.redraws = 0;
  host.redrawMenu();
  for (let tick = 0; tick < 20; tick++) await new Promise(done => setTimeout(done, 5));
  const reads = host.calls.filter(call => call.method === 'data.queryRecords');
  assert.equal(reads.length, 1, `the forgotten targets are read once, not ${reads.length} times`);
  assert.equal(q.quickFilterTargets.get('people')?.state, 'ready', 'and the menu offers them');
});
