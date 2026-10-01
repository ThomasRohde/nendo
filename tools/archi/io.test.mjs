import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exportArchimate, holdsNoModel, importBatches, modelForExport, planImport } from '../../extensions/archi/canvas.js';
import { archiSchema } from './fixtures.mjs';

// W-120: the workbench saves Archi.nendo's records as an .archimate file and opens one into an
// empty model. Reading XML needs a browser's DOMParser, so the XML itself is measured in the
// review lane (Gate-ArchiWorkbench.mjs) and against archi-online's fixtures and Desktop Archi
// (tools/archi/verify-archimate-io.mjs). Here: the mapping both ways, and the batches it is saved in.
const { records } = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
const all = Object.values(records).flat();
const roots = records['ar.folder'].filter(folder => !folder.values['ar.folder.parent']);
const rootFolders = Object.fromEntries(roots.map(folder => [folder.values['ar.folder.kind'], folder.recordId]));
const modelRecordId = records['ar.model'][0].recordId;
// Every reference field, from the record types Build-Archi.mjs makes, not from the code under test.
const references = new Map(archiSchema().entities.flatMap(entity => entity.fields.filter(field => field.reference).map(field => [field.fieldId, field.reference.targetEntityId])));

/** A file a new Archi model leaves: the concept types, the nine folders, and an empty Model record. */
function emptyFile({ withModel = true, rootVersion = 3 } = {}) {
  return {
    'ar.type': records['ar.type'],
    'ar.folder': roots.map(folder => ({ ...folder, version: rootVersion,
      values: { ...folder.values, 'ar.folder.archiId': null } })),
    'ar.model': withModel ? [{ entityId: 'ar.model', recordId: modelRecordId, version: 1, values: { 'ar.model.name': 'New model' } }] : [],
  };
}

test('saving Archisurance and opening it again gives back every record it holds, value for value', () => {
  const plan = planImport(modelForExport(records), { rootFolders, modelRecordId });
  const made = new Map(plan.creates.map(record => [`${record.entityId} ${record.recordId}`, record.values]));
  const expected = all.filter(record => !['ar.type', 'ar.model'].includes(record.entityId) && !roots.includes(record));
  assert.equal(made.size, expected.length, 'Opening the saved model made another number of records.');
  for (const record of expected) {
    assert.deepEqual(made.get(`${record.entityId} ${record.recordId}`), record.values, `${record.entityId} ${record.recordId} came back changed`);
  }
  assert.deepEqual(plan.rootUpdates.map(update => [update.recordId, update.values['ar.folder.archiId']]).sort(),
    roots.map(folder => [folder.recordId, folder.values['ar.folder.archiId']]).sort());
  const model = records['ar.model'][0].values;
  assert.deepEqual(plan.modelValues, Object.fromEntries(Object.entries(model).filter(([, value]) => value !== null)));
  assert.deepEqual(plan.counts, { elements: 120, relationships: 176, views: 17, objects: 249, connections: 199, folders: 17 });
});

test('the saved file is Archi XML with each object under the Archi ID it came with', () => {
  const { xml, fileName } = exportArchimate(records);
  assert.equal(fileName, 'Archisurance.archimate');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<archimate:model /);
  assert.match(xml, /name="Archisurance"/);
  const ids = [...xml.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  const objects = ['ar.folder', 'ar.concept', 'ar.view', 'ar.item', 'ar.model'].reduce((sum, entityId) => sum + records[entityId].length, 0);
  assert.equal(ids.length, objects, 'Not every folder, concept, view, diagram item and the model was written with an ID.');
  assert.equal(new Set(ids).size, ids.length, 'An Archi ID was written twice.');
  assert.deepEqual(ids.filter(id => id.startsWith('ar-') || id.startsWith('ar.')), [], 'A record ID was written where Archi expects its own ID.');
  const element = records['ar.concept'][0];
  assert.ok(ids.includes(element.values['ar.concept.archiId']), 'An element lost the Archi ID it came with.');
});

