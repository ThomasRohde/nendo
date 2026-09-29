// The shape of Archi.nendo: the ArchiMate 3.2 metamodel as record types, its screens, and the
// records every Archi file starts with. tools/Build-Archi.mjs sends them; this file only says
// what they are. docs/design/archi-in-nendo.md gives the reason for each choice (W-100, W-107).
//
// A change set carries at most 128 operations and a mutation 16, so the record types arrive in
// two stages: the model, then the diagrams, which reference it. A field a record needs is added
// in the same mutation as its record type.

import { CONCEPT_TYPES } from './archi-concept-types.mjs';

export const SURFACE = 'archi';
// What one add_operations call may carry, as Put-NendoPackage.mjs measures it.
export const CALL_CHARACTERS = 200_000;

const op = (operationType, payload) => ({ operationType, payload });
const field = (kind, entityId, fieldId, displayName, required = false, presentation = null, options = []) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind: kind, required, presentation, options });
const text = (entityId, fieldId, displayName, required = false) => field('Text', entityId, fieldId, displayName, required, 'singleLine');
const long = (entityId, fieldId, displayName) => field('Text', entityId, fieldId, displayName, false, 'longText');
const choice = (entityId, fieldId, displayName, options, required = false) =>
  field('Text', entityId, fieldId, displayName, required, 'singleChoice', options);
const integer = (entityId, fieldId, displayName, required = false) => field('Integer', entityId, fieldId, displayName, required);
const boolean = (entityId, fieldId, displayName) => field('Boolean', entityId, fieldId, displayName);
const reference = (entityId, fieldId, displayName, targetEntityId, labelFieldId, required = false) => [
  field('Reference', entityId, fieldId, displayName, required),
  op('schema.configureReference', { entityId, fieldId, targetEntityId, labelFieldId }),
];
const unique = (entityId, fieldId) => op('schema.setFieldUnique', { entityId, fieldId, unique: true });
const tone = (entityId, fieldId, choiceId, toneName) =>
  op('schema.setChoiceMetadata', { entityId, fieldId, choiceId, displayName: choiceId, retired: false, tone: toneName });

/** Split a record type's operations into mutations of at most 16, the first holding its create. */
function inMutations(description, operations) {
  const mutations = [];
  const total = Math.ceil(operations.length / 16);
  for (let start = 0; start < operations.length; start += 16) {
    mutations.push({
      description: total > 1 ? `${description} (${mutations.length + 1} of ${total})` : description,
      operations: operations.slice(start, start + 16),
    });
  }
  return mutations;
}

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
  const where = (parentNodeId, name, fieldId, operator, value) =>
    add(`${parentNodeId}.where.${name}`, 'filterClause', parentNodeId, { fieldId, operator, valueKind: 'literal', value });
  const related = (nodeId, parentNodeId, targetEntityId, viaFieldId, title, fieldIds, order) => {
    const list = add(nodeId, 'relatedList', parentNodeId, {
      targetEntityId, viaFieldId, title, ...(order ? { orderByFieldId: order, orderDirection: 'ascending' } : {}),
    });
    bindings(list, fieldIds);
    return list;
  };
  return { add, bindings, where, related, operations };
}

export const PURPOSE = [
  'An ArchiMate 3.2 model, kept the way Archi keeps one: elements and relationships, the folders they',
  'sit in, and views that draw them. It follows archi-online and Archi 5.9, offline, in one file.',
  '',
  'A Concept is an element or a relationship; its Concept type says which of the 72 ArchiMate types it',
  'is, and carries that type\'s layer and default look. A relationship points at its source and target,',
  'which may themselves be relationships. A View is a diagram, and its Diagram items are the boxes,',
  'groups, notes and lines on it, nested the way they are drawn. Properties are Archi\'s ordered',
  'key/value pairs, each on one concept, view, folder, diagram item or the model itself.',
  '',
  'The Archi ID of each record is the identifier Archi gave it, kept so a model can travel to and from a',
  '.archimate file unchanged. The relationship rules and viewpoints are ArchiMate\'s, not the model\'s,',
  'and live in the Archi view\'s code.',
].join('\n');

