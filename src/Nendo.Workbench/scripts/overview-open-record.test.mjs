import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// A front-page row whose record is not in the first page its record type's surface
// loads opens the record, not the type. The real view-overview.ts, actions.ts
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
    export const showRetainedNotice = () => {}; export const showKeptAlert = () => {}; export const showOutcome = () => {}; export const requiredElement = () => ({ hidden: true, textContent: '' });
    export const focusWithoutInteraction = () => {};`,
  './panels': `export const drillInto = async () => {}; export const drillIntoCell = async () => {}; export const refreshOverview = async () => {};
    export const refreshVisibleTiles = async () => {}; export const wireCharts = () => {}; export const wireSummaryRetry = () => {};
    export const matrixPending = () => false; export const patchCharts = () => {};
    export const wireChartTables = () => {}; export const drillGroupOf = () => null;`,
  './view-packages': 'export const openCustomViews = async () => {};',
};
const entry = [
  `export { drillPlan, openOverviewRecord, rankedRowsMarkup } from ${JSON.stringify(resolve(root, 'src/view-overview.ts'))};`,
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

// The numerals a ranking draws decide ties on the exact digits. The host orders
// 9007199254740993 above 9007199254740992, and comparing the JavaScript numbers the two
// lexemes round to would read both rows "ranked 1".
test('a ranking numbers two different exact values apart, and one value spelt two ways alike', () => {
  const entity = { semanticId: 'tasks', displayName: 'Tasks', fields: [field], derivedFields: [] };
  const row = (id, digits) => ({ semanticId: id, automationTarget: `record-${id}`, version: 1, values: { title: id, value: { $nendoNumber: digits } } });
  const numerals = (markup) => [...markup.matchAll(/<span class="ranked-numeral" aria-hidden="true">(\d+)<\/span>/g)].map(([, numeral]) => Number(numeral));
  const apart = p.rankedRowsMarkup(entity, [row('a', '9007199254740993'), row('b', '9007199254740992'), row('c', '7')], 'value', ['title'], 9007199254740993);
  assert.deepEqual(numerals(apart), [1, 2, 3], 'Two different exact values shared a rank numeral.');
  assert.match(apart, /aria-label="a, ranked 1, /);
  assert.match(apart, /aria-label="b, ranked 2, /);
  const alike = p.rankedRowsMarkup(entity, [row('a', '12.50'), row('b', '12.5'), row('c', '3')], 'value', ['title'], 12.5);
  assert.deepEqual(numerals(alike), [1, 1, 3]);
});

// A ranking by a calculated number reads each record's result, not a stored value.
test('a ranking by a calculated number reads its results', () => {
  const entity = { semanticId: 'tasks', displayName: 'Tasks', fields: [field], derivedFields: [{ semanticId: 'score', automationTarget: 'score', displayName: 'Score', resultType: 'decimal', resultNullable: true, calculationId: 'c', expression: 'x' }] };
  const row = (id, digits) => ({ semanticId: id, automationTarget: `record-${id}`, version: 1, values: { title: id },
    calculations: { score: { calculationId: 'c', fieldId: 'score', state: 'value', resultType: 'decimal', value: { $nendoNumber: digits } } } });
  const markup = p.rankedRowsMarkup(entity, [row('a', '40'), row('b', '20')], 'score', ['title'], 40);
  const widths = [...markup.matchAll(/ranked-bar-fill" style="width: ([\d.]+)%/g)].map(([, width]) => Number(width));
  assert.deepEqual(widths, [100, 50], 'A calculated ranking drew its bars from a stored value it does not have.');
});

// A front-page chart of a type whose only screen is a board is not drawn as bars to press, which
// would do nothing once the press had left the front page for a later redraw to show; and a row of
// a type with no screen at all is no button.
test('a chart drills only into a type with a list, and a row of a type with no screen is no button', () => {
  openFile();
  const board = { semanticId: 'board', automationTarget: 'board', kind: 'boardSurface', properties: { entityId: 'tasks' }, children: [] };
  p.state.compilation = { ...definition, applications: [{ ...plan, surfaces: [board] }] };
  assert.equal(p.drillPlan('tasks'), null, 'a board-only type is offered as a list to drill into');
  const records = { semanticId: 'records', automationTarget: 'records', kind: 'recordList', properties: { entityId: 'tasks' }, children: [] };
  p.state.compilation = { ...definition, applications: [{ ...plan, surfaces: [records] }] };
  assert.equal(p.drillPlan('tasks')?.entity.semanticId, 'tasks');
  const entity = { semanticId: 'tasks', displayName: 'Tasks', fields: [field], derivedFields: [] };
  const row = { semanticId: 'a', automationTarget: 'record-a', version: 1, values: { title: 'A', value: 3 } };
  assert.match(p.rankedRowsMarkup(entity, [row], 'value', ['title'], 3), /<button type="button" class="ranked-row" data-overview-record="a"/);
  p.state.compilation = { ...definition, applications: [] };
  const plain = p.rankedRowsMarkup(entity, [row], 'value', ['title'], 3);
  assert.doesNotMatch(plain, /<button/, `a row of a type with no screen is drawn as a button that opens nothing: ${plain}`);
  assert.match(plain, /<div class="ranked-row">/);
  const view = readFileSync(new URL('../src/view-overview.ts', import.meta.url), 'utf8');
  assert.match(view, /drillable: entityId !== null && drillPlan\(entityId\) !== null/, 'a chart is drillable wherever its type has any screen');
  const handler = view.slice(view.indexOf("'[data-chart-drill]'"), view.indexOf('void drillInto(target, scoped, group);'));
  assert.ok(handler.indexOf('drillPlan(') >= 0 && handler.indexOf('drillPlan(') < handler.indexOf('state.showOverview = false'),
    'the press leaves the front page before it knows there is a list to drill into');
});
