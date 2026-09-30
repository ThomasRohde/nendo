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
  const h = { posted, frameWindow, otherWindow, mount, calls: [], pending: [], timers: [], toasts: [], responsive: [], now: 0, running: true, heights: [], opened: [], canOpen: true,
    toolbars: [], menus: [], menuAnswer: null, keys: [], places: [] };
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
      setToolbar: (_mount, toolbar) => { h.toolbars.push(toolbar); },
      showMenu: async (_mount, menu) => { h.menus.push(menu); return h.menuAnswer; },
      key: (_mount, keys) => { h.keys.push(keys); },
      setPlace: (_mount, place) => { h.places.push(place); return true; },
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
const readMethods = ['data.queryRecords', 'data.treeRecords', 'data.countRecords', 'data.aggregateRecords', 'data.groupAggregateRecords', 'data.bucketAggregateRecords', 'data.cellAggregateRecords', 'proposal.get', 'extension.state.read'];
// The record writes a person's own edit uses, and preparing a proposal (ADR-0013 Phase 3,
// W-065 and W-069). The host admits a view's actor on exactly these and on proposal.get
// (WorkbenchMethods.ExtensionWriterMethods). Never promote or reject.
const writeMethods = ['data.createRecord', 'data.setFields', 'data.deleteRecord', 'data.moveRecord', 'data.writeRecords', 'data.executeCommand', 'proposal.prepareChangeSet', 'extension.state.set'];

test('R30-016: a batch admits the same record ID in different record types', async (t) => {
  const h = harness(); t.after(() => close(h)); const view = connect(h);
  const writes = ['nodes', 'other'].map(entityId => ({ op: 'update', entityId, recordId: 'shared', version: 1, values: { title: entityId } }));
  view.send({ t: 'req', id: 1, m: 'records.batch', p: { writes } });
  await until(() => h.calls.length > 0 || view.inbox.some(message => message.id === 1));
  assert.equal(h.calls.length, 1, 'Batch normalization confused equal IDs in different record types.');
  assert.deepEqual(h.calls[0].payload.writes.map(write => [write.entityId, write.recordId]), [['nodes', 'shared'], ['other', 'shared']]);
  h.pending[0].resolve({ records: [] });
  assert.equal((await view.next(message => message.id === 1)).ok, true);
});

test('R30-015: reserved property names survive record projections, labels, exact digits and calculated values', () => {
  const fields = JSON.parse('{"__proto__":"kept","constructor":"named","toString":null}');
  const record = model.plainRecord({ entityId: 'items', recordId: 'one', recordVersion: 1,
    values: fields, referenceLabels: fields });
  for (const [key, value] of Object.entries(fields)) {
    assert.equal(Object.hasOwn(record.values, key), true, `Projection lost own field ${key}.`);
    assert.equal(record.values[key], value);
    assert.equal(Object.hasOwn(record.labels, key), true, `Projection lost own label ${key}.`);
    assert.equal(record.labels[key], value);
  }
  const numeric = model.plainRecord({ entityId: 'items', recordId: 'one', recordVersion: 1,
    values: JSON.parse('{"__proto__":{"$nendoNumber":"12.50"}}'),
    calculations: ['constructor', 'toString'].map(fieldId => ({ fieldId, state: 'value', value: { $nendoNumber: '3.25' } })) });
  assert.equal(numeric.values.__proto__, 12.5);
  assert.equal(Object.hasOwn(numeric.exact, '__proto__'), true, 'Exact digits lost own __proto__ field.');
  assert.equal(numeric.exact.__proto__, '12.50');
  for (const key of ['constructor', 'toString']) {
    assert.equal(Object.hasOwn(numeric.values, key), true, `Calculated projection lost own field ${key}.`);
    assert.equal(numeric.values[key], 3.25);
    assert.equal(numeric.calculated[key].exact, '3.25');
  }
  assert.equal(Object.getPrototypeOf(record.values), Object.prototype, 'A field changed the result prototype.');
});

