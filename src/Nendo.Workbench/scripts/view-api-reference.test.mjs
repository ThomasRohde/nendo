import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'vite';

// The view API reference an agent reads before it writes a custom view's code (W-094), held to
// the modules it describes. The api build writes it beside api.js; the local MCP serves that
// file as it was built. Every name in it is checked against the real table, parser or object,
// and the whole view it offers to start from is run against the real api.js.
const built = await build({ configFile: 'vite.api.config.ts', logLevel: 'error', build: { write: false } });
const output = Array.isArray(built) ? built.flatMap((result) => result.output) : built.output;
const apiSource = output.find((item) => item.type === 'chunk').code;
const asset = output.find((item) => item.type === 'asset' && item.fileName === '_nendo/view-api.json');

const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const broker = await bundleOf('src/extension-broker.ts');
const toolbarModel = await bundleOf('src/view-toolbar-model.ts');
const model = await bundleOf('src/extension-model.ts');
const protocol = await bundleOf('src/extension-api/protocol.ts');

const text = (source) => (typeof source === 'string' ? source : Buffer.from(source).toString('utf8'));
const reference = asset === undefined ? null : JSON.parse(text(asset.source));

/** The path a documented call names: `nendo.records.query(query)` is records.query. */
const pathOf = (call) => call.replace(/^nendo\./, '').replace(/\(.*$/, '');

test('the api build writes the reference beside api.js, saying when to read it', () => {
  assert.ok(reference !== null, 'The api build wrote no _nendo/view-api.json.');
  assert.equal(reference.apiVersion, protocol.apiVersion);
  assert.match(reference.readWhen, /^Only while you write a custom view's code\. Nothing else needs this/);
});

test('every method of the broker has one line, named by the call that reaches it', () => {
  assert.deepEqual(reference.methods.map((line) => line.method), [...broker.brokerMethodNames],
    'The reference lists other methods than the broker answers, or in another order.');
  for (const line of reference.methods) {
    assert.ok(line.call.startsWith(`nendo.${line.method}(`), `${line.method} is documented as ${line.call}.`);
    for (const key of ['params', 'answer']) assert.ok(typeof line[key] === 'string' && line[key].length > 0, `${line.method} has no ${key}.`);
  }
});

test('every function and value on window.nendo has a line, and every line is on window.nendo', () => {
  const window = { addEventListener: () => undefined };
  window.parent = window;
  vm.runInNewContext(apiSource, { window, console: { error: () => undefined } });
  const found = [];
  const walk = (object, prefix) => {
    for (const key of Object.keys(object)) {
      const value = object[key];
      const path = prefix + key;
      const namespace = typeof value === 'object' && value !== null && typeof value.then !== 'function' && Object.isFrozen(value);
      if (namespace) walk(value, `${path}.`);
      else found.push(path);
    }
  };
  walk(window.nendo, '');
  const documented = [...reference.methods, ...reference.helpers].map((line) => pathOf(line.call));
  assert.deepEqual([...documented].sort(), [...found].sort(),
    'window.nendo and the reference name different calls: a function added to api.js needs its line in reference.ts.');
  assert.equal(new Set(documented).size, documented.length, 'A call is documented twice.');
});

test('events, icons, theme tokens, Nendo\'s keys and the limits come from their tables', () => {
  assert.deepEqual(reference.events.names, [...protocol.viewEventNames]);
  assert.deepEqual(Object.keys(reference.events).filter((key) => key !== 'names').sort(), [...protocol.viewEventNames].sort(),
    'An event is described that a view cannot hear, or one a view can hear is not described.');
  assert.deepEqual(reference.toolbar.icons, [...toolbarModel.toolbarIcons]);
  assert.deepEqual(reference.theme.tokens, [...model.themeTokenNames]);
  assert.deepEqual(reference.toolbar.hostKeys, [...protocol.hostKeys]);
  assert.deepEqual(reference.limits, { ...protocol.extensionLimits });
});

test('the toolbar kinds and menu items are exactly the ones Nendo reads', () => {
  const samples = {
    button: { kind: 'button', id: 'b', label: 'B' },
    toggle: { kind: 'toggle', id: 't', label: 'T', pressed: true },
    choice: { kind: 'choice', id: 'c', label: 'C', options: [{ value: 'a', label: 'A' }], value: 'a' },
    select: { kind: 'select', id: 's', label: 'S', options: [{ value: 'a', label: 'A' }] },
    search: { kind: 'search', id: 'q', label: 'Find', placeholder: 'Find a record' },
    menu: { kind: 'menu', id: 'm', label: 'More', items: [{ id: 'm1', label: 'One' }] },
    group: { kind: 'group', label: 'Zoom', items: [{ kind: 'button', id: 'g1', label: 'In' }] },
    text: { kind: 'text', text: '12 records' },
    separator: { kind: 'separator' },
    spacer: { kind: 'spacer' },
  };
  const listed = (message) => message.replace(/^.*must be /, '').replace(/[.:].*$/, '').split(/, | or /).sort();
  const refusal = (read) => { try { read(); } catch (error) { return error.message; } assert.fail('A made-up kind was accepted.'); };

  const kinds = listed(refusal(() => toolbarModel.readToolbar({ items: [{ kind: 'made-up', id: 'x', label: 'X' }] })));
  assert.deepEqual(Object.keys(reference.toolbar.kinds).sort(), kinds, 'The reference lists other toolbar kinds than Nendo reads.');
  for (const kind of kinds) {
    assert.ok(samples[kind] !== undefined, `No sample of ${kind}: add one here.`);
    assert.doesNotThrow(() => toolbarModel.readToolbar({ items: [samples[kind]] }), `Nendo refused the documented kind ${kind}.`);
  }

  const items = listed(refusal(() => toolbarModel.readMenu({ items: [{ kind: 'made-up', id: 'x', label: 'X' }], x: 0, y: 0 })));
  assert.deepEqual(Object.keys(reference.toolbar.menuItems).sort(), items, 'The reference lists other menu items than Nendo reads.');
});

test('the whole view in the reference runs against the real api.js', async (t) => {
  const list = { children: [], replaceChildren(...children) { this.children = children; } };
  const document = {
    documentElement: { style: { setProperty: () => undefined }, dataset: {} },
    head: null,
    getElementById: (id) => (id === 'list' ? list : null),
    createElement: (tag) => ({ tagName: tag.toUpperCase(), textContent: '', onclick: null }),
  };
  const listeners = [];
  const parent = { postMessage: () => undefined };
  const errors = [];
  // The view's global is its window, as in a browser, so the example's bare `nendo` resolves.
  const window = vm.createContext({
    parent, document, setTimeout, clearTimeout, console: { error: (error) => errors.push(error) },
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
  });
  vm.runInContext('var window = globalThis;', window);
  vm.runInContext(apiSource, window);
  vm.runInContext(reference.example['view.js'], window);
  assert.match(reference.example['index.html'], /<script src="\/_nendo\/api\.js"><\/script>\s*<script src="view\.js"><\/script>/);

  const channel = new MessageChannel();
  t.after(() => { channel.port1.close(); channel.port2.close(); });
  const inbox = [];
  channel.port1.onmessage = (event) => inbox.push(event.data);
  const next = async (method) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = inbox.findIndex((message) => message.t === 'req' && message.m === method);
      if (index >= 0) return inbox.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`The example never asked for ${method}; it sent ${JSON.stringify(inbox).slice(0, 300)}.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const answer = (request, result) => channel.port1.postMessage({ t: 'res', id: request.id, ok: true, r: result });
  const record = (recordId, title) => ({ entityId: 'work', recordId, version: 1, values: { title }, exact: {}, labels: {}, calculated: {} });

  const context = {
    apiVersion: 1, viewId: 'view.list', kind: 'extensionRecordsSurface', placement: 'screen', title: 'List', packageId: 'org.example.list',
    entityId: 'work', recordId: null,
    bindings: { labelFieldId: 'title', statusFieldId: null, edgeEntityId: null, sourceFieldId: null, targetFieldId: null, fields: [], filters: [] },
    configuration: {}, theme: { mode: 'dark', tokens: { ink: '#ffffff' } }, locale: 'en', readOnly: false,
    methods: ['records.query', 'records.get', 'ui.openRecord', 'ui.setToolbar'],
  };
  for (const listener of listeners) listener({ source: parent, data: { nendo: 'connect', apiVersion: 1, context }, ports: [channel.port2] });

  const toolbar = await next('ui.setToolbar');
  assert.doesNotThrow(() => toolbarModel.readToolbar(toolbar.p), 'Nendo would refuse the toolbar the example declares.');
  answer(toolbar, null);
  answer(await next('records.query'), { items: [record('r1', 'Alpha'), record('r2', 'Beta')], nextCursor: null, changeSequence: 1 });
  for (let wait = 0; list.children.length < 2 && wait < 600; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(list.children.map((item) => item.textContent), ['Alpha', 'Beta'], 'The example drew no records.');

  list.children[1].onclick();
  assert.deepEqual((await next('ui.openRecord')).p, { entityId: 'work', recordId: 'r2' });
  channel.port1.postMessage({ t: 'evt', n: 'command', d: { id: 'refresh', value: null, source: 'toolbar' } });
  answer(await next('records.query'), { items: [record('r1', 'Alpha')], nextCursor: null, changeSequence: 2 });
  channel.port1.postMessage({ t: 'evt', n: 'changes', d: 3 });
  answer(await next('records.query'), { items: [], nextCursor: null, changeSequence: 3 });
  assert.deepEqual(errors, [], 'The example threw.');
});
