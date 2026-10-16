import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { bundleOf } from './bundle-of.mjs';

// Compile the shipped TypeScript adapter with the pinned production toolchain;
// use Node's test runner and a deterministic bridge, without a second UI stack.
const bundle = await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true },
  build: { ssr: 'src/host.ts', write: false, minify: false, rollupOptions: { output: { codeSplitting: false } } } });
const module = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

function fixture({ hold = false } = {}) {
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
    if (hold) return;
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

test('R02-013: a lost hierarchy move response survives reload, blocks a new key and retries the exact move', { timeout: 2000 }, async () => {
  const f = fixture(); const first = f.client(); await first.request('session.getSnapshot');
  const move = { entityId: 'work', recordId: 'child', expectedRecordVersion: 7, parentRecordId: 'parent',
    expectedParentVersion: 3, beforeRecordId: 'sibling', idempotencyKey: 'move-original' };
  const original = first.request('data.moveRecord', move).catch(error => error);
  assert.equal(f.values.size, 1, 'The hierarchy move was dispatched without retaining its exact retry request.');
  f.timeout(); await original;
  const reloaded = f.client(); await reloaded.request('session.getSnapshot');
  assert.deepEqual(reloaded.pendingMutation().payload, move);
  assert.equal(reloaded.pendingMutation().method, 'data.moveRecord');
  await assert.rejects(reloaded.request('data.moveRecord', { ...move, idempotencyKey: 'move-new' }), /previous|pending|confirm/i);
  assert.equal(await reloaded.checkPendingMutation(), null);
  assert.equal(f.state.mutations.length, 1, 'Receipt lookup resubmitted an unresolved move.');
  const retry = reloaded.retryPendingMutation(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.mutations[1].method, 'data.moveRecord');
  assert.deepEqual(f.state.mutations[1].payload, move);
  f.respond(f.state.mutations[1], { mutation: receipt('move-original'), session: f.state.snapshot });
  assert.equal((await retry).mutation.revisionId, 'revision-move-original');
  assert.equal(f.values.size, 0);
});

test('R02-013: a committed move is resolved by receipt after timeout and reload without resubmission', { timeout: 2000 }, async () => {
  const f = fixture(); const first = f.client(); await first.request('session.getSnapshot');
  const original = first.request('data.moveRecord', { entityId: 'work', recordId: 'child', expectedRecordVersion: 7,
    parentRecordId: null, beforeRecordId: null, idempotencyKey: 'move-committed' }).catch(error => error);
  f.timeout(); await original;
  assert.equal(f.values.size, 1, 'The timed-out move lost its request before receipt reconciliation.');
  const reloaded = f.client(); await reloaded.request('session.getSnapshot');
  f.state.receipt = receipt('move-committed');
  const recovered = await reloaded.checkPendingMutation();
  assert.equal(recovered.mutation.revisionId, 'revision-move-committed');
  assert.equal(f.requests.at(-1).method, 'data.getReceipt');
  assert.deepEqual(f.requests.at(-1).payload, { idempotencyKey: 'move-committed' });
  assert.equal(f.state.mutations.length, 1, 'A committed move was submitted again.');
  assert.equal(f.values.size, 0);
});

test('R02-013: definitive hierarchy refusals release the retained request', { timeout: 2000 }, async () => {
  for (const code of ['hierarchy-not-declared', 'hierarchy-order-not-declared', 'hierarchy-sibling-not-found',
    'hierarchy-cycle', 'hierarchy-too-deep', 'move-unchanged']) {
    const f = fixture(); const client = f.client(); await client.request('session.getSnapshot');
    const failed = client.request('data.moveRecord', { entityId: 'work', recordId: 'child', expectedRecordVersion: 7,
      parentRecordId: null, beforeRecordId: null, idempotencyKey: 'refused-move' }).catch(error => error);
    f.respond(f.state.mutations[0], null, { code, message: 'Move refused before commit.' });
    assert.equal((await failed).code, code);
    assert.equal(f.values.size, 0, `${code} left a known refusal marked as an unconfirmed move.`);
  }
});

test('the retained request is isolated from later caller edits and rejects oversized input before dispatch', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  await assert.rejects(client.request('data.createRecord', { ...payload('large'), values: { text: 'x'.repeat(300_000) } }), /too large/i);
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

// WCS-02. A save the journal refused before sending it -- too large for it, or local storage
// that would not take it -- was a plain error, so the record form was redrawn from stored values
// and the typing was gone, under a sentence that blamed local storage for a size limit. The cap
// was half what the host accepts. Measured through the real host adapter and the real
// write-failure rule the record form uses.
const { decideWriteFailure } = await bundleOf('src/write-failure.ts');

test('WCS-02: a save the host would take is sent, and one refused before sending keeps the typing and says why', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  const long = client.request('data.setFields', { ...payload('long'), values: { 'field.body': 'x'.repeat(140_000) } });
  assert.equal(f.state.mutations.length, 1, 'a 140,000-character Markdown save the host accepts was refused here');
  f.respond(f.state.mutations[0], { mutation: receipt('long'), session: f.state.snapshot });
  await long;

  const tooLarge = await client.request('data.setFields', { ...payload('huge'), values: { 'field.body': 'x'.repeat(300_000) } }).catch(error => error);
  assert.equal(f.state.mutations.length, 1, 'an oversized save was sent');
  assert.equal(decideWriteFailure(tooLarge), 'retain-draft', 'a save refused before sending redrew the form and lost the typing');
  assert.match(tooLarge.message, /too large[\s\S]*300\D?\d{3} characters[\s\S]*Nothing was sent/);
  assert.doesNotMatch(tooLarge.message, /storage/i, 'a size refusal blamed local storage');

  f.state.failStore = true;
  const unkept = await client.request('data.setFields', payload('unkept')).catch(error => error);
  f.state.failStore = false;
  assert.equal(f.state.mutations.length, 1);
  assert.equal(decideWriteFailure(unkept), 'retain-draft', 'a save local storage would not keep lost the typing');
  assert.match(unkept.message, /nothing was sent/i);
});

// WCS-22. Stop on a slow save left it pending, and the only control that unlocked editing sent
// the save the person had stopped. Now a save the host answers as cancelled, whose receipt is then
// not found, can be discarded unsent; the receipt is looked up again first.
test('WCS-22: a stopped save that did not land can be discarded without sending it', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  const stopped = client.request('data.setFields', payload('stopped')).catch(error => error);
  f.respond(f.state.mutations[0], null, { code: 'cancelled', message: 'The request was stopped.' });
  assert.equal((await stopped).code, 'cancelled');
  assert.equal(client.pendingMutation().state, 'pending', 'a stop is not a confirmed refusal: the save stays retained');
  assert.equal(client.pendingMutation().discardable, true, 'a stopped save with no receipt offers no way but resending it');
  const lookups = () => f.requests.filter(request => request.method === 'data.getReceipt').length;
  const before = lookups();
  assert.equal(await client.discardPendingMutation(), null);
  assert.equal(lookups(), before + 1, 'the discard did not check the receipt once more');
  assert.equal(f.values.size, 0, 'the discarded request is still retained');
  assert.equal(f.state.mutations.length, 1, 'discarding sent the stopped save');
  // Editing is open again: the next save goes.
  const next = client.request('data.setFields', payload('next'));
  assert.equal(f.state.mutations.length, 2);
  f.respond(f.state.mutations[1], { mutation: receipt('next'), session: f.state.snapshot });
  await next;
});

