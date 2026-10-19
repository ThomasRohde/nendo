// The shape of PlannerNG.nendo, the next planner: record types, calculations, screens,
// front page and commands, one stage per change set. tools/Build-Planner.mjs --ng sends
// them; this file only says what they are. docs/design/planner-ng.md gives the reasons.
//
// Entity, field and command IDs keep the nd.* and pl.cmd.* names of Planner.nendo
// wherever the meaning is the same, so the planner mod, /next and the skill read the
// work the way they read it now. Nothing is migrated: the file starts at W-001.

export const SURFACE = 'planner';
// What one add_operations call may carry, as Put-NendoPackage.mjs measures it.
export const CALL_CHARACTERS = 200_000;
export const TARGET_FILE_NAME = 'PlannerNG.nendo';

const op = (operationType, payload) => ({ operationType, payload });
const text = (entityId, fieldId, displayName, required = false, presentation = 'singleLine') =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation, options: [] });
const long = (entityId, fieldId, displayName) => text(entityId, fieldId, displayName, false, 'longText');
// Briefs, criteria and observations are written in Markdown and shown formatted.
const md = (entityId, fieldId, displayName) => text(entityId, fieldId, displayName, false, 'markdown');
const choice = (entityId, fieldId, displayName, options, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation: 'singleChoice', options });
const date = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Date', required: false, presentation: 'date', options: [] });
const integer = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Integer', required: false, presentation: null, options: [] });
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
const calculation = (definitionId, entityId, fieldId, displayName, resultType, expression, bindings) =>
  op('behaviour.setDefinition', { definitionId, definitionKind: 'Calculation', body: {
    entityId, fieldId, displayName, resultType, resultNullable: false, expression, bindings, callAliases: [],
  } });
const field = (bindingId, entityId, fieldId, resultType) =>
  ({ bindingId, kind: 'SameRecordField', entityId, fieldId, resultType, nullable: false });
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
  const open = parentNodeId => {
    where(parentNodeId, 'open', 'nd.work.status', 'ne', 'Done');
    where(parentNodeId, 'live', 'nd.work.status', 'ne', 'Dropped');
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
  return { add, bindings, where, open, command, asMutations };
}

const chunk = (description, operations) => {
  const mutations = [];
  for (let start = 0; start < operations.length; start += 16) {
    mutations.push({ description, operations: operations.slice(start, start + 16) });
  }
  return mutations;
};

export const PURPOSE = [
  'The planner for building Nendo. The owner and the agents working on the code read and write it, and it',
  'is the one place priorities, handoffs and evidence live.',
  '',
  'A Work item says what is being built and what would settle it. Its Next action is the one line that',
  'says what happens next, and Held by says who has it, so two clients never take the same item.',
  'Decision standing says whether it may be built yet: work that needs the owner to choose points at a',
  'Decision, and no product source changes until that decision is made.',
  '',
  'Findings are what was observed: defects, friction and the limitations that are staying, each with the',
  'guard that now catches it and the failure seen when the defect was put back. Checks are what was',
  'measured for one work item, with how it was measured kept apart from what came out. A passing check',
  'never completes work: a person reads the evidence and decides.',
  '',
  'Horizon is priority (Now, Next, Later) and only open work has one. Status is how far the work has got.',
  'What is unfinished stays open and visible, and dates nobody has established stay empty.',
].join('\n');

