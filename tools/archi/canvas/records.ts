// The mirror's inverse (W-111): archi-online's ModelState as Archi.nendo's record values, and the
// writes that turn the records as stored into a model an archi-online operation has changed.
// Every id in the mirror is its record's ID (mirror.ts), so a changed object names its record.
//
// A field the editor does not own is never written: properties are the workbench's own panel,
// fonts are W-114's. What the mirror leaves out (an image object) is never deleted, because a
// record is deleted only when the model before the change held it and the model after does not.

import type { DiagramConnection, DiagramNode, ModelState } from '@archi/model/types';
import type { NendoRecord, RecordSets } from './mirror';

export type Values = Record<string, unknown>;
export interface Planned { entityId: string; values: Values }
export interface Write {
  op: 'create' | 'update' | 'delete';
  entityId: string;
  recordId: string;
  version?: number;
  values?: Values;
  targetVersions?: Record<string, number>;
}

const FOLDER_KIND = ['ar.folder.name', 'ar.folder.documentation', 'ar.folder.labelExpression', 'ar.folder.parent', 'ar.folder.order'];
const STYLE = ['fillColor', 'lineColor', 'fontColor', 'alpha', 'lineAlpha', 'fontAlpha', 'gradient', 'lineStyle', 'lineWidth',
  'iconVisible', 'iconColor', 'derivedLineColor', 'font', 'textAlignment', 'textPosition', 'labelExpression'];

/** The fields each record type's editor writes. Anything else on a record is left as it is. */
export const OWNED: Record<string, string[]> = {
  'ar.folder': FOLDER_KIND,
  'ar.concept': ['name', 'type', 'category', 'documentation', 'folder', 'source', 'target', 'access', 'strength', 'directed',
    'junction', 'specialization'].map(name => `ar.concept.${name}`),
  'ar.view': ['name', 'documentation', 'folder', 'viewpoint', 'router'].map(name => `ar.view.${name}`),
  'ar.item': ['view', 'kind', 'concept', 'refView', 'parent', 'order', 'x', 'y', 'width', 'height', 'name', 'documentation',
    'content', 'figure', 'border', 'legend', 'source', 'target', 'bendpoints', 'connectionType', 'nameVisible', ...STYLE]
    .map(name => `ar.item.${name}`),
};

/** The fields that point at another record: a write names the target's version as it read it. */
const REFERENCES = new Set(['ar.folder.parent', 'ar.concept.type', 'ar.concept.folder', 'ar.concept.source', 'ar.concept.target',
  'ar.concept.specialization', 'ar.view.folder', 'ar.item.view', 'ar.item.concept', 'ar.item.refView', 'ar.item.parent',
  'ar.item.source', 'ar.item.target']);

const ACCESS = ['Write', 'Read', 'Access', 'Read and write'];
const NODE_KIND: Record<string, string> = { element: 'Element', group: 'Group', note: 'Note', ref: 'View reference' };

/** An empty value is no value, as the importer stores it: the mirror reads a missing text as ''. */
const empty = (value: unknown) => value === undefined || value === null || value === '';
const plain = (value: unknown) => (empty(value) ? null : value);

/** A sibling list's orders: kept where they still ascend, fitted between neighbours where not. */
function orders(ids: string[], stored: Map<string, NendoRecord>, field: string): Map<string, number> {
  const current = ids.map(id => stored.get(id)?.values[field]);
  const result = new Map<string, number>();
  const kept = new Array<boolean>(ids.length).fill(false);
  let last = -Infinity;
  current.forEach((value, index) => {
    if (typeof value === 'number' && value > last) { kept[index] = true; last = value; }
  });
  let previous = 0;
  for (let index = 0; index < ids.length; index++) {
    if (kept[index]) { previous = current[index] as number; result.set(ids[index], previous); continue; }
    let next = index + 1;
    while (next < ids.length && !kept[next]) next++;
    const ceiling = next < ids.length ? (current[next] as number) : previous + 1024 * (next - index + 1);
    const step = Math.floor((ceiling - previous) / (next - index + 1));
    if (step < 1) return new Map(ids.map((id, at) => [id, (at + 1) * 1024]));
    previous += step;
    result.set(ids[index], previous);
  }
  return result;
}

