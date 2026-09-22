import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Studio's own proposals travel the same canonical lane as an agent's: a change set of
// typed operations that the host validates on a clone. This bundles the real builders
// and reads the payloads they produce, because the host takes the operation exactly as
// built and a wrong field name is refused at validate time, after a rebuild and a
// reinstall, which is where the board rename hid for sixteen days (F-084).
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/studio.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { renameBoardProposal } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

test('renaming a board is one property set on the board root, addressed by its surface', () => {
  const payload = renameBoardProposal('surface.idea.board', 'node.idea.board.root', '  Receipt recovered ');
  assert.match(payload.proposalId, /^proposal-[0-9a-f]{32}$/);
  assert.equal(payload.title, 'Rename board to Receipt recovered');
  assert.equal(payload.mutations.length, 1);
  const [mutation] = payload.mutations;
  assert.equal(mutation.operations.length, 1);
  const [operation] = mutation.operations;
  assert.equal(operation.operationType, 'ui.setProperty');
  assert.deepEqual(operation.payload, {
    surfaceId: 'surface.idea.board',
    nodeId: 'node.idea.board.root',
    propertyName: 'title',
    value: 'Receipt recovered',
  });
});

test('a board title that is empty or over 120 characters is refused before it reaches the host', () => {
  assert.throws(() => renameBoardProposal('surface.x', 'node.x.root', '   '), /up to 120 characters/);
  assert.throws(() => renameBoardProposal('surface.x', 'node.x.root', 'x'.repeat(121)), /up to 120 characters/);
  assert.equal(renameBoardProposal('surface.x', 'node.x.root', 'x'.repeat(120)).mutations[0].operations[0].payload.value.length, 120);
});