test('R30-015: reserved field IDs reach create requests with reference target versions intact', async (t) => {
  const h = harness(); t.after(() => close(h)); const view = connect(h);
  const values = JSON.parse('{"__proto__":"ref-1","constructor":"named","toString":null}');
  const targetVersions = JSON.parse('{"__proto__":7}');
  view.send({ t: 'req', id: 1, m: 'records.create', p: { entityId: 'items', values } });
  await until(() => h.calls.length === 1);
  assert.equal(h.calls[0].method, 'data.createRecord');
  assert.deepEqual(h.calls[0].payload.values, values, 'Create normalization lost a reserved field ID.');
  h.pending[0].resolve({});
  await until(() => h.calls.length === 2);
  h.pending[1].resolve({ items: [] });
  assert.equal((await view.next(message => message.id === 1)).ok, true);
  view.send({ t: 'req', id: 2, m: 'records.create', p: { entityId: 'items', values, targetVersions } });
  await until(() => h.calls.length === 3);
  assert.deepEqual(h.calls[2].payload.expectedTargetVersions, targetVersions, 'Create normalization lost a reserved target version.');
  h.pending[2].resolve({});
  await until(() => h.calls.length === 4);
  h.pending[3].resolve({ items: [] });
  assert.equal((await view.next(message => message.id === 2)).ok, true);
});

test('R30-015: JSON state and places keep nested reserved names through write, read and place events', async (t) => {
  const h = harness(); t.after(() => close(h)); const view = connect(h);
  const value = JSON.parse('{"__proto__":{"__proto__":"nested","constructor":false},"constructor":0,"toString":null}');
  assert.deepEqual(model.plainJson(value), value, 'JSON projection lost reserved keys.');
  view.send({ t: 'req', id: 1, m: 'state.set', p: { key: '__proto__', value } });
  await until(() => h.calls.length === 1);
  assert.deepEqual(h.calls[0].payload.value, value, 'State write lost reserved keys.');
  h.pending[0].resolve({});
  await until(() => h.calls.length === 2);
  h.pending[1].resolve({ entries: [{ key: '__proto__', value, version: 1 }] });
  assert.deepEqual((await view.next(message => message.id === 1)).r, { key: '__proto__', value, version: 1 });
  view.send({ t: 'req', id: 2, m: 'ui.setPlace', p: { place: value } });
  assert.equal((await view.next(message => message.id === 2)).ok, true);
  assert.deepEqual(h.places[0].value, value, 'Place declaration lost reserved keys.');
  h.broker.place(h.mount, { ...value, restored: true });
  const event = await view.next(message => message.n === 'place');
  assert.deepEqual(event.d, { ...value, restored: true }, 'Place event lost reserved keys.');
});

test('the method table is closed: reads, the record writes, preparing a proposal, and no promote, reject, approve, file, session or agent method', () => {
  const expected = [
    ['schema.describe', null],
    ['records.query', 'data.queryRecords'],
    ['records.get', 'data.queryRecords'],
    ['records.tree', 'data.treeRecords'],
    ['records.count', 'data.countRecords'],
    ['records.aggregate', 'data.aggregateRecords'],
    ['records.groupAggregate', 'data.groupAggregateRecords'],
    ['records.bucketAggregate', 'data.bucketAggregateRecords'],
    ['records.cellAggregate', 'data.cellAggregateRecords'],
    ['records.create', 'data.createRecord'],
    ['records.update', 'data.setFields'],
    ['records.delete', 'data.deleteRecord'],
    ['records.move', 'data.moveRecord'],
    // Several record writes as one revision (W-102).
    ['records.batch', 'data.writeRecords'],
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
    // The view's controls in Nendo's own chrome (W-090): the Workbench draws them itself.
    ['ui.setToolbar', null],
    ['ui.showMenu', null],
    // The view's place in Back and Forward (W-127): the Workbench keeps it and never reads it.
    ['ui.setPlace', null],
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

// W-102: several writes as one revision, made as the mount's package like every write.
test('a batch goes to the host as one write in the mount\u2019s package, rebuilt entry by entry, and answers each record\u2019s version', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'records.batch', p: { label: 'Align', actor: 'extension:someone-else', idempotencyKey: 'replay-me', writes: [
    { op: 'create', entityId: 'items', recordId: 'n1', values: { x: 10, name: 'A' }, extra: 'dropped' },
    { op: 'update', entityId: 'items', recordId: 'n2', version: 3, values: { x: 20, owner: 'n1' }, targetVersions: { owner: 1 } },
    { op: 'delete', entityId: 'items', recordId: 'n3', version: 2, values: { x: 1 } },
  ] } });
  await until(() => h.calls.length === 1, 'the host batch');
  const { method, payload } = h.calls[0];
  assert.equal(method, 'data.writeRecords');
  assert.equal(payload.actor, 'extension:org.example.glance', 'The batch was not made in the name of the mount\u2019s package.');
  assert.match(payload.idempotencyKey, /^view-[0-9a-f-]{36}$/, 'The view chose its own idempotency key.');
  assert.equal(payload.label, 'Align');
  assert.deepEqual(payload.writes, [
    { kind: 'create', entityId: 'items', recordId: 'n1', values: { x: { $nendoNumber: '10' }, name: 'A' } },
    { kind: 'update', entityId: 'items', recordId: 'n2', expectedRecordVersion: 3, values: { x: { $nendoNumber: '20' }, owner: 'n1' }, expectedTargetVersions: { owner: 1 } },
    { kind: 'delete', entityId: 'items', recordId: 'n3', expectedRecordVersion: 2 },
  ]);
  h.pending[0].resolve({ mutation: { changeSequence: 11 }, session: null, records: [
    { entityId: 'items', recordId: 'n1', recordVersion: 1 },
    { entityId: 'items', recordId: 'n2', recordVersion: 5 },
    { entityId: 'items', recordId: 'n3', recordVersion: null },
  ] });
  const answered = await view.next((message) => message.id === 1);
  assert.equal(answered.ok, true);
  assert.deepEqual(answered.r, { records: [
    { entityId: 'items', recordId: 'n1', version: 1 },
    { entityId: 'items', recordId: 'n2', version: 5 },
    { entityId: 'items', recordId: 'n3', version: null },
  ] });
  await settle();
  assert.equal(h.calls.length, 1, 'A batch read its records back one by one.');

  view.send({ t: 'req', id: 2, m: 'records.batch', p: { writes: [{ op: 'create', entityId: 'items', values: { name: 'B' } }] } });
  await until(() => h.calls.length === 2, 'a batch without a label');
  assert.equal(h.calls[1].payload.label, undefined);
  assert.match(h.calls[1].payload.writes[0].recordId, /^record-[0-9a-f]{32}$/, 'A create without a record ID was not given one.');
});

