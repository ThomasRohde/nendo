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
const { linkEndsOf, relatedHeadMarkup, relatedListEmpty, relatedListMarkup, relatedRowMarkup } = await bundleOf('src/record-markup.ts');

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

// ADR-0004, 2026-09-29 (W-076): a related list whose record type is a link, a support
// joining a capability and an application, links an existing record at its other end and
// removes a link, from either side. What makes a type a link is read from the schema.
const support = {
  entityId: 'support',
  displayName: 'Support',
  fields: [
    { fieldId: 'support.capability', displayName: 'Capability', storageKind: 'Reference', required: true, presentation: null, options: [], reference: { targetEntityId: 'capability', labelFieldId: 'cap.name' } },
    { fieldId: 'support.application', displayName: 'Application', storageKind: 'Reference', required: true, presentation: null, options: [], reference: { targetEntityId: 'application', labelFieldId: 'app.name' } },
    { fieldId: 'support.role', displayName: 'Role', storageKind: 'Text', required: true, presentation: null, options: [] },
  ],
};
const entities = [support, { entityId: 'capability', displayName: 'Capability', fields: [] }, { entityId: 'application', displayName: 'Application', fields: [] }];
const supports = node('rel.supports', 'relatedList', { title: 'Supported by', targetEntityId: 'support', viaFieldId: 'support.capability' });
const ends = linkEndsOf(support, 'support.capability', entities);

test('a link type is read from the schema: both ends required', () => {
  assert.deepEqual(ends, [{ fieldId: 'support.application', targetEntityId: 'application', targetName: 'Application' }]);
  // From the other side, the other end is the capability.
  assert.deepEqual(linkEndsOf(support, 'support.application', entities).map((end) => end.targetName), ['Capability']);
  const with_ = (fieldId, change) => ({ ...support, fields: support.fields.map((field) => field.fieldId === fieldId ? { ...field, ...change } : field) });
  // A record that merely points somewhere else as well is not a link: its other reference is optional.
  assert.deepEqual(linkEndsOf(with_('support.application', { required: false }), 'support.capability', entities), []);
  // Nor is one whose reference back is optional.
  assert.deepEqual(linkEndsOf(with_('support.capability', { required: false }), 'support.capability', entities), []);
  // And a retired end is no end.
  assert.deepEqual(linkEndsOf(with_('support.application', { retired: true }), 'support.capability', entities), []);
});

test('a link list offers Link at its other end beside Add, addressed by node and field', () => {
  const head = relatedHeadMarkup(supports, 'Supported by', support, true, ends);
  assert.ok(head.includes('data-related-link="rel.supports" data-related-link-field="support.application">Link Application<'), head);
  assert.ok(head.includes('data-related-add="rel.supports"'), 'Add stays: a link can also be made from its own form');
  // With nowhere to show the link type, neither is offered.
  assert.ok(!relatedHeadMarkup(supports, 'Supported by', support, false, ends).includes('data-related-link='));
  // And a list that is not a link list offers no Link.
  assert.ok(!relatedHeadMarkup(relation, 'Acceptance checks', check, true).includes('data-related-link='));
});

test('a link row removes its link, carrying the version the delete is refused without', () => {
  const row = relatedRowMarkup(['Payments hub', 'Primary'], 'support-1', 'support', true, 3);
  assert.ok(row.startsWith('<li class="is-link">'), row);
  assert.ok(row.includes('data-related-unlink="support-1" data-related-entity="support" data-related-version="3"'), row);
  assert.ok(row.includes('aria-label="Remove the link Payments hub">Remove link<'), row);
  // A row of an ordinary list, or one with nowhere to open, keeps what it had.
  assert.ok(!relatedRowMarkup(['Payments hub'], 'support-1', 'support', true).includes('related-unlink'));
  assert.ok(!relatedRowMarkup(['Payments hub'], 'support-1', 'support', false, 3).includes('related-unlink'));
});

test('Link and Remove link are wired, and Link opens the picker of the record to link', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/related-actions.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("querySelectorAll<HTMLButtonElement>('[data-related-link]')"), 'Link is not wired');
  assert.ok(source.includes("querySelectorAll<HTMLButtonElement>('[data-related-unlink]')"), 'Remove link is not wired');
  assert.ok(source.includes('[data-reference-field="${CSS.escape(created.linkFieldId)}"] .reference-choose`)?.click()'),
    'Link does not open the picker of the record to link');
  assert.ok(source.includes("runMutation('data.deleteRecord'"), 'Remove link does not delete the link record');
});
