// What the fixture broker shows the Archi workbench: Archi.nendo's schema, read from the stages
// tools/Build-Archi.mjs sends, and Archisurance's records (archisurance.json). The review lane
// (tools/Review-ArchiWorkbench.ps1) frames the package over it, so the lane needs no Nendo.

import { readFileSync } from 'node:fs';
import { STAGES } from '../archi-definition.mjs';

const KIND = { Text: 'text', Integer: 'integer', Decimal: 'decimal', Boolean: 'boolean', Date: 'date', Reference: 'reference' };

/** schema.describe's entities, as the host would answer them for the file the stages build. */
export function archiSchema() {
  const entities = new Map();
  const operations = ['model', 'diagrams'].flatMap(name => STAGES[name].mutations().flatMap(mutation => mutation.operations));
  for (const { operationType, payload } of operations) {
    if (operationType === 'schema.createEntity') entities.set(payload.entityId, { entityId: payload.entityId, displayName: payload.displayName, fields: [], hierarchy: null });
    if (operationType === 'schema.addField') {
      entities.get(payload.entityId).fields.push({
        fieldId: payload.fieldId, displayName: payload.displayName, storageKind: KIND[payload.storageKind], required: payload.required,
        presentation: payload.presentation, calculated: false, expression: null,
        choices: payload.options.map(id => ({ id, displayName: id, retired: false, tone: null })), reference: null, scale: null,
      });
    }
    if (operationType === 'schema.configureReference') {
      entities.get(payload.entityId).fields.find(field => field.fieldId === payload.fieldId).reference =
        { targetEntityId: payload.targetEntityId, labelFieldId: payload.labelFieldId };
    }
    if (operationType === 'schema.declareHierarchy') {
      entities.get(payload.entityId).hierarchy = { parentFieldId: payload.parentFieldId, orderFieldId: payload.orderFieldId };
    }
  }
  return { entities: [...entities.values()] };
}

export function archiFixture(extra = []) {
  const { records } = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
  for (const record of extra) (records[record.entityId] ??= []).push(record);
  const schema = archiSchema();
  // A record as window.nendo reads it: every field of its type present, null where it has no value.
  const full = Object.fromEntries(Object.entries(records).map(([entityId, list]) => {
    const fields = schema.entities.find(entity => entity.entityId === entityId).fields.map(field => field.fieldId);
    return [entityId, list.map(record => ({ ...record, values: Object.fromEntries(fields.map(id => [id, record.values[id] ?? null])), labels: {} }))];
  }));
  for (const entityId of schema.entities.map(entity => entity.entityId)) full[entityId] ??= [];
  return {
    changeSequence: 1,
    context: {
      viewId: 'ar.screen.archi', kind: 'extensionRecordsSurface', placement: 'screen', title: 'Archi', entityId: 'ar.view',
      recordId: null, bindings: { labelFieldId: 'ar.view.name', statusFieldId: null, fields: [], filters: [] }, theme: 'light',
    },
    schema, records: full,
    hierarchies: Object.fromEntries(schema.entities.filter(entity => entity.hierarchy).map(entity => [entity.entityId, entity.hierarchy])),
  };
}

/**
 * Archisurance and two views for measuring the drawing (W-110): "Every figure", each of the 61
 * element types in both figures and each of the 11 relationship types once, and "500 objects",
 * a grid of 500 boxes and 250 lines for pan and zoom.
 */
export function galleryFixture() {
  const base = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8')).records;
  const types = base['ar.type'];
  const folder = kind => base['ar.folder'].find(record => record.values['ar.folder.kind'] === kind && !record.values['ar.folder.parent']).recordId;
  const home = { Strategy: 'Strategy', Business: 'Business', Application: 'Application', Technology: 'Technology & Physical',
    Physical: 'Technology & Physical', Motivation: 'Motivation', 'Implementation & Migration': 'Implementation & Migration', Other: 'Other' };
  const record = (entityId, recordId, values) => ({ entityId, recordId, version: 1, values });
  const extra = [];
  const elements = types.filter(type => type.values['ar.type.category'] === 'Element');
  for (const type of elements) {
    extra.push(record('ar.concept', `ar-gc-${type.values['ar.type.key']}`, { 'ar.concept.name': type.values['ar.type.name'],
      'ar.concept.type': type.recordId, 'ar.concept.category': 'Element', 'ar.concept.folder': folder(home[type.values['ar.type.layer']]) }));
  }
  const relationships = types.filter(type => type.values['ar.type.category'] === 'Relationship');
  relationships.forEach((type, index) => extra.push(record('ar.concept', `ar-gr-${type.values['ar.type.key']}`, {
    'ar.concept.type': type.recordId, 'ar.concept.category': 'Relationship', 'ar.concept.folder': folder('Relations'),
    'ar.concept.source': `ar-gc-${elements[index * 2].values['ar.type.key']}`, 'ar.concept.target': `ar-gc-${elements[index * 2 + 1].values['ar.type.key']}` })));
  const views = folder('Views');
  extra.push(record('ar.view', 'ar-gv-figures', { 'ar.view.name': 'Every figure', 'ar.view.folder': views }));
  extra.push(record('ar.view', 'ar-gv-500', { 'ar.view.name': '500 objects', 'ar.view.folder': views }));
  let order = 0;
  elements.forEach((type, index) => {
    for (const figure of [0, 1]) {
      const key = type.values['ar.type.key'];
      const junction = key === 'Junction';
      extra.push(record('ar.item', `ar-gi-${key}-${figure}`, { 'ar.item.view': 'ar-gv-figures', 'ar.item.kind': 'Element', 'ar.item.concept': `ar-gc-${key}`,
        'ar.item.x': 20 + (index % 8) * 300 + figure * 140, 'ar.item.y': 20 + Math.floor(index / 8) * 100,
        'ar.item.width': junction ? 15 : 120, 'ar.item.height': junction ? 15 : 55, 'ar.item.figure': figure, 'ar.item.order': (++order) * 1024 }));
    }
  });
  relationships.forEach((type, index) => extra.push(record('ar.item', `ar-gl-${type.values['ar.type.key']}`, {
    'ar.item.view': 'ar-gv-figures', 'ar.item.kind': 'Relationship connection', 'ar.item.concept': `ar-gr-${type.values['ar.type.key']}`,
    'ar.item.source': `ar-gi-${elements[index * 2].values['ar.type.key']}-0`, 'ar.item.target': `ar-gi-${elements[index * 2 + 1].values['ar.type.key']}-0` })));
  for (let index = 0; index < 500; index++) {
    extra.push(record('ar.item', `ar-gp-${index}`, { 'ar.item.view': 'ar-gv-500', 'ar.item.kind': 'Element',
      'ar.item.concept': `ar-gc-${elements[index % elements.length].values['ar.type.key']}`,
      'ar.item.x': 20 + (index % 25) * 150, 'ar.item.y': 20 + Math.floor(index / 25) * 90, 'ar.item.width': 120, 'ar.item.height': 55,
      'ar.item.order': (index + 1) * 1024 }));
  }
  for (let index = 0; index < 500; index += 2) {
    extra.push(record('ar.item', `ar-gq-${index}`, { 'ar.item.view': 'ar-gv-500', 'ar.item.kind': 'Connection',
      'ar.item.source': `ar-gp-${index}`, 'ar.item.target': `ar-gp-${index + 1}` }));
  }
  return archiFixture(extra);
}
