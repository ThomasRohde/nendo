// The two files the Capability Atlas lane shows the package, each as the Workbench would hand it
// over: the view's context, the schema, the declared trees and the records, labels included.
//
//   bcm    BCM.nendo: the Northstar model with the schema and Capability map of definition.mjs.
//   other  A file that shares nothing with it: another record type, other field IDs, choice IDs
//          that are not their names, and only some of the Atlas's parts. Its view binds no
//          target, investment, owner, review date or evidence, and its configuration names a
//          definition field the view does not bind, which the package must say.
//
// tools/Review-BcmAtlas.ps1 writes atlasFixtures() into the gate probe; model.test.mjs binds both.
import { northstarModel } from './northstar.mjs';
import { schemaDescription, mapContext, tree } from './definition.mjs';

/** Records as the view API answers them, each reference carrying its target's label. */
function shape(source, schema) {
  const byType = new Map(Object.entries(source));
  const find = (entityId, recordId) => (byType.get(entityId) ?? []).find(record => record.recordId === recordId);
  return Object.fromEntries([...byType].map(([entityId, list]) => {
    const fields = schema.entities.find(entity => entity.entityId === entityId)?.fields ?? [];
    return [entityId, list.map(record => {
      const labels = {};
      for (const field of fields) {
        const target = field.reference && record.values[field.fieldId];
        if (target) labels[field.fieldId] = find(field.reference.targetEntityId, target)?.values[field.reference.labelFieldId] ?? null;
      }
      return { entityId, recordId: record.recordId, version: 1, values: { ...record.values }, exact: {}, labels, calculated: {} };
    })];
  }));
}

export function bcmFixture() {
  const schema = schemaDescription();
  return {
    context: mapContext(),
    schema,
    hierarchies: { [tree.entityId]: { parentFieldId: tree.parentFieldId, orderFieldId: tree.orderFieldId } },
    records: shape(northstarModel(), schema),
  };
}

const field = (fieldId, displayName, storageKind, extra = {}) => ({
  fieldId, displayName, storageKind, required: false, presentation: null, calculated: false, expression: null,
  choices: [], reference: null, scale: null, ...extra,
});
const choice = (...entries) => ({ presentation: 'singleChoice', choices: entries.map(([id, displayName, tone]) => ({ id, displayName, retired: false, tone })) });
const pointsAt = (targetEntityId, labelFieldId) => ({ reference: { targetEntityId, labelFieldId } });

/** A business-area map with nothing in common with BCM.nendo but the shape of a tree. */
export function otherFixture() {
  // Record types in the order the host lists them, by entity ID.
  const schema = {
    entities: [
      { entityId: 'org.area', displayName: 'Business area', hierarchy: { parentFieldId: 'area.up', orderFieldId: 'area.rank' }, fields: [
        field('area.title', 'Title', 'text', { required: true }),
        field('area.up', 'Part of', 'reference', pointsAt('org.area', 'area.title')),
        field('area.rank', 'Rank', 'integer'),
        field('area.key', 'Key', 'text'),
        field('area.level', 'Capability level', 'integer', { presentation: 'rating', scale: { min: 1, max: 5 } }),
        field('area.focus', 'Focus', 'text', choice(['commodity', 'Commodity', 'grey'], ['core', 'Core', 'blue'], ['edge', 'Edge', 'violet'])),
        field('area.state', 'State', 'text', choice(['draft', 'Draft', 'grey'], ['live', 'Live', 'teal'], ['sunset', 'Sunset', 'amber'])),
        field('area.lead', 'Lead', 'text'),
        field('area.notes', 'Notes', 'text', { presentation: 'longText' }),
      ] },
      { entityId: 'org.system', displayName: 'System', hierarchy: null, fields: [field('system.name', 'Name', 'text', { required: true })] },
      { entityId: 'org.use', displayName: 'System use', hierarchy: null, fields: [
        field('use.area', 'Area', 'reference', pointsAt('org.area', 'area.title')),
        field('use.system', 'System', 'reference', pointsAt('org.system', 'system.name')),
        field('use.grade', 'Grade', 'text', choice(['weak', 'Weak', 'red'], ['fair', 'Fair', 'amber'], ['good', 'Good', 'teal'])),
      ] },
      { entityId: 'org.project', displayName: 'Project', hierarchy: null, fields: [
        field('project.name', 'Name', 'text', { required: true }),
        field('project.area', 'Area', 'reference', pointsAt('org.area', 'area.title')),
        field('project.phase', 'Phase', 'text', choice(['idea', 'Idea', 'grey'], ['build', 'Build', 'blue'], ['done', 'Done', 'green'])),
      ] },
    ],
  };
  schema.entities.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));

  // Three areas, three children each, and two grandchildren under each first child: 3, 12, 18.
  const areas = [];
  const add = (recordId, title, up, rank, level, focus) => areas.push({ recordId, values: {
    'area.title': title, 'area.up': up, 'area.rank': rank, 'area.key': recordId.slice(4).toUpperCase().replaceAll('-', '.'),
    'area.level': level, 'area.focus': focus, 'area.state': 'live', 'area.lead': null, 'area.notes': `Why ${title} matters.`,
  } });
  const tops = [['org-a', 'Customers', 'edge'], ['org-b', 'Operations', 'core'], ['org-c', 'Enablement', 'commodity']];
  tops.forEach(([id, title, focus], i) => {
    add(id, title, null, i + 1, 3, focus);
    for (let child = 1; child <= 3; child += 1) {
      add(`${id}-${child}`, `${title} ${child}`, id, child, child === 3 ? null : child + 1, focus);
      if (child === 1) for (let grand = 1; grand <= 2; grand += 1) add(`${id}-1-${grand}`, `${title} 1.${grand}`, `${id}-1`, grand, 4, 'edge');
    }
  });
  const source = {
    'org.area': areas,
    'org.system': [['sys-crm', 'Relay CRM'], ['sys-web', 'Storefront'], ['sys-erp', 'Ledger ERP']]
      .map(([recordId, name]) => ({ recordId, values: { 'system.name': name } })),
    'org.use': [['use-1', 'org-a-1', 'sys-crm', 'good'], ['use-2', 'org-a-1', 'sys-web', 'fair'], ['use-3', 'org-b-2', 'sys-erp', 'weak']]
      .map(([recordId, area, system, grade]) => ({ recordId, values: { 'use.area': area, 'use.system': system, 'use.grade': grade } })),
    'org.project': [['project-1', 'Loyalty relaunch', 'org-a-1', 'build'], ['project-2', 'Warehouse move', 'org-b', 'idea']]
      .map(([recordId, name, area, phase]) => ({ recordId, values: { 'project.name': name, 'project.area': area, 'project.phase': phase } })),
  };

  return {
    context: {
      viewId: 'org.areas', kind: 'extensionRecordsSurface', placement: 'screen', title: 'Area map', entityId: 'org.area', recordId: null,
      bindings: {
        labelFieldId: 'area.title', statusFieldId: 'area.state', edgeEntityId: null, sourceFieldId: null, targetFieldId: null,
        fields: ['area.up', 'area.rank', 'area.key', 'area.level', 'area.focus', 'area.lead'].map(fieldId => ({ fieldId, entityId: 'org.area' })),
        filters: [],
      },
      configuration: { fields: { code: 'area.key', maturity: 'area.level', importance: 'area.focus', description: 'area.notes' } },
    },
    schema,
    hierarchies: { 'org.area': { parentFieldId: 'area.up', orderFieldId: 'area.rank' } },
    records: shape(source, schema),
  };
}

export const atlasFixtures = () => ({ bcm: bcmFixture(), other: otherFixture() });
