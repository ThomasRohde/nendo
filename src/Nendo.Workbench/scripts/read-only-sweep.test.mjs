import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// W-221. R2SMA-07: the read-only sweep disabled every input, select and textarea, so in a read-only
// or recovery session Use's filters, the record-type pickers on Structure and Screens and Show
// retired data were dead, though none of them writes the file. R2SMA-06 and R2SMA-10: which
// recovery actions Health and the File menu offer.
const controls = await bundleOf('src/read-controls.ts');
const quickFilter = await bundleOf('src/quick-filter-model.ts');
const recovery = await bundleOf('src/recovery-actions.ts');

// The sweep's selector, read from main.ts, applied to the real markup by a matcher for the forms
// it uses: a tag, an [attribute] or an #id, each followed by :not() of one of those.
const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
const selector = /const alwaysAvailable =\s*'([^']+)'/.exec(main)?.[1];
const simple = (element, part) => part.startsWith('#') ? element.id === part.slice(1)
  : part.startsWith('[') ? element.attributes.has(part.slice(1, -1)) : element.tag === part;
const compounds = (selector ?? '').split(',').map(text => {
  const match = /^\s*([a-z]+|\[[a-z-]+\]|#[a-z-]+)((?::not\([^)]+\))*)\s*$/.exec(text);
  assert.ok(match, `The sweep's selector has a form this test cannot read: ${text}`);
  return { base: match[1], not: [...match[2].matchAll(/:not\(([^)]+)\)/g)].map(item => item[1]) };
});
const elements = markup => [...markup.matchAll(/<(button|input|select|textarea)\b([^>]*)>/g)].map(([, tag, attributes]) => ({
  tag,
  id: /\bid="([^"]*)"/.exec(attributes)?.[1] ?? null,
  attributes: new Set([...attributes.matchAll(/(?:^|\s)([a-z-]+)(?==|\s|$)/g)].map(item => item[1])),
}));
const swept = element => compounds.some(compound => simple(element, compound.base) && !compound.not.some(part => simple(element, part)));

const status = { semanticId: 'status', automationTarget: 'status', displayName: 'Status', presentation: 'singleChoice', retired: false,
  required: false, storageKind: 'text', options: ['open'], choices: [{ id: 'open', displayName: 'Open', retired: false }] };

test('the read-only sweep leaves the controls that only read live', () => {
  assert.ok(selector, 'main.ts no longer declares the sweep as alwaysAvailable');
  const reads = [
    ...elements(controls.recordTypePicker('structure-entity', [{ value: 'tasks', label: 'Tasks', selected: true }])),
    ...elements(controls.recordTypePicker('surface-entity', [{ value: 'tasks', label: 'Tasks', selected: true }])),
    ...elements(controls.retiredDataToggle(false)),
    ...elements(quickFilter.quickFilterMenuMarkup([status], undefined, () => undefined, true, '')),
  ];
  assert.equal(reads.length, 4, 'every read control was found in its markup');
  for (const element of reads) assert.equal(swept(element), false, `${element.id ?? element.tag} is disabled in a read-only session`);
});

test('the read-only sweep still switches off edits', () => {
  const edits = elements('<button id="new-record" class="primary-button" data-action type="button">New</button><input id="field-title" type="text"><textarea id="notes"></textarea><select id="field-status"></select>');
  for (const element of edits) assert.equal(swept(element), true, `${element.id} stays live in a read-only session`);
  // A write control cannot opt out: data-reads exempts inputs and selects, never a data-action.
  for (const element of elements('<button id="save-record" data-action data-reads type="button">Save</button>'))
    assert.equal(swept(element), true, 'a data-action control marked data-reads stays live in a read-only session');
  for (const element of elements('<button id="approve-behaviour" data-action type="button"></button><button data-file-action="file.backup"></button>'))
    assert.equal(swept(element), false, `${element.id ?? 'a file action'} is a way out and was disabled`);
});

test('Inspect file again is offered only for a file that is not healthy', () => {
  assert.equal(recovery.offersReinspection({ fileName: 'a.nendo', health: 'normal' }), false,
    'a healthy file waiting for approval is offered a reinspection that reopens it read-only');
  assert.equal(recovery.offersReinspection({ fileName: 'a.nendo', health: 'readOnly' }), true);
  assert.equal(recovery.offersReinspection({ fileName: 'a.nendo', health: 'recoveryRequired' }), true);
  assert.equal(recovery.offersReinspection({ fileName: null, health: 'recoveryRequired' }), false);
});

test('Restore and Upgrade are not offered for a file marked read-only', () => {
  const backup = { backup: true };
  assert.equal(recovery.offersReplacement({ capabilities: backup, findings: [] }), true);
  assert.equal(recovery.offersReplacement({ capabilities: backup, findings: [{ code: 'file-read-only', message: '' }] }), false,
    'a file marked read-only is offered a replacement');
  assert.equal(recovery.offersReplacement({ capabilities: { backup: false }, findings: [] }), false);
});
