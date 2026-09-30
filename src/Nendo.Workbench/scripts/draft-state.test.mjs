import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/draft-state.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {decideDraftState,draftRetentionMessage} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const editable = { fileSessionId: 'session-1', canMutate: true };

test('an unchanged editable file leaves the draft alone', () => {
  assert.deepEqual(decideDraftState(editable, editable, true), { outcome: 'keep-editable', reason: 'unchanged' });
});

test('no unsaved input means the ordinary rebuild is free to happen', () => {
  assert.equal(decideDraftState(editable, { fileSessionId: 'session-2', canMutate: false }, false).outcome, 'discard');
});

test('a different file keeps the typing on screen and refuses to save it here', () => {
  // The same values typed against another file would land on whatever record now
  // happens to carry that ID, which is a data-loss bug wearing a rebuild's clothes.
  const state = decideDraftState(editable, { fileSessionId: 'session-2', canMutate: true }, true);
  assert.deepEqual(state, { outcome: 'retain-read-only', reason: 'file-changed' });
  assert.match(draftRetentionMessage(state.reason), /no longer the file you were editing/);
});

test('losing edit authority retains the draft without offering to save it', () => {
  const state = decideDraftState(editable, { fileSessionId: 'session-1', canMutate: false }, true);
  assert.deepEqual(state, { outcome: 'retain-read-only', reason: 'read-only' });
  assert.match(draftRetentionMessage(state.reason), /no longer editable/);
});

test('a session that could not be read is not treated as unchanged', () => {
  // Not knowing whether editing is still authorised is a reason to stop offering to
  // save, never a reason to assume it is.
  const state = decideDraftState(editable, null, true);
  assert.deepEqual(state, { outcome: 'retain-read-only', reason: 'session-unknown' });
  assert.match(draftRetentionMessage(state.reason), /could not check/);
});

test('a file closing under an open form is a file change, not an editable session', () => {
  assert.equal(decideDraftState(editable, { fileSessionId: null, canMutate: false }, true).reason, 'file-changed');
});

test('an unchanged decision carries no message to show', () => {
  assert.equal(draftRetentionMessage('unchanged'), '');
  assert.equal(draftRetentionMessage('no-draft'), '');
});

// R30-008: execute the production retention action and both autonomous-chase
// guards with a page/host stand-in. The old action forgot the draft, so releasing
// focus let a pending chase replace the field's only remaining copy.
const root = fileURLToPath(new URL('..', import.meta.url));
const page = { focused: true, controls: [], errors: [], chrome: 0, requests: [], reply: null };
globalThis.retainedDraftPage = page;
const stubs = {
  './client': `export const client = { request: async (method) => {
    const p = globalThis.retainedDraftPage; p.requests.push(method); return p.reply(method); } };`,
  './shell': `const p = () => globalThis.retainedDraftPage;
    export const content = { querySelectorAll: () => p().controls };
    export const announce = () => {}; export const clearError = () => {}; export const setBusy = () => {};
    export const showError = (message) => p().errors.push(message);
    export const rerender = () => { throw new Error('A retained draft was redrawn.'); };
    export const refreshChrome = () => { p().chrome++; };
    export const interactionInProgress = () => p().focused;
    export const showRetainedNotice = () => {}; export const requiredElement = () => null;`,
};
const entry = [
  `export { retainDraftReadOnly, recoverAfterWriteFailure } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { holdingThePage, refuseWhileDirty } from ${JSON.stringify(resolve(root, 'src/draft-guard.ts'))};`,
  `export { state } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
  `export { createReadChase, chaseIntervalMs } from ${JSON.stringify(resolve(root, 'src/read-chase.ts'))};`,
].join('\n');
const retentionBundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{ name: 'retained-draft-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('retained-draft-entry')) return '\0retained-draft-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0retained-draft-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'retained-draft-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const retained = await import('data:text/javascript;base64,' + Buffer.from(retentionBundle.output.find(item => item.type === 'chunk').code).toString('base64'));

function retainedPage() {
  page.controls = [{ value: 'Unsaved review text', disabled: false, dataset: {} }];
  page.focused = true; page.errors = []; page.requests = []; page.chrome = 0;
  retained.state.retainedDraft = null;
  retained.state.openDraft = { session: { fileSessionId: 'session-1', canMutate: true }, edited: new Set(['title']) };
  retained.state.session.fileSessionId = 'session-1';
  retained.state.actionInFlight = false;
  return page.controls[0];
}

test('R30-008: a retained draft holds pending read-chase and fileChanged redraws after focus leaves', async () => {
  for (const chaseName of ['read-chase', 'fileChanged']) {
    const field = retainedPage();
    let now = 0; const timers = [];
    const chase = retained.createReadChase({ now: () => now, later: run => timers.push(run) });
    let draws = 0; let reads = 0;
    chase.run(async () => { reads++; }, () => { draws++; field.value = 'Saved value'; }, () => {}, retained.holdingThePage);
    retained.retainDraftReadOnly('read-only');
    page.focused = false;
    assert.equal(retained.holdingThePage(), true, `${chaseName} lost the retained draft hold after focus left.`);
    assert.equal(Object.isFrozen(retained.state.retainedDraft), true, 'The retained display state must be immutable.');
    for (let tick = 0; tick < 3; tick++) { now += retained.chaseIntervalMs; timers.shift()?.(); }
    assert.equal(draws, 0, `${chaseName} redrew retained values.`);
    assert.equal(reads, 0, `${chaseName} read through the retained hold.`);
    assert.equal(field.value, 'Unsaved review text');
    assert.equal(field.disabled, true);
    assert.equal(field.dataset.busyWasDisabled, 'true', 'Finishing the request must leave the retained field disabled.');
    assert.equal(retained.refuseWhileDirty('leaving this screen'), false, 'The reader must be able to deliberately leave retained values.');
    // The explicit render on departure clears retainedDraft; the waiting chase resumes.
    retained.state.retainedDraft = null;
    now += retained.chaseIntervalMs; timers.shift()?.();
    assert.equal(draws, 1, `${chaseName} did not resume after deliberate departure.`);
  }
});

test('R30-008: repeated unsettled recovery preserves a locked display draft', async () => {
  const field = retainedPage();
  retained.retainDraftReadOnly('session-unknown');
  page.focused = false;
  page.reply = () => ({ ...retained.state.session, capabilities: { ...retained.state.session.capabilities, mutate: true } });
  await retained.recoverAfterWriteFailure();
  assert.equal(retained.holdingThePage(), true, 'A later recovery released the retained display draft.');
  assert.equal(field.value, 'Unsaved review text');
  assert.equal(field.disabled, true);
  assert.equal(retained.state.retainedDraft.reason, 'session-unknown', 'A retained draft cannot silently become an editable save.');
});
