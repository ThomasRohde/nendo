import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// W-172: the refresh after a write rebuilt the screen's window from its declared clauses alone,
// so a board narrowed by Filter showed every record again as soon as a card was dragged (found
// in the preview on 2026-10-05). The real actions.ts runs here against a stand-in host that
// records each read; the refresh must read the screen under the pick, as it opened.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], redraws: 0, errors: [], reply: null };
globalThis.quickRefreshHost = host;
const stubs = {
  './client': 'export const client = { mode: "desktop", request: async (method, payload) => { const h = globalThis.quickRefreshHost; h.calls.push({ method, payload }); return h.reply(method, payload); } };',
  './shell': `const h = () => globalThis.quickRefreshHost;
    export const content = { querySelectorAll: () => [], querySelector: () => null };
    export const interactionInProgress = () => false; export const rerender = () => { h().redraws += 1; };
    export const setBusy = () => {}; export const showError = (text) => { h().errors.push(text); };
    export const announce = () => {}; export const clearError = () => {}; export const refreshChrome = () => {};
    export const showRetainedNotice = () => {}; export const requiredElement = () => ({ hidden: true, textContent: '' });
    export const focusWithoutInteraction = () => {};`,
  './panels': `export const drillInto = async () => {}; export const drillIntoCell = async () => {}; export const refreshOverview = async () => {};
    export const refreshVisibleTiles = async () => {}; export const wireCharts = () => {}; export const wireSummaryRetry = () => {};
    export const matrixPending = () => false; export const patchCharts = () => {};
    export const wireChartTables = () => {}; export const drillGroupOf = () => null;`,
  './view-packages': 'export const openCustomViews = async () => {};',
};
const entry = [
  `export { refreshDerived } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { state, emptySession, quickFilters, selectedSurfaces } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'quick-refresh-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('quick-refresh-entry')) return '\0quick-refresh-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0quick-refresh-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'quick-refresh-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const status = { semanticId: 'status', automationTarget: 'status', storageKind: 0, displayName: 'Status', required: false, retired: false, presentation: 'singleChoice', options: ['open', 'done'] };
const board = { semanticId: 'board', automationTarget: 'board', kind: 'boardSurface', properties: { entityId: 'tasks', groupByFieldId: 'status' }, children: [] };
const plan = { entity: { semanticId: 'tasks', displayName: 'Tasks', fields: [status], derivedFields: [] }, surfaces: [board], records: [] };
const definition = { isValid: true, sourceChangeSequence: 1, applications: [plan], overview: null };

test('the refresh after a write reads a narrowed screen under its pick', async () => {
  const empty = p.emptySession();
  p.state.session = {
    ...empty, fileSessionId: 'file-A', fileName: 'Fixture.nendo', hasFile: true,
    capabilities: { ...empty.capabilities, readData: true, customSurfaces: true, mutate: true },
    manifest: { changeSequence: 1 }, entities: [{ entityId: 'tasks', displayName: 'Tasks', fields: [], retired: false }],
  };
  p.state.compilation = definition;
  p.state.showOverview = false;
  p.state.selectedApplicationEntity = 'tasks';
  p.selectedSurfaces.set('tasks', 'board');
  p.quickFilters.set('board', { fieldId: 'status', value: 'open', label: 'Status: Open' });
  host.calls = [];
  host.reply = (method) => {
    if (method === 'semantic.compile') return definition;
    if (method === 'agent.getStatus') return {};
    if (method === 'data.queryRecords') return { items: [], nextCursor: null, changeSequence: 1 };
    throw new Error(`Unexpected ${method}`);
  };
  await p.refreshDerived();
  const reads = host.calls.filter(call => call.method === 'data.queryRecords' && call.payload.filters.length > 0);
  assert.deepEqual(reads.map(call => call.payload.filters), [[{ fieldId: 'status', operator: 'eq', value: 'open' }]],
    'The board was read again without its Filter pick.');
});
