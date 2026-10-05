// The Flow app as canonical operations: record types, the actions that route a run,
// the screens and the sample flow. Build-Flow.mjs sends these through MCP; the Engine's
// FlowAppTests installs the same operations from flow-app.operations.json, which
// `node definition.mjs --write` regenerates and definition.test.mjs keeps current.
import fs from 'node:fs/promises';
import path from 'node:path';
import { sample } from '../../extensions/flow/model.mjs';

const op = (operationType, payload) => ({ operationType, payload });
export const PACKAGE_ID = 'org.nendo.flow';
export const WRONG_EDGE = 'That edge does not leave the step this run is on.';
export const WRONG_START = 'A run begins on the edge that leaves the Start of its own flow.';
export const DIRECT_MOVE = 'Nendo moves a run. Choose an edge in fl.run.choice instead of writing its step.';
export const FIXED_STEP = 'A step keeps its key and kind once it is drawn, because edges and runs name it by key. Add a new step instead.';

// [key, display name, storage kind, required, presentation, options]
export const entities = [
  { id: 'fl.flow', name: 'Flows', label: 'name', kept: true, fields: [
    ['name', 'Name', 'Text', true], ['key', 'Key', 'Text', true], ['purpose', 'Purpose', 'Text', false, 'longText'],
  ], unique: ['key'] },
  { id: 'fl.step', name: 'Steps', label: 'name', kept: true, fields: [
    ['name', 'Name', 'Text', true], ['key', 'Key', 'Text', true], ['flow', 'Flow', 'Reference', true],
    ['kind', 'Kind', 'Text', true, 'singleChoice', ['Start', 'Step', 'End']],
    ['instructions', 'Instructions', 'Text', false, 'longText'], ['doneWhen', 'Done when', 'Text', false, 'longText'],
    ['x', 'X', 'Decimal', true], ['y', 'Y', 'Decimal', true],
  ], refs: [['flow', 'fl.flow']], unique: ['key'] },
  { id: 'fl.edge', name: 'Edges', label: 'outcome', kept: true, fields: [
    ['outcome', 'Outcome', 'Text', true], ['flow', 'Flow', 'Reference', true],
    ['from', 'From', 'Reference', true], ['to', 'To', 'Reference', true], ['when', 'Choose when', 'Text', false, 'longText'],
    ['fromKey', 'From key', 'Text', false], ['toKey', 'To key', 'Text', false],
    ['fromKind', 'From kind', 'Text', false], ['toKind', 'To kind', 'Text', false], ['flowKey', 'Flow key', 'Text', false],
  ], refs: [['flow', 'fl.flow'], ['from', 'fl.step'], ['to', 'fl.step']] },
  { id: 'fl.run', name: 'Runs', label: 'title', kept: false, fields: [
    ['title', 'Title', 'Text', true], ['flow', 'Flow', 'Reference', true], ['choice', 'Chosen edge', 'Reference', true],
    ['currentKey', 'Current step', 'Text', false], ['status', 'Status', 'Text', false, 'singleChoice', ['Running', 'Finished']],
    ['path', 'Path', 'Text', false, 'longText'], ['notes', 'Notes', 'Text', false, 'longText'],
  ], refs: [['flow', 'fl.flow'], ['choice', 'fl.edge']] },
];

const text = (bindingId, entityId, fieldId, nullable) =>
  ({ bindingId, kind: 'SameRecordField', entityId, fieldId, resultType: 'Text', nullable });
const hop = (bindingId, entityId, referenceFieldId, relatedEntityId, fieldId, nullable) =>
  ({ bindingId, kind: 'ReferenceTraversal', entityId, referenceFieldId, relatedEntityId, fieldId, resultType: 'Text', nullable });
const assign = (fieldId, expression, bindings) => ({ fieldId, expression, bindings, callAliases: [] });
const action = (definitionId, displayName, stepId, assignments) => op('behaviour.setDefinition', {
  definitionId, definitionKind: 'Action',
  body: { displayName, steps: [{ stepId, kind: 'SetField', target: { kind: 'EventRecord' }, assignments }] },
});
const trigger = (definitionId, entityId, displayName, events, actionId, relevantFieldIds) => op('behaviour.setDefinition', {
  definitionId, definitionKind: 'Trigger',
  body: { entityId, displayName, events, actionId, relevantFieldIds, conditionBindings: [], callAliases: [] },
});

