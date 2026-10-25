// The shape of a Deck file: record types, screens, the Deck view, its skill, the six templates and
// the example deck, one stage per change set. tools/Build-Deck.mjs sends them; this file only says
// what they are. extensions/deck/README.md gives the reasons.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { E, F, LAYOUT_IDS, CHARTS, TRANSITIONS, SLIDE_TRANSITIONS, BUILDS } from '../../extensions/deck/model.mjs';
import { TEMPLATES } from '../../extensions/deck/themes.mjs';
import { MODES, PLACEMENT_LABELS } from '../../extensions/deck/design.mjs';
import { EXAMPLE_DECK, EXAMPLE_SLIDES } from './example.mjs';

export const SURFACE = 'deck';
export const CALL_CHARACTERS = 200_000;
export const PACKAGE_ID = 'org.nendo.deck';
export const SKILL_PACKAGE_ID = 'dev.nendo.deck';
export const SKILL_URI = 'skill://dev.nendo.deck/deck/SKILL.md';
const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_FOLDER = path.resolve(here, '..', '..', 'extensions', 'deck');
export const SKILL_FOLDER = path.resolve(here, 'skill');
export const NEW_FILE_LABEL = 'deck';
export const SEED_DATE = '2026-10-23';
export const VIEW_NODE = 'dk.view';
export const EXAMPLE_ID = 'dk.deck.example';

export const FAMILIES = ['Keynote', 'Editorial', 'Swiss', 'Boardroom', 'Studio', 'Minimal'];
export const DECK_STATUS = ['Draft', 'Ready', 'Presented'];
export const ASPECTS = ['16:9', '4:3'];
export const ASK_SCOPES = ['Whole deck', 'Selection', 'Mission'];
export const ASK_STATUS = ['Waiting', 'Working', 'Done', 'Failed', 'Cancelled'];
export const VARIANT_STATUS = ['Proposed', 'Used', 'Dismissed'];
export const BRAND_SOURCES = ['Brandkits', 'By hand'];
/** The layouts and charts the layouts stage adds; the schema stage makes the Layout and Chart choices without them. */
export const ADDED_LAYOUTS = ['Title only', 'Picture grid', 'Process', 'Cycle'];
export const ADDED_CHARTS = ['Pie', 'Area', 'Stacked'];

const op = (operationType, payload) => ({ operationType, payload });
const field = (entityId, fieldId, displayName, storageKind, presentation, { required = false, options = [] } = {}) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind, required, presentation, options });
const text = (entityId, fieldId, displayName, required = false) => field(entityId, fieldId, displayName, 'Text', 'singleLine', { required });
const long = (entityId, fieldId, displayName, required = false) => field(entityId, fieldId, displayName, 'Text', 'longText', { required });
const markdown = (entityId, fieldId, displayName) => field(entityId, fieldId, displayName, 'Text', 'markdown');
const picture = (entityId, fieldId, displayName) => field(entityId, fieldId, displayName, 'Text', 'media');
const choice = (entityId, fieldId, displayName, options, required = false) => field(entityId, fieldId, displayName, 'Text', 'singleChoice', { required, options });
const date = (entityId, fieldId, displayName) => field(entityId, fieldId, displayName, 'Date', 'date');
const integer = (entityId, fieldId, displayName) => field(entityId, fieldId, displayName, 'Integer', null);
const boolean = (entityId, fieldId, displayName, required = false) => field(entityId, fieldId, displayName, 'Boolean', null, { required });
const reference = (entityId, fieldId, displayName, required = false) => field(entityId, fieldId, displayName, 'Reference', null, { required });
const bind = (entityId, fieldId, targetEntityId, labelFieldId) => op('schema.configureReference', { entityId, fieldId, targetEntityId, labelFieldId });
const tone = (entityId, fieldId, choiceId, toneName) =>
  op('schema.setChoiceMetadata', { entityId, fieldId, choiceId, displayName: choiceId, retired: false, tone: toneName });

/** Screen nodes carry their position within their parent, counted here (as the planner's tree()). */
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
  const bindings = (parentNodeId, fieldIds) => { for (const fieldId of fieldIds) add(`${parentNodeId}.${fieldId}`, 'fieldBinding', parentNodeId, { fieldId }); };
  return { add, bindings, asMutations: description => chunk(operations, description) };
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
  'Slide decks. A Deck has Slides in order; each slide has a layout (Title, Bullets, Two columns, Big',
  'numbers, Process, Chart and fifteen more), a title, a kicker, a Markdown body, speaker notes and',
  'perhaps pictures. A deck draws with a Template (its look) and perhaps a Brand kit, imported from a',
  'Brandkits export, whose colours, fonts and logo override the template\'s.',
  '',
  'The Deck view is where decks are written, presented and exported to HTML and PowerPoint. The person',
  'asks their own agent from the view: each request is an Ask record, written first, and the agent',
  'answers with slides it writes, or with Variants of a slide that the person uses or dismisses. The',
  'file carries the agent\'s half as the skill dev.nendo.deck. There are no automatic actions.',
].join('\n');

