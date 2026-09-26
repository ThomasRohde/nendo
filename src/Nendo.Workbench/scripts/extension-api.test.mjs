import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'vite';

// The in-frame client a custom view loads as /_nendo/api.js (ADR-0013), built with the real
// vite.api.config.ts and run against a stand-in for the view's window. The Workbench end of the
// channel is played here: every request, answer and event crosses a real MessageChannel.
const built = await build({ configFile: 'vite.api.config.ts', logLevel: 'error', build: { write: false } });
const chunk = (Array.isArray(built) ? built.flatMap((result) => result.output) : built.output).find((item) => item.type === 'chunk');
const source = chunk.code;

test('the client is built as one classic script at _nendo/api.js that exports nothing', () => {
  assert.equal(chunk.fileName, '_nendo/api.js');
  assert.match(source, /^\(function\(\) \{/, 'The client is not wrapped in one function.');
  assert.doesNotMatch(source, /^\s*(export|import)\s/m, 'The client is a module, which a plain script tag cannot load.');
  assert.doesNotMatch(source, /chrome\.webview/, 'The client reaches for the host bridge.');
  assert.match(source, /apiVersion/);
});

test('a view opened on its own, outside Nendo, is told so instead of waiting forever', async () => {
  const window = { addEventListener: () => undefined };
  window.parent = window;
  vm.runInNewContext(source, { window, console: { error: () => undefined } });
  // Bounded, so a ready that never settles fails here instead of holding the run open.
  const settled = (promise) => Promise.race([promise, new Promise((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error('ready never settled'), { code: 'hung' })), 2000).unref();
  })]);
  await assert.rejects(settled(window.nendo.ready), (error) => error.code === 'not-framed' && /runs inside Nendo/.test(error.message));
  await assert.rejects(settled(window.nendo.records.query({ entityId: 'work' })), (error) => error.code === 'not-framed');
});

const baseContext = {
  apiVersion: 1, viewId: 'view.graph', kind: 'extensionGraphSurface', placement: 'screen', title: 'Links', packageId: 'org.example.graph',
  entityId: 'work', recordId: null,
  bindings: { labelFieldId: 'title', statusFieldId: 'status', edgeEntityId: 'link', sourceFieldId: 'from', targetFieldId: 'to', fields: [], filters: [] },
  configuration: {}, theme: { mode: 'light', tokens: { ink: '#13213d' } }, locale: 'en', readOnly: false,
  methods: ['schema.describe', 'records.query', 'records.get', 'records.count'],
};

/** A view's window, framed by a stand-in parent, with api.js run in it. */
function frame() {
  const sent = [];
  const listeners = [];
  const parent = { postMessage: (message, targetOrigin) => sent.push({ message, targetOrigin }) };
  const window = { parent, addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); } };
  const errors = [];
  vm.runInNewContext(source, { window, console: { error: (error) => errors.push(error) } });
  return { window, parent, sent, errors, deliver: (event) => { for (const listener of listeners) listener(event); } };
}

/** The Workbench's end of a fresh channel, connected with `context`. */
function connect(view, context = baseContext, t = null) {
  const channel = new MessageChannel();
  const inbox = [];
  channel.port1.onmessage = (event) => inbox.push(event.data);
  const workbench = {
    port: channel.port1, inbox,
    send: (message) => channel.port1.postMessage(message),
    next: (predicate) => until(() => inbox.find(predicate), `a message from the view; it sent ${JSON.stringify(inbox).slice(0, 300)}`),
    close: () => { channel.port1.close(); channel.port2.close(); },
  };
  t?.after(() => workbench.close());
  view.deliver({ source: view.parent, data: { nendo: 'connect', apiVersion: 1, context }, ports: [channel.port2] });
  return workbench;
}

async function until(probe, what) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const found = probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

// What the client builds is made in its own realm, whose arrays and objects are not this one's;
// comparing them as JSON compares what a view would actually hold.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('on load the client says hello to the window that framed it, and to nothing else', () => {
  const view = frame();
  assert.deepEqual(plain(view.sent), [{ message: { nendo: 'hello', apiVersion: 1 }, targetOrigin: '*' }]);
  assert.equal(view.window.nendo.apiVersion, 1);
  assert.equal(view.window.nendo.context, null);
  assert.equal(view.window.nendo.has('records.count'), false, 'A method was offered before the Workbench connected.');
});

