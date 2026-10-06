// The shape of workspace/Garden.nendo: record types, calculations, screens, the front page, the
// commands, the two packages, the skill and the seed notes, one stage per change set.
// tools/Build-Garden.mjs sends them; this file only says what they are. docs/design/garden.md
// gives the reason for each choice.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from '../../extensions/garden/parse.mjs';
import { plan, F } from '../../extensions/garden/sync.mjs';

export const SURFACE = 'garden';
export const CALL_CHARACTERS = 200_000;
export const PACKAGE_ID = 'org.nendo.garden';
// The graph screen ran this package before the Garden package drew its own graph with d3; a
// file built then still carries it until `node tools/Build-Garden.mjs upgrade` takes it out.
export const RETIRED_GRAPH_PACKAGE_ID = 'org.nendo.dependency-graph';
export const SKILL_PACKAGE_ID = 'dev.nendo.garden';
const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_FOLDER = path.resolve(here, '..', '..', 'extensions', 'garden');
export const SKILL_FOLDER = path.resolve(here, '..', 'garden-skill');
export const NEW_FILE_LABEL = 'garden';
export const SEED_DATE = '2026-10-06';
// Use lists the front page beside the Garden view, so the two need different names.
export const FRONT_TITLE = 'Overview';
export const FRONT_DESCRIPTION = 'What is growing, what is pinned, what was tended lately, and the tasks the notes carry. Notes are read and written in the Garden view.';

const op = (operationType, payload) => ({ operationType, payload });
const text = (entityId, fieldId, displayName, required = false, presentation = 'singleLine') =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation, options: [] });
const long = (entityId, fieldId, displayName) => text(entityId, fieldId, displayName, false, 'longText');
const markdown = (entityId, fieldId, displayName) => text(entityId, fieldId, displayName, false, 'markdown');
const choice = (entityId, fieldId, displayName, options, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Text', required, presentation: 'singleChoice', options });
const date = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Date', required: false, presentation: 'date', options: [] });
const integer = (entityId, fieldId, displayName) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Integer', required: false, presentation: null, options: [] });
const boolean = (entityId, fieldId, displayName, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Boolean', required, presentation: null, options: [] });
const reference = (entityId, fieldId, displayName, required = false) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: 'Reference', required, presentation: null, options: [] });
const bind = (entityId, fieldId, targetEntityId, labelFieldId) => op('schema.configureReference', { entityId, fieldId, targetEntityId, labelFieldId });
const unique = (entityId, fieldId) => op('schema.setFieldUnique', { entityId, fieldId, unique: true });
const tone = (entityId, fieldId, choiceId, toneName) =>
  op('schema.setChoiceMetadata', { entityId, fieldId, choiceId, displayName: choiceId, retired: false, tone: toneName });
const calculation = (definitionId, entityId, fieldId, displayName, resultType, expression, bindings, nullable = false) =>
  op('behaviour.setDefinition', { definitionId, definitionKind: 'Calculation', body: {
    entityId, fieldId, displayName, resultType, resultNullable: nullable, expression, bindings, callAliases: [],
  } });
const field = (bindingId, entityId, fieldId, resultType, nullable = false) => ({ bindingId, kind: 'SameRecordField', entityId, fieldId, resultType, nullable });
const related = (bindingId, entityId, relatedEntityId, relatedReferenceFieldId, extra = {}) =>
  ({ bindingId, kind: 'RelatedAggregate', aggregate: 'Count', entityId, relatedEntityId, relatedReferenceFieldId, resultType: 'Integer', nullable: false, ...extra });
const same = (bindingId, entityId, calculationId) => ({ bindingId, kind: 'SameRecordCalculation', entityId, calculationId, resultType: 'Integer', nullable: false });

/** Screen nodes carry their position within their parent, counted here (as the planner's tree()). */
function tree(taken = {}) {
  const positions = new Map(Object.entries(taken));
  const operations = [];
  const add = (nodeId, kind, parentNodeId, properties = {}) => {
    const key = parentNodeId ?? '';
    const position = positions.get(key) ?? 0;
    positions.set(key, position + 1);
    operations.push(op('ui.addNode', { surfaceId: SURFACE, nodeId, parentNodeId, kind, position, properties }));
    return nodeId;
  };
  const bindings = (parentNodeId, fieldIds) => { for (const fieldId of fieldIds) add(`${parentNodeId}.${fieldId}`, 'fieldBinding', parentNodeId, { fieldId }); };
  const where = (parentNodeId, name, fieldId, operator, value) => {
    add(`${parentNodeId}.where.${name}`, 'filterClause', parentNodeId, value === undefined ? { fieldId, operator } : { fieldId, operator, valueKind: 'literal', value });
  };
  const command = (nodeId, entityId, label, steps) => {
    const root = add(nodeId, 'recordCommand', null, { definitionVersion: 3, entityId, label });
    steps.forEach(([fieldId, valueKind, value], index) => {
      add(`${nodeId}.step${index + 1}`, 'commandStep', root, value === undefined ? { fieldId, valueKind } : { fieldId, valueKind, value });
    });
  };
  const asMutations = description => chunk(operations, description);
  return { add, bindings, where, command, asMutations };
}

function chunk(operations, description, size = 16) {
  const mutations = [];
  const total = Math.ceil(operations.length / size);
  for (let start = 0; start < operations.length; start += size) {
    mutations.push({ description: total > 1 ? `${description} (${mutations.length + 1} of ${total})` : description, operations: operations.slice(start, start + size) });
  }
  return mutations;
}