const ENTITIES = Object.values(E);

export const STAGES = {
  schema: {
    title: 'Deck: the record types',
    makes: ENTITIES,
    mutations: () => [
      { description: 'Say what this file is for, and give it a look of its own', operations: [
        op('application.setPurpose', { purpose: PURPOSE }),
        op('application.setLook', { tone: 'orange', letter: 'D' }),
        op('application.setNewFileLabel', { label: NEW_FILE_LABEL }),
      ] },
      { description: 'Create Templates', operations: [
        op('schema.createEntity', { entityId: E.template, displayName: 'Templates' }),
        text(E.template, F.template.name, 'Name', true),
        choice(E.template, F.template.family, 'Family', FAMILIES, true),
        long(E.template, F.template.description, 'About'),
        text(E.template, F.template.headingFont, 'Heading font'),
        text(E.template, F.template.bodyFont, 'Body font'),
        text(E.template, F.template.background, 'Background'),
        text(E.template, F.template.surface, 'Surface'),
        text(E.template, F.template.ink, 'Text'),
        text(E.template, F.template.muted, 'Muted text'),
        text(E.template, F.template.primary, 'Primary'),
        text(E.template, F.template.secondary, 'Secondary'),
        text(E.template, F.template.accent, 'Accent'),
      ] },
      { description: 'Create Brand kits', operations: [
        op('schema.createEntity', { entityId: E.brand, displayName: 'Brand kits' }),
        text(E.brand, F.brand.name, 'Name', true),
        choice(E.brand, F.brand.source, 'Source', BRAND_SOURCES),
        text(E.brand, F.brand.primary, 'Primary'),
        text(E.brand, F.brand.secondary, 'Secondary'),
        text(E.brand, F.brand.accent, 'Accent'),
        text(E.brand, F.brand.background, 'Background'),
        text(E.brand, F.brand.surface, 'Surface'),
        text(E.brand, F.brand.ink, 'Text'),
        text(E.brand, F.brand.muted, 'Muted text'),
        text(E.brand, F.brand.headingFont, 'Heading font'),
        text(E.brand, F.brand.bodyFont, 'Body font'),
        text(E.brand, F.brand.monoFont, 'Mono font'),
        picture(E.brand, F.brand.logo, 'Logo'),
        picture(E.brand, F.brand.logoDark, 'Logo on dark'),
      ] },
      { description: 'Give Brand kits their words', operations: [
        long(E.brand, F.brand.voice, 'Voice'),
        text(E.brand, F.brand.tagline, 'Tagline'),
        long(E.brand, F.brand.tokens, 'Tokens'),
      ] },
      { description: 'Create Decks', operations: [
        op('schema.createEntity', { entityId: E.deck, displayName: 'Decks' }),
        text(E.deck, F.deck.title, 'Title', true),
        text(E.deck, F.deck.subtitle, 'Subtitle'),
        text(E.deck, F.deck.author, 'Author'),
        date(E.deck, F.deck.date, 'Date'),
        long(E.deck, F.deck.audience, 'Audience'),
        long(E.deck, F.deck.goal, 'Goal'),
        choice(E.deck, F.deck.aspect, 'Shape', ASPECTS),
        reference(E.deck, F.deck.template, 'Template'),
        reference(E.deck, F.deck.brand, 'Brand kit'),
        text(E.deck, F.deck.footer, 'Footer'),
        boolean(E.deck, F.deck.numbers, 'Slide numbers', true),
        choice(E.deck, F.deck.status, 'Status', DECK_STATUS),
      ] },
      { description: 'Create Slides', operations: [
        op('schema.createEntity', { entityId: E.slide, displayName: 'Slides' }),
        reference(E.slide, F.slide.deck, 'Deck', true),
        integer(E.slide, F.slide.order, 'Order'),
        choice(E.slide, F.slide.layout, 'Layout', LAYOUT_IDS.filter(id => !ADDED_LAYOUTS.includes(id)), true),
        text(E.slide, F.slide.title, 'Title'),
        text(E.slide, F.slide.kicker, 'Kicker'),
        markdown(E.slide, F.slide.body, 'Body'),
        markdown(E.slide, F.slide.body2, 'Body 2'),
        long(E.slide, F.slide.notes, 'Speaker notes'),
        picture(E.slide, F.slide.image, 'Picture'),
        text(E.slide, F.slide.imageAlt, 'Picture text'),
        choice(E.slide, F.slide.chart, 'Chart', CHARTS.filter(id => !ADDED_CHARTS.includes(id))),
        boolean(E.slide, F.slide.hidden, 'Hidden', true),
        long(E.slide, F.slide.format, 'Text format'),
      ] },
      { description: 'Create Asks and Variants', operations: [
        op('schema.createEntity', { entityId: E.ask, displayName: 'Asks' }),
        reference(E.ask, F.ask.deck, 'Deck', true),
        choice(E.ask, F.ask.scope, 'Scope', ASK_SCOPES, true),
        long(E.ask, F.ask.request, 'Request', true),
        long(E.ask, F.ask.selection, 'Selection'),
        choice(E.ask, F.ask.status, 'Status', ASK_STATUS, true),
        long(E.ask, F.ask.progress, 'Progress'),
        long(E.ask, F.ask.reply, 'Reply'),
        text(E.ask, F.ask.made, 'Asked'),
        op('schema.createEntity', { entityId: E.variant, displayName: 'Variants' }),
        reference(E.variant, F.variant.ask, 'Ask', true),
        reference(E.variant, F.variant.slide, 'Slide', true),
        text(E.variant, F.variant.label, 'Label', true),
        long(E.variant, F.variant.changes, 'Changes', true),
        long(E.variant, F.variant.rationale, 'Why'),
        choice(E.variant, F.variant.status, 'Status', VARIANT_STATUS, true),
      ] },
      { description: 'Point every reference at what it names', operations: [
        bind(E.deck, F.deck.template, E.template, F.template.name),
        bind(E.deck, F.deck.brand, E.brand, F.brand.name),
        bind(E.slide, F.slide.deck, E.deck, F.deck.title),
        bind(E.ask, F.ask.deck, E.deck, F.deck.title),
        bind(E.variant, F.variant.ask, E.ask, F.ask.request),
        bind(E.variant, F.variant.slide, E.slide, F.slide.title),
      ] },
    ],
  },

  colour: {
    title: 'Deck: colour the choices',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema(E.ask)).fields.find(f => f.fieldId === F.ask.status)?.choices.some(c => c.tone) ?? false,
    mutations: () => chunk(TONES.flatMap(([entityId, fieldId, pairs]) => pairs.map(([choiceId, toneName]) => tone(entityId, fieldId, choiceId, toneName))), 'Colour the choices'),
  },

  screens: {
    title: 'Deck: the lists and the record pages',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode('dk.deck.list'),
    mutations: () => {
      const t = tree();
      const decks = t.add('dk.deck.list', 'recordList', null, { definitionVersion: 3, entityId: E.deck, title: 'Decks', orderByFieldId: F.deck.date, orderDirection: 'descending' });
      t.bindings(decks, [F.deck.title, F.deck.author, F.deck.date, F.deck.template, F.deck.brand, F.deck.status]);
      const brands = t.add('dk.brand.list', 'gallerySurface', null, { definitionVersion: 3, entityId: E.brand, title: 'Brand kits',
        titleFieldId: F.brand.name, orderByFieldId: F.brand.name, orderDirection: 'ascending' });
      t.bindings(brands, [F.brand.logo, F.brand.primary, F.brand.headingFont, F.brand.tagline]);
      const templates = t.add('dk.template.list', 'recordList', null, { definitionVersion: 3, entityId: E.template, title: 'Templates', orderByFieldId: F.template.name, orderDirection: 'ascending' });
      t.bindings(templates, [F.template.name, F.template.family, F.template.description, F.template.headingFont, F.template.primary]);
      const asks = t.add('dk.ask.list', 'recordList', null, { definitionVersion: 3, entityId: E.ask, title: 'Asks', orderByFieldId: F.ask.made, orderDirection: 'descending' });
      t.bindings(asks, [F.ask.request, F.ask.deck, F.ask.scope, F.ask.status, F.ask.made]);

      const deckPage = t.add('dk.deck.page', 'detailSurface', null, { definitionVersion: 3, entityId: E.deck, title: 'Deck', titleFieldId: F.deck.title, subtitleFieldId: F.deck.subtitle, accentFieldId: F.deck.status });
      t.bindings(deckPage, [F.deck.author, F.deck.date, F.deck.audience, F.deck.goal, F.deck.template, F.deck.brand, F.deck.aspect, F.deck.footer, F.deck.numbers, F.deck.status]);
      const slides = t.add('dk.deck.page.slides', 'relatedList', deckPage, { targetEntityId: E.slide, viaFieldId: F.slide.deck, title: 'Slides', orderByFieldId: F.slide.order, orderDirection: 'ascending' });
      t.bindings(slides, [F.slide.order, F.slide.layout, F.slide.title, F.slide.hidden]);
      const slidePage = t.add('dk.slide.page', 'detailSurface', null, { definitionVersion: 3, entityId: E.slide, title: 'Slide', titleFieldId: F.slide.title, subtitleFieldId: F.slide.kicker, accentFieldId: F.slide.layout });
      t.bindings(slidePage, [F.slide.deck, F.slide.order, F.slide.layout, F.slide.body, F.slide.body2, F.slide.notes, F.slide.image, F.slide.imageAlt, F.slide.chart, F.slide.hidden]);
      const brandPage = t.add('dk.brand.page', 'detailSurface', null, { definitionVersion: 3, entityId: E.brand, title: 'Brand kit', titleFieldId: F.brand.name, subtitleFieldId: F.brand.tagline });
      t.bindings(brandPage, [F.brand.source, F.brand.logo, F.brand.logoDark, F.brand.primary, F.brand.secondary, F.brand.accent, F.brand.background, F.brand.surface,
        F.brand.ink, F.brand.muted, F.brand.headingFont, F.brand.bodyFont, F.brand.monoFont, F.brand.voice, F.brand.tokens]);
      const templatePage = t.add('dk.template.page', 'detailSurface', null, { definitionVersion: 3, entityId: E.template, title: 'Template', titleFieldId: F.template.name, accentFieldId: F.template.family });
      t.bindings(templatePage, [F.template.family, F.template.description, F.template.headingFont, F.template.bodyFont, F.template.background, F.template.surface,
        F.template.ink, F.template.muted, F.template.primary, F.template.secondary, F.template.accent]);
      const askPage = t.add('dk.ask.page', 'detailSurface', null, { definitionVersion: 3, entityId: E.ask, title: 'Ask', titleFieldId: F.ask.request, accentFieldId: F.ask.status });
      t.bindings(askPage, [F.ask.deck, F.ask.scope, F.ask.status, F.ask.made, F.ask.selection, F.ask.progress, F.ask.reply]);
      const variants = t.add('dk.ask.page.variants', 'relatedList', askPage, { targetEntityId: E.variant, viaFieldId: F.variant.ask, title: 'Variants' });
      t.bindings(variants, [F.variant.slide, F.variant.label, F.variant.status]);
      const variantPage = t.add('dk.variant.page', 'detailSurface', null, { definitionVersion: 3, entityId: E.variant, title: 'Variant', titleFieldId: F.variant.label, accentFieldId: F.variant.status });
      t.bindings(variantPage, [F.variant.ask, F.variant.slide, F.variant.status, F.variant.rationale, F.variant.changes]);
      return t.asMutations('The lists and the record pages');
    },
  },

  view: {
    title: 'Deck: the Deck view, which the file opens on',
    needs: ENTITIES,
    appliedWhen: async read => read.hasNode(VIEW_NODE),
    mutations: async () => {
      const files = await packageMutations(PACKAGE_FOLDER, PACKAGE_ID, 'Put the Deck package into the file');
      const node = op('ui.addNode', { surfaceId: SURFACE, nodeId: VIEW_NODE, parentNodeId: null, kind: 'extensionView', beforeNodeId: 'dk.deck.list',
        properties: { definitionVersion: 3, title: 'Deck', packageId: PACKAGE_ID, entityId: E.deck, opensFile: true } });
      return [...files, { description: 'Show the Deck view, and open the file on it', operations: [node] }];
    },
  },

  skill: {
    title: 'Deck: the skill that tells an agent how to work an ask',
    needs: ENTITIES,
    appliedWhen: async read => (await read.json('nendo://application/extensions')).some(p => p.packageId === SKILL_PACKAGE_ID),
    mutations: async () => {
      const { manifest, skill } = await skillPackage();
      return [{ description: 'Put the Deck skill into the file', operations: [
        op('extension.setPackage', { packageId: SKILL_PACKAGE_ID, kind: 'skill', title: manifest.title, version: manifest.version, description: manifest.description }),
        op('extension.putFile', { packageId: SKILL_PACKAGE_ID, path: 'SKILL.md', text: skill, expectedSha256: 'absent' }),
      ] }];
    },
  },

  seed: {
    title: 'Deck: the six templates and the example deck',
    needs: ENTITIES,
    appliedWhen: async read => (await read.json(`nendo://application/entity/${E.template}/schema`)).recordCount > 0,
    mutations: () => chunk(seedOperations(), 'The templates and the example deck'),
  },

  keep: {
    title: 'Deck: keep the templates and the example in every new deck file',
    needs: ENTITIES,
    appliedWhen: async read => ((await read.json('nendo://application/describe?include=newFile')).newFile?.types ?? []).some(t => t.kept > 0),
    mutations: () => chunk(seedRecords().map(r => op('data.setKeptInNewFiles', { entityId: r.entityId, recordId: r.recordId, kept: true })), 'Keep the seeds in a new file'),
  },

  format: {
    title: 'Deck: a text format on each slide, for the size and alignment set on the stage',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema(E.slide)).fields.some(f => f.fieldId === F.slide.format),
    mutations: () => [{ description: 'Give Slides a text format', operations: [long(E.slide, F.slide.format, 'Text format')] }],
  },

  design: {
    title: 'Deck: designs from Brandkits, with their style, backgrounds and mark',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema(E.template)).fields.some(f => f.fieldId === F.template.source),
    mutations: () => chunk(designOperations(), 'Designs from Brandkits'),
  },

  present: {
    title: 'Deck: builds, transitions, rehearsed times and the talk length',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema(E.slide)).fields.some(f => f.fieldId === F.slide.build),
    mutations: () => chunk(presentOperations(), 'Builds, transitions and timings'),
  },

  tour: {
    title: 'Deck: the example deck shows the new layouts',
    needs: ENTITIES,
    // Run once: any of its slides in the file, in any deck, says so, and one the person deleted since stays deleted.
    appliedWhen: async read => tourRan(await read.records(E.slide)),
    // An empty file has no example deck yet, as in a dry run of the whole build: nothing to bring up.
    mutations: async ({ read }) => (await read.entities()).includes(E.deck)
      ? chunk(tourOperations(await read.records(E.slide), (await read.records(E.deck)).find(d => d.recordId === EXAMPLE_ID)), 'The example deck')
      : [],
  },

  layouts: {
    title: 'Deck: Title only, Picture grid, Process and Cycle, the pie, area and stacked charts, and the grid\'s pictures',
    needs: ENTITIES,
    appliedWhen: async read => (await read.schema(E.slide)).fields.some(f => f.fieldId === F.slide.image2),
    mutations: () => chunk(layoutsOperations(), 'More layouts and charts'),
  },

  search: {
    title: 'Deck: build the search index, so Find reads every slide',
    needs: ENTITIES,
    appliedWhen: async read => hasSearchIndex(read),
    mutations: () => [{ description: 'Build the search index', operations: [op('application.buildSearchIndex', {})] }],
  },
};