test('a batch is refused before the host when it is empty, too long, names a record twice, moves, or leaves out a version', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  const refusals = [
    [{ writes: [] }, /writes must be a list of 1 to 200 record writes/],
    [{ writes: Array.from({ length: 201 }, (_, index) => ({ op: 'delete', entityId: 'items', recordId: `r${index}`, version: 1 })) }, /1 to 200/],
    [{ writes: [{ op: 'delete', entityId: 'items', recordId: 'r1', version: 1 }, { op: 'update', entityId: 'items', recordId: 'r1', version: 1, values: { a: 1 } }] }, /writes\[1\] writes r1 again/],
    [{ writes: [{ op: 'move', entityId: 'items', recordId: 'r1', version: 1 }] }, /writes\[0\]: op must be create, update or delete/],
    [{ writes: [{ op: 'update', entityId: 'items', recordId: 'r1', values: { a: 1 } }] }, /writes\[0\]: version must be/],
    [{ writes: [{ op: 'create', entityId: 'items', values: {} }] }, /writes\[0\]: values must name 1 to 64 fields/],
    [{ label: '', writes: [{ op: 'delete', entityId: 'items', recordId: 'r1', version: 1 }] }, /label must be text of 1 to 80/],
  ];
  for (const [index, [p, message]] of refusals.entries()) {
    view.send({ t: 'req', id: index + 1, m: 'records.batch', p });
    const answered = await view.next((reply) => reply.id === index + 1);
    assert.equal(answered.e?.code, 'invalid-params', JSON.stringify(p).slice(0, 120));
    assert.match(answered.e.message, message);
  }
  h.context = { ...context, readOnly: true };
  view.send({ t: 'req', id: 99, m: 'records.batch', p: { writes: [{ op: 'delete', entityId: 'items', recordId: 'r1', version: 1 }] } });
  assert.equal((await view.next((message) => message.id === 99)).e.code, 'read-only');
  await settle();
  assert.equal(h.calls.length, 0, 'A refused batch reached the host.');
});