export const PURPOSE = [
  'A garden of notes. Each note is Markdown, and a note may sit under another note, so the garden is a tree',
  'rather than folders of files. A [[wikilink]] names another note by its slug or its title, a #tag names a',
  'tag, and a line that starts with - [ ] is a task. When a note is saved in the Garden view those become',
  'records of their own: Links (one note mentions another, with the sentence that does it), Note tags and',
  'Tasks, each marked as derived from the body. Links, tags and tasks written by hand, by a person or an',
  'agent, are marked Manual and are never touched by a save.',
  '',
  'A note has a stage, Seed, Growing or Evergreen, which says how far it has grown. A wikilink to a note that',
  'is not there yet plants it as a Seed. A note tended today is a note touched today. Daily notes carry a',
  'date and sit on a calendar. The file carries its own agent skill, which says how to read and write it.',
  'There are no automatic actions.',
].join('\n');

const ENTITIES = ['gd.note', 'gd.link', 'gd.tag', 'gd.noteTag', 'gd.task'];

export const STAGES = {
  schema: {
    title: 'Garden: the record types',
    makes: ENTITIES,
    mutations: () => [
      { description: 'Say what this file is for, and give it a look of its own', operations: [
        op('application.setPurpose', { purpose: PURPOSE }),
        op('application.setLook', { tone: 'green', letter: 'G' }),
        op('application.setNewFileLabel', { label: NEW_FILE_LABEL }),
      ] },
      { description: 'Create Notes', operations: [
        op('schema.createEntity', { entityId: 'gd.note', displayName: 'Notes' }),
        text('gd.note', F.note.title, 'Title', true),
        text('gd.note', F.note.slug, 'Slug', true),
        markdown('gd.note', F.note.body, 'Note'),
        long('gd.note', F.note.summary, 'Summary'),
        choice('gd.note', F.note.kind, 'Kind', ['Note', 'Daily', 'Map', 'Source', 'Template']),
        choice('gd.note', F.note.stage, 'Stage', ['Seed', 'Growing', 'Evergreen']),
        date('gd.note', F.note.date, 'Date'),
        date('gd.note', F.note.touched, 'Last tended'),
        boolean('gd.note', F.note.pinned, 'Pinned', true),
        reference('gd.note', F.note.parent, 'Under'),
        integer('gd.note', F.note.order, 'Order'),
        unique('gd.note', F.note.slug),
      ] },
      { description: 'Create Links', operations: [
        op('schema.createEntity', { entityId: 'gd.link', displayName: 'Links' }),
        reference('gd.link', F.link.from, 'From', true),
        reference('gd.link', F.link.to, 'To', true),
        choice('gd.link', F.link.kind, 'Kind', ['Mentions', 'Supports', 'Contradicts', 'See also', 'Part of']),
        long('gd.link', F.link.context, 'Context'),
        choice('gd.link', F.link.source, 'Source', ['Body', 'Manual']),
      ] },
      { description: 'Create Tags and Note tags', operations: [
        op('schema.createEntity', { entityId: 'gd.tag', displayName: 'Tags' }),
        text('gd.tag', F.tag.name, 'Name', true),
        long('gd.tag', F.tag.description, 'About'),
        unique('gd.tag', F.tag.name),
        op('schema.createEntity', { entityId: 'gd.noteTag', displayName: 'Note tags' }),
        reference('gd.noteTag', F.noteTag.note, 'Note', true),
        reference('gd.noteTag', F.noteTag.tag, 'Tag', true),
        choice('gd.noteTag', F.noteTag.source, 'Source', ['Body', 'Manual']),
      ] },
      { description: 'Create Tasks', operations: [
        op('schema.createEntity', { entityId: 'gd.task', displayName: 'Tasks' }),
        text('gd.task', F.task.title, 'Task', true),
        reference('gd.task', F.task.note, 'Note'),
        boolean('gd.task', F.task.done, 'Done', true),
        date('gd.task', F.task.due, 'Due'),
        choice('gd.task', F.task.source, 'Source', ['Checkbox', 'Manual']),
        text('gd.task', F.task.key, 'Key'),
      ] },
      { description: 'Point every reference at what it names', operations: [
        bind('gd.note', F.note.parent, 'gd.note', F.note.title),
        bind('gd.link', F.link.from, 'gd.note', F.note.title),
        bind('gd.link', F.link.to, 'gd.note', F.note.title),
        bind('gd.noteTag', F.noteTag.note, 'gd.note', F.note.title),
        bind('gd.noteTag', F.noteTag.tag, 'gd.tag', F.tag.name),
        bind('gd.task', F.task.note, 'gd.note', F.note.title),
      ] },
      { description: 'Let a note sit under another note, in order', operations: [
        op('schema.declareHierarchy', { entityId: 'gd.note', parentFieldId: F.note.parent, orderFieldId: F.note.order }),
      ] },
    ],
  },

  colour: {
    title: 'Garden: colour the choices',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema('gd.note')).fields.find(f => f.fieldId === F.note.stage)?.choices.some(c => c.tone) ?? false,
    mutations: () => {
      const tones = [
        ['gd.note', F.note.stage, [['Seed', 'amber'], ['Growing', 'teal'], ['Evergreen', 'green']]],
        ['gd.note', F.note.kind, [['Note', 'blue'], ['Daily', 'violet'], ['Map', 'teal'], ['Source', 'grey'], ['Template', 'amber']]],
        ['gd.link', F.link.kind, [['Mentions', 'grey'], ['Supports', 'green'], ['Contradicts', 'red'], ['See also', 'blue'], ['Part of', 'violet']]],
        ['gd.link', F.link.source, [['Body', 'teal'], ['Manual', 'grey']]],
        ['gd.noteTag', F.noteTag.source, [['Body', 'teal'], ['Manual', 'grey']]],
        ['gd.task', F.task.source, [['Checkbox', 'teal'], ['Manual', 'grey']]],
      ];
      return chunk(tones.flatMap(([entityId, fieldId, pairs]) => pairs.map(([choiceId, toneName]) => tone(entityId, fieldId, choiceId, toneName))), 'Colour the choices');
    },
  },

  behaviour: {
    title: 'Garden: what it works out for itself',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema('gd.note')).derivedFields.length > 0,
    mutations: () => [
      { description: 'What a note carries: its links, tasks, tags, place and length', operations: [
        calculation('gd.calc.linksOut', 'gd.note', 'gd.note.linksOut', 'Links out', 'Integer', 'links', [related('links', 'gd.note', 'gd.link', F.link.from)]),
        calculation('gd.calc.linksIn', 'gd.note', 'gd.note.linksIn', 'Backlinks', 'Integer', 'links', [related('links', 'gd.note', 'gd.link', F.link.to)]),
        calculation('gd.calc.isOrphan', 'gd.note', 'gd.note.isOrphan', 'Orphan', 'Boolean', 'inward == 0 and outward == 0',
          [same('inward', 'gd.note', 'gd.calc.linksIn'), same('outward', 'gd.note', 'gd.calc.linksOut')]),
        calculation('gd.calc.taskCount', 'gd.note', 'gd.note.taskCount', 'Tasks', 'Integer', 'tasks', [related('tasks', 'gd.note', 'gd.task', F.task.note)]),
        calculation('gd.calc.doneTasks', 'gd.note', 'gd.note.doneTasks', 'Done tasks', 'Integer', 'done',
          [related('done', 'gd.note', 'gd.task', F.task.note, { aggregate: 'FilteredCount', predicateFieldId: F.task.done })]),
        calculation('gd.calc.openTasks', 'gd.note', 'gd.note.openTasks', 'Open tasks', 'Integer', 'tasks - done',
          [same('tasks', 'gd.note', 'gd.calc.taskCount'), same('done', 'gd.note', 'gd.calc.doneTasks')]),
        calculation('gd.calc.tagCount', 'gd.note', 'gd.note.tagCount', 'Tags', 'Integer', 'tags', [related('tags', 'gd.note', 'gd.noteTag', F.noteTag.note)]),
        calculation('gd.calc.bodyLength', 'gd.note', 'gd.note.bodyLength', 'Length', 'Integer', 'TextLength(body)', [field('body', 'gd.note', F.note.body, 'Text', true)], true),
        calculation('gd.calc.beneath', 'gd.note', 'gd.note.beneath', 'Notes beneath', 'Integer', 'parts',
          [{ bindingId: 'parts', kind: 'SubtreeAggregate', aggregate: 'Count', entityId: 'gd.note', resultType: 'Integer', nullable: false }]),
        calculation('gd.calc.path', 'gd.note', 'gd.note.path', 'Place', 'Text', 'place',
          [{ bindingId: 'place', kind: 'HierarchyPath', entityId: 'gd.note', resultType: 'Text', nullable: false }]),
        calculation('gd.calc.isDaily', 'gd.note', 'gd.note.isDaily', 'Is daily', 'Boolean', "kind == 'Daily'", [field('kind', 'gd.note', F.note.kind, 'Text', true)], true),
        calculation('gd.calc.tagNotes', 'gd.tag', 'gd.tag.noteCount', 'Notes', 'Integer', 'notes', [related('notes', 'gd.tag', 'gd.noteTag', F.noteTag.tag)]),
      ] },
    ],
  },

  notes: {
    title: 'Garden: the notes, seen seven ways, and the note page',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode('gd.note.outline'),
    mutations: () => {
      const t = tree();
      const outline = t.add('gd.note.outline', 'outlineSurface', null, { definitionVersion: 3, entityId: 'gd.note', title: 'Tree',
        titleFieldId: F.note.title, accentFieldId: F.note.stage, expandDepth: 2, reorder: true });
      t.bindings(outline, [F.note.kind, 'gd.note.linksIn', 'gd.note.openTasks']);

      const all = t.add('gd.note.all', 'recordList', null, { definitionVersion: 3, entityId: 'gd.note', title: 'All notes', orderByFieldId: F.note.touched, orderDirection: 'descending' });
      t.bindings(all, [F.note.title, F.note.slug, F.note.kind, F.note.stage, F.note.touched, 'gd.note.linksIn', 'gd.note.openTasks']);
      t.add('gd.note.all.count', 'summaryTile', all, { aggregate: 'count', title: 'Notes' });
      t.add('gd.note.all.byStage', 'breakdownChart', all, { aggregate: 'count', groupByFieldId: F.note.stage, title: 'By stage' });

      const orphans = t.add('gd.note.orphans', 'recordList', null, { definitionVersion: 3, entityId: 'gd.note', title: 'Orphans', orderByFieldId: F.note.touched, orderDirection: 'descending' });
      t.bindings(orphans, [F.note.title, F.note.kind, F.note.stage, F.note.touched]);
      t.where(orphans, 'orphan', 'gd.note.isOrphan', 'eq', true);

      const board = t.add('gd.note.board', 'boardSurface', null, { definitionVersion: 3, entityId: 'gd.note', title: 'By stage',
        groupByFieldId: F.note.stage, orderByFieldId: F.note.touched, orderDirection: 'descending' });
      t.bindings(board, [F.note.title, F.note.kind, 'gd.note.linksIn', F.note.touched]);
      t.add('gd.note.board.column', 'summaryTile', board, { aggregate: 'count', title: 'Here', scope: 'group' });

      const daily = t.add('gd.note.daily', 'calendarSurface', null, { definitionVersion: 3, entityId: 'gd.note', title: 'Daily', dateFieldId: F.note.date });
      t.bindings(daily, [F.note.title, F.note.stage]);
      t.where(daily, 'daily', F.note.kind, 'eq', 'Daily');

      const maps = t.add('gd.note.maps', 'gallerySurface', null, { definitionVersion: 3, entityId: 'gd.note', title: 'Maps',
        titleFieldId: F.note.title, accentFieldId: F.note.stage, orderByFieldId: F.note.title, orderDirection: 'ascending' });
      t.bindings(maps, [F.note.summary, 'gd.note.linksOut', 'gd.note.beneath']);
      t.where(maps, 'map', F.note.kind, 'eq', 'Map');

      const page = t.add('gd.note.page', 'detailSurface', null, { definitionVersion: 3, entityId: 'gd.note', title: 'Note',
        titleFieldId: F.note.title, subtitleFieldId: F.note.slug, accentFieldId: F.note.stage });
      t.bindings(page, [F.note.stage, F.note.kind, F.note.pinned]);
      const day = t.add('gd.note.page.day', 'section', page, { title: 'Day', visibleWhen: 'gd.note.isDaily' });
      t.bindings(day, [F.note.date]);
      const tabs = t.add('gd.note.page.tabs', 'tabGroup', page, { title: 'Note' });
      const body = t.add('gd.note.page.note', 'section', tabs, { title: 'Note' });
      t.bindings(body, [F.note.body, F.note.summary, F.note.touched]);
      const links = t.add('gd.note.page.links', 'section', tabs, { title: 'Links' });
      const out = t.add('gd.note.page.out', 'relatedList', links, { targetEntityId: 'gd.link', viaFieldId: F.link.from, title: 'Links out' });
      t.bindings(out, [F.link.to, F.link.kind, F.link.context, F.link.source]);
      const back = t.add('gd.note.page.in', 'relatedList', links, { targetEntityId: 'gd.link', viaFieldId: F.link.to, title: 'Backlinks' });
      t.bindings(back, [F.link.from, F.link.kind, F.link.context, F.link.source]);
      t.add('gd.note.page.in.count', 'summaryTile', back, { aggregate: 'count', title: 'Backlinks' });
      const noteTags = t.add('gd.note.page.tags', 'relatedList', links, { targetEntityId: 'gd.noteTag', viaFieldId: F.noteTag.note, title: 'Tags' });
      t.bindings(noteTags, [F.noteTag.tag, F.noteTag.source]);
      const tasks = t.add('gd.note.page.tasksTab', 'section', tabs, { title: 'Tasks' });
      const taskList = t.add('gd.note.page.tasks', 'relatedList', tasks, { targetEntityId: 'gd.task', viaFieldId: F.task.note, title: 'Tasks', orderByFieldId: F.task.due, orderDirection: 'ascending' });
      t.bindings(taskList, [F.task.title, F.task.done, F.task.due, F.task.source]);
      t.add('gd.note.page.tasks.count', 'summaryTile', taskList, { aggregate: 'count', title: 'Tasks' });
      const place = t.add('gd.note.page.place', 'section', tabs, { title: 'Place' });
      t.bindings(place, [F.note.parent, F.note.order, 'gd.note.path', 'gd.note.beneath', 'gd.note.linksIn', 'gd.note.linksOut', 'gd.note.tagCount', 'gd.note.bodyLength']);
      const beneath = t.add('gd.note.page.beneath', 'relatedList', place, { targetEntityId: 'gd.note', viaFieldId: F.note.parent, title: 'Notes beneath', orderByFieldId: F.note.order, orderDirection: 'ascending' });
      t.bindings(beneath, [F.note.title, F.note.stage, F.note.kind]);
      return t.asMutations('The note screens and the note page');
    },
  },

  others: {
    title: 'Garden: tags, tasks and links, and the commands',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode('gd.tag.list'),
    mutations: () => {
      const t = tree();
      const tagList = t.add('gd.tag.list', 'recordList', null, { definitionVersion: 3, entityId: 'gd.tag', title: 'Tags', orderByFieldId: F.tag.name, orderDirection: 'ascending' });
      t.bindings(tagList, [F.tag.name, 'gd.tag.noteCount', F.tag.description]);
      t.add('gd.tag.list.count', 'summaryTile', tagList, { aggregate: 'count', title: 'Tags' });
      const tagPage = t.add('gd.tag.page', 'detailSurface', null, { definitionVersion: 3, entityId: 'gd.tag', title: 'Tag', titleFieldId: F.tag.name });
      t.bindings(tagPage, [F.tag.name, F.tag.description, 'gd.tag.noteCount']);
      const tagged = t.add('gd.tag.page.notes', 'relatedList', tagPage, { targetEntityId: 'gd.noteTag', viaFieldId: F.noteTag.tag, title: 'Notes' });
      t.bindings(tagged, [F.noteTag.note, F.noteTag.source]);

      const open = t.add('gd.task.open', 'recordList', null, { definitionVersion: 3, entityId: 'gd.task', title: 'Open', orderByFieldId: F.task.due, orderDirection: 'ascending' });
      t.bindings(open, [F.task.title, F.task.note, F.task.due, F.task.source]);
      t.where(open, 'open', F.task.done, 'eq', false);
      t.add('gd.task.open.count', 'summaryTile', open, { aggregate: 'count', title: 'Open' });
      const board = t.add('gd.task.board', 'boardSurface', null, { definitionVersion: 3, entityId: 'gd.task', title: 'By source', groupByFieldId: F.task.source, orderByFieldId: F.task.due, orderDirection: 'ascending' });
      t.bindings(board, [F.task.title, F.task.note, F.task.done, F.task.due]);
      const due = t.add('gd.task.due', 'calendarSurface', null, { definitionVersion: 3, entityId: 'gd.task', title: 'Due', dateFieldId: F.task.due });
      t.bindings(due, [F.task.title, F.task.note, F.task.done]);
      const allTasks = t.add('gd.task.all', 'recordList', null, { definitionVersion: 3, entityId: 'gd.task', title: 'All tasks', orderByFieldId: F.task.due, orderDirection: 'ascending' });
      t.bindings(allTasks, [F.task.title, F.task.note, F.task.done, F.task.due, F.task.source]);
      t.add('gd.task.all.byDone', 'breakdownChart', allTasks, { aggregate: 'count', groupByFieldId: F.task.source, title: 'By source' });
      const taskPage = t.add('gd.task.page', 'detailSurface', null, { definitionVersion: 3, entityId: 'gd.task', title: 'Task', titleFieldId: F.task.title });
      t.bindings(taskPage, [F.task.title, F.task.note, F.task.done, F.task.due, F.task.source, F.task.key]);

      const linkList = t.add('gd.link.list', 'recordList', null, { definitionVersion: 3, entityId: 'gd.link', title: 'Links', orderByFieldId: F.link.from, orderDirection: 'ascending' });
      t.bindings(linkList, [F.link.from, F.link.to, F.link.kind, F.link.source, F.link.context]);
      t.add('gd.link.list.byKind', 'breakdownChart', linkList, { aggregate: 'count', groupByFieldId: F.link.kind, title: 'By kind' });
      const linkPage = t.add('gd.link.page', 'detailSurface', null, { definitionVersion: 3, entityId: 'gd.link', title: 'Link' });
      t.bindings(linkPage, [F.link.from, F.link.to, F.link.kind, F.link.context, F.link.source]);
      const noteTagList = t.add('gd.noteTag.list', 'recordList', null, { definitionVersion: 3, entityId: 'gd.noteTag', title: 'Note tags', orderByFieldId: F.noteTag.tag, orderDirection: 'ascending' });
      t.bindings(noteTagList, [F.noteTag.note, F.noteTag.tag, F.noteTag.source]);
      const noteTagPage = t.add('gd.noteTag.page', 'detailSurface', null, { definitionVersion: 3, entityId: 'gd.noteTag', title: 'Note tag' });
      t.bindings(noteTagPage, [F.noteTag.note, F.noteTag.tag, F.noteTag.source]);

      t.command('gd.cmd.evergreen', 'gd.note', 'Mark evergreen', [[F.note.stage, 'literal', 'Evergreen'], [F.note.touched, 'today']]);
      t.command('gd.cmd.growing', 'gd.note', 'Mark growing', [[F.note.stage, 'literal', 'Growing'], [F.note.touched, 'today']]);
      t.command('gd.cmd.tend', 'gd.note', 'Tended today', [[F.note.touched, 'today']]);
      t.command('gd.cmd.pin', 'gd.note', 'Pin', [[F.note.pinned, 'literal', true]]);
      t.command('gd.cmd.unpin', 'gd.note', 'Unpin', [[F.note.pinned, 'literal', false]]);
      t.command('gd.cmd.done', 'gd.task', 'Done', [[F.task.done, 'literal', true]]);
      t.command('gd.cmd.reopen', 'gd.task', 'Reopen', [[F.task.done, 'literal', false]]);
      return t.asMutations('Screens and pages for tags, tasks and links, and the commands');
    },
  },

  front: {
    title: 'Garden: the front page',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode('gd.front'),
    mutations: () => {
      const t = tree();
      const front = t.add('gd.front', 'overviewSurface', null, { definitionVersion: 3, title: FRONT_TITLE, description: FRONT_DESCRIPTION });
      const tabs = t.add('gd.front.tabs', 'tabGroup', front, { title: 'Garden' });

      const tending = t.add('gd.front.tending', 'section', tabs, { title: 'Tending' });
      t.add('gd.front.tending.notes', 'summaryTile', tending, { entityId: 'gd.note', aggregate: 'count', title: 'Notes' });
      const seeds = t.add('gd.front.tending.seeds', 'summaryTile', tending, { entityId: 'gd.note', aggregate: 'count', title: 'Seeds to grow' });
      t.where(seeds, 'seed', F.note.stage, 'eq', 'Seed');
      const orphans = t.add('gd.front.tending.orphans', 'summaryTile', tending, { entityId: 'gd.note', aggregate: 'count', title: 'Orphans' });
      t.where(orphans, 'orphan', 'gd.note.isOrphan', 'eq', true);
      const pinned = t.add('gd.front.tending.pinned', 'recentList', tending, { entityId: 'gd.note', title: 'Pinned', limit: 10, orderByFieldId: F.note.title, orderDirection: 'ascending' });
      t.bindings(pinned, [F.note.title, F.note.kind, F.note.stage]);
      t.where(pinned, 'pinned', F.note.pinned, 'eq', true);
      const lately = t.add('gd.front.tending.lately', 'recentList', tending, { entityId: 'gd.note', title: 'Tended lately', limit: 10, orderByFieldId: F.note.touched, orderDirection: 'descending' });
      t.bindings(lately, [F.note.title, F.note.stage, 'gd.note.linksIn']);

      const growth = t.add('gd.front.growth', 'section', tabs, { title: 'Growth' });
      t.add('gd.front.growth.stage', 'breakdownChart', growth, { entityId: 'gd.note', aggregate: 'count', groupByFieldId: F.note.stage, title: 'Notes by stage' });
      t.add('gd.front.growth.kind', 'breakdownChart', growth, { entityId: 'gd.note', aggregate: 'count', groupByFieldId: F.note.kind, title: 'Notes by kind' });
      t.add('gd.front.growth.days', 'activityGrid', growth, { entityId: 'gd.note', dateFieldId: F.note.touched, range: 'thisYear', title: 'Days tended' });
      t.add('gd.front.growth.months', 'trendChart', growth, { entityId: 'gd.note', dateFieldId: F.note.touched, bucket: 'month', range: 'last12Months', aggregate: 'count', title: 'Notes tended by month' });

      const tasks = t.add('gd.front.tasks', 'section', tabs, { title: 'Tasks' });
      const open = t.add('gd.front.tasks.open', 'summaryTile', tasks, { entityId: 'gd.task', aggregate: 'count', title: 'Open' });
      t.where(open, 'open', F.task.done, 'eq', false);
      const done = t.add('gd.front.tasks.done', 'progressTile', tasks, { entityId: 'gd.task', title: 'Done' });
      t.where(done, 'done', F.task.done, 'eq', true);
      const next = t.add('gd.front.tasks.next', 'recentList', tasks, { entityId: 'gd.task', title: 'Due next', limit: 10, orderByFieldId: F.task.due, orderDirection: 'ascending' });
      t.bindings(next, [F.task.title, F.task.note, F.task.due]);
      t.where(next, 'open', F.task.done, 'eq', false);
      t.where(next, 'dated', F.task.due, 'isNotNull');

      const tags = t.add('gd.front.tags', 'section', tabs, { title: 'Tags' });
      t.add('gd.front.tags.count', 'summaryTile', tags, { entityId: 'gd.tag', aggregate: 'count', title: 'Tags' });
      const tagList = t.add('gd.front.tags.list', 'recentList', tags, { entityId: 'gd.tag', title: 'Tags', limit: 10, orderByFieldId: F.tag.name, orderDirection: 'ascending' });
      t.bindings(tagList, [F.tag.name, 'gd.tag.noteCount']);
      return t.asMutations('The front page');
    },
  },

  graph: {
    title: 'Garden: the living graph of the notes',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode('gd.note.graph'),
    mutations: () => {
      const t = tree();
      const graph = t.add('gd.note.graph', 'extensionGraphSurface', null, { definitionVersion: 3, entityId: 'gd.note', title: 'Graph', packageId: PACKAGE_ID,
        labelFieldId: F.note.title, statusFieldId: F.note.stage, edgeEntityId: 'gd.link', sourceFieldId: F.link.from, targetFieldId: F.link.to });
      t.bindings(graph, [F.note.kind, F.link.kind]);
      return t.asMutations('Show the notes as a living graph');
    },
  },

  garden: {
    title: 'Garden: the Garden view, which the file opens on, and the Backlinks panel',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode('gd.garden'),
    mutations: async () => {
      const files = await packageMutations(PACKAGE_FOLDER, PACKAGE_ID, 'Put the Garden package into the file');
      // The panel sits after the Note tab's three bindings, which the notes stage made.
      const t = tree({ 'gd.note.page.note': 3 });
      t.add('gd.garden', 'extensionView', null, { definitionVersion: 3, title: 'Garden', packageId: PACKAGE_ID, entityId: 'gd.note', opensFile: true });
      t.add('gd.note.page.backlinks', 'extensionRecordPanel', 'gd.note.page.note', { title: 'Backlinks', packageId: PACKAGE_ID, labelFieldId: F.note.title });
      return [...files, ...t.asMutations('Show the Garden view and the Backlinks panel')];
    },
  },

  skill: {
    title: 'Garden: the skill that tells an agent how to work this file',
    needs: ENTITIES,
    appliedWhen: async read => (await read.json('nendo://application/extensions')).some(p => p.packageId === SKILL_PACKAGE_ID),
    mutations: async ({ applicationId = '(read nendo://application/manifest)' } = {}) => {
      const manifest = JSON.parse(await fs.readFile(path.join(SKILL_FOLDER, 'nendo-package.json'), 'utf8'));
      const skill = (await fs.readFile(path.join(SKILL_FOLDER, 'SKILL.md'), 'utf8')).replaceAll('__APPLICATION_ID__', applicationId);
      return [{ description: 'Put the Garden skill into the file', operations: [
        op('extension.setPackage', { packageId: SKILL_PACKAGE_ID, kind: 'skill', title: manifest.title, version: manifest.version, description: manifest.description }),
        op('extension.putFile', { packageId: SKILL_PACKAGE_ID, path: 'SKILL.md', text: skill, expectedSha256: 'absent' }),
      ] }];
    },
  },

  seed: {
    title: 'Garden: the first notes, with their links, tags and tasks',
    needs: ENTITIES,
    appliedWhen: async read => (await read.json('nendo://application/entity/gd.note/schema')).recordCount > 0,
    mutations: () => chunk(seedOperations(), 'Plant the first notes'),
  },

  keep: {
    title: 'Garden: keep the first notes in every new garden',
    needs: ENTITIES,
    appliedWhen: async read => ((await read.json('nendo://application/describe?include=newFile')).newFile?.types ?? []).some(t => t.kept > 0),
    mutations: () => chunk(seedRecords().map(r => op('data.setKeptInNewFiles', { entityId: r.entityId, recordId: r.recordId, kept: true })), 'Keep the first notes in a new garden'),
  },
};

