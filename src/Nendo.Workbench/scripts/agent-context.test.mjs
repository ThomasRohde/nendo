import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// W-200: @ in the agent tab's message box points the agent at the file's own things. The owner's
// "Add more books!" stalled because the agent did not know the record type's ID or fields; what
// the person points at carries them, and the menu stays cheap on a large file.
const { attachmentsMarkup, contextChoices, contextForHost, describeRecord, describeType, foldsSoFar, maximumDescriptionCharacters, mentionAt, mentionMenuMarkup, recordUri, withAttachment } =
  await bundleOf('src/agent-context-model.ts');

const hostile = '<img src=x onerror="alert(1)">';

function field(fieldId, name, more = {}) {
  return { fieldId, name, kind: 'Text', required: false, choices: [], scale: null, referenceTo: null, ...more };
}

const books = {
  entityId: 'books', name: 'Books', recordCount: null,
  fields: [
    field('books.title', 'Title', { required: true }),
    field('books.rating', 'Rating', { kind: 'Number', scale: { min: 1, max: 5 } }),
    field('books.status', 'Status', { kind: 'Choice', choices: [{ id: 'to-read', name: 'To read' }, { id: 'done', name: 'Read' }] }),
    field('books.author', 'Author', { kind: 'Reference', referenceTo: 'authors' }),
  ],
};
const authors = { entityId: 'authors', name: 'Authors', recordCount: null, fields: [field('authors.name', 'Name')] };

function source(more = {}) {
  return {
    fileName: 'Copilot.nendo',
    entities: [books, authors],
    views: [{ viewId: 'view.shelf', title: 'Bookshelf', kind: 'extensionView', entityId: 'books' }],
    proposals: [{ proposalId: 'proposal-1', title: 'Add a Genre field', operationCount: 3 }],
    places: [],
    ...more,
  };
}

test('an @ is found at the caret only where a word starts', () => {
  assert.deepEqual(mentionAt('Rate @bo', 8), { start: 5, query: 'bo' });
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('Rate @Books and', 11), { start: 5, query: 'Books' });
  assert.equal(mentionAt('mail me@example', 15), null, 'An address took the menu.');
  assert.equal(mentionAt('Rate @bo\nnext', 13), null, 'The menu followed past a line break.');
  assert.equal(mentionAt('Rate it', 7), null);
});

test('with nothing typed it offers the tabs, the record types, the views and what waits; fields and records need a word', () => {
  const places = [{ label: 'Books · Bookshelf', entityId: 'books', viewId: 'view.shelf', recordId: null, proposalId: null },
    { label: 'Dune', entityId: 'books', viewId: null, recordId: 'r-7', proposalId: null }];
  const choices = contextChoices(source({ places }), '', null);
  assert.deepEqual([...new Set(choices.map((choice) => choice.group))], ['Open in your tabs', 'Record types', 'Views', 'Waiting for you']);
  const record = choices.find((choice) => choice.key === 'screen:record:books:r-7');
  assert.equal(record.uri, recordUri('books', 'r-7'));
  assert.equal(record.uri, 'nendo://application/entity/books/records?recordId=r-7');
  assert.equal(choices.find((choice) => choice.kind === 'proposal').uri, 'nendo://application/proposal/proposal-1');
});

test('a word finds fields by name, records from the index, and a name that starts with it first', () => {
  const choices = contextChoices(source(), 'ra', [{ entityId: 'books', recordId: 'r-9', label: 'Rama' }]);
  assert.deepEqual(choices.filter((choice) => choice.group === 'Fields').map((choice) => choice.label), ['Books › Rating']);
  assert.deepEqual(choices.filter((choice) => choice.group === 'Records').map((choice) => [choice.label, choice.detail]), [['Rama', 'Books']]);
  const status = contextChoices(source(), 'read', null);
  assert.equal(status.filter((choice) => choice.group === 'Fields').length, 0, 'A choice option was taken for a field name.');
  assert.deepEqual(contextChoices(source(), 'author', null).map((choice) => choice.label), ['Authors', 'Books › Author']);
});

test('a record type goes with its ID and every field\'s ID, kind, choices and scale', () => {
  const text = describeType('Copilot.nendo', books);
  for (const part of ['entityId: `books`', 'fieldId `books.title`', 'required', 'fieldId `books.rating`', '1 to 5', 'To read (`to-read`)', 'refers to entityId `authors`',
    'nendo://application/entity/books/records', 'Read more through Nendo: nendo://application/entity/books']) {
    assert.ok(text.includes(part), `The description lacks ${part}:\n${text}`);
  }
});

test('a record goes with its IDs, its version and its values by field', () => {
  const text = describeRecord('Copilot.nendo', books, 'Dune', {
    entityId: 'books', recordId: 'r-7', recordVersion: 4,
    values: { 'books.title': 'Dune', 'books.status': 'to-read', 'books.author': 'a-1', 'books.extra': 'x' },
    referenceLabels: { 'books.author': 'Frank Herbert' },
  });
  for (const part of ['recordId: `r-7`', 'recordVersion 4', '- Title (`books.title`): Dune', '- Rating (`books.rating`): (empty)', '- Status (`books.status`): To read',
    '- Author (`books.author`): Frank Herbert (`a-1`)', '- `books.extra`: x', 'nendo://application/entity/books/records?recordId=r-7']) {
    assert.ok(text.includes(part), `The description lacks ${part}:\n${text}`);
  }
});

