// The Capability Atlas application as BCM.nendo defines it: its record types, references, choice
// tones, the declared capability tree and the Capability map view with its configuration.
// build-model.mjs writes the file's batches from it, and fixtures.mjs hands the package the same
// schema and view context the Workbench would, so the lane measures the package against what the
// file declares rather than against a copy of it.

// [id, name, field prefix, fields]; each field is
// [key, name, stored kind, required, presentation, options, scale min, scale max].
export const defs = [
  ['capability', 'Capability', 'cap', [
    ['name', 'Name', 'text', true], ['code', 'Reference', 'text'], ['description', 'Definition', 'text', false, 'longText'],
    ['parent', 'Parent capability', 'reference'], ['owner', 'Accountable owner', 'text'],
    ['maturity', 'Current maturity', 'integer', false, 'rating', null, 1, 5], ['target', 'Target maturity', 'integer', false, 'rating', null, 1, 5],
    ['importance', 'Strategic importance', 'text', false, 'singleChoice', ['Supporting', 'Core', 'Differentiating']],
    ['investment', 'Investment direction', 'text', false, 'singleChoice', ['Tolerate', 'Invest', 'Migrate', 'Eliminate']],
    ['lifecycle', 'Lifecycle', 'text', false, 'singleChoice', ['Proposed', 'Active', 'Retiring']],
    ['reviewed', 'Last reviewed', 'date', false, 'date'], ['evidence', 'Assessment evidence', 'text', false, 'longText'],
    ['order', 'Display order', 'integer']]],
  ['application', 'Application', 'app', [
    ['name', 'Name', 'text', true], ['code', 'Reference', 'text'], ['description', 'Purpose', 'text', false, 'longText'],
    ['owner', 'Owner', 'text'], ['lifecycle', 'Lifecycle', 'text', false, 'singleChoice', ['Planned', 'Active', 'Retiring']],
    ['criticality', 'Criticality', 'text', false, 'singleChoice', ['Low', 'Medium', 'High']], ['vendor', 'Vendor', 'text']]],
  ['support', 'Application support', 'support', [
    ['name', 'Support relationship', 'text', true], ['capability', 'Capability', 'reference', true], ['application', 'Application', 'reference', true],
    ['role', 'Role', 'text', false, 'singleChoice', ['Primary', 'Supporting', 'System of record']],
    ['fit', 'Business fit', 'text', false, 'singleChoice', ['Poor', 'Adequate', 'Strong']], ['notes', 'Notes', 'text', false, 'longText']]],
  ['initiative', 'Initiative', 'initiative', [
    ['name', 'Name', 'text', true], ['code', 'Reference', 'text'], ['capability', 'Primary capability', 'reference'],
    ['description', 'Intended outcome', 'text', false, 'longText'], ['owner', 'Accountable owner', 'text'],
    ['stage', 'Stage', 'text', false, 'singleChoice', ['Proposed', 'Discovery', 'Delivery', 'Complete']],
    ['start', 'Start', 'date', false, 'date'], ['end', 'Target completion', 'date', false, 'date'],
    ['priority', 'Priority', 'text', false, 'singleChoice', ['Low', 'Medium', 'High']], ['success', 'Success measure', 'text', false, 'longText']]],
  // One scored judgement of one capability on one dimension at one date (W-080). History keeps
  // every one; the map shows the latest.
  ['assessment', 'Assessment', 'assess', [
    ['name', 'Assessment', 'text', true], ['capability', 'Capability', 'reference', true],
    ['dimension', 'Dimension', 'text', true, 'singleChoice', ['Maturity', 'Business value', 'IT health']],
    ['score', 'Score', 'integer', true, 'rating', null, 1, 5], ['date', 'Assessed on', 'date', true, 'date'],
    ['assessor', 'Assessor', 'text'], ['evidence', 'Evidence', 'text', false, 'longText']]],
  // An initiative covers several capabilities (W-081): one link record per capability it changes.
  ['scope', 'Initiative scope', 'scope', [
    ['name', 'Scope', 'text', true], ['initiative', 'Initiative', 'reference', true], ['capability', 'Capability', 'reference', true],
    ['note', 'Why it is in scope', 'text', false, 'longText']]],
];

// Fields no two records may share (ADR-0020): a capability's code names it on import (W-075).
export const unique = ['cap.code'];

// [record type, reference field, target record type, the target's label field].
export const references = [
  ['capability', 'cap.parent', 'capability', 'cap.name'], ['support', 'support.capability', 'capability', 'cap.name'],
  ['support', 'support.application', 'application', 'app.name'], ['initiative', 'initiative.capability', 'capability', 'cap.name'],
  ['assessment', 'assess.capability', 'capability', 'cap.name'],
  ['scope', 'scope.initiative', 'initiative', 'initiative.name'], ['scope', 'scope.capability', 'capability', 'cap.name'],
];