export const LAYERS = ['Strategy', 'Business', 'Application', 'Technology', 'Physical', 'Motivation',
  'Implementation & Migration', 'Other', 'Relationship'];
const LAYER_TONES = { Strategy: 'orange', Business: 'amber', Application: 'teal', Technology: 'green', Physical: 'green',
  Motivation: 'violet', 'Implementation & Migration': 'red', Other: 'grey', Relationship: 'grey' };
export const FOLDER_KINDS = ['Strategy', 'Business', 'Application', 'Technology & Physical', 'Motivation',
  'Implementation & Migration', 'Other', 'Relations', 'Views'];
const FOLDER_TONES = { Strategy: 'orange', Business: 'amber', Application: 'teal', 'Technology & Physical': 'green',
  Motivation: 'violet', 'Implementation & Migration': 'red', Other: 'grey', Relations: 'grey', Views: 'blue' };
export const ITEM_KINDS = ['Element', 'Group', 'Note', 'View reference', 'Relationship connection', 'Connection'];
const DUBLIN_CORE = ['title', 'creator', 'subject', 'description', 'publisher', 'contributor', 'date', 'type',
  'format', 'identifier', 'source', 'language', 'relation', 'coverage', 'rights'];
const titled = word => word.charAt(0).toUpperCase() + word.slice(1);

// Each field of a diagram item Archi stores, typed: bounds relative to the parent, as Archi
// keeps them; colours as #rrggbb text; the numbered styles as Archi numbers them.
const ITEM_STYLE = [
  ['figure', 'Figure', 'Integer'], ['border', 'Border type', 'Integer'], ['connectionType', 'Connection line and arrows', 'Integer'],
  ['nameVisible', 'Name visible', 'Boolean'], ['textAlignment', 'Text alignment', 'Integer'], ['textPosition', 'Text position', 'Integer'],
  ['fillColor', 'Fill colour', 'Text'], ['lineColor', 'Line colour', 'Text'], ['fontColor', 'Font colour', 'Text'],
  ['alpha', 'Fill alpha', 'Integer'], ['lineAlpha', 'Line alpha', 'Integer'], ['fontAlpha', 'Font alpha', 'Integer'],
  ['gradient', 'Gradient', 'Integer'], ['lineStyle', 'Line style', 'Integer'], ['lineWidth', 'Line width', 'Integer'],
  ['iconVisible', 'Icon visibility', 'Integer'], ['iconColor', 'Icon colour', 'Text'],
  ['derivedLineColor', 'Line colour derived from fill', 'Boolean'], ['font', 'Font', 'Text'],
];