const TONES = [
  [E.deck, F.deck.status, [['Draft', 'amber'], ['Ready', 'green'], ['Presented', 'blue']]],
  [E.ask, F.ask.status, [['Waiting', 'grey'], ['Working', 'amber'], ['Done', 'green'], ['Failed', 'red'], ['Cancelled', 'grey']]],
  [E.ask, F.ask.scope, [['Whole deck', 'blue'], ['Selection', 'teal'], ['Mission', 'violet']]],
  [E.variant, F.variant.status, [['Proposed', 'violet'], ['Used', 'green'], ['Dismissed', 'grey']]],
  [E.template, F.template.family, [['Keynote', 'violet'], ['Editorial', 'amber'], ['Swiss', 'red'], ['Boardroom', 'blue'], ['Studio', 'teal'], ['Minimal', 'grey']]],
  [E.brand, F.brand.source, [['Brandkits', 'orange'], ['By hand', 'grey']]],
];

// The seeds come after every stage that declares a field or a choice they use. A built file has the
// stages before them already, so the order only decides how an empty file is built.
export const STAGE_ORDER = ['schema', 'colour', 'screens', 'view', 'skill', 'format', 'design', 'present', 'layouts', 'seed', 'keep', 'search', 'tour'];

/**
 * Four layouts and three charts more, as choices added to the slide's Layout and Chart, and the
 * three pictures a Picture grid holds after the slide's own. The file says it has them in its purpose.
 */
