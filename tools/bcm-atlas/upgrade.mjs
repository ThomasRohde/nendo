// What a BCM.nendo built before 2026-09-29 needs to hold assessments over time (W-080): the
// Assessment record type and its screens, a unique capability code (W-075), both ends of a support
// link required (W-076), and the Capability map's configuration naming the assessments. Built from
// definition.mjs, so the upgrade and a file built fresh by build-model.mjs arrive at one schema.
//
// Upgrade-BcmAtlas.mjs sends these as one proposal the person accepts, then imports the
// assessments. Nothing here touches Nendo; upgrade.test.mjs checks the shape.
import { defs, references, tones, unique, mapView } from './definition.mjs';

const op = (operationType, payload) => ({ operationType, payload });
const entityOf = fieldId => `bcm.${defs.find(([, , prefix]) => fieldId.startsWith(prefix + '.'))[0]}`;
const [assessmentId, assessmentName, prefix, fields] = defs.find(([id]) => id === 'assessment');
const [scopeId, scopeName, scopePrefix, scopeFields] = defs.find(([id]) => id === 'scope');

/** The proposal's mutations, each within the host's 16 operations. */
export function upgradeMutations() {
  const entityId = `bcm.${assessmentId}`;
  const node = (nodeId, kind, parentNodeId, position, properties) =>
    op('ui.addNode', { surfaceId: 'bcm.atlas', nodeId, kind, position, parentNodeId, properties });
  const bind = (parent, keys, from = 0) => keys.map((key, index) =>
    node(`${parent}.${key}`, 'fieldBinding', parent, from + index, { fieldId: `${prefix}.${key}` }));
  return [
    {
      // A required field has to arrive in the mutation that creates its record type.
      description: `Define ${assessmentName}`,
      operations: [
        op('schema.createEntity', { entityId, displayName: assessmentName }),
        ...fields.map(([key, label, kind, required = false, presentation, options, min, max]) => op('schema.addField', {
          entityId, fieldId: `${prefix}.${key}`, displayName: label, storageKind: kind, required,
          ...(presentation ? { presentation } : {}), ...(options ? { options } : {}), ...(min ? { min, max } : {}),
        })),
      ],
    },
    {
      description: 'Connect assessments to capabilities, keep capability codes unique and require both ends of a support link',
      operations: [
        ...references.filter(([type]) => type === assessmentId).map(([type, fieldId, target, label]) =>
          op('schema.configureReference', { entityId: `bcm.${type}`, fieldId, targetEntityId: `bcm.${target}`, labelFieldId: label })),
        ...fields.filter(([, , , , presentation]) => presentation === 'singleChoice').flatMap(([key, , , , , options]) =>
          options.filter(choice => tones[choice]).map(choice => op('schema.setChoiceMetadata', {
            entityId, fieldId: `${prefix}.${key}`, choiceId: choice, displayName: choice, retired: false, tone: tones[choice] }))),
        ...unique.map(fieldId => op('schema.setFieldUnique', { entityId: entityOf(fieldId), fieldId, unique: true })),
        ...defs.find(([id]) => id === 'support')[3].filter(([, , kind, required]) => kind === 'reference' && required)
          .map(([key]) => op('schema.setFieldRequired', { entityId: 'bcm.support', fieldId: `support.${key}`, required: true })),
      ],
    },
    {
      description: 'Show assessments: their page, their register, and a capability’s history',
      operations: [
        node(`bcm.${assessmentId}.detail`, 'detailSurface', null, 1000,
          { definitionVersion: 3, entityId, titleFieldId: `${prefix}.name`, subtitleFieldId: `${prefix}.dimension` }),
        ...bind(`bcm.${assessmentId}.detail`, fields.map(([key]) => key).filter(key => key !== 'name')),
        node('bcm.history', 'relatedList', 'bcm.capability.detail', 1000,
          { targetEntityId: entityId, viaFieldId: `${prefix}.capability`, title: 'Assessment history' }),
        ...bind('bcm.history', ['dimension', 'score', 'date']),
      ],
    },
    {
      // W-081: an initiative covers several capabilities, one link record each.
      description: `Define ${scopeName}, linking an initiative to each capability it changes`,
      operations: [
        op('schema.createEntity', { entityId: `bcm.${scopeId}`, displayName: scopeName }),
        ...scopeFields.map(([key, label, kind, required = false, presentation]) => op('schema.addField', {
          entityId: `bcm.${scopeId}`, fieldId: `${scopePrefix}.${key}`, displayName: label, storageKind: kind, required,
          ...(presentation ? { presentation } : {}),
        })),
        ...references.filter(([type]) => type === scopeId).map(([type, fieldId, target, label]) =>
          op('schema.configureReference', { entityId: `bcm.${type}`, fieldId, targetEntityId: `bcm.${target}`, labelFieldId: label })),
      ],
    },
    {
      description: 'Show an initiative\u2019s scope from both sides',
      operations: [
        node(`bcm.${scopeId}.detail`, 'detailSurface', null, 1002,
          { definitionVersion: 3, entityId: `bcm.${scopeId}`, titleFieldId: `${scopePrefix}.name`, subtitleFieldId: `${scopePrefix}.initiative` }),
        ...['initiative', 'capability', 'note'].map((key, index) =>
          node(`bcm.${scopeId}.detail.${key}`, 'fieldBinding', `bcm.${scopeId}.detail`, index, { fieldId: `${scopePrefix}.${key}` })),
        node('bcm.scopes', 'relatedList', 'bcm.capability.detail', 1001,
          { targetEntityId: `bcm.${scopeId}`, viaFieldId: `${scopePrefix}.capability`, title: 'Initiatives in scope' }),
        ...['initiative', 'note'].map((key, index) => node(`bcm.scopes.${key}`, 'fieldBinding', 'bcm.scopes', index, { fieldId: `${scopePrefix}.${key}` })),
        node('bcm.inscope', 'relatedList', 'bcm.initiative.detail', 1000,
          { targetEntityId: `bcm.${scopeId}`, viaFieldId: `${scopePrefix}.initiative`, title: 'Capabilities in scope' }),
        ...['capability', 'note'].map((key, index) => node(`bcm.inscope.${key}`, 'fieldBinding', 'bcm.inscope', index, { fieldId: `${scopePrefix}.${key}` })),
      ],
    },
    {
      description: 'List every assessment, newest first, and name them to the Capability map',
      operations: [
        node('bcm.assessments', 'recordList', null, 1001,
          { definitionVersion: 3, entityId, title: 'Assessments', orderByFieldId: `${prefix}.date`, orderDirection: 'descending' }),
        ...bind('bcm.assessments', ['name', 'capability', 'dimension', 'score', 'date', 'assessor']),
        op('ui.setProperty', { surfaceId: 'bcm.atlas', nodeId: mapView.nodeId, propertyName: 'configuration', value: JSON.stringify(mapView.configuration) }),
      ],
    },
  ];
}

// node tools/bcm-atlas/upgrade.mjs writes upgrade-operations.json, which the LocalMcp lane proposes
// against a copy of workspace/BCM.nendo (BcmAtlasUpgradeTests) and upgrade.test.mjs holds to this.
if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(new URL('./upgrade-operations.json', import.meta.url), JSON.stringify(upgradeMutations(), null, 2) + '\n', 'utf8');
}
