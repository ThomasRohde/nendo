// The Manuscript app: its schema, screens and starting records, as canonical operations
// for Build-Manus.mjs, and the fixture the browser lane runs the view against.
import { BLOCK, NOTE, LINK, PROFILE, F, KINDS, NOTE_KINDS, LINK_KINDS, REVIEW, GAP, ROLES, ALIGNMENTS, LISTS, TABLE_KINDS, OUTPUT_LAYOUTS, PAGE_SIZES, SPACINGS } from '../../extensions/manuscript/model.mjs';

export const PACKAGE_ID = 'org.nendo.manuscript';
export const VIEW_NODE = 'mn.screen.sheet';
const SURFACE = 'manuscript';
const op = (operationType, payload) => ({ operationType, payload });
const addField = (entityId, fieldId, displayName, storageKind, required = false, presentation = null, options = []) =>
  op('schema.addField', { entityId, fieldId, displayName, storageKind, required, presentation: storageKind === 'Text' ? presentation ?? 'singleLine' : null, options });

export const entities = [
  { id: BLOCK, name: 'Blocks', fields: [
    [F.text, 'Text', 'Text', false, 'markdown'],
    [F.kind, 'Kind', 'Text', true, 'singleChoice', KINDS],
    [F.parent, 'Inside', 'Reference'],
    [F.order, 'Order', 'Integer'],
    [F.role, 'Role', 'Text', false, 'singleChoice', ROLES],
    [F.align, 'Align', 'Text', false, 'singleChoice', ALIGNMENTS],
    [F.list, 'List', 'Text', false, 'singleChoice', LISTS],
    [F.level, 'Level', 'Integer'],
  ], refs: [[F.parent, BLOCK, F.text]] },
  { id: NOTE, name: 'Notes', fields: [
    [F.noteText, 'Note', 'Text', true, 'longText'],
    [F.noteKind, 'Kind', 'Text', true, 'singleChoice', NOTE_KINDS],
    [F.noteBlock, 'On', 'Reference', true],
    [F.noteDone, 'Done', 'Boolean'],
  ], refs: [[F.noteBlock, BLOCK, F.text]] },
  { id: LINK, name: 'Links', fields: [
    [F.linkKind, 'Kind', 'Text', true, 'singleChoice', LINK_KINDS],
    [F.linkFrom, 'From', 'Reference', true],
    [F.linkTo, 'To', 'Reference', true],
    [F.linkNote, 'Why', 'Text', false, 'longText'],
    [F.linkReview, 'Review', 'Text', false, 'singleChoice', Object.values(REVIEW)],
    [F.linkFromSeen, 'From, as reviewed', 'Text', false, 'longText'],
    [F.linkToSeen, 'To, as reviewed', 'Text', false, 'longText'],
  ], refs: [[F.linkFrom, BLOCK, F.text], [F.linkTo, BLOCK, F.text]] },
  { id: PROFILE, name: 'Output profiles', fields: [
    [F.profileRoot, 'Manuscript', 'Reference', true],
    [F.profileLayout, 'Layout', 'Text', true, 'singleChoice', OUTPUT_LAYOUTS],
    [F.profilePage, 'Page size', 'Text', false, 'singleChoice', PAGE_SIZES],
    [F.profileMargin, 'Margins (mm)', 'Integer'],
    [F.profileFont, 'Typeface', 'Text'],
    [F.profileSize, 'Size (points)', 'Integer'],
    [F.profileSpacing, 'Line spacing', 'Text', false, 'singleChoice', SPACINGS],
    [F.profileNumbers, 'Page numbers', 'Boolean'],
  ], refs: [[F.profileRoot, BLOCK, F.text]] },
];

export const PURPOSE = 'A manuscript, written as one continuous page and kept paragraph by paragraph. Every part, chapter, section and paragraph is a Block, one hierarchy in reading order, so each has one place and an identity that survives edits and moves. Notes and named links attach to blocks. The Manuscript view is where writing happens; Studio and the outline reach the same records.';

export function definitionOperations() {
  const ops = [op('application.setPurpose', { purpose: PURPOSE }), op('application.setNewFileLabel', { label: 'manuscript' })];
  for (const e of entities) {
    ops.push(op('schema.createEntity', { entityId: e.id, displayName: e.name }));
    for (const [fieldId, name, kind, required, presentation, options] of e.fields) ops.push(addField(e.id, fieldId, name, kind, required, presentation, options));
    for (const [fieldId, target, label] of e.refs) ops.push(op('schema.configureReference', { entityId: e.id, fieldId, targetEntityId: target, labelFieldId: label }));
  }
  ops.push(op('schema.declareHierarchy', { entityId: BLOCK, parentFieldId: F.parent, orderFieldId: F.order }));
  return ops;
}

