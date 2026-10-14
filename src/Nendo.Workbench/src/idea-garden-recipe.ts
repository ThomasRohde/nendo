import type { DesktopSessionView, ReadPage, RecordSnapshot } from './host';

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
  /**
   * The payload to prepare, read from the file when it is pressed, where the recipe needs records
   * the open session does not hold. Without it, proposalPayload is prepared as it is.
   */
  prepare?: (query: (payload: Record<string, unknown>) => Promise<ReadPage<RecordSnapshot>>) => Promise<Record<string, unknown>>;
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
  // Existing ideas without a Status go into the Idea group. They are read from the file when the
  // recipe is pressed: the desktop session holds no records (bounded reads), so a backfill built
  // from session.records was never made there and every existing idea sat in Ungrouped (WSP-11).
  const proposalPayload = { proposalId, title: 'Idea form, list and board', mutations };
  const prepare = async (query: (payload: Record<string, unknown>) => Promise<ReadPage<RecordSnapshot>>): Promise<Record<string, unknown>> => {
    const missing: RecordSnapshot[] = [];
    let cursor: string | null = null;
    // Where the recipe adds Status itself, every existing record lacks it, and the host refuses a
    // filter on a field the type does not have yet; so every record of the type is read instead.
    const filters = existingFieldIds.has('field.idea.status') ? [{ fieldId: 'field.idea.status', operator: 'isNull' }] : [];
    do {
      const page: ReadPage<RecordSnapshot> = await query({ entityId, limit: 200, cursor, filters });
      missing.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    const backfill = missing.map((record, index) => ({
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
    return backfill.length === 0 ? proposalPayload : { ...proposalPayload, mutations: [...mutations, {
      idempotencyKey: `${proposalId}-data`,
      description: 'Place existing Ideas in the Idea group',
      operations: backfill,
    }] };
  };

  return {
    actionLabel: entity === undefined ? 'Start Idea Garden' : 'Complete Idea Garden',
    applicationName: 'Idea Garden',
    proposalPayload,
    ...(entity === undefined ? {} : { prepare }),
  };
}
