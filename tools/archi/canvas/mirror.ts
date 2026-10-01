// Archi.nendo's records as archi-online's ModelState: the mirror the Archi workbench draws from,
// and later edits through (docs/design/archi-in-nendo.md). The inverse of
// tools/archi/archimate-records.mjs: every id in the mirror is the record's ID, so a change the
// mirror makes names the record it changes.

import type {
  ArchimateElement, ArchimateRelationship, DiagramConnection, DiagramNode, DiagramView, Folder, FolderType, ModelState,
} from '@archi/model/types';
import type { ElementType, RelationshipType } from '@archi/model/metamodel';
import { parseFontStyle } from '@archi/model/font-style';
import { rebuildConnectionAdjacency } from '@archi/model/ops/draft';

export interface NendoRecord { entityId: string; recordId: string; version: number; values: Record<string, unknown> }
export type RecordSets = Record<string, NendoRecord[] | undefined>;

const FOLDER_TYPE: Record<string, FolderType> = {
  Strategy: 'strategy', Business: 'business', Application: 'application', 'Technology & Physical': 'technology',
  Motivation: 'motivation', 'Implementation & Migration': 'implementation_migration', Other: 'other', Relations: 'relations', Views: 'diagrams',
};
const ACCESS: Record<string, number> = { Write: 0, Read: 1, Access: 2, 'Read and write': 3 };
const NODE_TYPE: Record<string, DiagramNode['nodeType']> = { Element: 'element', Group: 'group', Note: 'note', 'View reference': 'ref' };

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const optional = <T,>(value: unknown): T | undefined => (value === null || value === undefined ? undefined : (value as T));
/** By an order field alone, stably: records with the same order, or none, stay as they came. */
const inOrder = (field: string) => (a: NendoRecord, b: NendoRecord) =>
  ((a.values[field] as number | null) ?? Number.MAX_SAFE_INTEGER) - ((b.values[field] as number | null) ?? Number.MAX_SAFE_INTEGER);
const byOrder = (field: string) => (a: NendoRecord, b: NendoRecord) =>
  ((a.values[field] as number | null) ?? Number.MAX_SAFE_INTEGER) - ((b.values[field] as number | null) ?? Number.MAX_SAFE_INTEGER)
  || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);

