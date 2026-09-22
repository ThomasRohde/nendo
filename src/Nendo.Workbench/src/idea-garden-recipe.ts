import type { DesktopSessionView } from './host';

interface CanonicalOperation {
  operationId: string;
  operationType: string;
  payload: Record<string, unknown>;
}

interface CanonicalMutation {
  idempotencyKey: string;
  description: string;
  operations: CanonicalOperation[];
}

export interface ApplicationRecipe {
  actionLabel: string;
  applicationName: string;
  proposalPayload: Record<string, unknown>;
}

const entityId = 'entity.idea';
const fields = [
  { fieldId: 'field.idea.title', displayName: 'Title', storageKind: 'text', required: true, presentation: 'singleLine', options: [] },
  { fieldId: 'field.idea.notes', displayName: 'Notes', storageKind: 'text', required: false, presentation: 'longText', options: [] },
  { fieldId: 'field.idea.status', displayName: 'Status', storageKind: 'text', required: false, presentation: 'singleChoice', options: ['Idea', 'Exploring', 'Trying', 'Paused', 'Done'] },
  { fieldId: 'field.idea.energy', displayName: 'Energy', storageKind: 'text', required: false, presentation: 'singleChoice', options: ['Low', 'Medium', 'High'] },
  { fieldId: 'field.idea.createdDate', displayName: 'Created date', storageKind: 'date', required: false, presentation: 'date', options: [] },
  { fieldId: 'field.idea.nextAction', displayName: 'Next action', storageKind: 'text', required: false, presentation: 'singleLine', options: [] },
] as const;

