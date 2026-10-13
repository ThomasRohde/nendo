import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// WCS-01, WST-03. The journal settles a save only on a code it knows to be a complete
// refusal. value-not-unique was missing, so a duplicate in a unique field left the save
// pending for good and locked editing of the file on this device, while the tests pinned a
// hand-copied list and passed. Here the codes come from the Engine and the Desktop host
// themselves: each one must either settle the journal or be named below as not doing so.
const { isConfirmedRejection } = await bundleOf('src/pending-mutations.ts');
const { decideWriteFailure } = await bundleOf('src/write-failure.ts');

const repository = join(import.meta.dirname, '..', '..', '..');
function csharpFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return entry.name === 'bin' || entry.name === 'obj' ? [] : csharpFiles(join(directory, entry.name));
    return entry.name.endsWith('.cs') ? [join(directory, entry.name)] : [];
  });
}
// Raised directly, fully qualified, or through a member that builds one: `=> new("code", ...)`.
const raisedForms = [
  /new (?:Nendo\.Engine\.)?NendoPreconditionException\(\s*"([a-z0-9-]+)"/g,
  /NendoPreconditionException\s+\w+\([^)]*\)\s*=>\s*new\(\s*"([a-z0-9-]+)"/g,
];
const raised = new Set();
for (const project of ['Nendo.Engine', 'Nendo.Desktop']) {
  for (const file of csharpFiles(join(repository, 'src', project))) {
    const text = readFileSync(file, 'utf8');
    for (const form of raisedForms) for (const match of text.matchAll(form)) raised.add(match[1]);
  }
}
// A save an automatic action refused arrives with its calculation code, passed through as is.
const calculationCodes = [...readFileSync(join(repository, 'src', 'Nendo.Engine', 'Behaviour', 'BehaviourDiagnostics.cs'), 'utf8')
  .matchAll(/public const string \w+ = "(calculation-[a-z-]+)"/g)].map(match => match[1]);

// Families no journaled write raises: file actions, recovery, packages and views, agents,
// schema authoring, reads. A journaled write is data.createRecord/deleteRecord/moveRecord/
// setKeptInNewFiles/setField/setFields/executeCommand, history.compensate or proposal.promote.
const otherFamilies = ['agent-', 'aggregate-', 'backup-', 'copy-', 'csv-', 'export-', 'extension-', 'field-presentation-',
  'field-sequence-', 'field-unique-', 'history-fold-', 'identity-', 'link-rule-', 'new-file-', 'recent-file-', 'recovery-',
  'reference-conversion-', 'replacement-', 'restore-', 'search-', 'semantic-definition-', 'stale-csv-', 'upgrade-'];
// Single codes outside those families that the journal must not settle on, or that no
// journaled write raises.
const notSettled = new Set([
  // Unsettled: a session that ended, or a host that could not answer, says nothing about
  // whether the request landed. The journal keeps the exact request and looks for its receipt.
  'stale-file-session', 'recovery-required', 'no-file-open', 'file-action-busy', 'file-actions-unavailable',
  'workbench-unavailable', 'window-unavailable', 'data-unavailable', 'history-unavailable', 'proposal-unavailable',
  // data.moveRecord answers this after an exact retry of a move that committed: the receipt decides, never the draft.
  'move-receipt-unavailable',
  // Raised only for a view's own writes, which carry its actor and never enter the journal.
  'actor-not-allowed', 'views-off',
  // Raised only by other methods.
  'calculated-query-too-wide', 'definition-referenced', 'definition-revision-conflict', 'entity-exists',
  'field-not-retired', 'file-already-open', 'file-changed-before-open', 'hierarchy-already-declared', 'hierarchy-field-in-use',
  'idea-field-conflict', 'inspection-not-required', 'invalid-cursor', 'invalid-limit', 'location-confirmation-context',
  'open-assessment-unavailable', 'partial-export-confirmation', 'proposal-exists', 'proposal-file-missing', 'proposal-not-previewable',
  'proposal-waiting', 'reopen-to-verify', 'required-field-needs-migration', 'stale-cursor', 'state-too-large', 'state-version-conflict',
  'reference-label-in-use', 'title-unchanged', 'ui-node-not-found', 'ui-property-absent', 'unknown-method',
  // A read-only session's reads of package files and view state (W-221); a read-only session journals no write.
  'read-only-file-changed',
]);

test('every refusal the Engine or the host raises is classified for the save journal', () => {
  assert.ok(raised.size > 100, `read ${raised.size} codes; the scan found too few to be the real source`);
  assert.ok(raised.has('field-calculated'), 'a refusal built by a factory member is read too');
  const unclassified = [...raised].filter(code =>
    !isConfirmedRejection(code) && !notSettled.has(code) && !otherFamilies.some(prefix => code.startsWith(prefix)));
  assert.deepEqual(unclassified, [],
    'Each new refusal code either settles the journal (pending-mutations.ts) or is named here as not settling it');
});

test('every calculation refusal of a save settles the journal, since the whole save rolled back', () => {
  assert.ok(calculationCodes.length >= 10, `read ${calculationCodes.length} calculation codes`);
  assert.deepEqual(calculationCodes.filter(code => !isConfirmedRejection(code)), [],
    'Each calculation code the Engine defines settles the journal (pending-mutations.ts)');
});

test('a refusal raised inside the save before it committed keeps the draft and settles the journal', () => {
  for (const code of ['value-not-unique', 'field-values-not-unique', 'kept-in-new-files-unchanged', 'hierarchy-parent-invalid',
    'write-ceiling-rows', 'record-exists-or-invalid', 'behaviour-not-approved', 'field-calculated']) {
    assert.equal(isConfirmedRejection(code), true, code);
    assert.equal(decideWriteFailure(Object.assign(new Error('refused'), { code })), 'retain-draft', code);
  }
});

test('a code that says nothing about the outcome leaves the journal looking for a receipt', () => {
  for (const code of ['stale-file-session', 'recovery-required', 'workbench-unavailable', 'move-receipt-unavailable', '']) {
    assert.equal(isConfirmedRejection(code), false, code);
  }
});