export function buildMirror(sets: RecordSets): ModelState {
  const all = Object.values(sets).flatMap(list => list ?? []);
  const of = (entityId: string) => all.filter(record => record.entityId === entityId);
  const typeKey = new Map(of('ar.type').map(record => [record.recordId, text(record.values['ar.type.key'])]));
  const propertiesOf = new Map<string, { key: string; value: string }[]>();
  for (const property of of('ar.property').sort(byOrder('ar.property.order'))) {
    for (const field of ['concept', 'view', 'folder', 'item', 'model']) {
      const owner = property.values[`ar.property.${field}`];
      if (typeof owner !== 'string') continue;
      if (!propertiesOf.has(owner)) propertiesOf.set(owner, []);
      propertiesOf.get(owner)!.push({ key: text(property.values['ar.property.key']), value: text(property.values['ar.property.value']) });
    }
  }
  const props = (id: string) => propertiesOf.get(id) ?? [];

  const info = of('ar.model')[0];
  const model: ModelState = {
    info: {
      id: info?.recordId ?? 'model', name: text(info?.values['ar.model.name']), documentation: text(info?.values['ar.model.documentation']),
      properties: info ? props(info.recordId) : [], metadata: [],
      language: optional(info?.values['ar.model.language']), version: optional(info?.values['ar.model.version']),
    },
    profiles: {}, assets: {}, folders: {}, rootFolderIds: [], elements: {}, relationships: {}, views: {}, nodes: {}, connections: {},
  };

  for (const specialization of of('ar.specialization')) {
    model.profiles[specialization.recordId] = { id: specialization.recordId, name: text(specialization.values['ar.specialization.name']),
      conceptType: typeKey.get(text(specialization.values['ar.specialization.type'])) as ElementType, specialization: true };
  }

  const folders = of('ar.folder').sort(byOrder('ar.folder.order'));
  for (const folder of folders) {
    const kind = text(folder.values['ar.folder.kind']);
    const entry: Folder = { id: folder.recordId, kind: 'folder', name: text(folder.values['ar.folder.name']),
      folderType: FOLDER_TYPE[kind], documentation: text(folder.values['ar.folder.documentation']), properties: props(folder.recordId),
      labelExpression: optional(folder.values['ar.folder.labelExpression']),
      parentId: optional<string>(folder.values['ar.folder.parent']) ?? null, folderIds: [], itemIds: [] };
    model.folders[folder.recordId] = entry;
  }
  for (const folder of folders) {
    const entry = model.folders[folder.recordId];
    if (entry.parentId === null) model.rootFolderIds.push(entry.id);
    else model.folders[entry.parentId]?.folderIds.push(entry.id);
    if (entry.parentId !== null) delete entry.folderType;
  }

  // A folder's concepts and views in their order there (W-120); one without an order comes after,
  // as it came: a concept the workbench made has none.
  for (const concept of of('ar.concept').sort(inOrder('ar.concept.order'))) {
    const values = concept.values;
    const base = { id: concept.recordId, name: text(values['ar.concept.name']), documentation: text(values['ar.concept.documentation']),
      properties: props(concept.recordId), profileIds: typeof values['ar.concept.specialization'] === 'string' ? [values['ar.concept.specialization'] as string] : [],
      folderId: text(values['ar.concept.folder']) };
    const type = typeKey.get(text(values['ar.concept.type'])) ?? '';
    if (values['ar.concept.category'] === 'Relationship') {
      const relationship: ArchimateRelationship = { ...base, kind: 'relationship', type: type as RelationshipType,
        sourceId: text(values['ar.concept.source']), targetId: text(values['ar.concept.target']) };
      if (typeof values['ar.concept.access'] === 'string') relationship.accessType = ACCESS[values['ar.concept.access'] as string];
      if (typeof values['ar.concept.strength'] === 'string') relationship.strength = values['ar.concept.strength'] as string;
      if (typeof values['ar.concept.directed'] === 'boolean') relationship.directed = values['ar.concept.directed'] as boolean;
      model.relationships[concept.recordId] = relationship;
    } else {
      const element: ArchimateElement = { ...base, kind: 'element', type: type as ElementType };
      if (values['ar.concept.junction'] === 'Or') element.junctionType = 'or';
      else if (type === 'Junction') element.junctionType = 'and';
      model.elements[concept.recordId] = element;
    }
    model.folders[base.folderId]?.itemIds.push(concept.recordId);
  }

  for (const view of of('ar.view').sort(inOrder('ar.view.order'))) {
    const router = view.values['ar.view.router'];
    const entry: DiagramView = { id: view.recordId, kind: 'view', name: text(view.values['ar.view.name']),
      documentation: text(view.values['ar.view.documentation']), properties: props(view.recordId), folderId: text(view.values['ar.view.folder']),
      viewpoint: optional(view.values['ar.view.viewpoint']), childIds: [],
      ...(router === 'Manhattan' ? { connectionRouterType: 2 as const } : router === 'Manual' ? { connectionRouterType: 0 as const } : {}) };
    model.views[view.recordId] = entry;
    model.folders[entry.folderId]?.itemIds.push(view.recordId);
  }

  const items = of('ar.item').sort(byOrder('ar.item.order'));
  const style = (values: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const name of ['fillColor', 'lineColor', 'fontColor', 'alpha', 'lineAlpha', 'fontAlpha', 'gradient', 'lineStyle', 'lineWidth',
      'iconVisible', 'iconColor', 'derivedLineColor', 'font', 'textAlignment', 'textPosition', 'labelExpression']) {
      const value = values[`ar.item.${name}`];
      if (value !== null && value !== undefined) out[name] = value;
    }
    if (typeof out.font === 'string') out.fontStyle = parseFontStyle(out.font as string);
    return out;
  };
  for (const item of items) {
    const values = item.values;
    const kind = text(values['ar.item.kind']);
    const viewId = text(values['ar.item.view']);
    if (kind === 'Relationship connection' || kind === 'Connection') {
      const connection = { id: item.recordId, viewId, connType: kind === 'Connection' ? 'plain' : 'relationship',
        ...(typeof values['ar.item.concept'] === 'string' ? { relationshipId: values['ar.item.concept'] } : {}),
        name: text(values['ar.item.name']), documentation: text(values['ar.item.documentation']), properties: props(item.recordId),
        sourceId: text(values['ar.item.source']), targetId: text(values['ar.item.target']),
        ...(typeof values['ar.item.connectionType'] === 'number' ? { connectionType: values['ar.item.connectionType'] } : {}),
        ...(typeof values['ar.item.nameVisible'] === 'boolean' ? { nameVisible: values['ar.item.nameVisible'] } : {}),
        bendpoints: typeof values['ar.item.bendpoints'] === 'string' ? JSON.parse(values['ar.item.bendpoints'] as string) : [],
        sourceConnectionIds: [], targetConnectionIds: [], ...style(values) } as unknown as DiagramConnection;
      model.connections[item.recordId] = connection;
      continue;
    }
    const nodeType = NODE_TYPE[kind];
    if (!nodeType) continue;
    const parentId = optional<string>(values['ar.item.parent']) ?? viewId;
    const node = { id: item.recordId, viewId, parentId, nodeType,
      bounds: { x: (values['ar.item.x'] as number) ?? 0, y: (values['ar.item.y'] as number) ?? 0,
        width: (values['ar.item.width'] as number) ?? -1, height: (values['ar.item.height'] as number) ?? -1 },
      childIds: [], sourceConnectionIds: [], targetConnectionIds: [], ...style(values),
      ...(nodeType === 'element' ? { elementId: text(values['ar.item.concept']), ...(typeof values['ar.item.figure'] === 'number' ? { figureType: values['ar.item.figure'] } : {}) } : {}),
      ...(nodeType === 'group' ? { name: text(values['ar.item.name']), documentation: text(values['ar.item.documentation']), properties: props(item.recordId) } : {}),
      ...(nodeType === 'note' ? { content: text(values['ar.item.content']), properties: props(item.recordId),
        ...(typeof values['ar.item.name'] === 'string' ? { name: values['ar.item.name'] } : {}),
        ...(typeof values['ar.item.legend'] === 'string' ? { legendOptions: JSON.parse(values['ar.item.legend'] as string) } : {}) } : {}),
      ...(nodeType === 'ref' ? { refViewId: text(values['ar.item.refView']) } : {}),
      ...(typeof values['ar.item.border'] === 'number' ? { borderType: values['ar.item.border'] } : {}),
    } as unknown as DiagramNode;
    model.nodes[item.recordId] = node;
  }
  for (const item of items) {
    const node = model.nodes[item.recordId];
    if (!node) continue;
    if (node.parentId === node.viewId) model.views[node.viewId]?.childIds.push(node.id);
    else model.nodes[node.parentId]?.childIds.push(node.id);
  }
  rebuildConnectionAdjacency(model);
  return model;
}