export const STAGE_ORDER = ['schema', 'colour', 'behaviour', 'notes', 'others', 'front', 'garden', 'graph', 'skill', 'seed', 'keep'];

// ---- Seeds: the notes a new garden starts with. Their links, tags and tasks come from the same
// parse and sync the view uses on save, so the seed cannot disagree with the parser.

export function seedNotes() {
  const note = (slug, title, kind, stage, body, extra = {}) => ({ slug, title, kind, stage, body: body.join('\n'), ...extra });
  return [
    note('start-here', 'Start here', 'Map', 'Evergreen', [
      '# Welcome to your garden',
      '',
      'This file is a garden of notes. Every note is Markdown, and a note can sit under another note, so the whole garden is one tree rather than folders of files. The notes below this one are the guide.',
      '',
      '- [[how-links-work|How links work]]: wikilinks, backlinks and the graph.',
      '- [[tags-and-tasks]]: a `#tag` and a `- [ ]` line become records.',
      '- [[daily-notes]]: one note a day, on a calendar.',
      '- [[for-agents]]: how an agent reads and writes this file.',
      '',
      'A note has a **stage**: Seed, Growing or Evergreen. Mark a note evergreen when it says what it means. The front page counts the seeds that are waiting to grow.',
      '',
      '- [ ] Plant your first note with **New note**',
      '- [ ] Link it to this one',
      '',
      '#garden #howto',
    ], { pinned: true, order: 0 }),
    note('how-links-work', 'How links work', 'Note', 'Evergreen', [
      '# How links work',
      '',
      'Write `[[start-here]]` to link to a note by its slug, or `[[Start here]]` by its title, or `[[start-here|the welcome note]]` to show other words. When you save, each link becomes a **Link** record: from this note, to that one, with the sentence it sits in as its context. So [[start-here]] now has this note among its backlinks, and the **Graph** screen draws the two.',
      '',
      'A link to a note that is not there yet plants it as a Seed, so nothing points nowhere. Remove the link and the Link record goes; the Seed stays.',
      '',
      'Links written by hand, on a note\'s record page or by an agent, carry the source *Manual* and a kind: Supports, Contradicts, See also or Part of. A save never touches them. Links inside code, like `[[not-a-link]]`, are left alone:',
      '',
      '```',
      '[[this is code, not a link]] #notatag',
      '```',
      '',
      '#garden #howto',
    ], { order: 1 }),
    note('daily-notes', 'Daily notes', 'Note', 'Growing', [
      '# Daily notes',
      '',
      '**Today** in the Garden view opens the note for today, or plants it from the note whose kind is *Template* ([[daily-note-template]]). A daily note carries its date and the kind *Daily*, so it sits on the **Daily** calendar beside the other screens.',
      '',
      'Keep what happened, what you read and what you want to come back to; link out with `[[...]]` and the backlinks do the rest.',
      '',
      '#garden #howto',
    ], { order: 2 }),
    note('tags-and-tasks', 'Tags and tasks', 'Note', 'Growing', [
      '# Tags and tasks',
      '',
      'A `#word` in the body is a tag. On save it becomes a **Tag** record, made once for the whole garden, and a **Note tag** that says this note carries it. A tag\'s page lists its notes.',
      '',
      'A line that starts with `- [ ]` is a task, and `- [x]` a task that is done. On save it becomes a **Task** record that remembers its note, so every task in the garden is on one list, one board and one calendar when it has a due date. Tick the box in the note and save: the same Task is marked done. A task written by hand on the Tasks screen is *Manual* and is yours.',
      '',
      '- [ ] Give one task a due date on its record page',
      '- [x] Read this note',
      '',
      '#garden #howto #tasks',
    ], { order: 3 }),
    note('for-agents', 'For agents', 'Note', 'Evergreen', [
      '# For agents',
      '',
      'This file carries its own skill, `dev.nendo.garden`. An agent that connects over MCP reads it at `skill://dev.nendo.garden/garden/SKILL.md` and learns the record types, how to find a note by its slug, how to write a note whose `[[links]]` the view will derive, and how to write a Link, Note tag or Task by hand with the source *Manual*.',
      '',
      'Three things make this garden easy for an agent:',
      '',
      '1. Every note has a **slug**, unique in the file, so `[[for-agents]]` always means this note.',
      '2. Every note has a **summary** field, a paragraph an agent can read instead of the body.',
      '3. Links, tags and tasks are **records**, so an agent asks the file who links where, rather than parsing text.',
      '',
      'See [[how-links-work]] for what a save derives.',
      '',
      '#garden #agents',
    ], { pinned: true, order: 4, summary: 'How an agent works this file: the dev.nendo.garden skill, slugs, summaries, and links as records.' }),
    note('daily-note-template', 'Daily note template', 'Template', 'Evergreen', [
      '## Today',
      '',
      '',
      '## Read',
      '',
      '',
      '## Next',
      '',
      '- [ ] ',
    ], { order: 5, summary: 'The body a new daily note starts with. Edit it to change what Today plants.' }),
  ];
}