function layoutsOperations() {
  const node = (page, fieldId, position) => op('ui.addNode', { surfaceId: SURFACE, nodeId: `${page}.${fieldId}`, parentNodeId: page, kind: 'fieldBinding', position, properties: { fieldId } });
  return [
    op('application.setPurpose', { purpose: PURPOSE }),
    ...ADDED_LAYOUTS.map(choiceId => op('schema.addChoice', { entityId: E.slide, fieldId: F.slide.layout, choiceId, displayName: choiceId })),
    ...ADDED_CHARTS.map(choiceId => op('schema.addChoice', { entityId: E.slide, fieldId: F.slide.chart, choiceId, displayName: choiceId })),
    picture(E.slide, F.slide.image2, 'Picture 2'),
    picture(E.slide, F.slide.image3, 'Picture 3'),
    picture(E.slide, F.slide.image4, 'Picture 4'),
    node('dk.slide.page', F.slide.image2, 13), node('dk.slide.page', F.slide.image3, 14), node('dk.slide.page', F.slide.image4, 15),
  ];
}

/**
 * How a talk is shown: a slide's points one click at a time, its transition (or the deck's), the
 * seconds a rehearsal kept on it, and the deck's transition and target length in minutes.
 */
function presentOperations() {
  const node = (page, fieldId, position) => op('ui.addNode', { surfaceId: SURFACE, nodeId: `${page}.${fieldId}`, parentNodeId: page, kind: 'fieldBinding', position, properties: { fieldId } });
  return [
    choice(E.slide, F.slide.build, 'Points', BUILDS),
    choice(E.slide, F.slide.transition, 'Transition', SLIDE_TRANSITIONS),
    integer(E.slide, F.slide.seconds, 'Rehearsed seconds'),
    choice(E.deck, F.deck.transition, 'Transition', TRANSITIONS),
    integer(E.deck, F.deck.minutes, 'Talk length (minutes)'),
    node('dk.slide.page', F.slide.build, 10), node('dk.slide.page', F.slide.transition, 11), node('dk.slide.page', F.slide.seconds, 12),
    node('dk.deck.page', F.deck.transition, 11), node('dk.deck.page', F.deck.minutes, 12),
  ];
}

