import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// History's "View changes" through the function view-history.ts draws it with. Help and the
// guides said History records which automatic action made each change; the opened entry drew
// only the operation and its class (2026-10-10).
const { operationDetailsMarkup } = await bundleOf('src/history-markup.ts');

const operation = (operationId, attribution = null) =>
  ({ operationId, operationType: 'data.setField', reversibility: 'reversible', canonicalJson: '{}', attribution });
const made = (triggerName) => ({
  triggerId: '10-stage', triggerName, actionId: 'project.close', actionName: 'Close a project when every task is done',
  stepId: '10-stage', eventKind: 1, eventEntityId: 'tasks', eventRecordId: 't2',
});

test('an operation an automatic action made names the action by its trigger; the author’s own names none', () => {
  const markup = operationDetailsMarkup([operation('edit-done'), operation('generated-1', made('Keep the project stage current'))]);
  const lines = [...markup.matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  assert.deepEqual(lines, [
    'Set field · Reversible',
    'Set field · Reversible · made by the automatic action “Keep the project stage current”',
  ]);
});

test('an action no longer in the file is still named, by the trigger ID the save recorded', () => {
  const markup = operationDetailsMarkup([operation('generated-1', made(null))]);
  assert.match(markup, /made by an automatic action no longer in this file \(10-stage\)/);
});

test('a trigger’s name is text, never markup', () => {
  const markup = operationDetailsMarkup([operation('generated-1', made('<b>Bold</b> & co'))]);
  assert.match(markup, /“&lt;b&gt;Bold&lt;\/b&gt; &amp; co”/);
});