const MANUAL_LINKS = [
  { from: 'for-agents', to: 'how-links-work', kind: 'See also', context: 'Written by hand on the For agents page, so a save never touches it.' },
];

/** The seed records in write order, as {entityId, recordId, values}: notes first, then what their bodies say. */
export function seedRecords() {
  const notes = seedNotes();
  const index = notes.map(n => ({ recordId: `gd.note.${n.slug}`, version: 1, slug: n.slug, title: n.title }));
  const records = [];
  const tags = [];
  const noteValues = n => ({
    [F.note.title]: n.title, [F.note.slug]: n.slug, [F.note.body]: n.body, [F.note.kind]: n.kind, [F.note.stage]: n.stage,
    [F.note.pinned]: n.pinned === true, [F.note.touched]: SEED_DATE, [F.note.order]: n.order,
    ...(n.summary ? { [F.note.summary]: n.summary } : {}), ...(n.slug === 'start-here' ? {} : { [F.note.parent]: 'gd.note.start-here' }),
  });
  for (const n of notes) records.push({ entityId: 'gd.note', recordId: `gd.note.${n.slug}`, values: noteValues(n) });
  const derived = [];
  for (const n of notes) {
    const newId = (entityId, hint) => `${entityId}.${hint}`;
    const planned = plan({ note: { recordId: `gd.note.${n.slug}`, version: 1, values: noteValues(n) }, title: n.title, body: n.body, parsed: parse(n.body),
      index, existing: {}, tags, today: SEED_DATE, newId });
    if (planned.problems.length || planned.stubs.length) throw new Error(`Seed ${n.slug}: ${planned.problems.join(' ') || 'links to a note that is not a seed'}`);
    for (const write of planned.writes) {
      if (write.entityId === 'gd.note') continue;
      if (write.op !== 'create') throw new Error(`Seed ${n.slug}: unexpected ${write.op}`);
      if (write.entityId === 'gd.tag') tags.push({ recordId: write.recordId, version: 1, values: write.values });
      derived.push({ entityId: write.entityId, recordId: write.recordId, values: write.values });
    }
  }
  for (const link of MANUAL_LINKS) {
    derived.push({ entityId: 'gd.link', recordId: `gd.link.manual.${link.from}-${link.to}`, values: {
      [F.link.from]: `gd.note.${link.from}`, [F.link.to]: `gd.note.${link.to}`, [F.link.kind]: link.kind, [F.link.context]: link.context, [F.link.source]: 'Manual',
    } });
  }
  // Tags before the rows that point at them.
  derived.sort((a, b) => (a.entityId === 'gd.tag' ? 0 : 1) - (b.entityId === 'gd.tag' ? 0 : 1));
  return [...records, ...derived];
}