/**
 * A Template that names a Brand kit is a Design: the whole look one Brandkits export carries. Its
 * style and backgrounds are JSON (design.mjs), its background pictures media, its source the kit it
 * came from, so a second import updates it in place. The brand's mark is its small logo.
 */
function designOperations() {
  const fields = [
    choice(E.template, F.template.mode, 'Light or dark', MODES),
    long(E.template, F.template.style, 'Style'),
    long(E.template, F.template.backgrounds, 'Backgrounds'),
    text(E.template, F.template.chart, 'Chart colours'),
    choice(E.template, F.template.logoPlacement, 'Logo on content slides', Object.values(PLACEMENT_LABELS)),
    picture(E.template, F.template.titleImage, 'Title background'),
    picture(E.template, F.template.sectionImage, 'Section background'),
    picture(E.template, F.template.closingImage, 'Closing background'),
    picture(E.template, F.template.contentImage, 'Content background'),
    reference(E.template, F.template.brand, 'Brand kit'),
    bind(E.template, F.template.brand, E.brand, F.brand.name),
    text(E.template, F.template.source, 'Designed from'),
    picture(E.brand, F.brand.mark, 'Mark'),
  ];
  // The record pages show the new fields after the ones the screens stage placed there.
  const node = (page, fieldId, position) => op('ui.addNode', { surfaceId: SURFACE, nodeId: `${page}.${fieldId}`, parentNodeId: page, kind: 'fieldBinding', position, properties: { fieldId } });
  const templateFields = [F.template.brand, F.template.mode, F.template.logoPlacement, F.template.chart, F.template.titleImage, F.template.sectionImage,
    F.template.closingImage, F.template.contentImage, F.template.style, F.template.backgrounds, F.template.source];
  const screens = [...templateFields.map((fieldId, i) => node('dk.template.page', fieldId, 11 + i)), node('dk.brand.page', F.brand.mark, 15)];
  return [...fields, ...screens];
}

