// The Archi workbench's model: Archi.nendo's records read into the tree Archi shows, the rules
// that say where a concept may live, and every change the workbench makes, planned as record
// writes. No DOM and no window.nendo, so the rules are tested in Node (tools/archi/model.test.mjs)
// and the view only draws and sends what this plans.
//
// A write is { op: 'create' | 'update' | 'delete', entityId, recordId, version?, values?,
// targetVersions? }: one entry of nendo.records.batch, or one single write where a Nendo has no
// batch. docs/design/archi-in-nendo.md says why the record types are what they are.

export const E = Object.freeze({
  model: 'ar.model', folder: 'ar.folder', type: 'ar.type', concept: 'ar.concept', specialization: 'ar.specialization',
  view: 'ar.view', item: 'ar.item', property: 'ar.property',
});

/** The top-level folder a concept of each layer lives under, as Archi keeps them. */
export const HOME_OF_LAYER = Object.freeze({
  Strategy: 'Strategy', Business: 'Business', Application: 'Application', Technology: 'Technology & Physical',
  Physical: 'Technology & Physical', Motivation: 'Motivation', 'Implementation & Migration': 'Implementation & Migration',
  Other: 'Other', Relationship: 'Relations',
});

export const LAYERS = Object.freeze(['Strategy', 'Business', 'Application', 'Technology', 'Physical', 'Motivation',
  'Implementation & Migration', 'Other', 'Relationship']);

// Every reference field, by record type: what a delete must clear before the record it points at.
const REFERENCES = Object.freeze({
  [E.folder]: ['ar.folder.parent'],
  [E.specialization]: ['ar.specialization.type'],
  [E.concept]: ['ar.concept.type', 'ar.concept.folder', 'ar.concept.source', 'ar.concept.target', 'ar.concept.specialization'],
  [E.view]: ['ar.view.folder'],
  [E.item]: ['ar.item.view', 'ar.item.concept', 'ar.item.refView', 'ar.item.parent', 'ar.item.source', 'ar.item.target'],
  [E.property]: ['ar.property.concept', 'ar.property.view', 'ar.property.folder', 'ar.property.item', 'ar.property.model'],
  [E.model]: [], [E.type]: [],
});

const OWNER_FIELD = Object.freeze({
  [E.concept]: 'ar.property.concept', [E.view]: 'ar.property.view', [E.folder]: 'ar.property.folder',
  [E.item]: 'ar.property.item', [E.model]: 'ar.property.model',
});

const byName = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const order = record => record.values['ar.folder.order'] ?? Number.MAX_SAFE_INTEGER;