const REFERENCES = { 'gd.note': [F.note.parent], 'gd.link': [F.link.from, F.link.to], 'gd.noteTag': [F.noteTag.note, F.noteTag.tag], 'gd.task': [F.task.note], 'gd.tag': [] };

export function seedOperations() {
  return seedRecords().map(r => op('data.createRecord', { entityId: r.entityId, recordId: r.recordId, values: r.values,
    expectedTargetVersions: Object.fromEntries(REFERENCES[r.entityId].filter(f => r.values[f] != null).map(f => [f, 1])) }));
}

// ---- What the fixture broker serves the view in tools/Review-Garden.ps1.

export function fixture() {
  const schemaOps = STAGES.schema.mutations().flatMap(m => m.operations);
  const entities = schemaOps.filter(o => o.operationType === 'schema.createEntity').map(o => ({ entityId: o.payload.entityId, displayName: o.payload.displayName, hierarchy: null, fields: [] }));
  const byId = Object.fromEntries(entities.map(e => [e.entityId, e]));
  for (const o of schemaOps) {
    if (o.operationType === 'schema.addField') {
      const p = o.payload;
      byId[p.entityId].fields.push({ fieldId: p.fieldId, displayName: p.displayName, storageKind: p.storageKind.toLowerCase(), required: p.required, presentation: p.presentation,
        calculated: false, choices: (p.options ?? []).map(id => ({ id, displayName: id, retired: false, tone: null })), reference: null, scale: null });
    }
    if (o.operationType === 'schema.configureReference') {
      const f = byId[o.payload.entityId].fields.find(f => f.fieldId === o.payload.fieldId);
      f.reference = { targetEntityId: o.payload.targetEntityId, labelFieldId: o.payload.labelFieldId };
    }
    if (o.operationType === 'schema.declareHierarchy') byId[o.payload.entityId].hierarchy = { parentFieldId: o.payload.parentFieldId, orderFieldId: o.payload.orderFieldId };
  }
  const tones = STAGES.colour.mutations().flatMap(m => m.operations);
  for (const o of tones) {
    const c = byId[o.payload.entityId].fields.find(f => f.fieldId === o.payload.fieldId).choices.find(c => c.id === o.payload.choiceId);
    c.tone = o.payload.tone;
  }
  const records = Object.fromEntries(entities.map(e => [e.entityId, []]));
  const seeds = seedRecords();
  const titles = new Map(seeds.filter(r => r.entityId === 'gd.note').map(r => [r.recordId, r.values[F.note.title]]));
  const names = new Map(seeds.filter(r => r.entityId === 'gd.tag').map(r => [r.recordId, r.values[F.tag.name]]));
  for (const r of seeds) {
    const labels = {};
    for (const f of REFERENCES[r.entityId]) if (r.values[f] != null) labels[f] = titles.get(r.values[f]) ?? names.get(r.values[f]) ?? r.values[f];
    records[r.entityId].push({ entityId: r.entityId, recordId: r.recordId, version: 1, values: r.values, labels, exact: {}, calculated: {} });
  }
  return {
    changeSequence: 1,
    schema: { entities, commands: [{ id: 'gd.cmd.evergreen', entityId: 'gd.note', label: 'Mark evergreen' }] },
    hierarchies: { 'gd.note': { parentFieldId: F.note.parent, orderFieldId: F.note.order } },
    records,
    commandEffects: { 'gd.cmd.evergreen': { [F.note.stage]: 'Evergreen', [F.note.touched]: SEED_DATE } },
    context: { viewId: 'gd.garden', kind: 'extensionView', placement: 'screen', title: 'Garden', entityId: 'gd.note', recordId: null,
      bindings: { labelFieldId: null, statusFieldId: null, fields: [], filters: [] }, theme: 'light' },
  };
}