test('WCS-22: a stopped save that landed after all is acknowledged, and a timed-out one cannot be discarded', { timeout: 2000 }, async () => {
  const f = fixture();
  const client = f.client();
  await client.request('session.getSnapshot');
  const stopped = client.request('data.setFields', payload('late')).catch(error => error);
  f.respond(f.state.mutations[0], null, { code: 'cancelled', message: 'The request was stopped.' });
  await stopped;
  f.state.receipt = receipt('late');
  const landed = await client.discardPendingMutation();
  assert.equal(landed.mutation.revisionId, 'revision-late', 'a save that committed was discarded as unsent');
  assert.equal(f.values.size, 0);

  // A request the host never answered may still be running there: nothing confirms it stopped.
  f.state.receipt = null;
  const lost = client.request('data.setFields', payload('lost')).catch(error => error);
  f.timeout();
  assert.equal((await lost).code, 'host-timeout');
  assert.notEqual(client.pendingMutation().discardable, true, 'a save the host may still be running was offered as discardable');
  await assert.rejects(client.discardPendingMutation(), /only a save that was stopped/i);
  assert.equal(f.values.size, 1);
});

// WCS-03. A raw copy or a backup keeps the file's application and instance IDs, so it found the
// original's unconfirmed save under the same key, and Check or retry wrote it into the copy. The
// request now carries the file it was made in, and is sent only there.
test('WCS-03: an unconfirmed save is not replayed into a copy of its file, and is in the file it was made in', { timeout: 2000 }, async () => {
  const f = fixture();
  const original = f.client();
  await original.request('session.getSnapshot');
  const lost = original.request('data.setFields', payload('original')).catch(error => error);
  f.timeout();
  assert.equal((await lost).code, 'host-timeout');
  assert.equal(f.state.mutations.length, 1);
  const made = original.pendingMutation();
  assert.equal(made.fileName, 'fixture.nendo');
  assert.ok(!Number.isNaN(Date.parse(made.savedAt)), 'the kept save does not say when it was made');

  const originalSnapshot = f.state.snapshot;
  f.state.snapshot = { ...originalSnapshot, fileSessionId: 'file-session-copy', fileName: 'fixture (backup).nendo' };
  const copy = f.client();
  await copy.request('session.getSnapshot');
  assert.equal(copy.pendingMutation().payload.idempotencyKey, 'original', 'the copy shares the identity, so it sees the kept save');
  const intoCopy = copy.retryPendingMutation().catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.mutations.length, 1, 'Check or retry sent the original file’s save into its copy');
  assert.match((await intoCopy).message, /made in fixture\.nendo, not in fixture \(backup\)\.nendo/);

  f.state.snapshot = { ...originalSnapshot, fileSessionId: 'file-session-reopened' };
  const reopened = f.client();
  await reopened.request('session.getSnapshot');
  const retried = reopened.retryPendingMutation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.mutations.length, 2, 'the save is not retried in the file it was made in');
  f.respond(f.state.mutations[1], { mutation: receipt('original'), session: f.state.snapshot });
  await retried;
  assert.equal(f.values.size, 0);
});