/** The model as record values, field by owned field; a missing value is null. */
export function toRecords(model: ModelState, stored: Map<string, NendoRecord> = new Map()): Map<string, Planned> {
  const out = new Map<string, Planned>();
  const typeId = (type: string) => `ar.type.r.${type}`;
  const put = (entityId: string, id: string, values: Values) => {
    const full: Values = {};
    for (const field of OWNED[entityId]) full[field] = plain(values[field]);
    out.set(id, { entityId, values: full });
  };

  for (const folder of Object.values(model.folders)) {
    if (folder.parentId === null) continue; // the nine top-level folders are the file's frame
    const siblings = model.folders[folder.parentId]?.folderIds ?? [];
    put('ar.folder', folder.id, { 'ar.folder.name': folder.name, 'ar.folder.documentation': folder.documentation,
      'ar.folder.labelExpression': folder.labelExpression, 'ar.folder.parent': folder.parentId,
      'ar.folder.order': orders(siblings, stored, 'ar.folder.order').get(folder.id) });
  }

  const concept = (item: { id: string; name: string; documentation: string; folderId: string; profileIds?: string[]; type: string }) => ({
    'ar.concept.name': item.name, 'ar.concept.documentation': item.documentation, 'ar.concept.folder': item.folderId,
    'ar.concept.type': typeId(item.type), 'ar.concept.specialization': item.profileIds?.[0],
  });
  for (const element of Object.values(model.elements)) {
    put('ar.concept', element.id, { ...concept(element), 'ar.concept.category': 'Element',
      'ar.concept.junction': element.junctionType === 'or' ? 'Or' : element.type === 'Junction' ? 'And' : null });
  }
  for (const relationship of Object.values(model.relationships)) {
    put('ar.concept', relationship.id, { ...concept(relationship), 'ar.concept.category': 'Relationship',
      'ar.concept.source': relationship.sourceId, 'ar.concept.target': relationship.targetId,
      'ar.concept.access': relationship.accessType === undefined ? null : ACCESS[relationship.accessType],
      'ar.concept.strength': relationship.strength, 'ar.concept.directed': relationship.directed });
  }

  for (const view of Object.values(model.views)) {
    const router = view.connectionRouterType === 2 ? 'Manhattan' : view.connectionRouterType === 0 ? 'Manual' : null;
    put('ar.view', view.id, { 'ar.view.name': view.name, 'ar.view.documentation': view.documentation, 'ar.view.folder': view.folderId,
      'ar.view.viewpoint': view.viewpoint, 'ar.view.router': router });
  }

  const style = (item: Record<string, unknown>) => Object.fromEntries(STYLE.map(name => [`ar.item.${name}`, item[name]]));
  const siblingOrders = new Map<string, Map<string, number>>();
  const orderOf = (node: DiagramNode) => {
    const parent = node.parentId;
    if (!siblingOrders.has(parent)) {
      const list = parent === node.viewId ? model.views[parent]?.childIds ?? [] : model.nodes[parent]?.childIds ?? [];
      siblingOrders.set(parent, orders(list, stored, 'ar.item.order'));
    }
    return siblingOrders.get(parent)!.get(node.id);
  };
  for (const node of Object.values(model.nodes) as (DiagramNode & Record<string, unknown>)[]) {
    const kind = NODE_KIND[node.nodeType];
    if (!kind) continue; // an image: the mirror has none, so neither has this
    put('ar.item', node.id, { ...style(node), 'ar.item.view': node.viewId, 'ar.item.kind': kind,
      'ar.item.concept': node.elementId, 'ar.item.refView': node.refViewId,
      'ar.item.parent': node.parentId === node.viewId ? null : node.parentId, 'ar.item.order': orderOf(node),
      'ar.item.x': node.bounds.x, 'ar.item.y': node.bounds.y, 'ar.item.width': node.bounds.width, 'ar.item.height': node.bounds.height,
      'ar.item.name': node.name, 'ar.item.documentation': node.documentation, 'ar.item.content': node.content,
      'ar.item.figure': node.figureType, 'ar.item.border': node.borderType,
      'ar.item.legend': node.legendOptions ? JSON.stringify(node.legendOptions) : null });
  }
  for (const connection of Object.values(model.connections) as (DiagramConnection & Record<string, unknown>)[]) {
    put('ar.item', connection.id, { ...style(connection), 'ar.item.view': connection.viewId,
      'ar.item.kind': connection.connType === 'relationship' ? 'Relationship connection' : 'Connection',
      'ar.item.concept': connection.relationshipId, 'ar.item.source': connection.sourceId, 'ar.item.target': connection.targetId,
      'ar.item.bendpoints': connection.bendpoints.length > 0 ? JSON.stringify(connection.bendpoints) : null,
      'ar.item.name': connection.name, 'ar.item.documentation': connection.documentation,
      'ar.item.connectionType': connection.connectionType, 'ar.item.nameVisible': connection.nameVisible });
  }
  return out;
}

/** Two stored values the same, a JSON text compared as what it holds. */
function same(field: string, stored: unknown, planned: unknown): boolean {
  if (empty(stored) && empty(planned)) return true;
  if (field.endsWith('.bendpoints') || field.endsWith('.legend')) {
    try { return JSON.stringify(JSON.parse(String(stored))) === JSON.stringify(JSON.parse(String(planned))); } catch { return false; }
  }
  return stored === planned;
}

/** A record's ID made from archi-online's: every id this editor makes is already `ar-id-…`. */
const archiIdOf = (recordId: string) => (recordId.startsWith('ar-') ? recordId.slice(3) : recordId);

