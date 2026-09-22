import type { ApplicationPlan, EntitySnapshot, RecordPlan, RecordSnapshot, SurfaceNodePlan, UiNodeSnapshot } from './host';

export type PreviewFixtureName = 'idea' | 'decision';

export interface PreviewFixture {
  fileName: string;
  entity: EntitySnapshot;
  records: RecordSnapshot[];
  uiNodes: UiNodeSnapshot[];
  plan: ApplicationPlan;
}

export function previewFixture(name: PreviewFixtureName): PreviewFixture {
  return name === 'decision' ? decisionLogFixture() : ideaGardenFixture();
}

export function previewFixtureName(value: string | null): PreviewFixtureName {
  return value === 'decision' ? 'decision' : 'idea';
}

export function previewFixtureForEntity(entityId: string): PreviewFixture | null {
  if (entityId === 'entity.idea') return ideaGardenFixture();
  if (entityId === 'entity.decision') return decisionLogFixture();
  return null;
}

function ideaGardenFixture(): PreviewFixture {
  const entity: EntitySnapshot = {
    entityId: 'entity.idea',
    displayName: 'Idea',
    fields: [
      field('field.idea.title', 'Title', 'text', true, 'singleLine'),
      field('field.idea.notes', 'Notes', 'text', false, 'longText'),
      field('field.idea.status', 'Status', 'text', false, 'singleChoice', ['Idea', 'Exploring', 'Trying', 'Paused', 'Done']),
      field('field.idea.energy', 'Energy', 'text', false, 'singleChoice', ['Low', 'Medium', 'High']),
      field('field.idea.createdDate', 'Created date', 'date', false, 'date'),
      field('field.idea.nextAction', 'Next action', 'text', false, 'singleLine'),
    ],
  };
  const records: RecordSnapshot[] = [
    record(entity.entityId, 'preview-idea-one', {
      'field.idea.title': 'A quieter weekly review',
      'field.idea.notes': 'Keep the ritual small enough to repeat.',
      'field.idea.status': 'Exploring',
      'field.idea.energy': 'Medium',
      'field.idea.createdDate': '2026-09-03',
      'field.idea.nextAction': 'Try it on Friday',
    }),
    record(entity.entityId, 'preview-idea-two', {
      'field.idea.title': 'Pocket field notes',
      'field.idea.notes': null,
      'field.idea.status': 'Trying',
      'field.idea.energy': 'High',
      'field.idea.createdDate': '2026-09-02',
      'field.idea.nextAction': 'Print a small batch',
    }),
  ];
  return fixture(
    'Idea Garden.nendo',
    entity,
    records,
    ['surface.idea.form', 'surface.idea.list', 'surface.idea.board'],
    ['node.idea.form.root', 'node.idea.list.root', 'node.idea.board.root'],
    {
      formTitle: 'Idea form',
      listTitle: 'All ideas',
      boardTitle: 'Idea board',
      formFields: entity.fields.map((candidate) => candidate.fieldId),
      listFields: ['field.idea.title', 'field.idea.status', 'field.idea.energy', 'field.idea.nextAction'],
      groupField: 'field.idea.status',
      cardFields: ['field.idea.title', 'field.idea.energy', 'field.idea.nextAction'],
      groups: ['Idea', 'Exploring', 'Trying', 'Paused', 'Done'],
      command: { nodeId: 'command.idea.moveToTrying', label: 'Move to Trying', fieldId: 'field.idea.status', value: 'Trying' },
    },
  );
}

