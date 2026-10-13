import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bundleOf } from './bundle-of.mjs';

// The Workbench's half of two Desktop host findings from a broad review (W-216). The host's
// half of each is held by the Desktop tests.
const { takesDefaultDrop, textDropTargets } = await bundleOf('src/file-drop.ts');
const { hostTimeoutMs } = await bundleOf('src/host-desktop.ts');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

const at = matches => ({ closest: selector => (selector === textDropTargets && matches ? {} : null) });

test('DSH-02: only a text field keeps the browser drop, which navigates the window anywhere else', () => {
  assert.equal(takesDefaultDrop(at(true)), true, 'a text field lost the drop of text and addresses into it');
  assert.equal(takesDefaultDrop(at(false)), false, 'a link dropped on the page keeps the browser drop, which navigates');
  assert.equal(takesDefaultDrop(null), false);
  assert.equal(takesDefaultDrop({}), false, 'a target that is not an element keeps the browser drop');
  const selectors = textDropTargets.split(',').map(selector => selector.trim());
  for (const field of ['textarea', 'input:not([type])', 'input[type="text"]', 'input[type="search"]', '[contenteditable="true"]'])
    assert.ok(selectors.includes(field), `${field} lost the drop of text into it`);
  // A checkbox, a button or a file input is not a text field: the browser's drop there navigates.
  assert.ok(!selectors.includes('input'), 'every input keeps the browser drop, buttons and checkboxes included');
  for (const selector of selectors.filter(selector => selector.startsWith('input')))
    assert.doesNotMatch(selector, /checkbox|radio|button|submit|file|range|color/, `${selector} keeps the browser drop`);
});

test('DSH-02: every drag and drop the page did not take is stopped, after the file drop has had its say', () => {
  const fileDrop = main.indexOf("document.addEventListener('drop'");
  const catchAll = main.indexOf("for (const kind of ['dragover', 'drop'] as const)");
  assert.ok(fileDrop > 0 && catchAll > fileDrop, 'the page does not stop the drops it did not take, after the file drop');
  const body = main.slice(catchAll, main.indexOf('\n}\n', catchAll));
  assert.match(body, /if \(!event\.defaultPrevented && !takesDefaultDrop\(event\.target\)\) event\.preventDefault\(\);/);
});

test('DSH-04: a fold of history and a search-index build wait for the host however long the file makes them', () => {
  assert.equal(hostTimeoutMs('history.fold'), null, 'a fold on a large file is reported unanswered while it runs');
  assert.equal(hostTimeoutMs('data.buildSearchIndex'), null, 'an index build on a large file is reported unanswered while it runs');
  // A picker is the person's wait, as before.
  for (const method of ['session.openFile', 'session.createFile', 'file.backup', 'extension.import']) assert.equal(hostTimeoutMs(method), null, method);
  // Everything else is still told when the host has stopped answering.
  for (const method of ['session.getSnapshot', 'data.queryRecords', 'history.foldPreview', 'data.searchRecords']) assert.equal(hostTimeoutMs(method), 15_000, method);
});
