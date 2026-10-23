import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as M from '../../extensions/archi/model.js';
import * as canvasModule from '../../extensions/archi/canvas.js';
const { buildMirror, writesFor, applyWrites } = canvasModule;
import { textAlternative } from '../../extensions/archi/kit/nendo-view-kit.js';

// Execute the shipped write controller/property renderer. The stand-ins cover only the
// service and DOM boundaries; the diff is the generated canvas's actual implementation.
const source = readFileSync(new URL('../../extensions/archi/view.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8')).records;
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `The production section ${start} could not be found.`);
  return source.slice(from, to);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function propertyController() {
  let stored = [{ entityId: M.E.concept, recordId: 'owner', version: 1,
    values: { 'ar.concept.name': 'Customer', 'ar.concept.category': 'Element' } }];
  const state = { model: M.buildModel({ records: stored }), selected: 'owner', readOnly: false,
    draftProperties: { owner: 'owner', rows: [{ key: '', value: '' }] } };
  const calls = [], statuses = [];
  const context = vm.createContext({ M, state, editor: null, renderProperties() {},
    setStatus: (message, problem) => statuses.push({ message, problem }), describe: error => error.message,
    nendo: { has: () => true, records: { async batch(writes) {
      const response = deferred(); calls.push({ writes, response });
      await response.promise;
      const answers = writes.map(write => {
        const found = stored.find(record => record.recordId === write.recordId);
        if (write.op === 'create') {
          assert.equal(found, undefined, 'A queued property edit tried to recreate the same record.');
          stored.push({ entityId: write.entityId, recordId: write.recordId, version: 1, values: { ...write.values } });
          return { recordId: write.recordId, version: 1 };
        }
        assert.equal(write.version, found?.version, 'A queued property edit used a stale version.');
        if (write.op === 'delete') stored = stored.filter(record => record !== found);
        else { found.values = { ...found.values, ...write.values }; found.version++; }
        return { recordId: write.recordId, version: write.op === 'delete' ? null : found.version };
      });
      return { records: answers };
    } } },
    readAll: async () => { state.model = M.buildModel({ records: structuredClone(stored) }); },
  });
  vm.runInContext(section('let writing = Promise.resolve();', '// ---------------------------------------------------------------- the tree') +
    section('function currentPropertyRows(', '// ---------------------------------------------------------------- making and removing') +
    '\nglobalThis.api = { propertyChanged, saveProperties, currentPropertyRows };', context);
  const change = (part, value, index = 0) => context.api.propertyChanged({ target: {
    dataset: { prop: part }, value, closest: () => ({ dataset: { index: String(index) } }),
  } });
  const waitForCall = async count => {
    for (let turn = 0; calls.length < count && turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, count, `Expected ${count} property writes, found ${calls.length}.`);
  };
  return { state, calls, statuses, change, waitForCall, stored: () => stored, api: context.api };
}

test('rapid property key/value entry keeps one record and the newest draft until both writes finish', async () => {
  const host = propertyController();
  const key = host.change('key', 'Department');
  await host.waitForCall(1);
  assert.equal(host.state.draftProperties?.rows[0].key, 'Department', 'A pending property create discarded its draft.');
  const value = host.change('value', 'Sales');
  const id = host.state.draftProperties.rows[0].recordId;
  host.calls[0].response.resolve();
  await key;
  await host.waitForCall(2);
  assert.equal(host.state.draftProperties.rows[0].value, 'Sales', 'The earlier save cleared a newer draft.');
  assert.equal(host.calls[1].writes[0].recordId, id);
  assert.equal(host.calls[1].writes[0].op, 'update');
  host.calls[1].response.resolve();
  await value;
  const properties = host.stored().filter(record => record.entityId === M.E.property);
  assert.equal(properties.length, 1);
  assert.equal(properties[0].values['ar.property.key'], 'Department');
  assert.equal(properties[0].values['ar.property.value'], 'Sales');
  assert.equal(host.state.draftProperties, null);
});

test('a refused property create retains its values and stable identity for retry', async () => {
  const host = propertyController();
  const first = host.change('key', 'Department');
  await host.waitForCall(1);
  const id = host.calls[0].writes[0].recordId;
  host.calls[0].response.reject(new Error('fixture refusal'));
  await first;
  assert.equal(host.state.draftProperties?.rows[0].key, 'Department', 'A refused property create discarded its draft.');
  assert.match(host.statuses.at(-1).message, /fixture refusal/);
  const retry = host.change('value', 'Sales');
  await host.waitForCall(2);
  assert.equal(host.calls[1].writes[0].recordId, id, 'Retry allocated a different property identity.');
  host.calls[1].response.resolve();
  await retry;
  assert.equal(host.stored().filter(record => record.entityId === M.E.property).length, 1);
  assert.equal(host.stored().find(record => record.recordId === id).values['ar.property.value'], 'Sales');
});

