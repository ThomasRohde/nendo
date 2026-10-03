import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  E, buildModel, label, treeRows, whyNotMove, moveWrite, createElement, createFolder, createView, deletePlan,
  propertyWrites, typeWrite, renameWrite, fieldWrite, rootFolderOfKind, homeKind, undoStep, oppositeStep, planStep,
} from '../../extensions/archi/model.js';

// The Archi workbench's rules (W-109), over Archisurance as Archi.nendo holds it
// (tools/archi/archisurance.json, from tools/archi/make-fixture.mjs).
const fixture = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
const model = () => buildModel(fixture.records);
const find = (m, entityId, name) => [...m.records.values()].find(r => r.entityId === entityId &&
  (r.values['ar.concept.name'] ?? r.values['ar.view.name'] ?? r.values['ar.folder.name']) === name);

test('the tree opens on Archi’s nine top-level folders in Archi’s order, and a folder shows folders first, then the rest by name', () => {
  const m = model();
  const top = treeRows(m, new Set());
  assert.deepEqual(top.map(row => row.label), ['Strategy', 'Business', 'Application', 'Technology & Physical', 'Motivation',
    'Implementation & Migration', 'Other', 'Relations', 'Views']);
  // A folder holding both folders and concepts, whichever Archisurance has; with none the test says so.
  const mixed = [...m.children].find(([, content]) => content.folders.length > 0 && content.concepts.length + content.views.length > 0);
  const [folderId, content] = mixed ?? [rootFolderOfKind(m, 'Business').recordId, m.children.get(rootFolderOfKind(m, 'Business').recordId)];
  const expanded = new Set([...m.records.values()].filter(r => r.entityId === E.folder).map(r => r.recordId));
  const all = treeRows(m, expanded);
  const at = all.findIndex(row => row.id === folderId);
  const rows = all.slice(at + 1).filter((row, index, list) => list.slice(0, index + 1).every(r => r.depth > all[at].depth))
    .filter(row => row.depth === all[at].depth + 1);
  assert.equal(rows.length, content.folders.length + content.concepts.length + content.views.length);
  const firstLeaf = rows.findIndex(row => row.entityId !== E.folder);
  const folders = firstLeaf === -1 ? rows : rows.slice(0, firstLeaf);
  assert.ok(folders.every(row => row.entityId === E.folder), 'Folders do not come first.');
  const leaves = (firstLeaf === -1 ? [] : rows.slice(firstLeaf)).map(row => row.label);
  assert.deepEqual(leaves, [...leaves].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
});

test('every concept and view of Archisurance is in the tree once, under its folder', () => {
  const m = model();
  const everything = new Set([...m.records.values()].filter(r => r.entityId === E.folder).map(r => r.recordId));
  const rows = treeRows(m, everything);
  const shown = rows.filter(row => row.entityId === E.concept || row.entityId === E.view).map(row => row.id);
  assert.equal(shown.length, 296 + 17);
  assert.equal(new Set(shown).size, shown.length, 'A record is in the tree twice.');
});

test('the model reads as its name, never its record ID', () => {
  const m = model();
  const root = m.of(E.model)[0];
  assert.equal(label(m, root), 'Archisurance');
  assert.equal(label(m, { ...root, recordId: 'ar.model.r.2080a942', values: { ...root.values, 'ar.model.name': null } }), '(model)');
});

test('an unnamed relationship reads as its type and its two ends', () => {
  const m = model();
  const unnamed = [...m.records.values()].find(r => r.entityId === E.concept && r.values['ar.concept.category'] === 'Relationship' && !r.values['ar.concept.name']);
  assert.match(label(m, unnamed), /^[A-Z][a-z]+ \(.+ – .+\)$/);
});

test('the filter keeps what matches and the folders on the way to it, and a layer keeps only that layer’s concepts', () => {
  const m = model();
  const rows = treeRows(m, new Set(), { text: 'customer' });
  const leaves = rows.filter(row => row.entityId !== E.folder);
  assert.ok(leaves.length > 0 && leaves.every(row => row.label.toLowerCase().includes('customer')));
  for (const row of rows.filter(row => row.entityId === E.folder)) assert.ok(row.expanded, `${row.label} holds a match but is closed.`);
  const application = treeRows(m, new Set(), { layer: 'Application' }).filter(row => row.entityId === E.concept);
  assert.ok(application.length > 0 && application.every(row => row.layer === 'Application'));
});

test('a concept moves only within its layer’s tree, and a folder never into itself', () => {
  const m = model();
  const actor = find(m, E.concept, 'Customer');
  const business = rootFolderOfKind(m, 'Business'), application = rootFolderOfKind(m, 'Application');
  assert.equal(homeKind(m, actor), 'Business');
  assert.match(whyNotMove(m, actor.recordId, application.recordId), /belongs under Business/);
  const sub = createFolder(m, business.recordId, 'Parties');
  const withSub = buildModel({ ...fixture.records, extra: [{ entityId: E.folder, recordId: sub.recordId, version: 1, values: sub.values }] });
  const write = moveWrite(withSub, actor.recordId, sub.recordId);
  assert.deepEqual(write.values, { 'ar.concept.folder': sub.recordId });
  assert.deepEqual(write.targetVersions, { 'ar.concept.folder': 1 });
  assert.match(whyNotMove(withSub, business.recordId, sub.recordId), /top-level folder/);
  const parties = withSub.records.get(sub.recordId);
  assert.match(whyNotMove(withSub, parties.recordId, parties.recordId), /inside itself/);
});

test('a new element goes to its layer’s folder, or to the selected folder of that layer, with an Archi identifier', () => {
  const m = model();
  const write = createElement(m, 'ApplicationComponent', rootFolderOfKind(m, 'Business').recordId);
  assert.equal(write.values['ar.concept.folder'], rootFolderOfKind(m, 'Application').recordId, 'A folder of another layer was used.');
  assert.match(write.values['ar.concept.archiId'], /^id-[0-9a-f]{32}$/);
  assert.equal(write.recordId, `ar-${write.values['ar.concept.archiId']}`);
  assert.equal(createView(m).values['ar.view.folder'], rootFolderOfKind(m, 'Views').recordId);
  assert.throws(() => createElement(m, 'ServingRelationship'), /not an element type/);
});

test('deleting an element takes its relationships, their lines and its boxes, and orders every delete after what points at it', () => {
  const m = model();
  const element = find(m, E.concept, 'Customer');
  const { writes, summary } = deletePlan(m, [element.recordId]);
  assert.ok(summary.relationships > 0 && summary.items > 0, JSON.stringify(summary));
  const gone = new Set(writes.map(write => write.recordId));
  const position = new Map(writes.map((write, index) => [write.recordId, index]));
  const references = ['ar.item.view', 'ar.item.concept', 'ar.item.refView', 'ar.item.parent', 'ar.item.source', 'ar.item.target',
    'ar.concept.source', 'ar.concept.target', 'ar.concept.folder', 'ar.property.concept'];
  for (const record of m.records.values()) {
    for (const fieldId of references) {
      const target = record.values[fieldId];
      if (!target || !gone.has(target)) continue;
      assert.ok(gone.has(record.recordId), `${record.recordId} would still point at deleted ${target}.`);
      assert.ok(position.get(record.recordId) < position.get(target), `${record.recordId} is deleted after ${target}, which it points at.`);
    }
  }
  assert.throws(() => deletePlan(m, [rootFolderOfKind(m, 'Business').recordId]), /top-level folder/);
});

test('deleting a view takes its diagram and every reference to it', () => {
  const m = model();
  const referenced = [...m.records.values()].find(r => r.entityId === E.item && r.values['ar.item.refView'])?.values['ar.item.refView'];
  const { writes } = deletePlan(m, [referenced]);
  const items = [...m.records.values()].filter(r => r.entityId === E.item && (r.values['ar.item.view'] === referenced || r.values['ar.item.refView'] === referenced));
  for (const item of items) assert.ok(writes.some(write => write.recordId === item.recordId), `${item.recordId} survives its view.`);
  assert.equal(writes.at(-1).recordId, referenced);
});

test('a property list is written as the rows say: new rows created, changed rows updated, missing rows deleted, in order', () => {
  const m = model();
  const element = find(m, E.concept, 'Customer');
  const created = propertyWrites(m, element.recordId, [{ key: 'owner', value: 'Sales' }, { key: 'status', value: 'live' }]);
  assert.deepEqual(created.map(write => [write.op, write.values['ar.property.key'], write.values['ar.property.order']]),
    [['create', 'owner', 1024], ['create', 'status', 2048]]);
  const properties = created.map(write => ({ entityId: E.property, recordId: write.recordId, version: 1, values: write.values }));
  const withProperties = buildModel({ ...fixture.records, extra: properties });
  const changed = propertyWrites(withProperties, element.recordId, [{ recordId: properties[1].recordId, key: 'status', value: 'retired' }]);
  assert.deepEqual(changed.map(write => write.op), ['delete', 'update']);
  assert.deepEqual(changed[1].values, { 'ar.property.value': 'retired', 'ar.property.order': 1024 });
});

test('a new type keeps the category and moves the concept to the new layer’s folder', () => {
  const m = model();
  const actor = find(m, E.concept, 'Customer');
  const component = [...m.types.values()].find(type => type.values['ar.type.key'] === 'ApplicationComponent');
  const write = typeWrite(m, actor.recordId, component.recordId);
  assert.equal(write.values['ar.concept.folder'], rootFolderOfKind(m, 'Application').recordId);
  const serving = [...m.types.values()].find(type => type.values['ar.type.key'] === 'ServingRelationship');
  assert.throws(() => typeWrite(m, actor.recordId, serving.recordId), /keeps its category/);
  assert.deepEqual(renameWrite(m, actor.recordId, 'Client').values, { 'ar.concept.name': 'Client' });
});

// ---------------------------------------------------------------- undo (W-112)

/**
 * A file that answers records.batch as Nendo does: every write or none, a version checked on
 * each update and delete and on each reference outside the batch, a record at most once, and
 * each record's new version in the answer. The records are kept as window.nendo reads them.
 */
function file(records = fixture.records) {
  let all = new Map(Object.values(records).flat().map(r => [r.recordId, structuredClone(r)]));
  return {
    model: () => buildModel({ all: [...all.values()] }),
    batch(writes) {
      const next = new Map([...all].map(([id, r]) => [id, structuredClone(r)]));
      const touched = new Set();
      const answers = writes.map(write => {
        assert.ok(!touched.has(write.recordId), `${write.recordId} is written twice in one batch.`);
        for (const [fieldId, version] of Object.entries(write.targetVersions ?? {})) {
          const target = next.get(write.values[fieldId]);
          if (!target || target.version !== version) throw new Error(`stale target ${fieldId}`);
        }
        const now = next.get(write.recordId);
        if (write.op === 'create') {
          if (now) throw new Error(`record-exists ${write.recordId}`);
          next.set(write.recordId, { entityId: write.entityId, recordId: write.recordId, version: 1, values: { ...write.values } });
        } else {
          if (!now || now.version !== write.version) throw new Error(`stale ${write.recordId}`);
          if (write.op === 'delete') next.delete(write.recordId);
          else next.set(write.recordId, { ...now, version: now.version + 1, values: { ...now.values, ...write.values } });
        }
        touched.add(write.recordId);
        return { recordId: write.recordId, version: write.op === 'delete' ? null : next.get(write.recordId).version };
      });
      all = next;
      return answers;
    },
    // A field set to null holds no value, as Nendo keeps it.
    snapshot: () => JSON.stringify([...all.values()].map(r => [r.recordId, Object.entries(r.values).filter(([, value]) => value !== null).sort()]).sort()),
  };
}

/** One gesture saved, then undone, then redone, as the workbench runs them; each step's model compared. */
function roundTrip(f, plan) {
  const states = new Map();
  const start = f.snapshot();
  const before = f.model();
  const writes = plan(before);
  const answers = f.batch(writes);
  const done = f.snapshot();
  const undo = undoStep(before, writes, answers, states);
  const beforeUndo = f.model();
  const undoWrites = planStep(beforeUndo, undo);
  const undone = f.batch(undoWrites);
  assert.equal(f.snapshot(), start, 'Undo did not put the model back as it was.');
  const redo = oppositeStep(beforeUndo, undo, undoWrites, undone, states);
  f.batch(planStep(f.model(), redo));
  assert.equal(f.snapshot(), done, 'Redo did not make the change again.');
  return { writes, undo, redo };
}

test('a rename, a new type, a property list and a move are each undone and redone exactly', () => {
  const f = file();
  const customer = find(f.model(), E.concept, 'Customer').recordId;
  roundTrip(f, m => [renameWrite(m, customer, 'Client')]);
  roundTrip(f, m => [typeWrite(m, customer, [...m.types.values()].find(type => type.values['ar.type.key'] === 'BusinessRole').recordId)]);
  roundTrip(f, m => propertyWrites(m, customer, [{ key: 'owner', value: 'Sales' }, { key: 'status', value: 'live' }]));
  const folder = createFolder(f.model(), rootFolderOfKind(f.model(), 'Business').recordId);
  f.batch([folder]);
  roundTrip(f, m => [moveWrite(m, customer, folder.recordId)]);
});

test('a new element, folder and view are undone by deleting them, and redone under the same record IDs', () => {
  const f = file();
  const { redo } = roundTrip(f, m => [createElement(m, 'ApplicationComponent', rootFolderOfKind(m, 'Application').recordId, 'Billing')]);
  assert.equal(redo[0].op, 'create');
  roundTrip(f, m => [createFolder(m, rootFolderOfKind(m, 'Business').recordId)]);
  roundTrip(f, m => [createView(m, rootFolderOfKind(m, 'Views').recordId)]);
});

test('deleting an element with its relationships, lines and boxes is undone with every value, and redone', () => {
  const f = file();
  const customer = find(f.model(), E.concept, 'Customer').recordId;
  const { writes, undo } = roundTrip(f, m => deletePlan(m, [customer]).writes);
  assert.ok(writes.length > 3, 'The element took nothing with it; the test needs one that does.');
  assert.ok(undo.every(entry => entry.op === 'create'));
  // Put back in the reverse order, so each record comes back before anything that points at it.
  assert.equal(undo[0].recordId, customer);
});

test('a view deleted with its diagram, and boxes nested in boxes, comes back whole', () => {
  const f = file();
  const nested = [...f.model().records.values()].find(r => r.entityId === E.item && r.values['ar.item.parent']);
  roundTrip(f, m => deletePlan(m, [nested.values['ar.item.view']]).writes);
});

test('an undo is refused, and changes nothing, when what it puts back has changed, gone or is used since', () => {
  const f = file();
  const m0 = f.model();
  const customer = find(m0, E.concept, 'Customer').recordId;
  // Changed since: renamed twice, and the first rename undone after the second.
  const writes = [renameWrite(m0, customer, 'Client')];
  const step = undoStep(m0, writes, f.batch(writes));
  f.batch([renameWrite(f.model(), customer, 'Patron')]);
  const unchanged = f.snapshot();
  assert.throws(() => planStep(f.model(), step), /Patron has changed since\./);
  assert.equal(f.snapshot(), unchanged);
  // Gone since: the element deleted.
  f.batch(deletePlan(f.model(), [customer]).writes);
  assert.throws(() => planStep(f.model(), step), /has been deleted since\./);
  // Used since: a new element given a property, then its creation undone.
  const m1 = f.model();
  const made = [createElement(m1, 'BusinessActor', rootFolderOfKind(m1, 'Business').recordId, 'Broker')];
  const undoMade = undoStep(m1, made, f.batch(made));
  f.batch(propertyWrites(f.model(), made[0].recordId, [{ key: 'tier', value: 'gold' }]));
  assert.throws(() => planStep(f.model(), undoMade), /the property tier uses Broker now\./);
  // Back again: a deleted record whose ID has been taken again.
  const m2 = f.model();
  const spare = [createFolder(m2, rootFolderOfKind(m2, 'Business').recordId, 'Spare')];
  f.batch(spare);
  const m3 = f.model();
  const removal = deletePlan(m3, [spare[0].recordId]).writes;
  const undoRemoval = undoStep(m3, removal, f.batch(removal));
  f.batch([{ ...spare[0], values: { ...spare[0].values, 'ar.folder.name': 'Again' } }]);
  assert.throws(() => planStep(f.model(), undoRemoval), /Again is in the model again\./);
});

test('a chain of gestures is walked back to the start and forward again, a delete undone in the middle of it', () => {
  // As the workbench keeps them: a stack to undo, one to redo, and one map of states. A rename and
  // three documentation changes of one element, a property list, then the element deleted: undoing
  // the delete makes it again at version 1, so its versions start over, and every step before and
  // after must still find it.
  const f = file();
  const undo = [], redo = [], states = new Map();
  const gesture = plan => { const before = f.model(); const writes = plan(before); undo.push(undoStep(before, writes, f.batch(writes), states)); redo.length = 0; };
  const take = (from, to) => {
    const step = from.pop();
    const before = f.model();
    const writes = planStep(before, step);
    to.push(oppositeStep(before, step, writes, f.batch(writes), states));
  };
  const start = f.snapshot();
  const id = find(f.model(), E.concept, 'Customer').recordId;
  gesture(m => [renameWrite(m, id, 'Policyholder')]);
  for (const text of ['Buys insurance.', 'Buys insurance!', 'Buys a policy.']) gesture(m => [fieldWrite(m, id, 'ar.concept.documentation', text)]);
  gesture(m => propertyWrites(m, id, [{ key: 'owner', value: 'Sales' }]));
  gesture(m => deletePlan(m, [id]).writes);
  const end = f.snapshot();
  const steps = undo.length;
  for (let index = 0; index < steps; index += 1) take(undo, redo);
  assert.equal(f.snapshot(), start, 'Undoing the chain did not reach the start.');
  for (let index = 0; index < steps; index += 1) take(redo, undo);
  assert.equal(f.snapshot(), end, 'Redoing the chain did not reach the end.');
  for (let index = 0; index < 3; index += 1) take(undo, redo);
  for (let index = 0; index < 3; index += 1) take(redo, undo);
  assert.equal(f.snapshot(), end, 'Half back and forward again did not reach the end.');
});
