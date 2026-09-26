import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'vite';

// The broker between custom views and the Workbench (ADR-0013), driven through the real
// module with a stand-in for the window, the frame and the host bridge. What a view can do is
// exactly the method table, so the table is pinned; the rest measures the handshake's two
// checks, the bounds, and the shape of what a view reads.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const broker = await bundleOf('src/extension-broker.ts');
const model = await bundleOf('src/extension-model.ts');

const origin = 'https://org-example-glance-3f2a9c01be.example';
const hello = { nendo: 'hello', apiVersion: 1 };
const context = { apiVersion: 1, viewId: 'view.glance', packageId: 'org.example.glance', readOnly: false, methods: ['records.count'], bindings: { fields: [], filters: [] } };

function harness() {
  const posted = [];
  const frameWindow = { postMessage: (message, targetOrigin, transfer) => posted.push({ message, targetOrigin, transfer }) };
  const otherWindow = { postMessage: () => { throw new Error('A window this Workbench did not mount was answered.'); } };
  const mount = { key: 'mount-1', origin, frameWindow: () => frameWindow };
  const h = { posted, frameWindow, otherWindow, mount, calls: [], pending: [], timers: [], toasts: [], responsive: [], now: 0, running: true, heights: [], opened: [], canOpen: true };
  h.broker = broker.createExtensionBroker({
    request: (method, payload) => {
      h.calls.push({ method, payload });
      return new Promise((resolve, reject) => h.pending.push({ resolve, reject }));
    },
    mounts: () => [mount],
    running: () => h.running,
    context: () => h.context ?? context,
    describe: () => ({ purpose: null, changeSequence: 1, entities: [], screens: [], commands: [] }),
    ui: {
      openRecord: async (_mount, target) => ({ opened: true, target }),
      openScreen: async () => ({ opened: true }),
      openStudio: async () => ({ opened: true }),
      toast: (_mount, text) => h.toasts.push(text),
      setHeight: (_mount, pixels) => { h.heights.push(pixels); return pixels; },
      openProposal: (_mount, preview) => { h.opened.push(preview); return { opened: h.canOpen }; },
    },
    responsive: (_mount, responsive) => h.responsive.push(responsive),
    now: () => h.now,
    later: (callback, milliseconds) => h.timers.push({ at: h.now + milliseconds, callback }),
  });
  return h;
}

/** Connect the frame and answer as the view does: the port the broker transferred, with an inbox. */
function connect(h) {
  h.broker.receive({ source: h.frameWindow, origin: h.mount.origin, data: hello });
  const port = h.posted.at(-1).transfer[0];
  const inbox = [];
  port.onmessage = (event) => inbox.push(event.data);
  return {
    port, inbox,
    send: (message) => port.postMessage(message),
    next: (predicate) => until(() => inbox.find(predicate), `a message for the view; it has ${JSON.stringify(inbox).slice(0, 300)}`),
  };
}

