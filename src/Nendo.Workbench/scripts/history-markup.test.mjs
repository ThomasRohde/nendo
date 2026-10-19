import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// History's "View changes" through the function view-history.ts draws it with. Help and the
// guides say History records which automatic action made each change, so the opened entry
// names it beside the operation and its class.
const { operationDetailsMarkup } = await bundleOf('src/history-markup.ts');

const operation = (operationId, attribution = null) =>
  ({ operationId, operationType: 'data.setField', reversibility: 'reversible', canonicalJson: '{}', attribution });
const made = (triggerName) => ({
  triggerId: '10-stage', triggerName, actionId: 'project.close', actionName: 'Close a project when every task is done',
  stepId: '10-stage', eventKind: 1, eventEntityId: 'tasks', eventRecordId: 't2',
});

test('an operation an automatic action made names the action by its trigger; the author’s own names none', () => {
  // A save's revision, which History offers to undo; one it does not offer says so (studio-review.test.mjs).
  const markup = operationDetailsMarkup([operation('edit-done'), operation('generated-1', made('Keep the project stage current'))], [], true);
  const lines = [...markup.matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  assert.deepEqual(lines, [
    'Set field · Can be undone',
    'Set field · Can be undone · made by the automatic action “Keep the project stage current”',
  ]);
});

test('a created or restored record reads as History undoes it, not as cannot be undone', () => {
  const both = [
    { operationId: 'c', operationType: 'data.createRecord', reversibility: 'irreversibleDeclared', canonicalJson: '{}' },
    { operationId: 'r', operationType: 'data.restoreDeletedRecord', reversibility: 'irreversibleDeclared', canonicalJson: '{}' },
  ];
  const withheld = [...operationDetailsMarkup(both, [], false).matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1]);
  assert.deepEqual(withheld, ['Add record · Cannot be undone', 'Restore deleted record · Cannot be undone'],
    'An entry History does not offer to undo says it is undone by deleting the record.');
  const markup = operationDetailsMarkup(both, [], true);
  const lines = [...markup.matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1]);
  assert.deepEqual(lines, [
    'Add record · Undone by deleting the record; its ID stays reserved',
    'Restore deleted record · Undone by deleting the record; its ID stays reserved',
  ], 'History labels an operation it undoes as one that cannot be undone.');
});

test('an action no longer in the file is still named, by the trigger ID the save recorded', () => {
  const markup = operationDetailsMarkup([operation('generated-1', made(null))]);
  assert.match(markup, /made by an automatic action no longer in this file \(10-stage\)/);
});

test('a trigger’s name is text, never markup', () => {
  const markup = operationDetailsMarkup([operation('generated-1', made('<b>Bold</b> & co'))]);
  assert.match(markup, /“&lt;b&gt;Bold&lt;\/b&gt; &amp; co”/);
});