export const STAGES = {
  model: {
    title: 'Archi: the model, its folders and its concepts',
    makes: ['ar.model', 'ar.folder', 'ar.type', 'ar.specialization', 'ar.concept', 'ar.view'],
    mutations: () => [
      {
        description: 'Say what this file is for, and give it a look of its own',
        operations: [
          op('application.setPurpose', { purpose: PURPOSE }),
          op('application.setLook', { tone: 'teal', letter: 'A' }),
        ],
      },
      ...inMutations('Create Model', [
        op('schema.createEntity', { entityId: 'ar.model', displayName: 'Model' }),
        text('ar.model', 'ar.model.name', 'Name', true),
        long('ar.model', 'ar.model.documentation', 'Purpose'),
        text('ar.model', 'ar.model.language', 'Language'),
        text('ar.model', 'ar.model.version', 'Version'),
        text('ar.model', 'ar.model.archiId', 'Archi ID'),
        unique('ar.model', 'ar.model.archiId'),
        ...DUBLIN_CORE.map(name => text('ar.model', `ar.model.dc${titled(name)}`, `Dublin Core ${name}`)),
      ]),
      ...inMutations('Create Folders', [
        op('schema.createEntity', { entityId: 'ar.folder', displayName: 'Folders' }),
        text('ar.folder', 'ar.folder.name', 'Name', true),
        choice('ar.folder', 'ar.folder.kind', 'Kind', FOLDER_KINDS),
        long('ar.folder', 'ar.folder.documentation', 'Documentation'),
        text('ar.folder', 'ar.folder.labelExpression', 'Label expression'),
        ...reference('ar.folder', 'ar.folder.parent', 'Inside', 'ar.folder', 'ar.folder.name'),
        integer('ar.folder', 'ar.folder.order', 'Order'),
        text('ar.folder', 'ar.folder.archiId', 'Archi ID'),
        unique('ar.folder', 'ar.folder.archiId'),
        op('schema.declareHierarchy', { entityId: 'ar.folder', parentFieldId: 'ar.folder.parent', orderFieldId: 'ar.folder.order' }),
      ]),
      ...inMutations('Create Concept types', [
        op('schema.createEntity', { entityId: 'ar.type', displayName: 'Concept types' }),
        text('ar.type', 'ar.type.key', 'Key', true),
        text('ar.type', 'ar.type.name', 'Name', true),
        choice('ar.type', 'ar.type.category', 'Category', ['Element', 'Relationship'], true),
        choice('ar.type', 'ar.type.layer', 'Layer', LAYERS, true),
        text('ar.type', 'ar.type.fill', 'Default fill'),
        integer('ar.type', 'ar.type.width', 'Default width'),
        integer('ar.type', 'ar.type.height', 'Default height'),
        text('ar.type', 'ar.type.letter', 'Relationship letter'),
        unique('ar.type', 'ar.type.key'),
      ]),
      ...inMutations('Create Specializations', [
        op('schema.createEntity', { entityId: 'ar.specialization', displayName: 'Specializations' }),
        text('ar.specialization', 'ar.specialization.name', 'Name', true),
        ...reference('ar.specialization', 'ar.specialization.type', 'Concept type', 'ar.type', 'ar.type.name', true),
        text('ar.specialization', 'ar.specialization.archiId', 'Archi ID'),
        unique('ar.specialization', 'ar.specialization.archiId'),
      ]),
      ...inMutations('Create Concepts', [
        op('schema.createEntity', { entityId: 'ar.concept', displayName: 'Concepts' }),
        text('ar.concept', 'ar.concept.name', 'Name'),
        ...reference('ar.concept', 'ar.concept.type', 'Type', 'ar.type', 'ar.type.name', true),
        choice('ar.concept', 'ar.concept.category', 'Category', ['Element', 'Relationship'], true),
        long('ar.concept', 'ar.concept.documentation', 'Documentation'),
        ...reference('ar.concept', 'ar.concept.folder', 'Folder', 'ar.folder', 'ar.folder.name'),
        ...reference('ar.concept', 'ar.concept.source', 'Source', 'ar.concept', 'ar.concept.name'),
        ...reference('ar.concept', 'ar.concept.target', 'Target', 'ar.concept', 'ar.concept.name'),
        choice('ar.concept', 'ar.concept.access', 'Access', ['Write', 'Read', 'Access', 'Read and write']),
        text('ar.concept', 'ar.concept.strength', 'Influence strength'),
        boolean('ar.concept', 'ar.concept.directed', 'Directed'),
        choice('ar.concept', 'ar.concept.junction', 'Junction type', ['And', 'Or']),
        ...reference('ar.concept', 'ar.concept.specialization', 'Specialization', 'ar.specialization', 'ar.specialization.name'),
        text('ar.concept', 'ar.concept.archiId', 'Archi ID'),
        unique('ar.concept', 'ar.concept.archiId'),
      ]),
      ...inMutations('Create Views', [
        op('schema.createEntity', { entityId: 'ar.view', displayName: 'Views' }),
        text('ar.view', 'ar.view.name', 'Name', true),
        long('ar.view', 'ar.view.documentation', 'Documentation'),
        ...reference('ar.view', 'ar.view.folder', 'Folder', 'ar.folder', 'ar.folder.name'),
        text('ar.view', 'ar.view.viewpoint', 'Viewpoint'),
        choice('ar.view', 'ar.view.router', 'Connection router', ['Manual', 'Manhattan']),
        text('ar.view', 'ar.view.archiId', 'Archi ID'),
        unique('ar.view', 'ar.view.archiId'),
      ]),
    ],
  },

  diagrams: {
    title: 'Archi: diagram items and properties',
    needs: ['ar.model', 'ar.folder', 'ar.concept', 'ar.view'],
    makes: ['ar.item', 'ar.property'],
    mutations: () => [
      ...inMutations('Create Diagram items', [
        op('schema.createEntity', { entityId: 'ar.item', displayName: 'Diagram items' }),
        ...reference('ar.item', 'ar.item.view', 'View', 'ar.view', 'ar.view.name', true),
        choice('ar.item', 'ar.item.kind', 'Kind', ITEM_KINDS, true),
        // A reference needs a text label; most diagram items have no name, so the Archi ID is it.
        text('ar.item', 'ar.item.archiId', 'Archi ID'),
        unique('ar.item', 'ar.item.archiId'),
        ...reference('ar.item', 'ar.item.concept', 'Concept', 'ar.concept', 'ar.concept.name'),
        ...reference('ar.item', 'ar.item.refView', 'Referenced view', 'ar.view', 'ar.view.name'),
        ...reference('ar.item', 'ar.item.parent', 'Inside', 'ar.item', 'ar.item.archiId'),
        integer('ar.item', 'ar.item.order', 'Order'),
        ...reference('ar.item', 'ar.item.source', 'From', 'ar.item', 'ar.item.archiId'),
        ...reference('ar.item', 'ar.item.target', 'To', 'ar.item', 'ar.item.archiId'),
        integer('ar.item', 'ar.item.x', 'X'),
        integer('ar.item', 'ar.item.y', 'Y'),
        integer('ar.item', 'ar.item.width', 'Width'),
        integer('ar.item', 'ar.item.height', 'Height'),
        long('ar.item', 'ar.item.bendpoints', 'Bendpoints'),
        text('ar.item', 'ar.item.name', 'Name'),
        long('ar.item', 'ar.item.documentation', 'Documentation'),
        long('ar.item', 'ar.item.content', 'Note text'),
        ...ITEM_STYLE.map(([name, displayName, kind]) => field(kind, 'ar.item', `ar.item.${name}`, displayName)),
        long('ar.item', 'ar.item.labelExpression', 'Label expression'),
        long('ar.item', 'ar.item.legend', 'Legend options'),
        op('schema.declareHierarchy', { entityId: 'ar.item', parentFieldId: 'ar.item.parent', orderFieldId: 'ar.item.order' }),
      ]),
      ...inMutations('Create Properties', [
        op('schema.createEntity', { entityId: 'ar.property', displayName: 'Properties' }),
        text('ar.property', 'ar.property.key', 'Key', true),
        long('ar.property', 'ar.property.value', 'Value'),
        integer('ar.property', 'ar.property.order', 'Order'),
        ...reference('ar.property', 'ar.property.concept', 'Concept', 'ar.concept', 'ar.concept.name'),
        ...reference('ar.property', 'ar.property.view', 'View', 'ar.view', 'ar.view.name'),
        ...reference('ar.property', 'ar.property.folder', 'Folder', 'ar.folder', 'ar.folder.name'),
        ...reference('ar.property', 'ar.property.item', 'Diagram item', 'ar.item', 'ar.item.archiId'),
        ...reference('ar.property', 'ar.property.model', 'Model', 'ar.model', 'ar.model.name'),
      ]),
    ],
  },

  colour: {
    title: 'Archi: colour the layers and folders',
    needs: ['ar.type', 'ar.folder', 'ar.concept'],
    appliedWhen: async read => (await read.schema('ar.type')).fields
      .find(f => f.fieldId === 'ar.type.layer')?.choices.some(c => c.tone) ?? false,
    mutations: () => inMutations('Colour the choices', [
      ...LAYERS.map(layer => tone('ar.type', 'ar.type.layer', layer, LAYER_TONES[layer])),
      ...FOLDER_KINDS.map(kind => tone('ar.folder', 'ar.folder.kind', kind, FOLDER_TONES[kind])),
      tone('ar.type', 'ar.type.category', 'Element', 'blue'),
      tone('ar.type', 'ar.type.category', 'Relationship', 'grey'),
      tone('ar.concept', 'ar.concept.category', 'Element', 'blue'),
      tone('ar.concept', 'ar.concept.category', 'Relationship', 'grey'),
    ]),
  },

  screens: {
    title: 'Archi: screens for concepts, views and folders',
    needs: ['ar.model', 'ar.folder', 'ar.type', 'ar.concept', 'ar.view', 'ar.item', 'ar.property', 'ar.specialization'],
    appliedWhen: async read => read.hasNode('ar.screen.elements'),
    mutations: () => inMutations('Screens for concepts, views and folders', screenOperations().first),
  },

  pages: {
    title: 'Archi: screens for diagram items, types, the model and properties',
    needs: ['ar.model', 'ar.folder', 'ar.type', 'ar.concept', 'ar.view', 'ar.item', 'ar.property', 'ar.specialization'],
    appliedWhen: async read => read.hasNode('ar.screen.items'),
    mutations: () => inMutations('Screens for diagram items, types, the model and properties', screenOperations().second),
  },
};