async function until(probe, what = 'the condition') {
  const deadline = Date.now() + 3000;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** Close every port the broker ever handed out, so that a failing test cannot hold the run open. */
function close(h) {
  h.broker.disconnect(h.mount);
  for (const { transfer } of h.posted) for (const port of transfer ?? []) port.close();
}

// proposal.get reads a proposal the view's own package prepared, and nothing else.
const readMethods = ['data.queryRecords', 'data.countRecords', 'data.aggregateRecords', 'data.groupAggregateRecords', 'data.bucketAggregateRecords', 'data.cellAggregateRecords', 'proposal.get', 'extension.state.read'];
// The record writes a person's own edit uses, and preparing a proposal (ADR-0013 Phase 3,
// W-065 and W-069). The host admits a view's actor on exactly these and on proposal.get
// (WorkbenchMethods.ExtensionWriterMethods). Never promote or reject.
const writeMethods = ['data.createRecord', 'data.setFields', 'data.deleteRecord', 'data.executeCommand', 'proposal.prepareChangeSet', 'extension.state.set'];

test('the method table is closed: reads, the record writes, preparing a proposal, and no promote, reject, approve, file, session or agent method', () => {
  const expected = [
    ['schema.describe', null],
    ['records.query', 'data.queryRecords'],
    ['records.get', 'data.queryRecords'],
    ['records.count', 'data.countRecords'],
    ['records.aggregate', 'data.aggregateRecords'],
    ['records.groupAggregate', 'data.groupAggregateRecords'],
    ['records.bucketAggregate', 'data.bucketAggregateRecords'],
    ['records.cellAggregate', 'data.cellAggregateRecords'],
    ['records.create', 'data.createRecord'],
    ['records.update', 'data.setFields'],
    ['records.delete', 'data.deleteRecord'],
    ['commands.run', 'data.executeCommand'],
    ['proposals.prepare', 'proposal.prepareChangeSet'],
    ['proposals.get', 'proposal.get'],
    ['proposals.open', 'proposal.get'],
    ['state.get', 'extension.state.read'],
    ['state.keys', 'extension.state.read'],
    ['state.set', 'extension.state.set'],
    ['state.delete', 'extension.state.set'],
    ['ui.openRecord', null],
    ['ui.openScreen', null],
    ['ui.openStudio', null],
    ['ui.toast', null],
    ['ui.setHeight', null],
  ];
  const table = broker.brokerTable();
  assert.deepEqual(table.map(({ method, host }) => [method, host]), expected);
  assert.deepEqual([...broker.brokerMethodNames], expected.map(([method]) => method));
  for (const { method, host, writes } of table) {
    assert.doesNotMatch(method, /^(proposal|behaviour|agent|file|session|appearance|history|extension|data)\./, method);
    assert.doesNotMatch(method, /promote|reject|approve|remove|import|compensate|commit|grant|lease/i, method);
    if (writes) assert.ok(writeMethods.includes(host), `${method} writes through ${host}, which is not one of the record writes.`);
    else {
      assert.doesNotMatch(method, /create|update|delete|execute|write|run/i, method);
      if (host !== null) assert.ok(readMethods.includes(host), `${method} becomes ${host}, which is not one of the host's reads.`);
    }
  }
  assert.deepEqual([...new Set(table.filter((entry) => entry.writes).map((entry) => entry.host))], writeMethods);
});

test('a write goes to the host as the mount\u2019s package, never as anything the view names, with a fresh key, and answers the record', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  const record = { entityId: 'tasks', recordId: 't1', recordVersion: 4, values: { title: 'Done', estimate: { $nendoNumber: '12.50' } } };
  view.send({ t: 'req', id: 1, m: 'records.update', p: {
    entityId: 'tasks', recordId: 't1', version: 3, actor: 'extension:someone-else', idempotencyKey: 'replay-me',
    values: { title: 'Done', estimate: { $nendoNumber: '12.50' }, count: 2 },
  } });
  await until(() => h.calls.length === 1, 'the host write');
  const { method, payload } = h.calls[0];
  assert.equal(method, 'data.setFields');
  assert.equal(payload.actor, 'extension:org.example.glance', 'The write was not made in the name of the mount\u2019s package.');
  assert.match(payload.idempotencyKey, /^view-[0-9a-f-]{36}$/, 'The view chose its own idempotency key.');
  assert.deepEqual({ ...payload, idempotencyKey: undefined, actor: undefined }, {
    entityId: 'tasks', recordId: 't1', expectedRecordVersion: 3, idempotencyKey: undefined, actor: undefined,
    values: { title: 'Done', estimate: { $nendoNumber: '12.50' }, count: { $nendoNumber: '2' } },
  });
  h.pending[0].resolve({ mutation: { changeSequence: 10 }, session: null });
  await until(() => h.calls.length === 2, 'the read back');
  assert.deepEqual(h.calls[1], { method: 'data.queryRecords', payload: { entityId: 'tasks', recordId: 't1', limit: 1 } });
  h.pending[1].resolve({ items: [record] });
  const answered = await view.next((message) => message.id === 1);
  assert.equal(answered.ok, true);
  assert.equal(answered.r.version, 4);
  assert.equal(answered.r.exact.estimate, '12.50');

  view.send({ t: 'req', id: 2, m: 'records.update', p: { entityId: 'tasks', recordId: 't1', version: 4, values: { title: 'Again' } } });
  await until(() => h.calls.length === 3, 'a second write');
  assert.notEqual(h.calls[2].payload.idempotencyKey, payload.idempotencyKey, 'Two writes shared one key, so the second would replay the first.');
  h.pending[2].resolve({});
  await until(() => h.calls.length === 4, 'its read back');
  h.pending[3].resolve({ items: [] });
  assert.equal((await view.next((message) => message.id === 2)).r, null);

  view.send({ t: 'req', id: 3, m: 'records.delete', p: { entityId: 'tasks', recordId: 't1', version: 5 } });
  await until(() => h.calls.length === 5, 'the delete');
  assert.deepEqual({ ...h.calls[4].payload, idempotencyKey: undefined },
    { entityId: 'tasks', recordId: 't1', expectedRecordVersion: 5, actor: 'extension:org.example.glance', idempotencyKey: undefined });
  h.pending[4].resolve({});
  assert.equal((await view.next((message) => message.id === 3)).r, null);
  await settle();
  assert.equal(h.calls.length, 5, 'A delete read the record back.');

  view.send({ t: 'req', id: 4, m: 'commands.run', p: { commandId: 'page.done', entityId: 'tasks', recordId: 't2', version: 1 } });
  await until(() => h.calls.length === 6, 'the command');
  assert.equal(h.calls[5].method, 'data.executeCommand');
  assert.equal(h.calls[5].payload.commandId, 'page.done');
  assert.equal(h.calls[5].payload.expectedRecordVersion, 1);
});

