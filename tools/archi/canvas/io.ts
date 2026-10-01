// Open and save .archimate files (W-120): archi-online's own parser and serializer over the
// records Archi.nendo holds. Reading takes Archi's plain XML or its archive with images, and
// leaves the images out, counted: binary fields are out of scope (F-208). Planning maps the model
// onto Archi.nendo's record types, the mapping tools/Import-Archimate.mjs has always used and now
// shares from here. Saving writes the records back as plain XML, each object under the Archi ID
// it came with, or the one its record ID gives it.

import { strFromU8, unzipSync } from 'fflate';
import { parseArchimate } from '@archi/model/io/archimate-xml/parse';
import { serializeArchimate } from '@archi/model/io/archimate-xml/serialize';
import {
  MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_ENTRY_BYTES, MAX_ARCHIVE_UNCOMPRESSED_BYTES, MAX_DOCUMENT_BYTES, MAX_MODEL_XML_BYTES,
} from '@archi/model/io/document-limits';
import { DUBLIN_CORE_FIELDS, type ModelState } from '@archi/model/types';
import { buildMirror, type NendoRecord, type RecordSets } from './mirror';

type Values = Record<string, unknown>;

export interface LeftOut {
  /** Image objects on views, and the connections that end on one. */
  imageObjects: number;
  imageConnections: number;
  /** Pictures that diagram objects and specializations show, and the archive's image files. */
  pictures: number;
  archiveImages: number;
}

/** A thrown refusal a person can read: what is wrong with the file, not where the parser was. */
export class ArchimateFileError extends Error {}

const ARCHI_FOLDER_KIND: Record<string, string> = {
  strategy: 'Strategy', business: 'Business', application: 'Application', technology: 'Technology & Physical',
  motivation: 'Motivation', implementation_migration: 'Implementation & Migration', other: 'Other', relations: 'Relations', diagrams: 'Views',
};
const ACCESS = ['Write', 'Read', 'Access', 'Read and write'];
const ROUTER: Record<number, string> = { 0: 'Manual', 2: 'Manhattan' };
const NODE_KIND: Record<string, string> = { element: 'Element', group: 'Group', note: 'Note', ref: 'View reference' };
const STYLE = ['fillColor', 'lineColor', 'fontColor', 'alpha', 'lineAlpha', 'fontAlpha', 'gradient', 'lineStyle', 'lineWidth',
  'iconVisible', 'iconColor', 'derivedLineColor', 'font', 'textAlignment', 'textPosition', 'labelExpression'];

/** Every field that points at another record. A write names each target's version as it read it. */
export const REFERENCE_FIELDS = new Set(['ar.folder.parent', 'ar.specialization.type', 'ar.concept.type', 'ar.concept.folder',
  'ar.concept.source', 'ar.concept.target', 'ar.concept.specialization', 'ar.view.folder', 'ar.item.view', 'ar.item.concept',
  'ar.item.refView', 'ar.item.parent', 'ar.item.source', 'ar.item.target', 'ar.property.concept', 'ar.property.view',
  'ar.property.folder', 'ar.property.item', 'ar.property.model']);

const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const titled = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

// ---------------------------------------------------------------- reading

const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
  ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8));

/**
 * An .archimate file as archi-online reads it: plain XML, or Archi's archive of model.xml and its
 * images, within archi-online's own limits. The images stay behind and are counted.
 */
