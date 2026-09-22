import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Adding and opening a record from a related list (ADR-0004, 2026-09-18 amendment).
//
// A related list showed the inverse of a reference and did nothing else, so recording a
// linked record meant leaving the page that already knew which record you meant, finding
// it again in a picker, and navigating back (F-031, and C-044 where the workaround was
// accepted so W-001 could close).
//
// What is asserted here is the markup, from the real functions the app draws with: the
// hooks the wiring and the gate click — data-related-add, data-related-open and
// data-related-entity — and the words beside them. The journey itself reads the shared
// `state`, which this bundle owns a private copy of, so it belongs to the gate.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { relatedHeadMarkup, relatedListEmpty, relatedListMarkup, relatedRowMarkup } = await bundleOf('src/record-markup.ts');

const node = (semanticId, kind, properties = {}, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const relation = node('rel.checks', 'relatedList', { title: 'Acceptance checks', targetEntityId: 'check', viaFieldId: 'check.work' },
  [node('bind.ref', 'fieldBinding', { fieldId: 'check.ref' })]);
const check = {
  entityId: 'check',
  displayName: 'Check',
  fields: [{ fieldId: 'check.work', displayName: 'Work item', storageKind: 0, required: true, presentation: null, options: [] }],
};
const record = { semanticId: 'w033', automationTarget: 'record-w033', version: 7, values: { title: 'W-033' }, referenceLabels: null, calculations: null };

test('a relation offers Add, named after the record type it makes and addressed by its own node', () => {
  const head = relatedHeadMarkup(relation, 'Acceptance checks', check, true);
  // The node is the hook, because a page carries several relations and the wiring has to
  // know which one was pressed.
  assert.match(head, /data-related-add="rel\.checks"/);
  // "Add" alone would not say which relation, on a page that has four of them.
  assert.match(head, /Add Check</);
  assert.match(head, /<h3>Acceptance checks<\/h3>/);
});

test('a relation whose record type has no screen says why instead of offering a button', () => {
  // A record created into a type Use cannot show would have nowhere to go after it was
  // saved. Leaving the button out with nothing said would make somebody work that out.
  const head = relatedHeadMarkup(relation, 'Acceptance checks', check, false);
  assert.ok(!head.includes('data-related-add'), 'there is nowhere for the new record to go');
  assert.match(head, /Check has no screen to add one on\./);
});

test('a relation naming a record type the session has not got offers nothing and guesses at no name', () => {
  const head = relatedHeadMarkup(relation, 'Acceptance checks', undefined, true);
  assert.equal(head, '<header class="related-head"><h3>Acceptance checks</h3></header>');
});

test('a row opens the record it names, and carries the record type the wiring navigates to', () => {
  const row = relatedRowMarkup(['C-044', 'Accepted exception'], 'c044', 'check', true);
  assert.match(row, /data-related-open="c044"/);
  assert.match(row, /data-related-entity="check"/);
  // The first bound field titles the row, so a screen reader hears what the eye reads.
  assert.match(row, /aria-label="Open C-044"/);
  assert.match(row, /<strong>C-044<\/strong>/);
  assert.match(row, /<span>Accepted exception<\/span>/);
});

test('a row with nowhere to open keeps exactly the row it had', () => {
  const row = relatedRowMarkup(['C-044', 'Accepted exception'], 'c044', 'check', false);
  assert.equal(row, '<li><strong>C-044</strong><span>Accepted exception</span></li>');
  // An unset value is a dash in both states, rather than an empty cell in one of them.
  assert.equal(relatedRowMarkup(['', ''], 'c044', 'check', false), '<li><strong>—</strong><span>—</span></li>');
  // With nothing to title it, the accessible label falls back to the stable ID rather
  // than to an empty string nobody can act on.
  assert.match(relatedRowMarkup(['', ''], 'c044', 'check', true), /aria-label="Open c044"/);
});

test('record values and record type names are escaped wherever the actions carry them', () => {
  const hostile = relatedRowMarkup(['<img src=x onerror=alert(1)>'], '"><script>', 'check', true);
  assert.ok(!hostile.includes('<img'), 'the tag must not survive into the row');
  assert.ok(!hostile.includes('<script'), 'nor into the attribute the wiring reads');

  const named = relatedHeadMarkup(relation, '<b>Checks</b>', { ...check, displayName: '<img src=x>' }, true);
  assert.ok(!named.includes('<img'), 'a record type name reaches the button label');
  assert.ok(!named.includes('<b>'), 'and the authored title reaches the heading');
});

test('the composed relation goes through the heading, so a fix that stops calling it fails here', () => {
  // This bundle has no open file, so there is no record type to name and no compiled
  // surface to reach: the heading is the one with no action, which is what proves the
  // list is built from it rather than from a copy of its markup.
  const markup = relatedListMarkup(relation, record);
  assert.match(markup, /data-related="rel\.checks"/);
  assert.match(markup, /<header class="related-head"><h3>Acceptance checks<\/h3><\/header>/);
  // A window read against another revision is not this relation's answer, so a relation
  // that has just been added to says it is loading rather than showing what it held.
  assert.match(markup, /Loading…/);
});

test('the sentence for an empty relation still states the inverse, and still states only that', () => {
  // W-042's wording is unchanged: the Add sits beside it rather than inside it, so the
  // sentence says what is missing and the button is the thing that is done about it.
  assert.equal(relatedListEmpty(relation, [check]), 'No Check records point at this one through Work item yet.');
  assert.ok(!/Add/.test(relatedListEmpty(relation, [check])));
});