// The edge, the run's flow and the step it is on, as the run's own actions read them.
const runReads = {
  edgeFrom: hop('edgeFrom', 'fl.run', 'fl.run.choice', 'fl.edge', 'fl.edge.fromKey', true),
  edgeTo: hop('edgeTo', 'fl.run', 'fl.run.choice', 'fl.edge', 'fl.edge.toKey', true),
  fromKind: hop('fromKind', 'fl.run', 'fl.run.choice', 'fl.edge', 'fl.edge.fromKind', true),
  toKind: hop('toKind', 'fl.run', 'fl.run.choice', 'fl.edge', 'fl.edge.toKind', true),
  edgeFlow: hop('edgeFlow', 'fl.run', 'fl.run.choice', 'fl.edge', 'fl.edge.flowKey', true),
  runFlow: hop('runFlow', 'fl.run', 'fl.run.flow', 'fl.flow', 'fl.flow.key', false),
  current: text('current', 'fl.run', 'fl.run.currentKey', true),
  path: text('path', 'fl.run', 'fl.run.path', true),
};
const status = assign('fl.run.status', "toKind == 'End' ? 'Finished' : 'Running'", [runReads.toKind]);

export function behaviourOperations() {
  const { edgeFrom, edgeTo, fromKind, edgeFlow, runFlow, current, path } = runReads;
  return [
    // An edge keeps its ends' keys and kinds as text, because a formula compares text
    // and never a reference.
    action('fl.edge.copyEnds', 'Copy the keys and kinds of the steps an edge joins', '10-ends', [
      assign('fl.edge.fromKey', 'v', [hop('v', 'fl.edge', 'fl.edge.from', 'fl.step', 'fl.step.key', false)]),
      assign('fl.edge.fromKind', 'v', [hop('v', 'fl.edge', 'fl.edge.from', 'fl.step', 'fl.step.kind', false)]),
      assign('fl.edge.toKey', 'v', [hop('v', 'fl.edge', 'fl.edge.to', 'fl.step', 'fl.step.key', false)]),
      assign('fl.edge.toKind', 'v', [hop('v', 'fl.edge', 'fl.edge.to', 'fl.step', 'fl.step.kind', false)]),
      assign('fl.edge.flowKey', 'v', [hop('v', 'fl.edge', 'fl.edge.flow', 'fl.flow', 'fl.flow.key', false)]),
    ]),
    trigger('fl.edge.whenDrawn', 'fl.edge', 'Copy the ends when an edge is drawn or redrawn', 'Created, Updated', 'fl.edge.copyEnds',
      ['fl.edge.from', 'fl.edge.to', 'fl.edge.flow']),

    // A run begins on the edge that leaves its flow's Start.
    action('fl.run.begin', 'Begin a run on the edge leaving the Start', '10-begin', [
      assign('fl.run.currentKey', `(fromKind == 'Start' and edgeFlow == runFlow) ? edgeTo : Refuse('${WRONG_START}')`,
        [fromKind, edgeFlow, runFlow, edgeTo]),
      assign('fl.run.path', 'current', [current]),
      status,
    ]),
    trigger('fl.run.whenCreated', 'fl.run', 'Begin a run when it is created', 'Created', 'fl.run.begin', []),

    // A run moves only along an edge that leaves the step it is on.
    action('fl.run.advance', 'Move a run along the chosen edge', '10-advance', [
      assign('fl.run.currentKey', `(edgeFrom == current and edgeFlow == runFlow) ? edgeTo : Refuse('${WRONG_EDGE}')`,
        [edgeFrom, current, edgeFlow, runFlow, edgeTo]),
      assign('fl.run.path', "Concat(path, ' › ', current)", [path, current]),
      status,
    ]),
    // The guard sorts before the move, so a write that sets a step and an edge together
    // meets it first: the step must be where the edge leads, and the move then needs the
    // edge to leave that same step.
    action('fl.run.hold', 'Keep a run on the step its edge leads to', '10-hold', [
      assign('fl.run.currentKey', `current == edgeTo ? current : Refuse('${DIRECT_MOVE}')`, [current, edgeTo]),
      status,
    ]),
    trigger('fl.run.a-whenStepWritten', 'fl.run', 'Refuse a step written by hand', 'Updated', 'fl.run.hold',
      ['fl.run.currentKey', 'fl.run.status']),
    trigger('fl.run.b-whenEdgeChosen', 'fl.run', 'Move a run when an edge is chosen', 'Updated', 'fl.run.advance', ['fl.run.choice']),

    // Edges and runs name a step by key, so its key and kind stay as drawn.
    action('fl.step.keep', 'Keep a step’s key and kind', '10-keep', [
      assign('fl.step.key', `key == key ? Refuse('${FIXED_STEP}') : key`, [text('key', 'fl.step', 'fl.step.key', false)]),
    ]),
    trigger('fl.step.whenRekeyed', 'fl.step', 'Refuse a changed key or kind', 'Updated', 'fl.step.keep', ['fl.step.key', 'fl.step.kind']),
  ];
}

