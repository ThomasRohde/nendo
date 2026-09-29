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
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FOLDER_KINDS, ROOT_FOLDERS } from './archi-definition.mjs';
import { fail, target, withLease } from './archi-mcp.mjs';

const ARCHI_ONLINE = path.resolve(process.env.ARCHI_ONLINE ?? path.join(import.meta.dirname, '..', '..', 'archi-online'));

async function parser() {
  const require = createRequire(path.join(ARCHI_ONLINE, 'package.json'));
  let esbuild, jsdom;
  try { esbuild = require('esbuild'); jsdom = require('jsdom'); } catch {
    fail(`The parser comes from archi-online, which was not found with its dependencies at ${ARCHI_ONLINE}. Set ARCHI_ONLINE.`);
  }
  globalThis.DOMParser = new jsdom.JSDOM('').window.DOMParser;
  const outfile = path.join(os.tmpdir(), `archi-parse-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(ARCHI_ONLINE, 'src', 'model', 'io', 'archimate-xml', 'parse.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error',
  });
  try { return (await import(pathToFileURL(outfile).href)).parseArchimate; } finally { await fs.rm(outfile, { force: true }); }
}

const ARCHI_FOLDER_KIND = { strategy: 'Strategy', business: 'Business', application: 'Application',
  technology: 'Technology & Physical', motivation: 'Motivation', implementation_migration: 'Implementation & Migration',
  other: 'Other', relations: 'Relations', diagrams: 'Views' };
const ACCESS = ['Write', 'Read', 'Access', 'Read and write'];
const ROUTER = { 0: 'Manual', 2: 'Manhattan' };
const NODE_KIND = { element: 'Element', group: 'Group', note: 'Note', ref: 'View reference' };
const STYLE = { fillColor: 'fillColor', lineColor: 'lineColor', fontColor: 'fontColor', alpha: 'alpha', lineAlpha: 'lineAlpha',
  fontAlpha: 'fontAlpha', gradient: 'gradient', lineStyle: 'lineStyle', lineWidth: 'lineWidth', iconVisible: 'iconVisible',
  iconColor: 'iconColor', derivedLineColor: 'derivedLineColor', font: 'font', textAlignment: 'textAlignment',
  textPosition: 'textPosition', labelExpression: 'labelExpression' };

const rid = archiId => `ar-${archiId}`;
const present = value => value !== undefined && value !== null && value !== '';
function values(prefix, map) {
  const out = {};
  for (const [field, value] of Object.entries(map)) if (present(value)) out[`${prefix}.${field}`] = value;
  return out;
}

/** Order records so each one's references to its own type come before it. */
function dependencyOrder(records, dependsOn) {
  const byId = new Map(records.map(record => [record.recordId, record]));
  const done = new Set();
  const ordered = [];
  const visit = (record, trail) => {
    if (done.has(record.recordId)) return;
    if (trail.has(record.recordId)) fail(`${record.recordId} depends on itself.`);
    trail.add(record.recordId);
    for (const id of dependsOn(record)) if (byId.has(id)) visit(byId.get(id), trail);
    done.add(record.recordId);
    ordered.push(record);
  };
  for (const record of records) visit(record, new Set());
  return ordered;
}

/** The model as rows per record type, in the order they can be written. */
function plan(model) {
  const images = Object.values(model.nodes).filter(node => node.nodeType === 'image').length;
  const rootFolder = new Map();
  for (const folder of Object.values(model.folders)) {
    if (folder.parentId === null && folder.folderType) {
      const kind = ARCHI_FOLDER_KIND[folder.folderType];
      rootFolder.set(folder.id, ROOT_FOLDERS[FOLDER_KINDS.indexOf(kind)].recordId);
    }
  }
  const folderRef = id => rootFolder.get(id) ?? rid(id);
  const properties = [];
  const addProperties = (owner, ownerId, list) => (list ?? []).forEach((property, index) => properties.push({
    recordId: `${rid(ownerId)}.p${index + 1}`,
    values: { 'ar.property.key': property.key, 'ar.property.value': property.value ?? '', 'ar.property.order': (index + 1) * 1024,
      [`ar.property.${owner}`]: owner === 'model' ? 'ar.model.r.model' : owner === 'folder' ? folderRef(ownerId) : rid(ownerId) },
  }));

  const orderIn = (list, id) => (list.indexOf(id) + 1) * 1024;
  const folders = dependencyOrder(Object.values(model.folders).filter(folder => !rootFolder.has(folder.id)).map(folder => {
    const siblings = folder.parentId === null ? model.rootFolderIds : model.folders[folder.parentId].folderIds;
    addProperties('folder', folder.id, folder.properties);
    return { recordId: rid(folder.id), parent: folder.parentId, values: values('ar.folder', {
      name: folder.name, documentation: folder.documentation, labelExpression: folder.labelExpression,
      parent: folder.parentId === null ? null : folderRef(folder.parentId), order: orderIn(siblings, folder.id), archiId: folder.id,
    }) };
  }), record => record.parent ? [rid(record.parent)] : []);
  for (const [archiId, recordId] of rootFolder) addProperties('folder', archiId, model.folders[archiId].properties);

  const specializations = Object.values(model.profiles).map(profile => ({ recordId: rid(profile.id), values: values('ar.specialization', {
    name: profile.name, type: `ar.type.r.${profile.conceptType}`, archiId: profile.id }) }));

  const concept = (item, category) => {
    addProperties('concept', item.id, item.properties);
    return { recordId: rid(item.id), source: item.sourceId, target: item.targetId, values: values('ar.concept', {
      name: item.name, type: `ar.type.r.${item.type}`, category, documentation: item.documentation, folder: folderRef(item.folderId),
      source: item.sourceId ? rid(item.sourceId) : null, target: item.targetId ? rid(item.targetId) : null,
      access: item.accessType === undefined ? null : ACCESS[item.accessType], strength: item.strength,
      directed: item.directed === undefined ? null : item.directed,
      junction: item.junctionType === undefined ? null : item.junctionType === 'or' ? 'Or' : 'And',
      specialization: item.profileIds?.[0] ? rid(item.profileIds[0]) : null, archiId: item.id,
    }) };
  };
  const elements = Object.values(model.elements).map(element => concept(element, 'Element'));
  const relationships = dependencyOrder(Object.values(model.relationships).map(relationship => concept(relationship, 'Relationship')),
    record => [record.source, record.target].filter(Boolean).map(rid));

  const views = Object.values(model.views).map(view => {
    addProperties('view', view.id, view.properties);
    return { recordId: rid(view.id), values: values('ar.view', {
      name: view.name, documentation: view.documentation, folder: folderRef(view.folderId), viewpoint: view.viewpoint,
      router: ROUTER[view.connectionRouterType] ?? null, archiId: view.id,
    }) };
  });

  const style = item => Object.fromEntries(Object.entries(STYLE).map(([from, to]) => [to, item[from]]));
  const nodes = dependencyOrder(Object.values(model.nodes).filter(node => node.nodeType !== 'image').map(node => {
    const parentIsView = node.parentId === node.viewId;
    const siblings = parentIsView ? model.views[node.viewId].childIds : model.nodes[node.parentId].childIds;
    addProperties('item', node.id, node.properties);
    return { recordId: rid(node.id), parent: parentIsView ? null : node.parentId, values: values('ar.item', {
      view: rid(node.viewId), kind: NODE_KIND[node.nodeType], concept: node.elementId ? rid(node.elementId) : null,
      refView: node.refViewId ? rid(node.refViewId) : null, parent: parentIsView ? null : rid(node.parentId),
      order: orderIn(siblings, node.id), x: node.bounds.x, y: node.bounds.y, width: node.bounds.width, height: node.bounds.height,
      name: node.name, documentation: node.documentation, content: node.content, figure: node.figureType, border: node.borderType,
      legend: node.legendOptions ? JSON.stringify(node.legendOptions) : null, archiId: node.id, ...style(node),
    }) };
  }), record => record.parent ? [rid(record.parent)] : []);

  const connections = dependencyOrder(Object.values(model.connections).map(connection => {
    addProperties('item', connection.id, connection.properties);
    return { recordId: rid(connection.id), source: connection.sourceId, target: connection.targetId, values: values('ar.item', {
      view: rid(connection.viewId), kind: connection.connType === 'relationship' ? 'Relationship connection' : 'Connection',
      concept: connection.relationshipId ? rid(connection.relationshipId) : null,
      source: rid(connection.sourceId), target: rid(connection.targetId),
      bendpoints: connection.bendpoints.length > 0 ? JSON.stringify(connection.bendpoints) : null,
      name: connection.name, documentation: connection.documentation, connectionType: connection.connectionType,
      nameVisible: connection.nameVisible, archiId: connection.id, ...style(connection),
    }) };
  }), record => [record.source, record.target].filter(Boolean).map(rid));
  addProperties('model', 'model', model.info.properties);

  const info = model.info;
  const modelValues = values('ar.model', { name: info.name, documentation: info.documentation, language: info.language,
    version: info.version, archiId: info.id,
    ...Object.fromEntries((info.metadata ?? []).map(entry => [`dc${entry.name.charAt(0).toUpperCase()}${entry.name.slice(1)}`, entry.value])) });
  const rootIds = [...rootFolder].map(([archiId, recordId]) => ({ recordId, archiId }));

  return {
    images,
    writes: [
      ['ar.folder', folders], ['ar.specialization', specializations], ['ar.concept', [...elements, ...relationships]],
      ['ar.view', views], ['ar.item', [...nodes, ...connections]], ['ar.property', properties],
    ],
    modelValues, rootIds,
  };
}

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