/** The Role field alone, for a file built before roles (Manuscript 0.5.0). */
export function roleFieldOperations() { return fieldOperations(F.role); }

/** The Align field alone, for a file built before alignment (Manuscript 0.9.0). */
export function alignFieldOperations() { return fieldOperations(F.align); }

/** The List and Level fields, for a file built before lists (Manuscript 0.10.0). */
export function listFieldOperations() { return [...fieldOperations(F.list), ...fieldOperations(F.level)]; }

/** The Output profiles type, for a file built before 0.19.0. */
export function profileEntityOperations() {
  const e = entities.find(x => x.id === PROFILE);
  return [op('schema.createEntity', { entityId: e.id, displayName: e.name }),
    ...e.fields.map(([fieldId, name, kind, required, presentation, options]) => addField(e.id, fieldId, name, kind, required, presentation, options)),
    ...e.refs.map(([fieldId, target, label]) => op('schema.configureReference', { entityId: e.id, fieldId, targetEntityId: target, labelFieldId: label }))];
}

/** A link's two words-as-reviewed fields, for a file built before 0.18.0. */
export function linkSeenFieldOperations() {
  return entities[2].fields.filter(f => f[0] === F.linkFromSeen || f[0] === F.linkToSeen)
    .map(([fieldId, name, kind, required, presentation, options]) => addField(LINK, fieldId, name, kind, required, presentation, options));
}

/** Footnote added to an older file's Kind (Manuscript 0.17.0). */
export function footnoteKindOperations() {
  return [op('schema.addChoice', { entityId: BLOCK, fieldId: F.kind, choiceId: 'Footnote', displayName: 'Footnote' })];
}

/** Table, Row and Cell added to an older file's Kind, which needs a Nendo with schema.addChoice. */
export function tableKindOperations() {
  return TABLE_KINDS.map(choiceId => op('schema.addChoice', { entityId: BLOCK, fieldId: F.kind, choiceId, displayName: choiceId }));
}

function fieldOperations(id) {
  const [fieldId, name, kind, required, presentation, options] = entities[0].fields.find(f => f[0] === id);
  return [addField(BLOCK, fieldId, name, kind, required, presentation, options)];
}

export function screenOperations() {
  const ops = [];
  let position = 0;
  const node = (nodeId, kind, parentNodeId, properties, at = 0) => ops.push(op('ui.addNode', { surfaceId: SURFACE, nodeId, parentNodeId, kind, position: parentNodeId ? at : position++, properties }));
  node(VIEW_NODE, 'extensionView', null, { definitionVersion: 3, title: 'Manuscript', packageId: PACKAGE_ID, opensFile: true });
  node('mn.block.outline', 'outlineSurface', null, { definitionVersion: 3, entityId: BLOCK, title: 'Outline', titleFieldId: F.text, expandDepth: 2, reorder: true });
  node('mn.block.outline.kind', 'fieldBinding', 'mn.block.outline', { fieldId: F.kind }, 0);
  node('mn.note.list', 'recordList', null, { definitionVersion: 3, entityId: NOTE, title: 'Notes' });
  [F.noteText, F.noteKind, F.noteBlock, F.noteDone].forEach((fieldId, i) => node(`mn.note.list.${i}`, 'fieldBinding', 'mn.note.list', { fieldId }, i));
  node('mn.link.list', 'recordList', null, { definitionVersion: 3, entityId: LINK, title: 'Links' });
  [F.linkFrom, F.linkKind, F.linkTo, F.linkReview].forEach((fieldId, i) => node(`mn.link.list.${i}`, 'fieldBinding', 'mn.link.list', { fieldId }, i));
  return ops;
}

/** The starting manuscript: a title, one chapter with one empty paragraph, and the Cuttings. */
export const seed = [
  { recordId: 'b-root', values: { [F.kind]: 'Manuscript', [F.text]: 'Untitled manuscript', [F.parent]: null, [F.order]: GAP } },
  { recordId: 'b-chapter-1', values: { [F.kind]: 'Chapter', [F.text]: 'Chapter one', [F.parent]: 'b-root', [F.order]: GAP } },
  { recordId: 'b-first', values: { [F.kind]: 'Paragraph', [F.text]: null, [F.parent]: 'b-chapter-1', [F.order]: GAP } },
  { recordId: 'b-cuttings', values: { [F.kind]: 'Cuttings', [F.text]: 'Cuttings', [F.parent]: 'b-root', [F.order]: 1073741824 } },
];

