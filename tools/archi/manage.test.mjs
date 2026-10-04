import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildModel } from '../../extensions/archi/model.js';
import {
  buildMirror, writesFor, specializationsOf, manageSpecializations, propertyKeys, renamePropertyKeyIn, deletePropertyKeyIn,
  findReplacePreview, findReplaceApply,
} from '../../extensions/archi/canvas.js';

// W-119: Archi's Specializations Manager, Properties Manager and Find and Replace are archi-online's
// own operations on the mirror; what reaches the file is writesFor's difference. Each is run here
// as the workbench runs it, against a file that answers records.batch as Nendo does, and read back:
// the model read back must be the model archi-online made, and Undo must put the file back.

const fixture = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
const all = Object.values(fixture.records).flat();
const named = (entityId, name) => all.find(r => r.entityId === entityId && (r.values['ar.concept.name'] ?? r.values['ar.view.name'] ?? r.values['ar.folder.name']) === name);
const actor = all.find(r => r.values['ar.concept.type'] === 'ar.type.r.BusinessActor');
const component = all.find(r => r.values['ar.concept.type'] === 'ar.type.r.ApplicationComponent');
const view = all.find(r => r.entityId === 'ar.view');
const subfolder = all.find(r => r.entityId === 'ar.folder' && r.values['ar.folder.parent']);
const business = all.find(r => r.entityId === 'ar.folder' && !r.values['ar.folder.parent'] && r.values['ar.folder.kind'] === 'Business');
const modelRecord = all.find(r => r.entityId === 'ar.model');
const group = all.find(r => r.entityId === 'ar.item' && r.values['ar.item.kind'] === 'Group');

/** Archisurance with two specializations, one given to an actor, and properties on six kinds of owner. */
function seeded() {
  const records = structuredClone(all);
  const spec = (id, name, type) => ({ entityId: 'ar.specialization', recordId: id, version: 1,
    values: { 'ar.specialization.name': name, 'ar.specialization.type': `ar.type.r.${type}`, 'ar.specialization.archiId': id.slice(3) } });
  records.push(spec('ar-id-gold', 'Gold Customer', 'BusinessActor'), spec('ar-id-portal', 'Portal', 'ApplicationComponent'));
  records.find(r => r.recordId === actor.recordId).values['ar.concept.specialization'] = 'ar-id-gold';
  let n = 0;
  const prop = (owner, id, key, value) => records.push({ entityId: 'ar.property', recordId: `ar-id-p${++n}`, version: 1,
    values: { 'ar.property.key': key, 'ar.property.value': value, 'ar.property.order': n * 1024, [`ar.property.${owner}`]: id } });
  prop('concept', actor.recordId, 'Owner', 'Sales'); prop('concept', actor.recordId, 'Status', 'Live'); prop('concept', actor.recordId, 'Owner', 'Sales desk');
  prop('view', view.recordId, 'Owner', 'IT');
  prop('folder', subfolder.recordId, 'Owner', 'PMO');
  prop('folder', business.recordId, 'Review', 'Sales to check');
  prop('model', modelRecord.recordId, 'Owner', 'Board');
  prop('item', group.recordId, 'Owner', 'Docs');
  return records;
}

/** A file answering records.batch as Nendo does: all or nothing, versions checked, each record once. */
function file(records = seeded()) {
  let now = new Map(records.map(r => [r.recordId, structuredClone(r)]));
  return {
    sets: () => ({ all: [...now.values()] }),
    model: () => buildModel({ all: [...now.values()] }),
    batch(writes) {
      assert.ok(writes.length <= 200, `${writes.length} writes cannot be one revision.`);
      const next = new Map([...now].map(([id, r]) => [id, structuredClone(r)]));
      const touched = new Set();
      const answers = writes.map(write => {
        assert.ok(!touched.has(write.recordId), `${write.recordId} is written twice in one batch.`);
        for (const [fieldId, version] of Object.entries(write.targetVersions ?? {})) {
          const target = next.get(write.values[fieldId]);
          if (!target || target.version !== version) throw new Error(`stale target ${fieldId}`);
        }
        for (const [fieldId, value] of Object.entries(write.values ?? {})) {
          if (/\.(type|specialization|concept|view|folder|item|model|parent)$/.test(fieldId) && typeof value === 'string') {
            assert.ok(next.has(value), `${write.recordId}.${fieldId} points at ${value}, which is not in the file.`);
          }
        }
        const current = next.get(write.recordId);
        if (write.op === 'create') {
          if (current) throw new Error(`record-exists ${write.recordId}`);
          next.set(write.recordId, { entityId: write.entityId, recordId: write.recordId, version: 1, values: { ...write.values } });
        } else {
          if (!current || current.version !== write.version) throw new Error(`stale ${write.recordId}`);
          if (write.op === 'delete') {
            const referrer = [...next.values()].find(r => r.recordId !== write.recordId && !touched.has(r.recordId) && Object.values(r.values).includes(write.recordId));
            assert.equal(referrer, undefined, `${write.recordId} is deleted while ${referrer?.recordId} points at it.`);
            next.delete(write.recordId);
          } else next.set(write.recordId, { ...current, version: current.version + 1, values: { ...current.values, ...write.values } });
        }
        touched.add(write.recordId);
        return { recordId: write.recordId, version: write.op === 'delete' ? null : next.get(write.recordId).version };
      });
      now = next;
      return answers;
    },
    snapshot: () => JSON.stringify([...now.values()].map(r => [r.recordId, Object.entries(r.values).filter(([, value]) => value !== null && value !== '').sort()]).sort()),
  };
}