test('a property draft that already matches the file is settled, so later changes show', async () => {
  const host = propertyController();
  const first = host.change('key', 'Department');
  await host.waitForCall(1); host.calls[0].response.resolve(); await first;
  const owner = () => host.state.model.records.get('owner');
  const rows = host.api.currentPropertyRows(owner()).map(row => ({ ...row }));
  // Add a property, then remove the blank row again: nothing differs from the file.
  host.state.draftProperties = { owner: 'owner', rows: [...rows, { key: '', value: '' }] };
  await host.api.saveProperties(owner(), rows);
  assert.equal(host.calls.length, 1, 'An unchanged property list was written.');
  assert.equal(host.state.draftProperties, null, 'A draft identical to the file outlived its save.');
  const stored = host.stored().find(record => record.entityId === M.E.property);
  stored.values['ar.property.value'] = 'Changed elsewhere'; stored.version++;
  host.state.model = M.buildModel({ records: structuredClone(host.stored()) });
  assert.equal(host.api.currentPropertyRows(owner())[0].value, 'Changed elsewhere', 'A settled draft hid a later change to the properties.');
});

test('reversed read completion installs only the newest model', async () => {
  const replies = [], rendered = [], state = { loaded: true };
  const context = vm.createContext({ state, READS: { concepts: M.E.concept }, M, READ_MAX: 50000,
    nendo: { records: { queryAll() { const reply = deferred(); replies.push(reply); return reply.promise; } } },
    render: () => rendered.push(state.model.records.get('owner').version), startEmptyModel() {},
    readAgentRecords: () => Promise.resolve(null), keptCreates: () => false,
  });
  const reading = section('// ---------------------------------------------------------------- reading', '/**\n * A new Archi model');
  vm.runInContext(reading + '\nglobalThis.load = readAll;', context);
  const old = context.load(), newer = context.load();
  const response = version => [{ entityId: M.E.concept, recordId: 'owner', version, values: {} }];
  replies[1].resolve(response(2)); await newer;
  replies[0].resolve(response(1)); await old;
  assert.equal(state.model.records.get('owner').version, 2, 'An older read replaced the newer model.');
  assert.deepEqual(rendered, [2]);
});

