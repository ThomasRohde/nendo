// Authors Nendo Station from an empty file, through the local MCP interface alone.
//
//   node tools/Build-NendoStation.mjs            the first stage not yet applied
//   node tools/Build-NendoStation.mjs schema-a   one named stage
//   node tools/Build-NendoStation.mjs --list     what the stages are
//
// The file is the output and this script is the source: when a surface slice
// lands, its screen is added here and the station is rebuilt. See
// docs/design/nendo-station-plan.md.
//
// One stage is one change set, validated into a proposal. This script never
// accepts one: it prints the exact title and stops, because acceptance is the
// person's act and the whole point of the review path. Each stage builds on the
// definition revision the last one left, so the next stage refuses until the
// previous proposal has been accepted.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import * as station from './station-data.mjs';

// The development planner. Authoring the station into it would be a bad day, so
// the identity is checked rather than trusted to whichever Nendo answered.
// NENDO_STATION_PLANNER_ID exists so that guard can be falsified without letting
// the script write anything: point it at an ID nothing has, run --dry-run, and
// watch the planner be selected by a build that stops before the lease.
const PLANNER_APPLICATION_ID =
  process.env.NENDO_STATION_PLANNER_ID || 'application-7efd926c073f4be9974be19bbc39ff41';

const op = (operationType, payload) => ({ operationType, payload });
const text = (entityId, fieldId, displayName, required = false, presentation = 'singleLine') =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation, options: [] });
const choice = (entityId, fieldId, displayName, options, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation: 'singleChoice', options });
const scalar = (kind, entityId, fieldId, displayName, required = false, presentation = null) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: kind, required, presentation, options: [] });
const reference = (entityId, fieldId, displayName, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Reference', required, presentation: null, options: [] });
const bind = (entityId, fieldId, targetEntityId, labelFieldId) =>
  op('schema.configureReference', { entityId, fieldId, targetEntityId, labelFieldId });
const tone = (entityId, fieldId, choiceId, toneName) =>
  op('schema.setChoiceMetadata', { entityId, fieldId, choiceId, displayName: choiceId, retired: false, tone: toneName });
const behaviour = (definitionId, definitionKind, body) =>
  op('behaviour.setDefinition', { definitionId, definitionKind, body });

// A calculation over stored fields of its own record, written once here because
// the station has nine of them and the envelope is the same every time.
const calculation = (definitionId, entityId, fieldId, displayName, resultType, expression, bindings, options = {}) =>
  behaviour(definitionId, 'Calculation', {
    entityId, fieldId, displayName, resultType,
    resultNullable: options.nullable ?? false,
    expression, bindings, callAliases: options.callAliases ?? [],
  });
const field = (bindingId, entityId, fieldId, resultType, nullable = false) =>
  ({ bindingId, kind: 'SameRecordField', entityId, fieldId, resultType, nullable });

// Screen nodes carry their position within their parent, which is a counter
// rather than something worth writing out forty times.
function tree(surfaceId) {
  const positions = new Map();
  const operations = [];
  const add = (nodeId, kind, parentNodeId, properties = {}) => {
    const key = parentNodeId ?? '';
    const position = positions.get(key) ?? 0;
    positions.set(key, position + 1);
    operations.push(op('ui.addNode', { surfaceId, nodeId, parentNodeId, kind, position, properties }));
    return nodeId;
  };
  const bindings = (parentNodeId, fieldIds) => {
    for (const fieldId of fieldIds) add(`${parentNodeId}.${fieldId}`, 'fieldBinding', parentNodeId, { fieldId });
  };
  // A call carries sixteen operations, so a screen of forty nodes is several
  // mutations. They are still one change set and one proposal.
  const asMutations = description => {
    const mutations = [];
    for (let start = 0; start < operations.length; start += 16) {
      const part = operations.slice(start, start + 16);
      mutations.push({
        description: operations.length > 16
          ? `${description} (${mutations.length + 1} of ${Math.ceil(operations.length / 16)})`
          : description,
        operations: part,
      });
    }
    return mutations;
  };
  return { add, bindings, operations, asMutations };
}

const SURFACE = 'station';

const PURPOSE = [
  'Nendo Station is a seven-module habitat in low orbit, crew of twelve, flying for about five',
  'years. This file runs it as a small operations room: what each system is made of, what feeds',
  'what, what was read off the instruments, what went wrong and what was done about it.',
  '',
  'It is fiction. The numbers are plausible and none of them is validated, nothing here models',
  'pressure, heat or flow, and no screen in it predicts a failure. Condition is what an operator',
  'recorded, not what a simulation concluded.',
  '',
  'It is also the fourth Nendo reference application, built from an empty file over MCP alone.',
  'Every kind of screen this host compiles is somewhere in it, each answering a question an',
  'operator would actually ask rather than standing in a gallery of features.',
].join('\n');

const STAGES = {
  'schema-a': {
    title: 'Nendo Station: the station and what it is made of',
    needs: [],
    makes: ['module', 'system', 'component', 'feed'],
    mutations: () => [
      {
        description: 'Say what this file is for',
        operations: [op('application.setPurpose', { purpose: PURPOSE })],
      },
      {
        description: 'Create the Module record type',
        operations: [
          op('schema.createEntity', { entityId: 'module', displayName: 'Modules' }),
          text('module', 'moduleName', 'Name', true),
          text('module', 'moduleDesignation', 'Designation'),
          scalar('Boolean', 'module', 'modulePressurised', 'Pressurised'),
          scalar('Decimal', 'module', 'moduleVolume', 'Volume (m3)'),
          scalar('Date', 'module', 'moduleCommissioned', 'Commissioned', false, 'date'),
        ],
      },
      {
        description: 'Create the System record type',
        operations: [
          op('schema.createEntity', { entityId: 'system', displayName: 'Systems' }),
          text('system', 'systemName', 'Name', true),
          text('system', 'systemCode', 'Code'),
          choice('system', 'systemCriticality', 'Criticality', ['Vital', 'Major', 'Minor'], true),
          choice('system', 'systemCondition', 'Condition', ['Nominal', 'Degraded', 'Offline', 'Maintenance'], true),
          reference('system', 'systemModule', 'Module'),
          scalar('Date', 'system', 'systemCommissioned', 'Commissioned', false, 'date'),
          scalar('Decimal', 'system', 'systemCapacity', 'Design capacity', true),
          scalar('Decimal', 'system', 'systemLoad', 'Current load', true),
          text('system', 'systemCapacityUnit', 'Capacity unit'),
          // Required so no formula that reads it has to cope with an empty
          // operand, and so the action has somewhere definite to write.
          scalar('Boolean', 'system', 'systemReviewFlag', 'Flagged for review', true),
          text('system', 'systemReviewNote', 'Review note', false, 'longText'),
        ],
      },
      {
        description: 'Create the Component record type',
        operations: [
          op('schema.createEntity', { entityId: 'component', displayName: 'Components' }),
          text('component', 'componentName', 'Name', true),
          // The schematic label is what the custom view is allowed to read. The
          // convention SYSTEM . Name is between this file and the package; the
          // host discloses a label and one status and nothing else.
          text('component', 'componentSchematicLabel', 'Schematic label', true),
          reference('component', 'componentSystem', 'System', true),
          choice('component', 'componentKind', 'Kind',
            ['Pump', 'Valve', 'Filter', 'Sensor', 'Radiator', 'Cell', 'Controller', 'Tank'], true),
          choice('component', 'componentState', 'State', ['Online', 'Standby', 'Offline', 'Removed'], true),
          scalar('Date', 'component', 'componentInstalled', 'Installed', false, 'date'),
          scalar('Integer', 'component', 'componentServiceInterval', 'Service interval (days)'),
          scalar('Date', 'component', 'componentLastServiced', 'Last serviced', false, 'date'),
          scalar('Date', 'component', 'componentNextServiceDue', 'Next service due', false, 'date'),
          text('component', 'componentSerial', 'Serial'),
        ],
      },
      {
        description: 'Create the Feed record type, which is the graph edge',
        operations: [
          op('schema.createEntity', { entityId: 'feed', displayName: 'Feeds' }),
          reference('feed', 'feedFrom', 'Feeds from', true),
          reference('feed', 'feedTo', 'Feeds into', true),
          choice('feed', 'feedKind', 'Carries', ['Power', 'Coolant', 'Air', 'Water', 'Data'], true),
          scalar('Boolean', 'feed', 'feedRedundant', 'Declared backup path', true),
          text('feed', 'feedNote', 'Note', false, 'longText'),
        ],
      },
      {
        description: 'Point the references at what they name',
        operations: [
          bind('system', 'systemModule', 'module', 'moduleName'),
          bind('component', 'componentSystem', 'system', 'systemName'),
          bind('feed', 'feedFrom', 'component', 'componentName'),
          bind('feed', 'feedTo', 'component', 'componentName'),
        ],
      },
      {
        description: 'Colour the system options',
        operations: [
          tone('system', 'systemCriticality', 'Vital', 'red'),
          tone('system', 'systemCriticality', 'Major', 'amber'),
          tone('system', 'systemCriticality', 'Minor', 'blue'),
          tone('system', 'systemCondition', 'Nominal', 'green'),
          tone('system', 'systemCondition', 'Degraded', 'amber'),
          tone('system', 'systemCondition', 'Offline', 'red'),
          tone('system', 'systemCondition', 'Maintenance', 'violet'),
        ],
      },
      {
        description: 'Colour the component and feed options',
        operations: [
          tone('component', 'componentState', 'Online', 'green'),
          tone('component', 'componentState', 'Standby', 'blue'),
          tone('component', 'componentState', 'Offline', 'red'),
          tone('component', 'componentState', 'Removed', 'grey'),
          tone('feed', 'feedKind', 'Power', 'amber'),
          tone('feed', 'feedKind', 'Coolant', 'teal'),
          tone('feed', 'feedKind', 'Air', 'blue'),
          tone('feed', 'feedKind', 'Water', 'violet'),
          tone('feed', 'feedKind', 'Data', 'grey'),
        ],
      },
    ],
  },

  'schema-b': {
    title: 'Nendo Station: what happens on it',
    needs: ['system', 'component'],
    makes: ['reading', 'incident', 'maintenance'],
    mutations: () => [
      {
        description: 'Create the Reading record type',
        operations: [
          op('schema.createEntity', { entityId: 'reading', displayName: 'Readings' }),
          reference('reading', 'readingSystem', 'System', true),
          scalar('Date', 'reading', 'readingTaken', 'Taken', true, 'date'),
          choice('reading', 'readingMetric', 'Metric',
            ['Pressure', 'Temperature', 'Oxygen', 'Carbon dioxide', 'Power draw', 'Water'], true),
          scalar('Decimal', 'reading', 'readingValue', 'Value', true),
          text('reading', 'readingUnit', 'Unit'),
          // Stored rather than worked out: a limit is an operator's judgement,
          // and FilteredCount counts a Boolean that is true.
          scalar('Boolean', 'reading', 'readingOutOfLimits', 'Outside limits', true),
        ],
      },
      {
        description: 'Create the Incident record type',
        operations: [
          op('schema.createEntity', { entityId: 'incident', displayName: 'Incidents' }),
          text('incident', 'incidentTitle', 'Title', true),
          // Required because the action follows it. An empty reference names no
          // record: the step would write nothing and the save would still commit.
          reference('incident', 'incidentSystem', 'System', true),
          reference('incident', 'incidentComponent', 'Component'),
          scalar('Date', 'incident', 'incidentRaised', 'Raised', true, 'date'),
          scalar('Date', 'incident', 'incidentResolved', 'Resolved', false, 'date'),
          choice('incident', 'incidentSeverity', 'Severity', ['Routine', 'Elevated', 'Critical'], true),
          choice('incident', 'incidentStatus', 'Status', ['Open', 'Contained', 'Resolved', 'Stood down'], true),
          text('incident', 'incidentSummary', 'Summary', false, 'longText'),
        ],
      },
      {
        description: 'Create the Maintenance record type',
        operations: [
          op('schema.createEntity', { entityId: 'maintenance', displayName: 'Maintenance' }),
          text('maintenance', 'taskTitle', 'Title', true),
          reference('maintenance', 'taskComponent', 'Component', true),
          choice('maintenance', 'taskKind', 'Kind', ['Inspection', 'Replace', 'Calibrate', 'Clean'], true),
          scalar('Date', 'maintenance', 'taskOpened', 'Opened', false, 'date'),
          scalar('Date', 'maintenance', 'taskDue', 'Due', false, 'date'),
          scalar('Date', 'maintenance', 'taskCompleted', 'Completed', false, 'date'),
          choice('maintenance', 'taskStatus', 'Status', ['Scheduled', 'In progress', 'Done', 'Deferred'], true),
          // Required because a Sum over it is an error on a member with no
          // value, not a zero.
          scalar('Decimal', 'maintenance', 'taskHours', 'Hours', true),
        ],
      },
      {
        description: 'Point the references at what they name',
        operations: [
          bind('reading', 'readingSystem', 'system', 'systemName'),
          bind('incident', 'incidentSystem', 'system', 'systemName'),
          bind('incident', 'incidentComponent', 'component', 'componentName'),
          bind('maintenance', 'taskComponent', 'component', 'componentName'),
        ],
      },
      {
        description: 'Colour the incident options',
        operations: [
          tone('incident', 'incidentSeverity', 'Routine', 'blue'),
          tone('incident', 'incidentSeverity', 'Elevated', 'amber'),
          tone('incident', 'incidentSeverity', 'Critical', 'red'),
          tone('incident', 'incidentStatus', 'Open', 'red'),
          tone('incident', 'incidentStatus', 'Contained', 'amber'),
          tone('incident', 'incidentStatus', 'Resolved', 'green'),
          tone('incident', 'incidentStatus', 'Stood down', 'grey'),
        ],
      },
      {
        description: 'Colour the maintenance options',
        operations: [
          tone('maintenance', 'taskStatus', 'Scheduled', 'blue'),
          tone('maintenance', 'taskStatus', 'In progress', 'violet'),
          tone('maintenance', 'taskStatus', 'Done', 'green'),
          tone('maintenance', 'taskStatus', 'Deferred', 'grey'),
        ],
      },
    ],
  },

  'schema-c': {
    title: 'Nendo Station: crew and experiments',
    needs: ['module', 'system'],
    makes: ['crew', 'experiment'],
    mutations: () => [
      {
        description: 'Create the Crew record type',
        operations: [
          op('schema.createEntity', { entityId: 'crew', displayName: 'Crew' }),
          text('crew', 'crewName', 'Name', true),
          choice('crew', 'crewRole', 'Role',
            ['Commander', 'Flight engineer', 'Scientist', 'Medical officer'], true),
          scalar('Date', 'crew', 'crewRotationStart', 'Rotation starts', false, 'date'),
          scalar('Date', 'crew', 'crewRotationEnd', 'Rotation ends', false, 'date'),
          text('crew', 'crewCallsign', 'Callsign'),
        ],
      },
      {
        description: 'Create the Experiment record type',
        operations: [
          op('schema.createEntity', { entityId: 'experiment', displayName: 'Experiments' }),
          text('experiment', 'experimentTitle', 'Title', true),
          reference('experiment', 'experimentLead', 'Lead'),
          reference('experiment', 'experimentModule', 'Module'),
          reference('experiment', 'experimentSystem', 'Draws on'),
          scalar('Date', 'experiment', 'experimentStart', 'Starts', false, 'date'),
          scalar('Date', 'experiment', 'experimentEnd', 'Ends', false, 'date'),
          choice('experiment', 'experimentStatus', 'Status',
            ['Proposed', 'Running', 'Complete', 'Halted'], true),
          scalar('Decimal', 'experiment', 'experimentPower', 'Power draw (W)', true),
          op('schema.addField', {
            entityId: 'experiment', fieldId: 'experimentPriority', displayName: 'Priority',
            storageKind: 'Integer', required: false, presentation: 'rating', options: [], min: 1, max: 5,
          }),
        ],
      },
      {
        description: 'Point the references at what they name',
        operations: [
          bind('experiment', 'experimentLead', 'crew', 'crewName'),
          bind('experiment', 'experimentModule', 'module', 'moduleName'),
          bind('experiment', 'experimentSystem', 'system', 'systemName'),
        ],
      },
      {
        description: 'Colour the crew and experiment options',
        operations: [
          tone('crew', 'crewRole', 'Commander', 'violet'),
          tone('crew', 'crewRole', 'Flight engineer', 'amber'),
          tone('crew', 'crewRole', 'Scientist', 'teal'),
          tone('crew', 'crewRole', 'Medical officer', 'blue'),
          tone('experiment', 'experimentStatus', 'Proposed', 'grey'),
          tone('experiment', 'experimentStatus', 'Running', 'green'),
          tone('experiment', 'experimentStatus', 'Complete', 'blue'),
          tone('experiment', 'experimentStatus', 'Halted', 'red'),
        ],
      },
    ],
  },

  behaviour: {
    title: 'Nendo Station: what it works out for itself',
    needs: ['system', 'component', 'incident', 'maintenance', 'reading', 'experiment'],
    makes: [],
    mutations: () => [
      {
        description: 'A percentage, written once and called twice',
        operations: [
          behaviour('fn.percentOf', 'Function', {
            displayName: 'Percent of',
            parameters: [
              { parameterId: 'part', displayName: 'Part', parameterType: 'Decimal', nullable: false },
              { parameterId: 'whole', displayName: 'Whole', parameterType: 'Decimal', nullable: false },
            ],
            resultType: 'Decimal',
            resultNullable: false,
            expression: 'RoundEven(part / whole * 100, 2)',
            callAliases: [],
          }),
        ],
      },
      {
        description: 'What a system has left, and how hard it is working',
        operations: [
          calculation('system.headroom', 'system', 'systemHeadroom', 'Headroom', 'Decimal',
            'capacity - load', [
              field('capacity', 'system', 'systemCapacity', 'Decimal'),
              field('load', 'system', 'systemLoad', 'Decimal'),
            ]),
          // A system with no recorded capacity declines to invent a percentage,
          // in its own sentence, rather than borrowing a division error to say so.
          calculation('system.loadPercent', 'system', 'systemLoadPercent', 'Load', 'Decimal',
            "capacity == 0 ? Refuse('This system records no design capacity, so a load percentage would be invented.') : PercentOf(load, capacity)",
            [
              field('capacity', 'system', 'systemCapacity', 'Decimal'),
              field('load', 'system', 'systemLoad', 'Decimal'),
            ],
            { callAliases: [{ alias: 'PercentOf', functionId: 'fn.percentOf' }] }),
        ],
      },
      {
        description: 'What a system is carrying from elsewhere',
        operations: [
          calculation('system.openIncidents', 'system', 'systemOpenIncidents', 'Incidents', 'Integer',
            'incidents', [{
              bindingId: 'incidents', kind: 'RelatedAggregate', aggregate: 'Count',
              entityId: 'system', relatedEntityId: 'incident', relatedReferenceFieldId: 'incidentSystem',
              resultType: 'Integer', nullable: false,
            }]),
          calculation('system.outOfLimitReadings', 'system', 'systemOutOfLimits', 'Readings outside limits', 'Integer',
            'outside', [{
              bindingId: 'outside', kind: 'RelatedAggregate', aggregate: 'FilteredCount',
              entityId: 'system', relatedEntityId: 'reading', relatedReferenceFieldId: 'readingSystem',
              predicateFieldId: 'readingOutOfLimits', resultType: 'Integer', nullable: false,
            }]),
          // Drives visibleWhen on the review note. The stored flag is what the
          // action writes and what a screen filters on; this reads both.
          calculation('system.underReview', 'system', 'systemUnderReview', 'Under review', 'Boolean',
            'flag or open > 0', [
              field('flag', 'system', 'systemReviewFlag', 'Boolean'),
              {
                bindingId: 'open', kind: 'SameRecordCalculation', entityId: 'system',
                calculationId: 'system.openIncidents', resultType: 'Integer', nullable: false,
              },
            ]),
        ],
      },
      {
        description: 'What a component and an incident each say about time',
        operations: [
          // There is no clock in a formula, so this is the window a person
          // recorded, not the days left in it. A screen answers that with today.
          calculation('component.serviceWindow', 'component', 'componentServiceWindow', 'Service window (days)', 'Integer',
            'DaysBetween(lastServiced, nextDue)', [
              field('lastServiced', 'component', 'componentLastServiced', 'Date', true),
              field('nextDue', 'component', 'componentNextServiceDue', 'Date', true),
            ], { nullable: true }),
          calculation('component.plannedHours', 'component', 'componentPlannedHours', 'Planned hours', 'Decimal',
            'hours', [{
              bindingId: 'hours', kind: 'RelatedAggregate', aggregate: 'Sum',
              entityId: 'component', relatedEntityId: 'maintenance', relatedReferenceFieldId: 'taskComponent',
              valueFieldId: 'taskHours', resultType: 'Decimal', nullable: false,
            }]),
          // Empty while an incident is open, which is the honest answer and not
          // a missing input: the declaration is what decides that.
          calculation('incident.daysToResolve', 'incident', 'incidentDaysToResolve', 'Days to resolve', 'Integer',
            'DaysBetween(raised, resolved)', [
              field('raised', 'incident', 'incidentRaised', 'Date'),
              field('resolved', 'incident', 'incidentResolved', 'Date', true),
            ], { nullable: true }),
        ],
      },
      {
        description: 'What an experiment takes from the system it draws on',
        operations: [
          calculation('experiment.powerShare', 'experiment', 'experimentPowerShare', 'Share of capacity', 'Decimal',
            "capacity == 0 ? Refuse('The system this experiment draws on records no design capacity.') : PercentOf(power, capacity)",
            [
              field('power', 'experiment', 'experimentPower', 'Decimal'),
              {
                bindingId: 'capacity', kind: 'ReferenceTraversal', entityId: 'experiment',
                referenceFieldId: 'experimentSystem', relatedEntityId: 'system', fieldId: 'systemCapacity',
                resultType: 'Decimal', nullable: true,
              },
            ],
            { nullable: true, callAliases: [{ alias: 'PercentOf', functionId: 'fn.percentOf' }] }),
        ],
      },
      {
        description: 'Flag a system for review when an incident against it changes',
        operations: [
          // It raises a flag. It does not set the condition, though the host
          // would let it: a condition is an operator's judgement, and an
          // application that downgraded a system because a ticket changed would
          // be making that judgement for them. A person lowers the flag again
          // with the Clear review flag command.
          behaviour('station.flagSystemForReview', 'Action', {
            displayName: 'Flag the system for review',
            steps: [{
              stepId: '10-flag',
              kind: 'SetField',
              target: { kind: 'ReferencedRecord', referenceFieldId: 'incidentSystem' },
              assignments: [{ fieldId: 'systemReviewFlag', expression: 'true', bindings: [], callAliases: [] }],
            }],
          }),
          behaviour('incident.onChanged', 'Trigger', {
            entityId: 'incident',
            displayName: 'Flag the system when an incident arrives or moves',
            events: 'Created,Updated',
            actionId: 'station.flagSystemForReview',
            relevantFieldIds: ['incidentSeverity', 'incidentStatus'],
            conditionBindings: [],
            callAliases: [],
          }),
        ],
      },
    ],
  },
};

STAGES['surfaces-a'] = {
  title: 'Nendo Station: the systems, seen five ways',
  needs: ['system'],
  makes: [],
  mutations: () => {
    const t = tree(SURFACE);

    const list = t.add('systemList', 'recordList', null, {
      definitionVersion: 3, entityId: 'system', title: 'Systems',
      orderByFieldId: 'systemName', orderDirection: 'ascending',
    });
    t.bindings(list, ['systemName', 'systemCode', 'systemCriticality', 'systemCondition',
      'systemModule', 'systemLoadPercent', 'systemHeadroom']);
    t.add('systemListCount', 'summaryTile', list, { aggregate: 'count', title: 'Systems' });
    t.add('systemListByCondition', 'breakdownChart', list,
      { aggregate: 'count', groupByFieldId: 'systemCondition', title: 'By condition' });

    const gallery = t.add('systemCards', 'gallerySurface', null, {
      definitionVersion: 3, entityId: 'system', title: 'System cards',
      titleFieldId: 'systemName', accentFieldId: 'systemCondition',
      orderByFieldId: 'systemName', orderDirection: 'ascending',
    });
    t.bindings(gallery, ['systemCode', 'systemModule', 'systemLoadPercent', 'systemHeadroom', 'systemIncidents']);

    const byModule = t.add('systemsByModule', 'boardSurface', null, {
      definitionVersion: 3, entityId: 'system', title: 'By module',
      groupByFieldId: 'systemModule', orderByFieldId: 'systemName', orderDirection: 'ascending',
    });
    t.bindings(byModule, ['systemName', 'systemCondition', 'systemLoadPercent']);

    const byCondition = t.add('systemsByCondition', 'boardSurface', null, {
      definitionVersion: 3, entityId: 'system', title: 'By condition',
      groupByFieldId: 'systemCondition', orderByFieldId: 'systemName', orderDirection: 'ascending',
    });
    t.bindings(byCondition, ['systemName', 'systemCriticality', 'systemModule']);
    t.add('systemsByConditionColumn', 'summaryTile', byCondition,
      { aggregate: 'count', title: 'In this condition', scope: 'group' });

    const matrix = t.add('systemMatrix', 'matrixSurface', null, {
      definitionVersion: 3, entityId: 'system', title: 'Condition by criticality',
      rowByFieldId: 'systemCondition', columnByFieldId: 'systemCriticality',
      orderByFieldId: 'systemName', orderDirection: 'ascending',
    });
    t.bindings(matrix, ['systemName', 'systemCode']);

    return [
      {
        description: 'Say what this file is for, with the years it has actually flown',
        operations: [op('application.setPurpose', { purpose: PURPOSE })],
      },
      {
        // Count has no filter and only FilteredCount reads a Boolean, so this
        // was never a count of open incidents: it counts every incident a
        // system has ever had. Under review therefore stood on a number that
        // never goes down, and a signal that is always on is not a signal. The
        // flag the action raises and a person lowers is the signal; the count
        // is history, and it is now named as history.
        description: 'Say what the incident count is, and let the flag be the signal',
        operations: [
          calculation('system.underReview', 'system', 'systemUnderReview', 'Under review', 'Boolean',
            'flag', [field('flag', 'system', 'systemReviewFlag', 'Boolean')]),
          op('behaviour.removeDefinition', { definitionId: 'system.openIncidents', definitionKind: 'Calculation' }),
          calculation('system.incidentCount', 'system', 'systemIncidents', 'Incidents', 'Integer',
            'incidents', [{
              bindingId: 'incidents', kind: 'RelatedAggregate', aggregate: 'Count',
              entityId: 'system', relatedEntityId: 'incident', relatedReferenceFieldId: 'incidentSystem',
              resultType: 'Integer', nullable: false,
            }]),
        ],
      },
      ...t.asMutations('Five ways to look at the systems'),
    ];
  },
  appliedWhen: async client => hasNode(client, 'systemList'),
};

STAGES['surfaces-b'] = {
  title: 'Nendo Station: the front page and the system page',
  needs: ['system', 'incident', 'reading', 'component', 'experiment', 'crew'],
  makes: [],
  mutations: () => {
    const t = tree(SURFACE);

    const front = t.add('front', 'overviewSurface', null, {
      definitionVersion: 3, title: 'Station status',
      description: 'How the station is today, and what has been happening to it.',
    });

    const now = t.add('frontNow', 'section', front, { title: 'Now' });
    t.add('frontSystemCount', 'summaryTile', now, { entityId: 'system', aggregate: 'count', title: 'Systems' });
    t.add('frontCrewCount', 'summaryTile', now, { entityId: 'crew', aggregate: 'count', title: 'Crew on the books' });
    const nominal = t.add('frontNominal', 'progressTile', now, { entityId: 'system', title: 'Nominal' });
    t.add('frontNominalClause', 'filterClause', nominal,
      { fieldId: 'systemCondition', operator: 'eq', valueKind: 'literal', value: 'Nominal' });
    t.add('frontByCondition', 'breakdownChart', now,
      { entityId: 'system', aggregate: 'count', groupByFieldId: 'systemCondition', title: 'Systems by condition' });
    t.add('frontBySeverity', 'breakdownChart', now,
      { entityId: 'incident', aggregate: 'count', groupByFieldId: 'incidentSeverity', title: 'Incidents by severity' });

    const watch = t.add('frontWatch', 'section', front, { title: 'Watch' });
    const openIncidents = t.add('frontOpenIncidents', 'summaryTile', watch,
      { entityId: 'incident', aggregate: 'count', title: 'Still open' });
    t.add('frontOpenIncidentsClause', 'filterClause', openIncidents,
      { fieldId: 'incidentStatus', operator: 'eq', valueKind: 'literal', value: 'Open' });
    const dueSoon = t.add('frontDue', 'summaryTile', watch,
      { entityId: 'maintenance', aggregate: 'count', title: 'Maintenance overdue' });
    t.add('frontDueClause', 'filterClause', dueSoon,
      { fieldId: 'taskDue', operator: 'lte', valueKind: 'today' });
    t.add('frontDueOpenClause', 'filterClause', dueSoon,
      { fieldId: 'taskStatus', operator: 'ne', valueKind: 'literal', value: 'Done' });
    const ranked = t.add('frontExperiments', 'rankedList', watch,
      { entityId: 'experiment', rankByFieldId: 'experimentPower', orderDirection: 'descending', limit: 5, title: 'Hungriest experiments' });
    t.bindings(ranked, ['experimentTitle', 'experimentStatus']);
    const recent = t.add('frontRecentIncidents', 'recentList', watch,
      { entityId: 'incident', title: 'Latest incidents', limit: 5, orderByFieldId: 'incidentRaised', orderDirection: 'descending' });
    t.bindings(recent, ['incidentTitle', 'incidentSeverity', 'incidentStatus', 'incidentRaised']);
    t.add('frontReadingRange', 'rangeTile', watch,
      { entityId: 'reading', fieldId: 'readingTaken', title: 'Readings span' });

    const overTime = t.add('frontOverTime', 'section', front, { title: 'Over time' });
    t.add('frontIncidentTrend', 'trendChart', overTime, {
      entityId: 'incident', dateFieldId: 'incidentRaised', bucket: 'month',
      range: 'last12Months', aggregate: 'count', title: 'Incidents raised each month',
    });
    t.add('frontReadingGrid', 'activityGrid', overTime, {
      entityId: 'reading', dateFieldId: 'readingTaken', range: 'lastTwelveMonths', title: 'Readings taken',
    });

    const page = t.add('systemPage', 'detailSurface', null, {
      definitionVersion: 3, entityId: 'system', title: 'System',
      titleFieldId: 'systemName', subtitleFieldId: 'systemCode', accentFieldId: 'systemCondition',
    });
    const standing = t.add('systemStanding', 'section', page, { title: 'Standing' });
    t.bindings(standing, ['systemCondition', 'systemCriticality', 'systemModule', 'systemCommissioned', 'systemIncidents']);
    // The note is on the page only while the flag is up. The field is still in
    // the record, still saved, and Studio still shows it.
    t.add('systemReviewNoteBinding', 'fieldBinding', standing,
      { fieldId: 'systemReviewNote', visibleWhen: 'systemUnderReview' });

    const tabs = t.add('systemTabs', 'tabGroup', page, { title: 'System' });

    const capacity = t.add('systemCapacityTab', 'section', tabs, { title: 'Capacity' });
    t.bindings(capacity, ['systemCapacity', 'systemLoad', 'systemCapacityUnit', 'systemHeadroom', 'systemLoadPercent']);

    const parts = t.add('systemPartsTab', 'section', tabs, { title: 'Components' });
    const partsList = t.add('systemComponents', 'relatedList', parts,
      { targetEntityId: 'component', viaFieldId: 'componentSystem', title: 'Components', orderByFieldId: 'componentName', orderDirection: 'ascending' });
    t.bindings(partsList, ['componentName', 'componentKind', 'componentState', 'componentNextServiceDue']);
    t.add('systemComponentCount', 'summaryTile', partsList, { aggregate: 'count', title: 'Components' });

    const trouble = t.add('systemIncidentsTab', 'section', tabs, { title: 'Incidents' });
    const incidentList = t.add('systemIncidentList', 'relatedList', trouble,
      { targetEntityId: 'incident', viaFieldId: 'incidentSystem', title: 'Incidents', orderByFieldId: 'incidentRaised', orderDirection: 'descending' });
    t.bindings(incidentList, ['incidentTitle', 'incidentSeverity', 'incidentStatus', 'incidentRaised', 'incidentDaysToResolve']);

    // A tile on a record page reads over the whole record type, so a trend here
    // would be the station's readings rather than this system's. The related
    // list is the one thing on this page that is scoped by the reference, and
    // its own tile is scoped with it.
    const telemetry = t.add('systemTelemetryTab', 'section', tabs, { title: 'Telemetry' });
    t.bindings(telemetry, ['systemOutOfLimits']);
    const readingList = t.add('systemReadings', 'relatedList', telemetry,
      { targetEntityId: 'reading', viaFieldId: 'readingSystem', title: 'Readings', orderByFieldId: 'readingTaken', orderDirection: 'descending' });
    t.bindings(readingList, ['readingTaken', 'readingMetric', 'readingValue', 'readingUnit', 'readingOutOfLimits']);
    t.add('systemReadingCount', 'summaryTile', readingList, { aggregate: 'count', title: 'Readings' });

    return t.asMutations('A front page for the station, and a page for one system');
  },
  appliedWhen: async client => hasNode(client, 'front'),
};

const command = (t, nodeId, entityId, label, steps) => {
  const root = t.add(nodeId, 'recordCommand', null, { definitionVersion: 3, entityId, label });
  steps.forEach(([fieldId, valueKind, value], index) => {
    const properties = value === undefined ? { fieldId, valueKind } : { fieldId, valueKind, value };
    t.add(`${nodeId}.step${index + 1}`, 'commandStep', root, properties);
  });
};

STAGES['surfaces-c'] = {
  title: 'Nendo Station: the ops board, the spine and the calendar',
  needs: ['incident', 'maintenance'],
  makes: [],
  mutations: () => {
    const t = tree(SURFACE);

    const board = t.add('incidentBoard', 'boardSurface', null, {
      definitionVersion: 3, entityId: 'incident', title: 'Ops board',
      groupByFieldId: 'incidentStatus', orderByFieldId: 'incidentRaised', orderDirection: 'descending',
    });
    t.bindings(board, ['incidentTitle', 'incidentSystem', 'incidentSeverity', 'incidentRaised']);
    t.add('incidentBoardColumn', 'summaryTile', board, { aggregate: 'count', title: 'In this state', scope: 'group' });

    // An incident with no resolved date is an entry rather than a span, which is
    // what an incident that is still open looks like.
    const spine = t.add('incidentTimeline', 'timelineSurface', null, {
      definitionVersion: 3, entityId: 'incident', title: 'How long things stayed broken',
      dateFieldId: 'incidentRaised', endDateFieldId: 'incidentResolved',
      titleFieldId: 'incidentTitle', accentFieldId: 'incidentSeverity',
      orderByFieldId: 'incidentRaised', orderDirection: 'descending',
    });
    t.bindings(spine, ['incidentSystem', 'incidentStatus', 'incidentDaysToResolve']);

    const openList = t.add('incidentOpen', 'recordList', null, {
      definitionVersion: 3, entityId: 'incident', title: 'Still open',
      orderByFieldId: 'incidentRaised', orderDirection: 'descending',
    });
    t.bindings(openList, ['incidentTitle', 'incidentSystem', 'incidentComponent', 'incidentSeverity', 'incidentRaised']);
    t.add('incidentOpenNotResolved', 'filterClause', openList,
      { fieldId: 'incidentStatus', operator: 'ne', valueKind: 'literal', value: 'Resolved' });
    t.add('incidentOpenNotStoodDown', 'filterClause', openList,
      { fieldId: 'incidentStatus', operator: 'ne', valueKind: 'literal', value: 'Stood down' });
    t.add('incidentOpenCount', 'summaryTile', openList, { aggregate: 'count', title: 'Still open' });

    const incidentPage = t.add('incidentPage', 'detailSurface', null, {
      definitionVersion: 3, entityId: 'incident', title: 'Incident',
      titleFieldId: 'incidentTitle', accentFieldId: 'incidentSeverity',
    });
    const what = t.add('incidentWhat', 'section', incidentPage, { title: 'What happened' });
    t.bindings(what, ['incidentSummary', 'incidentSystem', 'incidentComponent', 'incidentSeverity']);
    const when = t.add('incidentWhen', 'section', incidentPage, { title: 'When' });
    t.bindings(when, ['incidentStatus', 'incidentRaised', 'incidentResolved', 'incidentDaysToResolve']);

    const incidentForm = t.add('incidentForm', 'recordForm', null,
      { definitionVersion: 3, entityId: 'incident', title: 'Raise an incident' });
    t.bindings(incidentForm, ['incidentTitle', 'incidentSystem', 'incidentComponent', 'incidentSeverity',
      'incidentStatus', 'incidentRaised', 'incidentSummary']);

    command(t, 'incidentStandDown', 'incident', 'Stand down', [
      ['incidentStatus', 'literal', 'Stood down'],
      ['incidentResolved', 'today'],
    ]);

    const calendar = t.add('maintenanceCalendar', 'calendarSurface', null, {
      definitionVersion: 3, entityId: 'maintenance', title: 'What is due',
      dateFieldId: 'taskDue', orderByFieldId: 'taskDue', orderDirection: 'ascending',
    });
    t.bindings(calendar, ['taskTitle', 'taskComponent', 'taskStatus']);
    t.add('maintenanceCalendarOpen', 'filterClause', calendar,
      { fieldId: 'taskStatus', operator: 'ne', valueKind: 'literal', value: 'Done' });

    const maintenanceBoard = t.add('maintenanceBoard', 'boardSurface', null, {
      definitionVersion: 3, entityId: 'maintenance', title: 'Maintenance',
      groupByFieldId: 'taskStatus', orderByFieldId: 'taskDue', orderDirection: 'ascending',
    });
    t.bindings(maintenanceBoard, ['taskTitle', 'taskComponent', 'taskKind', 'taskDue']);
    t.add('maintenanceBoardHours', 'summaryTile', maintenanceBoard,
      { aggregate: 'sum', fieldId: 'taskHours', title: 'Hours in this state', scope: 'group' });

    const maintenanceList = t.add('maintenanceList', 'recordList', null, {
      definitionVersion: 3, entityId: 'maintenance', title: 'All maintenance',
      orderByFieldId: 'taskDue', orderDirection: 'ascending',
    });
    t.bindings(maintenanceList, ['taskTitle', 'taskComponent', 'taskKind', 'taskStatus', 'taskDue', 'taskHours']);
    t.add('maintenanceListByKind', 'breakdownChart', maintenanceList,
      { aggregate: 'sum', fieldId: 'taskHours', groupByFieldId: 'taskKind', title: 'Hours by kind' });

    const maintenanceForm = t.add('maintenanceForm', 'recordForm', null,
      { definitionVersion: 3, entityId: 'maintenance', title: 'Schedule maintenance' });
    t.bindings(maintenanceForm, ['taskTitle', 'taskComponent', 'taskKind', 'taskStatus',
      'taskOpened', 'taskDue', 'taskHours']);

    command(t, 'maintenanceComplete', 'maintenance', 'Complete', [
      ['taskStatus', 'literal', 'Done'],
      ['taskCompleted', 'today'],
    ]);

    return t.asMutations('The incidents and the maintenance, with the two buttons that close them');
  },
  appliedWhen: async client => hasNode(client, 'incidentBoard'),
};

STAGES['surfaces-d'] = {
  title: 'Nendo Station: components, crew, experiments and telemetry',
  needs: ['component', 'crew', 'experiment', 'reading', 'module'],
  makes: [],
  mutations: () => {
    const t = tree(SURFACE);

    const componentList = t.add('componentList', 'recordList', null, {
      definitionVersion: 3, entityId: 'component', title: 'Components',
      orderByFieldId: 'componentSchematicLabel', orderDirection: 'ascending',
    });
    t.bindings(componentList, ['componentSchematicLabel', 'componentSystem', 'componentKind',
      'componentState', 'componentNextServiceDue']);
    t.add('componentListByState', 'breakdownChart', componentList,
      { aggregate: 'count', groupByFieldId: 'componentState', title: 'By state' });
    const dueSoon = t.add('componentListDue', 'summaryTile', componentList,
      { aggregate: 'count', title: 'Service overdue' });
    t.add('componentListDueClause', 'filterClause', dueSoon,
      { fieldId: 'componentNextServiceDue', operator: 'lte', valueKind: 'today' });

    const componentPage = t.add('componentPage', 'detailSurface', null, {
      definitionVersion: 3, entityId: 'component', title: 'Component',
      titleFieldId: 'componentName', subtitleFieldId: 'componentSchematicLabel', accentFieldId: 'componentState',
    });
    const fitted = t.add('componentFitted', 'section', componentPage, { title: 'Fitted' });
    t.bindings(fitted, ['componentSystem', 'componentKind', 'componentState', 'componentSerial', 'componentInstalled']);
    const service = t.add('componentService', 'section', componentPage, { title: 'Service' });
    t.bindings(service, ['componentLastServiced', 'componentNextServiceDue', 'componentServiceInterval',
      'componentServiceWindow', 'componentPlannedHours']);
    // The two halves of the graph, as two lists: what reaches this component and
    // what it reaches. Same record type, different reference.
    const plumbing = t.add('componentPlumbing', 'section', componentPage, { title: 'Feeds' });
    const feedsIn = t.add('componentFeedsIn', 'relatedList', plumbing,
      { targetEntityId: 'feed', viaFieldId: 'feedTo', title: 'Fed by' });
    t.bindings(feedsIn, ['feedFrom', 'feedKind', 'feedRedundant']);
    const feedsOut = t.add('componentFeedsOut', 'relatedList', plumbing,
      { targetEntityId: 'feed', viaFieldId: 'feedFrom', title: 'Feeds into' });
    t.bindings(feedsOut, ['feedTo', 'feedKind', 'feedRedundant']);

    command(t, 'componentTakeOffline', 'component', 'Take offline', [['componentState', 'literal', 'Offline']]);
    command(t, 'componentReturn', 'component', 'Return to service', [['componentState', 'literal', 'Online']]);
    // The literal for a Boolean field is a Boolean, not the text 'false';
    // NUI277 says so by name rather than storing the string.
    command(t, 'systemClearFlag', 'system', 'Clear review flag', [
      ['systemReviewFlag', 'literal', false],
      ['systemReviewNote', 'null'],
    ]);

    const feedList = t.add('feedList', 'recordList', null, {
      definitionVersion: 3, entityId: 'feed', title: 'Feeds',
    });
    t.bindings(feedList, ['feedFrom', 'feedTo', 'feedKind', 'feedRedundant']);
    t.add('feedListByKind', 'breakdownChart', feedList,
      { aggregate: 'count', groupByFieldId: 'feedKind', title: 'What they carry' });

    const moduleList = t.add('moduleList', 'recordList', null, {
      definitionVersion: 3, entityId: 'module', title: 'Modules',
      orderByFieldId: 'moduleName', orderDirection: 'ascending',
    });
    t.bindings(moduleList, ['moduleName', 'moduleDesignation', 'modulePressurised', 'moduleVolume']);
    const modulePage = t.add('modulePage', 'detailSurface', null, {
      definitionVersion: 3, entityId: 'module', title: 'Module', titleFieldId: 'moduleName',
      subtitleFieldId: 'moduleDesignation',
    });
    const built = t.add('moduleBuilt', 'section', modulePage, { title: 'Module' });
    t.bindings(built, ['modulePressurised', 'moduleVolume', 'moduleCommissioned']);
    const moduleSystems = t.add('moduleSystems', 'relatedList', modulePage,
      { targetEntityId: 'system', viaFieldId: 'systemModule', title: 'Systems here', orderByFieldId: 'systemName', orderDirection: 'ascending' });
    t.bindings(moduleSystems, ['systemName', 'systemCondition', 'systemLoadPercent']);

    const crewList = t.add('crewList', 'recordList', null, {
      definitionVersion: 3, entityId: 'crew', title: 'Crew',
      orderByFieldId: 'crewName', orderDirection: 'ascending',
    });
    t.bindings(crewList, ['crewName', 'crewRole', 'crewCallsign', 'crewRotationStart', 'crewRotationEnd']);
    const rotations = t.add('crewRotations', 'timelineSurface', null, {
      definitionVersion: 3, entityId: 'crew', title: 'Rotations',
      dateFieldId: 'crewRotationStart', endDateFieldId: 'crewRotationEnd',
      titleFieldId: 'crewName', accentFieldId: 'crewRole',
      orderByFieldId: 'crewRotationStart', orderDirection: 'ascending',
    });
    t.bindings(rotations, ['crewRole', 'crewCallsign']);
    const crewBoard = t.add('crewByRole', 'boardSurface', null, {
      definitionVersion: 3, entityId: 'crew', title: 'By role', groupByFieldId: 'crewRole',
      orderByFieldId: 'crewName', orderDirection: 'ascending',
    });
    t.bindings(crewBoard, ['crewName', 'crewCallsign']);

    const experimentCards = t.add('experimentCards', 'gallerySurface', null, {
      definitionVersion: 3, entityId: 'experiment', title: 'Experiments',
      titleFieldId: 'experimentTitle', accentFieldId: 'experimentStatus',
      orderByFieldId: 'experimentStart', orderDirection: 'descending',
    });
    t.bindings(experimentCards, ['experimentLead', 'experimentModule', 'experimentPriority',
      'experimentPower', 'experimentPowerShare']);
    const experimentSpine = t.add('experimentTimeline', 'timelineSurface', null, {
      definitionVersion: 3, entityId: 'experiment', title: 'Experiment runs',
      dateFieldId: 'experimentStart', endDateFieldId: 'experimentEnd',
      titleFieldId: 'experimentTitle', accentFieldId: 'experimentStatus',
      orderByFieldId: 'experimentStart', orderDirection: 'ascending',
    });
    t.bindings(experimentSpine, ['experimentLead', 'experimentStatus', 'experimentPower']);

    const readingList = t.add('readingList', 'recordList', null, {
      definitionVersion: 3, entityId: 'reading', title: 'Telemetry',
      orderByFieldId: 'readingTaken', orderDirection: 'descending',
    });
    t.bindings(readingList, ['readingTaken', 'readingSystem', 'readingMetric', 'readingValue',
      'readingUnit', 'readingOutOfLimits']);
    t.add('readingListByMetric', 'breakdownChart', readingList,
      { aggregate: 'count', groupByFieldId: 'readingMetric', title: 'By metric' });
    t.add('readingListOutside', 'breakdownChart', readingList,
      { aggregate: 'count', groupByFieldId: 'readingOutOfLimits', title: 'Inside and outside limits' });
    t.add('readingListTrend', 'trendChart', readingList, {
      dateFieldId: 'readingTaken', bucket: 'week', range: 'last90Days',
      aggregate: 'count', title: 'Readings a week',
    });
    t.add('readingListGrid', 'activityGrid', readingList,
      { dateFieldId: 'readingTaken', range: 'lastTwelveMonths', title: 'Days with readings' });

    return t.asMutations('Everything else the station has to show');
  },
  appliedWhen: async client => hasNode(client, 'componentList'),
};

const LENS_PACKAGE = path.join('artifacts', 'extensions', 'org.nendo.systems-lens-0.2.0.nendoview');

// The pin is the digest of the exact archive bytes, so it is read off the file that
// exists rather than copied into this script and left to go stale. Rebuilding the
// package changes the digest, which is a different package: the view has to be
// installed and allowed again.
async function lensDigest() {
  const bytes = await fs.readFile(LENS_PACKAGE).catch(() => {
    fail([
      `${LENS_PACKAGE} is not there.`,
      'Build it first: pwsh ./tools/Build-NendoSystemsLensPackage.ps1',
    ].join('\n'));
  });
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

STAGES.pin = {
  title: 'Nendo Station: pin the Systems Lens schematic',
  needs: ['component', 'feed'],
  makes: [],
  mutations: async () => {
    const t = tree(SURFACE);
    // Protocol 2 (ADR-0013, 2026-09-24): the system is disclosed as a field of its own,
    // so the label is the component's name and nothing is packed into it.
    t.add('systemsLens', 'extensionGraphSurface', null, {
      definitionVersion: 3, entityId: 'component', title: 'Systems Lens',
      packageId: 'org.nendo.systems-lens', packageVersion: '0.2.0', packageDigest: await lensDigest(),
      protocolVersion: 2, configurationVersion: 1, configuration: '{}',
      labelFieldId: 'componentName', statusFieldId: 'componentState',
      edgeEntityId: 'feed', sourceFieldId: 'feedFrom', targetFieldId: 'feedTo',
    });
    t.add('systemsLens.componentSystem', 'fieldBinding', 'systemsLens', { fieldId: 'componentSystem' });
    return t.asMutations('Pin the schematic view to the components and their feeds');
  },
  appliedWhen: async client => hasNode(client, 'systemsLens'),
};

// The change the demonstration asks an agent for, in the person's own words: "We need to
// distinguish temporary workarounds from permanent repairs. Add that distinction and a
// focused incident view." It is here so the file can be rebuilt to its finished state;
// the demonstration itself is performed against a file built as far as the pin, so the
// screen it adds is genuinely new on the day.
STAGES.workarounds = {
  title: 'Nendo Station: tell a workaround from a repair',
  needs: ['incident'],
  makes: [],
  mutations: () => {
    const t = tree(SURFACE);

    const standing = t.add('incidentWorkarounds', 'recordList', null, {
      definitionVersion: 3, entityId: 'incident', title: 'Standing workarounds',
      orderByFieldId: 'incidentRaised', orderDirection: 'ascending',
    });
    t.bindings(standing, ['incidentTitle', 'incidentSystem', 'incidentComponent',
      'incidentResolution', 'incidentStatus', 'incidentRaised']);
    t.add('incidentWorkaroundsIsWorkaround', 'filterClause', standing,
      { fieldId: 'incidentResolution', operator: 'eq', valueKind: 'literal', value: 'Workaround' });
    t.add('incidentWorkaroundsOpen', 'filterClause', standing,
      { fieldId: 'incidentStatus', operator: 'ne', valueKind: 'literal', value: 'Stood down' });
    t.add('incidentWorkaroundsCount', 'summaryTile', standing, { aggregate: 'count', title: 'Standing on a workaround' });

    t.add('incidentBoardByResolution', 'breakdownChart', 'incidentBoard',
      { aggregate: 'count', groupByFieldId: 'incidentResolution', title: 'How they were closed' });

    const front = t.add('frontWorkarounds', 'summaryTile', 'frontWatch',
      { entityId: 'incident', aggregate: 'count', title: 'Standing on a workaround' });
    t.add('frontWorkaroundsIsWorkaround', 'filterClause', front,
      { fieldId: 'incidentResolution', operator: 'eq', valueKind: 'literal', value: 'Workaround' });
    t.add('frontWorkaroundsOpen', 'filterClause', front,
      { fieldId: 'incidentStatus', operator: 'ne', valueKind: 'literal', value: 'Stood down' });

    t.add('incidentWhen.incidentResolution', 'fieldBinding', 'incidentWhen', { fieldId: 'incidentResolution' });
    t.add('incidentForm.incidentResolution', 'fieldBinding', 'incidentForm', { fieldId: 'incidentResolution' });

    return [
      {
        // Optional, because every incident already on file was closed before anybody
        // drew this distinction, and guessing which of them was a workaround would be
        // inventing the answer the field exists to record.
        description: 'Add Resolution to an incident',
        operations: [
          choice('incident', 'incidentResolution', 'Resolution',
            ['Workaround', 'Permanent repair', 'Not applicable']),
          tone('incident', 'incidentResolution', 'Workaround', 'amber'),
          tone('incident', 'incidentResolution', 'Permanent repair', 'green'),
          tone('incident', 'incidentResolution', 'Not applicable', 'grey'),
        ],
      },
      ...t.asMutations('A screen for what is still standing on a workaround'),
    ];
  },
  appliedWhen: async client => hasNode(client, 'incidentWorkarounds'),
};

// A station pinned before protocol 2 carried the system inside its label. This moves the
// pin to the 0.2.0 package in one proposal: protocol 2, the name as the label, and the
// system disclosed as a field. It is a new consent, and the review names the field.
STAGES['lens-fields'] = {
  title: 'Nendo Station: disclose the system to the schematic instead of packing it into the label',
  needs: ['component', 'feed'],
  makes: [],
  mutations: async () => {
    const set = (propertyName, value) => op('ui.setProperty', { surfaceId: SURFACE, nodeId: 'systemsLens', propertyName, value });
    return [{
      description: "Move the schematic to protocol 2 and disclose each component's system",
      operations: [
        set('protocolVersion', 2),
        set('packageVersion', '0.2.0'),
        set('packageDigest', await lensDigest()),
        set('labelFieldId', 'componentName'),
        op('ui.addNode', { surfaceId: SURFACE, nodeId: 'systemsLens.componentSystem', parentNodeId: 'systemsLens',
          kind: 'fieldBinding', position: 0, properties: { fieldId: 'componentSystem' } }),
      ],
    }];
  },
  appliedWhen: async client => hasNode(client, 'systemsLens.componentSystem'),
};

// Rebuilding the package is a different package, so the pin has to move with it. The
// digest is consent, not a version number: the file reports the package as changed and
// the view stays shut until it is installed and allowed again.
STAGES.repin = {
  title: 'Nendo Station: point the schematic at the rebuilt package',
  needs: ['component', 'feed'],
  makes: [],
  mutations: async () => [{
    description: 'Move the pin to the rebuilt package',
    operations: [op('ui.setProperty', {
      surfaceId: SURFACE, nodeId: 'systemsLens', propertyName: 'packageDigest', value: await lensDigest(),
    })],
  }],
  appliedWhen: async client => {
    const read = await client.rpc('resources/read', { uri: 'nendo://application/surfaces' });
    return read.contents[0].text.includes(await lensDigest());
  },
};

// The data stages write records, which is the data lane: no change set, no
// proposal, no acceptance. A person accepts a shape; records are ordinary
// writes, and these are the station's own.
const DATA_STAGES = {
  'data-a': {
    title: 'The station, its systems and its crew',
    needs: ['module', 'system', 'crew'],
    fills: [
      { entityId: 'module', records: station.modules },
      { entityId: 'system', records: station.systems },
      { entityId: 'crew', records: station.crew },
    ],
  },
  'data-b': {
    title: 'Components and the feeds between them',
    needs: ['component', 'feed'],
    fills: [
      { entityId: 'component', records: station.components },
      { entityId: 'feed', records: station.feeds },
    ],
  },
  'data-c': {
    title: 'Incidents, maintenance and experiments',
    needs: ['incident', 'maintenance', 'experiment'],
    // Creating an incident fires the trigger, which flags the system it names.
    // Thermal Control is deliberately not in this list, so the flag the
    // demonstration raises is visibly new rather than already on.
    fills: [
      { entityId: 'incident', records: station.incidents },
      { entityId: 'maintenance', records: station.maintenance },
      { entityId: 'experiment', records: station.experiments },
    ],
  },
};

const CSV_PATH = path.join('artifacts', 'station', 'readings.csv');

const STAGE_ORDER = [
  'schema-a', 'schema-b', 'schema-c', 'behaviour',
  'data-a', 'data-b', 'data-c', 'readings-csv',
  'surfaces-a', 'surfaces-b', 'surfaces-c', 'surfaces-d', 'pin', 'lens-fields', 'repin', 'workarounds',
];

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// One Nendo, and not the planner. The discovery directory holds a file per
// running instance; a station build refuses to guess which one was meant.
async function connect() {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'Nendo', 'Mcp', 'active');
  let names = [];
  try {
    names = (await fs.readdir(root)).filter(name => name.endsWith('.json'));
  } catch {
    fail(`No Nendo is running: ${root} does not exist. Open the station file in Nendo and try again.`);
  }
  const entries = [];
  for (const name of names) {
    try { entries.push(JSON.parse(await fs.readFile(path.join(root, name), 'utf8'))); } catch { /* half-written */ }
  }
  if (entries.length === 0) fail('No Nendo is running. Open the station file in Nendo and try again.');

  const candidates = [];
  for (const entry of entries) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp\/?$/.test(entry.endpoint ?? '')) continue;
    const client = createNendoMcpClient(entry, 'nendo-station-build');
    let manifest;
    try {
      const read = await client.rpc('resources/read', { uri: 'nendo://application/manifest' });
      manifest = JSON.parse(read.contents[0].text);
    } catch { continue; }
    candidates.push({ entry, client, manifest });
  }

  const station = candidates.filter(c => c.manifest.applicationId !== PLANNER_APPLICATION_ID);
  if (candidates.length > 0 && station.length === 0) {
    fail([
      'The only Nendo answering has the development planner open.',
      'This script will not author a station into it. Open the station file in Nendo',
      '(File, New, then save it as workspace/Nendo Station.nendo) and run this again.',
    ].join('\n'));
  }
  if (station.length > 1) {
    fail(`More than one Nendo is open with a file that is not the planner:\n${
      station.map(c => `  ${c.entry.endpoint}  ${c.manifest.applicationId}`).join('\n')
    }\nClose the ones that are not the station.`);
  }
  if (station.length === 0) fail('No Nendo answered on a local MCP endpoint.');
  return station[0];
}