export const PURPOSE = [
  'Repeatable procedures an agent walks one step at a time. A flow is Steps joined by Edges, drawn in the Flow screen. A Run is one walk through a flow, and Nendo holds where it is.',
  'To walk a flow over MCP: create a fl.run with a title, its flow and fl.run.choice = the edge leaving the flow\'s Start step; Nendo sets fl.run.currentKey. Read the fl.step with that key, do its instructions until its "Done when" holds, then set fl.run.choice to the fl.edge leaving that step whose "Choose when" matches. Nendo moves the run, or refuses an edge that does not leave its step and changes nothing. Repeat until fl.run.status is Finished.',
  'Never write fl.run.currentKey, fl.run.path or fl.run.status: Nendo writes them, and refuses a step written by hand. History holds every move.',
].join('\n\n');

export function definitionOperations() {
  const ops = [op('application.setPurpose', { purpose: PURPOSE }), op('application.setNewFileLabel', { label: 'flow library' })];
  for (const e of entities) {
    ops.push(op('schema.createEntity', { entityId: e.id, displayName: e.name }));
    for (const [key, name, kind = 'Text', required = false, presentation = 'singleLine', options = []] of e.fields) {
      ops.push(op('schema.addField', { entityId: e.id, fieldId: `${e.id}.${key}`, displayName: name, storageKind: kind, required,
        presentation: kind === 'Text' ? presentation : null, options }));
    }
    for (const [key, target] of e.refs ?? []) {
      const label = entities.find(t => t.id === target).label;
      ops.push(op('schema.configureReference', { entityId: e.id, fieldId: `${e.id}.${key}`, targetEntityId: target, labelFieldId: `${target}.${label}` }));
    }
    for (const key of e.unique ?? []) ops.push(op('schema.setFieldUnique', { entityId: e.id, fieldId: `${e.id}.${key}`, unique: true }));
    // Left out is the default, and saying it again is refused.
    if (e.kept) ops.push(op('schema.setKeptInNewFiles', { entityId: e.id, kept: true }));
  }
  ops.push(...behaviourOperations());
  ops.push(op('ui.addNode', { surfaceId: 'flow', nodeId: 'fl.screen.editor', parentNodeId: null, kind: 'extensionView', position: 0,
    properties: { definitionVersion: 3, title: 'Flow', packageId: PACKAGE_ID, opensFile: true } }));
  const columns = { 'fl.flow': ['name', 'key'], 'fl.step': ['name', 'key', 'kind'], 'fl.edge': ['outcome', 'fromKey', 'toKey'], 'fl.run': ['title', 'status', 'currentKey'] };
  entities.forEach((e, index) => {
    const nodeId = `${e.id}.list`;
    ops.push(op('ui.addNode', { surfaceId: 'flow', nodeId, parentNodeId: null, kind: 'recordList', position: index + 1,
      properties: { definitionVersion: 3, entityId: e.id, title: e.name } }));
    columns[e.id].forEach((key, position) => ops.push(op('ui.addNode', { surfaceId: 'flow', nodeId: `${nodeId}.${key}`, parentNodeId: nodeId,
      kind: 'fieldBinding', position, properties: { fieldId: `${e.id}.${key}` } })));
  });
  return ops;
}