/** What a person could see of a model: every name, text and documentation, specialization and property. */
function seen(model) {
  const props = owner => (owner.properties ?? []).map(p => `${p.key}=${p.value}`);
  const objects = list => Object.values(list).map(o => [o.id, o.name ?? null, o.documentation ?? null, o.content ?? null,
    (o.profileIds ?? []).join(), props(o)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.parse(JSON.stringify({
    info: [model.info.name, model.info.documentation, props(model.info)],
    profiles: Object.values(model.profiles).map(p => [p.id, p.name, p.conceptType]).sort(),
    folders: objects(model.folders), elements: objects(model.elements), relationships: objects(model.relationships),
    views: objects(model.views), nodes: objects(model.nodes), connections: objects(model.connections),
  }));
}

/**
 * One change saved as the workbench saves it, as one batch, and read back. `change` takes the
 * mirror and answers archi-online's model after its operation. Undo and Redo of the batch are
 * Nendo's own (ADR-0023), measured in the Engine and in the workbench's lane.
 */
function saved(f, change) {
  const before = buildMirror(f.sets());
  const after = change(before);
  const writes = writesFor(f.sets(), before, after);
  f.batch(writes);
  assert.deepEqual(seen(buildMirror(f.sets())), seen(after), 'The model read back is not the model archi-online made.');
  assert.deepEqual(writesFor(f.sets(), buildMirror(f.sets()), buildMirror(f.sets())), [], 'Reading the file back would write again.');
  return writes;
}

const shape = writes => writes.map(w => [w.op, w.entityId, w.recordId, Object.keys(w.values ?? {}).sort().join()]);

test('the seeded file reads back as itself and writes nothing', () => {
  const f = file();
  const mirror = buildMirror(f.sets());
  assert.deepEqual(writesFor(f.sets(), mirror, buildMirror(f.sets())), []);
  assert.deepEqual(mirror.elements[actor.recordId].properties.map(p => p.recordId), ['ar-id-p1', 'ar-id-p2', 'ar-id-p3']);
  assert.deepEqual(specializationsOf(mirror).map(s => [s.name, s.conceptType, s.used]), [['Gold Customer', 'BusinessActor', 1], ['Portal', 'ApplicationComponent', 0]]);
});

test('specializations made, renamed and taken away are one revision each, and the one in use is taken from its concept first', () => {
  const f = file();
  const made = saved(f, m => manageSpecializations(m, [...specializationsOf(m), { id: 'ar-id-new-weak', name: 'Weak', conceptType: 'AssociationRelationship' }]));
  assert.deepEqual(shape(made), [['create', 'ar.specialization', 'ar-id-new-weak', 'ar.specialization.archiId,ar.specialization.name,ar.specialization.type']]);
  assert.equal(made[0].values['ar.specialization.archiId'], 'id-new-weak');
  assert.equal(made[0].targetVersions['ar.specialization.type'], all.find(r => r.recordId === 'ar.type.r.AssociationRelationship').version);

  const renamed = saved(f, m => manageSpecializations(m, specializationsOf(m).map(s => (s.id === 'ar-id-gold' ? { ...s, name: 'Platinum Customer' } : s))));
  assert.deepEqual(shape(renamed), [['update', 'ar.specialization', 'ar-id-gold', 'ar.specialization.name']]);

  const removed = saved(f, m => manageSpecializations(m, specializationsOf(m).filter(s => s.id !== 'ar-id-gold')));
  assert.deepEqual(shape(removed), [['update', 'ar.concept', actor.recordId, 'ar.concept.specialization'], ['delete', 'ar.specialization', 'ar-id-gold', '']]);
});

test("archi-online's own refusals hold: a name used for the type, and a new type for one in use", () => {
  const m = buildMirror(file().sets());
  assert.throws(() => manageSpecializations(m, [...specializationsOf(m), { id: 'ar-id-twin', name: 'gold customer', conceptType: 'BusinessActor' }]),
    /must be unique: gold customer \(BusinessActor\)/);
  assert.throws(() => manageSpecializations(m, specializationsOf(m).map(s => (s.id === 'ar-id-gold' ? { ...s, conceptType: 'BusinessRole' } : s))),
    /Cannot change the concept type of used profile: Gold Customer/);
});

test('a property key renamed everywhere is one update of each property that has it, and nothing else', () => {
  const f = file();
  const keys = propertyKeys(buildMirror(f.sets()));
  const owner = keys.find(k => k.key === 'Owner');
  assert.equal(owner.occurrenceCount, 6);
  const writes = saved(f, m => renamePropertyKeyIn(m, 'Owner', 'Responsible').model);
  assert.equal(writes.length, owner.occurrenceCount);
  assert.ok(writes.every(w => w.op === 'update' && w.entityId === 'ar.property' && Object.keys(w.values).join() === 'ar.property.key' && w.values['ar.property.key'] === 'Responsible'));
  assert.deepEqual(propertyKeys(buildMirror(f.sets())).map(k => k.key).sort(), ['Responsible', 'Review', 'Status']);
});

test('renaming to a key in use waits for the person to acknowledge it, then keeps the rows separate', () => {
  const f = file();
  const asked = renamePropertyKeyIn(buildMirror(f.sets()), 'Status', 'Owner');
  assert.equal(asked.collision, true);
  assert.equal(asked.applied, 0);
  assert.match(asked.warning, /already exists/);
  const writes = saved(f, m => renamePropertyKeyIn(m, 'Status', 'Owner', true).model);
  assert.deepEqual(shape(writes), [['update', 'ar.property', 'ar-id-p2', 'ar.property.key']]);
  assert.throws(() => renamePropertyKeyIn(buildMirror(f.sets()), 'Owner', 'Owner'), /must differ/);
});

test('a key deleted takes exactly its properties, in the middle of a list too, and leaves the others as they were', () => {
  const f = file();
  const writes = saved(f, m => deletePropertyKeyIn(m, 'Status').model);
  assert.deepEqual(shape(writes), [['delete', 'ar.property', 'ar-id-p2', '']]);
  const left = buildMirror(f.sets()).elements[actor.recordId].properties;
  assert.deepEqual(left.map(p => [p.recordId, p.key, p.value]), [['ar-id-p1', 'Owner', 'Sales'], ['ar-id-p3', 'Owner', 'Sales desk']]);
});

const options = (find, replace, more = {}) => ({ find, replace, scope: 'model', searchName: true, searchDocumentation: true,
  searchPropertyValues: true, matchCase: false, useRegex: false, ...more });

test('replace all over names, documentation and property values writes each changed field once, on every kind of owner', () => {
  const f = file();
  const preview = findReplacePreview(buildMirror(f.sets()), options('Sales', 'Commerce'));
  assert.equal(preview.error, null);
  const fields = new Set(preview.rows.map(row => row.field.replace(/^Property: .*/, 'Property')));
  assert.ok(fields.has('Name') && fields.has('Property'), `Only ${[...fields]} matched.`);
  const owners = new Set(preview.rows.map(row => row.ownerKind));
  assert.ok(owners.has('folder') && owners.has('element'), `Only ${[...owners]} owners matched.`);
  const writes = saved(f, m => findReplaceApply(m, options('Sales', 'Commerce'), preview.rows).model);
  const changed = writes.reduce((n, w) => n + Object.keys(w.values).length, 0);
  assert.equal(changed, preview.rows.length, 'Not one field written per row replaced.');
  assert.ok(writes.every(w => w.op === 'update'));
  assert.equal(findReplacePreview(buildMirror(f.sets()), options('Sales', 'Commerce')).rows.length, 0, 'Something matching was left.');
});

test('the model, a top-level folder and a group are replaced in too, which the editor never wrote', () => {
  const f = file();
  const writes = saved(f, m => {
    const chosen = findReplacePreview(m, options('Archisurance|Business|Board|Docs', 'X', { useRegex: true, matchCase: true })).rows
      .filter(row => ['model', 'group'].includes(row.ownerKind) || row.ownerId === business.recordId);
    return findReplaceApply(m, options('Archisurance|Business|Board|Docs', 'X', { useRegex: true, matchCase: true }), chosen).model;
  });
  const by = new Map(writes.map(w => [w.recordId, w]));
  assert.ok(by.get(modelRecord.recordId)?.values['ar.model.name'].includes('X'), 'The model was not renamed.');
  assert.equal(by.get(business.recordId)?.values['ar.folder.name'], 'X');
  assert.equal(by.get('ar-id-p7')?.values['ar.property.value'], 'X');
  assert.equal(by.get('ar-id-p8')?.values['ar.property.value'], 'X', "The group's property was not replaced.");
  assert.ok(writes.every(w => w.op === 'update'));
});

test('only the rows chosen are replaced, and a row changed since the preview refuses the whole replace', () => {
  const f = file();
  const mirror = buildMirror(f.sets());
  const rows = findReplacePreview(mirror, options('Owner', 'Lead', { searchName: false, searchDocumentation: false })).rows;
  assert.equal(rows.length, 0, 'A key matched as a value.');
  const values = findReplacePreview(mirror, options('Sales', 'Trade', { searchName: false, searchDocumentation: false })).rows;
  assert.deepEqual(values.map(row => row.before).sort(), ['Sales', 'Sales desk', 'Sales to check']);
  const one = values.filter(row => row.before === 'Sales desk');
  const writes = saved(f, m => findReplaceApply(m, options('Sales', 'Trade', { searchName: false, searchDocumentation: false }), one).model);
  assert.deepEqual(writes.map(w => [w.recordId, w.values['ar.property.value']]), [['ar-id-p3', 'Trade desk']]);
  assert.throws(() => findReplaceApply(buildMirror(f.sets()), options('Sales', 'Trade', { searchName: false, searchDocumentation: false }), one),
    /changed since the preview/);
});

test('in the active view, the scope is what the view shows', () => {
  const mirror = buildMirror(file().sets());
  const viewId = Object.values(mirror.views).find(v => v.childIds.length > 3).id;
  const rows = findReplacePreview(mirror, options('e', 'e', { scope: 'active-view' }), viewId).rows;
  assert.ok(rows.length > 0);
  const shown = new Set(Object.values(mirror.nodes).filter(n => n.viewId === viewId).flatMap(n => [n.id, n.elementId]));
  for (const row of rows) if (row.ownerKind === 'element') assert.ok(shown.has(row.ownerId), `${row.ownerId} is not on the view.`);
  assert.match(findReplacePreview(mirror, options('e', 'e', { scope: 'active-view' })).error, /No active view/);
  assert.match(findReplacePreview(mirror, options('(', 'x', { useRegex: true })).error ?? '', /./);
});

test('a property copied with its element is a new record of the copy, and the original keeps its own', () => {
  const f = file();
  const before = buildMirror(f.sets());
  const after = structuredClone(before);
  const original = after.elements[actor.recordId];
  after.elements['ar-id-copy'] = { ...structuredClone(original), id: 'ar-id-copy', name: 'Copy', profileIds: [] };
  after.folders[original.folderId].itemIds.push('ar-id-copy');
  const writes = writesFor(f.sets(), before, after);
  const props = writes.filter(w => w.entityId === 'ar.property');
  assert.equal(props.length, 3);
  assert.ok(props.every(w => w.op === 'create' && w.values['ar.property.concept'] === 'ar-id-copy' && !w.values['ar.property.archiId']));
  assert.ok(props.every(w => !['ar-id-p1', 'ar-id-p2', 'ar-id-p3'].includes(w.recordId)), 'A copy took the record of the original.');
  assert.ok(writes.findIndex(w => w.recordId === 'ar-id-copy') < writes.indexOf(props[0]), 'A property was made before its owner.');
  assert.deepEqual(props.map(w => w.values['ar.property.order']), [1024, 2048, 3072]);
  f.batch(writes);
  assert.deepEqual(seen(buildMirror(f.sets())), seen(after));
});