function decisionLogFixture(): PreviewFixture {
  const entity: EntitySnapshot = {
    entityId: 'entity.decision',
    displayName: 'Decision',
    fields: [
      field('field.decision.title', 'Decision', 'text', true, 'singleLine'),
      field('field.decision.context', 'Context', 'text', false, 'longText'),
      field('field.decision.state', 'State', 'text', true, 'singleChoice', ['Proposed', 'Accepted', 'Superseded']),
      field('field.decision.owner', 'Owner', 'text', false, 'singleLine'),
      field('field.decision.reviewDate', 'Review date', 'date', false, 'date'),
      field('field.decision.decidedDate', 'Decided', 'date', false, 'date'),
    ],
  };
  const records: RecordSnapshot[] = [
    record(entity.entityId, 'preview-decision-one', {
      'field.decision.title': 'Keep the working file local',
      'field.decision.context': 'The first release should remain understandable and portable.',
      'field.decision.state': 'Accepted',
      'field.decision.owner': 'Thomas',
      'field.decision.reviewDate': '2026-10-01',
      'field.decision.decidedDate': '2026-09-01',
    }),
    record(entity.entityId, 'preview-decision-two', {
      'field.decision.title': 'Review export formats after field use',
      'field.decision.context': 'Choose from observed needs instead of guesses.',
      'field.decision.state': 'Proposed',
      'field.decision.owner': 'Studio',
      'field.decision.reviewDate': '2026-11-15',
      'field.decision.decidedDate': '2026-09-03',
    }),
  ];
  return fixture(
    'Decision Log.nendo',
    entity,
    records,
    ['surface.decision.form', 'surface.decision.list', 'surface.decision.board'],
    ['node.decision.form.root', 'node.decision.list.root', 'node.decision.board.root'],
    {
      formTitle: 'Decision record',
      listTitle: 'Decision log',
      boardTitle: 'Decisions by state',
      formFields: entity.fields.map((candidate) => candidate.fieldId),
      listFields: ['field.decision.title', 'field.decision.state', 'field.decision.owner', 'field.decision.reviewDate'],
      groupField: 'field.decision.state',
      cardFields: ['field.decision.title', 'field.decision.owner', 'field.decision.reviewDate'],
      groups: ['Proposed', 'Accepted', 'Superseded'],
      command: { nodeId: 'command.decision.accept', label: 'Accept decision', fieldId: 'field.decision.state', value: 'Accepted' },
      // Decisions as toned cards, titled by the decision itself.
      gallery: {
        surfaceId: 'surface.decision.gallery',
        nodeId: 'node.decision.gallery.root',
        title: 'Decision cards',
        titleFieldId: 'field.decision.title',
        accentFieldId: 'field.decision.state',
        fields: ['field.decision.owner', 'field.decision.reviewDate'],
      },
      // Decisions on a spine from their decided date to their review date.
      timeline: {
        surfaceId: 'surface.decision.timeline',
        nodeId: 'node.decision.timeline.root',
        title: 'Decisions over time',
        dateFieldId: 'field.decision.decidedDate',
        endDateFieldId: 'field.decision.reviewDate',
        titleFieldId: 'field.decision.title',
        accentFieldId: 'field.decision.state',
        fields: ['field.decision.owner'],
      },
    },
  );
}

interface FixtureSurfaces {
  formTitle: string;
  listTitle: string;
  boardTitle: string;
  formFields: string[];
  listFields: string[];
  groupField: string;
  cardFields: string[];
  groups: string[];
  command: { nodeId: string; label: string; fieldId: string; value: unknown };
  timeline?: {
    surfaceId: string;
    nodeId: string;
    title: string;
    dateFieldId: string;
    endDateFieldId?: string;
    titleFieldId?: string;
    accentFieldId?: string;
    fields: string[];
  };
  gallery?: {
    surfaceId: string;
    nodeId: string;
    title: string;
    titleFieldId?: string;
    accentFieldId?: string;
    fields: string[];
  };
}