export function seedOperations() {
  return seed.map(r => op('data.createRecord', { entityId: BLOCK, recordId: r.recordId, values: r.values,
    expectedTargetVersions: r.values[F.parent] ? { [F.parent]: 1 } : {} }));
}

// ---------- The browser lane's fixture ----------

const sample = [
  ['b-root', 'Manuscript', null, 'Low Water'],
  ['b-part-1', 'Part', 'b-root', 'Part One'],
  ['b-ch-3', 'Chapter', 'b-part-1', 'The Tide Table'],
  ['b-0413', 'Paragraph', 'b-ch-3', 'The tide table hung by the door where Agnes could not miss it, though she had stopped believing it the winter her father died.'],
  ['b-0414', 'Paragraph', 'b-ch-3', 'She took the ledger down from the shelf anyway. Forty years of entries in three hands.'],
  ['b-0415', 'Paragraph', 'b-ch-3', 'On the 9th of November 1953 someone had written a single line in pencil: *Boat seen beyond the bar. No lights. Did not report.*'],
  ['b-0416', 'Paragraph', 'b-ch-3', 'Agnes read it three times. Her grandfather had kept the light for twenty-two years and reported everything.'],
  ['b-ch-4', 'Chapter', 'b-part-1', 'What the Bar Keeps'],
  ['b-0501', 'Paragraph', 'b-ch-4', 'The causeway was dry by five.'],
  ['b-0502', 'Paragraph', 'b-ch-4', `![The causeway at low water](media:${'ab'.repeat(32)})`],
  ['b-cuttings', 'Cuttings', 'b-root', 'Cuttings'],
  ['b-root-2', 'Manuscript', null, 'Field Notes'],
  ['b-fn-1', 'Chapter', 'b-root-2', 'Spring'],
  ['b-fn-2', 'Paragraph', 'b-fn-1', 'The first swallows came back on the ninth.'],
];

export function fixture() {
  const orders = new Map();
  const blocks = sample.map(([recordId, kind, parent, text]) => {
    const key = parent ?? 'top';
    const order = kind === 'Cuttings' ? 1073741824 : (orders.get(key) ?? 0) + GAP;
    if (kind !== 'Cuttings') orders.set(key, order);
    return { entityId: BLOCK, recordId, version: 1, labels: {}, values: { [F.kind]: kind, [F.parent]: parent, [F.order]: order, [F.text]: text } };
  });
  const notes = [{ entityId: NOTE, recordId: 'n-1', version: 1, labels: {}, values: { [F.noteBlock]: 'b-0415', [F.noteKind]: 'Question', [F.noteText]: 'Whose hand wrote the pencil line?', [F.noteDone]: false } }];
  const links = [{ entityId: LINK, recordId: 'l-1', version: 1, labels: {}, values: { [F.linkFrom]: 'b-0415', [F.linkTo]: 'b-0501', [F.linkKind]: 'Foreshadows', [F.linkNote]: null, [F.linkReview]: REVIEW.current } }];
  const schema = { entities: entities.map(e => ({ entityId: e.id, displayName: e.name, hierarchy: e.id === BLOCK ? { parentFieldId: F.parent, orderFieldId: F.order } : null,
    fields: e.fields.map(([fieldId, displayName, kind, required = false, presentation = null, options = []]) => ({
      fieldId, displayName, storageKind: kind.toLowerCase(), required, presentation: kind === 'Text' ? presentation ?? 'singleLine' : null, calculated: false,
      choices: options.map(id => ({ id, displayName: id, retired: false, tone: null })),
      reference: e.refs.find(([f]) => f === fieldId) ? { targetEntityId: BLOCK, labelFieldId: F.text } : null, scale: null,
    })) })) };
  return {
    changeSequence: 1, schema,
    hierarchies: { [BLOCK]: { parentFieldId: F.parent, orderFieldId: F.order } },
    records: { [BLOCK]: blocks, [NOTE]: notes, [LINK]: links },
    context: { viewId: VIEW_NODE, kind: 'extensionView', placement: 'screen', title: 'Manuscript', entityId: null, recordId: null,
      bindings: { labelFieldId: null, statusFieldId: null, fields: [], filters: [] }, theme: 'light' },
  };
}
