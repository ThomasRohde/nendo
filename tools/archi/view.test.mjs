import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as M from '../../extensions/archi/model.js';
import { buildMirror, writesFor, applyWrites } from '../../extensions/archi/canvas.js';

// Execute the shipped write controller/property renderer. The stand-ins cover only the
// service and DOM boundaries; the diff is the generated canvas's actual implementation.
const source = readFileSync(new URL('../../extensions/archi/view.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8')).records;
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `The production section ${start} could not be found.`);
  return source.slice(from, to);
}

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

function controller(draft, batch = true) {
  let stored = structuredClone(fixture), readCalls = 0;
  const calls = [], statuses = [], saved = new Map();
  const state = { readOnly: false, openView: draft.viewId, pending: 0 };
  const context = vm.createContext({
    state, editor: { model: () => draft.after, viewId: () => draft.viewId }, editSets: fixture, editBase: draft.before,
    canvasModule: { writesFor }, EDITS_KEY: 'archi-edits',
    localStorage: { setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    declareToolbar() {}, markStale() {}, describe: error => error.message, setStatus: (message, problem = false) => statuses.push({ message, problem }),
    async readAll() { readCalls++; },
    nendo: { has: () => batch, records: {
      async batch(writes) {
        calls.push(writes);
        // The fixture enforces the Engine's per-call created-record version exemption. A
        // second chunk must name a target version for records created by the first chunk.
        const known = new Map(Object.values(stored).flat().map(record => [record.recordId, record]));
        const created = new Set();
        for (const write of writes) {
          for (const field of ['ar.item.concept', 'ar.property.concept']) {
            const id = write.values?.[field];
            if (id && !created.has(id) && write.targetVersions?.[field] !== known.get(id)?.version)
              throw new Error('Select the target again so its current version can be checked.');
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
    '\nglobalThis.api = { write, waitingWrites, editsChanged, commitEdits };', context);
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
// earlier one created: over 200 writes it goes in batches of 200, as before R30-001, and is
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
    const model = M.buildModel({ records: [
      { entityId: M.E.type, recordId: 'type', version: 1, values: { 'ar.type.key': 'ServingRelationship', 'ar.type.name': 'Serving', 'ar.type.layer': 'Relationship', 'ar.type.category': 'Relationship' } },
      { entityId: M.E.folder, recordId: 'relations', version: 1, values: { 'ar.folder.name': 'Relations', 'ar.folder.kind': 'Relations' } },
      { entityId: M.E.concept, recordId: 'element', version: 1, values: { 'ar.concept.name': 'Actor', 'ar.concept.category': 'Element' } },
      relation('A', 'B'), relation('B', 'A'), relation('self', 'self'),
    ] });
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
      const context = vm.createContext({ M, state: { model, selected: id, readOnly: false }, $: () => pane,
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