test('a new object the workbench made is saved under its record ID without the ar- prefix', () => {
  const made = { entityId: 'ar.concept', recordId: 'ar-id-0123456789abcdef0123456789abcdef', version: 1, values: {
    'ar.concept.name': 'Made here', 'ar.concept.type': 'ar.type.r.BusinessActor', 'ar.concept.category': 'Element',
    'ar.concept.folder': rootFolders.Business, 'ar.concept.archiId': null } };
  const { xml } = exportArchimate({ ...records, 'ar.concept': [...records['ar.concept'], made] });
  assert.match(xml, /<element xsi:type="archimate:BusinessActor" name="Made here" id="id-0123456789abcdef0123456789abcdef"\/>/);
});

test('an empty model is one a model can be opened into; Archisurance is not', () => {
  assert.equal(holdsNoModel(emptyFile()), true);
  assert.equal(holdsNoModel(records), false);
  const withFolder = emptyFile();
  withFolder['ar.folder'] = [...withFolder['ar.folder'], { entityId: 'ar.folder', recordId: 'ar-sub', version: 1, values: { 'ar.folder.parent': rootFolders.Business } }];
  assert.equal(holdsNoModel(withFolder), false, 'A folder inside a top-level one is a model’s work.');
});

test('the writes go in batches of 200, each reference naming the version it will find', () => {
  const sets = emptyFile();
  const plan = planImport(modelForExport(records), { rootFolders, modelRecordId });
  const batches = importBatches(plan, sets, 200);
  const writes = batches.flat();
  assert.ok(batches.every(batch => batch.length <= 200));
  assert.equal(writes.length, plan.creates.length + 1 + roots.length, 'Every record, the Model record and the nine folders.');
  assert.deepEqual(writes.slice(-1 - roots.length).map(write => [write.op, write.entityId]),
    [['update', 'ar.model'], ...roots.map(() => ['update', 'ar.folder'])], 'The Model record and the folders are not updated last.');
  assert.ok(writes.slice(-roots.length).every(write => write.version === 3), 'A folder update does not name the version it read.');

  const held = new Map(Object.values(sets).flat().map(record => [record.recordId, record.version]));
  const madeIn = new Map();
  batches.forEach((batch, index) => batch.forEach(write => { if (write.op === 'create') madeIn.set(write.recordId, index); }));
  let checked = 0;
  batches.forEach((batch, index) => batch.forEach((write, at) => {
    for (const [field, value] of Object.entries(write.values)) {
      if (!references.has(field) || typeof value !== 'string') continue;
      const version = write.targetVersions?.[field];
      if (madeIn.has(value)) {
        assert.ok(madeIn.get(value) <= index, `${write.recordId} points at ${value} before it is made`);
        if (madeIn.get(value) === index) {
          assert.ok(batch.findIndex(other => other.recordId === value) < at, `${write.recordId} comes before ${value} in its batch`);
          assert.equal(version, undefined, `${write.recordId}.${field} names a version for a record its own batch makes`);
        } else assert.equal(version, 1, `${write.recordId}.${field} does not name version 1 for a record an earlier batch made`);
      } else {
        assert.ok(held.has(value), `${write.recordId}.${field} points at ${value}, which is neither made nor held`);
        assert.equal(version, held.get(value), `${write.recordId}.${field} does not name the version the file holds`);
      }
      checked++;
    }
  }));
  assert.ok(checked > 2000, `Only ${checked} references were checked.`);
});

test('a file without a Model record gets one first, which the model’s properties point at', () => {
  const sets = emptyFile({ withModel: false });
  const model = modelForExport(records);
  model.info.properties = [{ key: 'Owner', value: 'Architecture' }];
  const plan = planImport(model, { rootFolders, modelRecordId: 'ar.model.r.made' });
  const writes = importBatches(plan, sets, 200).flat();
  assert.deepEqual([writes[0].op, writes[0].entityId, writes[0].recordId, writes[0].values['ar.model.name']], ['create', 'ar.model', 'ar.model.r.made', 'Archisurance']);
  assert.equal(writes.filter(write => write.entityId === 'ar.model').length, 1, 'The Model record was written twice.');
  assert.ok(writes.some(write => write.values['ar.property.model'] === 'ar.model.r.made'));
});