/** Whether the file can be searched: the search read answers, rather than refusing for want of an index. */
export async function hasSearchIndex(read) {
  try {
    await read.json('nendo://application/search?q=deck&limit=1');
    return true;
  } catch (error) {
    if (/SEARCH_INDEX_MISSING/.test(error?.message ?? '')) return false;
    throw error;
  }
}

// ---- Seeds: the six templates and the example deck. ----------------------------------------------

export const templateRecordId = id => `dk.template.${id}`;
const capital = word => word[0].toUpperCase() + word.slice(1);

/** The seed records in write order, as {entityId, recordId, values}: templates, the deck, its slides. */
export function seedRecords() {
  const records = TEMPLATES.map(t => ({ entityId: E.template, recordId: templateRecordId(t.id), values: {
    [F.template.name]: t.name, [F.template.family]: capital(t.id), [F.template.description]: t.description,
    [F.template.headingFont]: t.fonts.heading, [F.template.bodyFont]: t.fonts.body,
    [F.template.background]: t.colors.bg, [F.template.surface]: t.colors.surface, [F.template.ink]: t.colors.ink, [F.template.muted]: t.colors.muted,
    [F.template.primary]: t.colors.primary, [F.template.secondary]: t.colors.secondary, [F.template.accent]: t.colors.accent,
  } }));
  records.push({ entityId: E.deck, recordId: EXAMPLE_ID, values: {
    [F.deck.title]: EXAMPLE_DECK.title, [F.deck.subtitle]: EXAMPLE_DECK.subtitle, [F.deck.author]: EXAMPLE_DECK.author, [F.deck.date]: SEED_DATE,
    [F.deck.audience]: EXAMPLE_DECK.audience, [F.deck.goal]: EXAMPLE_DECK.goal, [F.deck.aspect]: '16:9', [F.deck.template]: templateRecordId('keynote'),
    [F.deck.footer]: EXAMPLE_DECK.footer, [F.deck.numbers]: true, [F.deck.status]: 'Ready',
  } });
  EXAMPLE_SLIDES.forEach((s, i) => records.push({ entityId: E.slide, recordId: exampleSlideId(s.n), values: {
    [F.slide.deck]: EXAMPLE_ID, [F.slide.order]: (i + 1) * 10, [F.slide.layout]: s.layout, [F.slide.hidden]: false,
    ...(s.title ? { [F.slide.title]: s.title } : {}), ...(s.kicker ? { [F.slide.kicker]: s.kicker } : {}), ...(s.body ? { [F.slide.body]: s.body } : {}),
    ...(s.body2 ? { [F.slide.body2]: s.body2 } : {}), ...(s.notes ? { [F.slide.notes]: s.notes } : {}), ...(s.chart ? { [F.slide.chart]: s.chart } : {}),
    ...(s.imageAlt ? { [F.slide.imageAlt]: s.imageAlt } : {}),
  } }));
  return records;
}