test('a superseded read waits for the newest model before a queued writer can continue', async () => {
  const replies = [], state = { loaded: true }, observed = [];
  const context = vm.createContext({ state, READS: { concepts: M.E.concept }, M, READ_MAX: 50000,
    nendo: { records: { queryAll() { const reply = deferred(); replies.push(reply); return reply.promise; } } },
    render() {}, startEmptyModel() {},
    readAgentRecords: () => Promise.resolve(null), keptCreates: () => false,
  });
  vm.runInContext(section('// ---------------------------------------------------------------- reading', '/**\n * A new Archi model') + '\nglobalThis.load = readAll;', context);
  const old = context.load().then(() => observed.push(state.model.records.get('owner').version));
  const newer = context.load();
  replies[0].resolve([{ entityId: M.E.concept, recordId: 'owner', version: 1, values: {} }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, [], 'A superseded reread let a queued write plan before the new model was installed.');
  replies[1].resolve([{ entityId: M.E.concept, recordId: 'owner', version: 2, values: {} }]);
  await Promise.all([old, newer]);
  assert.deepEqual(observed, [2]);
});

test('diagram text alternatives carry every nonempty concept name', () => {
  const model = M.buildModel(fixture), view = model.of(M.E.view).find(candidate =>
    model.of(M.E.item).some(item => item.values['ar.item.view'] === candidate.recordId && item.values['ar.item.kind'] === 'Element'));
  const names = model.of(M.E.item).filter(item => item.values['ar.item.view'] === view.recordId && item.values['ar.item.kind'] === 'Element')
    .map(item => M.label(model, model.records.get(item.values['ar.item.concept']))).filter(Boolean);
  const rendered = section("items: state.model.of(M.E.item).filter", '  })).catch').slice('items: '.length).replace(/,\s*$/, '');
  const items = vm.runInNewContext(rendered, { state: { model }, M, view });
  let list;
  const doc = { createElement: () => ({ textContent: '', setAttribute() {}, replaceChildren(...children) { this.children = children; } }) };
  textAlternative({ ownerDocument: doc, querySelector: () => null, append(value) { list = value; } }, { label: 'Diagram', items });
  assert.ok(names.length > 0);
  assert.deepEqual(list.children.map(entry => entry.textContent), names, 'Diagram text alternative entries lost their concept names.');
});

function newElements(count, extraBox = false) {
  const before = buildMirror(fixture), after = structuredClone(before);
  const view = Object.values(after.views)[0];
  const folder = Object.values(after.folders).find(candidate => candidate.folderType === 'business');
  for (let index = 0; index < count; index++) {
    const elementId = `ar-id-bound-element-${index}`, boxId = `ar-id-bound-box-${index}`;
    after.elements[elementId] = { id: elementId, kind: 'element', type: 'BusinessActor', name: `Actor ${index}`,
      documentation: '', properties: [], profileIds: [], folderId: folder.id };
    folder.itemIds.push(elementId);
    after.nodes[boxId] = { id: boxId, viewId: view.id, parentId: view.id, nodeType: 'element', elementId,
      bounds: { x: index * 10, y: 10, width: 120, height: 55 }, childIds: [], sourceConnectionIds: [], targetConnectionIds: [] };
    view.childIds.push(boxId);
  }
  if (extraBox) {
    const boxId = 'ar-id-bound-extra-box';
    after.nodes[boxId] = { ...structuredClone(after.nodes['ar-id-bound-box-0']), id: boxId };
    view.childIds.push(boxId);
  }
  return { before, after, viewId: view.id };
}

function controller(draft, batch = true, failAt = null) {
  let stored = structuredClone(fixture), readCalls = 0;
  const calls = [], statuses = [], saved = new Map();
  const state = { readOnly: false, openView: draft.viewId, pending: 0 };
  const context = vm.createContext({
    state, editor: { model: () => draft.after, viewId: () => draft.viewId, canUndo: () => false }, editSets: fixture, editBase: draft.before,
    canvasModule: { writesFor }, EDITS_KEY: 'archi-edits', keptProposal: null, appliedWrite: () => [],
    localStorage: { setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    declareToolbar() {}, markStale() {}, refreshVisualiser() {}, describe: error => error.message, setStatus: (message, problem = false) => statuses.push({ message, problem }),
    async readAll() { readCalls++; },
    nendo: { has: () => batch, records: {
      async batch(writes) {
        calls.push(writes);
        if (calls.length === failAt) throw new Error('Something it changes has changed since.');
        // The fixture enforces the Engine's per-call created-record version exemption. A
        // second chunk must name a target version for records created by the first chunk.
        const known = new Map(Object.values(stored).flat().map(record => [record.recordId, record]));
        const created = new Set();
        for (const write of writes) {
          for (const field of ['ar.item.concept', 'ar.property.concept']) {
            const id = write.values?.[field];
            if (id && !created.has(id) && write.targetVersions?.[field] !== known.get(id)?.version)
              throw new Error(`${field} points at ${id} without the version it was chosen at. Select the target again so its current version can be checked.`);
          }
          if (write.op === 'create') created.add(write.recordId);
        }
        stored = applyWrites(stored, writes);
        for (const record of Object.values(stored).flat()) if (created.has(record.recordId)) record.version = 1;
      },
      async create(...args) { calls.push(args); }, async update(...args) { calls.push(args); }, async delete(...args) { calls.push(args); },
    } },
  });
  vm.runInContext(section('let writing = Promise.resolve();', '// ---------------------------------------------------------------- the tree') +
    section('function keepEdits(', 'function renderEditor(') +
    section('function commitEdits(', 'function discardEdits(') +
    '\nglobalThis.api = { write, waitingWrites, editsChanged, commitEdits, saved, undoName };', context);
  context.api.editsChanged();
  return { api: context.api, calls, saved, statuses, state, stored: () => stored, readCalls: () => readCalls };
}

for (const [count, extraBox, expected] of [[100, true, 201], [101, false, 202]]) {
  test(`a Commit of ${expected} dependent writes saves nothing and retains the whole editor draft`, async () => {
    const host = controller(newElements(count, extraBox));
    assert.equal(host.api.waitingWrites().length, expected);
    const draftBefore = host.saved.get('archi-edits');
    await host.api.commitEdits();
    const persisted = Object.values(host.stored()).flat().length - Object.values(fixture).flat().length;
    assert.equal(host.calls.length, 0, `An over-limit Commit sent ${host.calls.length} write requests and persisted ${persisted} records; it must save nothing.`);
    assert.deepEqual(host.stored(), fixture, 'An over-limit Commit partially persisted its dependent records.');
    assert.equal(host.readCalls(), 0, 'A preflight refusal reread/rebased the draft.');
    assert.equal(host.state.pending, expected);
    assert.equal(host.saved.get('archi-edits'), draftBefore, 'A preflight refusal changed the saved editor draft.');
    assert.equal(host.api.waitingWrites().length, expected);
    assert.equal(host.statuses.at(-1).problem, true);
    assert.match(host.statuses.at(-1).message, /at most 200.*Nothing was saved/);
  });
}

test('exactly 200 dependent writes are sent together and every element and box is saved', async () => {
  const host = controller(newElements(100));
  assert.equal(host.api.waitingWrites().length, 200);
  await host.api.commitEdits();
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].length, 200);
  assert.equal(Object.values(host.stored()).flat().length - Object.values(fixture).flat().length, 200);
  assert.equal(host.readCalls(), 1);
  assert.equal(host.statuses.at(-1).problem, false);
});

