import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Compile the shipped TypeScript adapter with the pinned production toolchain;
// use Node's test runner and a deterministic bridge, without a second UI stack.
const bundle = await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true },
  build: { ssr: 'src/host.ts', write: false, minify: false, rollupOptions: { output: { codeSplitting: false } } } });
const module = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

function fixture() {
  const values = new Map();
  const listeners = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const state = { failStore: false, failCleanup: false, receipt: null, mutations: [],
    snapshot: { fileSessionId: 'file-session-one', hasFile: true, fileName: 'fixture.nendo', health: 'normal',
      manifest: { applicationId: 'app-one', instanceId: 'instance-one', changeSequence: 0 },
      capabilities: module.fileCapabilities(true), entities: [], records: [], uiNodes: [], storage: null } };
  const bridge = { addEventListener: (_, listener) => listeners.push(listener), postMessage: request => {
    requests.push(request);
    if (request.method === 'session.getSnapshot') respond(request, state.snapshot);
    else if (request.method === 'data.getReceipt' || request.method === 'history.getCompensationReceipt' || request.method === 'proposal.getReceipt') respond(request, state.receipt);
    else if (request.method.startsWith('data.') || request.method === 'proposal.promote') state.mutations.push(request);
  } };
  function respond(request, result, error = null) {
    for (const listener of listeners) listener({ data: { protocolVersion: module.protocolVersion,
      requestId: request.requestId, ok: error === null, result, error } });
  }
  globalThis.window = { chrome: { webview: bridge }, location: { search: '' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { if (state.failStore) throw new Error('quota'); values.set(key, value); },
      removeItem: key => { if (state.failCleanup) throw new Error('cleanup'); values.delete(key); } },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  function deliver(message) { for (const listener of listeners) listener({ data: message }); }
  return { state, values, requests, respond, deliver, client: () => module.createWorkbenchClient(),
    timeout: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}
const payload = key => ({ entityId: 'entity.generic', recordId: 'record-one', values: { 'field.title': 'Keep this exact value' }, idempotencyKey: key });
const receipt = key => ({ revisionId: 'revision-' + key, operationDigest: 'digest-' + key,
  definitionRevision: 1, dataRevision: 1, changeSequence: 2, isIdempotentReplay: true });

test('definitive reference rejection releases the pending request so a freshly selected target can be saved', { timeout: 2000 }, async () => {
  for (const code of ['target-version-required', 'target-version-conflict', 'target-not-found', 'reference-unbound']) {
    const f = fixture(); const client = f.client(); await client.request('session.getSnapshot');
    const failed = client.request('data.setFields', { ...payload('stale'), expectedTargetVersions: { 'field.target': 1 } }).catch(error => error);
    f.respond(f.state.mutations[0], null, { code, message: 'Reference rejected before commit.' });
    assert.equal((await failed).code, code);
    assert.equal(f.values.size, 0, 'A known transactional rejection must not remain an unconfirmed save.');
    const retry = client.request('data.setFields', { ...payload('fresh'), expectedTargetVersions: { 'field.target': 2 } });
    assert.equal(f.state.mutations.length, 2);
    f.respond(f.state.mutations[1], { mutation: receipt('fresh'), session: f.state.snapshot });
    await retry;
    assert.equal(f.values.size, 0);
  }
});

test('persist before dispatch, recover after renderer reload, and keep a newer pending request on late reply', { timeout: 2000 }, async () => {
  const f = fixture();
  const first = f.client();
  await first.request('session.getSnapshot');
  const original = first.request('data.createRecord', payload('original'));
  assert.equal(f.values.size, 1, 'The request identity must be retained before the bridge dispatch.');
  assert.equal(f.state.mutations.length, 1);
  const reloaded = f.client();
  await reloaded.request('session.getSnapshot');
  assert.equal(reloaded.pendingMutation().payload.idempotencyKey, 'original');
  await assert.rejects(reloaded.request('data.createRecord', payload('new-key')), /previous|pending|confirm/i);
  assert.equal(f.state.mutations.length, 1, 'An unresolved operation must block a new key.');
  f.state.receipt = receipt('original');
  const recovered = await reloaded.retryPendingMutation();
  assert.equal(recovered.mutation.revisionId, 'revision-original');
  assert.equal(f.values.size, 0);
  const newer = reloaded.request('data.createRecord', payload('newer'));
  const newerRequest = f.state.mutations[1];
  f.respond(f.state.mutations[0], { mutation: receipt('original'), session: f.state.snapshot });
  await original;
  assert.equal(reloaded.pendingMutation().payload.idempotencyKey, 'newer', 'Late completion cannot clear another request.');
  f.respond(newerRequest, { mutation: receipt('newer'), session: f.state.snapshot });
  await newer;
  assert.equal(f.values.size, 0);
});

test('an absent receipt retains the exact payload and key for explicit retry', { timeout: 2000 }, async () => {
  const f = fixture();
  const first = f.client();
  await first.request('session.getSnapshot');
  const original = first.request('data.createRecord', payload('same-key')).catch(error => error);
  f.timeout();
  assert.match((await original).message, /respond|confirm|pending/i);
  assert.equal(f.values.size, 1);
  const second = f.client();
  await second.request('session.getSnapshot');
  assert.equal(await second.checkPendingMutation(), null);
  assert.equal(f.state.mutations.length, 1, 'Reconciliation after reload must not resubmit on its own.');
  const retry = second.retryPendingMutation();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.state.mutations[1].payload, f.state.mutations[0].payload);
  f.respond(f.state.mutations[1], { mutation: receipt('same-key'), session: f.state.snapshot });
  assert.equal((await retry).mutation.revisionId, 'revision-same-key');
  assert.equal(f.values.size, 0);
});

test('the retained request is isolated from later caller edits and rejects oversized input before dispatch', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  await assert.rejects(client.request('data.createRecord', { ...payload('large'), values: { text: 'x'.repeat(140_000) } }), /retained/i);
  assert.equal(f.state.mutations.length, 0);
  const mutable = payload('fixed');
  const original = client.request('data.createRecord', mutable);
  mutable.idempotencyKey = 'changed';
  mutable.values['field.title'] = 'Changed after dispatch';
  assert.equal(f.state.mutations[0].payload.idempotencyKey, 'fixed');
  assert.equal(f.state.mutations[0].payload.values['field.title'], 'Keep this exact value');
  f.respond(f.state.mutations[0], { mutation: receipt('fixed'), session: f.state.snapshot });
  await original;
  assert.equal(f.values.size, 0);
});