test('on a large file the menu stays capped and quick, and a description stays bounded', () => {
  // 2,000 record types of 60 fields: 120,000 field names to match on every keystroke.
  const entities = Array.from({ length: 2000 }, (_, index) => ({
    entityId: `t${index}`, name: `Type ${index}`, recordCount: null,
    fields: Array.from({ length: 60 }, (_, at) => field(`t${index}.f${at}`, `Field ${at} of ${index}`)),
  }));
  const big = source({ entities, views: Array.from({ length: 500 }, (_, index) => ({ viewId: `v${index}`, title: `View ${index}`, kind: 'extensionView', entityId: null })) });
  contextChoices(big, 'z', null); // The menu opening: every name is folded once here.
  // What made a keystroke slow was folding every name in the file again on every key: a tenth
  // of a second a key at this size. Counted, not timed, so a busy machine cannot make it pass or
  // fail; the time is printed for whoever reads the run.
  const queries = ['', 'f', 'fi', 'fie', 'field 1', 'type 19', 'of 1999', 'nothing like it'];
  const foldedBefore = foldsSoFar();
  const started = performance.now();
  for (const query of queries) {
    const choices = contextChoices(big, query, null);
    assert.ok(choices.length <= 30, `${choices.length} lines for "${query}"`);
  }
  const perKey = (performance.now() - started) / queries.length;
  const foldedPerKey = (foldsSoFar() - foldedBefore) / queries.length;
  console.log(`agent-context: ${perKey.toFixed(1)} ms and ${foldedPerKey} folds a keystroke on 120,000 fields`);
  assert.ok(foldedPerKey <= 8, `A keystroke folded ${foldedPerKey} names again on a file of 120,000 fields.`);
  const wide = { entityId: 'wide', name: 'Wide', recordCount: null, fields: Array.from({ length: 400 }, (_, at) => field(`wide.f${at}`, `A rather long field name number ${at}`)) };
  const text = describeType('Big.nendo', wide);
  assert.ok(text.length <= maximumDescriptionCharacters, `${text.length} characters`);
  assert.ok(text.includes('… and 340 more fields'), 'A wide record type was cut without saying so.');
});

test('nothing the file names becomes markup', () => {
  const evil = { entityId: hostile, name: hostile, recordCount: null, fields: [field(hostile, hostile)] };
  const choices = contextChoices(source({ entities: [evil], views: [{ viewId: hostile, title: hostile, kind: hostile, entityId: hostile }],
    proposals: [{ proposalId: hostile, title: hostile, operationCount: 1 }] }), '', [{ entityId: hostile, recordId: hostile, label: hostile }]);
  const markup = mentionMenuMarkup(choices, 0, hostile)
    + attachmentsMarkup([{ key: hostile, kind: 'type', label: hostile, uri: 'nendo://x', text: hostile }]);
  assert.doesNotMatch(markup, /<img/);
  assert.match(mentionMenuMarkup([], 0, null), /Nothing in this file has that name/);
});

// ACP-10 (review of 2026-10-10): the menu offered eight things of up to 6,000 characters each,
// and the host takes 32,000 together and 120 for a name: six large record types made a message
// that could not be sent at all, with nothing on screen saying why. The bounds below are the
// host's (AgentConversation.Context.cs).
const hostTotal = 32_000;
const hostTitle = 120;
const hostItems = 8;

function largeType(index) {
  const fields = Array.from({ length: 200 }, (_, at) => field(`t${index}.f${at}`, `A rather long field name number ${at} of type ${index} ${'that goes on and on '.repeat(5)}`));
  return { entityId: `t${index}`, name: `Type ${index}`, recordCount: null, fields };
}

test('ACP-10: what a message points at fits what the host takes, and keeps the address that reads the rest', () => {
  let attached = [];
  const refusals = [];
  for (let index = 0; index < 10; index++) {
    const text = describeType('Big.nendo', largeType(index));
    assert.equal(text.length, maximumDescriptionCharacters, 'The case this guards needs maximum-size descriptions.');
    const label = index === 0 ? 'L'.repeat(300) : `Type ${index}`;
    const added = withAttachment(attached, { key: `type:t${index}`, kind: 'type', label, uri: `nendo://application/entity/t${index}`, text });
    if (added.refused !== null) refusals.push(added.refused);
    attached = added.attached;
  }
  const sent = contextForHost(attached);
  assert.ok(sent.length <= hostItems, `${sent.length} things were sent; the host takes ${hostItems}.`);
  const total = sent.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(total <= hostTotal, `The descriptions came to ${total} characters; the host takes ${hostTotal} together, and refuses the message.`);
  assert.ok(sent.every((item) => item.title.length <= hostTitle && item.title.trim().length > 0), 'A name was longer than the host takes.');
  assert.ok(sent.every((item) => item.text.includes(`Read more through Nendo: ${item.uri}`)), 'A description cut to fit lost the address that reads the rest.');
  assert.ok(sent.length >= 5, `Only ${sent.length} large things fitted; cutting them should leave room for more.`);
  assert.ok(refusals.length > 0 && refusals.every((said) => /Stop pointing at|at most/.test(said)), 'A thing that did not fit was dropped without saying what to take back.');
});