export function readArchimate(bytes: Uint8Array): { model: ModelState; leftOut: LeftOut } {
  const mib = (count: number) => `${Math.round(count / 1048576)} MiB`;
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new ArchimateFileError(`The file is larger than ${mib(MAX_DOCUMENT_BYTES)}.`);
  let xml: string;
  let archiveImages = 0;
  if (isZip(bytes)) {
    let entries = 0, total = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: file => {
        entries += 1;
        total += file.originalSize;
        if (entries > MAX_ARCHIVE_ENTRIES) throw new ArchimateFileError(`The archive holds more than ${MAX_ARCHIVE_ENTRIES} files.`);
        if (file.originalSize > MAX_ARCHIVE_ENTRY_BYTES || total > MAX_ARCHIVE_UNCOMPRESSED_BYTES)
          throw new ArchimateFileError(`The archive unpacks to more than ${mib(MAX_ARCHIVE_UNCOMPRESSED_BYTES)}, or holds a file over ${mib(MAX_ARCHIVE_ENTRY_BYTES)}.`);
        if (file.name.startsWith('images/')) archiveImages += 1;
        return file.name === 'model.xml';
      } });
    } catch (error) {
      if (error instanceof ArchimateFileError) throw error;
      throw new ArchimateFileError(`The archive could not be read: ${(error as Error).message}`);
    }
    if (!files['model.xml']) throw new ArchimateFileError('The archive holds no model.xml, so it is not an Archi model.');
    xml = strFromU8(files['model.xml']);
  } else {
    xml = new TextDecoder().decode(bytes);
  }
  if (xml.length > MAX_MODEL_XML_BYTES) throw new ArchimateFileError(`The model is larger than ${mib(MAX_MODEL_XML_BYTES)}.`);
  let model: ModelState;
  try { model = parseArchimate(xml); } catch (error) {
    throw new ArchimateFileError(`This is not an Archi model that can be opened: ${(error as Error).message}`);
  }

  const imageNodes = new Set(Object.values(model.nodes).filter(node => node.nodeType === 'image').map(node => node.id));
  // A connection that ends on an image object, or on such a connection, goes with it.
  const droppedConnections = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const connection of Object.values(model.connections)) {
      if (droppedConnections.has(connection.id)) continue;
      const ends = [connection.sourceId, connection.targetId];
      if (ends.some(id => imageNodes.has(id) || droppedConnections.has(id))) { droppedConnections.add(connection.id); grew = true; }
    }
  }
  const pictures = Object.values(model.nodes).filter(node => node.nodeType !== 'image' && present((node as { imagePath?: string }).imagePath)).length
    + Object.values(model.profiles).filter(profile => present(profile.imagePath)).length;
  return { model, leftOut: { imageObjects: imageNodes.size, imageConnections: droppedConnections.size, pictures, archiveImages } };
}

/** What is left out, as one sentence, or null when nothing is. */
export function leftOutSentence(leftOut: LeftOut): string | null {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (leftOut.imageObjects > 0) parts.push(count(leftOut.imageObjects, 'image object', 'image objects'));
  if (leftOut.imageConnections > 0) parts.push(count(leftOut.imageConnections, 'connection to an image', 'connections to images'));
  if (leftOut.pictures > 0) parts.push(count(leftOut.pictures, 'picture on a figure or specialization', 'pictures on figures and specializations'));
  if (parts.length === 0 && leftOut.archiveImages === 0) return null;
  if (parts.length === 0) parts.push(count(leftOut.archiveImages, 'image file', 'image files'));
  return `Left out: ${parts.join(', ')}. Archi.nendo holds no images.`;
}

// ---------------------------------------------------------------- planning

export interface PlannedRecord { entityId: string; recordId: string; values: Values }
export interface ImportTarget {
  /** The top-level folder of each kind the file holds, by its Kind ('Business', 'Views', …). */
  rootFolders: Record<string, string>;
  /** The Model record, which takes the model's name, purpose and metadata. */
  modelRecordId: string;
}
export interface ImportPlan {
  /** Every record to create, each after what it points at. */
  creates: PlannedRecord[];
  /** The Model record's values, and each top-level folder's Archi ID and what Archi says of it. */
  modelValues: Values;
  rootUpdates: { recordId: string; values: Values }[];
  modelRecordId: string;
  leftOut: LeftOut;
  counts: { elements: number; relationships: number; views: number; objects: number; connections: number; folders: number };
}

export const recordIdOf = (archiId: string) => `ar-${archiId}`;

function values(prefix: string, map: Values): Values {
  const out: Values = {};
  for (const [field, value] of Object.entries(map)) if (present(value)) out[`${prefix}.${field}`] = value;
  return out;
}