test('a connect is accepted only from the parent window, with one port and a context', async (t) => {
  const view = frame();
  let readied = false;
  view.window.nendo.ready.then(() => { readied = true; });
  const stray = new MessageChannel();
  t.after(() => { stray.port1.close(); stray.port2.close(); });
  const connectMessage = { nendo: 'connect', apiVersion: 1, context: baseContext };
  view.deliver({ source: { postMessage() {} }, data: connectMessage, ports: [stray.port2] });
  view.deliver({ source: null, data: connectMessage, ports: [stray.port2] });
  view.deliver({ source: view.parent, data: connectMessage, ports: [] });
  view.deliver({ source: view.parent, data: { ...connectMessage, context: { viewId: 'x' } }, ports: [stray.port2] });
  view.deliver({ source: view.parent, data: { nendo: 'hello', apiVersion: 1 }, ports: [stray.port2] });
  await settle();
  assert.equal(view.window.nendo.context, null, 'A connect from somewhere other than the framing window was taken.');
  assert.equal(readied, false);
  connect(view, baseContext, t);
  assert.equal((await view.window.nendo.ready).viewId, 'view.graph');
  assert.equal(view.window.nendo.context.viewId, 'view.graph');
  assert.equal(view.window.nendo.has('records.count'), true);
  assert.equal(view.window.nendo.has('proposal.promote'), false);
});

test('requests, answers, refusals and events travel over the port', async (t) => {
  const view = frame();
  const workbench = connect(view, baseContext, t);
  const nendo = view.window.nendo;
  const count = nendo.records.count({ entityId: 'tasks', filters: [{ fieldId: 'due', operator: 'le', value: '2026-09-25' }], skipped: undefined });
  const request = await workbench.next((message) => message.t === 'req');
  assert.deepEqual(request, { t: 'req', id: request.id, m: 'records.count', p: { entityId: 'tasks', filters: [{ fieldId: 'due', operator: 'le', value: '2026-09-25' }] } });
  workbench.send({ t: 'res', id: request.id, ok: true, r: { count: 3 } });
  assert.deepEqual(plain(await count), { count: 3 });

  const refused = nendo.records.query({ entityId: 'tasks' });
  const second = await workbench.next((message) => message.t === 'req' && message.id !== request.id);
  workbench.send({ t: 'res', id: second.id, ok: false, e: { code: 'invalid-params', message: 'limit must be a whole number from 1 to 200.' } });
  await assert.rejects(refused, (error) => error.name === 'NendoError' && error.code === 'invalid-params' && /limit/.test(error.message));

  const heard = [];
  nendo.changes.subscribe((sequence) => heard.push(sequence));
  const themes = [];
  nendo.on('theme', (theme) => themes.push(theme.mode));
  workbench.send({ t: 'evt', n: 'changes', d: 12 });
  workbench.send({ t: 'evt', n: 'theme', d: { mode: 'dark', tokens: { ink: '#edf3ff' } } });
  await until(() => heard.length === 1 && themes.length === 1, 'the two events');
  assert.deepEqual(heard, [12]);
  assert.deepEqual(themes, ['dark']);
  assert.equal(nendo.ui.theme.mode, 'dark');
  assert.equal(nendo.context.theme.tokens.ink, '#edf3ff');
  workbench.send({ t: 'ping', id: 41 });
  assert.deepEqual(await workbench.next((message) => message.t === 'pong'), { t: 'pong', id: 41 });
  assert.throws(() => nendo.on('proposals', () => {}), /not an event/);
});

test('a reconnect fails what was waiting with disconnected, and later requests use the new port', async (t) => {
  const view = frame();
  const first = connect(view, baseContext, t);
  const nendo = view.window.nendo;
  const contexts = [];
  nendo.on('context', (context) => contexts.push(context.title));
  const waiting = nendo.records.count({ entityId: 'tasks' });
  await first.next((message) => message.t === 'req');
  const second = connect(view, { ...baseContext, title: 'Links again' }, t);
  await assert.rejects(waiting, (error) => error.code === 'disconnected');
  assert.deepEqual(contexts, ['Links again']);
  const later = nendo.records.count({ entityId: 'tasks' });
  const request = await second.next((message) => message.t === 'req');
  second.send({ t: 'res', id: request.id, ok: true, r: { count: 1 } });
  assert.equal((await later).count, 1);
  assert.equal(first.inbox.filter((message) => message.t === 'req').length, 1, 'A request after the reconnect went to the old port.');
});