test('an older host without records.batch is not held to the batch limit: a 202-write Commit goes one by one', async () => {
  const host = controller(newElements(101), false);
  await host.api.commitEdits();
  assert.equal(host.calls.length, 202, 'The one-by-one path was refused by a limit that belongs to records.batch.');
  assert.ok(!host.statuses.some(status => /at most 200/.test(status.message)), 'An older host was told about a batch limit it does not use.');
});

// A delete is planned from records that already exist, so a later batch names nothing an
// earlier one created: over 200 writes it goes in batches of 200, and is
// not refused. The largest folder delete the Archisurance fixture offers is over 200 writes.
function largestFolderDelete() {
  const model = M.buildModel(fixture);
  const plans = model.of(M.E.folder).filter(folder => folder.values['ar.folder.parent'])
    .map(folder => ({ name: M.label(model, folder), writes: M.deletePlan(model, [folder.recordId]).writes }))
    .sort((left, right) => right.writes.length - left.writes.length);
  assert.ok(plans[0].writes.length > 200, `The fixture's largest folder delete is only ${plans[0].writes.length} writes.`);
  return plans[0];
}

for (const batch of [true, false]) {
  test(`a folder delete over 200 writes is ${batch ? 'sent in batches of 200' : 'written one by one on an older host'} and not refused`, async () => {
    const plan = largestFolderDelete();
    const host = controller(newElements(0), batch);
    await host.api.write(() => plan.writes, `Delete ${plan.name}`);
    assert.ok(!host.statuses.some(status => status.problem),
      `Delete ${plan.name} (${plan.writes.length} writes) was refused: ${host.statuses.map(status => status.message).join(' | ')}`);
    if (batch) {
      assert.deepEqual(host.calls.map(call => call.length), [200, plan.writes.length - 200]);
      const gone = new Set(plan.writes.map(write => write.recordId));
      assert.ok(!Object.values(host.stored()).flat().some(record => gone.has(record.recordId)), 'A deleted record is still stored.');
    } else {
      assert.equal(host.calls.length, plan.writes.length);
    }
    assert.equal(host.readCalls(), 1);
  });
}

