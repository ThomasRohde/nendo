import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/draft-state.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {decideDraftState,draftRetentionMessage} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const editable = { fileSessionId: 'session-1', canMutate: true };

test('an unchanged editable file leaves the draft alone', () => {
  assert.deepEqual(decideDraftState(editable, editable, true), { outcome: 'keep-editable', reason: 'unchanged' });
});

test('no unsaved input means the ordinary rebuild is free to happen', () => {
  assert.equal(decideDraftState(editable, { fileSessionId: 'session-2', canMutate: false }, false).outcome, 'discard');
});

test('a different file keeps the typing on screen and refuses to save it here', () => {
  // The same values typed against another file would land on whatever record now
  // happens to carry that ID, which is a data-loss bug wearing a rebuild's clothes.
  const state = decideDraftState(editable, { fileSessionId: 'session-2', canMutate: true }, true);
  assert.deepEqual(state, { outcome: 'retain-read-only', reason: 'file-changed' });
  assert.match(draftRetentionMessage(state.reason), /no longer the file you were editing/);
});

test('losing edit authority retains the draft without offering to save it', () => {
  const state = decideDraftState(editable, { fileSessionId: 'session-1', canMutate: false }, true);
  assert.deepEqual(state, { outcome: 'retain-read-only', reason: 'read-only' });
  assert.match(draftRetentionMessage(state.reason), /no longer editable/);
});

test('a session that could not be read is not treated as unchanged', () => {
  // Not knowing whether editing is still authorised is a reason to stop offering to
  // save, never a reason to assume it is.
  const state = decideDraftState(editable, null, true);
  assert.deepEqual(state, { outcome: 'retain-read-only', reason: 'session-unknown' });
  assert.match(draftRetentionMessage(state.reason), /could not check/);
});

test('a file closing under an open form is a file change, not an editable session', () => {
  assert.equal(decideDraftState(editable, { fileSessionId: null, canMutate: false }, true).reason, 'file-changed');
});

test('an unchanged decision carries no message to show', () => {
  assert.equal(draftRetentionMessage('unchanged'), '');
  assert.equal(draftRetentionMessage('no-draft'), '');
});
