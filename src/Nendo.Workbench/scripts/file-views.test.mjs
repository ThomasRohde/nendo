import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// W-106: a view of the file (extensionView) is a screen beside the front page. The real
// actions.ts (refreshDerived), file-view-model.ts and file-views.ts run here against a
// stand-in host: which screen a file opens on, what the Showing picker offers and in which
// order, and what the screen of a view is made of. Only the page, the frames and the pickers'
// slot are stand-ins.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], redraws: 0, errors: [], reply: null, html: '', pickers: '', wired: 0, add: null, elements: {} };
globalThis.fileViewHost = host;
const stubs = {
  './client': 'export const client = { mode: "desktop", request: async (method, payload) => { const h = globalThis.fileViewHost; h.calls.push({ method, payload }); return h.reply(method, payload); } };',
  './shell': `const h = () => globalThis.fileViewHost;
    export const content = { set innerHTML(value) { h().html = value; }, get innerHTML() { return h().html; }, querySelectorAll: () => [], querySelector: () => null };
    export const interactionInProgress = () => false; export const rerender = () => { h().redraws += 1; };
    export const setBusy = () => {}; export const showError = (text) => { h().errors.push(text); };
    export const announce = () => {}; export const clearError = () => {}; export const refreshChrome = () => {};
    export const showRetainedNotice = () => {}; export const requiredElement = (selector) => (h().elements[selector] ??= { hidden: true, textContent: '', innerHTML: '', addEventListener: () => {} });
    export const focusWithoutInteraction = () => {};`,
  './place-pickers': 'export const drawPlacePickers = (markup) => { globalThis.fileViewHost.pickers = markup; return { querySelector: () => null }; };',
  './view-frames': `export const wireViewFrames = () => { globalThis.fileViewHost.wired += 1; };
    export const viewAddCommand = () => globalThis.fileViewHost.add;`,
  './panels': `export const drillInto = async () => {}; export const drillIntoCell = async () => {}; export const refreshOverview = async () => {};
    export const refreshVisibleTiles = async () => {}; export const wireCharts = () => {}; export const wireSummaryRetry = () => {};
    export const matrixPending = () => false; export const patchCharts = () => {};
    export const wireChartTables = () => {}; export const drillGroupOf = () => null;`,
  './view-packages': 'export const openCustomViews = async () => {};',
};
const entry = [
  `export { refreshDerived, resetFileView } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { state, emptySession } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
  `export { openingFileView, showingOptionsMarkup, showingLabel, showsFileView, viewIcon } from ${JSON.stringify(resolve(root, 'src/file-view-model.ts'))};`,
  `export { renderFileView } from ${JSON.stringify(resolve(root, 'src/file-views.ts'))};`,
  `export { activePlan } from ${JSON.stringify(resolve(root, 'src/plan-selection.ts'))};`,
  `export { drawRailPlaces } from ${JSON.stringify(resolve(root, 'src/rail-places.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'file-view-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('file-view-entry')) return '\0file-view-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0file-view-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'file-view-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const field = { semanticId: 'title', automationTarget: 'title', storageKind: 0, displayName: 'Title', required: false, retired: false, presentation: null, options: [] };
const list = { semanticId: 'list', automationTarget: 'list', kind: 'recordList', properties: { entityId: 'tasks' }, children: [] };
const plan = { entity: { semanticId: 'tasks', displayName: 'Tasks', fields: [field], derivedFields: [] }, surfaces: [list], records: [] };
const overview = { surface: { semanticId: 'front', kind: 'overviewSurface', properties: { title: 'Front page' }, children: [] }, entities: [] };
const view = (id, title, extra = {}) => ({ semanticId: id, automationTarget: id, kind: 'extensionView', properties: { definitionVersion: 3, title, packageId: 'org.nendo.archi', ...extra }, children: [] });
const workbench = view('workbench', 'Archi', { opensFile: true, entityId: 'tasks' });
const notes = view('notes', 'Notes');

/** A file opened afresh, with views running or not, whose definition holds what is given. */
async function openFile({ views = [workbench, notes], run = true, front = true, applications = [plan] } = {}) {
  Object.assign(host, { calls: [], redraws: 0, errors: [], html: '', pickers: '', wired: 0, add: null });
  const empty = p.emptySession();
  p.state.session = {
    ...empty, fileSessionId: 'file-A', fileName: 'Archi.nendo', hasFile: true,
    capabilities: { ...empty.capabilities, readData: true, customSurfaces: true, mutate: true },
    manifest: { changeSequence: 1 }, entities: applications.map((app) => ({ entityId: app.entity.semanticId, displayName: app.entity.displayName, fields: [], retired: false })),
    extensions: { run, offReason: run ? null : 'device', packages: [] },
  };
  p.resetFileView();
  p.state.view = 'use';
  const definition = { isValid: true, sourceChangeSequence: 1, applications, overview: front ? overview : null, views };
  host.reply = (method) => {
    if (method === 'semantic.compile') return definition;
    if (method === 'agent.getStatus') return {};
    if (method === 'data.queryRecords') return { items: [], nextCursor: null, changeSequence: 1 };
    if (method === 'history.list') return { items: [], nextCursor: null, changeSequence: 1 };
    throw new Error(`Unexpected ${method}`);
  };
  await p.refreshDerived();
}

test('a file opens on the view that says opensFile, before its front page', async () => {
  await openFile();
  assert.equal(p.state.fileView, 'workbench', 'The file did not open on its workbench.');
  assert.equal(p.state.showOverview, false);
  assert.equal(p.showsFileView(), true);
  assert.deepEqual(host.errors, []);
});

test('where custom views do not run, the file opens on its front page as before', async () => {
  await openFile({ run: false });
  assert.equal(p.state.fileView, null, 'A file opened on a view that cannot run.');
  assert.equal(p.state.showOverview, true);
  assert.equal(p.openingFileView({ isValid: true, views: [workbench] }, null), null, 'Safe mode, with no view runtime, opened on a view.');
  assert.equal(p.openingFileView({ isValid: false, views: [workbench] }, { run: true }), null, 'A definition that does not compile opened on a view.');
});

test('without a view that opens it, the file opens as it did: the front page, else the first record type', async () => {
  await openFile({ views: [notes] });
  assert.equal(p.state.fileView, null);
  assert.equal(p.state.showOverview, true);
  await openFile({ views: [notes], front: false });
  assert.equal(p.state.fileView, null);
  assert.equal(p.state.showOverview, false);
});

test('Showing lists the front page, then the file’s views in authored order, then the record types', async () => {
  await openFile();
  const options = [...p.showingOptionsMarkup({ overview: false, fileView: 'notes', entityId: null }).matchAll(/<option value="([^"]*)" (selected)?/g)]
    .map(([, value, selected]) => selected ? `*${value}` : value);
  assert.deepEqual(options, ['', 'view:workbench', '*view:notes', 'tasks']);
  assert.equal(p.showingLabel(), 'Showing');
});

test('the screen of a view is one frame filling Use, about the record type it names, with Add only for the view’s own', async () => {
  await openFile();
  p.renderFileView(workbench);
  assert.match(host.html, /data-testid="file-view"/);
  const mount = /<section class="view-mount is-screen" ([^>]*)>/.exec(host.html)?.[1] ?? '';
  assert.match(mount, /data-view-id="workbench"/);
  assert.match(mount, /data-view-kind="extensionView"/);
  assert.match(mount, /data-view-placement="screen"/);
  assert.match(mount, /data-view-entity="tasks"/);
  assert.match(mount, /data-view-package="org.nendo.archi"/);
  assert.match(host.html, /<button id="new-record"[^>]*data-file-view-add[^>]*hidden/, 'A view that names no Add was given one.');
  assert.match(host.pickers, /<option value="view:workbench" selected>Archi<\/option>/);
  assert.equal(host.wired, 1, 'The frame was never wired.');
  host.add = () => {};
  p.renderFileView(notes);
  assert.doesNotMatch(host.html, /data-file-view-add[^>]*hidden/, 'A view that names an Add was not given one.');
  assert.match(host.html, /data-view-entity=""/, 'A view that names no record type was handed one.');
});

test('a record type with only its record page is no place: not in Showing, not in the navigation, never the default (W-184)', async () => {
  // Compiled order is by entity ID, so the joining type comes first, as gd.link does in Garden.
  const page = { semanticId: 'joins.page', automationTarget: 'joins.page', kind: 'detailSurface', properties: { entityId: 'joins' }, children: [] };
  const joins = { entity: { semanticId: 'joins', displayName: 'Joins', fields: [field], derivedFields: [] }, surfaces: [page], records: [] };
  await openFile({ applications: [joins, plan], front: false, views: [] });
  const options = markup => [...markup.matchAll(/<option value="([^"]*)" (selected)?/g)].map(([, value, selected]) => selected ? `*${value}` : value);
  assert.deepEqual(options(p.showingOptionsMarkup({ overview: false, fileView: null, entityId: 'tasks' })), ['*tasks'], 'A type with only a record page was offered as a place.');
  assert.equal(p.activePlan()?.entity.semanticId, 'tasks', 'Use opened on a type that has no screen.');
  p.drawRailPlaces();
  const rail = host.elements['#nav-places']?.innerHTML ?? '';
  assert.match(rail, /data-rail-place="type:tasks"/);
  assert.doesNotMatch(rail, /type:joins/, 'The navigation offered a type that has no screen.');
  // Open one of its records from a related row and the picker still says where Use is.
  p.state.selectedApplicationEntity = 'joins';
  assert.equal(p.activePlan()?.entity.semanticId, 'joins', 'A record page of the type could not be shown.');
  assert.deepEqual(options(p.showingOptionsMarkup({ overview: false, fileView: null, entityId: 'joins' })), ['*joins', 'tasks']);
});

test('a view’s icon: the view the file opens on is its home when it has no front page, others are guessed from their title (W-184)', async () => {
  const home = view('home', 'Overview', { opensFile: true }), garden = view('garden', 'Garden'), archi = view('archi', 'Archi');
  await openFile({ views: [home, garden, archi], front: false });
  assert.deepEqual([home, garden, archi].map(p.viewIcon), ['home', 'sprout', 'surfaces'], 'Overview and Garden drew the same icon, or a title that says nothing lost the panels.');
  await openFile({ views: [home, garden], front: true });
  assert.equal(p.viewIcon(home), 'surfaces', 'With a front page, the front page alone is home.');
  p.drawRailPlaces();
  const glyphs = [...(host.elements['#nav-places']?.innerHTML ?? '').matchAll(/data-rail-place="([^"]+)"[^>]*><span class="nav-symbol" aria-hidden="true">(<svg[^]*?<\/svg>)/g)].map(([, place, svg]) => [place, svg]);
  const of = place => glyphs.find(([value]) => value === place)?.[1];
  assert.ok(of('view:home') && of('view:garden') && of('view:home') !== of('view:garden'), `The navigation drew the two views alike: ${JSON.stringify(glyphs.map(([place]) => place))}`);
});