for (const named of [false, true]) for (const surface of ['tree', 'properties']) {
  test(`${named ? 'named' : 'unnamed'} relationship cycles render in ${surface}`, () => {
    const relation = (id, other) => ({ entityId: M.E.concept, recordId: id, version: 1, values: {
      'ar.concept.name': named ? `<${id}>` : '', 'ar.concept.type': 'type', 'ar.concept.folder': 'relations',
      'ar.concept.category': 'Relationship', 'ar.concept.source': other, 'ar.concept.target': 'element',
    } });
    const sets = { records: [
      { entityId: M.E.type, recordId: 'type', version: 1, values: { 'ar.type.key': 'ServingRelationship', 'ar.type.name': 'Serving', 'ar.type.layer': 'Relationship', 'ar.type.category': 'Relationship' } },
      { entityId: M.E.folder, recordId: 'relations', version: 1, values: { 'ar.folder.name': 'Relations', 'ar.folder.kind': 'Relations' } },
      { entityId: M.E.concept, recordId: 'element', version: 1, values: { 'ar.concept.name': 'Actor', 'ar.concept.category': 'Element' } },
      relation('A', 'B'), relation('B', 'A'), relation('self', 'self'),
    ] };
    const model = M.buildModel(sets);
    if (surface === 'tree') {
      const rows = M.treeRows(model, new Set(['relations'])).filter(row => row.entityId === M.E.concept);
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.match(row.label, /\[cycle\]/);
        assert.ok(row.label.length < 200, `A cycle produced an unbounded label of ${row.label.length} characters.`);
      }
      return;
    }
    for (const id of ['A', 'B', 'self']) {
      const pane = { innerHTML: '', dataset: {}, contains: () => false, querySelectorAll: () => [] };
      const context = vm.createContext({ M, state: { model, sets, selected: id, readOnly: false }, $: () => pane, canvasModule, canvasReady: Promise.resolve(),
        document: { activeElement: null }, LAYER_TONE: { Relationship: 'grey' }, tone: () => '',
        escape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      });
      vm.runInContext(section('function listOf(', 'function renderDiagram(') +
        section('function renderAnalysis(', 'function renderCentre(') +
        section('const field = ', 'function saveProperties(') + '\nrenderProperties();', context);
      assert.match(pane.innerHTML, /<h2>.*\[cycle\]/);
      assert.ok(pane.innerHTML.includes(`data-select="${id === 'self' ? 'self' : id === 'A' ? 'B' : 'A'}"`), 'The cyclic source is not selectable.');
      assert.ok(pane.innerHTML.includes('data-select="element"'), 'The target is not selectable.');
      if (named) assert.ok(pane.innerHTML.includes(`&lt;${id}&gt;`), 'A named cycle lost its escaped name.');
    }
  });
}

test('the same relationship at both endpoints is labelled twice without being mistaken for a cycle', () => {
  const record = (id, values) => ({ entityId: M.E.concept, recordId: id, version: 1, values });
  const leaf = record('leaf', { 'ar.concept.name': 'Actor', 'ar.concept.category': 'Element' });
  const relation = record('relation', { 'ar.concept.category': 'Relationship', 'ar.concept.source': 'leaf', 'ar.concept.target': 'leaf' });
  const outer = record('outer', { 'ar.concept.category': 'Relationship', 'ar.concept.source': 'relation', 'ar.concept.target': 'relation' });
  const model = M.buildModel({ records: [leaf, relation, outer] });
  assert.equal(M.label(model, outer), 'Relationship (Relationship (Actor – Actor) – Relationship (Actor – Actor))');
});

