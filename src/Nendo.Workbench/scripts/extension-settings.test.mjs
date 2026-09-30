import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// R30-014: use the real device-switch refresh with the host and frame lifecycle
// replaced by stand-ins. A switch changes no data sequence and must stop views
// even while unsaved/retained record values hold the page.
const root = fileURLToPath(new URL('..', import.meta.url));
const page = { calls: [], reply: null, focused: false };
globalThis.extensionSettingsPage = page;
const stubs = {
  './client': `export const client = { request: async (method) => {
    const p = globalThis.extensionSettingsPage; p.calls.push(method); return p.reply(); } };`,
  './actions': `export const refreshDerived = async () => globalThis.extensionSettingsPage.calls.push('derived');`,
  './shell': `const p = () => globalThis.extensionSettingsPage;
    export const content = {}; export const refreshChrome = () => p().calls.push('chrome');
    export const rerender = () => p().calls.push('render'); export const showError = () => {};
    export const interactionInProgress = () => p().focused;`,
  './view-frames': `const p = () => globalThis.extensionSettingsPage;
    export const parkViewFrames = () => p().calls.push('park');
    export const wireViewFrames = () => p().calls.push('wire');
    export const releaseViewFrames = () => p().calls.push('release');`,
};
const entry = [
  `export { refreshExtensionSettings } from ${JSON.stringify(resolve(root, 'src/extension-settings.ts'))};`,
  `export { state } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({ root, configFile: false, logLevel: 'error',
  plugins: [{ name: 'extension-settings-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('extension-settings-entry')) return '\0extension-settings-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0extension-settings-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'extension-settings-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const f = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

function setup() {
  page.calls = []; page.focused = false;
  f.state.openDraft = null; f.state.retainedDraft = null;
  f.state.session = { ...f.state.session, fileSessionId: 'file-1', hasFile: true,
    manifest: { changeSequence: 7 }, extensions: { run: true, deviceEnabled: true } };
  page.reply = () => ({ ...f.state.session, extensions: { run: false, deviceEnabled: false } });
}

test('R30-014: an unheld page follows device Off even at the same data revision', async () => {
  setup(); await f.refreshExtensionSettings();
  assert.equal(f.state.session.extensions.run, false, 'A device switch left the old run state in the window.');
  assert.equal(f.state.session.manifest.changeSequence, 7);
  assert.deepEqual(page.calls, ['session.getSnapshot', 'derived', 'render']);
});

test('R30-014: a held record page stops/disconnects views in place without discarding its draft', async () => {
  for (const hold of ['edited', 'retained', 'focused']) {
    setup();
    if (hold === 'edited') f.state.openDraft = { session: { fileSessionId: 'file-1', canMutate: true }, edited: new Set(['title']) };
    if (hold === 'retained') f.state.retainedDraft = Object.freeze({ reason: 'read-only' });
    if (hold === 'focused') page.focused = true;
    const draft = f.state.openDraft; const retained = f.state.retainedDraft;
    await f.refreshExtensionSettings();
    assert.equal(f.state.session.extensions.run, false, `${hold} blocked the device switch.`);
    assert.deepEqual(page.calls, ['session.getSnapshot', 'park', 'wire', 'release', 'chrome'], `${hold} lost the in-place frame shutdown.`);
    assert.equal(f.state.openDraft, draft); assert.equal(f.state.retainedDraft, retained);
  }
});

test('R30-014: a delayed settings snapshot cannot overwrite a newly opened file or a newer switch', async () => {
  setup(); let release;
  page.reply = () => new Promise(resolve => { release = resolve; });
  const refresh = f.refreshExtensionSettings();
  const old = { ...f.state.session, extensions: { run: false } };
  f.state.session = { ...f.state.session, fileSessionId: 'file-2', extensions: { run: true } };
  release(old); await refresh;
  assert.equal(f.state.session.fileSessionId, 'file-2');
  assert.equal(f.state.session.extensions.run, true, 'Old-file settings crossed the session boundary.');
  assert.deepEqual(page.calls, ['session.getSnapshot']);

  setup(); page.reply = () => new Promise(resolve => { release = resolve; });
  const earlier = f.refreshExtensionSettings();
  const off = { ...f.state.session, extensions: { run: false } };
  page.reply = () => ({ ...f.state.session, extensions: { run: true } });
  await f.refreshExtensionSettings(); release(off); await earlier;
  assert.equal(f.state.session.extensions.run, true, 'An older event overwrote the newest switch.');
});

// Exercise the real mount/release lifecycle too: a frame parked for proposal
// review must lose its broker connection and navigate to about:blank on Off.
const frames = { mounts: [], retired: [], controls: [], deps: null, timers: [] };
globalThis.extensionSettingsFrames = frames;
const frameStubs = {
  './client': 'export const client = { mode: "desktop" };',
  './shell': 'export const content = { contains: () => true }; export const root = { dataset: {} }; export const refreshChrome = () => {};',
  './extension-broker': `export const brokerMethodNames = []; export const createExtensionBroker = deps => {
    const f = globalThis.extensionSettingsFrames; f.deps = deps;
    return { disconnect: mount => f.retired.push(mount), isConnected: () => true, place: () => {}, refreshContext: () => {} }; };`,
  './extension-ui': 'export const openProposalFromView = () => ({ opened: true }); export const openRecordFromView = () => {}; export const openScreenFromView = () => {}; export const openStudioFromView = () => {}; export const toastFromView = () => {};',
  './view-menu': 'export const closeViewMenu = () => {}; export const showViewMenu = () => {};',
  './view-toolbar': 'export const drawViewToolbar = (_element, host) => globalThis.extensionSettingsFrames.controls.push(host.toolbar); export const focusViewSearch = () => {};',
  './view-health': 'export const refreshHealth = () => {};',
  './view-packages': 'export const importPackage = () => {}; export const openCustomViews = () => {}; export const saveDevelopment = () => {}; export const setViewSwitch = () => {}; export const stopDeveloping = () => {};',
};
const frameEntry = [
  `export { installViewFrames, wireViewFrames, parkViewFrames, releaseViewFrames } from ${JSON.stringify(resolve(root, 'src/view-frames.ts'))};`,
  `export { state } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const frameBundle = await build({ root, configFile: false, logLevel: 'error',
  plugins: [{ name: 'settings-frame-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('settings-frame-entry')) return '\0settings-frame-entry'; if (id in frameStubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0settings-frame-entry') return frameEntry; if (id.startsWith('\0stub')) return frameStubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'settings-frame-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const lifecycle = await import('data:text/javascript;base64,' + Buffer.from(frameBundle.output.find(item => item.type === 'chunk').code).toString('base64'));

test('R30-014: Off retires even a frame held for proposal review and removes its toolbar', () => {
  const stage = { style: {}, querySelector: () => null, prepend: frame => frames.mounts.push(frame) };
  const placeholder = { isConnected: true, dataset: { viewId: 'view.glance', viewPlacement: 'screen', viewPackage: 'org.example.glance' },
    querySelector: selector => selector === '[data-view-stage]' ? stage : null };
  globalThis.window = { addEventListener() {}, setTimeout: callback => frames.timers.push(callback) };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.document = { createElement: () => ({ isConnected: true, src: '', setAttribute(key, value) { this[key] = value; }, addEventListener() {}, remove() {} }) };
  lifecycle.state.session = { ...lifecycle.state.session, fileSessionId: 'file-1', extensions: {
    run: true, packages: [{ packageId: 'org.example.glance', origin: 'https://org-example-glance.example', entryPoint: 'index.html' }] } };
  lifecycle.installViewFrames(); lifecycle.wireViewFrames({ querySelectorAll: () => [placeholder] });
  assert.equal(frames.mounts.length, 1, 'The fixture did not start a production frame.');
  const mount = [...frames.deps.mounts()][0];
  frames.deps.ui.setToolbar(mount, { items: [{ id: 'one', kind: 'button', label: 'One' }], add: null });
  assert.equal(frames.deps.ui.openProposal(mount, {}).opened, true);
  lifecycle.state.view = 'proposal';
  lifecycle.parkViewFrames(); lifecycle.releaseViewFrames();
  assert.equal(frames.retired.length, 0, 'A running review frame was not held.');
  lifecycle.state.session.extensions = { run: false, packages: [] };
  lifecycle.parkViewFrames(); lifecycle.releaseViewFrames();
  assert.equal(frames.retired.length, 1, 'Device Off left the review frame connected.');
  assert.equal(frames.mounts[0].src, 'about:blank', 'Device Off did not end the frame renderer.');
  assert.equal(frames.controls.at(-1), null, 'Device Off left the view toolbar drawn.');
});