/** Order records so each one's references to its own type come before it. */
function dependencyOrder<T extends { recordId: string }>(records: T[], dependsOn: (record: T) => string[]): T[] {
  const byId = new Map(records.map(record => [record.recordId, record]));
  const done = new Set<string>();
  const ordered: T[] = [];
  const visit = (record: T, trail: Set<string>) => {
    if (done.has(record.recordId)) return;
    if (trail.has(record.recordId)) throw new ArchimateFileError(`${record.recordId} depends on itself.`);
    trail.add(record.recordId);
    for (const id of dependsOn(record)) if (byId.has(id)) visit(byId.get(id)!, trail);
    done.add(record.recordId);
    ordered.push(record);
  };
  for (const record of records) visit(record, new Set());
  return ordered;
}

/** The model as Archi.nendo's records, in the order they can be written. */
export function planImport(model: ModelState, target: ImportTarget, leftOut?: LeftOut): ImportPlan {
  const left = leftOut ?? { imageObjects: 0, imageConnections: 0, pictures: 0, archiveImages: 0 };
  const rid = recordIdOf;
  const rootFolder = new Map<string, string>();
  for (const folder of Object.values(model.folders)) {
    if (folder.parentId !== null || !folder.folderType) continue;
    const kind = ARCHI_FOLDER_KIND[folder.folderType];
    const recordId = target.rootFolders[kind];
    if (!recordId) throw new ArchimateFileError(`This file has no top-level ${kind} folder to hold the model's ${kind} folder.`);
    rootFolder.set(folder.id, recordId);
  }
  const folderRef = (id: string) => rootFolder.get(id) ?? rid(id);
  const properties: PlannedRecord[] = [];
  const addProperties = (owner: string, ownerId: string, list: { key: string; value: string }[] | undefined) => (list ?? []).forEach((property, index) => properties.push({
    entityId: 'ar.property',
    recordId: `${rid(ownerId)}.p${index + 1}`,
    values: { 'ar.property.key': property.key, 'ar.property.value': property.value ?? '', 'ar.property.order': (index + 1) * 1024,
      [`ar.property.${owner}`]: owner === 'model' ? target.modelRecordId : owner === 'folder' ? folderRef(ownerId) : rid(ownerId) },
  }));

  const orderIn = (list: string[], id: string) => (list.indexOf(id) + 1) * 1024;
  // A concept's or a view's place among its folder's items, as Archi's file holds them.
  const inFolder = (folderId: string, id: string) => {
    const list = model.folders[folderId]?.itemIds ?? [];
    return list.includes(id) ? orderIn(list, id) : null;
  };
  const folders = dependencyOrder(Object.values(model.folders).filter(folder => !rootFolder.has(folder.id)).map(folder => {
    const siblings = folder.parentId === null ? model.rootFolderIds : model.folders[folder.parentId].folderIds;
    addProperties('folder', folder.id, folder.properties);
    return { entityId: 'ar.folder', recordId: rid(folder.id), parent: folder.parentId, values: values('ar.folder', {
      name: folder.name, documentation: folder.documentation, labelExpression: folder.labelExpression,
      parent: folder.parentId === null ? null : folderRef(folder.parentId), order: orderIn(siblings, folder.id), archiId: folder.id,
    }) };
  }), record => (record.parent ? [rid(record.parent)] : []));
  for (const archiId of rootFolder.keys()) addProperties('folder', archiId, model.folders[archiId].properties);

  const specializations = Object.values(model.profiles).map(profile => ({ entityId: 'ar.specialization', recordId: rid(profile.id),
    values: values('ar.specialization', { name: profile.name, type: `ar.type.r.${profile.conceptType}`, archiId: profile.id }) }));

  type Concept = { id: string; name: string; type: string; documentation: string; folderId: string; properties: { key: string; value: string }[];
    profileIds?: string[]; sourceId?: string; targetId?: string; accessType?: number; strength?: string; directed?: boolean; junctionType?: string };
  const concept = (item: Concept, category: string) => {
    addProperties('concept', item.id, item.properties);
    return { entityId: 'ar.concept', recordId: rid(item.id), source: item.sourceId, target: item.targetId, values: values('ar.concept', {
      name: item.name, type: `ar.type.r.${item.type}`, category, documentation: item.documentation, folder: folderRef(item.folderId),
      order: inFolder(item.folderId, item.id),
      source: item.sourceId ? rid(item.sourceId) : null, target: item.targetId ? rid(item.targetId) : null,
      access: item.accessType === undefined ? null : ACCESS[item.accessType], strength: item.strength,
      directed: item.directed === undefined ? null : item.directed,
      junction: item.junctionType === undefined ? null : item.junctionType === 'or' ? 'Or' : 'And',
      specialization: item.profileIds?.[0] ? rid(item.profileIds[0]) : null, archiId: item.id,
    }) };
  };
  const elements = Object.values(model.elements).map(element => concept(element as unknown as Concept, 'Element'));
  const relationships = dependencyOrder(Object.values(model.relationships).map(relationship => concept(relationship as unknown as Concept, 'Relationship')),
    record => [record.source, record.target].filter((id): id is string => Boolean(id)).map(rid));

  const views = Object.values(model.views).map(view => {
    addProperties('view', view.id, view.properties);
    return { entityId: 'ar.view', recordId: rid(view.id), values: values('ar.view', {
      name: view.name, documentation: view.documentation, folder: folderRef(view.folderId), order: inFolder(view.folderId, view.id),
      viewpoint: view.viewpoint, router: ROUTER[view.connectionRouterType ?? -1] ?? null, archiId: view.id,
    }) };
  });

  const style = (item: Record<string, unknown>) => Object.fromEntries(STYLE.map(name => [name, item[name]]));
  const imageNodes = new Set(Object.values(model.nodes).filter(node => node.nodeType === 'image').map(node => node.id));
  const nodes = dependencyOrder(Object.values(model.nodes).filter(node => node.nodeType !== 'image').map(node => {
    const any = node as unknown as Record<string, unknown> & { id: string; viewId: string; parentId: string; bounds: { x: number; y: number; width: number; height: number }; properties?: { key: string; value: string }[] };
    const parentIsView = any.parentId === any.viewId;
    const siblings = parentIsView ? model.views[any.viewId].childIds : model.nodes[any.parentId].childIds;
    addProperties('item', any.id, any.properties);
    return { entityId: 'ar.item', recordId: rid(any.id), parent: parentIsView ? null : any.parentId, values: values('ar.item', {
      view: rid(any.viewId), kind: NODE_KIND[node.nodeType], concept: any.elementId ? rid(any.elementId as string) : null,
      refView: any.refViewId ? rid(any.refViewId as string) : null, parent: parentIsView ? null : rid(any.parentId),
      order: orderIn(siblings, any.id), x: any.bounds.x, y: any.bounds.y, width: any.bounds.width, height: any.bounds.height,
      name: any.name, documentation: any.documentation, content: any.content, figure: any.figureType, border: any.borderType,
      legend: any.legendOptions ? JSON.stringify(any.legendOptions) : null, archiId: any.id, ...style(any),
    }) };
  }), record => (record.parent ? [rid(record.parent)] : []));

  const droppedConnections = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const connection of Object.values(model.connections)) {
      if (droppedConnections.has(connection.id)) continue;
      if ([connection.sourceId, connection.targetId].some(id => imageNodes.has(id) || droppedConnections.has(id))) { droppedConnections.add(connection.id); grew = true; }
    }
  }
  const ranks = connectionRanks(model, droppedConnections);
  const connections = dependencyOrder(Object.values(model.connections).filter(connection => !droppedConnections.has(connection.id)).map(connection => {
    const any = connection as unknown as Record<string, unknown> & { id: string; viewId: string; sourceId: string; targetId: string; bendpoints: unknown[]; properties?: { key: string; value: string }[] };
    addProperties('item', any.id, any.properties);
    return { entityId: 'ar.item', recordId: rid(any.id), source: any.sourceId, target: any.targetId, values: values('ar.item', {
      view: rid(any.viewId), kind: any.connType === 'relationship' ? 'Relationship connection' : 'Connection',
      concept: any.relationshipId ? rid(any.relationshipId as string) : null,
      source: rid(any.sourceId), target: rid(any.targetId), order: ranks.get(any.id),
      bendpoints: any.bendpoints.length > 0 ? JSON.stringify(any.bendpoints) : null,
      name: any.name, documentation: any.documentation, connectionType: any.connectionType,
      nameVisible: any.nameVisible, archiId: any.id, ...style(any),
    }) };
  }), record => [record.source, record.target].filter(Boolean).map(rid));
  addProperties('model', 'model', model.info.properties);

  const info = model.info;
  const modelValues = values('ar.model', { name: info.name, documentation: info.documentation, language: info.language,
    version: info.version, archiId: info.id,
    ...Object.fromEntries((info.metadata ?? []).map(entry => [`dc${titled(entry.name)}`, entry.value])) });
  // A top-level folder keeps its record and takes what Archi says of it: its ID, and its name,
  // documentation and label expression where the file gives them.
  const rootUpdates = [...rootFolder].map(([archiId, recordId]) => {
    const folder = model.folders[archiId];
    return { recordId, values: { ...values('ar.folder', { name: folder.name, documentation: folder.documentation,
      labelExpression: folder.labelExpression }), 'ar.folder.archiId': archiId } };
  });

  const strip = <T extends PlannedRecord>(list: T[]): PlannedRecord[] => list.map(({ entityId, recordId, values: v }) => ({ entityId, recordId, values: v }));
  return {
    creates: [...strip(folders), ...strip(specializations), ...strip(elements), ...strip(relationships), ...strip(views),
      ...strip(nodes), ...strip(connections), ...properties],
    modelValues, rootUpdates, modelRecordId: target.modelRecordId,
    leftOut: { ...left, imageObjects: imageNodes.size, imageConnections: droppedConnections.size },
    counts: { elements: elements.length, relationships: relationships.length, views: views.length, objects: nodes.length,
      connections: connections.length, folders: folders.length },
  };
}