async function entityIds(client) {
  const read = await client.rpc('resources/read', { uri: 'nendo://application/entities' });
  return JSON.parse(read.contents[0].text).map(entity => entity.entityId);
}

async function records(client, entityId) {
  const items = [];
  let uri = `nendo://application/entity/${entityId}/records`;
  for (;;) {
    const read = await client.rpc('resources/read', { uri });
    const page = JSON.parse(read.contents[0].text);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    uri = `nendo://application/entity/${entityId}/records?cursor=${page.nextCursor}`;
  }
}

async function count(client, entityId) {
  return (await records(client, entityId)).length;
}

async function hasNode(client, nodeId) {
  const read = await client.rpc('resources/read', { uri: 'nendo://application/surfaces' });
  return read.contents[0].text.includes(`"${nodeId}"`);
}

// A reference write is checked against the target's current version, so every
// record carries the version of each record it points at. The versions are read
// immediately before the batch that uses them, because an action that fires on
// one batch moves the records the next one is about to name.
async function targetVersions(client, entityId) {
  const read = await client.rpc('resources/read', { uri: `nendo://application/entity/${entityId}/schema` });
  const fields = JSON.parse(read.contents[0].text).fields
    .filter(field => field.storageKind === 'reference' && field.reference)
    .map(field => ({ fieldId: field.fieldId, targetEntityId: field.reference.targetEntityId }));
  const versions = new Map();
  for (const targetEntityId of new Set(fields.map(field => field.targetEntityId))) {
    if (versions.has(targetEntityId)) continue;
    const map = new Map();
    for (const item of await records(client, targetEntityId)) map.set(item.recordId, item.recordVersion);
    versions.set(targetEntityId, map);
  }
  return record => {
    const expected = {};
    for (const { fieldId, targetEntityId } of fields) {
      const target = record.values[fieldId];
      if (target === null || target === undefined) continue;
      const version = versions.get(targetEntityId)?.get(target);
      if (version === undefined) fail(`${record.recordId} points at ${target}, which is not in ${targetEntityId}.`);
      expected[fieldId] = version;
    }
    return Object.keys(expected).length > 0 ? expected : undefined;
  };
}

