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

export function archiFixture() {
  const { records } = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
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