/**
 * What stops the person making a new file from this one, from describe's newFile: each kept record
 * that points at a record a new file leaves out, such as an example deck given a template of the
 * person's own. Nendo refuses File > New while there is one.
 */
export function newFileProblems(newFile) {
  return (newFile?.conflicts ?? []).map(c => `a new file keeps ${c.recordId} but leaves out ${c.targetRecordId}, which its ${c.fieldId} names: keep that one too, or point it at a kept one`);
}

export const exampleSlideId = n => `dk.slide.example-${String(n).padStart(2, '0')}`;

/**
 * The words in an older file's example slides that named seventeen layouts and four charts, by slide
 * number and field, with the words they held. The tour stage writes the seed's words over them only
 * where the file still holds these, so a slide the person has rewritten keeps their words.
 */
/** The example slides the tour adds: Title only, Picture grid, Process and Cycle. */
const TOUR_SLIDES = [17, 18, 19, 20];
/** Whether the tour has run on a file: it holds one of the tour's slides. */
export const tourRan = slides => slides.some(s => TOUR_SLIDES.map(exampleSlideId).includes(s.recordId));
const TOUR_WORDS = [
  [1, F.slide.body, 'Seventeen layouts, six templates, your brand'],
  [11, F.slide.body, '- 17 | layouts | from title to closing\n- 6 | templates | each with its own decorations\n- 2 | exports | HTML and PowerPoint'],
  [15, F.slide.title, 'This tour leans on text layouts'],
  [15, F.slide.body, '| Kind | Slides |\n| --- | --- |\n| Text | 6 |\n| Feature | 4 |\n| Data | 4 |\n| Picture | 2 |'],
  [15, F.slide.body2, 'A chart is a table in the body. Pick Column, Bar, Line or Doughnut.'],
  [15, F.slide.chart, 'Bar'],
];

/**
 * What brings an older file's example deck up to this one, given every slide the file holds and the
 * example deck. On a file that holds none of them, the TOUR_SLIDES slides are made, kept in new
 * files, and each placed just after the nearest slide before it in the seed that the deck still holds,
 * wherever the person has put that one; with no room there, it goes at the end. Once the file holds
 * one, a missing one is one the person deleted, and is not made again. An older example slide the person deleted stays
 * deleted, and one moved to another deck is theirs there. The slides already there keep their
 * places. A file without the example deck gets nothing. The old words of TOUR_WORDS take the seed's.
 * Nothing else is written: not the notes, the pictures, the order the person gave a slide, or a slide
 * of their own.
 */
export function tourOperations(slides, deck) {
  if (!deck) return [];
  // Once any of the tour's slides is in the file, a missing one is one the person deleted.
  const ran = tourRan(slides);
  slides = slides.filter(s => s.values[F.slide.deck] === EXAMPLE_ID);
  const held = new Map(slides.map(s => [s.recordId, s]));
  const seeds = seedRecords().filter(x => x.entityId === E.slide);
  const operations = [];
  const orders = new Map(seeds.filter(r => held.has(r.recordId)).map(r => [r.recordId, held.get(r.recordId).values[F.slide.order]]));
  const taken = slides.map(s => s.values[F.slide.order]).filter(Number.isInteger);
  seeds.forEach((r, k) => {
    if (ran || !TOUR_SLIDES.includes(Number(r.recordId.slice(-2)))) return;
    // Halfway from the slide it follows to the next slide in the deck, or ten past that slide when
    // nothing follows it; before every slide when it follows none.
    const before = seeds.slice(0, k).reverse().find(x => orders.has(x.recordId));
    const anchor = before ? orders.get(before.recordId) : null;
    const next = anchor === null ? Math.min(...taken) : Math.min(...taken.filter(o => o > anchor));
    let order = anchor === null ? (Number.isFinite(next) ? next - 10 : 10)
      : !Number.isFinite(next) ? anchor + 10 : next - anchor >= 2 ? Math.floor((anchor + next) / 2) : null;
    if (order === null) order = Math.max(...taken) + 10;
    orders.set(r.recordId, order); taken.push(order);
    operations.push(op('data.createRecord', { entityId: E.slide, recordId: r.recordId, values: { ...r.values, [F.slide.order]: order },
      expectedTargetVersions: { [F.slide.deck]: deck.recordVersion } }),
      op('data.setKeptInNewFiles', { entityId: E.slide, recordId: r.recordId, kept: true }));
  });
  const version = new Map(slides.map(s => [s.recordId, s.recordVersion]));
  for (const [n, fieldId, was] of TOUR_WORDS) {
    const slide = held.get(exampleSlideId(n));
    const value = seeds.find(r => r.recordId === exampleSlideId(n)).values[fieldId] ?? null;
    if (!slide || slide.values[fieldId] !== was || value === was) continue;
    operations.push(op('data.setField', { entityId: E.slide, recordId: slide.recordId, fieldId, expectedRecordVersion: version.get(slide.recordId), value }));
    version.set(slide.recordId, version.get(slide.recordId) + 1);
  }
  return operations;
}