/** The sample flow's records. Each edge carries its ends' keys already, so it reads right before any action runs. */
export function seedRecords() {
  const flow = sample(), byId = new Map(flow.steps.map(step => [step.id, step]));
  return [
    { entityId: 'fl.flow', recordId: flow.id, values: { 'fl.flow.name': flow.name, 'fl.flow.key': flow.key, 'fl.flow.purpose': flow.purpose } },
    ...flow.steps.map(s => ({ entityId: 'fl.step', recordId: s.id, values: {
      'fl.step.name': s.name, 'fl.step.key': s.key, 'fl.step.flow': flow.id, 'fl.step.kind': s.kind,
      'fl.step.instructions': s.instructions, 'fl.step.doneWhen': s.doneWhen, 'fl.step.x': s.x, 'fl.step.y': s.y,
    }, targets: { 'fl.step.flow': 1 } })),
    ...flow.edges.map(e => ({ entityId: 'fl.edge', recordId: e.id, values: {
      'fl.edge.outcome': e.outcome, 'fl.edge.flow': flow.id, 'fl.edge.from': e.from, 'fl.edge.to': e.to, 'fl.edge.when': e.when,
      'fl.edge.fromKey': byId.get(e.from).key, 'fl.edge.toKey': byId.get(e.to).key,
      'fl.edge.fromKind': byId.get(e.from).kind, 'fl.edge.toKind': byId.get(e.to).kind, 'fl.edge.flowKey': flow.key,
    }, targets: { 'fl.edge.flow': 1, 'fl.edge.from': 1, 'fl.edge.to': 1 } })),
  ];
}

export const seedOperations = () => seedRecords().map(({ entityId, recordId, values, targets }) =>
  op('data.createRecord', { entityId, recordId, values, expectedTargetVersions: targets ?? {} }));

/**
 * The file as the fixture broker serves it to the view: the schema, the sample flow and one run
 * part-way through it. The broker runs no actions, so the run carries the step and path Nendo
 * would have written.
 */
export function fixture() {
  const schema = { entities: entities.map(e => ({ entityId: e.id, displayName: e.name, hierarchy: null,
    fields: e.fields.map(([key, name, kind = 'Text', required = false, presentation = 'singleLine', options = []]) => {
      const target = (e.refs ?? []).find(([k]) => k === key)?.[1];
      return { fieldId: `${e.id}.${key}`, displayName: name, storageKind: kind.toLowerCase(), required,
        presentation: kind === 'Text' ? presentation : null, calculated: false, scale: null,
        choices: options.map(id => ({ id, displayName: id, retired: false, tone: null })),
        reference: target ? { targetEntityId: target, labelFieldId: `${target}.${entities.find(t => t.id === target).label}` } : null };
    }) })) };
  const records = Object.fromEntries(entities.map(e => [e.id, []]));
  for (const r of seedRecords()) records[r.entityId].push({ entityId: r.entityId, recordId: r.recordId, values: r.values, version: 1, labels: {} });
  records['fl.run'].push({ entityId: 'fl.run', recordId: 'fl_run_fixture', version: 3, labels: {}, values: {
    'fl.run.title': 'Fixture walk', 'fl.run.flow': 'fl_flow_defect', 'fl.run.choice': 'fl_edge_defect_locate_fix',
    'fl.run.currentKey': 'defect.fix', 'fl.run.status': 'Running', 'fl.run.path': 'defect.locate › defect.fix', 'fl.run.notes': null } });
  return { changeSequence: 1, schema, records, context: { viewId: 'fl.screen.editor', kind: 'extensionView', placement: 'screen', title: 'Flow',
    entityId: null, recordId: null, bindings: { labelFieldId: null, statusFieldId: null, fields: [], filters: [] }, theme: 'light' } };
}

export const FIXTURE = path.join(import.meta.dirname, 'flow-app.operations.json');
export const fixtureText = () => JSON.stringify({ definition: definitionOperations(), seed: seedOperations() }, null, 1) + '\n';

if (process.argv.includes('--write')) {
  await fs.writeFile(FIXTURE, fixtureText());
  console.log(`Wrote ${path.relative(process.cwd(), FIXTURE)}: ${definitionOperations().length} definition and ${seedOperations().length} seed operations.`);
}