// ---- Packages: a folder's files as extension operations, in parts a call can carry.

export async function packageFiles(folder) {
  const manifest = JSON.parse(await fs.readFile(path.join(folder, 'nendo-package.json'), 'utf8'));
  const names = (await fs.readdir(folder, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.relative(folder, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'))
    .filter(name => name !== 'nendo-package.json' && name !== 'README.md' && !name.split('/').some(part => part.startsWith('.') || part === 'node_modules'))
    .sort();
  const files = [];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(folder, name));
    files.push({ path: name, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return { manifest, files };
}

export async function packageMutations(folder, packageId, description) {
  const { manifest, files } = await packageFiles(folder);
  if (manifest.packageId !== packageId) throw new Error(`${folder} is ${manifest.packageId}, not ${packageId}.`);
  const operations = [op('extension.setPackage', { packageId, title: manifest.title, entryPoint: manifest.entryPoint ?? 'index.html', version: manifest.version, description: manifest.description })];
  const partBytes = 70 * 1024;
  for (const file of files) {
    for (let offset = 0; offset === 0 || offset < file.bytes.length; offset += partBytes) {
      operations.push(op('extension.putFile', { packageId, path: file.path, base64: file.bytes.subarray(offset, offset + partBytes).toString('base64'),
        ...(offset === 0 ? { expectedSha256: 'absent' } : { append: true }) }));
    }
  }
  const mutations = [];
  for (const operation of operations) {
    const size = JSON.stringify(operation).length;
    const last = mutations.at(-1);
    if (!last || last.operations.length === 16 || last.size + size > CALL_CHARACTERS) mutations.push({ description, operations: [], size: 0 });
    mutations.at(-1).operations.push(operation);
    mutations.at(-1).size += size;
  }
  return mutations.map(({ description: d, operations: o }) => ({ description: d, operations: o }));
}