// Every screen, in one tree so the top-level positions run on across both stages; a change set
// carries 128 operations, so they arrive in two, cut where the diagram-item list begins.
function screenOperations() {
  const t = tree();

  const elements = t.add('ar.screen.elements', 'recordList', null, {
    definitionVersion: 3, entityId: 'ar.concept', title: 'Elements', orderByFieldId: 'ar.concept.name', orderDirection: 'ascending',
  });
  t.bindings(elements, ['ar.concept.name', 'ar.concept.type', 'ar.concept.folder']);
  t.where(elements, 'elements', 'ar.concept.category', 'eq', 'Element');
  t.add('ar.screen.elements.count', 'summaryTile', elements, { aggregate: 'count', title: 'Elements' });

  const relationships = t.add('ar.screen.relationships', 'recordList', null, {
    definitionVersion: 3, entityId: 'ar.concept', title: 'Relationships', orderByFieldId: 'ar.concept.name', orderDirection: 'ascending',
  });
  t.bindings(relationships, ['ar.concept.type', 'ar.concept.source', 'ar.concept.target', 'ar.concept.name']);
  t.where(relationships, 'relationships', 'ar.concept.category', 'eq', 'Relationship');
  t.add('ar.screen.relationships.count', 'summaryTile', relationships, { aggregate: 'count', title: 'Relationships' });

  const concept = t.add('ar.page.concept', 'detailSurface', null, {
    definitionVersion: 3, entityId: 'ar.concept', title: 'Concept', titleFieldId: 'ar.concept.name', accentFieldId: 'ar.concept.category',
  });
  const details = t.add('ar.page.concept.details', 'section', concept, { title: 'Details' });
  t.bindings(details, ['ar.concept.name', 'ar.concept.type', 'ar.concept.category', 'ar.concept.documentation',
    'ar.concept.folder', 'ar.concept.specialization']);
  const relationship = t.add('ar.page.concept.relationship', 'section', concept, { title: 'Relationship' });
  t.bindings(relationship, ['ar.concept.source', 'ar.concept.target', 'ar.concept.access', 'ar.concept.strength',
    'ar.concept.directed', 'ar.concept.junction', 'ar.concept.archiId']);
  const model = t.add('ar.page.concept.model', 'section', concept, { title: 'In the model' });
  t.related('ar.page.concept.from', model, 'ar.concept', 'ar.concept.source', 'Relationships from here',
    ['ar.concept.type', 'ar.concept.target', 'ar.concept.name']);
  t.related('ar.page.concept.to', model, 'ar.concept', 'ar.concept.target', 'Relationships to here',
    ['ar.concept.type', 'ar.concept.source', 'ar.concept.name']);
  t.related('ar.page.concept.occurrences', model, 'ar.item', 'ar.item.concept', 'In views', ['ar.item.view', 'ar.item.kind']);
  t.related('ar.page.concept.properties', model, 'ar.property', 'ar.property.concept', 'Properties',
    ['ar.property.key', 'ar.property.value'], 'ar.property.order');

  const views = t.add('ar.screen.views', 'recordList', null, {
    definitionVersion: 3, entityId: 'ar.view', title: 'Views', orderByFieldId: 'ar.view.name', orderDirection: 'ascending',
  });
  t.bindings(views, ['ar.view.name', 'ar.view.viewpoint', 'ar.view.folder']);
  const view = t.add('ar.page.view', 'detailSurface', null, {
    definitionVersion: 3, entityId: 'ar.view', title: 'View', titleFieldId: 'ar.view.name',
  });
  const viewDetails = t.add('ar.page.view.details', 'section', view, { title: 'Details' });
  t.bindings(viewDetails, ['ar.view.name', 'ar.view.documentation', 'ar.view.folder', 'ar.view.viewpoint',
    'ar.view.router', 'ar.view.archiId']);
  t.related('ar.page.view.items', viewDetails, 'ar.item', 'ar.item.view', 'On this view',
    ['ar.item.kind', 'ar.item.concept', 'ar.item.parent', 'ar.item.x', 'ar.item.y']);
  t.related('ar.page.view.properties', viewDetails, 'ar.property', 'ar.property.view', 'Properties',
    ['ar.property.key', 'ar.property.value'], 'ar.property.order');

  const outline = t.add('ar.screen.tree', 'outlineSurface', null, {
    definitionVersion: 3, entityId: 'ar.folder', title: 'Model tree', titleFieldId: 'ar.folder.name',
    accentFieldId: 'ar.folder.kind', expandDepth: 1, reorder: true,
  });
  t.bindings(outline, ['ar.folder.kind']);
  const folder = t.add('ar.page.folder', 'detailSurface', null, {
    definitionVersion: 3, entityId: 'ar.folder', title: 'Folder', titleFieldId: 'ar.folder.name', accentFieldId: 'ar.folder.kind',
  });
  const folderDetails = t.add('ar.page.folder.details', 'section', folder, { title: 'Details' });
  t.bindings(folderDetails, ['ar.folder.name', 'ar.folder.kind', 'ar.folder.parent', 'ar.folder.documentation',
    'ar.folder.labelExpression']);
  t.related('ar.page.folder.folders', folderDetails, 'ar.folder', 'ar.folder.parent', 'Folders', ['ar.folder.name'], 'ar.folder.order');
  t.related('ar.page.folder.concepts', folderDetails, 'ar.concept', 'ar.concept.folder', 'Concepts', ['ar.concept.name', 'ar.concept.type']);
  t.related('ar.page.folder.views', folderDetails, 'ar.view', 'ar.view.folder', 'Views', ['ar.view.name']);

  const items = t.add('ar.screen.items', 'recordList', null, {
    definitionVersion: 3, entityId: 'ar.item', title: 'Diagram items', orderByFieldId: 'ar.item.view', orderDirection: 'ascending',
  });
  t.bindings(items, ['ar.item.view', 'ar.item.kind', 'ar.item.concept', 'ar.item.x', 'ar.item.y']);
  const item = t.add('ar.page.item', 'detailSurface', null, {
    definitionVersion: 3, entityId: 'ar.item', title: 'Diagram item', titleFieldId: 'ar.item.archiId', accentFieldId: 'ar.item.kind',
  });
  const placed = t.add('ar.page.item.placed', 'section', item, { title: 'Placement' });
  t.bindings(placed, ['ar.item.view', 'ar.item.kind', 'ar.item.concept', 'ar.item.refView', 'ar.item.parent',
    'ar.item.order', 'ar.item.x', 'ar.item.y', 'ar.item.width', 'ar.item.height', 'ar.item.source', 'ar.item.target',
    'ar.item.bendpoints', 'ar.item.name', 'ar.item.content']);
  const look = t.add('ar.page.item.look', 'section', item, { title: 'Appearance', opens: 'closed' });
  t.bindings(look, [...ITEM_STYLE.map(([name]) => `ar.item.${name}`), 'ar.item.labelExpression']);
  t.related('ar.page.item.properties', item, 'ar.property', 'ar.property.item', 'Properties',
    ['ar.property.key', 'ar.property.value'], 'ar.property.order');

  const types = t.add('ar.screen.types', 'boardSurface', null, {
    definitionVersion: 3, entityId: 'ar.type', title: 'Concept types', groupByFieldId: 'ar.type.layer',
    orderByFieldId: 'ar.type.name', orderDirection: 'ascending',
  });
  t.bindings(types, ['ar.type.name', 'ar.type.key', 'ar.type.fill']);
  const type = t.add('ar.page.type', 'detailSurface', null, {
    definitionVersion: 3, entityId: 'ar.type', title: 'Concept type', titleFieldId: 'ar.type.name', accentFieldId: 'ar.type.layer',
  });
  const typeDetails = t.add('ar.page.type.details', 'section', type, { title: 'Details' });
  t.bindings(typeDetails, ['ar.type.key', 'ar.type.category', 'ar.type.layer', 'ar.type.fill', 'ar.type.width',
    'ar.type.height', 'ar.type.letter']);
  t.related('ar.page.type.concepts', typeDetails, 'ar.concept', 'ar.concept.type', 'Concepts of this type', ['ar.concept.name', 'ar.concept.folder']);

  const specializations = t.add('ar.screen.specializations', 'recordList', null, {
    definitionVersion: 3, entityId: 'ar.specialization', title: 'Specializations',
    orderByFieldId: 'ar.specialization.name', orderDirection: 'ascending',
  });
  t.bindings(specializations, ['ar.specialization.name', 'ar.specialization.type']);

  const models = t.add('ar.screen.model', 'recordList', null, { definitionVersion: 3, entityId: 'ar.model', title: 'Model' });
  t.bindings(models, ['ar.model.name', 'ar.model.version']);
  const modelPage = t.add('ar.page.model', 'detailSurface', null, {
    definitionVersion: 3, entityId: 'ar.model', title: 'Model', titleFieldId: 'ar.model.name',
  });
  const about = t.add('ar.page.model.about', 'section', modelPage, { title: 'About' });
  t.bindings(about, ['ar.model.name', 'ar.model.documentation', 'ar.model.language', 'ar.model.version']);
  const metadata = t.add('ar.page.model.metadata', 'section', modelPage, { title: 'Dublin Core', opens: 'closed' });
  t.bindings(metadata, DUBLIN_CORE.map(name => `ar.model.dc${titled(name)}`));
  t.related('ar.page.model.properties', modelPage, 'ar.property', 'ar.property.model', 'Properties',
    ['ar.property.key', 'ar.property.value'], 'ar.property.order');

  const properties = t.add('ar.screen.properties', 'recordList', null, {
    definitionVersion: 3, entityId: 'ar.property', title: 'Properties', orderByFieldId: 'ar.property.key', orderDirection: 'ascending',
  });
  t.bindings(properties, ['ar.property.key', 'ar.property.value', 'ar.property.concept', 'ar.property.view']);

  const cut = t.operations.findIndex(operation => operation.payload.nodeId === 'ar.screen.items');
  return { first: t.operations.slice(0, cut), second: t.operations.slice(cut) };
}

export const STAGE_ORDER = ['model', 'diagrams', 'colour', 'screens', 'pages'];

// The records every Archi file starts with: Archi's nine top-level folders, in its order, and
// the 72 concept types. Record IDs are stable, so a rebuild finds what is already there.
export const ROOT_FOLDERS = FOLDER_KINDS.map((kind, index) => ({
  recordId: `ar.folder.r.${kind.toLowerCase().replace(/[^a-z]+/g, '-')}`,
  values: { 'ar.folder.name': kind, 'ar.folder.kind': kind, 'ar.folder.order': (index + 1) * 1024 },
}));

export const TYPES = CONCEPT_TYPES.map(type => ({
  recordId: `ar.type.r.${type.key}`,
  values: {
    'ar.type.key': type.key, 'ar.type.name': type.name, 'ar.type.category': type.category, 'ar.type.layer': type.layer,
    'ar.type.fill': type.fill ?? null, 'ar.type.width': type.width ?? null, 'ar.type.height': type.height ?? null,
    'ar.type.letter': type.letter ?? null,
  },
}));

export const MODEL = { recordId: 'ar.model.r.model', values: { 'ar.model.name': 'New model' } };