/** An Archi identifier, as Archi 4 and later make them: id- and 32 hex digits. */
export function newArchiId() {
  return `id-${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * The records of Archi.nendo, read into one model. `sets` holds the records of each type as
 * window.nendo reads them: { entityId, recordId, version, values }.
 */
export function buildModel(sets) {
  const records = new Map();
  for (const list of Object.values(sets)) for (const record of list ?? []) records.set(record.recordId, record);
  const of = entityId => [...records.values()].filter(record => record.entityId === entityId);
  const types = new Map(of(E.type).map(record => [record.recordId, record]));
  const children = new Map();
  const bucket = id => {
    if (!children.has(id)) children.set(id, { folders: [], concepts: [], views: [] });
    return children.get(id);
  };
  const roots = [];
  for (const folder of of(E.folder)) {
    const parent = folder.values['ar.folder.parent'];
    if (parent) bucket(parent).folders.push(folder.recordId); else roots.push(folder.recordId);
  }
  for (const concept of of(E.concept)) {
    const folder = concept.values['ar.concept.folder'];
    if (folder) bucket(folder).concepts.push(concept.recordId);
  }
  for (const view of of(E.view)) {
    const folder = view.values['ar.view.folder'];
    if (folder) bucket(folder).views.push(view.recordId);
  }
  const propertiesOf = new Map();
  for (const property of of(E.property)) {
    for (const [entityId, fieldId] of Object.entries(OWNER_FIELD)) {
      const owner = property.values[fieldId];
      if (!owner) continue;
      if (!propertiesOf.has(owner)) propertiesOf.set(owner, []);
      propertiesOf.get(owner).push(property);
      void entityId;
    }
  }
  for (const list of propertiesOf.values()) list.sort((a, b) => (a.values['ar.property.order'] ?? 0) - (b.values['ar.property.order'] ?? 0));
  const model = { records, types, children, roots, propertiesOf, of };
  model.roots.sort((a, b) => order(records.get(a)) - order(records.get(b)));
  return model;
}

export const typeOf = (model, concept) => model.types.get(concept?.values['ar.concept.type']) ?? null;

/** What the tree calls a record: its name, or for an unnamed relationship its type and ends. */
export function label(model, record, path = new Set()) {
  if (!record) return '';
  switch (record.entityId) {
    case E.folder: return record.values['ar.folder.name'] || '(folder)';
    case E.view: return record.values['ar.view.name'] || '(view)';
    case E.concept: {
      const name = record.values['ar.concept.name'];
      const type = typeOf(model, record);
      if (record.values['ar.concept.category'] !== 'Relationship') return name || type?.values['ar.type.name'] || '(element)';
      const short = name || type?.values['ar.type.name'] || 'Relationship';
      if (path.has(record.recordId)) return `${short} [cycle]`;
      path.add(record.recordId);
      try {
        const end = id => { const other = model.records.get(id); return other ? label(model, other, path) : '?'; };
        const ends = `${end(record.values['ar.concept.source'])} – ${end(record.values['ar.concept.target'])}`;
        return `${short} (${ends})`;
      } finally { path.delete(record.recordId); }
    }
    default: return record.recordId;
  }
}

/** The top-level folder a folder sits under, or itself. */
export function rootOf(model, folderId) {
  let folder = model.records.get(folderId);
  for (let steps = 0; folder && folder.values['ar.folder.parent'] && steps < 64; steps++) folder = model.records.get(folder.values['ar.folder.parent']);
  return folder ?? null;
}

/** The kind of top-level folder a record belongs under: its layer's for a concept, Views for a view. */
export function homeKind(model, record) {
  if (record.entityId === E.view) return 'Views';
  if (record.entityId === E.concept) return HOME_OF_LAYER[typeOf(model, record)?.values['ar.type.layer']] ?? 'Other';
  if (record.entityId === E.folder) return rootOf(model, record.recordId)?.values['ar.folder.kind'] ?? null;
  return null;
}

export function rootFolderOfKind(model, kind) {
  return model.roots.map(id => model.records.get(id)).find(folder => folder.values['ar.folder.kind'] === kind) ?? null;
}

const isUnder = (model, folderId, ancestorId) => {
  for (let at = model.records.get(folderId), steps = 0; at && steps < 64; at = model.records.get(at.values['ar.folder.parent']), steps++) {
    if (at.recordId === ancestorId) return true;
  }
  return false;
};

/** Why a record cannot go into a folder, or null when it can: Archi keeps each layer in its own tree. */
export function whyNotMove(model, recordId, folderId) {
  const record = model.records.get(recordId), folder = model.records.get(folderId);
  if (!record || !folder || folder.entityId !== E.folder) return 'That is not a folder.';
  if (record.entityId === E.folder) {
    if (!record.values['ar.folder.parent']) return 'A top-level folder stays where it is.';
    if (isUnder(model, folderId, recordId)) return 'A folder cannot go inside itself.';
    if (record.values['ar.folder.parent'] === folderId) return 'It is already there.';
  } else if (record.values[record.entityId === E.view ? 'ar.view.folder' : 'ar.concept.folder'] === folderId) return 'It is already there.';
  const home = homeKind(model, record), there = rootOf(model, folderId)?.values['ar.folder.kind'];
  if (home !== there) return `${label(model, record)} belongs under ${home}, not ${there}.`;
  return null;
}

const folderField = entityId => entityId === E.view ? 'ar.view.folder' : entityId === E.folder ? 'ar.folder.parent' : 'ar.concept.folder';

export function moveWrite(model, recordId, folderId) {
  const reason = whyNotMove(model, recordId, folderId);
  if (reason) throw new Error(reason);
  const record = model.records.get(recordId), folder = model.records.get(folderId);
  const fieldId = folderField(record.entityId);
  return { op: 'update', entityId: record.entityId, recordId, version: record.version, values: { [fieldId]: folderId },
    targetVersions: { [fieldId]: folder.version } };
}

export function renameWrite(model, recordId, name) {
  const record = model.records.get(recordId);
  const fieldId = { [E.folder]: 'ar.folder.name', [E.view]: 'ar.view.name', [E.concept]: 'ar.concept.name', [E.model]: 'ar.model.name' }[record.entityId];
  return { op: 'update', entityId: record.entityId, recordId, version: record.version, values: { [fieldId]: name } };
}

/** One field of one record, with the target's version when the field is a reference. */
export function fieldWrite(model, recordId, fieldId, value) {
  const record = model.records.get(recordId);
  const write = { op: 'update', entityId: record.entityId, recordId, version: record.version, values: { [fieldId]: value } };
  if ((REFERENCES[record.entityId] ?? []).includes(fieldId) && value) {
    const target = model.records.get(value);
    if (!target) throw new Error(`${value} is not in this model.`);
    write.targetVersions = { [fieldId]: target.version };
  }
  return write;
}

/**
 * A concept's new type, as Archi's Set Concept Type changes it: within its category, and into
 * the new layer's top-level folder when the type belongs to another layer than its folder.
 */
export function typeWrite(model, conceptId, typeId) {
  const concept = model.records.get(conceptId), type = model.types.get(typeId);
  if (!type || type.values['ar.type.category'] !== concept.values['ar.concept.category'])
    throw new Error('A concept keeps its category: an element stays an element, a relationship a relationship.');
  const write = { op: 'update', entityId: E.concept, recordId: conceptId, version: concept.version,
    values: { 'ar.concept.type': typeId }, targetVersions: { 'ar.concept.type': type.version } };
  const home = HOME_OF_LAYER[type.values['ar.type.layer']];
  if (rootOf(model, concept.values['ar.concept.folder'])?.values['ar.folder.kind'] !== home) {
    const folder = rootFolderOfKind(model, home);
    write.values['ar.concept.folder'] = folder.recordId;
    write.targetVersions['ar.concept.folder'] = folder.version;
  }
  return write;
}

/** Where a new record goes when the person picked no folder: the one selected, if it fits. */
function folderFor(model, kind, selectedFolderId) {
  const selected = selectedFolderId ? model.records.get(selectedFolderId) : null;
  if (selected?.entityId === E.folder && rootOf(model, selected.recordId)?.values['ar.folder.kind'] === kind) return selected;
  return rootFolderOfKind(model, kind);
}

export function createElement(model, typeKey, selectedFolderId, name) {
  const type = [...model.types.values()].find(candidate => candidate.values['ar.type.key'] === typeKey);
  if (!type || type.values['ar.type.category'] !== 'Element') throw new Error(`${typeKey} is not an element type.`);
  const folder = folderFor(model, HOME_OF_LAYER[type.values['ar.type.layer']], selectedFolderId);
  const archiId = newArchiId();
  return { op: 'create', entityId: E.concept, recordId: `ar-${archiId}`, values: {
    'ar.concept.name': name ?? type.values['ar.type.name'], 'ar.concept.type': type.recordId, 'ar.concept.category': 'Element',
    'ar.concept.folder': folder.recordId, 'ar.concept.archiId': archiId,
    ...(typeKey === 'Junction' ? { 'ar.concept.junction': 'And' } : {}),
  }, targetVersions: { 'ar.concept.type': type.version, 'ar.concept.folder': folder.version } };
}

export function createView(model, selectedFolderId, name = 'New view') {
  const folder = folderFor(model, 'Views', selectedFolderId);
  const archiId = newArchiId();
  return { op: 'create', entityId: E.view, recordId: `ar-${archiId}`, values: {
    'ar.view.name': name, 'ar.view.folder': folder.recordId, 'ar.view.archiId': archiId,
  }, targetVersions: { 'ar.view.folder': folder.version } };
}

export function createFolder(model, parentFolderId, name = 'New folder') {
  const parent = model.records.get(parentFolderId);
  if (parent?.entityId !== E.folder) throw new Error('A new folder goes inside a folder.');
  const archiId = newArchiId();
  const siblings = model.children.get(parentFolderId)?.folders ?? [];
  const last = Math.max(0, ...siblings.map(id => model.records.get(id).values['ar.folder.order'] ?? 0));
  return { op: 'create', entityId: E.folder, recordId: `ar-${archiId}`, values: {
    'ar.folder.name': name, 'ar.folder.parent': parentFolderId, 'ar.folder.order': last + 1024, 'ar.folder.archiId': archiId,
  }, targetVersions: { 'ar.folder.parent': parent.version } };
}

/**
 * Everything a delete takes with it, as Archi deletes: a folder its contents, a concept its
 * relationships and every diagram object that shows it, a view its diagram objects and every
 * reference to it, a diagram object what is nested in it and every line that ends on it, and
 * each record's properties. The writes are ordered so nothing is deleted while a record still
 * points at it. A top-level folder cannot be deleted.
 */
export function deletePlan(model, recordIds) {
  const doomed = new Set();
  const queue = [...recordIds];
  const all = [...model.records.values()];
  const pointingAt = new Map();
  for (const record of all) {
    for (const fieldId of REFERENCES[record.entityId] ?? []) {
      const target = record.values[fieldId];
      if (!target) continue;
      if (!pointingAt.has(target)) pointingAt.set(target, []);
      pointingAt.get(target).push({ record, fieldId });
    }
  }
  while (queue.length > 0) {
    const id = queue.pop();
    const record = model.records.get(id);
    if (!record || doomed.has(id)) continue;
    if (record.entityId === E.folder && !record.values['ar.folder.parent']) throw new Error(`${label(model, record)} is a top-level folder and stays.`);
    if (record.entityId === E.type || record.entityId === E.model) throw new Error(`${label(model, record)} is part of the model's frame and stays.`);
    doomed.add(id);
    // Everything that points at a doomed record goes with it, except a concept's type and a
    // specialization, which outlive the concepts of that type.
    for (const { record: referrer } of pointingAt.get(id) ?? []) {
      if (referrer.entityId === E.specialization) continue;
      queue.push(referrer.recordId);
    }
  }
  // Each record after everything doomed that points at it.
  const ordered = [];
  const placed = new Set();
  const visit = (id, trail) => {
    if (placed.has(id)) return;
    if (trail.has(id)) throw new Error(`${id} is part of a loop of references.`);
    trail.add(id);
    for (const { record: referrer } of pointingAt.get(id) ?? []) if (doomed.has(referrer.recordId)) visit(referrer.recordId, trail);
    trail.delete(id);
    placed.add(id);
    ordered.push(id);
  };
  for (const id of doomed) visit(id, new Set());
  const writes = ordered.map(id => {
    const record = model.records.get(id);
    return { op: 'delete', entityId: record.entityId, recordId: id, version: record.version };
  });
  const count = entityId => writes.filter(write => write.entityId === entityId).length;
  const concepts = writes.filter(write => write.entityId === E.concept).map(write => model.records.get(write.recordId));
  return {
    writes,
    summary: {
      folders: count(E.folder), views: count(E.view), items: count(E.item), properties: count(E.property),
      elements: concepts.filter(record => record.values['ar.concept.category'] === 'Element').length,
      relationships: concepts.filter(record => record.values['ar.concept.category'] === 'Relationship').length,
    },
  };
}

