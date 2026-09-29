// The shape of Planner.nendo: record types, calculations, screens, front page and
// commands, one stage per change set. tools/Build-Planner.mjs sends them; this file
// only says what they are. docs/design/planner.md gives the reason for each choice.
//
// Entity and field IDs keep the nd.* prefix of workspace/Nendo.nendo wherever the
// meaning is the same, so a record carried across keeps its field IDs and every
// reader of the old file (the /next skill, the docs) reads the new one unchanged.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SURFACE = 'planner';
// What one add_operations call may carry, as Put-NendoPackage.mjs measures it.
export const CALL_CHARACTERS = 200_000;
export const PACKAGE_ID = 'org.nendo.work-dependencies';
export const PACKAGE_FOLDER = path.join('extensions', 'work-dependencies');

const op = (operationType, payload) => ({ operationType, payload });
const text = (entityId, fieldId, displayName, required = false, presentation = 'singleLine') =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation, options: [] });
const long = (entityId, fieldId, displayName) => text(entityId, fieldId, displayName, false, 'longText');
const choice = (entityId, fieldId, displayName, options, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation: 'singleChoice', options });
const date = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Date', required: false, presentation: 'date', options: [] });
const integer = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Integer', required: false, presentation: null, options: [] });
const rating = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Integer', required: false, presentation: 'rating', options: [], min: 1, max: 5 });
const reference = (entityId, fieldId, displayName, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Reference', required, presentation: null, options: [] });
const bind = (entityId, fieldId, targetEntityId, labelFieldId) =>
  op('schema.configureReference', { entityId, fieldId, targetEntityId, labelFieldId });
const tone = (entityId, fieldId, choiceId, toneName) =>
  op('schema.setChoiceMetadata', { entityId, fieldId, choiceId, displayName: choiceId, retired: false, tone: toneName });
const numbered = (entityId, fieldId, prefix) => [
  op('schema.setFieldUnique', { entityId, fieldId, unique: true }),
  op('schema.setFieldSequence', { entityId, fieldId, prefix, width: 3 }),
];
const calculation = (definitionId, entityId, fieldId, displayName, resultType, expression, bindings, nullable = false) =>
  op('behaviour.setDefinition', { definitionId, definitionKind: 'Calculation', body: {
    entityId, fieldId, displayName, resultType, resultNullable: nullable, expression, bindings, callAliases: [],
  } });
const field = (bindingId, entityId, fieldId, resultType, nullable = false) =>
  ({ bindingId, kind: 'SameRecordField', entityId, fieldId, resultType, nullable });
const related = (bindingId, entityId, relatedEntityId, relatedReferenceFieldId) =>
  ({ bindingId, kind: 'RelatedAggregate', aggregate: 'Count', entityId, relatedEntityId, relatedReferenceFieldId,
    resultType: 'Integer', nullable: false });

// Screen nodes carry their position within their parent, counted here.
function tree() {
  const positions = new Map();
  const operations = [];
  const add = (nodeId, kind, parentNodeId, properties = {}) => {
    const key = parentNodeId ?? '';
    const position = positions.get(key) ?? 0;
    positions.set(key, position + 1);
    operations.push(op('ui.addNode', { surfaceId: SURFACE, nodeId, parentNodeId, kind, position, properties }));
    return nodeId;
  };
  const bindings = (parentNodeId, fieldIds) => {
    for (const fieldId of fieldIds) add(`${parentNodeId}.${fieldId}`, 'fieldBinding', parentNodeId, { fieldId });
  };
  const where = (parentNodeId, name, fieldId, operator, value) => {
    const properties = value === undefined
      ? { fieldId, operator }
      : { fieldId, operator, valueKind: 'literal', value };
    add(`${parentNodeId}.where.${name}`, 'filterClause', parentNodeId, properties);
  };
  const command = (nodeId, entityId, label, steps) => {
    const root = add(nodeId, 'recordCommand', null, { definitionVersion: 3, entityId, label });
    steps.forEach(([fieldId, valueKind, value], index) => {
      add(`${nodeId}.step${index + 1}`, 'commandStep', root,
        value === undefined ? { fieldId, valueKind } : { fieldId, valueKind, value });
    });
  };
  const asMutations = description => {
    const mutations = [];
    const total = Math.ceil(operations.length / 16);
    for (let start = 0; start < operations.length; start += 16) {
      mutations.push({
        description: total > 1 ? `${description} (${mutations.length + 1} of ${total})` : description,
        operations: operations.slice(start, start + 16),
      });
    }
    return mutations;
  };
  return { add, bindings, where, command, asMutations };
}

export const PURPOSE = [
  'The planner for building Nendo, kept in Nendo. The owner and the agents working on the code read and',
  'write it here, and it is the only place priorities and evidence live.',
  '',
  'Work says what is being built, the acceptance criteria that would settle it, and the decision standing',
  'that says whether it may be built yet. Findings are what was observed: defects, friction, and the',
  'limitations that are staying. Checks are what was measured, each with its method: automated,',
  'agent-observed, or reported by a person. Decisions are the questions only the owner answers, and work',
  'that waits on one points at it. Initiatives group work under the outcome it serves.',
  '',
  'Horizon says when: Now, Next, then Later, and closed work has none. Status says how far the work has',
  'got. A passing check never completes work on its own: a person reads the evidence and decides.',
  '',
  'What is unfinished stays open and visible. Ratings and dates nobody has established stay empty rather',
  'than being guessed at.',
].join('\n');

const OPEN = [['open', 'nd.work.status', 'ne', 'Done'], ['live', 'nd.work.status', 'ne', 'Dropped']];

export const STAGES = {
  schema: {
    title: 'Planner: the record types',
    makes: ['nd.initiative', 'nd.work', 'nd.finding', 'nd.check', 'nd.link', 'nd.decision'],
    mutations: () => [
      {
        description: 'Say what this file is for, and give it a look of its own',
        operations: [
          op('application.setPurpose', { purpose: PURPOSE }),
          op('application.setLook', { tone: 'violet', letter: 'P' }),
        ],
      },
      {
        description: 'Create Initiatives',
        operations: [
          op('schema.createEntity', { entityId: 'nd.initiative', displayName: 'Initiatives' }),
          text('nd.initiative', 'nd.initiative.title', 'Title', true),
          text('nd.initiative', 'nd.initiative.ref', 'Reference', true),
          choice('nd.initiative', 'nd.initiative.status', 'Status', ['Active', 'Paused', 'Closed'], true),
          long('nd.initiative', 'nd.initiative.outcome', 'Desired outcome'),
          text('nd.initiative', 'nd.initiative.area', 'Product area'),
          date('nd.initiative', 'nd.initiative.target', 'Target date'),
          date('nd.initiative', 'nd.initiative.reviewed', 'Last reviewed'),
          long('nd.initiative', 'nd.initiative.sources', 'Source references'),
        ],
      },
      {
        description: 'Create Decisions',
        operations: [
          op('schema.createEntity', { entityId: 'nd.decision', displayName: 'Decisions' }),
          text('nd.decision', 'nd.decision.title', 'Title', true),
          text('nd.decision', 'nd.decision.ref', 'Reference', true),
          choice('nd.decision', 'nd.decision.status', 'Status', ['Open', 'Decided', 'Superseded'], true),
          long('nd.decision', 'nd.decision.question', 'Question'),
          long('nd.decision', 'nd.decision.options', 'Options'),
          long('nd.decision', 'nd.decision.recommendation', 'Recommendation'),
          long('nd.decision', 'nd.decision.outcome', 'Decided'),
          date('nd.decision', 'nd.decision.decided', 'Decided on'),
          long('nd.decision', 'nd.decision.sources', 'ADR and sources'),
        ],
      },
      {
        description: 'Create Work items with what every one of them must say',
        operations: [
          op('schema.createEntity', { entityId: 'nd.work', displayName: 'Work items' }),
          text('nd.work', 'nd.work.title', 'Title', true),
          text('nd.work', 'nd.work.ref', 'Reference', true),
          choice('nd.work', 'nd.work.kind', 'Kind',
            ['Feature', 'Defect', 'Improvement', 'Investigation', 'Qualification', 'Documentation'], true),
          choice('nd.work', 'nd.work.status', 'Status',
            ['Inbox', 'Ready', 'Doing', 'Blocked', 'Review', 'Done', 'Dropped'], true),
          choice('nd.work', 'nd.work.standing', 'Decision standing',
            ['Within accepted scope', 'Needs decision/ADR', 'Outside current scope'], true),
        ],
      },
      {
        description: 'Give Work items the rest of their fields',
        operations: [
          // Optional, so work that is closed has no horizon rather than a false one.
          choice('nd.work', 'nd.work.horizon', 'Horizon', ['Now', 'Next', 'Later']),
          long('nd.work', 'nd.work.description', 'Description'),
          long('nd.work', 'nd.work.acceptance', 'Acceptance criteria'),
          long('nd.work', 'nd.work.sources', 'Source references'),
          long('nd.work', 'nd.work.blocker', 'Blocker'),
          reference('nd.work', 'nd.work.initiative', 'Initiative'),
          reference('nd.work', 'nd.work.parent', 'Part of'),
          reference('nd.work', 'nd.work.decision', 'Waits on decision'),
          integer('nd.work', 'nd.work.order', 'Planning order'),
          rating('nd.work', 'nd.work.value', 'Value (1-5)'),
          rating('nd.work', 'nd.work.effort', 'Effort (1-5)'),
          date('nd.work', 'nd.work.started', 'Started on'),
          date('nd.work', 'nd.work.target', 'Target date'),
          date('nd.work', 'nd.work.completed', 'Completed on'),
        ],
      },
      {
        description: 'Create Findings',
        operations: [
          op('schema.createEntity', { entityId: 'nd.finding', displayName: 'Findings' }),
          text('nd.finding', 'nd.finding.title', 'Title', true),
          text('nd.finding', 'nd.finding.ref', 'Reference', true),
          choice('nd.finding', 'nd.finding.kind', 'Kind', ['Friction', 'Defect', 'Idea', 'Known limitation'], true),
          choice('nd.finding', 'nd.finding.disposition', 'Disposition',
            ['Untriaged', 'Investigating', 'Tracked in work', 'Accepted limitation', 'Resolved'], true),
          choice('nd.finding', 'nd.finding.severity', 'Severity', ['Low', 'Medium', 'High', 'Critical']),
          long('nd.finding', 'nd.finding.observation', 'Observation'),
          long('nd.finding', 'nd.finding.context', 'Reproduction / context'),
          long('nd.finding', 'nd.finding.guard', 'Guard and its falsification'),
          date('nd.finding', 'nd.finding.observed', 'Observed on'),
          long('nd.finding', 'nd.finding.sources', 'Source references'),
          reference('nd.finding', 'nd.finding.work', 'Work item'),
        ],
      },
      {
        description: 'Create Checks',
        operations: [
          op('schema.createEntity', { entityId: 'nd.check', displayName: 'Checks' }),
          text('nd.check', 'nd.check.title', 'Title', true),
          text('nd.check', 'nd.check.ref', 'Reference', true),
          reference('nd.check', 'nd.check.work', 'Work item', true),
          choice('nd.check', 'nd.check.method', 'Evidence method', ['Automated', 'Agent-observed', 'Owner-reported'], true),
          choice('nd.check', 'nd.check.outcome', 'Outcome',
            ['Not run', 'Passed', 'Failed', 'Blocked', 'Accepted exception'], true),
          long('nd.check', 'nd.check.expected', 'Expected result'),
          long('nd.check', 'nd.check.actual', 'Actual result'),
          long('nd.check', 'nd.check.procedure', 'Command / procedure'),
          text('nd.check', 'nd.check.environment', 'Environment / version'),
          long('nd.check', 'nd.check.evidence', 'Evidence reference'),
          date('nd.check', 'nd.check.executed', 'Executed on'),
        ],
      },
      {
        description: 'Create Dependencies, one blocker and the work it blocks',
        operations: [
          op('schema.createEntity', { entityId: 'nd.link', displayName: 'Dependencies' }),
          reference('nd.link', 'nd.link.from', 'Blocker', true),
          reference('nd.link', 'nd.link.to', 'Blocked item', true),
          long('nd.link', 'nd.link.note', 'Why'),
        ],
      },
      {
        description: 'Point every reference at what it names',
        operations: [
          bind('nd.work', 'nd.work.initiative', 'nd.initiative', 'nd.initiative.title'),
          bind('nd.work', 'nd.work.parent', 'nd.work', 'nd.work.title'),
          bind('nd.work', 'nd.work.decision', 'nd.decision', 'nd.decision.title'),
          bind('nd.finding', 'nd.finding.work', 'nd.work', 'nd.work.title'),
          bind('nd.check', 'nd.check.work', 'nd.work', 'nd.work.title'),
          bind('nd.link', 'nd.link.from', 'nd.work', 'nd.work.title'),
          bind('nd.link', 'nd.link.to', 'nd.work', 'nd.work.title'),
        ],
      },
      {
        description: 'Number every Reference, and keep each one unique',
        operations: [
          ...numbered('nd.initiative', 'nd.initiative.ref', 'I-'),
          ...numbered('nd.work', 'nd.work.ref', 'W-'),
          ...numbered('nd.finding', 'nd.finding.ref', 'F-'),
          ...numbered('nd.check', 'nd.check.ref', 'C-'),
          ...numbered('nd.decision', 'nd.decision.ref', 'D-'),
        ],
      },
      {
        // The planning order becomes the order among siblings, so the outline's drag
        // replaces the old convention of numbering open, delivered and dropped work
        // in separate ranges by hand.
        description: 'Let work be broken into parts, ordered by its planning order',
        operations: [
          op('schema.declareHierarchy', { entityId: 'nd.work', parentFieldId: 'nd.work.parent', orderFieldId: 'nd.work.order' }),
        ],
      },
    ],
  },

  colour: {
    title: 'Planner: colour the choices',
    needs: ['nd.initiative', 'nd.work', 'nd.finding', 'nd.check', 'nd.decision'],
    appliedWhen: async read => (await read.schema('nd.work')).fields
      .find(f => f.fieldId === 'nd.work.status')?.choices.some(c => c.tone) ?? false,
    mutations: () => {
      const tones = [
        ['nd.work', 'nd.work.status', [['Inbox', 'grey'], ['Ready', 'blue'], ['Doing', 'violet'], ['Blocked', 'red'],
          ['Review', 'amber'], ['Done', 'green'], ['Dropped', 'grey']]],
        ['nd.work', 'nd.work.horizon', [['Now', 'teal'], ['Next', 'blue'], ['Later', 'grey']]],
        ['nd.work', 'nd.work.standing', [['Within accepted scope', 'green'], ['Needs decision/ADR', 'amber'],
          ['Outside current scope', 'grey']]],
        ['nd.work', 'nd.work.kind', [['Feature', 'blue'], ['Defect', 'red'], ['Improvement', 'teal'],
          ['Investigation', 'violet'], ['Qualification', 'amber'], ['Documentation', 'grey']]],
        ['nd.check', 'nd.check.outcome', [['Not run', 'grey'], ['Passed', 'green'], ['Failed', 'red'],
          ['Blocked', 'orange'], ['Accepted exception', 'amber']]],
        ['nd.check', 'nd.check.method', [['Automated', 'blue'], ['Agent-observed', 'violet'], ['Owner-reported', 'teal']]],
        ['nd.finding', 'nd.finding.disposition', [['Untriaged', 'orange'], ['Investigating', 'violet'],
          ['Tracked in work', 'blue'], ['Accepted limitation', 'grey'], ['Resolved', 'green']]],
        ['nd.finding', 'nd.finding.kind', [['Friction', 'amber'], ['Defect', 'red'], ['Idea', 'blue'],
          ['Known limitation', 'grey']]],
        ['nd.finding', 'nd.finding.severity', [['Low', 'grey'], ['Medium', 'amber'], ['High', 'orange'], ['Critical', 'red']]],
        ['nd.initiative', 'nd.initiative.status', [['Active', 'green'], ['Paused', 'amber'], ['Closed', 'grey']]],
        ['nd.decision', 'nd.decision.status', [['Open', 'amber'], ['Decided', 'green'], ['Superseded', 'grey']]],
      ];
      const operations = tones.flatMap(([entityId, fieldId, pairs]) =>
        pairs.map(([choiceId, toneName]) => tone(entityId, fieldId, choiceId, toneName)));
      const mutations = [];
      for (let start = 0; start < operations.length; start += 16) {
        mutations.push({ description: 'Colour the choices', operations: operations.slice(start, start + 16) });
      }
      return mutations;
    },
  },

  behaviour: {
    title: 'Planner: what it works out for itself',
    needs: ['nd.work', 'nd.check', 'nd.finding', 'nd.initiative', 'nd.decision'],
    appliedWhen: async read => (await read.schema('nd.work')).derivedFields.length > 0,
    mutations: () => [
      {
        description: 'What a work item carries',
        operations: [
          // Drives the Blocker section, which shows only while the work is blocked.
          calculation('nd.calc.isBlocked', 'nd.work', 'nd.work.isBlocked', 'Is blocked', 'Boolean',
            "status == 'Blocked'", [field('status', 'nd.work', 'nd.work.status', 'Text')]),
          // Empty until the work is both started and completed, which is the honest answer.
          calculation('nd.calc.leadTime', 'nd.work', 'nd.work.leadTime', 'Days from start to done', 'Integer',
            'DaysBetween(started, completed)', [
              field('started', 'nd.work', 'nd.work.started', 'Date', true),
              field('completed', 'nd.work', 'nd.work.completed', 'Date', true),
            ], true),
          calculation('nd.calc.checkCount', 'nd.work', 'nd.work.checkCount', 'Checks', 'Integer',
            'checks', [related('checks', 'nd.work', 'nd.check', 'nd.check.work')]),
          calculation('nd.calc.findingCount', 'nd.work', 'nd.work.findingCount', 'Findings', 'Integer',
            'findings', [related('findings', 'nd.work', 'nd.finding', 'nd.finding.work')]),
          calculation('nd.calc.partCount', 'nd.work', 'nd.work.partCount', 'Parts', 'Integer',
            'parts', [{ bindingId: 'parts', kind: 'SubtreeAggregate', aggregate: 'Count', entityId: 'nd.work',
              resultType: 'Integer', nullable: false }]),
        ],
      },
      {
        description: 'How much work an initiative and a decision hold',
        operations: [
          calculation('nd.calc.workCount', 'nd.initiative', 'nd.initiative.workCount', 'Work items', 'Integer',
            'work', [related('work', 'nd.initiative', 'nd.work', 'nd.work.initiative')]),
          calculation('nd.calc.decisionWork', 'nd.decision', 'nd.decision.workCount', 'Work waiting on it', 'Integer',
            'work', [related('work', 'nd.decision', 'nd.work', 'nd.work.decision')]),
        ],
      },
    ],
  },

  work: {
    title: 'Planner: the work, seen six ways, and its page',
    needs: ['nd.work', 'nd.check', 'nd.finding', 'nd.link'],
    appliedWhen: async read => read.hasNode('pl.work.now'),
    mutations: () => {
      const t = tree();

      const now = t.add('pl.work.now', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Now',
        groupByFieldId: 'nd.work.status', orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(now, ['nd.work.title', 'nd.work.ref', 'nd.work.kind', 'nd.work.initiative']);
      t.where(now, 'now', 'nd.work.horizon', 'eq', 'Now');
      t.add('pl.work.now.column', 'summaryTile', now, { aggregate: 'count', title: 'In this state', scope: 'group' });

      const plan = t.add('pl.work.plan', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Plan',
        groupByFieldId: 'nd.work.horizon', orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(plan, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.standing']);
      for (const [name, fieldId, operator, value] of OPEN) t.where(plan, name, fieldId, operator, value);
      t.add('pl.work.plan.column', 'summaryTile', plan, { aggregate: 'count', title: 'Open here', scope: 'group' });

      const byInitiative = t.add('pl.work.byInitiative', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'By initiative',
        groupByFieldId: 'nd.work.initiative', orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(byInitiative, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.horizon']);
      for (const [name, fieldId, operator, value] of OPEN) t.where(byInitiative, name, fieldId, operator, value);

      const outline = t.add('pl.work.breakdown', 'outlineSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Breakdown',
        titleFieldId: 'nd.work.title', accentFieldId: 'nd.work.status', expandDepth: 2, reorder: true,
      });
      t.bindings(outline, ['nd.work.ref', 'nd.work.status', 'nd.work.horizon']);

      const all = t.add('pl.work.all', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'All work',
        orderByFieldId: 'nd.work.ref', orderDirection: 'descending',
      });
      t.bindings(all, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.horizon', 'nd.work.kind',
        'nd.work.initiative', 'nd.work.completed']);
      t.add('pl.work.all.count', 'summaryTile', all, { aggregate: 'count', title: 'Work items' });
      t.add('pl.work.all.byStatus', 'breakdownChart', all,
        { aggregate: 'count', groupByFieldId: 'nd.work.status', title: 'By status' });

      const history = t.add('pl.work.history', 'timelineSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Delivery history',
        dateFieldId: 'nd.work.started', endDateFieldId: 'nd.work.completed',
        titleFieldId: 'nd.work.title', accentFieldId: 'nd.work.kind',
        orderByFieldId: 'nd.work.started', orderDirection: 'ascending',
      });
      t.bindings(history, ['nd.work.ref', 'nd.work.initiative']);
      t.where(history, 'done', 'nd.work.status', 'eq', 'Done');

      const page = t.add('pl.work.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Work item',
        titleFieldId: 'nd.work.title', subtitleFieldId: 'nd.work.ref', accentFieldId: 'nd.work.status',
      });
      t.bindings(page, ['nd.work.status', 'nd.work.horizon', 'nd.work.standing']);
      const blocked = t.add('pl.work.page.blocked', 'section', page,
        { title: 'Blocked', visibleWhen: 'nd.work.isBlocked' });
      t.bindings(blocked, ['nd.work.blocker']);
      const tabs = t.add('pl.work.page.tabs', 'tabGroup', page, { title: 'Work item' });

      const brief = t.add('pl.work.page.brief', 'section', tabs, { title: 'Brief' });
      t.bindings(brief, ['nd.work.title', 'nd.work.description', 'nd.work.acceptance', 'nd.work.kind',
        'nd.work.initiative', 'nd.work.decision', 'nd.work.sources']);

      const planning = t.add('pl.work.page.plan', 'section', tabs, { title: 'Plan' });
      t.bindings(planning, ['nd.work.parent', 'nd.work.order', 'nd.work.value', 'nd.work.effort',
        'nd.work.started', 'nd.work.target', 'nd.work.completed', 'nd.work.leadTime', 'nd.work.blocker']);

      const evidence = t.add('pl.work.page.evidence', 'section', tabs, { title: 'Evidence' });
      const checks = t.add('pl.work.page.checks', 'relatedList', evidence, {
        targetEntityId: 'nd.check', viaFieldId: 'nd.check.work', title: 'Checks',
        orderByFieldId: 'nd.check.ref', orderDirection: 'ascending',
      });
      t.bindings(checks, ['nd.check.title', 'nd.check.outcome', 'nd.check.method', 'nd.check.executed']);
      t.add('pl.work.page.checks.count', 'summaryTile', checks, { aggregate: 'count', title: 'Checks' });
      const findings = t.add('pl.work.page.findings', 'relatedList', evidence, {
        targetEntityId: 'nd.finding', viaFieldId: 'nd.finding.work', title: 'Findings',
        orderByFieldId: 'nd.finding.ref', orderDirection: 'ascending',
      });
      t.bindings(findings, ['nd.finding.title', 'nd.finding.disposition', 'nd.finding.kind', 'nd.finding.severity']);
      t.add('pl.work.page.findings.count', 'summaryTile', findings, { aggregate: 'count', title: 'Findings' });

      const links = t.add('pl.work.page.links', 'section', tabs, { title: 'Links' });
      const parts = t.add('pl.work.page.parts', 'relatedList', links, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.parent', title: 'Parts',
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(parts, ['nd.work.title', 'nd.work.ref', 'nd.work.status']);
      const blockedBy = t.add('pl.work.page.blockedBy', 'relatedList', links, {
        targetEntityId: 'nd.link', viaFieldId: 'nd.link.to', title: 'Blocked by',
      });
      t.bindings(blockedBy, ['nd.link.from', 'nd.link.note']);
      const blocks = t.add('pl.work.page.blocks', 'relatedList', links, {
        targetEntityId: 'nd.link', viaFieldId: 'nd.link.from', title: 'Blocks',
      });
      t.bindings(blocks, ['nd.link.to', 'nd.link.note']);

      return t.asMutations('The work screens and the work page');
    },
  },

  records: {
    title: 'Planner: initiatives, findings, checks, decisions and dependencies',
    needs: ['nd.initiative', 'nd.finding', 'nd.check', 'nd.decision', 'nd.link'],
    appliedWhen: async read => read.hasNode('pl.initiative.gallery'),
    mutations: () => {
      const t = tree();

      const gallery = t.add('pl.initiative.gallery', 'gallerySurface', null, {
        definitionVersion: 3, entityId: 'nd.initiative', title: 'Initiatives',
        titleFieldId: 'nd.initiative.title', accentFieldId: 'nd.initiative.status',
        orderByFieldId: 'nd.initiative.ref', orderDirection: 'ascending',
      });
      t.bindings(gallery, ['nd.initiative.ref', 'nd.initiative.area', 'nd.initiative.workCount', 'nd.initiative.reviewed']);
      const initiative = t.add('pl.initiative.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.initiative', title: 'Initiative',
        titleFieldId: 'nd.initiative.title', subtitleFieldId: 'nd.initiative.ref', accentFieldId: 'nd.initiative.status',
      });
      t.bindings(initiative, ['nd.initiative.title', 'nd.initiative.status', 'nd.initiative.outcome',
        'nd.initiative.area', 'nd.initiative.target', 'nd.initiative.reviewed', 'nd.initiative.workCount',
        'nd.initiative.sources']);
      const openWork = t.add('pl.initiative.page.open', 'relatedList', initiative, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.initiative', title: 'Open work',
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(openWork, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.horizon']);
      for (const [name, fieldId, operator, value] of OPEN) t.where(openWork, name, fieldId, operator, value);
      t.add('pl.initiative.page.open.count', 'summaryTile', openWork, { aggregate: 'count', title: 'Open' });
      const delivered = t.add('pl.initiative.page.deliveredSection', 'section', initiative,
        { title: 'Delivered', opens: 'closed' });
      const deliveredWork = t.add('pl.initiative.page.delivered', 'relatedList', delivered, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.initiative', title: 'Delivered work',
        orderByFieldId: 'nd.work.completed', orderDirection: 'descending',
      });
      t.bindings(deliveredWork, ['nd.work.title', 'nd.work.ref', 'nd.work.completed']);
      t.where(deliveredWork, 'done', 'nd.work.status', 'eq', 'Done');
      t.add('pl.initiative.page.delivered.count', 'summaryTile', deliveredWork, { aggregate: 'count', title: 'Delivered' });

      const triage = t.add('pl.finding.triage', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.finding', title: 'Triage',
        groupByFieldId: 'nd.finding.disposition', orderByFieldId: 'nd.finding.ref', orderDirection: 'descending',
      });
      t.bindings(triage, ['nd.finding.title', 'nd.finding.ref', 'nd.finding.kind', 'nd.finding.severity']);
      t.add('pl.finding.triage.column', 'summaryTile', triage, { aggregate: 'count', title: 'Here', scope: 'group' });
      const findingList = t.add('pl.finding.list', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.finding', title: 'All findings',
        orderByFieldId: 'nd.finding.ref', orderDirection: 'descending',
      });
      t.bindings(findingList, ['nd.finding.title', 'nd.finding.ref', 'nd.finding.disposition', 'nd.finding.kind',
        'nd.finding.severity', 'nd.finding.work', 'nd.finding.observed']);
      t.add('pl.finding.list.byKind', 'breakdownChart', findingList,
        { aggregate: 'count', groupByFieldId: 'nd.finding.kind', title: 'By kind' });
      const finding = t.add('pl.finding.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.finding', title: 'Finding',
        titleFieldId: 'nd.finding.title', subtitleFieldId: 'nd.finding.ref', accentFieldId: 'nd.finding.disposition',
      });
      t.bindings(finding, ['nd.finding.title', 'nd.finding.kind', 'nd.finding.disposition', 'nd.finding.severity',
        'nd.finding.work', 'nd.finding.observed', 'nd.finding.observation', 'nd.finding.context',
        'nd.finding.guard', 'nd.finding.sources']);

      const outcomes = t.add('pl.check.board', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.check', title: 'By outcome',
        groupByFieldId: 'nd.check.outcome', orderByFieldId: 'nd.check.ref', orderDirection: 'descending',
      });
      t.bindings(outcomes, ['nd.check.title', 'nd.check.ref', 'nd.check.method', 'nd.check.work']);
      t.add('pl.check.board.column', 'summaryTile', outcomes, { aggregate: 'count', title: 'Here', scope: 'group' });
      const checkList = t.add('pl.check.list', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.check', title: 'All checks',
        orderByFieldId: 'nd.check.ref', orderDirection: 'descending',
      });
      t.bindings(checkList, ['nd.check.title', 'nd.check.ref', 'nd.check.outcome', 'nd.check.method',
        'nd.check.work', 'nd.check.executed']);
      t.add('pl.check.list.byMethod', 'breakdownChart', checkList,
        { aggregate: 'count', groupByFieldId: 'nd.check.method', title: 'By method' });
      const check = t.add('pl.check.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.check', title: 'Check',
        titleFieldId: 'nd.check.title', subtitleFieldId: 'nd.check.ref', accentFieldId: 'nd.check.outcome',
      });
      t.bindings(check, ['nd.check.title', 'nd.check.work', 'nd.check.method', 'nd.check.outcome',
        'nd.check.executed', 'nd.check.environment', 'nd.check.expected', 'nd.check.actual',
        'nd.check.procedure', 'nd.check.evidence']);

      const decisions = t.add('pl.decision.board', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.decision', title: 'Decisions',
        groupByFieldId: 'nd.decision.status', orderByFieldId: 'nd.decision.ref', orderDirection: 'descending',
      });
      t.bindings(decisions, ['nd.decision.title', 'nd.decision.ref', 'nd.decision.workCount', 'nd.decision.decided']);
      const decision = t.add('pl.decision.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.decision', title: 'Decision',
        titleFieldId: 'nd.decision.title', subtitleFieldId: 'nd.decision.ref', accentFieldId: 'nd.decision.status',
      });
      t.bindings(decision, ['nd.decision.title', 'nd.decision.status', 'nd.decision.question', 'nd.decision.options',
        'nd.decision.recommendation', 'nd.decision.outcome', 'nd.decision.decided', 'nd.decision.sources']);
      const waiting = t.add('pl.decision.page.work', 'relatedList', decision, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.decision', title: 'Work waiting on it',
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(waiting, ['nd.work.title', 'nd.work.ref', 'nd.work.status']);

      const linkList = t.add('pl.link.list', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.link', title: 'Dependencies',
        orderByFieldId: 'nd.link.to', orderDirection: 'ascending',
      });
      t.bindings(linkList, ['nd.link.from', 'nd.link.to', 'nd.link.note']);
      const link = t.add('pl.link.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.link', title: 'Dependency',
      });
      t.bindings(link, ['nd.link.from', 'nd.link.to', 'nd.link.note']);

      return t.asMutations('Screens and pages for the other record types');
    },
  },

  front: {
    title: 'Planner: the front page and the commands',
    needs: ['nd.work', 'nd.check', 'nd.finding', 'nd.initiative', 'nd.decision'],
    appliedWhen: async read => read.hasNode('pl.front'),
    mutations: () => {
      const t = tree();
      const front = t.add('pl.front', 'overviewSurface', null, {
        definitionVersion: 3, title: 'Nendo planner',
        description: 'What is being built now, what was delivered, and the evidence and decisions behind it. A passing check never completes work by itself.',
      });
      const tabs = t.add('pl.front.tabs', 'tabGroup', front, { title: 'Planner' });

      const now = t.add('pl.front.now', 'section', tabs, { title: 'Now' });
      for (const [name, title, status] of [['doing', 'Doing', 'Doing'], ['review', 'In review', 'Review'],
        ['blocked', 'Blocked', 'Blocked']]) {
        const tile = t.add(`pl.front.now.${name}`, 'summaryTile', now, { entityId: 'nd.work', aggregate: 'count', title });
        t.where(tile, 'status', 'nd.work.status', 'eq', status);
      }
      const ready = t.add('pl.front.now.ready', 'summaryTile', now,
        { entityId: 'nd.work', aggregate: 'count', title: 'Ready in Now' });
      t.where(ready, 'status', 'nd.work.status', 'eq', 'Ready');
      t.where(ready, 'now', 'nd.work.horizon', 'eq', 'Now');
      const nowList = t.add('pl.front.now.list', 'recentList', now, {
        entityId: 'nd.work', title: 'In Now, in planning order', limit: 10,
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(nowList, ['nd.work.title', 'nd.work.ref', 'nd.work.status']);
      t.where(nowList, 'now', 'nd.work.horizon', 'eq', 'Now');
      t.add('pl.front.now.byHorizon', 'breakdownChart', now,
        { entityId: 'nd.work', aggregate: 'count', groupByFieldId: 'nd.work.horizon', title: 'Open work by horizon' });
      // The breakdown's unset group is closed work, so the chart states only open work.
      t.where('pl.front.now.byHorizon', 'open', 'nd.work.status', 'ne', 'Done');
      t.where('pl.front.now.byHorizon', 'live', 'nd.work.status', 'ne', 'Dropped');

      const delivery = t.add('pl.front.delivery', 'section', tabs, { title: 'Delivery' });
      const done = t.add('pl.front.delivery.count', 'summaryTile', delivery,
        { entityId: 'nd.work', aggregate: 'count', title: 'Delivered' });
      t.where(done, 'done', 'nd.work.status', 'eq', 'Done');
      t.add('pl.front.delivery.span', 'rangeTile', delivery,
        { entityId: 'nd.work', fieldId: 'nd.work.completed', title: 'Delivered between' });
      t.add('pl.front.delivery.byMonth', 'trendChart', delivery, {
        entityId: 'nd.work', dateFieldId: 'nd.work.completed', bucket: 'month', range: 'last12Months',
        aggregate: 'count', title: 'Delivered by month',
      });
      t.add('pl.front.delivery.days', 'activityGrid', delivery, {
        entityId: 'nd.work', dateFieldId: 'nd.work.completed', range: 'thisYear', title: 'Days anything was delivered',
      });
      const lately = t.add('pl.front.delivery.lately', 'recentList', delivery, {
        entityId: 'nd.work', title: 'Delivered lately', limit: 5,
        orderByFieldId: 'nd.work.completed', orderDirection: 'descending',
      });
      t.bindings(lately, ['nd.work.title', 'nd.work.ref', 'nd.work.completed']);
      t.where(lately, 'done', 'nd.work.status', 'eq', 'Done');

      const evidence = t.add('pl.front.evidence', 'section', tabs, { title: 'Evidence' });
      t.add('pl.front.evidence.checks', 'summaryTile', evidence, { entityId: 'nd.check', aggregate: 'count', title: 'Checks' });
      const untriaged = t.add('pl.front.evidence.untriaged', 'summaryTile', evidence,
        { entityId: 'nd.finding', aggregate: 'count', title: 'Untriaged findings' });
      t.where(untriaged, 'untriaged', 'nd.finding.disposition', 'eq', 'Untriaged');
      t.add('pl.front.evidence.outcome', 'breakdownChart', evidence,
        { entityId: 'nd.check', aggregate: 'count', groupByFieldId: 'nd.check.outcome', title: 'Checks by outcome' });
      t.add('pl.front.evidence.method', 'breakdownChart', evidence,
        { entityId: 'nd.check', aggregate: 'count', groupByFieldId: 'nd.check.method', title: 'Checks by method' });
      t.add('pl.front.evidence.disposition', 'breakdownChart', evidence,
        { entityId: 'nd.finding', aggregate: 'count', groupByFieldId: 'nd.finding.disposition', title: 'Findings by disposition' });
      const recent = t.add('pl.front.evidence.recent', 'recentList', evidence, {
        entityId: 'nd.finding', title: 'Latest findings', limit: 5,
        orderByFieldId: 'nd.finding.ref', orderDirection: 'descending',
      });
      t.bindings(recent, ['nd.finding.title', 'nd.finding.ref', 'nd.finding.disposition']);

      const decided = t.add('pl.front.decisions', 'section', tabs, { title: 'Decisions' });
      const open = t.add('pl.front.decisions.open', 'summaryTile', decided,
        { entityId: 'nd.decision', aggregate: 'count', title: 'Waiting for the owner' });
      t.where(open, 'open', 'nd.decision.status', 'eq', 'Open');
      const openList = t.add('pl.front.decisions.list', 'recentList', decided, {
        entityId: 'nd.decision', title: 'Open decisions', limit: 10,
        orderByFieldId: 'nd.decision.ref', orderDirection: 'ascending',
      });
      t.bindings(openList, ['nd.decision.title', 'nd.decision.ref', 'nd.decision.workCount']);
      t.where(openList, 'open', 'nd.decision.status', 'eq', 'Open');
      const needs = t.add('pl.front.decisions.needs', 'summaryTile', decided,
        { entityId: 'nd.work', aggregate: 'count', title: 'Open work needing a decision' });
      t.where(needs, 'needs', 'nd.work.standing', 'eq', 'Needs decision/ADR');
      t.where(needs, 'open', 'nd.work.status', 'ne', 'Done');
      t.where(needs, 'live', 'nd.work.status', 'ne', 'Dropped');

      // Explicit convenience edits, not a guarded state machine. Closing work clears
      // its horizon, because a horizon on closed work says nothing.
      t.command('pl.cmd.planNow', 'nd.work', 'Plan now',
        [['nd.work.horizon', 'literal', 'Now'], ['nd.work.status', 'literal', 'Ready']]);
      t.command('pl.cmd.start', 'nd.work', 'Start',
        [['nd.work.status', 'literal', 'Doing'], ['nd.work.started', 'today']]);
      t.command('pl.cmd.review', 'nd.work', 'Send to review', [['nd.work.status', 'literal', 'Review']]);
      t.command('pl.cmd.complete', 'nd.work', 'Complete',
        [['nd.work.status', 'literal', 'Done'], ['nd.work.completed', 'today'], ['nd.work.horizon', 'null']]);
      t.command('pl.cmd.drop', 'nd.work', 'Drop',
        [['nd.work.status', 'literal', 'Dropped'], ['nd.work.horizon', 'null']]);
      t.command('pl.cmd.reopen', 'nd.work', 'Reopen',
        [['nd.work.status', 'literal', 'Ready'], ['nd.work.completed', 'null'], ['nd.work.horizon', 'literal', 'Next']]);
      t.command('pl.cmd.reviewed', 'nd.initiative', 'Mark reviewed', [['nd.initiative.reviewed', 'today']]);
      t.command('pl.cmd.decide', 'nd.decision', 'Decide',
        [['nd.decision.status', 'literal', 'Decided'], ['nd.decision.decided', 'today']]);

      return t.asMutations('The front page and the commands');
    },
  },

  dependencies: {
    title: 'Planner: carry the Work dependencies view in the file',
    needs: ['nd.work', 'nd.link'],
    appliedWhen: async read => read.hasNode('pl.work.dependencies'),
    mutations: async () => {
      const { manifest, files } = await packageFiles();
      const operations = [op('extension.setPackage', {
        packageId: PACKAGE_ID, title: manifest.title, entryPoint: manifest.entryPoint ?? 'index.html',
        version: manifest.version, description: manifest.description,
      })];
      // One extension.putFile carries 96 KiB of JSON, where base64 makes bytes a third larger.
      const partBytes = 70 * 1024;
      for (const file of files) {
        for (let offset = 0; offset === 0 || offset < file.bytes.length; offset += partBytes) {
          operations.push(op('extension.putFile', {
            packageId: PACKAGE_ID, path: file.path, base64: file.bytes.subarray(offset, offset + partBytes).toString('base64'),
            ...(offset === 0 ? { expectedSha256: 'absent' } : { append: true }),
          }));
        }
      }
      const t = tree();
      const graph = t.add('pl.work.dependencies', 'extensionGraphSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Dependencies', packageId: PACKAGE_ID,
        labelFieldId: 'nd.work.title', statusFieldId: 'nd.work.status',
        edgeEntityId: 'nd.link', sourceFieldId: 'nd.link.from', targetFieldId: 'nd.link.to',
      });
      t.bindings(graph, ['nd.work.ref', 'nd.work.horizon', 'nd.work.initiative']);
      // A call body is bounded too, so a mutation of file parts closes at CALL_CHARACTERS.
      const mutations = [];
      for (const operation of operations) {
        const size = JSON.stringify(operation).length;
        const last = mutations.at(-1);
        if (!last || last.operations.length === 16 || last.size + size > CALL_CHARACTERS) {
          mutations.push({ description: 'Put the Work dependencies package into the file', operations: [], size: 0 });
        }
        mutations.at(-1).operations.push(operation);
        mutations.at(-1).size += size;
      }
      return [...mutations.map(({ description, operations }) => ({ description, operations })),
        ...t.asMutations('Show the dependency graph')];
    },
  },
};

