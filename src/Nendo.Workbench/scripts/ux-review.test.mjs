import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// UX copy, status and recovery.
const { activityLabel, counted, operationLabel } = await bundleOf('src/format.ts');
const { filterInput, filterInputMode, filterPlaceholder, studioFilter } = await bundleOf('src/filter-input.ts');
const { operationDetailsMarkup, operationSentence } = await bundleOf('src/history-markup.ts');

/** Every operation type the Engine records, read from its own source rather than kept beside it. */
function engineOperationTypes() {
  const root = new URL('../../Nendo.Engine/', import.meta.url);
  const types = new Set(['data.moveRecord']);
  const walk = (url) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, url));
      else if (entry.name.endsWith('.cs'))
        for (const [, type] of readFileSync(new URL(entry.name, url), 'utf8').matchAll(/OperationType => "([a-zA-Z.]+)"/g)) types.add(type);
    }
  };
  walk(root);
  return [...types];
}

test('every operation the Engine records has words of its own', () => {
  const types = engineOperationTypes();
  assert.ok(types.length >= 39, `only ${types.length} operation types were found; the scan measures nothing`);
  const raw = types.filter(type => operationLabel(type) === type);
  assert.deepEqual(raw, [], `History draws these as identifiers: ${raw.join(', ')}`);
});

const entities = [{ entityId: 'idea', displayName: 'Idea', fields: [{ fieldId: 'idea.notes', displayName: 'Notes' }, { fieldId: 'idea.title', displayName: 'Title' }] }];
const op = (operationType, payload, recordLabel = null) =>
  ({ operationId: 'o', operationType, reversibility: 'reversibleWithRetainedState', canonicalJson: JSON.stringify({ operationType, payload }), recordLabel });

test('an operation is named by its field, its record type and its record', () => {
  assert.equal(operationSentence(op('data.setField', { entityId: 'idea', recordId: 'r1', fieldId: 'idea.notes', value: 'x' }, 'A quieter weekly review'), entities),
    'Set field: Notes on Idea “A quieter weekly review”');
  assert.equal(operationSentence(op('data.deleteRecord', { entityId: 'idea', recordId: 'r2' }, 'Pocket field notes'), entities),
    'Delete record: Idea “Pocket field notes”');
  assert.equal(operationSentence(op('data.deleteRecord', { entityId: 'idea', recordId: 'r3' }), entities), 'Delete record: Idea');
  assert.equal(operationSentence(op('schema.renameField', { entityId: 'idea', fieldId: 'idea.title', displayName: 'Heading' }), entities), 'Rename field: Title on Idea');
  assert.equal(operationSentence({ ...op('ui.moveNode', {}), canonicalJson: 'not json' }, entities), 'Move on a screen');
  assert.match(operationDetailsMarkup([op('data.deleteRecord', { entityId: 'idea', recordId: 'r2' }, 'Pocket <b>notes</b>')], entities), /Pocket &lt;b&gt;notes&lt;\/b&gt;/);
});

test('Help does not say a custom view cannot change records', () => {
  const help = readFileSync(new URL('../src/help-concepts.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/help.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(help, /cannot change them/, 'Help says a custom view cannot change records, which it can');
  assert.doesNotMatch(help, /no plug-ins or scripts in a file/, 'Help says a file carries no scripts, though a custom view is code the file carries');
  assert.doesNotMatch(help, /The file never contains HTML, styling, scripts/, 'Help says the file never contains scripts');
});

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('History says Undo, and no class label says compensate', () => {
  const history = source('view-history.ts');
  assert.doesNotMatch(history, />Compensate</, 'History’s button still reads Compensate');
  assert.doesNotMatch(history, /No compensation offered|<span>Compensation<\/span>/, 'History still says compensation to a person');
});

test('a count of one reads in the singular', () => {
  assert.equal(counted(1, 'revision'), '1 revision');
  assert.equal(counted(2, 'revision'), '2 revisions');
  assert.equal(counted(1, 'proposed change'), '1 proposed change');
  for (const [file, pattern] of [['view-history.ts', /\} (revisions|operations)( shown| ·)/], ['view-agent.ts', /operationCount\} proposed changes/], ['view-surfaces.ts', /\} surfaces</]])
    assert.doesNotMatch(source(file), pattern, `${file} still appends a fixed plural`);
});

test('every tool the local MCP host registers reads as what happened', () => {
  const tools = new Set();
  const root = new URL('../../Nendo.LocalMcp/', import.meta.url);
  for (const entry of readdirSync(root)) if (entry.endsWith('.cs'))
    for (const [, name] of readFileSync(new URL(entry, root), 'utf8').matchAll(/"(nendo\.(?:data|change_set|lease|health)\.[a-z_]+)"/g)) tools.add(name);
  assert.ok(tools.size >= 20, `only ${tools.size} tools were found; the scan measures nothing`);
  const generic = [...tools].filter(name => ['Changed the file’s data', 'Agent activity'].includes(activityLabel({ category: 'mutation', name })));
  assert.deepEqual(generic, [], `these tools read only as a generic line: ${generic.join(', ')}`);
});

test('the Data filter takes Yes, No and a choice by its label', () => {
  const done = { fieldId: 'done', displayName: 'Done', storageKind: 'boolean', required: false, presentation: null, options: [] };
  assert.equal(filterInput(done, 'Yes'), 'true');
  assert.equal(filterInput(done, ' no '), 'false');
  const status = { fieldId: 's', displayName: 'Status', storageKind: 'text', required: false, presentation: 'singleChoice', options: ['doing'],
    choices: [{ id: 'doing', displayName: 'In progress', retired: false }] };
  assert.equal(filterInput(status, 'in progress'), 'doing');
  assert.equal(filterInput(status, 'other'), 'other');
  const renamed = { ...status, choices: [{ id: 'old', displayName: 'Done', retired: true }, { id: 'done', displayName: 'Done', retired: false }] };
  assert.equal(filterInput(renamed, 'Done'), 'done', 'a retired choice won over the available one of the same label');
});