/**
 * Each connection's place in the order Archi drew them. Archi appends a connection to its
 * source's outgoing list and its target's incoming list as it is drawn, so one order keeps every
 * list as the file holds it; the workbench's mirror rebuilds both lists from it. Lists that
 * disagree (a reconnected end) keep what they can, the rest in the file's order.
 */
function connectionRanks(model: ModelState, dropped: Set<string>): Map<string, number> {
  const ids = Object.keys(model.connections).filter(id => !dropped.has(id));
  const position = new Map(ids.map((id, index) => [id, index]));
  const after = new Map(ids.map(id => [id, new Set<string>()]));
  const before = new Map(ids.map(id => [id, 0]));
  const connectables = [...Object.values(model.nodes), ...Object.values(model.connections)] as unknown as
    { sourceConnectionIds?: string[]; targetConnectionIds?: string[] }[];
  for (const item of connectables) {
    for (const list of [item.sourceConnectionIds ?? [], item.targetConnectionIds ?? []]) {
      const kept = list.filter(id => position.has(id));
      for (let index = 1; index < kept.length; index++) {
        const edges = after.get(kept[index - 1])!;
        if (!edges.has(kept[index])) { edges.add(kept[index]); before.set(kept[index], before.get(kept[index])! + 1); }
      }
    }
  }
  const ready = ids.filter(id => before.get(id) === 0);
  const ranked: string[] = [];
  const done = new Set<string>();
  while (ranked.length < ids.length) {
    if (ready.length === 0) ready.push(ids.find(id => !done.has(id))!);
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const next = ready.shift()!;
    if (done.has(next)) continue;
    done.add(next);
    ranked.push(next);
    for (const later of after.get(next)!) {
      before.set(later, before.get(later)! - 1);
      if (before.get(later) === 0 && !done.has(later)) ready.push(later);
    }
  }
  return new Map(ranked.map((id, index) => [id, (index + 1) * 1024]));
}