// R-002: the host refuses a non-null reference without the target's version
// (target-version-required), so a view's create and update must carry the map to it.
test('a create and an update that set a reference carry each target’s version to the host as expectedTargetVersions', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'records.create', p: {
    entityId: 'tasks', recordId: 't9', values: { title: 'Cure the slab', owner: 'p1' }, targetVersions: { owner: 7 },
  } });
  await until(() => h.calls.length === 1, 'the create');
  assert.equal(h.calls[0].method, 'data.createRecord');
  assert.deepEqual({ ...h.calls[0].payload, idempotencyKey: undefined }, {
    entityId: 'tasks', recordId: 't9', values: { title: 'Cure the slab', owner: 'p1' }, expectedTargetVersions: { owner: 7 },
    idempotencyKey: undefined, actor: 'extension:org.example.glance',
  });
  h.pending[0].resolve({});
  await until(() => h.calls.length === 2, 'the read back');
  h.pending[1].resolve({ items: [] });
  await view.next((message) => message.id === 1);

  view.send({ t: 'req', id: 2, m: 'records.update', p: {
    entityId: 'tasks', recordId: 't9', version: 1, values: { owner: 'p2', reviewer: null }, targetVersions: { owner: 3 },
  } });
  await until(() => h.calls.length === 3, 'the update');
  assert.equal(h.calls[2].method, 'data.setFields');
  assert.deepEqual({ ...h.calls[2].payload, idempotencyKey: undefined }, {
    entityId: 'tasks', recordId: 't9', expectedRecordVersion: 1, values: { owner: 'p2', reviewer: null }, expectedTargetVersions: { owner: 3 },
    idempotencyKey: undefined, actor: 'extension:org.example.glance',
  });
  h.pending[2].resolve({});
  await until(() => h.calls.length === 4, 'its read back');
  h.pending[3].resolve({ items: [] });
  await view.next((message) => message.id === 2);

  // A write that sets no reference sends no map, and a view's own expectedTargetVersions is not passed on.
  view.send({ t: 'req', id: 3, m: 'records.update', p: {
    entityId: 'tasks', recordId: 't9', version: 2, values: { title: 'x' }, expectedTargetVersions: { title: 1 },
  } });
  await until(() => h.calls.length === 5, 'the plain update');
  assert.equal('expectedTargetVersions' in h.calls[4].payload, false, 'A map the broker did not rebuild reached the host.');
  h.pending[4].resolve({});
  await until(() => h.calls.length === 6, 'its read back');
  h.pending[5].resolve({ items: [] });
  await view.next((message) => message.id === 3);

  const refusals = [
    [4, 'records.create', { entityId: 'tasks', values: { owner: 'p1' }, targetVersions: { owner: 0 } }],
    [5, 'records.create', { entityId: 'tasks', values: { owner: 'p1' }, targetVersions: { owner: '7' } }],
    [6, 'records.create', { entityId: 'tasks', values: { owner: 'p1' }, targetVersions: { reviewer: 7 } }],
    [7, 'records.update', { entityId: 'tasks', recordId: 't9', version: 3, values: { owner: 'p1' }, targetVersions: [7] }],
  ];
  for (const [id, m, p] of refusals) {
    view.send({ t: 'req', id, m, p });
    assert.equal((await view.next((message) => message.id === id)).e.code, 'invalid-params', `${m} ${JSON.stringify(p)}`);
  }
  await settle();
  assert.equal(h.calls.length, 6, 'A refused target version reached the host.');
});

test('a view prepares a proposal as its package, which opens in the review; it reads only its own, and cannot promote or reject', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  const operation = { operationType: 'schema.addField', payload: { entityId: 'tasks', fieldId: 'due' } };
  view.send({ t: 'req', id: 1, m: 'proposals.prepare', p: {
    title: 'Add a due date', operations: [operation], actor: 'extension:someone-else', proposalId: 'proposal-chosen-by-the-view',
  } });
  await until(() => h.calls.length === 1, 'the prepared proposal');
  const { method, payload } = h.calls[0];
  assert.equal(method, 'proposal.prepareChangeSet');
  assert.equal(payload.actor, 'extension:org.example.glance', 'The proposal was not prepared in the name of the mount\u2019s package.');
  assert.match(payload.proposalId, /^proposal-[0-9a-f]{32}$/, 'The view chose its own proposal ID.');
  assert.equal(payload.title, 'Add a due date');
  assert.equal(payload.mutations.length, 1);
  assert.match(payload.mutations[0].idempotencyKey, /^view-[0-9a-f-]{36}$/);
  assert.match(payload.mutations[0].operations[0].operationId, /^view-op-[0-9a-f]{32}$/);
  assert.deepEqual({ ...payload.mutations[0].operations[0], operationId: undefined }, { ...operation, operationId: undefined });
  const preview = { proposalId: payload.proposalId, title: 'Add a due date', state: 3, diagnostics: [], origin: 'extension:org.example.glance', semanticDiff: [{ summary: 'x' }] };
  h.pending[0].resolve(preview);
  const answered = await view.next((message) => message.id === 1);
  assert.deepEqual(answered.r, { proposalId: payload.proposalId, title: 'Add a due date', state: 'previewable', diagnostics: [], opened: true });
  assert.deepEqual(h.opened, [preview], 'The prepared proposal did not open in the review.');

  view.send({ t: 'req', id: 2, m: 'proposals.get', p: { proposalId: payload.proposalId, actor: 'extension:someone-else' } });
  await until(() => h.calls.length === 2, 'the proposal read');
  assert.deepEqual(h.calls[1], { method: 'proposal.get', payload: { proposalId: payload.proposalId, actor: 'extension:org.example.glance' } });
  h.pending[1].resolve({ ...preview, state: 'Active' });
  assert.equal((await view.next((message) => message.id === 2)).r.state, 'active');

  h.canOpen = false;
  view.send({ t: 'req', id: 3, m: 'proposals.open', p: { proposalId: payload.proposalId } });
  await until(() => h.calls.length === 3, 'the proposal read for open');
  h.pending[2].resolve(preview);
  assert.equal((await view.next((message) => message.id === 3)).r.opened, false, 'A refused open was reported as opened.');

  for (const [id, name] of [[4, 'proposals.promote'], [5, 'proposals.reject'], [6, 'proposal.promote']]) {
    view.send({ t: 'req', id, m: name, p: { proposalId: payload.proposalId } });
    const refused = await view.next((message) => message.id === id);
    assert.equal(refused.ok, false, `${name} was answered.`);
  }
  await settle();
  assert.equal(h.calls.length, 3, 'A promote or reject reached the host.');

  h.context = { ...context, readOnly: true };
  view.send({ t: 'req', id: 7, m: 'proposals.prepare', p: { title: 'x', operations: [operation] } });
  assert.equal((await view.next((message) => message.id === 7)).e.code, 'read-only');
  h.context = context;
  view.send({ t: 'req', id: 8, m: 'proposals.prepare', p: { title: 'x', operations: [] } });
  assert.equal((await view.next((message) => message.id === 8)).e.code, 'invalid-params');
  await settle();
  assert.equal(h.calls.length, 3, 'A refused proposal reached the host.');
});