// WCS-03, after review: an exact name match stranded a save after a rename or a change of letter
// case. Windows names a file without regard to case, and a renamed file is the person's to name.
test('WCS-03: a name that differs only in case is the same file, and a renamed one is the person’s choice, never a dead end', { timeout: 2000 }, async () => {
  const f = fixture();
  const original = f.client();
  await original.request('session.getSnapshot');
  const lost = original.request('data.setFields', payload('cased')).catch(error => error);
  f.timeout();
  await lost;
  const originalSnapshot = f.state.snapshot;

  f.state.snapshot = { ...originalSnapshot, fileSessionId: 'file-session-cased', fileName: 'FIXTURE.NENDO' };
  const cased = f.client();
  await cased.request('session.getSnapshot');
  assert.notEqual(cased.pendingMutation().madeElsewhere, true, 'a change of letter case was taken for another file');
  const retried = cased.retryPendingMutation().catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.mutations.length, 2, 'a save was stranded by a change of letter case in its file’s name');
  f.respond(f.state.mutations[1], { mutation: receipt('cased'), session: f.state.snapshot });
  await retried;

  // A rename: neither sent nor dropped on its own, and both ways out are there.
  f.state.snapshot = originalSnapshot;
  const before = f.client();
  await before.request('session.getSnapshot');
  const second = before.request('data.setFields', payload('renamed')).catch(error => error);
  f.timeout();
  await second;
  f.state.snapshot = { ...originalSnapshot, fileSessionId: 'file-session-renamed', fileName: 'Renamed.nendo' };
  const renamed = f.client();
  await renamed.request('session.getSnapshot');
  assert.equal(renamed.pendingMutation().madeElsewhere, true);
  const sent = renamed.retryPendingMutation(true).catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.mutations.length, 4, 'the person said this is the file renamed, and the save was not sent into it');
  f.respond(f.state.mutations[3], { mutation: receipt('renamed'), session: f.state.snapshot });
  await sent;
  assert.equal(f.values.size, 0);

  // A copy: the person discards it here; the receipt is looked up first, and nothing is sent.
  f.state.snapshot = originalSnapshot;
  const third = f.client();
  await third.request('session.getSnapshot');
  const kept = third.request('data.setFields', payload('copied')).catch(error => error);
  f.timeout();
  await kept;
  f.state.snapshot = { ...originalSnapshot, fileSessionId: 'file-session-copy-2', fileName: 'Copy of fixture.nendo' };
  const copy = f.client();
  await copy.request('session.getSnapshot');
  assert.equal(await copy.discardPendingMutation(), null, 'a save made in another file could not be discarded, so the copy stayed locked');
  assert.equal(f.values.size, 0);
  assert.equal(f.state.mutations.length, 5, 'discarding sent the save');
});

