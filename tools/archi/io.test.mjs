import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exportArchimate, exportExchange, holdsNoModel, importBatches, importProblems, importProblemSentence, leftOutSentence, modelFileFormat, modelForExport, planImport } from '../../extensions/archi/canvas.js';
import { EXCHANGE_SCHEMAS, validateExchangeXml } from '../../extensions/archi/xsd.js';
import { archiSchema } from './fixtures.mjs';
import { modelRecordOf, plan } from './archimate-records.mjs';

// The workbench saves Archi.nendo's records as an .archimate file and opens one into an
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

// Archisurance saved as Open Exchange XML is valid against Archi 5.9's own schemas, checked
// by libxml2 as the workbench checks it before saving (xsd.js). Reading it back needs a DOMParser,
// so that is measured in the review lane and by tools/archi/verify-exchange-io.mjs.
test('Archisurance saved as Exchange XML validates against Archi 5.9’s five schemas, and a type they do not know does not', async () => {
  assert.deepEqual(Object.keys(EXCHANGE_SCHEMAS).sort(), ['archimate3_Diagram.xsd', 'archimate3_Model.xsd', 'archimate3_View.xsd', 'dc.xsd', 'xml.xsd']);
  const { xml, fileName } = exportExchange(records);
  assert.equal(fileName, 'Archisurance.xml');
  assert.match(xml, /<model xmlns="http:\/\/www\.opengroup\.org\/xsd\/archimate\/3\.0\/"/);
  assert.equal((xml.match(/<element identifier=/g) ?? []).length, 120);
  assert.equal((xml.match(/<relationship identifier=/g) ?? []).length, 176);
  assert.equal((xml.match(/<view identifier=/g) ?? []).length, 17);
  assert.match(xml, /<organizations>/, 'The folders were left out of the organization.');
  assert.deepEqual(await validateExchangeXml(xml), []);
  const refused = await validateExchangeXml(xml.replace('xsi:type="BusinessActor"', 'xsi:type="NoSuchType"'));
  assert.ok(refused.length > 0 && refused.every(problem => problem.severity === 'error'));
  assert.match(refused[0].message, /NoSuchType' of the xsi:type attribute does not resolve to a type definition/);
});

test('the Open dialog tells Exchange XML from an .archimate by what the file holds', () => {
  const bytes = text => new TextEncoder().encode(text);
  assert.equal(modelFileFormat(bytes(exportExchange(records).xml)), 'exchange');
  assert.equal(modelFileFormat(bytes(exportArchimate(records).xml)), 'archimate');
  assert.equal(modelFileFormat(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), 'archimate', 'An archive is an .archimate.');
});

// Open writes a model in batches of 200, each its own revision, so a reference to nothing
// or a relationship the link rule refuses near the end left a half-imported model. Both are now
// found before anything is written, and the Open dialog refuses the file naming the first.
test('a relationship to nothing, or one ArchiMate does not allow, is found before anything is written', () => {
  const sets = emptyFile();
  assert.deepEqual(importProblems(planImport(modelForExport(records), { rootFolders, modelRecordId }), sets), [], 'Archisurance itself has an import problem.');
  const relations = Object.values(modelForExport(records).folders).find(folder => folder.folderType === 'relations');
  const withRelationship = relationship => {
    const model = modelForExport(records);
    model.relationships[relationship.id] = { kind: 'relationship', name: '', documentation: '', properties: [], profileIds: [], folderId: relations.id, ...relationship };
    model.folders[relations.id].itemIds.push(relationship.id);
    return planImport(model, { rootFolders, modelRecordId });
  };
  const element = type => Object.values(modelForExport(records).elements).find(candidate => candidate.type === type).id;
  const dangling = importProblems(withRelationship({ id: 'id-dangling', type: 'AssociationRelationship', sourceId: element('BusinessActor'), targetId: 'id-nowhere' }), sets);
  assert.equal(dangling.length, 1, `A relationship to an element nobody makes was not found before the writes: ${JSON.stringify(dangling)}`);
  assert.match(dangling[0], /^id-dangling points at id-nowhere, which the file does not hold\.$/);
  const objects = Object.values(modelForExport(records).elements).filter(candidate => candidate.type === 'BusinessObject').map(candidate => candidate.id);
  const refused = importProblems(withRelationship({ id: 'id-refused', name: 'Triggers', type: 'TriggeringRelationship', sourceId: objects[0], targetId: objects[1] }), sets);
  assert.equal(refused.length, 1, `A relationship the link rule refuses was not found before the writes: ${JSON.stringify(refused)}`);
  assert.match(refused[0], /^id-refused "Triggers" is a TriggeringRelationship from a BusinessObject to a BusinessObject, which ArchiMate does not allow\.$/);
  assert.match(importProblemSentence([...dangling, ...refused]), /^Nendo would refuse part of it, so nothing is opened: id-dangling points at id-nowhere.* 1 more like it\./);
  assert.equal(importProblemSentence([]), null);
});

// archi-online's reader skips Sketch and Canvas views without a word; the Open dialog's
// Left out line says how many there were. (Counting them reads the XML, which needs a browser's
// DOMParser; Gate-ArchiWorkbench.mjs drops such a file on the workbench.)
test('the Left out line names Sketch and Canvas views, with or without images', () => {
  const none = { imageObjects: 0, imageConnections: 0, pictures: 0, archiveImages: 0 };
  assert.equal(leftOutSentence(none), null);
  assert.equal(leftOutSentence({ ...none, sketchViews: 1, canvasViews: 2 }), 'Left out: 1 Sketch view, 2 Canvas views. Archi.nendo holds no Sketch or Canvas views.',
    'The Left out line says nothing of the Sketch and Canvas views the file holds.');
  assert.equal(leftOutSentence({ ...none, imageObjects: 2, sketchViews: 1 }), 'Left out: 2 image objects, 1 Sketch view. Archi.nendo holds no images and no Sketch or Canvas views.');
  assert.equal(leftOutSentence({ ...none, archiveImages: 3 }), 'Left out: 3 image files. Archi.nendo holds no images.');
});

// tools/Import-Archimate.mjs planned every model property against Build-Archi's seeded
// Model record ID and then read a Model record that a new Archi model does not keep.
test('the importer points the model’s properties at the file’s own Model record, and makes one where a new model has none', async () => {
  const model = modelForExport(records);
  model.info.properties = [{ key: 'Owner', value: 'Architecture' }];
  const properties = plan(model, 'ar.model.r.0123').writes.find(([entityId]) => entityId === 'ar.property')[1].filter(record => record.values['ar.property.model']);
  assert.deepEqual(properties.map(record => record.values['ar.property.model']), ['ar.model.r.0123'],
    'The model’s properties point at the seeded Model record, not the one the file holds.');
  const existing = { read: { records: async () => [{ recordId: 'ar.model.r.abc', recordVersion: 3, values: {} }] } };
  assert.deepEqual(await modelRecordOf(existing, async () => assert.fail('A second Model record was made.')), { recordId: 'ar.model.r.abc', version: 3 });
  const held = [];
  const made = await modelRecordOf({ read: { records: async () => held } }, async record => held.push({ recordId: record.recordId, recordVersion: 1, values: record.values }));
  assert.deepEqual(made, { recordId: 'ar.model.r.model', version: 1 }, 'A file without a Model record got none, so the import would stop after writing everything else.');
});

// A view reference to a Sketch or Canvas view, which archi-online does not read,
// pointed at no planned view, and the preflight refused a valid file. It is left out and counted.
test('a view reference to a view the file does not open is left out and counted, not refused', () => {
  const model = modelForExport(records);
  const view = Object.values(model.views)[0];
  const reference = { id: 'id-ref-to-sketch', nodeType: 'ref', viewId: view.id, parentId: view.id, refViewId: 'id-a-sketch',
    bounds: { x: 10, y: 10, width: 120, height: 55 }, childIds: [], sourceConnectionIds: [], targetConnectionIds: [] };
  model.nodes[reference.id] = reference;
  view.childIds.push(reference.id);
  const plan = planImport(model, { rootFolders, modelRecordId });
  const problems = importProblems(plan, emptyFile());
  assert.deepEqual(problems, [], `A valid file with a reference to a Sketch view was refused: ${JSON.stringify(problems)}`);
  assert.ok(!plan.creates.some(record => record.recordId === 'ar-id-ref-to-sketch'), 'The reference to a view nobody makes was planned.');
  assert.equal(plan.leftOut.viewReferences, 1, 'The left-out view reference was not counted.');
  assert.match(leftOutSentence({ ...plan.leftOut, sketchViews: 1 }), /1 Sketch view, 1 view reference to one\. Archi\.nendo holds no Sketch or Canvas views\./);
});