test('a view keeps state as its package, in its own view or the package\u2019s shared place, at most two writes a second', async (t) => {
  const h = harness();
  h.context = { ...context, title: 'Glance' };
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'state.set', p: { key: 'zoom', value: { level: 2 }, actor: 'extension:someone-else', viewId: 'another.view' } });
  await until(() => h.calls.length === 1, 'the state write');
  const { method, payload } = h.calls[0];
  assert.equal(method, 'extension.state.set');
  assert.equal(payload.actor, 'extension:org.example.glance', 'State was kept in another package\u2019s name.');
  assert.equal(payload.viewId, 'view.glance', 'The view chose where its state is kept.');
  assert.deepEqual({ ...payload, idempotencyKey: undefined, actor: undefined }, {
    viewId: 'view.glance', key: 'zoom', value: { level: 2 }, description: 'Keep zoom for the view Glance', idempotencyKey: undefined, actor: undefined,
  });
  h.pending[0].resolve({});
  await until(() => h.calls.length === 2, 'the read back');
  assert.deepEqual(h.calls[1], { method: 'extension.state.read', payload: { viewId: 'view.glance', key: 'zoom', actor: 'extension:org.example.glance' } });
  h.pending[1].resolve({ entries: [{ key: 'zoom', value: { level: 2 }, version: 1 }] });
  assert.deepEqual((await view.next((message) => message.id === 1)).r, { key: 'zoom', value: { level: 2 }, version: 1 });

  view.send({ t: 'req', id: 2, m: 'state.delete', p: { key: 'shared', scope: 'package', expectedVersion: 3 } });
  await until(() => h.calls.length === 3, 'the shared removal');
  assert.deepEqual({ ...h.calls[2].payload, idempotencyKey: undefined }, {
    viewId: '', key: 'shared', value: null, expectedVersion: 3, description: 'Forget shared for the views of org.example.glance',
    idempotencyKey: undefined, actor: 'extension:org.example.glance',
  });
  h.pending[2].resolve({});
  assert.equal((await view.next((message) => message.id === 2)).r, null);

  // Two writes in this second already; a third is refused before the host is asked.
  view.send({ t: 'req', id: 3, m: 'state.set', p: { key: 'zoom', value: 3 } });
  assert.equal((await view.next((message) => message.id === 3)).e.code, 'busy');
  h.now += 1_001;
  view.send({ t: 'req', id: 4, m: 'state.set', p: { key: 'zoom', value: 3, scope: 'everyone' } });
  assert.equal((await view.next((message) => message.id === 4)).e.code, 'invalid-params');
  h.context = { ...context, readOnly: true };
  view.send({ t: 'req', id: 5, m: 'state.set', p: { key: 'zoom', value: 3 } });
  assert.equal((await view.next((message) => message.id === 5)).e.code, 'read-only');
  await settle();
  assert.equal(h.calls.length, 3, 'A refused state write reached the host.');
});

