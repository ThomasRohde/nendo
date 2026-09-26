import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// R-013: a front-page row whose record is not in the first page its record type's surface
// loads opened the type and not the record. The real view-overview.ts, actions.ts
// (refreshDerived) and reads.ts run here against a stand-in host holding 100 records, of
// which the surface's first window returns 50; only the page and the charts are stand-ins.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], redraws: 0, errors: [], reply: null };
globalThis.overviewOpenHost = host;
const stubs = {
  './client': 'export const client = { mode: "desktop", request: async (method, payload) => { const h = globalThis.overviewOpenHost; h.calls.push({ method, payload }); return h.reply(method, payload); } };',
  './shell': `const h = () => globalThis.overviewOpenHost;
    export const content = { querySelectorAll: () => [], querySelector: () => null };
    export const interactionInProgress = () => false; export const rerender = () => { h().redraws += 1; };
    export const setBusy = () => {}; export const showError = (text) => { h().errors.push(text); };
    export const announce = () => {}; export const clearError = () => {}; export const refreshChrome = () => {};
    export const showRetainedNotice = () => {}; export const requiredElement = () => ({ hidden: true, textContent: '' });`,
  './panels': `export const drillInto = async () => {}; export const drillIntoCell = async () => {}; export const refreshOverview = async () => {};
    export const refreshVisibleTiles = async () => {}; export const wireCharts = () => {}; export const wireSummaryRetry = () => {};
    export const matrixPending = () => false; export const patchCharts = () => {};`,
  './view-packages': 'export const openCustomViews = async () => {};',
};
const entry = [
  `export { openOverviewRecord } from ${JSON.stringify(resolve(root, 'src/view-overview.ts'))};`,
  `export { state, emptySession, focusedRecords } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'overview-open-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('overview-open-entry')) return '\0overview-open-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0overview-open-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'overview-open-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const field = { semanticId: 'title', automationTarget: 'title', storageKind: 0, displayName: 'Title', required: false, retired: false, presentation: null, options: [] };
const list = { semanticId: 'list', automationTarget: 'list', kind: 'listSurface', properties: { entityId: 'tasks' }, children: [] };
const plan = { entity: { semanticId: 'tasks', displayName: 'Tasks', fields: [field], derivedFields: [] }, surfaces: [list], records: [] };
const definition = { isValid: true, sourceChangeSequence: 1, applications: [plan], overview: null };
// 100 records. The surface lists them by title, so its first window of 50 holds record-0 to
// record-49; the front page ranks them another way and shows record-99 at the top.
const stored = Array.from({ length: 100 }, (_, index) => ({ entityId: 'tasks', recordId: `record-${index}`, recordVersion: 1, values: { title: `Task ${String(index).padStart(3, '0')}` } }));

function openFile({ deleted = [] } = {}) {
  Object.assign(host, { calls: [], redraws: 0, errors: [] });
  p.focusedRecords.clear();
  const empty = p.emptySession();
  p.state.session = {
    ...empty, fileSessionId: 'file-A', fileName: 'Fixture.nendo', hasFile: true,
    capabilities: { ...empty.capabilities, readData: true, customSurfaces: true, mutate: true },
    manifest: { changeSequence: 1 }, entities: [{ entityId: 'tasks', displayName: 'Tasks', fields: [], retired: false }],
  };
  p.state.compilation = definition;
  p.state.showOverview = true;
  p.state.selectedApplicationEntity = null;
  p.state.selectedRecordId = null;
  p.state.actionInFlight = false;
  p.state.view = 'use';
  const present = stored.filter((record) => !deleted.includes(record.recordId));
  host.reply = (method, payload) => {
    if (method === 'semantic.compile') return definition;
    if (method === 'agent.getStatus') return {};
    if (method === 'data.queryRecords') {
      const items = payload.recordId === undefined ? present.slice(0, payload.limit ?? 50) : present.filter((record) => record.recordId === payload.recordId);
      return { items, nextCursor: payload.recordId === undefined ? 'next-page' : null, changeSequence: 1 };
    }
    throw new Error(`Unexpected ${method}`);
  };
}

test('a front-page row outside the surface’s first 50 records opens that record, read by its own ID', async () => {
  openFile();
  await p.openOverviewRecord('tasks', 'record-99');
  assert.equal(p.state.selectedRecordId, 'record-99', 'The record type opened and the clicked record did not.');
  assert.ok(host.calls.some((call) => call.method === 'data.queryRecords' && call.payload.recordId === 'record-99'),
    'The record was never read by its ID.');
  assert.equal(p.focusedRecords.get('record-99')?.semanticId, 'record-99');
  assert.equal(p.state.showOverview, false);
  assert.equal(p.state.selectedApplicationEntity, 'tasks');
  assert.deepEqual(host.errors, []);
  assert.equal(host.redraws, 1);
});

test('a front-page row whose record has gone says so and stays on the front page', async () => {
  openFile({ deleted: ['record-99'] });
  await p.openOverviewRecord('tasks', 'record-99');
  assert.equal(p.state.selectedRecordId, null);
  assert.equal(p.state.showOverview, true, 'The front page was left for a record that is not there.');
  assert.equal(host.errors.length, 1);
  assert.match(host.errors[0], /no longer there/);
});

test('a row inside the first window still opens, read by ID all the same', async () => {
  openFile();
  await p.openOverviewRecord('tasks', 'record-3');
  assert.equal(p.state.selectedRecordId, 'record-3');
});