const REFERENCES = { [E.template]: [], [E.deck]: [F.deck.template, F.deck.brand], [E.slide]: [F.slide.deck] };

export function seedOperations() {
  return seedRecords().map(r => op('data.createRecord', { entityId: r.entityId, recordId: r.recordId, values: r.values,
    expectedTargetVersions: Object.fromEntries(REFERENCES[r.entityId].filter(f => r.values[f] != null).map(f => [f, 1])) }));
}

// ---- What the fixture broker serves the view in tools/Review-Deck.ps1. -----------------------------

export function fixture({ seeds = true } = {}) {
  const schemaOps = [...STAGES.schema.mutations(), ...STAGES.design.mutations(), ...STAGES.present.mutations(), ...STAGES.layouts.mutations()].flatMap(m => m.operations);
  const entities = schemaOps.filter(o => o.operationType === 'schema.createEntity').map(o => ({ entityId: o.payload.entityId, displayName: o.payload.displayName, hierarchy: null, fields: [] }));
  const byId = Object.fromEntries(entities.map(e => [e.entityId, e]));
  for (const o of schemaOps) {
    if (o.operationType === 'schema.addField') {
      const p = o.payload;
      byId[p.entityId].fields.push({ fieldId: p.fieldId, displayName: p.displayName, storageKind: p.storageKind.toLowerCase(), required: p.required, presentation: p.presentation,
        calculated: false, choices: (p.options ?? []).map(id => ({ id, displayName: id, retired: false, tone: null })), reference: null, scale: null });
    }
    if (o.operationType === 'schema.addChoice') {
      byId[o.payload.entityId].fields.find(f => f.fieldId === o.payload.fieldId).choices.push({ id: o.payload.choiceId, displayName: o.payload.displayName, retired: false, tone: null });
    }
    if (o.operationType === 'schema.configureReference') {
      const f = byId[o.payload.entityId].fields.find(x => x.fieldId === o.payload.fieldId);
      f.reference = { targetEntityId: o.payload.targetEntityId, labelFieldId: o.payload.labelFieldId };
    }
  }
  for (const o of STAGES.colour.mutations().flatMap(m => m.operations)) {
    byId[o.payload.entityId].fields.find(f => f.fieldId === o.payload.fieldId).choices.find(c => c.id === o.payload.choiceId).tone = o.payload.tone;
  }
  const records = Object.fromEntries(entities.map(e => [e.entityId, []]));
  if (seeds) {
    for (const r of seedRecords()) records[r.entityId].push({ entityId: r.entityId, recordId: r.recordId, version: 1, values: r.values, labels: {}, exact: {}, calculated: {} });
  } else {
    for (const r of seedRecords().filter(x => x.entityId === E.template)) records[r.entityId].push({ entityId: r.entityId, recordId: r.recordId, version: 1, values: r.values, labels: {}, exact: {}, calculated: {} });
  }
  return {
    changeSequence: 1,
    schema: { entities, commands: [] },
    hierarchies: {},
    records,
    commandEffects: {},
    context: { viewId: VIEW_NODE, kind: 'extensionView', placement: 'screen', title: 'Deck', entityId: E.deck, recordId: null,
      bindings: { labelFieldId: null, statusFieldId: null, fields: [], filters: [] }, theme: 'light' },
  };
}

// ---- Packages: a folder's files as extension operations, in parts a call can carry. ---------------

/** The Deck skill as the file carries it: its manifest and its SKILL.md. */
export async function skillPackage() {
  const manifest = JSON.parse(await fs.readFile(path.join(SKILL_FOLDER, 'nendo-package.json'), 'utf8'));
  const skill = await fs.readFile(path.join(SKILL_FOLDER, 'SKILL.md'), 'utf8');
  return { manifest, skill };
}

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
  const setPackage = op('extension.setPackage', { packageId, title: manifest.title, entryPoint: manifest.entryPoint ?? 'index.html', version: manifest.version, description: manifest.description });
  return fileMutations(files, packageId, description, [setPackage]);
}

/** Each file as extension.putFile parts of 70 KiB, new to the package, in mutations a call can carry. */
export function fileMutations(files, packageId, description, operations = [], held = new Map()) {
  const partBytes = 70 * 1024;
  for (const file of files) {
    for (let offset = 0; offset === 0 || offset < file.bytes.length; offset += partBytes) {
      operations.push(op('extension.putFile', { packageId, path: file.path, base64: file.bytes.subarray(offset, offset + partBytes).toString('base64'),
        ...(offset === 0 ? { expectedSha256: held.get(file.path) ?? 'absent' } : { append: true }) }));
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