// Records go in at most fifty at a time, all or nothing per call. An incident
// carries the trigger with it, so its call reports what the action also moved.
async function writeRecords(client, stage) {
  const lease = await client.tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    for (const fill of stage.fills) {
      if (await count(client, fill.entityId) > 0) {
        console.log(`   -  ${fill.entityId} already holds records; left alone`);
        continue;
      }
      const expectedFor = await targetVersions(client, fill.entityId);
      let written = 0;
      const moved = new Set();
      for (let start = 0; start < fill.records.length; start += 50) {
        const batch = fill.records.slice(start, start + 50).map(record => {
          const expected = expectedFor(record);
          return expected ? { ...record, expectedTargetVersions: expected } : record;
        });
        const result = await client.tool('nendo.data.create_records', {
          ...owned, entityId: fill.entityId, records: batch, idempotencyKey: crypto.randomUUID(),
        });
        written += result.recordIds.length;
        for (const change of result.alsoChanged ?? []) moved.add(change.recordId ?? change);
      }
      console.log(`${String(written).padStart(4)}  ${fill.entityId}${
        moved.size > 0 ? `   (an action also wrote ${moved.size} other record${moved.size === 1 ? '' : 's'})` : ''}`);
    }
  } finally {
    await client.tool('nendo.lease.release', owned).catch(() => { /* the person may have revoked it */ });
  }
  console.log('\nThese are records, not a shape: they are written, and there is nothing to accept.');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const argument = process.argv.slice(2).find(value => !value.startsWith('--'));
  if (process.argv.includes('--list')) {
    for (const name of STAGE_ORDER) {
      const stage = STAGES[name] ?? DATA_STAGES[name];
      console.log(`${name.padEnd(12)}  ${stage ? stage.title : 'The readings, as a CSV file to import'}`);
    }
    return;
  }

  const { client, manifest } = await connect();
  const present = await entityIds(client);

  const applied = async candidate => {
    if (STAGES[candidate]?.appliedWhen) return STAGES[candidate].appliedWhen(client);
    if (candidate === 'readings-csv') return fs.access(CSV_PATH).then(() => true, () => false);
    if (candidate === 'behaviour') {
      if (!present.includes('system')) return false;
      const read = await client.rpc('resources/read', { uri: 'nendo://application/entity/system/schema' });
      return (JSON.parse(read.contents[0].text).derivedFields ?? []).length > 0;
    }
    if (DATA_STAGES[candidate]) {
      for (const fill of DATA_STAGES[candidate].fills) {
        if (!present.includes(fill.entityId)) return false;
        if (await count(client, fill.entityId) === 0) return false;
      }
      return true;
    }
    return STAGES[candidate].makes.every(id => present.includes(id));
  };

  let name = argument;
  if (!name) {
    for (const candidate of STAGE_ORDER) {
      if (!await applied(candidate)) { name = candidate; break; }
    }
    if (!name) fail('Every stage this script knows is already applied.');
  }
  if (!STAGE_ORDER.includes(name)) fail(`Unknown stage ${name}. Run with --list.`);
  if (await applied(name)) fail(`Stage ${name} is already applied.`);

  const stage = STAGES[name] ?? DATA_STAGES[name] ?? { title: 'The readings, as a CSV file to import', needs: ['reading'] };
  const missing = (stage.needs ?? []).filter(id => !present.includes(id));
  if (missing.length > 0) {
    fail([
      `Stage ${name} needs record types that are not in the file yet: ${missing.join(', ')}.`,
      'An earlier stage is waiting to be accepted in Nendo, or has not been run.',
    ].join('\n'));
  }

  console.log(`File            ${manifest.applicationId}`);
  console.log(`Revision        definition ${manifest.definitionRevision}, data ${manifest.dataRevision}`);
  console.log(`Stage           ${name}`);
  console.log(`                ${stage.title}\n`);

  if (dryRun && name !== 'readings-csv') {
    const planned = DATA_STAGES[name]
      ? DATA_STAGES[name].fills.map(fill => `${fill.records.length} ${fill.entityId}`).join(', ')
      : `${(await stage.mutations()).length} mutations`;
    console.log(`Dry run: ${planned} would be written. No lease was taken.`);
    return;
  }

  if (name === 'readings-csv') {
    const csv = station.readingsCsv();
    await fs.mkdir(path.dirname(CSV_PATH), { recursive: true });
    await fs.writeFile(CSV_PATH, csv, 'utf8');
    const rows = csv.trimEnd().split('\r\n').length - 1;
    console.log(`Wrote ${CSV_PATH}: ${rows} readings.`);
    console.log('\nImport it in Nendo, into Readings, with the Nendo profile. The headers are');
    console.log('field IDs, the system column holds stable record IDs, and the importer shows');
    console.log('the column mapping before it writes anything.');
    return;
  }

  if (DATA_STAGES[name]) {
    await writeRecords(client, stage);
    return;
  }

  const mutations = await stage.mutations();
  const operationCount = mutations.reduce((total, mutation) => total + mutation.operations.length, 0);
  for (const mutation of mutations) {
    if (mutation.operations.length > 16) fail(`Mutation "${mutation.description}" holds ${mutation.operations.length} operations; a call carries 16.`);
  }

  if (dryRun) {
    console.log(`Dry run: ${mutations.length} mutations, ${operationCount} operations would be sent. No lease was taken.`);
    return;
  }

  const lease = await client.tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    const draft = await client.tool('nendo.change_set.begin', {
      ...owned, title: stage.title, idempotencyKey: crypto.randomUUID(),
    });

    // At most eight mutations and sixteen operations per call, so the stage is
    // sent in batches and the draft accumulates them.
    let batch = [];
    let batched = 0;
    const send = async () => {
      if (batch.length === 0) return;
      await client.tool('nendo.change_set.add_operations', {
        ...owned, changeSetId: draft.changeSetId, mutations: batch, idempotencyKey: crypto.randomUUID(),
      });
      batch = [];
      batched = 0;
    };
    for (const mutation of mutations) {
      if (batch.length === 8 || batched + mutation.operations.length > 16) await send();
      batch.push(mutation);
      batched += mutation.operations.length;
    }
    await send();

    const validated = await client.tool('nendo.change_set.validate', {
      ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID(),
    });
    const diagnostics = validated.diagnostics ?? [];
    if (diagnostics.length > 0 || validated.isValid === false) {
      console.error(`\nThe draft did not validate. It stays open; correct it and validate again.\n`);
      for (const diagnostic of diagnostics) console.error(`  ${diagnostic.code ?? ''} ${diagnostic.message ?? JSON.stringify(diagnostic)}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Validated on a clone: ${mutations.length} mutations, ${operationCount} submitted operations.`);
    console.log('\nNothing has changed in the file yet. In Nendo, review and accept the proposal');
    console.log(`  ${stage.title}`);
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(name) + 1];
    console.log(next
      ? `\nThen run: node tools/Build-NendoStation.mjs ${next}`
      : '\nThat is the last stage this script knows.');
  } finally {
    await client.tool('nendo.lease.release', owned).catch(() => { /* the person may have revoked it */ });
  }
}

main().catch(error => fail(error.stack ?? String(error)));
