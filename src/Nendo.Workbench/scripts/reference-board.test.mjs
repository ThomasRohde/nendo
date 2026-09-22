import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// A board grouped by a reference (ADR-0004, 2026-09-17 amendment, S7): where the columns
// come from, what the surface's own clauses still remove from them, and the ceiling.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { boardViewOf, excludedLanesNote, maximumReferenceBoardColumns, referenceColumnsEmpty, referenceColumnsOverflow } =
  await bundleOf('src/surface-model.ts');
// The renderer itself, not a copy of its sentences. A board with no columns is drawn from
// the same function the app draws it with, so a fix that stops calling one of these
// sentences fails here rather than passing on the strength of the sentence still existing.
const { boardMarkup } = await bundleOf('src/surface-markup.ts');

const node = (semanticId, kind, properties, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const clause = (id, fieldId, operator, value) => node(id, 'filterClause', value === undefined ? { fieldId, operator } : { fieldId, operator, value });
const status = { semanticId: 'status', displayName: 'Status', storageKind: 'text', presentation: 'singleChoice', options: ['open', 'done'], choices: [] };
const client = {
  semanticId: 'client', displayName: 'Client', storageKind: 'reference', presentation: null, options: [], choices: [],
  reference: { targetEntityId: 'clientType', labelFieldId: 'clientName' },
};
const loose = { semanticId: 'loose', displayName: 'Unbound', storageKind: 'reference', presentation: null, options: [], choices: [] };
const fields = [status, client, loose];

test('a reference board takes its columns from the records it was given, not from the field', () => {
  const board = node('b', 'boardSurface', { groupByFieldId: 'client' });

  // The field carries no options, so a board that read them would have no columns at all
  // and every card would fall into Ungrouped -- which means "not set", and would be false
  // of every one of them.
  assert.deepEqual(boardViewOf(board, fields).groups, []);
  assert.deepEqual(boardViewOf(board, fields, ['c1', 'c2', 'c3']).groups, ['c1', 'c2', 'c3']);
  assert.deepEqual(boardViewOf(board, fields).reference, { targetEntityId: 'clientType', labelFieldId: 'clientName' });
});

test('a choice board is unchanged and names no reference', () => {
  const board = node('b', 'boardSurface', { groupByFieldId: 'status' });

  assert.deepEqual(boardViewOf(board, fields).groups, ['open', 'done']);
  assert.equal(boardViewOf(board, fields).reference, null);
  // Columns passed in are ignored where the definition already says what the lanes are.
  assert.deepEqual(boardViewOf(board, fields, ['c1']).groups, ['open', 'done']);
});

test("the board's own clauses remove a reference column as they remove an option", () => {
  // A board that declares "client is not Acme" and then draws an empty Acme lane says
  // something untrue about Acme, exactly as one that declares "status is not Done" does.
  const excluded = node('b', 'boardSurface', { groupByFieldId: 'client' }, [clause('c', 'client', 'ne', 'c2')]);
  assert.deepEqual(boardViewOf(excluded, fields, ['c1', 'c2', 'c3']).groups, ['c1', 'c3']);

  const only = node('b', 'boardSurface', { groupByFieldId: 'client' }, [clause('c', 'client', 'eq', 'c2')]);
  assert.deepEqual(boardViewOf(only, fields, ['c1', 'c2', 'c3']).groups, ['c2']);

  // A null test says nothing definite about which targets remain, so every lane stays.
  const present = node('b', 'boardSurface', { groupByFieldId: 'client' }, [clause('c', 'client', 'isNotNull')]);
  assert.deepEqual(boardViewOf(present, fields, ['c1', 'c2']).groups, ['c1', 'c2']);
});

test('an unbound reference names no target, so nothing tries to read columns for it', () => {
  const board = node('b', 'boardSurface', { groupByFieldId: 'loose' });

  // The compiler refuses this definition (NUI237); the renderer must not meanwhile decide
  // it is a choice board with no options, which would draw a column-less board rather than
  // the refusal.
  assert.equal(boardViewOf(board, fields).reference, null);
});

test('the renderer draws no more columns than the host publishes', () => {
  // The same number the Engine holds in NendoSemanticVocabulary.MaximumReferenceBoardColumns
  // and publishes at boards.maximumReferenceColumns. Two places hold it because the
  // renderer decides what to draw before a read of the vocabulary would have answered;
  // this is what stops them drifting apart unnoticed.
  assert.equal(maximumReferenceBoardColumns, 24);
});

test('the board says why it will not draw, in a sentence that reads', () => {
  const said = referenceColumnsOverflow('Author', 27, 24);

  // The defect this exists for. The count and the word "more" were alternatives in one
  // template, so the branch that knew the number lost the comparison and a person read
  // "holds 27 records than the 24 columns a board draws". Every gate step draws a board
  // that fits, so nothing had ever rendered this line.
  assert.ok(!/\d+ records than/.test(said), said);
  assert.ok(said.includes('holds 27 records, more than the 24 columns'), said);

  // It still names the record type, the count, the bound and what to do instead.
  assert.ok(said.includes('Author') && said.includes('27') && said.includes('24'), said);
  assert.ok(said.includes('not drawn at all'), said);

  // And it reads when the exact count could not be read, which is the case the first
  // version got right and the only one anyone had looked at.
  const unknown = referenceColumnsOverflow('Author', null, 24);
  assert.ok(unknown.includes('holds more records than the 24 columns'), unknown);
});

// The other end of the same range (W-042, F-060). The ceiling case above was written
// carefully and the zero case was not written at all: the board drew the Ungrouped lane,
// stated 0, and explained nothing -- while that lane told a person to move a card to a
// named column, on a board that had none.
const drawable = (semanticId, displayName, extra = {}) =>
  ({ semanticId, displayName, storageKind: 0, presentation: 'singleLine', required: false, retired: false, options: [], choices: [], ...extra });
const title = drawable('title', 'Title');
const stage = drawable('stage', 'Stage', {
  presentation: 'singleChoice', options: ['open', 'done'],
  choices: [{ id: 'open', displayName: 'Open', retired: false }, { id: 'done', displayName: 'Done', retired: false }],
});
const card = (semanticId, values) => ({ semanticId, automationTarget: semanticId, version: 1, values, referenceLabels: null, calculations: null });
const planOf = (surface, records) =>
  ({ entity: { semanticId: 'deal', displayName: 'Deal', fields: [title, stage], derivedFields: [] }, records, surfaces: [surface] });

test('a board with no columns does not tell a person to move a card into one', () => {
  // Every option excluded by the board's own clauses, which is the one way a choice board
  // reaches zero lanes -- the reference way needs a read, and the gate covers it.
  const emptied = node('b', 'boardSurface', { groupByFieldId: 'stage' }, [
    node('bind', 'fieldBinding', { fieldId: 'title' }),
    clause('c1', 'stage', 'ne', 'open'),
    clause('c2', 'stage', 'ne', 'done'),
  ]);
  const drawn = boardMarkup(planOf(emptied, [card('r1', { title: 'Acme', stage: null })]), emptied);

  // The defect, in the renderer's own output.
  assert.ok(!drawn.includes('Move a card to a named column'), drawn);
  assert.ok(drawn.includes('This board has no named column to move a card to.'), drawn);
  // And it still says which nothing it is, rather than leaving a nameless lane to stand
  // for a screen that might equally be broken.
  assert.ok(drawn.includes('excludes every Stage option'), drawn);
  // The cards are still there. Over the ceiling a board draws nothing, because there is
  // nothing to lose; at zero the Ungrouped lane is every record there is.
  assert.ok(drawn.includes('data-record-id="r1"'), drawn);
});

test('a board that still has columns keeps the instruction it can carry out', () => {
  const ordinary = node('b', 'boardSurface', { groupByFieldId: 'stage' }, [node('bind', 'fieldBinding', { fieldId: 'title' })]);
  const drawn = boardMarkup(planOf(ordinary, [card('r1', { title: 'Acme', stage: null })]), ordinary);

  assert.ok(drawn.includes('Move a card to a named column to assign it.'), drawn);
  assert.ok(!drawn.includes('no named column'), drawn);
  assert.ok(!drawn.includes('excludes every'), drawn);
});

test('at zero the board says the same kind of thing it says above the ceiling', () => {
  const said = referenceColumnsEmpty('Author', true);

  // The asymmetry F-060 is about: the ceiling sentence names the type, the count and the
  // bound, and this one named nothing because it did not exist.
  assert.ok(said.includes('Author') && said.includes('no columns'), said);
  assert.ok(said.includes('every record of that type would be one'), said);
  // The action has to be one the board's own screen can carry out. Showing and Add are
  // both on that toolbar; a type with no view of its own is not in Showing at all.
  assert.ok(said.includes('Choose Author under Showing'), said);
  assert.ok(referenceColumnsEmpty('Author', false).includes('made in Studio'), referenceColumnsEmpty('Author', false));
  assert.ok(!referenceColumnsEmpty('Author', false).includes('Showing'), referenceColumnsEmpty('Author', false));
});

test('an axis its own filter emptied says so, on either kind', () => {
  assert.equal(excludedLanesNote('Stage', 'columns'),
    "This board's own filter excludes every Stage option, so it has no columns. Remove a condition on Stage to bring its columns back.");
  assert.equal(excludedLanesNote('Horizon', 'rows'),
    "This grid's own filter excludes every Horizon option, so it has no rows. Remove a condition on Horizon to bring its rows back.");
});