// The tone of each choice that has one, whichever field offers it.
export const tones = {
  Supporting: 'grey', Core: 'blue', Differentiating: 'violet', Tolerate: 'blue', Invest: 'teal', Migrate: 'amber', Eliminate: 'red',
  Proposed: 'grey', Active: 'teal', Retiring: 'amber', Planned: 'violet', Low: 'grey', Medium: 'amber', High: 'red',
  Poor: 'red', Adequate: 'amber', Strong: 'teal', Discovery: 'violet', Delivery: 'blue', Complete: 'green',
  Maturity: 'blue', 'Business value': 'violet', 'IT health': 'teal',
};

// The capability tree the Engine keeps (ADR-0019): no loops, at most 32 levels, siblings by Display order.
export const tree = { entityId: 'bcm.capability', parentFieldId: 'cap.parent', orderFieldId: 'cap.order' };

/**
 * The Capability map: the Atlas package over Capability, labelled by Name, with Lifecycle as its
 * status and every other capability field bound. Its configuration tells the package which bound
 * field plays which part, and carries the words that belong to this file rather than to the
 * package: the Northstar banner and how the two related record types read in the inspector.
 */
export const mapView = {
  nodeId: 'bcm.map',
  title: 'Capability map',
  labelFieldId: 'cap.name',
  statusFieldId: 'cap.lifecycle',
  fieldIds: defs[0][3].map(([key]) => key).filter(key => key !== 'name').map(key => `cap.${key}`),
  configuration: {
    fields: {
      code: 'cap.code', description: 'cap.description', owner: 'cap.owner', maturity: 'cap.maturity', target: 'cap.target',
      importance: 'cap.importance', investment: 'cap.investment', lifecycle: 'cap.lifecycle', reviewed: 'cap.reviewed', evidence: 'cap.evidence',
    },
    banner: { title: 'NORTHSTAR / DEMONSTRATION MODEL', note: 'Fictional data · replace with your organisation' },
    related: {
      'bcm.support': { title: 'Application support', row: '{support.fit} fit · {support.role}', empty: 'No applications linked. Add support links in the record page.' },
      'bcm.initiative': { title: 'Change portfolio', row: '{initiative.stage} · {initiative.end}', empty: 'No initiatives linked.' },
      'bcm.scope': { title: 'Initiatives in scope', row: '{scope.note}', empty: 'No initiative covers this capability.' },
      'bcm.assessment': { title: 'Assessment history', row: '{assess.dimension} {assess.score} · {assess.date}', empty: 'Not assessed yet. Add an assessment in the record page.' },
    },
    coverage: { entityId: 'bcm.support', capability: 'support.capability', application: 'support.application', role: 'support.role', fit: 'support.fit' },
    assessments: {
      entityId: 'bcm.assessment', capability: 'assess.capability', dimension: 'assess.dimension', score: 'assess.score', date: 'assess.date',
      dimensions: { maturity: 'Maturity', health: 'IT health', value: 'Business value' },
    },
  },
};

/**
 * The file's record types as nendo.schema.describe() answers them: by entity ID, as the host
 * lists them, and each type's fields in the order they were authored.
 */
export function schemaDescription() {
  return {
    entities: [...defs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, displayName, prefix, fields]) => ({
      entityId: `bcm.${id}`,
      displayName,
      hierarchy: `bcm.${id}` === tree.entityId ? { parentFieldId: tree.parentFieldId, orderFieldId: tree.orderFieldId } : null,
      fields: fields.map(([key, name, kind, required = false, presentation = null, options = null, min, max]) => {
        const fieldId = `${prefix}.${key}`;
        const reference = references.find(([, field]) => field === fieldId);
        return {
          fieldId, displayName: name, storageKind: kind, required, presentation, calculated: false, expression: null, unique: unique.includes(fieldId),
          choices: (options ?? []).map(option => ({ id: option, displayName: option, retired: false, tone: tones[option] ?? null })),
          reference: reference ? { targetEntityId: `bcm.${reference[2]}`, labelFieldId: reference[3] } : null,
          scale: min ? { min, max } : null,
        };
      }),
    })),
  };
}

/** The context the Workbench hands the package on the Capability map. */
export function mapContext(configuration = mapView.configuration) {
  return {
    viewId: mapView.nodeId, kind: 'extensionRecordsSurface', placement: 'screen', title: mapView.title, entityId: tree.entityId, recordId: null,
    bindings: {
      labelFieldId: mapView.labelFieldId, statusFieldId: mapView.statusFieldId, edgeEntityId: null, sourceFieldId: null, targetFieldId: null,
      fields: mapView.fieldIds.map(fieldId => ({ fieldId, entityId: tree.entityId })), filters: [],
    },
    configuration,
  };
}