export function ideaGardenRecipe(session: DesktopSessionView): ApplicationRecipe | null {
  if (!session.hasFile || session.uiNodes.length > 0) return null;
  const entity = session.entities.find((candidate) => candidate.entityId === entityId);
  if (entity === undefined && session.entities.length > 0) return null;

  const proposalId = `proposal-${crypto.randomUUID().replaceAll('-', '')}`;
  const definition: CanonicalOperation[] = [];
  const operation = (operationType: string, payload: Record<string, unknown>): void => {
    definition.push({
      operationId: `${proposalId}-operation-${definition.length.toString().padStart(3, '0')}`,
      operationType,
      payload,
    });
  };
  const property = (surfaceId: string, nodeId: string, propertyName: string, value: unknown): void => {
    operation('ui.setProperty', { surfaceId, nodeId, propertyName, value });
  };
  const root = (surfaceId: string, nodeId: string, kind: string, title: string): void => {
    operation('ui.addNode', { surfaceId, nodeId, parentNodeId: null, kind, position: 0 });
    property(surfaceId, nodeId, 'definitionVersion', 3);
    property(surfaceId, nodeId, 'entityId', entityId);
    property(surfaceId, nodeId, 'title', title);
  };
  const bindings = (surfaceId: string, rootNodeId: string, role: string, fieldIds: string[]): void => {
    fieldIds.forEach((fieldId, position) => {
      const shortId = fieldId.slice('field.idea.'.length);
      const nodeId = `node.idea.${role}.${shortId}`;
      operation('ui.addNode', { surfaceId, nodeId, parentNodeId: rootNodeId, kind: 'fieldBinding', position });
      property(surfaceId, nodeId, 'fieldId', fieldId);
    });
  };

  if (entity === undefined) {
    operation('schema.createEntity', { entityId, displayName: 'Idea' });
  }
  const existingFieldIds = new Set(entity?.fields.map((field) => field.fieldId) ?? []);
  for (const field of fields) {
    if (!existingFieldIds.has(field.fieldId)) {
      operation('schema.addField', { entityId, ...field });
    }
  }
  // Colour the statuses and energies so the board reads at a glance. A tone is
  // part of an option's metadata and rides in the same mutation as its field; a
  // field that already exists keeps whatever colours the person chose.
  const expectedDefinitionRevision = session.manifest?.definitionRevision ?? 0;
  const tones: Array<[string, string, string]> = [
    ['field.idea.status', 'Idea', 'blue'],
    ['field.idea.status', 'Exploring', 'violet'],
    ['field.idea.status', 'Trying', 'amber'],
    ['field.idea.status', 'Paused', 'grey'],
    ['field.idea.status', 'Done', 'green'],
    ['field.idea.energy', 'Low', 'teal'],
    ['field.idea.energy', 'Medium', 'amber'],
    ['field.idea.energy', 'High', 'red'],
  ];
  for (const [fieldId, choiceId, tone] of tones) {
    if (existingFieldIds.has(fieldId)) continue;
    operation('schema.setChoiceMetadata', { entityId, fieldId, choiceId, displayName: choiceId, retired: false, tone, expectedDefinitionRevision });
  }

  root('surface.idea.form', 'node.idea.form.root', 'recordForm', 'Idea form');
  bindings('surface.idea.form', 'node.idea.form.root', 'form', fields.map((field) => field.fieldId));
  root('surface.idea.list', 'node.idea.list.root', 'recordList', 'All ideas');
  bindings('surface.idea.list', 'node.idea.list.root', 'list', [
    'field.idea.title',
    'field.idea.status',
    'field.idea.energy',
    'field.idea.nextAction',
  ]);
  root('surface.idea.board', 'node.idea.board.root', 'boardSurface', 'Idea board');
  const cardFieldIds = ['field.idea.title', 'field.idea.energy', 'field.idea.nextAction'];
  property('surface.idea.board', 'node.idea.board.root', 'groupByFieldId', 'field.idea.status');
  bindings('surface.idea.board', 'node.idea.board.root', 'card', cardFieldIds);
  operation('ui.addNode', {
    surfaceId: 'surface.idea.commands',
    nodeId: 'command.idea.moveToTrying',
    parentNodeId: null,
    kind: 'recordCommand',
    position: 0,
  });
  for (const [propertyName, value] of Object.entries({
    definitionVersion: 3,
    entityId,
    label: 'Move to Trying',
  })) {
    property('surface.idea.commands', 'command.idea.moveToTrying', propertyName, value);
  }
  // A command owns ordered steps rather than one inline effect.
  operation('ui.addNode', {
    surfaceId: 'surface.idea.commands',
    nodeId: 'node.idea.command.moveToTrying.status',
    parentNodeId: 'command.idea.moveToTrying',
    kind: 'commandStep',
    position: 0,
  });
  for (const [propertyName, value] of Object.entries({
    fieldId: 'field.idea.status',
    valueKind: 'literal',
    value: 'Trying',
  })) {
    property('surface.idea.commands', 'node.idea.command.moveToTrying.status', propertyName, value);
  }

  const mutations: CanonicalMutation[] = [{
    idempotencyKey: `${proposalId}-definition`,
    description: 'Create the Idea Garden structure and surfaces',
    operations: definition,
  }];
  const backfill = session.records
    .filter((record) => record.entityId === entityId && record.values['field.idea.status'] == null)
    .map((record, index) => ({
      operationId: `${proposalId}-backfill-${index.toString().padStart(3, '0')}`,
      operationType: 'data.setField',
      payload: {
        entityId,
        recordId: record.recordId,
        fieldId: 'field.idea.status',
        expectedRecordVersion: record.recordVersion,
        value: 'Idea',
      },
    }));
  if (backfill.length > 0) {
    mutations.push({
      idempotencyKey: `${proposalId}-data`,
      description: 'Place existing Ideas in the Idea group',
      operations: backfill,
    });
  }

  return {
    actionLabel: entity === undefined ? 'Start Idea Garden' : 'Complete Idea Garden',
    applicationName: 'Idea Garden',
    proposalPayload: {
      proposalId,
      title: 'Idea form, list and board',
      mutations,
    },
  };
}