test('a write is refused before the host is asked when the file is read-only or the parameters are wrong', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  const refusals = [
    [1, 'records.update', { entityId: 'tasks', recordId: 't1', values: { title: 'x' } }],
    [2, 'records.update', { entityId: 'tasks', recordId: 't1', version: 0, values: { title: 'x' } }],
    [3, 'records.create', { entityId: 'tasks', values: {} }],
    [4, 'records.create', { entityId: 'tasks', values: { title: ['a list'] } }],
    [5, 'records.create', { entityId: 'tasks', values: { estimate: { $nendoNumber: 'twelve' } } }],
    [6, 'records.create', { entityId: 'tasks', values: { estimate: Number.POSITIVE_INFINITY } }],
    [7, 'commands.run', { commandId: 'page.done', entityId: 'tasks', recordId: 't1' }],
  ];
  for (const [id, m, p] of refusals) {
    view.send({ t: 'req', id, m, p });
    assert.equal((await view.next((message) => message.id === id)).e.code, 'invalid-params', `${m} ${JSON.stringify(p)}`);
  }
  h.context = { ...context, readOnly: true };
  view.send({ t: 'req', id: 8, m: 'records.create', p: { entityId: 'tasks', values: { title: 'x' } } });
  assert.equal((await view.next((message) => message.id === 8)).e.code, 'read-only');
  await settle();
  assert.equal(h.calls.length, 0, 'A refused write reached the host.');
});

test('a hello is answered only for a frame this Workbench mounted, from the origin it was mounted at', (t) => {
  const h = harness();
  t.after(() => close(h));
  h.broker.receive({ source: h.otherWindow, origin, data: hello });
  h.broker.receive({ source: h.frameWindow, origin: 'https://org-example-other-0f0f0f0f0f.example', data: hello });
  h.broker.receive({ source: h.frameWindow, origin: 'https://app.nendo.local', data: hello });
  h.broker.receive({ source: null, origin, data: hello });
  h.broker.receive({ source: h.frameWindow, origin, data: { nendo: 'connect', apiVersion: 1 } });
  h.broker.receive({ source: h.frameWindow, origin, data: 'hello' });
  assert.equal(h.posted.length, 0, 'A message that was not a hello from the mounted frame at its own origin was answered.');
  assert.equal(h.broker.connectionCount(), 0);
  h.running = false;
  h.broker.receive({ source: h.frameWindow, origin, data: hello });
  assert.equal(h.posted.length, 0, 'A view was connected while views were off.');
  h.running = true;
  h.broker.receive({ source: h.frameWindow, origin, data: hello });
  assert.equal(h.posted.length, 1);
  const [{ message, targetOrigin, transfer }] = h.posted;
  assert.equal(targetOrigin, origin, 'The connect message may be read by whatever the frame navigated to.');
  assert.deepEqual(message, { nendo: 'connect', apiVersion: 1, context });
  assert.equal(transfer.length, 1);
});

test('a second hello from the same frame gets a new port and closes the old one', async (t) => {
  const h = harness();
  t.after(() => close(h));
  const first = connect(h);
  const closed = once(first.port, 'close');
  const second = connect(h);
  assert.notEqual(second.port, first.port);
  await closed;
  assert.equal(h.broker.connectionCount(), 1);
});

test('a request becomes the host read, built key by key, and the answer comes back on the port', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'records.count', p: { entityId: 'tasks', actor: 'extension:someone-else', filters: [{ fieldId: 'status', operator: 'eq', value: 'open', note: 'dropped' }] } });
  await until(() => h.calls.length === 1, 'the host read');
  assert.deepEqual(h.calls[0], { method: 'data.countRecords', payload: { entityId: 'tasks', filters: [{ fieldId: 'status', operator: 'eq', value: 'open' }] } });
  h.pending[0].resolve({ entityId: 'tasks', count: 3, changeSequence: 9 });
  assert.deepEqual(await view.next((message) => message.t === 'res' && message.id === 1),
    { t: 'res', id: 1, ok: true, r: { entityId: 'tasks', count: 3, changeSequence: 9 } });

  view.send({ t: 'req', id: 2, m: 'records.count', p: { entityId: 'tasks' } });
  await until(() => h.calls.length === 2, 'the second read');
  h.pending[1].reject(Object.assign(new Error('The Desktop host did not respond.'), { code: 'host-timeout' }));
  assert.deepEqual(await view.next((message) => message.id === 2),
    { t: 'res', id: 2, ok: false, e: { code: 'host-timeout', message: 'The Desktop host did not respond.' } });

  view.send({ t: 'req', id: 3, m: 'records.query', p: { entityId: 'tasks', limit: 201 } });
  assert.equal((await view.next((message) => message.id === 3)).e.code, 'invalid-params');
  view.send({ t: 'ping', id: 77 });
  assert.deepEqual(await view.next((message) => message.t === 'pong'), { t: 'pong', id: 77 });
});

