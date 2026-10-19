import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// The Workbench's state rules, driven through the real moves -- openWorkspaceView,
// openHelp, the tab switch (switchTab with revisitCurrent), the busy queue and following the file
// -- in one bundle so they share the app's state, with the host replaced by a recorder that can
// be told to fail a method or hold one back, and the shell by one that records what was said.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], fail: new Set(), held: new Map(), said: [], notices: [], redraws: 0, session: null };
globalThis.navStateHost = host;
const status = { semanticId: 'status', automationTarget: 'status', displayName: 'Status', presentation: 'singleChoice', storageKind: 'text', retired: false, required: false,
  options: ['ready', 'done'], choices: [{ id: 'ready', displayName: 'Ready', retired: false }, { id: 'done', displayName: 'Done', retired: false }] };
globalThis.navStatePlan = { entity: { semanticId: 'tasks', displayName: 'Task', fields: [status], derivedFields: [] },
  surfaces: [{ semanticId: 'tasks.list', automationTarget: 'tasks.list', kind: 'recordList', properties: { entityId: 'tasks' }, children: [] }] };
const busyQueue = JSON.stringify(resolve(root, 'src/busy-queue.ts'));
const hostTypes = JSON.stringify(resolve(root, 'src/host-types.ts'));
const appState = JSON.stringify(resolve(root, 'src/app-state.ts'));
const stubs = {
  './client': `import { WorkbenchHostError } from ${hostTypes};
    export const client={mode:'desktop',request:async(method,payload)=>{const h=globalThis.navStateHost;h.calls.push({method,payload});
    if(h.fail.has(method))throw new WorkbenchHostError(h.failCode??'view-changed','The file is changing. Refresh the view when the current changes finish.');
    if(h.held.has(method))return h.held.get(method).promise;
    const sequence=h.session.manifest.changeSequence;
    if(method==='session.getSnapshot')return h.session;
    if(method==='semantic.compile')return {isValid:true,sourceChangeSequence:sequence,applications:[globalThis.navStatePlan],overview:null};
    if(method==='history.query')return {items:[],nextCursor:null,changeSequence:sequence};
    if(method==='help.readPages')return {pages:[]};
    return {items:[],nextCursor:null,changeSequence:sequence};}};`,
  './shell': `import { hasDeferredMove, runDeferredMove } from ${busyQueue};
    import { state } from ${appState};
    const h=()=>globalThis.navStateHost;
    export const content={querySelectorAll:()=>[],querySelector:()=>null,innerHTML:'',contains:()=>false};
    export const interactionInProgress=()=>false;
    export const setBusy=(busy)=>{h().busyNow=busy;if(!busy&&hasDeferredMove())setTimeout(runDeferredMove,0);};
    export const rerender=()=>{h().redraws+=1;setBusy(state.actionInFlight);};
    export const showError=(m)=>{h().said.push(m);};
    export const clearError=()=>{};export const announce=()=>{};export const refreshChrome=()=>{};
    export const showRetainedNotice=(message,refresh,takeFocus=true)=>{h().notices.push({message,refresh,takeFocus});};
    export const showKeptAlert=(m)=>{h().said.push(m);};export const showOutcome=()=>{};
    export const requiredElement=()=>({hidden:false,addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]});
    export const focusWithoutInteraction=()=>{};`,
  './confirm-dialog': 'export const confirmDialog=async()=>false;',
};
const entry = [
  `export { openWorkspaceView, openHelp, refreshDerived, derivedAt, showFailure, showOutcomeRefreshNotice } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { placeNow, revisitCurrent } from ${JSON.stringify(resolve(root, 'src/navigation-actions.ts'))};`,
  `export { switchTab } from ${JSON.stringify(resolve(root, 'src/tab-set.ts'))};`,
  `export { navigationTrail } from ${JSON.stringify(resolve(root, 'src/navigation-trail.ts'))};`,
  `export { state } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
  `export { deferWhileBusy, runDeferredMove } from ${busyQueue};`,
  `export { createFileFollow } from ${JSON.stringify(resolve(root, 'src/file-follow.ts'))};`,
  `export { createReadChase } from ${JSON.stringify(resolve(root, 'src/read-chase.ts'))};`,
  `export { WorkbenchHostError } from ${hostTypes};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'nav-state-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('nav-state-entry')) return '\0nav-state-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0nav-state-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'nav-state-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const settle = () => new Promise((done) => setTimeout(done, 5));
const deferred = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };
const session = (changeSequence) => ({ hasFile: true, fileSessionId: 'file-A', fileName: 'Tasks.nendo', manifest: { changeSequence },
  capabilities: { customSurfaces: true, readHistory: true, readData: true, mutate: true }, entities: [{ entityId: 'tasks' }], extensions: null });