// R-002: a reference assignment needs the target's version, so the client must send it.
test('create and update send the reference targets’ versions a view passes, and the record ID create still takes alone', async (t) => {
  const view = frame();
  const workbench = connect(view, { ...baseContext, methods: [...baseContext.methods, 'records.create', 'records.update'] }, t);
  const nendo = view.window.nendo;
  const requests = () => workbench.inbox.filter((message) => message.t === 'req');
  const answerLast = async (count) => {
    await until(() => requests().length === count, `request ${count}`);
    const request = requests().at(-1);
    workbench.send({ t: 'res', id: request.id, ok: true, r: null });
    return plain(request);
  };
  const created = nendo.records.create('tasks', { title: 'Cure', owner: 'p1' }, { recordId: 't9', targetVersions: { owner: 7 } });
  assert.deepEqual((await answerLast(1)).p, { entityId: 'tasks', values: { title: 'Cure', owner: 'p1' }, recordId: 't9', targetVersions: { owner: 7 } });
  await created;
  const legacy = nendo.records.create('tasks', { title: 'Cure' }, 't10');
  assert.deepEqual((await answerLast(2)).p, { entityId: 'tasks', values: { title: 'Cure' }, recordId: 't10' });
  await legacy;
  const updated = nendo.records.update({ entityId: 'tasks', recordId: 't9', version: 1 }, { owner: 'p2' }, { targetVersions: { owner: 3 } });
  assert.deepEqual((await answerLast(3)).p, { entityId: 'tasks', recordId: 't9', version: 1, values: { owner: 'p2' }, targetVersions: { owner: 3 } });
  await updated;
  const plainUpdate = nendo.records.update({ entityId: 'tasks', recordId: 't9', version: 2 }, { title: 'x' });
  assert.deepEqual((await answerLast(4)).p, { entityId: 'tasks', recordId: 't9', version: 2, values: { title: 'x' } });
  await plainUpdate;
});

test('the client keeps an honest view inside the bounds: 256 KiB a request, eight in flight', async (t) => {
  const view = frame();
  const workbench = connect(view, baseContext, t);
  const nendo = view.window.nendo;
  await assert.rejects(nendo.records.count({ entityId: 'tasks', note: 'x'.repeat(256 * 1024) }), (error) => error.code === 'too-large');
  const calls = Array.from({ length: 9 }, (_, index) => nendo.records.count({ entityId: `t${index}` }));
  await until(() => workbench.inbox.filter((message) => message.t === 'req').length === 8, 'eight requests');
  await settle();
  const sent = workbench.inbox.filter((message) => message.t === 'req');
  assert.equal(sent.length, 8, 'A ninth request was sent while eight were waiting, or the too-large one was sent.');
  workbench.send({ t: 'res', id: sent[0].id, ok: true, r: { count: 0 } });
  await until(() => workbench.inbox.filter((message) => message.t === 'req').length === 9, 'the ninth request');
  for (const message of workbench.inbox.filter((candidate) => candidate.t === 'req').slice(1))
    workbench.send({ t: 'res', id: message.id, ok: true, r: { count: 0 } });
  await Promise.all(calls);
});

test('queryAll pages through a record type and starts again when the file moves under it', async (t) => {
  const view = frame();
  const workbench = connect(view, baseContext, t);
  const record = (recordId) => ({ entityId: 'tasks', recordId, version: 1, values: {}, exact: {}, labels: {}, calculated: {} });
  let firstPages = 0;
  workbench.port.onmessage = (event) => {
    const message = event.data;
    if (message.t !== 'req') return;
    assert.equal(message.m, 'records.query');
    assert.equal(message.p.limit, 200);
    if (message.p.cursor === null) {
      firstPages += 1;
      workbench.send({ t: 'res', id: message.id, ok: true, r: { items: [record(`a${firstPages}`)], nextCursor: 'page-2', changeSequence: firstPages } });
    } else if (firstPages === 1) {
      workbench.send({ t: 'res', id: message.id, ok: false, e: { code: 'stale-cursor', message: 'The file changed during paging.' } });
    } else {
      workbench.send({ t: 'res', id: message.id, ok: true, r: { items: [record('b')], nextCursor: null, changeSequence: 2 } });
    }
  };
  const records = await view.window.nendo.records.queryAll({ entityId: 'tasks' });
  assert.deepEqual(plain(records.map((item) => item.recordId)), ['a2', 'b'], 'The read kept a page from before the file moved.');
  assert.equal(firstPages, 2);
});