test('a view reads plain values with their exact digits, labels and calculated fields beside them', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'records.query', p: { entityId: 'tasks' } });
  await until(() => h.calls.length === 1, 'the page read');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].payload)), { entityId: 'tasks', limit: 100, cursor: null, filters: [] });
  h.pending[0].resolve({
    items: [{
      entityId: 'tasks', recordId: 't1', recordVersion: 4,
      values: { title: 'One', cost: { $nendoNumber: '12.50' }, big: { $nendoNumber: '9007199254740993' }, owner: 'person-1', done: false, due: null },
      referenceLabels: { owner: 'Ada' },
      calculations: [
        { calculationId: 'c1', fieldId: 'total', state: 0, resultType: 1, value: { $nendoNumber: '25.00' } },
        { calculationId: 'c2', fieldId: 'ratio', state: 'error', resultType: 1, value: null, errorCode: 'calculation-division', errorMessage: 'Division by zero.' },
      ],
    }],
    nextCursor: 'next-page', changeSequence: 9,
  });
  const answer = await view.next((message) => message.id === 1);
  assert.deepEqual(answer.r, {
    items: [{
      entityId: 'tasks', recordId: 't1', version: 4,
      values: { title: 'One', cost: 12.5, big: 9007199254740992, owner: 'person-1', done: false, due: null, total: 25, ratio: null },
      exact: { cost: '12.50', big: '9007199254740993', total: '25.00' },
      labels: { owner: 'Ada' },
      calculated: {
        total: { state: 'value', value: 25, exact: '25.00', errorCode: null, errorMessage: null },
        ratio: { state: 'error', value: null, exact: null, errorCode: 'calculation-division', errorMessage: 'Division by zero.' },
      },
    }],
    nextCursor: 'next-page', changeSequence: 9,
  });
  view.send({ t: 'req', id: 2, m: 'records.get', p: { entityId: 'tasks', recordId: 'gone' } });
  await until(() => h.calls.length === 2, 'the record read');
  assert.deepEqual(h.calls[1].payload, { entityId: 'tasks', recordId: 'gone', limit: 1 });
  h.pending[1].resolve({ items: [], nextCursor: null, changeSequence: 9 });
  assert.equal((await view.next((message) => message.id === 2)).r, null);
});

test('a request over 256 KiB is refused as too large, and an unknown method by name, before the host is asked', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'records.count', p: { entityId: 'tasks', note: 'x'.repeat(256 * 1024) } });
  await until(() => view.inbox.some((message) => message.id === 1) || h.calls.length > 0, 'an answer or a host read');
  assert.equal(h.calls.length, 0, 'A request over 256 KiB reached the host.');
  assert.deepEqual((await view.next((message) => message.id === 1)).e.code, 'too-large');
  view.send({ t: 'req', id: 2, m: 'records.count', p: { entityId: 'tasks', note: 'é'.repeat(128 * 1024) } });
  await until(() => view.inbox.some((message) => message.id === 2) || h.calls.length > 0, 'an answer or a host read');
  assert.equal(h.calls.length, 0, 'A request of 256 KiB of UTF-8 in fewer characters reached the host.');
  assert.deepEqual((await view.next((message) => message.id === 2)).e.code, 'too-large');
  for (const [id, method] of [[3, 'proposal.promote'], [4, 'data.createRecord'], [5, 'constructor'], [6, 'toString'], [7, '__proto__']]) {
    view.send({ t: 'req', id, m: method, p: {} });
    const refused = await view.next((message) => message.id === id);
    assert.equal(refused.e.code, 'unknown-method', method);
  }
  await settle();
  assert.equal(h.calls.length, 0, 'A refused request reached the host.');
});

test('eight requests run at once, the ninth waits, and past sixty-four waiting the next is busy', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  for (let id = 1; id <= 9; id += 1) view.send({ t: 'req', id, m: 'records.count', p: { entityId: 'tasks' } });
  await until(() => h.calls.length >= 8, 'eight host reads');
  await settle();
  assert.equal(h.calls.length, 8, 'A ninth request went to the host while eight were in flight.');
  h.pending[0].resolve({ count: 1 });
  await until(() => h.calls.length === 9, 'the ninth read, once one had answered');
  for (let id = 10; id <= 73; id += 1) view.send({ t: 'req', id, m: 'records.count', p: { entityId: 'tasks' } });
  view.send({ t: 'req', id: 74, m: 'records.count', p: { entityId: 'tasks' } });
  assert.equal((await view.next((message) => message.id === 74)).e.code, 'busy');
  await settle();
  assert.equal(h.calls.length, 9);
  assert.equal(view.inbox.filter((message) => message.ok === false).length, 1, 'A request inside the sixty-four was refused.');
});

test('a view hears the file move at most four times a second, and the latest sequence last', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  h.broker.changes(10);
  h.now = 100;
  h.broker.changes(11);
  h.broker.changes(12);
  await settle();
  assert.deepEqual(view.inbox.filter((message) => message.n === 'changes').map((message) => message.d), [10]);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].at, 250);
  h.now = 250;
  h.timers.shift().callback();
  await until(() => view.inbox.filter((message) => message.n === 'changes').length === 2, 'the second change');
  assert.deepEqual(view.inbox.filter((message) => message.n === 'changes').map((message) => message.d), [10, 12]);
  h.broker.theme({ mode: 'dark', tokens: { ink: '#edf3ff' } });
  assert.deepEqual(await view.next((message) => message.n === 'theme'), { t: 'evt', n: 'theme', d: { mode: 'dark', tokens: { ink: '#edf3ff' } } });
});