export const STAGES = {
  schema: {
    title: 'Planner NG: the record types',
    makes: ['nd.initiative', 'nd.decision', 'nd.work', 'nd.finding', 'nd.check'],
    mutations: () => [
      {
        description: 'Say what this file is for, and give it a look of its own',
        operations: [
          op('application.setPurpose', { purpose: PURPOSE }),
          // Teal, so it is not mistaken for the violet Planner.nendo while both are open.
          op('application.setLook', { tone: 'teal', letter: 'P' }),
        ],
      },
      {
        description: 'Create Initiatives, the outcome a run of work serves',
        operations: [
          op('schema.createEntity', { entityId: 'nd.initiative', displayName: 'Initiatives' }),
          text('nd.initiative', 'nd.initiative.title', 'Title', true),
          text('nd.initiative', 'nd.initiative.ref', 'Reference', true),
          choice('nd.initiative', 'nd.initiative.status', 'Status', ['Active', 'Paused', 'Closed'], true),
          md('nd.initiative', 'nd.initiative.outcome', 'Desired outcome'),
        ],
      },
      {
        description: 'Create Decisions, the questions only the owner answers',
        operations: [
          op('schema.createEntity', { entityId: 'nd.decision', displayName: 'Decisions' }),
          text('nd.decision', 'nd.decision.title', 'Title', true),
          text('nd.decision', 'nd.decision.ref', 'Reference', true),
          choice('nd.decision', 'nd.decision.status', 'Status', ['Open', 'Decided', 'Superseded'], true),
          md('nd.decision', 'nd.decision.question', 'Question and options'),
          md('nd.decision', 'nd.decision.recommendation', 'Recommendation'),
          md('nd.decision', 'nd.decision.outcome', 'Decided'),
          date('nd.decision', 'nd.decision.decided', 'Decided on'),
          text('nd.decision', 'nd.decision.adr', 'ADR'),
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
            ['Within accepted scope', 'Needs decision/ADR'], true),
        ],
      },
      {
        description: 'Give Work items the rest of their fields',
        operations: [
          // Optional, so closed work has no horizon rather than a false one.
          choice('nd.work', 'nd.work.horizon', 'Horizon', ['Now', 'Next', 'Later']),
          text('nd.work', 'nd.work.next', 'Next action'),
          choice('nd.work', 'nd.work.heldBy', 'Held by', ['Owner', 'Claude Code', 'Codex']),
          md('nd.work', 'nd.work.description', 'Brief'),
          md('nd.work', 'nd.work.acceptance', 'Acceptance criteria'),
          md('nd.work', 'nd.work.handoff', 'Handoff log'),
          md('nd.work', 'nd.work.sources', 'Sources'),
          long('nd.work', 'nd.work.blocker', 'Blocker'),
          reference('nd.work', 'nd.work.initiative', 'Initiative'),
          reference('nd.work', 'nd.work.parent', 'Part of'),
          reference('nd.work', 'nd.work.decision', 'Waits on decision'),
          integer('nd.work', 'nd.work.order', 'Planning order'),
          date('nd.work', 'nd.work.started', 'Started on'),
          date('nd.work', 'nd.work.completed', 'Completed on'),
        ],
      },
      {
        description: 'Create Findings',
        operations: [
          op('schema.createEntity', { entityId: 'nd.finding', displayName: 'Findings' }),
          text('nd.finding', 'nd.finding.title', 'Title', true),
          text('nd.finding', 'nd.finding.ref', 'Reference', true),
          choice('nd.finding', 'nd.finding.kind', 'Kind', ['Defect', 'Friction', 'Known limitation', 'Idea'], true),
          choice('nd.finding', 'nd.finding.disposition', 'Disposition',
            ['Untriaged', 'Investigating', 'Tracked in work', 'Accepted limitation', 'Resolved'], true),
          choice('nd.finding', 'nd.finding.severity', 'Severity', ['Low', 'Medium', 'High', 'Critical']),
          md('nd.finding', 'nd.finding.observation', 'Observation'),
          md('nd.finding', 'nd.finding.guard', 'Guard and its falsification'),
          date('nd.finding', 'nd.finding.observed', 'Observed on'),
          reference('nd.finding', 'nd.finding.work', 'Work item'),
        ],
      },
      {
        description: 'Create Checks, one measured outcome for one work item',
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
          text('nd.check', 'nd.check.environment', 'Build / environment'),
          date('nd.check', 'nd.check.executed', 'Executed on'),
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
        ],
      },
      {
        description: 'Number every Reference, and keep each one unique',
        operations: [
          ...numbered('nd.initiative', 'nd.initiative.ref', 'I-'),
          ...numbered('nd.decision', 'nd.decision.ref', 'D-'),
          ...numbered('nd.work', 'nd.work.ref', 'W-'),
          ...numbered('nd.finding', 'nd.finding.ref', 'F-'),
          ...numbered('nd.check', 'nd.check.ref', 'C-'),
        ],
      },
      {
        // Planning order is the order among siblings, so the board and the page's parts
        // keep one order without ranges numbered by hand.
        description: 'Let work be broken into parts, ordered by its planning order',
        operations: [
          op('schema.declareHierarchy', { entityId: 'nd.work', parentFieldId: 'nd.work.parent', orderFieldId: 'nd.work.order' }),
        ],
      },
    ],
  },

  colour: {
    title: 'Planner NG: colour the choices',
    needs: ['nd.initiative', 'nd.decision', 'nd.work', 'nd.finding', 'nd.check'],
    appliedWhen: async read => (await read.schema('nd.work')).fields
      .find(f => f.fieldId === 'nd.work.status')?.choices.some(c => c.tone) ?? false,
    mutations: () => {
      const tones = [
        ['nd.work', 'nd.work.status', [['Inbox', 'grey'], ['Ready', 'blue'], ['Doing', 'violet'], ['Blocked', 'red'],
          ['Review', 'amber'], ['Done', 'green'], ['Dropped', 'grey']]],
        ['nd.work', 'nd.work.horizon', [['Now', 'teal'], ['Next', 'blue'], ['Later', 'grey']]],
        ['nd.work', 'nd.work.standing', [['Within accepted scope', 'green'], ['Needs decision/ADR', 'amber']]],
        ['nd.work', 'nd.work.kind', [['Feature', 'blue'], ['Defect', 'red'], ['Improvement', 'teal'],
          ['Investigation', 'violet'], ['Qualification', 'amber'], ['Documentation', 'grey']]],
        ['nd.work', 'nd.work.heldBy', [['Owner', 'teal'], ['Claude Code', 'orange'], ['Codex', 'blue']]],
        ['nd.check', 'nd.check.outcome', [['Not run', 'grey'], ['Passed', 'green'], ['Failed', 'red'],
          ['Blocked', 'orange'], ['Accepted exception', 'amber']]],
        ['nd.check', 'nd.check.method', [['Automated', 'blue'], ['Agent-observed', 'violet'], ['Owner-reported', 'teal']]],
        ['nd.finding', 'nd.finding.disposition', [['Untriaged', 'orange'], ['Investigating', 'violet'],
          ['Tracked in work', 'blue'], ['Accepted limitation', 'grey'], ['Resolved', 'green']]],
        ['nd.finding', 'nd.finding.kind', [['Defect', 'red'], ['Friction', 'amber'], ['Known limitation', 'grey'],
          ['Idea', 'blue']]],
        ['nd.finding', 'nd.finding.severity', [['Low', 'grey'], ['Medium', 'amber'], ['High', 'orange'], ['Critical', 'red']]],
        ['nd.initiative', 'nd.initiative.status', [['Active', 'green'], ['Paused', 'amber'], ['Closed', 'grey']]],
        ['nd.decision', 'nd.decision.status', [['Open', 'amber'], ['Decided', 'green'], ['Superseded', 'grey']]],
      ];
      return chunk('Colour the choices', tones.flatMap(([entityId, fieldId, pairs]) =>
        pairs.map(([choiceId, toneName]) => tone(entityId, fieldId, choiceId, toneName))));
    },
  },

  behaviour: {
    title: 'Planner NG: what it works out for itself',
    needs: ['nd.work', 'nd.initiative', 'nd.decision'],
    appliedWhen: async read => (await read.schema('nd.work')).derivedFields.length > 0,
    mutations: () => [
      {
        description: 'Whether work is blocked, and how much work an initiative and a decision hold',
        operations: [
          // Shows the Blocker section only while the work is blocked; the planner mod reads it too.
          calculation('nd.calc.isBlocked', 'nd.work', 'nd.work.isBlocked', 'Is blocked', 'Boolean',
            "status == 'Blocked'", [field('status', 'nd.work', 'nd.work.status', 'Text')]),
          calculation('nd.calc.workCount', 'nd.initiative', 'nd.initiative.workCount', 'Work items', 'Integer',
            'work', [related('work', 'nd.initiative', 'nd.work', 'nd.work.initiative')]),
          calculation('nd.calc.decisionWork', 'nd.decision', 'nd.decision.workCount', 'Work waiting on it', 'Integer',
            'work', [related('work', 'nd.decision', 'nd.work', 'nd.work.decision')]),
        ],
      },
    ],
  },

  work: {
    title: 'Planner NG: the work, seen three ways, and its page',
    needs: ['nd.work', 'nd.check', 'nd.finding'],
    appliedWhen: async read => read.hasNode('pl.work.now'),
    mutations: () => {
      const t = tree();

      // Daily: the Now lane by status. Its Review column is the owner's queue.
      const now = t.add('pl.work.now', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Now',
        groupByFieldId: 'nd.work.status', orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(now, ['nd.work.title', 'nd.work.ref', 'nd.work.next', 'nd.work.heldBy', 'nd.work.kind']);
      t.where(now, 'now', 'nd.work.horizon', 'eq', 'Now');
      t.add('pl.work.now.column', 'summaryTile', now, { aggregate: 'count', title: 'Here', scope: 'group' });

      // Planning: open work by horizon. Its empty-horizon column is the untriaged inbox.
      const plan = t.add('pl.work.plan', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Plan',
        groupByFieldId: 'nd.work.horizon', orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(plan, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.standing', 'nd.work.initiative']);
      t.open(plan);
      t.add('pl.work.plan.column', 'summaryTile', plan, { aggregate: 'count', title: 'Open here', scope: 'group' });

      // History and search: every item, newest first.
      const all = t.add('pl.work.all', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'All work',
        orderByFieldId: 'nd.work.ref', orderDirection: 'descending',
      });
      t.bindings(all, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.horizon', 'nd.work.kind',
        'nd.work.initiative', 'nd.work.completed']);
      t.add('pl.work.all.count', 'summaryTile', all, { aggregate: 'count', title: 'Work items' });

      const page = t.add('pl.work.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.work', title: 'Work item',
        titleFieldId: 'nd.work.title', subtitleFieldId: 'nd.work.ref', accentFieldId: 'nd.work.status',
      });
      t.bindings(page, ['nd.work.status', 'nd.work.horizon', 'nd.work.standing', 'nd.work.heldBy', 'nd.work.next']);
      const blocked = t.add('pl.work.page.blocked', 'section', page,
        { title: 'Blocked', visibleWhen: 'nd.work.isBlocked' });
      t.bindings(blocked, ['nd.work.blocker']);
      const tabs = t.add('pl.work.page.tabs', 'tabGroup', page, { title: 'Work item' });

      const brief = t.add('pl.work.page.brief', 'section', tabs, { title: 'Brief' });
      t.bindings(brief, ['nd.work.title', 'nd.work.description', 'nd.work.acceptance', 'nd.work.sources']);

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

      const handoff = t.add('pl.work.page.handoff', 'section', tabs, { title: 'Handoff' });
      t.bindings(handoff, ['nd.work.handoff']);

      const details = t.add('pl.work.page.details', 'section', tabs, { title: 'Details' });
      t.bindings(details, ['nd.work.kind', 'nd.work.initiative', 'nd.work.decision', 'nd.work.parent',
        'nd.work.order', 'nd.work.started', 'nd.work.completed', 'nd.work.blocker']);
      const parts = t.add('pl.work.page.parts', 'relatedList', details, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.parent', title: 'Parts',
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(parts, ['nd.work.title', 'nd.work.ref', 'nd.work.status']);

      return t.asMutations('The work screens and the work page');
    },
  },

  records: {
    title: 'Planner NG: findings, checks, decisions and initiatives',
    needs: ['nd.initiative', 'nd.finding', 'nd.check', 'nd.decision'],
    appliedWhen: async read => read.hasNode('pl.finding.triage'),
    mutations: () => {
      const t = tree();

      // Triage shows only what still needs a hand; the list keeps everything.
      const triage = t.add('pl.finding.triage', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.finding', title: 'Triage',
        groupByFieldId: 'nd.finding.disposition', orderByFieldId: 'nd.finding.ref', orderDirection: 'descending',
      });
      t.bindings(triage, ['nd.finding.title', 'nd.finding.ref', 'nd.finding.kind', 'nd.finding.severity', 'nd.finding.work']);
      t.where(triage, 'unresolved', 'nd.finding.disposition', 'ne', 'Resolved');
      t.where(triage, 'unaccepted', 'nd.finding.disposition', 'ne', 'Accepted limitation');
      t.add('pl.finding.triage.column', 'summaryTile', triage, { aggregate: 'count', title: 'Here', scope: 'group' });
      const findingList = t.add('pl.finding.list', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.finding', title: 'All findings',
        orderByFieldId: 'nd.finding.ref', orderDirection: 'descending',
      });
      t.bindings(findingList, ['nd.finding.title', 'nd.finding.ref', 'nd.finding.disposition', 'nd.finding.kind',
        'nd.finding.severity', 'nd.finding.work', 'nd.finding.observed']);
      const finding = t.add('pl.finding.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.finding', title: 'Finding',
        titleFieldId: 'nd.finding.title', subtitleFieldId: 'nd.finding.ref', accentFieldId: 'nd.finding.disposition',
      });
      t.bindings(finding, ['nd.finding.title', 'nd.finding.kind', 'nd.finding.disposition', 'nd.finding.severity',
        'nd.finding.work', 'nd.finding.observed', 'nd.finding.observation', 'nd.finding.guard']);

      const checkList = t.add('pl.check.list', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.check', title: 'Checks',
        orderByFieldId: 'nd.check.ref', orderDirection: 'descending',
      });
      t.bindings(checkList, ['nd.check.title', 'nd.check.ref', 'nd.check.outcome', 'nd.check.method',
        'nd.check.work', 'nd.check.executed']);
      const check = t.add('pl.check.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.check', title: 'Check',
        titleFieldId: 'nd.check.title', subtitleFieldId: 'nd.check.ref', accentFieldId: 'nd.check.outcome',
      });
      t.bindings(check, ['nd.check.title', 'nd.check.work', 'nd.check.method', 'nd.check.outcome',
        'nd.check.executed', 'nd.check.environment', 'nd.check.expected', 'nd.check.actual', 'nd.check.procedure']);

      const decisions = t.add('pl.decision.board', 'boardSurface', null, {
        definitionVersion: 3, entityId: 'nd.decision', title: 'Decisions',
        groupByFieldId: 'nd.decision.status', orderByFieldId: 'nd.decision.ref', orderDirection: 'descending',
      });
      t.bindings(decisions, ['nd.decision.title', 'nd.decision.ref', 'nd.decision.workCount', 'nd.decision.decided']);
      const decision = t.add('pl.decision.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.decision', title: 'Decision',
        titleFieldId: 'nd.decision.title', subtitleFieldId: 'nd.decision.ref', accentFieldId: 'nd.decision.status',
      });
      t.bindings(decision, ['nd.decision.title', 'nd.decision.status', 'nd.decision.question',
        'nd.decision.recommendation', 'nd.decision.outcome', 'nd.decision.decided', 'nd.decision.adr']);
      const waiting = t.add('pl.decision.page.work', 'relatedList', decision, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.decision', title: 'Work waiting on it',
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(waiting, ['nd.work.title', 'nd.work.ref', 'nd.work.status']);

      const initiatives = t.add('pl.initiative.list', 'recordList', null, {
        definitionVersion: 3, entityId: 'nd.initiative', title: 'Initiatives',
        orderByFieldId: 'nd.initiative.ref', orderDirection: 'descending',
      });
      t.bindings(initiatives, ['nd.initiative.title', 'nd.initiative.ref', 'nd.initiative.status', 'nd.initiative.workCount']);
      const initiative = t.add('pl.initiative.page', 'detailSurface', null, {
        definitionVersion: 3, entityId: 'nd.initiative', title: 'Initiative',
        titleFieldId: 'nd.initiative.title', subtitleFieldId: 'nd.initiative.ref', accentFieldId: 'nd.initiative.status',
      });
      t.bindings(initiative, ['nd.initiative.title', 'nd.initiative.status', 'nd.initiative.outcome']);
      const openWork = t.add('pl.initiative.page.open', 'relatedList', initiative, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.initiative', title: 'Open work',
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(openWork, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.horizon']);
      t.open(openWork);
      t.add('pl.initiative.page.open.count', 'summaryTile', openWork, { aggregate: 'count', title: 'Open' });
      const delivered = t.add('pl.initiative.page.deliveredSection', 'section', initiative,
        { title: 'Delivered', opens: 'closed' });
      const deliveredWork = t.add('pl.initiative.page.delivered', 'relatedList', delivered, {
        targetEntityId: 'nd.work', viaFieldId: 'nd.work.initiative', title: 'Delivered work',
        orderByFieldId: 'nd.work.completed', orderDirection: 'descending',
      });
      t.bindings(deliveredWork, ['nd.work.title', 'nd.work.ref', 'nd.work.completed']);
      t.where(deliveredWork, 'done', 'nd.work.status', 'eq', 'Done');

      return t.asMutations('Screens and pages for the other record types');
    },
  },

  front: {
    title: 'Planner NG: the front page and the commands',
    needs: ['nd.work', 'nd.finding', 'nd.decision'],
    appliedWhen: async read => read.hasNode('pl.front'),
    mutations: () => {
      const t = tree();
      const front = t.add('pl.front', 'overviewSurface', null, {
        definitionVersion: 3, title: 'Nendo planner',
        description: 'What is being built now, what waits for the owner, and what was seen and delivered. A passing check never completes work by itself.',
      });

      const now = t.add('pl.front.now', 'section', front, { title: 'Now' });
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
        entityId: 'nd.work', title: 'Now, in planning order', limit: 10,
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(nowList, ['nd.work.title', 'nd.work.ref', 'nd.work.status', 'nd.work.next']);
      t.where(nowList, 'now', 'nd.work.horizon', 'eq', 'Now');

      const owner = t.add('pl.front.owner', 'section', front, { title: 'Waiting for the owner' });
      const review = t.add('pl.front.owner.review', 'recentList', owner, {
        entityId: 'nd.work', title: 'In review', limit: 10,
        orderByFieldId: 'nd.work.order', orderDirection: 'ascending',
      });
      t.bindings(review, ['nd.work.title', 'nd.work.ref', 'nd.work.next']);
      t.where(review, 'review', 'nd.work.status', 'eq', 'Review');
      const decisions = t.add('pl.front.owner.decisions', 'recentList', owner, {
        entityId: 'nd.decision', title: 'Open decisions', limit: 10,
        orderByFieldId: 'nd.decision.ref', orderDirection: 'ascending',
      });
      t.bindings(decisions, ['nd.decision.title', 'nd.decision.ref', 'nd.decision.workCount']);
      t.where(decisions, 'open', 'nd.decision.status', 'eq', 'Open');

      const seen = t.add('pl.front.findings', 'section', front, { title: 'Findings' });
      const untriaged = t.add('pl.front.findings.untriaged', 'summaryTile', seen,
        { entityId: 'nd.finding', aggregate: 'count', title: 'Untriaged' });
      t.where(untriaged, 'untriaged', 'nd.finding.disposition', 'eq', 'Untriaged');
      const latest = t.add('pl.front.findings.list', 'recentList', seen, {
        entityId: 'nd.finding', title: 'Untriaged, newest first', limit: 10,
        orderByFieldId: 'nd.finding.ref', orderDirection: 'descending',
      });
      t.bindings(latest, ['nd.finding.title', 'nd.finding.ref', 'nd.finding.kind', 'nd.finding.severity']);
      t.where(latest, 'untriaged', 'nd.finding.disposition', 'eq', 'Untriaged');

      const delivery = t.add('pl.front.delivery', 'section', front, { title: 'Delivered' });
      const byMonth = t.add('pl.front.delivery.byMonth', 'trendChart', delivery, {
        entityId: 'nd.work', dateFieldId: 'nd.work.completed', bucket: 'month', range: 'last12Months',
        aggregate: 'count', title: 'Delivered by month',
      });
      t.where(byMonth, 'done', 'nd.work.status', 'eq', 'Done');
      const lately = t.add('pl.front.delivery.lately', 'recentList', delivery, {
        entityId: 'nd.work', title: 'Delivered lately', limit: 5,
        orderByFieldId: 'nd.work.completed', orderDirection: 'descending',
      });
      t.bindings(lately, ['nd.work.title', 'nd.work.ref', 'nd.work.completed']);
      t.where(lately, 'done', 'nd.work.status', 'eq', 'Done');

      // Explicit convenience edits, not a guarded state machine. Closing work clears its
      // horizon, its holder and its next action, because on closed work they say nothing.
      t.command('pl.cmd.planNow', 'nd.work', 'Plan now',
        [['nd.work.horizon', 'literal', 'Now'], ['nd.work.status', 'literal', 'Ready']]);
      t.command('pl.cmd.start', 'nd.work', 'Start',
        [['nd.work.status', 'literal', 'Doing'], ['nd.work.started', 'today']]);
      t.command('pl.cmd.review', 'nd.work', 'Send to review', [['nd.work.status', 'literal', 'Review']]);
      t.command('pl.cmd.complete', 'nd.work', 'Complete',
        [['nd.work.status', 'literal', 'Done'], ['nd.work.completed', 'today'], ['nd.work.horizon', 'null'],
          ['nd.work.heldBy', 'null'], ['nd.work.next', 'null']]);
      t.command('pl.cmd.drop', 'nd.work', 'Drop',
        [['nd.work.status', 'literal', 'Dropped'], ['nd.work.horizon', 'null'], ['nd.work.heldBy', 'null']]);
      t.command('pl.cmd.reopen', 'nd.work', 'Reopen',
        [['nd.work.status', 'literal', 'Ready'], ['nd.work.completed', 'null'], ['nd.work.horizon', 'literal', 'Next']]);
      t.command('pl.cmd.decide', 'nd.decision', 'Decide',
        [['nd.decision.status', 'literal', 'Decided'], ['nd.decision.decided', 'today']]);

      return t.asMutations('The front page and the commands');
    },
  },

  // File → New planner… makes an empty planner from this shape (ADR-0022), and the
  // full-text index (ADR-0028) lets search find work by what its brief says.
  finish: {
    title: 'Planner NG: name a new empty planner, and index it for search',
    needs: ['nd.work'],
    appliedWhen: async read => (await read.json('nendo://application/manifest')).newFileLabel === NEW_FILE_LABEL,
    mutations: () => [
      { description: 'Name a new empty planner', operations: [op('application.setNewFileLabel', { label: NEW_FILE_LABEL })] },
      { description: 'Build the search index', operations: [op('application.buildSearchIndex', {})] },
    ],
  },
};

export const STAGE_ORDER = ['schema', 'colour', 'behaviour', 'work', 'records', 'front', 'finish'];

/** What the File menu calls a new file of the planner: New planner… (ADR-0022). */
export const NEW_FILE_LABEL = 'planner';