async function onUse() {
  host.fail.clear(); host.held.clear(); host.said.length = 0; host.notices.length = 0; host.failCode = undefined;
  host.session = session(3);
  p.state.session = host.session;
  p.state.actionInFlight = false;
  p.state.openDraft = null;
  p.state.lastOutcome = null;
  p.state.view = 'use';
  p.state.selectedApplicationEntity = 'tasks';
  p.state.showOverview = false;
  p.state.fileView = null;
  await p.refreshDerived();
  p.navigationTrail.load({ places: [], cursor: -1 });
}

test('a move whose read fails leaves the state on the screen still drawn', async () => {
  await onUse();
  host.fail.add('history.query');
  await p.openWorkspaceView('history');
  assert.equal(host.said.length + host.notices.length, 1, 'the failure was not said');
  assert.equal(p.state.view, 'use', 'the state names the screen the move failed to reach, under the old page');
});

test('a refusal that asks for a refresh carries the Refresh view button, and a background one keeps the focus where it is', async () => {
  await onUse();
  p.showFailure(new p.WorkbenchHostError('stale-file-session', 'The file changed while this action was running. Refresh the view.'));
  assert.equal(host.notices.length, 1, 'a sentence that says Refresh the view offers nothing to press');
  assert.equal(typeof host.notices[0].refresh, 'function');
  p.showFailure(new p.WorkbenchHostError('view-changed', 'The file is changing.'), false);
  assert.equal(host.notices[1].takeFocus, false);
  p.showFailure(new p.WorkbenchHostError('record-not-found', 'That record is gone.'));
  assert.deepEqual(host.said, ['That record is gone.'], 'a refusal with nothing to refresh grew a Refresh view button');
});

test('Refresh view leaves the window idle once it has read the file again', async () => {
  // Its handlers set the one-action flag without the busy state, and the redraw inside them then
  // set the busy state the handler never cleared: every control stayed disabled under "Still working".
  for (const show of [() => p.showFailure(new p.WorkbenchHostError('stale-file-session', 'Refresh the view.')), () => p.showOutcomeRefreshNotice('Saved.', 'Refresh the view.')]) {
    await onUse();
    show();
    await host.notices.at(-1).refresh({ disabled: false });
    assert.equal(p.state.actionInFlight, false);
    assert.equal(host.busyNow, false, 'Refresh view left the window busy, with every control disabled');
  }
});

test('Help pressed while an action runs opens when it ends', async () => {
  await onUse();
  p.state.actionInFlight = true;
  await p.openHelp('');
  assert.equal(p.state.view, 'use', 'Help drew under a running action');
  p.state.actionInFlight = false;
  p.runDeferredMove();
  await settle();
  assert.equal(p.state.view, 'help', 'Help pressed during an action was dropped');
});

test('a move pressed while an action runs is made when it ends, and a refusal since keeps the person where it is said', async () => {
  await onUse();
  p.state.actionInFlight = true;
  await p.openWorkspaceView('data');
  assert.equal(p.state.view, 'use');
  p.state.actionInFlight = false;
  p.runDeferredMove();
  await settle();
  assert.equal(p.state.view, 'data', 'a press made while a save ran was dropped without a word');

  await onUse();
  p.state.actionInFlight = true;
  await p.openWorkspaceView('data');
  p.state.lastOutcome = { view: 'use', message: 'That value is already used.', tone: 'alert' };
  p.state.actionInFlight = false;
  p.runDeferredMove();
  await settle();
  assert.equal(p.state.view, 'use', 'the held move took the person away from the refusal of the save it waited on');
});

test('a tab whose place cannot be read puts the screen back with the tab and its trail', async () => {
  await onUse();
  const heading = { eyebrow: 'Use · Task', title: 'All tasks' };
  p.navigationTrail.record(p.placeNow(heading));
  const usePlace = p.placeNow(heading);
  const history = { ...usePlace, view: 'history', eyebrow: 'Studio', title: 'History', applicationEntityId: null, surfaceId: null };
  const set = { tabs: [{ id: 1, saved: null }, { id: 2, saved: { places: [history], cursor: 0 } }], active: 0 };
  host.fail.add('history.query');
  assert.equal(await p.switchTab(set, 1, p.navigationTrail, p.revisitCurrent), false);
  assert.equal(set.active, 0, 'the tab that was on screen is not selected again');
  assert.equal(p.navigationTrail.current()?.view, 'use');
  assert.equal(p.state.view, 'use', 'the old tab is selected over the new tab’s screen');
  assert.equal(host.said.length, 1, 'the failure was not said on the screen it was put back to');
});