/**
 * The writes that make a record's properties the rows given, in their order: a row with a
 * recordId is an existing property, kept or changed; one without is new; a property no row
 * names is deleted.
 */
export function propertyWrites(model, ownerId, rows) {
  const owner = model.records.get(ownerId);
  const ownerField = OWNER_FIELD[owner.entityId];
  const existing = model.propertiesOf.get(ownerId) ?? [];
  const kept = new Set(rows.filter(row => row.recordId).map(row => row.recordId));
  const writes = existing.filter(property => !kept.has(property.recordId))
    .map(property => ({ op: 'delete', entityId: E.property, recordId: property.recordId, version: property.version }));
  rows.forEach((row, index) => {
    const values = { 'ar.property.key': row.key, 'ar.property.value': row.value ?? '', 'ar.property.order': (index + 1) * 1024 };
    const current = row.recordId ? model.records.get(row.recordId) : null;
    if (!current) {
      writes.push({ op: 'create', entityId: E.property, recordId: `ar-${newArchiId()}`,
        values: { ...values, [ownerField]: ownerId }, targetVersions: { [ownerField]: owner.version } });
      return;
    }
    const changed = Object.fromEntries(Object.entries(values).filter(([fieldId, value]) => current.values[fieldId] !== value));
    if (Object.keys(changed).length > 0) writes.push({ op: 'update', entityId: E.property, recordId: current.recordId, version: current.version, values: changed });
  });
  return writes;
}