// W-079: a move in a declared tree (ADR-0019), made as the mount's package like every write.
test('a move goes to the host as the mount\u2019s package with the parent\u2019s version, or to the top level with neither, and answers the record', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'records.move', p: {
    entityId: 'tasks', recordId: 't1', version: 3, parentRecordId: 't0', parentVersion: 2, beforeRecordId: 't5', actor: 'extension:someone-else',
  } });
  await until(() => h.calls.length === 1, 'the move');
  assert.equal(h.calls[0].method, 'data.moveRecord');
  assert.deepEqual({ ...h.calls[0].payload, idempotencyKey: undefined }, {
    entityId: 'tasks', recordId: 't1', expectedRecordVersion: 3, parentRecordId: 't0', expectedParentVersion: 2, beforeRecordId: 't5',
    idempotencyKey: undefined, actor: 'extension:org.example.glance',
  });
  h.pending[0].resolve({});
  await until(() => h.calls.length === 2, 'the read back');
  assert.deepEqual(h.calls[1], { method: 'data.queryRecords', payload: { entityId: 'tasks', recordId: 't1', limit: 1 } });
  h.pending[1].resolve({ items: [{ entityId: 'tasks', recordId: 't1', recordVersion: 5, values: { title: 'Moved' } }] });
  assert.equal((await view.next((message) => message.id === 1)).r.version, 5);

  view.send({ t: 'req', id: 2, m: 'records.move', p: { entityId: 'tasks', recordId: 't1', version: 5, parentRecordId: null } });
  await until(() => h.calls.length === 3, 'a move to the top level');
  assert.deepEqual({ ...h.calls[2].payload, idempotencyKey: undefined }, {
    entityId: 'tasks', recordId: 't1', expectedRecordVersion: 5, parentRecordId: null, beforeRecordId: null,
    idempotencyKey: undefined, actor: 'extension:org.example.glance',
  });
  h.pending[2].resolve({});
  await until(() => h.calls.length === 4, 'its read back');
  h.pending[3].resolve({ items: [] });
  await view.next((message) => message.id === 2);

  // A parent without the version the view read, or a version with no parent, never reaches the host.
  for (const [id, params, message] of [
    [3, { entityId: 'tasks', recordId: 't1', version: 5, parentRecordId: 't0' }, /parentVersion must be/],
    [4, { entityId: 'tasks', recordId: 't1', version: 5, parentVersion: 2 }, /parentVersion goes with parentRecordId/],
  ]) {
    view.send({ t: 'req', id, m: 'records.move', p: params });
    const refused = await view.next((answer) => answer.id === id);
    assert.equal(refused.ok, false);
    assert.match(refused.e.message, message);
  }
  await settle();
  assert.equal(h.calls.length, 4, 'A move the broker refused reached the host.');
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
  // A file's icon colours (--look-*, W-089) are the same in both themes: they are the raster
  // icon's, not a theme, so a view that follows the person's theme is not handed them.
  const declared = (block) => [...new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]))]
    .filter((name) => !name.startsWith('look-')).sort();
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
      { entityId: 'work', displayName: 'Work', hierarchy: { parentFieldId: 'parent' }, fields: [
        { fieldId: 'title', displayName: 'Title', storageKind: 0, required: true, presentation: null, options: [] },
        { fieldId: 'parent', displayName: 'Part of', storageKind: 7, required: false, presentation: null, options: [], reference: { targetEntityId: 'work', labelFieldId: 'title' } },
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
  assert.deepEqual(work.fields.map((field) => field.fieldId), ['title', 'parent', 'status', 'due', 'age'], 'A retired field was described, or a calculated one left out.');
  // The tree a record type declares (ADR-0019), so a view can write a parent without guessing
  // which self-reference holds it. A record type that declares none says so with null.
  assert.deepEqual(work.hierarchy, { parentFieldId: 'parent', orderFieldId: null }, 'schema.describe did not name the declared hierarchy.');
  assert.equal(schema.entities[1].hierarchy, null, 'A record type without a hierarchy was described with one.');
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

// --- A view's controls in Nendo's own chrome (ADR-0013, 2026-09-28; W-090) ------------------

const atlasToolbar = {
  items: [
    { kind: 'choice', id: 'mode', label: 'Mode', hideLabel: true, value: 'map', options: [{ value: 'map', label: 'Map' }, { value: 'outline', label: 'Outline' }] },
    { kind: 'select', id: 'colour', label: 'Colour', value: 'maturity', options: [{ value: 'maturity', label: 'Maturity' }, { value: 'none', label: 'Neutral' }] },
    { kind: 'spacer' },
    { kind: 'search', id: 'find', label: 'Find a capability', keys: 'ctrl+f' },
    { kind: 'group', label: 'Zoom', items: [
      { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
      { kind: 'button', id: 'fit', label: 'Fit', keys: 'Control+0' },
      { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus' },
    ] },
    { kind: 'toggle', id: 'pan', label: 'Pan', icon: 'pan', pressed: false },
    { kind: 'text', text: '115%', mono: true },
    { kind: 'menu', id: 'export', label: 'Export', icon: 'export', items: [
      { id: 'export-svg', label: 'SVG, to edit', detail: 'Plain shapes and text' },
      { kind: 'separator' },
      { kind: 'check', id: 'light', label: 'Light colours for print', checked: false },
    ] },
  ],
  add: 'add-capability',
};

test('G27: a toolbar is rebuilt into closed kinds and plain text before the Workbench draws it', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  const hostile = structuredClone(atlasToolbar);
  hostile.items[0].onclick = 'alert(1)';
  hostile.items[1].options[0].label = '<img src=x onerror=alert(1)>';
  hostile.items[5].style = 'position:fixed';
  view.send({ t: 'req', id: 1, m: 'ui.setToolbar', p: hostile });
  assert.equal((await view.next((message) => message.id === 1)).ok, true);
  const drawn = h.toolbars.at(-1);
  assert.equal(drawn.add, 'add-capability');
  assert.equal(drawn.items[0].onclick, undefined, 'A key the rules do not name reached the Workbench.');
  assert.equal(drawn.items[5].style, undefined, 'A key the rules do not name reached the Workbench.');
  assert.equal(drawn.items[1].options[0].label, '<img src=x onerror=alert(1)>', 'A label was changed rather than carried as text for the markup to escape.');
  // Keys are normalised to one spelling, so a key is one key however a view writes it.
  assert.deepEqual([drawn.items[3].keys, ...drawn.items[4].items.map((item) => item.keys)], ['Ctrl+F', 'Ctrl+-', 'Ctrl+0', 'Ctrl+Plus']);

  const refusals = [
    [{ items: [{ kind: 'html', id: 'x', label: 'X' }] }, /kind must be/],
    [{ items: [{ kind: 'button', id: 'x', label: 'X', icon: 'skull' }] }, /icon must be one of Nendo/],
    [{ items: [{ kind: 'button', id: 'x', label: 'X', keys: 'Ctrl+K' }] }, /Ctrl\+K is Nendo's own key/],
    [{ items: [{ kind: 'button', id: 'x', label: 'X', keys: 'F1' }] }, /F1 is Nendo's own key/],
    [{ items: [{ kind: 'button', id: 'x', label: 'X', keys: 'Q' }] }, /keys must be a key with Ctrl or Alt/],
    [{ items: [{ kind: 'button', id: 'x', label: 'X' }, { kind: 'toggle', id: 'x', label: 'Y' }] }, /Two controls are named x/],
    [{ items: [{ kind: 'button', id: 'a', label: 'A', keys: 'Ctrl+E' }, { kind: 'button', id: 'b', label: 'B', keys: 'ctrl+e' }] }, /Two controls declare Ctrl\+E/],
    [{ items: [{ kind: 'button', id: 'x', label: 'x'.repeat(81) }] }, /label must be text of 1 to 80/],
    [{ items: Array.from({ length: 33 }, (_, index) => ({ kind: 'button', id: `b${index}`, label: 'B' })) }, /items must be a list of at most 32/],
    [{ items: [{ kind: 'select', id: 's', label: 'S', value: 'gone', options: [{ value: 'a', label: 'A' }] }] }, /value must be the value of one of its options/],
    [{ items: [{ kind: 'group', label: 'G', items: [{ kind: 'search', id: 'f', label: 'F' }] }] }, /a group holds buttons/],
    [{ items: [{ kind: 'button', id: '<script>', label: 'X' }] }, /id must be 1 to 64 letters/],
    [{ items: [], add: 'bad id' }, /add\.id must be/],
  ];
  let id = 2;
  for (const [params, pattern] of refusals) {
    const count = h.toolbars.length;
    h.now += 1_000;
    view.send({ t: 'req', id, m: 'ui.setToolbar', p: params });
    const answer = await view.next((message) => message.id === id);
    assert.equal(answer.ok, false, `${JSON.stringify(params).slice(0, 120)} was drawn.`);
    assert.equal(answer.e.code, 'invalid-params');
    assert.match(answer.e.message, pattern);
    assert.equal(h.toolbars.length, count, 'A refused toolbar still reached the Workbench.');
    id += 1;
  }
  // An empty declaration takes the toolbar away.
  h.now += 1_000;
  view.send({ t: 'req', id: 99, m: 'ui.setToolbar', p: { items: [] } });
  assert.equal((await view.next((message) => message.id === 99)).ok, true);
  assert.equal(h.toolbars.at(-1), null);
});

test('G27: a view declares its toolbar at most twenty times a second', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  for (let id = 1; id <= 21; id += 1) view.send({ t: 'req', id, m: 'ui.setToolbar', p: { items: [{ kind: 'text', text: `${id}%` }] } });
  const last = await view.next((message) => message.id === 21);
  assert.equal(last.ok, false);
  assert.equal(last.e.code, 'busy');
  assert.equal(h.toolbars.length, 20);
  h.now = 1_001;
  view.send({ t: 'req', id: 22, m: 'ui.setToolbar', p: { items: [] } });
  assert.equal((await view.next((message) => message.id === 22)).ok, true);
});

test('G28: a command reaches the connected view as the event command, with exactly its id, value and source', async (t) => {
  const h = harness();
  assert.equal(h.broker.command(h.mount, { id: 'fit', value: null, source: 'toolbar' }), false, 'A view that is not connected was said to be told.');
  const view = connect(h);
  t.after(() => close(h));
  assert.equal(h.broker.command(h.mount, { id: 'pan', value: true, source: 'key', extra: 'dropped' }), true);
  assert.deepEqual(await view.next((message) => message.n === 'command'), { t: 'evt', n: 'command', d: { id: 'pan', value: true, source: 'key' } });
});

test('G29: a menu the view asks for is rebuilt, drawn at its point, and answers the pick; four a second', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  h.menuAnswer = { id: 'rename', value: null };
  view.send({ t: 'req', id: 1, m: 'ui.showMenu', p: {
    x: 120.4, y: 48, items: [{ id: 'open', label: 'Open record', icon: 'external', keys: 'Enter', script: 'x' }, { kind: 'separator' }, { id: 'rename', label: 'Rename', keys: 'F2' }],
  } });
  const answer = await view.next((message) => message.id === 1);
  assert.equal(answer.ok, false, 'Enter alone was taken as a key a view may declare.');
  view.send({ t: 'req', id: 2, m: 'ui.showMenu', p: {
    x: 120.4, y: 48, items: [{ id: 'open', label: 'Open record', icon: 'external', script: 'x' }, { kind: 'separator' }, { id: 'rename', label: 'Rename', keys: 'F2' }],
  } });
  assert.deepEqual((await view.next((message) => message.id === 2)).r, { id: 'rename', value: null });
  assert.deepEqual(h.menus.at(-1), { x: 120, y: 48, items: [
    { kind: 'item', id: 'open', label: 'Open record', detail: null, icon: 'external', keys: null, disabled: false, danger: false },
    { kind: 'separator' },
    { kind: 'item', id: 'rename', label: 'Rename', detail: null, icon: null, keys: 'F2', disabled: false, danger: false },
  ] }, 'The menu reached the Workbench as the view sent it rather than rebuilt.');
  view.send({ t: 'req', id: 3, m: 'ui.showMenu', p: { x: 0, y: 0, items: [{ kind: 'separator' }] } });
  assert.match((await view.next((message) => message.id === 3)).e.message, /at least one item to pick/);
  h.now = 2_000;
  for (let id = 4; id <= 7; id += 1) view.send({ t: 'req', id, m: 'ui.showMenu', p: { x: 0, y: 0, items: [{ id: 'a', label: 'A' }] } });
  assert.equal((await view.next((message) => message.id === 7)).ok, true);
  view.send({ t: 'req', id: 8, m: 'ui.showMenu', p: { x: 0, y: 0, items: [{ id: 'a', label: 'A' }] } });
  assert.equal((await view.next((message) => message.id === 8)).e.code, 'busy', 'A fifth menu in one second was drawn.');
});

test('G30: a key handed back is taken only when it is Nendo’s or one the toolbar declares, eight a second, and not with views off', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'key', keys: 'Ctrl+K' });
  view.send({ t: 'key', keys: 'Ctrl+0' });
  view.send({ t: 'key', keys: 'Ctrl+W' });
  view.send({ t: 'key', keys: ['Ctrl+K'] });
  await settle();
  assert.deepEqual(h.keys, ['Ctrl+K'], 'A key the view never declared, or not a key at all, was run.');
  view.send({ t: 'req', id: 1, m: 'ui.setToolbar', p: atlasToolbar });
  await view.next((message) => message.id === 1);
  view.send({ t: 'key', keys: 'Ctrl+0' });
  view.send({ t: 'key', keys: 'Alt+ArrowLeft' });
  await settle();
  assert.deepEqual(h.keys, ['Ctrl+K', 'Ctrl+0', 'Alt+ArrowLeft']);
  for (let index = 0; index < 10; index += 1) view.send({ t: 'key', keys: 'Ctrl+Plus' });
  await settle();
  assert.equal(h.keys.filter((keys) => keys === 'Ctrl+Plus').length, 5, 'More than eight keys in one second were run.');
  h.now = 5_000;
  h.running = false;
  view.send({ t: 'key', keys: 'Ctrl+K' });
  await settle();
  assert.equal(h.keys.filter((keys) => keys === 'Ctrl+K').length, 1, 'A key was run while views were off.');
});