test('loadGraph gives nodes, the edges between them, the fields the view names, and a count of what it left out', async (t) => {
  const view = frame();
  const context = {
    ...baseContext,
    bindings: {
      ...baseContext.bindings,
      fields: [{ fieldId: 'owner', entityId: 'work' }, { fieldId: 'weight', entityId: 'link' }],
      filters: [{ fieldId: 'due', entityId: 'work', operator: 'le', value: null, valueKind: 'today' }, { fieldId: 'kind', entityId: 'link', operator: 'isNotNull', value: null, valueKind: 'literal' }],
    },
  };
  const workbench = connect(view, context, t);
  const record = (entityId, recordId, values, labels = {}, exact = {}) => ({ entityId, recordId, version: 1, values, exact, labels, calculated: {} });
  const queries = [];
  workbench.port.onmessage = (event) => {
    const message = event.data;
    if (message.t !== 'req') return;
    if (message.m === 'schema.describe') {
      workbench.send({ t: 'res', id: message.id, ok: true, r: { purpose: null, changeSequence: 1, screens: [], commands: [], entities: [
        { entityId: 'work', displayName: 'Work', fields: [
          { fieldId: 'title', displayName: 'Title', storageKind: 'text', choices: [] },
          { fieldId: 'status', displayName: 'Status', storageKind: 'text', choices: [{ id: 'open', displayName: 'Open', retired: false, tone: 'blue' }] },
          { fieldId: 'owner', displayName: 'Owner', storageKind: 'reference', choices: [] },
        ] },
        { entityId: 'link', displayName: 'Link', fields: [{ fieldId: 'weight', displayName: 'Weight', storageKind: 'decimal', choices: [] }] },
      ] } });
      return;
    }
    queries.push(message.p);
    const items = message.p.entityId === 'work'
      ? [record('work', 'w1', { title: 'Plan', status: 'open', owner: 'p1' }, { owner: 'Ada' }), record('work', 'w2', { title: null, status: null, owner: null })]
      : [record('link', 'l1', { from: 'w1', to: 'w2', weight: 1.5 }, {}, { weight: '1.50' }), record('link', 'l2', { from: 'w1', to: 'w9', weight: 2 }), record('link', 'l3', { from: 'w2', to: null, weight: null })];
    workbench.send({ t: 'res', id: message.id, ok: true, r: { items, nextCursor: null, changeSequence: 1 } });
  };
  const graph = await view.window.nendo.view.loadGraph();
  assert.deepEqual(plain(graph.nodes.map(({ id, label, status, values }) => ({ id, label, status, values }))), [
    { id: 'w1', label: 'Plan', status: 'open', values: { owner: 'p1' } },
    { id: 'w2', label: '', status: null, values: { owner: null } },
  ]);
  assert.equal(graph.nodes[0].record.labels.owner, 'Ada');
  assert.deepEqual(plain(graph.edges.map(({ id, source, target, values }) => ({ id, source, target, values }))), [{ id: 'l1', source: 'w1', target: 'w2', values: { weight: 1.5 } }]);
  assert.equal(graph.edges[0].record.exact.weight, '1.50');
  assert.equal(graph.hiddenEdges, 2, 'A link to a record that is not a node, or to nothing, was drawn or not counted.');
  assert.deepEqual(plain(graph.fields), [
    { fieldId: 'owner', entityId: 'work', displayName: 'Owner', storageKind: 'reference' },
    { fieldId: 'weight', entityId: 'link', displayName: 'Weight', storageKind: 'decimal' },
  ]);
  const nodeQuery = queries.find((query) => query.entityId === 'work');
  assert.equal(nodeQuery.filters.length, 1);
  assert.equal(nodeQuery.filters[0].operator, 'le');
  assert.match(nodeQuery.filters[0].value, /^\d{4}-\d{2}-\d{2}$/, 'A filter on today was sent without the date it means.');
  assert.deepEqual(plain(queries.find((query) => query.entityId === 'link').filters[0]), { fieldId: 'kind', operator: 'isNotNull' });
});

// R-003: a view's authored `today` on a DateTime field went out as a bare date, which the
// host refuses for a DateTime comparison; it has to be the instant the day begins, with a zone.
test('a view’s authored today is a date on a Date field and a zoned instant on a DateTime field', async (t) => {
  const view = frame();
  const context = {
    ...baseContext, recordId: null,
    bindings: { ...baseContext.bindings, edgeEntityId: null, filters: [
      { fieldId: 'due', entityId: 'work', operator: 'le', value: null, valueKind: 'today', storageKind: 'date' },
      { fieldId: 'createdAt', entityId: 'work', operator: 'le', value: null, valueKind: 'today', storageKind: 'dateTime' },
    ] },
  };
  const workbench = connect(view, context, t);
  const queries = [];
  workbench.port.onmessage = (event) => {
    const message = event.data;
    if (message.t !== 'req') return;
    queries.push(message.p);
    workbench.send({ t: 'res', id: message.id, ok: true, r: { items: [], nextCursor: null, changeSequence: 1 } });
  };
  await view.window.nendo.view.loadRecords();
  const [date, instant] = plain(queries[0].filters);
  assert.match(date.value, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(instant.value, /^\d{4}-\d{2}-\d{2}T00:00:00[+-]\d{2}:\d{2}$/, 'A DateTime today was sent without the explicit zone the host requires.');
  assert.equal(instant.value.slice(0, 10), date.value, 'The instant and the date name different days.');
});