/**
 * The writes that take the records as stored to the model `after`, where `before` is the model
 * the change was made on: one gesture, or every edit collected since the last commit. Creates come first, each after what it points at; then updates; then
 * deletes, each before what it points at, with the properties of what goes.
 */
export function writesFor(sets: RecordSets, before: ModelState, after: ModelState): Write[] {
  const stored = new Map<string, NendoRecord>();
  for (const list of Object.values(sets)) for (const record of list ?? []) stored.set(record.recordId, record);
  const was = toRecords(before, stored);
  const now = toRecords(after, stored);
  const targetVersions = (values: Values, created: Set<string>) => {
    const versions: Record<string, number> = {};
    for (const [field, value] of Object.entries(values)) {
      if (!REFERENCES.has(field) || typeof value !== 'string' || created.has(value)) continue;
      const target = stored.get(value);
      if (target) versions[field] = target.version;
    }
    return Object.keys(versions).length > 0 ? versions : undefined;
  };

  const created = new Set([...now.keys()].filter(id => !was.has(id) && !stored.has(id)));
  const creates: Write[] = [];
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (!created.has(id) || creates.some(write => write.recordId === id) || visiting.has(id)) return;
    visiting.add(id);
    const planned = now.get(id)!;
    for (const [field, value] of Object.entries(planned.values)) if (REFERENCES.has(field) && typeof value === 'string') visit(value);
    const values = Object.fromEntries(Object.entries(planned.values).filter(([, value]) => value !== null));
    values[`${planned.entityId}.archiId`] = archiIdOf(id);
    const versions = targetVersions(values, created);
    creates.push({ op: 'create', entityId: planned.entityId, recordId: id, values, ...(versions ? { targetVersions: versions } : {}) });
  };
  for (const id of created) visit(id);

  const updates: Write[] = [];
  for (const [id, planned] of now) {
    const record = stored.get(id);
    if (!record || !was.has(id)) continue;
    // Only what the change itself changed: a field someone else set since `before` was read keeps
    // their value, however long the edits waited to be committed.
    const values: Values = {};
    const base = was.get(id)!.values;
    for (const [field, value] of Object.entries(planned.values)) {
      if (!same(field, base[field], value) && !same(field, record.values[field], value)) values[field] = value;
    }
    if (Object.keys(values).length === 0) continue;
    const versions = targetVersions(values, created);
    updates.push({ op: 'update', entityId: planned.entityId, recordId: id, version: record.version, values,
      ...(versions ? { targetVersions: versions } : {}) });
  }

  const doomed = new Set([...was.keys()].filter(id => !now.has(id) && stored.has(id)));
  for (const record of stored.values()) {
    if (record.entityId !== 'ar.property') continue;
    for (const field of ['concept', 'view', 'folder', 'item']) {
      if (doomed.has(record.values[`ar.property.${field}`] as string)) doomed.add(record.recordId);
    }
  }
  const deletes: Write[] = [];
  const removing = new Set<string>();
  const referrers = new Map<string, string[]>();
  for (const id of doomed) {
    for (const [field, value] of Object.entries(stored.get(id)!.values)) {
      if ((REFERENCES.has(field) || field.startsWith('ar.property.')) && typeof value === 'string' && doomed.has(value)) {
        if (!referrers.has(value)) referrers.set(value, []);
        referrers.get(value)!.push(id);
      }
    }
  }
  const remove = (id: string) => {
    if (removing.has(id)) return;
    removing.add(id);
    for (const referrer of referrers.get(id) ?? []) remove(referrer);
    const record = stored.get(id)!;
    deletes.push({ op: 'delete', entityId: record.entityId, recordId: id, version: record.version });
  };
  for (const id of doomed) remove(id);
  return [...creates, ...updates, ...deletes];
}

/**
 * The records as they would stand after `writes`, in memory: how edits still waiting are carried
 * onto a file that changed under them, and back after the workbench started again.
 */
export function applyWrites(sets: RecordSets, writes: Write[]): RecordSets {
  const out: RecordSets = {};
  for (const [key, list] of Object.entries(sets)) out[key] = (list ?? []).map(record => ({ ...record, values: { ...record.values } }));
  const listOf = (entityId: string) => Object.values(out).find(list => list?.some(record => record.entityId === entityId))
    ?? (out[entityId] ??= []);
  for (const write of writes) {
    const list = listOf(write.entityId)!;
    const at = list.findIndex(record => record.recordId === write.recordId);
    if (write.op === 'create' && at < 0) list.push({ entityId: write.entityId, recordId: write.recordId, version: 0, values: { ...write.values } });
    else if (write.op === 'update' && at >= 0) Object.assign(list[at].values, write.values);
    else if (write.op === 'delete' && at >= 0) list.splice(at, 1);
  }
  return out;
}
