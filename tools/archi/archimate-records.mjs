// An .archimate model as Archi.nendo's records: archi-online's own parser, bundled for Node, and
// the mapping from its model onto the record types tools/Build-Archi.mjs makes. Shared by
// tools/Import-Archimate.mjs, which writes the records into a file, and tools/archi/make-fixture.mjs,
// which writes them as the fixture the workbench's tests read.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FOLDER_KINDS, ROOT_FOLDERS } from '../archi-definition.mjs';
import { fail } from '../archi-mcp.mjs';

const ARCHI_ONLINE = path.resolve(process.env.ARCHI_ONLINE ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online'));

export async function parser() {
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

export const rid = archiId => `ar-${archiId}`;
export const present = value => value !== undefined && value !== null && value !== '';
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
export function plan(model) {
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
