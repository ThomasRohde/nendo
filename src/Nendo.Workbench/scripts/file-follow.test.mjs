import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// Catching the view up with the file, and the one thing that makes the loop terminate:
// the number being chased belongs to the file it was counted in.
const { followTarget, stillBehind } = await bundleOf('src/file-follow.ts');
const { clearFileScoped, boardColumns, matrixCells, rankedWindows, recentWindows, surfaceWindows, chartTables } =
  await bundleOf('src/app-state.ts');

test('a screen keeps reading until it has caught up with the file it is looking at', () => {
  const target = followTarget(null, 'session-a', 318);
  assert.ok(stillBehind(target, 'session-a', 300));
  assert.ok(!stillBehind(target, 'session-a', 318));
  assert.ok(!stillBehind(target, 'session-a', 319));

  // A later nudge about the same file raises the target; an earlier one does not lower it.
  assert.equal(followTarget(target, 'session-a', 400).changeSequence, 400);
  assert.equal(followTarget(target, 'session-a', 200).changeSequence, 318);
});

test('a target from another file is not something this one is behind', () => {
  // The defect this exists for. A change sequence counts one file's changes and starts at
  // zero in a new one, so a planner at 318 swapped for a reading log at 16 left the
  // renderer asking whether 16 was 318 yet -- no, once a second, for as long as the file
  // stayed open, redrawing every screen on each pass.
  const fromTheOldFile = followTarget(null, 'session-a', 318);
  assert.ok(!stillBehind(fromTheOldFile, 'session-b', 16));

  // And a nudge about the new file replaces the target rather than raising it, so the
  // old file's number cannot survive as a maximum either.
  const afterTheSwitch = followTarget(fromTheOldFile, 'session-b', 16);
  assert.equal(afterTheSwitch.changeSequence, 16);
  assert.equal(afterTheSwitch.fileSessionId, 'session-b');
  assert.ok(!stillBehind(afterTheSwitch, 'session-b', 16));
});

test('no target at all is nothing to chase', () => {
  assert.ok(!stillBehind(null, 'session-a', 0));
});

test('every cache that belongs to the open file is emptied when another one is opened', () => {
  // Listed by hand this rule was already missed four times: resetFileView cleared what
  // existed when it was written, and the matrix reads, the ranked and recent windows and
  // a reference board's columns each arrived afterwards. They register themselves now.
  for (const cache of [boardColumns, matrixCells, rankedWindows, recentWindows, surfaceWindows])
    cache.set('some-node', { state: 'ready' });
  chartTables.add('some-chart');

  clearFileScoped();

  for (const [name, cache] of Object.entries({ boardColumns, matrixCells, rankedWindows, recentWindows, surfaceWindows, chartTables }))
    assert.equal(cache.size, 0, `${name} kept the previous file's state`);
});

// WST-08. Studio's search text was a plain module-level map keyed by entity ID, so opening
// another file of the same lineage pre-filled and ran the previous file's search. The six caches
// above are named by hand; this finds every module-level Map or Set that starts empty and
// requires it to be emptied with the file, or to be named here with the reason it is not.
const notFileScoped = new Map([
  ['agent-context-model.ts:foldedNames', 'a memo of how a name folds, the same in every file'],
  ['surface-preview.ts:previewTabs', 'tabs of a read-only preview of a validated clone; nothing it selects reaches a file'],
  ['type-icons.ts:byWord', 'a constant table, filled once as the module loads'],
  ['view-agent-chat.ts:expanded', "the launched agent’s conversation, which is the window’s rather than the file’s (ADR-0030)"],
  ['view-agent-chat.ts:drawn', "the launched agent’s conversation, which is the window’s rather than the file’s (ADR-0030)"],
  ['view-frames.ts:mounts', 'live custom-view frames, keyed by mount IDs that never repeat and released as the page changes'],
  ['view-frames.ts:heldForReview', 'live custom-view frames, keyed by mount IDs that never repeat'],
  ['view-use.ts:waitingRetries', 'a read waiting for a save to end, which checks the screen and the file revision before it runs'],
]);

test('WST-08: every module-level cache that starts empty is emptied with the file, or says why not', () => {
  // The view API's folder too: what it keeps at module level lives in the same page.
  const sources = ['../src/', '../src/extension-api/'].flatMap((folder) => {
    const directory = new URL(folder, import.meta.url);
    return readdirSync(directory).filter((file) => file.endsWith('.ts')).map((file) => ({ name: folder === '../src/' ? file : `extension-api/${file}`, url: new URL(file, directory) }));
  });
  assert.ok(sources.some((source) => source.name.startsWith('extension-api/')), 'the scan reads no extension-api source');
  const unregistered = [];
  let found = 0;
  for (const { name, url } of sources) {
    const text = readFileSync(url, 'utf8');
    for (const match of text.matchAll(/^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)(?::[^=]+)? = new (?:Map|Set)(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\)/gm)) {
      found += 1;
      const cache = match[1];
      const registered = new RegExp(String.raw`fileScopedClearable\(\s*(?:${cache}\b|\{[\s\S]{0,200}?\b${cache}\.clear\(\))`).test(text);
      if (!registered && !notFileScoped.has(`${name}:${cache}`)) unregistered.push(`${name}:${cache}`);
    }
  }
  assert.ok(found >= 8, `found ${found} module-level caches; the scan reads nothing`);
  assert.deepEqual(unregistered, [], 'a module-level cache keeps the previous file’s state when another file opens');
});
