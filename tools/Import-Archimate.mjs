// Loads an .archimate model into Archi.nendo over MCP (W-108), before the Archi view can open a
// file itself (W-104, W-120). The file is parsed by archi-online's own parser, so the records are
// what archi-online would hold; this script only maps that model onto the record types that
// tools/Build-Archi.mjs made, and writes them in the order their references need.
//
//   node tools/Import-Archimate.mjs <file.archimate>          write it, then compare
//   node tools/Import-Archimate.mjs <file.archimate> --dry-run count what would be written
//   node tools/Import-Archimate.mjs <file.archimate> compare   compare what the file holds
//
// It needs the archi-online checkout beside this one (ARCHI_ONLINE names another) for the parser,
// esbuild and jsdom. It writes into a file that holds no concepts yet, and refuses one that does.
// Images are left out: binary fields are out of scope (F-208), and a model that has them is
// named as such rather than silently thinned.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fail, target, withLease } from './archi-mcp.mjs';
import { parser, plan, present } from './archi/archimate-records.mjs';

// Every reference a record makes is to a record written before it, all at version 1: seeded
// folders and types are untouched until the last step, and every other target is new.
const REFERENCES = {
  'ar.folder': ['ar.folder.parent'],
  'ar.specialization': ['ar.specialization.type'],
  'ar.concept': ['ar.concept.type', 'ar.concept.folder', 'ar.concept.source', 'ar.concept.target', 'ar.concept.specialization'],
  'ar.view': ['ar.view.folder'],
  'ar.item': ['ar.item.view', 'ar.item.concept', 'ar.item.refView', 'ar.item.parent', 'ar.item.source', 'ar.item.target'],
  'ar.property': ['ar.property.concept', 'ar.property.view', 'ar.property.folder', 'ar.property.item', 'ar.property.model'],
};

async function write(file, planned) {
  if ((await file.read.records('ar.concept')).length > 0) fail('Archi.nendo already holds concepts. Import into a file built from empty.');
  await withLease(file.client, async owned => {
    for (const [entityId, records] of planned.writes) {
      for (let start = 0; start < records.length; start += 50) {
        const slice = records.slice(start, start + 50).map(record => {
          const expected = Object.fromEntries(REFERENCES[entityId].filter(fieldId => present(record.values[fieldId])).map(fieldId => [fieldId, 1]));
          return Object.keys(expected).length > 0
            ? { recordId: record.recordId, values: record.values, expectedTargetVersions: expected }
            : { recordId: record.recordId, values: record.values };
        });
        const key = crypto.createHash('sha256').update(JSON.stringify(slice)).digest('hex').slice(0, 32);
        await file.client.tool('nendo.data.create_records', { ...owned, entityId, records: slice, idempotencyKey: `archi-import-${key}` });
      }
      console.log(`    +  ${entityId}: ${records.length}`);
    }
    // Last, because a changed record moves past version 1: the seeded top-level folders take the
    // IDs Archi gave them, and the model record its name and metadata.
    const modelRecord = (await file.read.records('ar.model'))[0];
    let version = modelRecord.recordVersion;
    for (const [fieldId, value] of Object.entries(planned.modelValues)) {
      const answer = await file.client.tool('nendo.data.set_field', { ...owned, entityId: 'ar.model', recordId: modelRecord.recordId,
        fieldId, expectedRecordVersion: version, value, idempotencyKey: `archi-import-model-${fieldId}-${version}` });
      version = answer.recordVersion;
    }
    const folders = new Map((await file.read.records('ar.folder')).map(record => [record.recordId, record.recordVersion]));
    for (const { recordId, archiId } of planned.rootIds) {
      await file.client.tool('nendo.data.set_field', { ...owned, entityId: 'ar.folder', recordId, fieldId: 'ar.folder.archiId',
        expectedRecordVersion: folders.get(recordId), value: archiId, idempotencyKey: `archi-import-root-${archiId}` });
    }
    console.log(`    +  ar.model: ${Object.keys(planned.modelValues).length} fields; ${planned.rootIds.length} top-level folders named`);
  });
}

/** What the file holds against the parsed model: counts, and every diagram item's bounds and route. */
async function compare(file, model) {
  const problems = [];
  const concepts = await file.read.records('ar.concept');
  const items = await file.read.records('ar.item');
  const count = (label, actual, expected) => {
    console.log(`${String(actual).padStart(5)} ${label}${actual === expected ? '' : ` (expected ${expected})`}`);
    if (actual !== expected) problems.push(`${label}: ${actual}, not ${expected}`);
  };
  const nonImage = Object.values(model.nodes).filter(node => node.nodeType !== 'image');
  count('elements', concepts.filter(r => r.values['ar.concept.category'] === 'Element').length, Object.keys(model.elements).length);
  count('relationships', concepts.filter(r => r.values['ar.concept.category'] === 'Relationship').length, Object.keys(model.relationships).length);
  count('views', (await file.read.records('ar.view')).length, Object.keys(model.views).length);
  count('diagram objects', items.filter(r => !/connection/i.test(r.values['ar.item.kind'])).length, nonImage.length);
  count('connections', items.filter(r => /connection/i.test(r.values['ar.item.kind'])).length, Object.keys(model.connections).length);
  count('folders', (await file.read.records('ar.folder')).length, Object.keys(model.folders).length);
  const held = new Map(items.map(record => [record.values['ar.item.archiId'], record.values]));
  let bounds = 0;
  let routes = 0;
  for (const node of nonImage) {
    const values = held.get(node.id);
    const same = values && ['x', 'y', 'width', 'height'].every(name => values[`ar.item.${name}`] === node.bounds[name]);
    if (same) bounds++; else problems.push(`${node.id}: bounds ${JSON.stringify(values && ['x', 'y', 'width', 'height'].map(n => values[`ar.item.${n}`]))}, not ${JSON.stringify(node.bounds)}`);
  }
  for (const connection of Object.values(model.connections)) {
    const stored = held.get(connection.id)?.['ar.item.bendpoints'] ?? null;
    const expected = connection.bendpoints.length > 0 ? connection.bendpoints : null;
    if (JSON.stringify(stored === null ? null : JSON.parse(stored)) === JSON.stringify(expected)) routes++;
    else problems.push(`${connection.id}: bendpoints ${stored}, not ${JSON.stringify(expected)}`);
  }
  console.log(`${String(bounds).padStart(5)} diagram objects with their bounds`);
  console.log(`${String(routes).padStart(5)} connections with their bendpoints`);
  if (problems.length > 0) fail(`Archi.nendo differs from the model:\n  ${problems.slice(0, 20).join('\n  ')}`);
  console.log('Archi.nendo holds the model: every count, bound and route matches.');
}

const args = process.argv.slice(2);
const source = args.find(arg => !arg.startsWith('--') && arg !== 'compare');
if (!source) fail('Name the .archimate file to import.');
const parseArchimate = await parser();
const model = parseArchimate(await fs.readFile(source, 'utf8'));
const planned = plan(model);
for (const [entityId, records] of planned.writes) console.log(`${String(records.length).padStart(5)}  ${entityId}`);
if (planned.images > 0) console.log(`Left out: ${planned.images} image objects (binary fields are out of scope, F-208).`);
if (args.includes('--dry-run')) process.exit(0);

const file = await target('nendo-archi-import');
if (!args.includes('compare')) await write(file, planned);
await compare(file, model);