test('storage failure prevents dispatch and cleanup failure preserves the committed receipt', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  f.state.failStore = true;
  await assert.rejects(client.request('data.createRecord', payload('quota')), /retain|store|save/i);
  assert.equal(f.state.mutations.length, 0);
  f.state.failStore = false;
  const saved = client.request('data.createRecord', payload('cleanup'));
  f.state.failCleanup = true;
  f.respond(f.state.mutations[0], { mutation: receipt('cleanup'), session: f.state.snapshot });
  assert.equal((await saved).mutation.revisionId, 'revision-cleanup');
  assert.equal(client.pendingMutation().state, 'committed');
  f.state.failCleanup = false;
  f.state.receipt = receipt('cleanup');
  await client.retryPendingMutation();
  assert.equal(f.values.size, 0);
});

test('file identity isolates pending requests and stale-generation replies cannot acknowledge the new file', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  const old = client.request('data.createRecord', payload('old')).catch(error => error);
  f.state.snapshot = { ...f.state.snapshot, fileSessionId: 'file-session-two', manifest: { ...f.state.snapshot.manifest, instanceId: 'instance-two' } };
  await client.request('session.getSnapshot');
  assert.equal(client.pendingMutation(), null);
  f.respond(f.state.mutations[0], { mutation: receipt('old'), session: f.state.snapshot });
  assert.equal((await old).code, 'stale-file-session');
  assert.equal(f.values.size, 1, 'The old file keeps its unresolved request.');
  assert.equal(f.requests.filter(item => item.method === 'data.getReceipt').length, 0, 'A stale reply must not look up a receipt in another file.');
});

const proposalInput = { proposalId: 'proposal-recover', expectedOperationDigest: 'a'.repeat(64) };
const proposalReceipt = { changeSetDigest: proposalInput.expectedOperationDigest, revisions: [receipt('proposal')],
  definitionRevision: 2, dataRevision: 1, changeSequence: 3 };

test('proposal acceptance is retained before dispatch and committed acceptance resolves after reload', { timeout: 2000 }, async () => {
  const f = fixture(); const first = f.client(); await first.request('session.getSnapshot');
  const original = first.request('proposal.promote', proposalInput);
  assert.equal(f.values.size, 1);
  assert.deepEqual(first.pendingMutation().payload, proposalInput);
  const reloaded = f.client(); await reloaded.request('session.getSnapshot');
  await assert.rejects(reloaded.request('data.createRecord', payload('duplicate')), /previous|confirm/i);
  f.state.receipt = proposalReceipt;
  const resolved = await reloaded.checkPendingMutation();
  assert.equal(resolved.promotion.applied, true);
  assert.deepEqual(resolved.promotion.result, proposalReceipt);
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.values.size, 0);
  f.respond(f.state.mutations[0], resolved); await original;
});