/** Whether a record passes the tree's filter: its label contains the text, and a concept is of the layer. */
export function matches(model, record, filter) {
  if (!filter.text && !filter.layer) return true;
  if (filter.layer) {
    if (record.entityId !== E.concept) return false;
    if (typeOf(model, record)?.values['ar.type.layer'] !== filter.layer) return false;
  }
  return !filter.text || label(model, record).toLocaleLowerCase().includes(filter.text.toLocaleLowerCase());
}

/**
 * The tree's rows, depth first: folders first in their order, then concepts and views by name.
 * A folder shows its contents when it is expanded, or, under a filter, when anything in it
 * matches, and then only what matches and the folders on the way to it.
 */
export function treeRows(model, expanded, filter = {}) {
  const filtering = Boolean(filter.text || filter.layer);
  const rows = [];
  const visible = new Map();
  const shows = id => {
    if (visible.has(id)) return visible.get(id);
    const record = model.records.get(id);
    let result = matches(model, record, filter);
    if (record.entityId === E.folder) {
      const content = model.children.get(id);
      const any = content && [...content.folders, ...content.concepts, ...content.views].some(shows);
      result = filtering ? any || (!filter.layer && result) : true;
    }
    visible.set(id, result);
    return result;
  };
  const walk = (id, depth) => {
    const record = model.records.get(id);
    if (filtering && !shows(id)) return;
    const content = model.children.get(id) ?? { folders: [], concepts: [], views: [] };
    const count = content.folders.length + content.concepts.length + content.views.length;
    const isFolder = record.entityId === E.folder;
    const open = isFolder && (filtering ? count > 0 : expanded.has(id));
    rows.push({ id, entityId: record.entityId, depth, label: label(model, record), children: count, expanded: open,
      layer: record.entityId === E.concept ? typeOf(model, record)?.values['ar.type.layer'] ?? null : null,
      typeName: record.entityId === E.concept ? typeOf(model, record)?.values['ar.type.name'] ?? null : null,
      kind: isFolder ? record.values['ar.folder.kind'] ?? rootOf(model, id)?.values['ar.folder.kind'] ?? null : null });
    if (!open) return;
    const folders = content.folders.map(folderId => model.records.get(folderId))
      .sort((a, b) => order(a) - order(b) || byName({ label: label(model, a), id: a.recordId }, { label: label(model, b), id: b.recordId }));
    for (const folder of folders) walk(folder.recordId, depth + 1);
    const leaves = [...content.concepts, ...content.views].map(leafId => ({ id: leafId, label: label(model, model.records.get(leafId)) })).sort(byName);
    for (const leaf of leaves) walk(leaf.id, depth + 1);
  };
  for (const root of model.roots) walk(root, 0);
  return rows;
}

/** The folders a record could move to, with why each one is refused. */
export function folderChoices(model, recordId) {
  return [...model.records.values()].filter(record => record.entityId === E.folder)
    .map(folder => ({ id: folder.recordId, label: folderPath(model, folder.recordId), reason: whyNotMove(model, recordId, folder.recordId) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function folderPath(model, folderId) {
  const names = [];
  for (let at = model.records.get(folderId), steps = 0; at && steps < 64; at = model.records.get(at.values['ar.folder.parent']), steps++) names.unshift(label(model, at));
  return names.join(' / ');
}

/** The types a concept may be changed to: its own category, as Archi's Set Concept Type offers. */
export function typeChoices(model, concept) {
  const category = concept.values['ar.concept.category'];
  return [...model.types.values()].filter(type => type.values['ar.type.category'] === category)
    .map(type => ({ id: type.recordId, label: type.values['ar.type.name'], layer: type.values['ar.type.layer'] }))
    .sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || a.label.localeCompare(b.label));
}