export const STAGE_ORDER = ['schema', 'colour', 'behaviour', 'work', 'records', 'front', 'dependencies'];

async function packageFiles() {
  const manifest = JSON.parse(await fs.readFile(path.join(PACKAGE_FOLDER, 'nendo-package.json'), 'utf8'));
  const names = (await fs.readdir(PACKAGE_FOLDER, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.relative(PACKAGE_FOLDER, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'))
    .filter(name => name !== 'nendo-package.json' && !name.split('/').some(part => part.startsWith('.')))
    .sort();
  const files = [];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(PACKAGE_FOLDER, name));
    files.push({ path: name, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return { manifest, files };
}

// How a record of Nendo.nendo becomes a record of Planner.nendo. Every field the
// new type has is copied as it stands, except for these, and the compare stage
// holds the migration to exactly this list.
export const CARRY = [
  { entityId: 'nd.initiative', transform: values => ({ ...values, 'nd.initiative.status': 'Active' }) },
  {
    entityId: 'nd.work',
    // A horizon on closed work said nothing; here closed work has none.
    transform: values => ['Done', 'Dropped'].includes(values['nd.work.status'])
      ? { ...values, 'nd.work.horizon': null } : values,
  },
  { entityId: 'nd.link', transform: values => values },
  {
    entityId: 'nd.finding',
    transform: values => values['nd.finding.disposition'] === 'Linked to work'
      ? { ...values, 'nd.finding.disposition': 'Tracked in work' } : values,
  },
  { entityId: 'nd.check', transform: values => values },
];

// Fields of Nendo.nendo that deliberately do not cross, with the reason.
export const LEFT_BEHIND = {
  'nd.initiative.reviewNeeded': 'the flag an always-on action raised; the review date remains',
};