// One authored shape drives both the stored nodes and the compiled tree, so the
// double cannot describe a surface the stored definition does not contain.
function fixture(
  fileName: string,
  entity: EntitySnapshot,
  records: RecordSnapshot[],
  surfaceIds: [string, string, string],
  nodeIds: [string, string, string],
  surfaces: FixtureSurfaces,
): PreviewFixture {
  const uiNodes: UiNodeSnapshot[] = [];
  const roots: SurfaceNodePlan[] = [];

  const child = (surfaceId: string, parentNodeId: string, nodeId: string, kind: string, position: number,
    properties: Record<string, unknown>): SurfaceNodePlan => {
    uiNodes.push({ surfaceId, nodeId, parentNodeId, kind, position, properties });
    return { semanticId: nodeId, automationTarget: automationTarget(nodeId), kind, properties, children: [] };
  };

  const root = (surfaceId: string, nodeId: string, kind: string, title: string,
    extra: Record<string, unknown>, children: SurfaceNodePlan[] = []): void => {
    const properties = { definitionVersion: 3, entityId: entity.entityId, title, ...extra };
    uiNodes.push({ surfaceId, nodeId, parentNodeId: null, kind, position: 0, properties });
    roots.push({ semanticId: nodeId, automationTarget: automationTarget(nodeId), kind, properties, children });
  };

  const bindings = (surfaceId: string, nodeId: string, fieldIds: string[]): SurfaceNodePlan[] =>
    fieldIds.map((fieldId, position) =>
      child(surfaceId, nodeId, `${nodeId}.binding.${position}`, 'fieldBinding', position, { fieldId }));

  root(surfaceIds[0], nodeIds[0], 'recordForm', surfaces.formTitle, {},
    bindings(surfaceIds[0], nodeIds[0], surfaces.formFields));
  root(surfaceIds[1], nodeIds[1], 'recordList', surfaces.listTitle, {},
    bindings(surfaceIds[1], nodeIds[1], surfaces.listFields));
  // Version 3 takes card fields from ordered fieldBinding children only.
  root(surfaceIds[2], nodeIds[2], 'boardSurface', surfaces.boardTitle, { groupByFieldId: surfaces.groupField },
    bindings(surfaceIds[2], nodeIds[2], surfaces.cardFields));
  const timeline = surfaces.timeline;
  if (timeline !== undefined) {
    const extra: Record<string, unknown> = { dateFieldId: timeline.dateFieldId };
    if (timeline.endDateFieldId !== undefined) extra.endDateFieldId = timeline.endDateFieldId;
    if (timeline.titleFieldId !== undefined) extra.titleFieldId = timeline.titleFieldId;
    if (timeline.accentFieldId !== undefined) extra.accentFieldId = timeline.accentFieldId;
    root(timeline.surfaceId, timeline.nodeId, 'timelineSurface', timeline.title, extra,
      bindings(timeline.surfaceId, timeline.nodeId, timeline.fields));
  }

  const gallery = surfaces.gallery;
  if (gallery !== undefined) {
    const extra: Record<string, unknown> = {};
    if (gallery.titleFieldId !== undefined) extra.titleFieldId = gallery.titleFieldId;
    if (gallery.accentFieldId !== undefined) extra.accentFieldId = gallery.accentFieldId;
    root(gallery.surfaceId, gallery.nodeId, 'gallerySurface', gallery.title, extra,
      bindings(gallery.surfaceId, gallery.nodeId, gallery.fields));
  }

  const commandSurfaceId = `${surfaceIds[2]}.commands`;
  const command = surfaces.command;
  const step = child(commandSurfaceId, command.nodeId, `${command.nodeId}.step`, 'commandStep', 0,
    { fieldId: command.fieldId, valueKind: 'literal', value: command.value });
  uiNodes.push({ surfaceId: commandSurfaceId, nodeId: command.nodeId, parentNodeId: null, kind: 'recordCommand',
    position: 0, properties: { definitionVersion: 3, entityId: entity.entityId, label: command.label } });
  roots.push({
    semanticId: command.nodeId,
    automationTarget: automationTarget(command.nodeId),
    kind: 'recordCommand',
    properties: { definitionVersion: 3, entityId: entity.entityId, label: command.label },
    children: [step],
  });

  const plan: ApplicationPlan = {
    contractVersion: 3,
    applicationId: 'preview',
    definitionRevision: 1,
    dataRevision: records.length,
    digest: `preview-${entity.entityId}`,
    entity: {
      semanticId: entity.entityId,
      automationTarget: automationTarget(entity.entityId),
      displayName: entity.displayName,
      fields: entity.fields.map((candidate) => ({
        semanticId: candidate.fieldId,
        automationTarget: automationTarget(candidate.fieldId),
        displayName: candidate.displayName,
        storageKind: candidate.storageKind,
        required: candidate.required,
        presentation: candidate.presentation,
        options: [...candidate.options],
      })),
    },
    surfaces: roots,
    records: records.map(recordPlan),
  };
  return { fileName, entity, records, uiNodes, plan };
}

function field(
  fieldId: string,
  displayName: string,
  storageKind: string,
  required: boolean,
  presentation: string,
  options: string[] = [],
): EntitySnapshot['fields'][number] {
  return { fieldId, displayName, storageKind, required, presentation, options };
}

function record(entityId: string, recordId: string, values: Record<string, unknown>): RecordSnapshot {
  return { entityId, recordId, recordVersion: 1, values };
}

function recordPlan(value: RecordSnapshot): RecordPlan {
  return {
    semanticId: value.recordId,
    automationTarget: automationTarget(value.recordId),
    version: value.recordVersion,
    values: structuredClone(value.values),
  };
}



function automationTarget(semanticId: string): string {
  return semanticId.replaceAll('.', '-').replaceAll('_', '-');
}
