import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  E, buildModel, label, treeRows, whyNotMove, moveWrite, createElement, createFolder, createView, deletePlan,
  propertyWrites, typeWrite, renameWrite, rootFolderOfKind, homeKind,
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