test("on a Nendo without the newer row icons the row is declared again with words where they would be, and not left for the view's own", async () => {
  const declared = [];
  let left = null;
  const context = vm.createContext({
    M, describe: error => error?.message ?? String(error), summary: () => '1 element', TextEncoder, $: () => null,
    state: { nativeChrome: true, filter: { text: '', layer: '' }, openView: 'ar-view', readOnly: false, editing: true, pending: 0, styleShown: false, validator: { open: false }, visualiser: { open: false }, agent: { available: true, open: false }, zoom: 1, transparent: false },
    canvasModule: { createEditor() {}, editorSettings: () => ({ grid: false, snap: true, guides: true }) },
    editor: { canUndo: () => false, canRedo: () => false },
    undoName: () => null, redoName: () => null,
    // The Specializations Manager's New and filter entries, which a model with no specializations does not have.
    specializedItems: () => [], specializationFilter: () => [],
    leaveNativeChrome: reason => { left = reason; },
    nendo: { ui: { setToolbar(toolbar) {
      declared.push(toolbar);
      const icons = JSON.stringify(toolbar).match(/"icon":"(clipboard|layout|undo|redo)"/g);
      return icons ? Promise.reject(new Error(`items[9].icon must be one of Nendo's icons: plus, minus, layers.`)) : Promise.resolve();
    } } },
  });
  vm.runInContext(section('const TOOLBAR_BYTES', 'function arrange(') + '\ndeclareToolbar();', context);
  for (let waited = 0; declared.length < 2 && waited < 50; waited++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(declared.length, 2, 'The row was not declared again.');
  assert.equal(left, null, `The workbench left Nendo's row: ${left}.`);
  const plain = JSON.stringify(declared[1]);
  assert.doesNotMatch(plain, /"icon":"(clipboard|layout|undo|redo)"/);
  const find = (items, id) => items.flatMap(item => [item, ...(item.items ?? [])]).find(item => item.id === id);
  for (const id of ['clipboard', 'layout', 'undo', 'redo']) assert.equal(find(declared[1].items, id).iconOnly, false, `${id} has no words.`);
  assert.equal(find(declared[1].items, 'arrange').icon, 'layers', 'An icon every Nendo has was dropped too.');
});

// ---- Large deletes and layouts, the row's size, and renaming in place.

test('after a delete of more than 200 writes, Undo no longer names the gesture before it', async () => {
  const plan = largestFolderDelete();
  const host = controller(newElements(0));
  host.api.saved.undo.push({ label: 'Move Customer', revision: 'revision-move' });
  await host.api.write(() => plan.writes, `Delete ${plan.name}`);
  assert.ok(!host.statuses.some(status => status.problem), host.statuses.map(status => status.message).join(' | '));
  assert.equal(host.api.undoName(), null,
    `After Delete ${plan.name} (${plan.writes.length} writes, ${Math.ceil(plan.writes.length / 200)} revisions), Undo names "${host.api.undoName()}" and would run that earlier gesture instead.`);
});

test('a delete refused after its first batch says it was done only in part, and leaves no Undo', async () => {
  const plan = largestFolderDelete();
  const host = controller(newElements(0), true, 2);
  host.api.saved.undo.push({ label: 'Move Customer', revision: 'revision-move' });
  await host.api.write(() => plan.writes, `Delete ${plan.name}`);
  const said = host.statuses.at(-1);
  assert.equal(host.calls.length, 2);
  assert.ok(said.problem && /was done only in part: 1 of 2 saves went through before this was refused/.test(said.message),
    `A delete whose first batch was kept was reported as refused whole: "${said.message}"`);
  assert.equal(host.api.undoName(), null, 'A delete done in part left Undo naming the gesture before it.');
});

function specializedModel(count, length) {
  const records = structuredClone(fixture);
  const elementTypes = records['ar.type'].filter(type => type.values['ar.type.category'] === 'Element');
  records['ar.specialization'] = Array.from({ length: count }, (_, index) => ({ entityId: M.E.specialization,
    recordId: `ar-id-${String(index).padStart(32, '0')}`, version: 1, values: {
      'ar.specialization.name': `Specialization ${index} `.padEnd(length, 'x'), 'ar.specialization.type': elementTypes[index % elementTypes.length].recordId } }));
  return M.buildModel(records);
}

for (const editing of [true, false]) {
  test(`with 63 specializations of 80 characters the row stays within Nendo's 16 KiB ${editing ? 'while a view is edited, and keeps Edit, Commit, Discard and Undo' : 'with no view open'}`, async () => {
    const declared = [];
    let left = null;
    const context = vm.createContext({
      M, describe: error => error?.message ?? String(error), summary: () => '120 elements · 176 relationships · 17 views', TextEncoder, $: () => null,
      SPECIALIZED: 'new-specialized:',
      state: { nativeChrome: true, model: specializedModel(63, 80), filter: { text: '', layer: '', specialization: '' }, openView: editing ? 'ar-view' : null,
        readOnly: false, editing, pending: editing ? 3 : 0, styleShown: false, validator: { open: false }, visualiser: { open: false }, agent: { available: true, open: false }, zoom: 1, transparent: false },
      canvasModule: { createEditor() {}, editorSettings: () => ({ grid: false, snap: true, guides: true }) },
      editor: { canUndo: () => false, canRedo: () => false },
      undoName: () => 'Move Customer', redoName: () => null,
      leaveNativeChrome: reason => { left = reason; },
      nendo: { ui: { setToolbar(toolbar) { declared.push(toolbar); return Promise.resolve(); } } },
    });
    vm.runInContext(section('const TOOLBAR_BYTES', 'function arrange(') + section('function specializedItems(', 'function newSpecialized(') + '\ndeclareToolbar();', context);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(declared.length, 1);
    assert.equal(left, null);
    const bytes = Buffer.byteLength(JSON.stringify(declared[0]), 'utf8');
    assert.ok(bytes <= 16 * 1024, `The row is ${bytes} bytes, over Nendo's 16 KiB: Nendo refuses it whole, and the workbench's own row has no Edit, Commit or Discard.`);
    const ids = new Set(JSON.stringify(declared[0]).match(/"id":"[^"]+"/g).map(entry => entry.slice(6, -1)));
    const wanted = editing ? ['edit', 'commit', 'discard', 'undo', 'new-element', 'archi-file'] : ['undo', 'new-element', 'archi-file', 'find', 'layer'];
    assert.deepEqual(wanted.filter(id => !ids.has(id)), [], 'Keeping the row small took away a control it must keep.');
  });
}

test('the workbench\u2019s own row can still edit a view, and commit or discard its edits', () => {
  const page = readFileSync(new URL('../../extensions/archi/index.html', import.meta.url), 'utf8');
  const own = page.slice(page.indexOf('<header id="own-toolbar"'), page.indexOf('</header>'));
  assert.deepEqual(['own-edit', 'own-commit', 'own-discard'].filter(id => !own.includes(`id="${id}"`)), [],
    'The row the workbench falls back to when Nendo refuses its declaration has no Edit, Commit or Discard, so waiting edits are stranded.');
});

for (const named of [true, false]) {
  test(`F2 on ${named ? 'a named' : 'an unnamed'} relationship starts from its stored name, and one more letter is all that is saved`, async () => {
    const model = M.buildModel(fixture);
    const relationship = model.of(M.E.concept).find(record => record.values['ar.concept.category'] === 'Relationship' && Boolean(record.values['ar.concept.name']) === named);
    const stored = relationship.values['ar.concept.name'] ?? '';
    const writes = [];
    const tree = { innerHTML: '', contains: () => false, querySelector: selector => (selector === 'input.rename' ? { focus() {}, select() {} } : null) };
    const empty = { hidden: false, textContent: '' };
    const context = vm.createContext({ M, $: id => (id === 'tree' ? tree : empty), tone: () => '', LAYER_TONE: {}, FOLDER_TONE: {}, CSS: { escape: value => value },
      escape: text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
      document: { activeElement: null }, render() {}, select() {},
      state: { model, renaming: relationship.recordId, selected: relationship.recordId, filter: { text: '', layer: '', specialization: '' },
        expanded: new Set(model.of(M.E.folder).map(folder => folder.recordId)), modelOpen: true, readOnly: false },
      modelRecord: () => model.of(M.E.model)[0],
      write: plan => { writes.push(...plan()); return Promise.resolve(true); },
    });
    vm.runInContext(section('function rows()', '// ---------------------------------------------------------------- the centre') + '\nglobalThis.api = { renderTree, finishRename };', context);
    context.api.renderTree();
    const box = /class="rename" value="([^"]*)"/.exec(tree.innerHTML);
    assert.ok(box, 'F2 drew no rename box for the relationship.');
    const prefilled = box[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.equal(prefilled, stored, `The rename box starts from "${prefilled}", not the relationship's stored name "${stored}".`);
    context.api.finishRename({ value: `${prefilled}s` }, true);
    assert.deepEqual(writes.map(write => write.values), [{ 'ar.concept.name': `${stored}s` }],
      `A one-letter fix saved ${JSON.stringify(writes.map(write => write.values))} into the relationship's name.`);
  });
}

test('a record type read past its cap is said, and no file is saved from it', async () => {
  const max = Number(/const READ_MAX = (\d+);/.exec(source)[1]);
  const state = { loaded: true };
  const context = vm.createContext({ state, READS: { concepts: M.E.concept, views: M.E.view }, M, READ_MAX: max,
    nendo: { records: { async queryAll({ entityId }, { max: asked }) {
      if (entityId !== M.E.concept) return [];
      return Array.from({ length: asked }, (_, index) => ({ entityId, recordId: `c${index}`, version: 1, values: { 'ar.concept.category': 'Element' } }));
    } } },
    render() {}, startEmptyModel() {},
    readAgentRecords: () => Promise.resolve(null), keptCreates: () => false,
  });
  vm.runInContext(section('// ---------------------------------------------------------------- reading', '/**\n * A new Archi model') + '\nglobalThis.load = readAll;', context);
  await context.load();
  assert.deepEqual([...state.cut], [M.E.concept], `A type that holds more than ${max} records was read without a word that it was cut.`);
  assert.equal(state.sets.concepts.length, max);
  const statuses = [];
  let exported = 0;
  const saving = vm.createContext({ M, state, READ_MAX: max, canvasReady: Promise.resolve(), summary: () => '', download() {},
    canvasModule: { exportArchimate: () => { exported++; return { xml: '', fileName: 'Model.archimate' }; } },
    setStatus: (message, problem) => statuses.push({ message, problem }) });
  vm.runInContext(section('/** Each record type the workbench reads', 'function validatorStale(') + section('async function saveArchimate(', '/**\n * The model as Open Exchange XML') + '\nglobalThis.save = saveArchimate;', saving);
  await saving.save();
  assert.equal(exported, 0, 'Save as .archimate wrote a file from a model read in part.');
  assert.match(statuses.at(-1).message, /^Not saved: the file holds more than 50,000 concepts, and/, `Save names the record type by its ID: ${statuses.at(-1).message}`);
});

test('edits kept from view A, found while view B is edited, name view A until an edit is made on B', () => {
  let editorOptions = null;
  const model = M.buildModel(fixture);
  const [viewA, viewB] = model.of(M.E.view);
  const stored = new Map([['archi-edits', JSON.stringify({ viewId: viewA.recordId, writes: [{ op: 'update', entityId: M.E.item, recordId: 'box', version: 1, values: { 'ar.item.x': 5 } }] })]]);
  const statuses = [];
  const centre = { innerHTML: '', querySelector: () => null };
  const context = vm.createContext({ M, state: { model, sets: {}, styleShown: false, diagramSelection: [], pending: 0, openView: viewB.recordId },
    keptProposal: null, $: () => centre, canvas: null, drawnSets: null, requestAnimationFrame() {}, declareToolbar() {}, markStale() {}, refreshVisualiser() {}, select() {}, renderCentre() {},
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    setStatus: (message, problem = false) => statuses.push({ message, problem }),
    canvasModule: { buildMirror: () => ({}), applyWrites: sets => sets, writesFor: () => [{ op: 'update', entityId: M.E.item, recordId: 'box', version: 1, values: { 'ar.item.x': 5 } }],
      createEditor: (host, start, options) => { editorOptions = options; return { show() {}, viewId: () => viewB.recordId, select() {}, fit() {}, model: () => ({}), busy: () => false }; } },
  });
  vm.runInContext(section('const EDITS_KEY', 'function stopEditor(') + '\nglobalThis.open = renderEditor;', context);
  context.open(viewB);
  const said = statuses.find(status => /edits were waiting/.test(status.message));
  assert.ok(said && said.message.includes(M.label(model, viewA)) && said.problem,
    `Edits made on ${M.label(model, viewA)} were said to be "here again" on ${M.label(model, viewB)}: ${JSON.stringify(said)}`);
  assert.equal(JSON.parse(stored.get('archi-edits')).viewId, viewA.recordId, 'Opening another view replaced the view the kept edits were made on.');
  // An edit made on view B now: the edits are named under B, where the person made the newest.
  editorOptions.onChange({}, 'Move');
  assert.equal(JSON.parse(stored.get('archi-edits')).viewId, viewB.recordId, 'Edits made on view B after kept edits from view A are still named under view A.');
});

test('a layout that needs more than 200 writes is taken back at once and said', async () => {
  const statuses = [];
  let undone = 0;
  const state = { pending: 0 };
  const context = vm.createContext({ state, describe: error => error.message, setStatus: (message, problem = false) => statuses.push({ message, problem }),
    editor: { async layout() { state.pending = 214; return null; }, undo() { undone++; state.pending = 0; } } });
  vm.runInContext(section('async function layoutView(', 'function showAutomaticRelationships(') + '\nglobalThis.lay = layoutView;', context);
  await context.lay('right');
  assert.equal(undone, 1, `A layout of 214 writes was left waiting, where Commit can never save it: ${JSON.stringify(statuses.at(-1))}`);
  assert.ok(statuses.at(-1).problem && /214 record writes, and at most 200/.test(statuses.at(-1).message), statuses.at(-1).message);
});
test('a layout that would pass 200 beside edits already waiting names its own writes', async () => {
  const statuses = [];
  const state = { pending: 20 };
  const context = vm.createContext({ state, describe: error => error.message, setStatus: (message, problem = false) => statuses.push({ message, problem }),
    editor: { async layout() { state.pending = 210; return null; }, undo() { state.pending = 20; } } });
  vm.runInContext(section('async function layoutView(', 'function showAutomaticRelationships(') + '\nglobalThis.lay = layoutView;', context);
  await context.lay('down');
  assert.match(statuses.at(-1).message, /it needs 190 record writes beside the 20 already waiting, and at most 200/,
    `The layout's message counted the edits already waiting as its own: ${statuses.at(-1).message}`);
});

