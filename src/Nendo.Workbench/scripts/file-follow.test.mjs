import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Catching the view up with the file, and the one thing that makes the loop terminate:
// the number being chased belongs to the file it was counted in.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
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