// ---------------------------------------------------------------- writing

export interface ImportWrite {
  op: 'create' | 'update';
  entityId: string;
  recordId: string;
  version?: number;
  values: Values;
  targetVersions?: Record<string, number>;
}

/** Whether the file's model is empty: nothing but its top-level folders and, perhaps, a Model record. */
export function holdsNoModel(sets: RecordSets): boolean {
  const count = (entityId: string) => Object.values(sets).flatMap(list => list ?? []).filter(record => record.entityId === entityId).length;
  const folders = Object.values(sets).flatMap(list => list ?? []).filter(record => record.entityId === 'ar.folder');
  return ['ar.concept', 'ar.view', 'ar.item', 'ar.specialization', 'ar.property'].every(entityId => count(entityId) === 0)
    && folders.every(folder => !present(folder.values['ar.folder.parent']));
}

/**
 * The plan as batches of at most `size` writes, each a revision. A reference to a record made by
 * an earlier batch names version 1; one to a record the file already held names its version as
 * read; one to a record made earlier in the same batch names none. The Model record and the
 * top-level folders are updated last; a Model record the file lacks is made first.
 */
export function importBatches(plan: ImportPlan, sets: RecordSets, size = 200): ImportWrite[][] {
  const held = new Map<string, NendoRecord>();
  for (const list of Object.values(sets)) for (const record of list ?? []) held.set(`${record.entityId} ${record.recordId}`, record);
  const targetOf: Record<string, string> = { 'ar.folder.parent': 'ar.folder', 'ar.specialization.type': 'ar.type', 'ar.concept.type': 'ar.type',
    'ar.concept.folder': 'ar.folder', 'ar.concept.source': 'ar.concept', 'ar.concept.target': 'ar.concept', 'ar.concept.specialization': 'ar.specialization',
    'ar.view.folder': 'ar.folder', 'ar.item.view': 'ar.view', 'ar.item.concept': 'ar.concept', 'ar.item.refView': 'ar.view',
    'ar.item.parent': 'ar.item', 'ar.item.source': 'ar.item', 'ar.item.target': 'ar.item', 'ar.property.concept': 'ar.concept',
    'ar.property.view': 'ar.view', 'ar.property.folder': 'ar.folder', 'ar.property.item': 'ar.item', 'ar.property.model': 'ar.model' };

  const writes: Omit<ImportWrite, 'targetVersions'>[] = [];
  const modelHeld = held.get(`ar.model ${plan.modelRecordId}`);
  if (!modelHeld) writes.push({ op: 'create', entityId: 'ar.model', recordId: plan.modelRecordId, values: { 'ar.model.name': 'Model', ...plan.modelValues } });
  for (const record of plan.creates) writes.push({ op: 'create', ...record });
  if (modelHeld && Object.keys(plan.modelValues).length > 0)
    writes.push({ op: 'update', entityId: 'ar.model', recordId: modelHeld.recordId, version: modelHeld.version, values: plan.modelValues });
  for (const update of plan.rootUpdates) {
    const folder = held.get(`ar.folder ${update.recordId}`);
    if (!folder) throw new ArchimateFileError(`The top-level folder ${update.recordId} is not in this file.`);
    const changed = Object.fromEntries(Object.entries(update.values).filter(([field, value]) => folder.values[field] !== value));
    if (Object.keys(changed).length > 0) writes.push({ op: 'update', entityId: 'ar.folder', recordId: update.recordId, version: folder.version, values: changed });
  }

  const batches: ImportWrite[][] = [];
  const madeBefore = new Set<string>();
  for (let start = 0; start < writes.length; start += size) {
    const madeHere = new Set<string>();
    const batch = writes.slice(start, start + size).map(write => {
      const versions: Record<string, number> = {};
      for (const [field, value] of Object.entries(write.values)) {
        if (!REFERENCE_FIELDS.has(field) || typeof value !== 'string') continue;
        const key = `${targetOf[field]} ${value}`;
        if (madeHere.has(key)) continue;
        if (madeBefore.has(key)) { versions[field] = 1; continue; }
        const target = held.get(key);
        if (target) versions[field] = target.version;
      }
      if (write.op === 'create') madeHere.add(`${write.entityId} ${write.recordId}`);
      return { ...write, ...(Object.keys(versions).length > 0 ? { targetVersions: versions } : {}) };
    });
    for (const key of madeHere) madeBefore.add(key);
    batches.push(batch);
  }
  return batches;
}