test('a host navigate event reaches its listener', { timeout: 2000 }, async () => {
  const f = fixture(); const client = f.client();
  const seen = [];
  client.onNavigate(route => seen.push(route));
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'agent' });
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'health' });
  f.deliver({ protocolVersion: module.protocolVersion, event: 'navigate', payload: 'studio' });
  assert.deepEqual(seen, ['agent', 'health', 'studio']);
});

test('R30-014: a device custom-view switch event reaches live windows without a data revision change', () => {
  const f = fixture(); const client = f.client(); let heard = 0;
  assert.equal(typeof client.onExtensionSettingsChanged, 'function', 'The host adapter must expose device switch events.');
  client.onExtensionSettingsChanged(() => { throw new Error('An unrelated listener failed.'); });
  const stop = client.onExtensionSettingsChanged(() => heard++);
  f.deliver({ protocolVersion: module.protocolVersion - 1, event: 'extensionSettingsChanged', payload: null });
  assert.equal(heard, 0, 'A different protocol version was heard.');
  f.deliver({ protocolVersion: module.protocolVersion, event: 'extensionSettingsChanged', payload: null });
  assert.equal(heard, 1, 'The live device switch was not heard.');
  stop();
  f.deliver({ protocolVersion: module.protocolVersion, event: 'extensionSettingsChanged', payload: null });
  assert.equal(heard, 1, 'A removed listener still heard a switch.');
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
  // WST-04. The fixture once answered the snapshot as it was sent, so the event arrived after the
  // request had settled and this could not fail. The bridge here answers nothing on its own: the
  // event is delivered while the read and a journaled save are really waiting.
  const f = fixture({ hold: true }); const client = f.client();
  const first = client.request('session.getSnapshot');
  f.respond(f.requests[0], f.state.snapshot);
  await first;
  const settled = [];
  const pending = client.request('session.getSnapshot').then(value => { settled.push('read'); return value; });
  const save = client.request('data.setFields', payload('waiting')).then(value => { settled.push('save'); return value; });
  assert.equal(f.requests.length, 3);
  for (const event of [{ event: 'navigate', payload: 'agent' }, { event: 'fileChanged', payload: 4 }, { event: 'agentActivity', payload: { busy: true, client: 'agent', activity: 'x' } }])
    f.deliver({ protocolVersion: module.protocolVersion, ...event });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(settled, [], 'a host event resolved a request that was still waiting for its answer');
  assert.equal(client.pendingMutation().state, 'pending');
  // The replies are what resolve them.
  f.respond(f.requests[1], f.state.snapshot);
  f.respond(f.requests[2], { mutation: receipt('waiting'), session: f.state.snapshot });
  assert.equal((await pending).fileName, 'fixture.nendo');
  assert.equal((await save).mutation.revisionId, 'revision-waiting');
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
