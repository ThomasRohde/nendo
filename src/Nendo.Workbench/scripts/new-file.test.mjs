import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

const bundle = await build({ configFile: false, logLevel: 'error',
  build: { ssr: 'src/new-file.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const newFile = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

// ADR-0022 (W-129). Studio says what a new file of the application keeps, and the File menu
// names a new file by the application's own label.
test('the File menu names a new file by the application label, or as an empty copy', () => {
  assert.equal(newFile.newFileMenuLabel('Archi model'), 'New Archi model…');
  assert.equal(newFile.newFileMenuLabel(null), 'New empty copy…');
  assert.equal(newFile.newFileMenuLabel(undefined), 'New empty copy…');
});

test('a cell reads a record’s own mark, or what its type gives it, and writes one of three', () => {
  assert.equal(newFile.keptText(false, true), 'Kept');
  assert.equal(newFile.keptText(true, false), 'Left out');
  assert.equal(newFile.keptText(true, null), 'Kept (type)');
  assert.equal(newFile.keptText(false, undefined), 'Left out (type)');
  for (const own of [true, false, null]) assert.equal(newFile.keptFromChoice(newFile.keptChoice(own)), own);
  assert.deepEqual([...newFile.keptChoices], ['Follows type', 'Kept', 'Left out']);
  assert.throws(() => newFile.keptFromChoice('maybe'), /Choose Kept, Left out or Follows type/);
});

test('turning a type’s default is one reviewed operation against the definition revision', () => {
  const proposal = newFile.keptDefaultProposal('ar.type', 'Concept types', true, 12);
  assert.match(proposal.proposalId, /^proposal-[0-9a-f]{32}$/);
  assert.equal(proposal.title, 'Keep Concept types records in new files');
  assert.equal(proposal.mutations.length, 1);
  const [operation] = proposal.mutations[0].operations;
  assert.equal(operation.operationType, 'schema.setKeptInNewFiles');
  assert.deepEqual(operation.payload, { entityId: 'ar.type', kept: true, expectedDefinitionRevision: 12 });
  assert.equal(newFile.keptDefaultProposal('x', 'Folders', false, 1).title, 'Leave Folders records out of new files');
  assert.match(newFile.keptDefaultSentence('Folders', false), /leaves Folders records out, unless a record says otherwise/);
});