test('a view that stops answering its ping is reported within ten seconds, and a pong clears it', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.port.onmessage = null;
  const pings = [];
  view.port.onmessage = (event) => { if (event.data.t === 'ping') pings.push(event.data); };
  h.now = 4_999;
  h.broker.tick();
  await settle();
  assert.equal(pings.length, 0, 'Pinged before five seconds had passed.');
  h.now = 5_000;
  h.broker.tick();
  await until(() => pings.length === 1, 'a ping');
  h.now = 9_999;
  h.broker.tick();
  assert.deepEqual(h.responsive, []);
  h.now = 10_000;
  h.broker.tick();
  assert.deepEqual(h.responsive, [false], 'Ten seconds without an answer while a ping waited was not reported.');
  h.now = 10_500;
  view.port.postMessage({ t: 'pong', id: pings[0].id });
  await until(() => h.responsive.length === 2, 'the view answering again');
  assert.deepEqual(h.responsive, [false, true]);
});

test('a toast is one line of at most 300 characters, one a second, and a height is bounded', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'ui.toast', p: { text: 'Saved the layout.' } });
  assert.equal((await view.next((message) => message.id === 1)).ok, true);
  view.send({ t: 'req', id: 2, m: 'ui.toast', p: { text: 'Again.' } });
  assert.equal((await view.next((message) => message.id === 2)).e.code, 'busy');
  h.now = 1_000;
  view.send({ t: 'req', id: 3, m: 'ui.toast', p: { text: 'x'.repeat(301) } });
  assert.equal((await view.next((message) => message.id === 3)).e.code, 'invalid-params');
  assert.deepEqual(h.toasts, ['Saved the layout.']);
  view.send({ t: 'req', id: 4, m: 'ui.setHeight', p: { pixels: 12 } });
  assert.deepEqual((await view.next((message) => message.id === 4)).r, { pixels: 80 });
  view.send({ t: 'req', id: 5, m: 'ui.setHeight', p: { pixels: 99_999 } });
  assert.deepEqual((await view.next((message) => message.id === 5)).r, { pixels: 4000 });
  view.send({ t: 'req', id: 6, m: 'ui.openRecord', p: { entityId: 'tasks', recordId: 't1' } });
  assert.deepEqual((await view.next((message) => message.id === 6)).r, { opened: true, target: { entityId: 'tasks', recordId: 't1' } });
});

test('the colours a view is handed are exactly the tokens the Workbench declares for both themes', async () => {
  const css = await readFile(new URL('../src/styles/02-tokens.css', import.meta.url), 'utf8');
  const [light, dark] = css.split(':root[data-theme="dark"]');
  const declared = (block) => [...new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]))].sort();
  assert.deepEqual([...model.themeTokenNames].sort(), declared(light));
  assert.deepEqual([...model.themeTokenNames].sort(), declared(dark));
  const theme = model.viewTheme('dark', (name) => ` value-of-${name} `);
  assert.equal(theme.mode, 'dark');
  assert.equal(theme.tokens.ink, 'value-of-ink');
  assert.equal(Object.keys(theme.tokens).length, model.themeTokenNames.length);
});