// ---------------------------------------------------------------- saving

/**
 * The records as archi-online's model, ready to serialize: each object under its Archi ID (the
 * one it came with, or its record ID without the `ar-` the workbench gives new objects), the
 * model's Dublin Core metadata from its fields, in Archi's order.
 */
export function modelForExport(sets: RecordSets): ModelState {
  const mirror = buildMirror(sets);
  const all = Object.values(sets).flatMap(list => list ?? []);
  const ids = new Map<string, string>();
  for (const record of all) {
    const archiId = record.values[`${record.entityId}.archiId`];
    ids.set(record.recordId, typeof archiId === 'string' && archiId !== '' ? archiId : record.recordId.startsWith('ar-') ? record.recordId.slice(3) : record.recordId);
  }
  const id = (value: string) => ids.get(value) ?? value;
  const ids_ = (list: string[] | undefined) => (list ?? []).map(id);
  const rekey = <T extends { id: string }>(map: Record<string, T>, change: (item: T) => T) =>
    Object.fromEntries(Object.values(map).map(item => { const next = change({ ...item, id: id(item.id) }); return [next.id, next]; }));

  const modelRecord = all.find(record => record.entityId === 'ar.model');
  const metadata = DUBLIN_CORE_FIELDS.filter(name => present(modelRecord?.values[`ar.model.dc${titled(name)}`]))
    .map(name => ({ name, value: String(modelRecord!.values[`ar.model.dc${titled(name)}`]) }));
  const anyOf = (value: unknown) => value as Record<string, unknown>;
  return {
    ...mirror,
    info: { ...mirror.info, id: id(mirror.info.id), metadata },
    profiles: rekey(mirror.profiles, profile => profile),
    assets: {},
    folders: rekey(mirror.folders, folder => ({ ...folder, parentId: folder.parentId === null ? null : id(folder.parentId),
      folderIds: ids_(folder.folderIds), itemIds: ids_(folder.itemIds) })),
    rootFolderIds: ids_(mirror.rootFolderIds),
    elements: rekey(mirror.elements, element => ({ ...element, folderId: id(element.folderId), profileIds: ids_(element.profileIds) })),
    relationships: rekey(mirror.relationships, relationship => ({ ...relationship, folderId: id(relationship.folderId),
      profileIds: ids_(relationship.profileIds), sourceId: id(relationship.sourceId), targetId: id(relationship.targetId) })),
    views: rekey(mirror.views, view => ({ ...view, folderId: id(view.folderId), childIds: ids_(view.childIds) })),
    nodes: rekey(mirror.nodes, node => {
      const next = anyOf({ ...node, viewId: id(node.viewId), parentId: id(node.parentId), childIds: ids_(node.childIds),
        sourceConnectionIds: ids_(node.sourceConnectionIds), targetConnectionIds: ids_(node.targetConnectionIds) });
      if (typeof next.elementId === 'string') next.elementId = id(next.elementId);
      if (typeof next.refViewId === 'string') next.refViewId = id(next.refViewId);
      return next as unknown as typeof node;
    }),
    connections: rekey(mirror.connections, connection => {
      const next = anyOf({ ...connection, viewId: id(connection.viewId), sourceId: id(connection.sourceId), targetId: id(connection.targetId),
        sourceConnectionIds: ids_(connection.sourceConnectionIds), targetConnectionIds: ids_(connection.targetConnectionIds) });
      if (typeof next.relationshipId === 'string') next.relationshipId = id(next.relationshipId);
      return next as unknown as typeof connection;
    }),
  };
}

/** The records as an .archimate file Archi opens: plain XML, and the name to save it under. */
export function exportArchimate(sets: RecordSets): { xml: string; fileName: string } {
  const model = modelForExport(sets);
  const xml = serializeArchimate(model);
  const base = (model.info.name || 'Model').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'Model';
  return { xml, fileName: `${base}.archimate` };
}

/** Parse, for a test or a tool that holds XML text rather than a file's bytes. */
export function parseArchimateText(xml: string): ModelState {
  return parseArchimate(xml);
}