test('unknown proposal outcome preserves the preview digest and explicit retry can resolve not-applied', { timeout: 2000 }, async () => {
  const f = fixture(); const first = f.client(); await first.request('session.getSnapshot');
  const original = first.request('proposal.promote', proposalInput).catch(error => error);
  f.timeout(); await original;
  assert.equal(f.values.size, 1);
  const reloaded = f.client(); await reloaded.request('session.getSnapshot');
  assert.equal(await reloaded.checkPendingMutation(), null);
  assert.equal(f.state.mutations.length, 1);
  const retry = reloaded.retryPendingMutation(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.state.mutations[1].payload, proposalInput);
  const rejected = { promotion: { proposalId: proposalInput.proposalId, state: 'stale', applied: false,
    message: 'Preview is stale.', result: null }, session: null };
  f.respond(f.state.mutations[1], rejected);
  assert.equal((await retry).promotion.applied, false);
  assert.equal(f.values.size, 0);
});

test('a receipt for different proposal content cannot acknowledge the retained acceptance', { timeout: 2000 }, async () => {
  const f = fixture(); const client = f.client(); await client.request('session.getSnapshot');
  const original = client.request('proposal.promote', proposalInput).catch(error => error);
  f.timeout(); await original;
  f.state.receipt = { ...proposalReceipt, changeSetDigest: 'b'.repeat(64) };
  await assert.rejects(client.checkPendingMutation(), /digest|different|match/i);
  assert.equal(f.values.size, 1);
  assert.equal(f.state.mutations.length, 1);
});

// --- Host events -----------------------------------------------------------
// A message the host sends on its own account, so a Windows notification can put
// somebody back on the view that needed them.

test('a host navigate event reaches its listener', { timeout: 2000 }, async () => {
  const f = fixture(); const client = f.client();
  const seen = [];
  client.onNavigate(route => seen.push(route));
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'agent' });
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'health' });
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'studio' });
  assert.deepEqual(seen, ['agent', 'health', 'studio']);
});

test('a host event cannot name a route the router does not have', { timeout: 2000 }, async () => {
  const f = fixture(); const client = f.client();
  const seen = [];
  client.onNavigate(route => seen.push(route));
  for (const payload of ['data', 'unknown', '', null, 42, { view: 'agent' }]) {
    f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload });
  }
  f.deliver({ protocolVersion: module.protocolVersion, event: 'detonate', payload: 'agent' });
  assert.deepEqual(seen, []);
});

test('a custom-view frame failure is heard only for the open file and for frames the Workbench named', async () => {
  const f = fixture(); const client = f.client(); await client.request('session.getSnapshot');
  const seen = []; client.onExtensionFramesFailed(failed => seen.push(failed));
  // A crash takes every frame of the package with it, so the host names them all (spike S4).
  const failed = { fileSessionId: 'file-session-one', frames: ['nendo-view-0a1b2c3d4e5f', 'nendo-view-ffffffffffff'] };
  for (const payload of [null, {}, { ...failed, fileSessionId: 'old' }, { ...failed, frames: [] }, { ...failed, frames: 'nendo-view-0a1b2c3d4e5f' },
    { ...failed, frames: ['nendo-view-1'] }, { ...failed, frames: ['workbench'] }, { ...failed, frames: ['nendo-view-0A1B2C3D4E5F'] },
    { ...failed, frames: [...failed.frames, 42] }, { ...failed, frames: Array(257).fill('nendo-view-0a1b2c3d4e5f') }]) {
    f.deliver({ protocolVersion: module.protocolVersion, event: 'extensionFramesFailed', payload });
  }
  assert.deepEqual(seen, []);
  f.deliver({ protocolVersion: module.protocolVersion, event: 'extensionFramesFailed', payload: failed });
  assert.deepEqual(seen, [failed]);
  // The events the helper sent are gone with it: nothing listens for them any more.
  assert.equal(typeof client.onOpenRecord, 'undefined');
  assert.equal(typeof client.onExtensionPanelStopped, 'undefined');
});

test('a host event from another protocol version is ignored', { timeout: 2000 }, async () => {
  const f = fixture(); const client = f.client();
  const seen = [];
  client.onNavigate(route => seen.push(route));
  f.deliver({ protocolVersion: module.protocolVersion - 1, event: 'navigate', payload: 'agent' });
  assert.deepEqual(seen, []);
});

test('a host event never resolves a pending request', { timeout: 2000 }, async () => {
  const f = fixture(); const client = f.client();
  const pending = client.request('session.getSnapshot');
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'agent' });
  // The snapshot reply is what resolves it; the event in between changed nothing.
  f.respond(f.requests[0], f.state.snapshot);
  assert.equal((await pending).fileName, 'fixture.nendo');
});

test('removing a listener stops it hearing events, and one that throws does not silence the rest',
  { timeout: 2000 }, async () => {
    const f = fixture(); const client = f.client();
    const seen = [];
    const stop = client.onNavigate(() => { throw new Error('listener failed'); });
    client.onNavigate(route => seen.push(route));
    f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'agent' });
    assert.deepEqual(seen, ['agent']);
    stop();
    f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'health' });
    assert.deepEqual(seen, ['agent', 'health']);
  });