test('a topic picked while Help loads stays picked, and a late answer does not redraw another page', async () => {
  await onUse();
  host.held.set('help.readPages', deferred());
  const opening = p.openHelp('');
  await settle();
  p.state.helpTopicId = 'connect-mcp';
  host.held.get('help.readPages').release({ pages: [] });
  await opening;
  assert.equal(p.state.helpTopicId, 'connect-mcp', 'the file’s first page replaced the topic the person picked');

  await onUse();
  host.held.set('help.readPages', deferred());
  const second = p.openHelp('');
  await settle();
  p.state.view = 'data';
  const before = host.redraws;
  host.held.get('help.readPages').release({ pages: [] });
  await second;
  assert.equal(host.redraws, before, 'Help’s late answer redrew the page the person had moved to');
});

function clock() {
  let now = 0; const timers = [];
  return {
    now: () => now,
    later: (run, ms) => { timers.push({ at: now + ms, run }); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (timers.length === 0 || timers[0].at > until) break;
        const timer = timers.shift(); now = timer.at; timer.run(); await settle();
      }
      now = until;
    },
  };
}

function follower() {
  const time = clock();
  const seen = { passes: 0, failures: [], recovered: 0, redraws: 0 };
  const follow = p.createFileFollow({
    chase: p.createReadChase(time),
    drawnAt: p.derivedAt,
    pass: async () => { seen.passes += 1; p.state.session = await Promise.resolve(host.session); await p.refreshDerived(); },
    redraw: () => { seen.redraws += 1; },
    later: time.later,
    failed: (error, first) => { seen.failures.push(first); },
    recovered: () => { seen.recovered += 1; },
    holding: () => false,
  });
  return { time, seen, follow };
}

test('a follow that failed after adopting the newer snapshot still catches up on the next nudge', async () => {
  await onUse();
  const { time, seen, follow } = follower();
  host.session = session(5);
  host.fail.add('semantic.compile');
  follow.nudge('file-A', 5);
  await settle();
  assert.equal(seen.passes, 1);
  assert.deepEqual(seen.failures, [true]);
  assert.equal(p.state.session.manifest.changeSequence, 5, 'the pass adopted the newer snapshot before it failed');
  host.fail.clear();
  follow.nudge('file-A', 5);
  await time.advance(1000);
  assert.equal(seen.passes, 2, 'a nudge for the change the failed pass had adopted was ignored, and the screen stayed on the old revision');
  assert.equal(p.derivedAt().changeSequence, 5);
  assert.equal(seen.recovered, 1);
});

test('a failed follow asks again by itself, waiting longer each time it fails', async () => {
  await onUse();
  const { time, seen, follow } = follower();
  host.session = session(6);
  host.fail.add('semantic.compile');
  follow.nudge('file-A', 6);
  await settle();
  await time.advance(1000);
  assert.equal(seen.passes, 2, 'nothing re-armed the follow after a failed pass');
  assert.deepEqual(seen.failures, [true, false], 'a streak of failures is said once');
  await time.advance(1999);
  assert.equal(seen.passes, 2, 'a follow that keeps failing asked again after one second, not two');
  await time.advance(1);
  assert.equal(seen.passes, 3);
  await time.advance(4000);
  assert.equal(seen.passes, 4, 'the third retry did not wait four seconds');
  host.fail.clear();
  await time.advance(8000);
  assert.equal(seen.passes, 5);
  assert.equal(p.derivedAt().changeSequence, 6);
  assert.equal(seen.recovered, 1);
  await time.advance(60000);
  assert.equal(seen.passes, 5, 'the follow kept reading after it had caught up');
});

test('a wake-up with nothing new read starts the pass it waited for and redraws once', async () => {
  await onUse();
  const { time, seen, follow } = follower();
  host.session = session(7);
  follow.follow();
  await settle();
  follow.follow();
  await time.advance(1000);
  assert.equal(seen.passes, 2);
  assert.equal(seen.redraws, seen.passes, 'the page was rebuilt for a wake-up that had read nothing');
});