test('the Data filter names the date form, and a plain date against a date and time is the start of that local day', () => {
  const held = { fieldId: 'held', displayName: 'Held on', storageKind: 4, required: false, presentation: null, options: [] };
  const at = { fieldId: 'at', displayName: 'At', storageKind: 5, required: false, presentation: null, options: [] };
  assert.equal(filterPlaceholder(held), 'YYYY-MM-DD');
  assert.equal(filterPlaceholder(at), 'YYYY-MM-DD');
  assert.equal(filterPlaceholder({ ...held, storageKind: 'boolean' }), 'Yes or No');
  assert.equal(filterPlaceholder({ ...held, storageKind: 0 }), '');
  const one = (operator, typed) => studioFilter(at, operator, typed);
  const start = one('ge', '2026-10-25').filters[0].value;
  assert.match(start, /^2026-10-25T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/, 'the host refuses an instant without its offset');
  assert.equal(new Date(start).getTime(), new Date(2026, 9, 25).getTime(), 'the instant is where this device\'s day begins');
  assert.equal(one('ge', '2026-10-25').phrase, 'is on or after 2026-10-25, this device\u2019s day');
  assert.equal(one('le', '2026-10-25').phrase, 'is at or before the start of 2026-10-25 here');
  // Equals is the whole local day, not the one instant at its midnight.
  const day = one('eq', '2026-10-25');
  assert.deepEqual(day.filters.map((filter) => filter.operator), ['ge', 'lt'], 'Equals with a date matched only local midnight');
  assert.equal(new Date(day.filters[0].value).getTime(), new Date(2026, 9, 25).getTime());
  assert.equal(new Date(day.filters[1].value).getTime(), new Date(2026, 9, 26).getTime());
  assert.equal(day.phrase, 'is on 2026-10-25, this device\u2019s day');
  assert.throws(() => one('ne', '2026-10-25'), /Less than or At least/, 'Does not equal a day needs an or, so it is refused with what works');
  assert.deepEqual(studioFilter({ ...at, storageKind: 'dateTime' }, 'eq', '2026-10-25').filters, day.filters);
  assert.deepEqual(one('eq', '2026-10-25T08:00:00+02:00'), { filters: [{ fieldId: 'at', operator: 'eq', value: '2026-10-25T08:00:00+02:00' }], phrase: null }, 'a full timestamp is left as typed');
  assert.equal(one('ge', '2026-02-30').filters[0].value, '2026-02-30', 'a day the calendar lacks is left for the host to refuse');
  assert.deepEqual(studioFilter(held, 'eq', ' 2026-10-25 ').filters, [{ fieldId: 'held', operator: 'eq', value: '2026-10-25' }], 'a Date keeps the date');
  assert.deepEqual(studioFilter(at, 'isNull', '').filters, [{ fieldId: 'at', operator: 'isNull' }]);
  assert.equal(filterInputMode({ ...held, storageKind: 1 }), 'numeric', 'a whole number gets no separator key');
  assert.equal(filterInputMode({ ...held, storageKind: 2 }), 'decimal');
  assert.equal(filterInputMode(held), '');
});

test('Use rows, cards and the inspector show no concurrency counter, and a picker no stored ID', () => {
  assert.doesNotMatch(source('surface-markup.ts'), /v\$\{record\.version\}/);
  assert.doesNotMatch(source('page-markup.ts'), /Record version/);
  assert.doesNotMatch(source('surface-markup.ts'), /<small><\/small><\/div>`/, 'the list head keeps a version column the rows no longer have');
  assert.doesNotMatch(source('surface-model.ts'), /\(\$\{node\.semanticId\}\)/);
  assert.doesNotMatch(source('view-frame-markup.ts'), /<span class="view-package">\$\{escapeHtml\(spec\.packageId\)\}/);
});

test('the delete question speaks in a person’s words', () => {
  const form = source('record-form.ts');
  const dialog = form.slice(form.indexOf("headingId: 'delete-record-heading'"), form.indexOf("confirmLabel: 'Delete record'"));
  assert.doesNotMatch(dialog, /schema|Incoming references|record\.semanticId/);
});

test('each Structure action names its field', () => {
  const structure = source('view-structure.ts');
  for (const attribute of ['data-retire-field', 'data-choice-field', 'data-require-field', 'data-unique-field', 'data-sequence-field']) {
    const button = structure.match(new RegExp(`<button[^>]*${attribute}[^>]*>`))?.[0] ?? '';
    assert.match(button, /aria-label="[^"]*\$\{escapeAttribute\(field\.displayName\)\}/, `${attribute} has no field in its accessible name`);
  }
});

test('the type default switch reads as a control', () => {
  const css = readFileSync(new URL('../src/styles/07-studio.css', import.meta.url), 'utf8');
  assert.match(css, /\.kept-default \.text-button \{[^}]*color: var\(--cobalt\)/);
});

test('the filter status names a chosen record by its label, not its ID', async () => {
  const { queryStatusText } = await bundleOf('src/studio-columns.ts');
  const status = queryStatusText({ fieldId: 'parent', operator: 'eq', text: 'Brand', sortFieldId: null, descending: false,
    filters: [{ fieldId: 'parent', operator: 'eq', value: 'cap-brand' }] }, () => 'Part of');
  assert.match(status, /Part of is Brand/);
  assert.doesNotMatch(status, /cap-brand/);
});