test('G31: a place the view declares is plain JSON of at most 4 KiB with a short label, twenty a second', async (t) => {
  const h = harness();
  const view = connect(h);
  t.after(() => close(h));
  view.send({ t: 'req', id: 1, m: 'ui.setPlace', p: { place: { view: 'v-1', selected: null, when: new Date(0).toISOString() }, label: 'Main view' } });
  assert.equal((await view.next((message) => message.id === 1)).ok, true);
  assert.deepEqual(h.places, [{ value: { view: 'v-1', selected: null, when: '1970-01-01T00:00:00.000Z' }, label: 'Main view', replace: false }]);
  view.send({ t: 'req', id: 2, m: 'ui.setPlace', p: { place: { view: 'v-1', selected: 'e-2' }, replace: true } });
  assert.equal((await view.next((message) => message.id === 2)).ok, true);
  assert.deepEqual(h.places.at(-1), { value: { view: 'v-1', selected: 'e-2' }, label: null, replace: true }, 'replace, or the missing label, did not reach the Workbench.');
  view.send({ t: 'req', id: 3, m: 'ui.setPlace', p: { place: { text: 'x'.repeat(4_100) } } });
  assert.match((await view.next((message) => message.id === 3)).e.message, /at most 4096 bytes/);
  view.send({ t: 'req', id: 4, m: 'ui.setPlace', p: { place: 1, label: 'y'.repeat(81) } });
  assert.equal((await view.next((message) => message.id === 4)).ok, false, 'A label longer than 80 characters was taken.');
  view.send({ t: 'req', id: 5, m: 'ui.setPlace', p: { place: 1, replace: 'yes' } });
  assert.equal((await view.next((message) => message.id === 5)).ok, false, 'replace that is not true or false was taken.');
  h.now = 5_000;
  for (let id = 10; id < 30; id += 1) view.send({ t: 'req', id, m: 'ui.setPlace', p: { place: id } });
  assert.equal((await view.next((message) => message.id === 29)).ok, true);
  view.send({ t: 'req', id: 30, m: 'ui.setPlace', p: { place: 30 } });
  assert.equal((await view.next((message) => message.id === 30)).e.code, 'busy', 'A twenty-first place in one second was taken.');
});

test('G32: Back or Forward hands a view its place as the event place, never the place it declared itself', async (t) => {
  const h = harness();
  h.context = { ...context, place: { view: 'v-1' } };
  const view = connect(h);
  t.after(() => close(h));
  h.broker.place(h.mount, { view: 'v-1' });
  // The Workbench keeps the place before the broker reads the context again, as view-frames does.
  h.context = { ...context, place: { view: 'v-2' } };
  view.send({ t: 'req', id: 1, m: 'ui.setPlace', p: { place: { view: 'v-2' } } });
  await view.next((message) => message.id === 1);
  h.broker.place(h.mount, { view: 'v-2' });
  h.broker.refreshContext(h.mount);
  h.context = { ...context, place: { view: 'v-1' } };
  h.broker.place(h.mount, { view: 'v-1' });
  h.broker.refreshContext(h.mount);
  const event = await view.next((message) => message.n === 'place');
  assert.deepEqual(event, { t: 'evt', n: 'place', d: { view: 'v-1' } });
  await settle();
  assert.deepEqual(view.inbox.filter((message) => message.t === 'evt').map((message) => message.n), ['place'],
    'The view heard its own place back, or a context event for a place it was already told.');
});