test('a view’s context is built from the stored nodes: its bindings, filters, configuration and methods', () => {
  const session = {
    capabilities: { mutate: false },
    manifest: { purpose: 'Plan work', changeSequence: 7 },
    entities: [
      { entityId: 'work', displayName: 'Work', fields: [
        { fieldId: 'title', displayName: 'Title', storageKind: 0, required: true, presentation: null, options: [] },
        { fieldId: 'status', displayName: 'Status', storageKind: 0, required: false, presentation: 'singleChoice', options: [], choices: [{ id: 'open', displayName: 'Open', retired: false, tone: 'blue' }] },
        { fieldId: 'due', displayName: 'Due', storageKind: 4, required: false, presentation: null, options: [] },
        { fieldId: 'old', displayName: 'Old', storageKind: 0, required: false, presentation: null, options: [], retired: true },
      ], derivedFields: [{ fieldId: 'age', displayName: 'Age', calculationId: 'c-age', resultType: 0, resultNullable: true, expression: 'today() - created' }] },
      { entityId: 'link', displayName: 'Link', fields: [
        { fieldId: 'from', displayName: 'From', storageKind: 7, required: true, presentation: null, options: [], reference: { targetEntityId: 'work', labelFieldId: 'title' } },
        { fieldId: 'to', displayName: 'To', storageKind: 7, required: true, presentation: null, options: [], reference: { targetEntityId: 'work', labelFieldId: 'title' } },
        { fieldId: 'kind', displayName: 'Kind', storageKind: 0, required: false, presentation: null, options: [] },
      ] },
      { entityId: 'gone', displayName: 'Gone', retired: true, fields: [] },
    ],
    uiNodes: [
      { surfaceId: 's.graph', nodeId: 'graph', parentNodeId: null, kind: 'extensionGraphSurface', position: 0,
        properties: { entityId: 'work', title: 'Dependencies', packageId: 'org.example.graph', labelFieldId: 'title', statusFieldId: 'status',
          edgeEntityId: 'link', sourceFieldId: 'from', targetFieldId: 'to', configuration: '{"layout":"layered","gap":{"$nendoNumber":"4"}}' } },
      { surfaceId: 's.graph', nodeId: 'graph.b1', parentNodeId: 'graph', kind: 'fieldBinding', position: 1, properties: { fieldId: 'kind' } },
      { surfaceId: 's.graph', nodeId: 'graph.b0', parentNodeId: 'graph', kind: 'fieldBinding', position: 0, properties: { fieldId: 'age' } },
      { surfaceId: 's.graph', nodeId: 'graph.f0', parentNodeId: 'graph', kind: 'filterClause', position: 2, properties: { fieldId: 'due', operator: 'lte', valueKind: 'today' } },
      { surfaceId: 's.graph', nodeId: 'graph.f1', parentNodeId: 'graph', kind: 'filterClause', position: 3, properties: { fieldId: 'kind', operator: 'isNotNull' } },
      { surfaceId: 's.graph', nodeId: 'graph.f2', parentNodeId: 'graph', kind: 'filterClause', position: 4, properties: { fieldId: 'status', operator: 'ne', value: 'open' } },
      { surfaceId: 's.page', nodeId: 'page', parentNodeId: null, kind: 'detailSurface', position: 0, properties: { entityId: 'work' } },
      { surfaceId: 's.page', nodeId: 'page.done', parentNodeId: 'page', kind: 'recordCommand', position: 0, properties: { label: 'Done' } },
      { surfaceId: 's.page', nodeId: 'page.done.when', parentNodeId: 'page.done', kind: 'commandStep', position: 1, properties: { fieldId: 'due', valueKind: 'today' } },
      { surfaceId: 's.page', nodeId: 'page.done.status', parentNodeId: 'page.done', kind: 'commandStep', position: 0, properties: { fieldId: 'status', valueKind: 'literal', value: 'status-done' } },
    ],
  };
  const spec = { viewId: 'graph', kind: 'extensionGraphSurface', placement: 'screen', title: 'Dependencies', packageId: 'org.example.graph', entityId: 'work', recordId: null };
  const theme = { mode: 'light', tokens: { ink: '#13213d' } };
  const built = model.viewContext(spec, session, theme, 'da-DK', broker.brokerMethodNames);
  assert.deepEqual(built.bindings, {
    labelFieldId: 'title', statusFieldId: 'status', edgeEntityId: 'link', sourceFieldId: 'from', targetFieldId: 'to',
    fields: [{ fieldId: 'age', entityId: 'work' }, { fieldId: 'kind', entityId: 'link' }],
    filters: [
      // Each filter says its field's stored kind, so `today` resolves to a date or an instant (R-003).
      { fieldId: 'due', entityId: 'work', operator: 'le', value: null, valueKind: 'today', storageKind: 'date' },
      { fieldId: 'kind', entityId: 'link', operator: 'isNotNull', value: null, valueKind: 'literal', storageKind: 'text' },
      { fieldId: 'status', entityId: 'work', operator: 'ne', value: 'open', valueKind: 'literal', storageKind: 'text' },
    ],
  });
  assert.deepEqual(built.configuration, { layout: 'layered', gap: 4 });
  assert.equal(built.readOnly, true);
  assert.equal(built.locale, 'da-DK');
  assert.deepEqual(built.methods, [...broker.brokerMethodNames]);
  assert.equal(built.apiVersion, 1);
  assert.deepEqual(model.viewConfiguration('not json'), {});
  assert.deepEqual(model.viewConfiguration('[1,2]'), {});

  const schema = model.describeSchema(session);
  assert.equal(schema.purpose, 'Plan work');
  assert.deepEqual(schema.entities.map((entity) => entity.entityId), ['work', 'link'], 'A retired record type was described.');
  const work = schema.entities[0];
  assert.deepEqual(work.fields.map((field) => field.fieldId), ['title', 'status', 'due', 'age'], 'A retired field was described, or a calculated one left out.');
  assert.deepEqual(work.fields.find((field) => field.fieldId === 'age'), {
    fieldId: 'age', displayName: 'Age', storageKind: 'integer', required: false, presentation: null, calculated: true,
    expression: 'today() - created', choices: [], reference: null, scale: null,
  });
  assert.equal(work.fields.find((field) => field.fieldId === 'due').storageKind, 'date');
  assert.equal(schema.entities[1].fields[0].storageKind, 'reference');
  assert.deepEqual(schema.screens, [
    { id: 'graph', surfaceId: 's.graph', kind: 'extensionGraphSurface', title: 'Dependencies', entityId: 'work' },
    { id: 'page', surfaceId: 's.page', kind: 'detailSurface', title: null, entityId: 'work' },
  ]);
  // A command says what it sets, in step order, so a view can grey one the record already holds.
  assert.deepEqual(schema.commands, [{ id: 'page.done', entityId: 'work', label: 'Done', steps: [
    { fieldId: 'status', valueKind: 'literal', value: 'status-done' },
    { fieldId: 'due', valueKind: 'today', value: null },
  ] }]);
});
