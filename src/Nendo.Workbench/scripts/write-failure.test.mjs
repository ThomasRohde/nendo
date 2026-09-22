import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/write-failure.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {decideWriteFailure,errorCode} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

class HostError extends Error {
  constructor(code, message = 'refused') { super(message); this.code = code; }
}

// The codes the journal settles on. A save refused for any of these left the file
// untouched, so the unsaved draft is still the newest copy of the user's intent.
const confirmed = ['validation','invalid-request','idempotency-conflict','record-version-conflict',
  'record-referenced','record-id-reserved','record-version-exhausted','deletion-state-conflict',
  'choice-retired','label-conflict','definition-version-conflict','entity-retired','field-retired',
  'entity-referenced','retired-binding','required-backfill-needed','target-version-required',
  'target-version-conflict','target-not-found','reference-unbound','entity-not-found',
  'field-not-found','record-not-found','command-unavailable','compensation-not-supported',
  'proposal-not-found'];

test('every confirmed refusal retains the draft', () => {
  for (const code of confirmed) {
    assert.equal(decideWriteFailure(new HostError(code)), 'retain-draft', code);
  }
});

test('an unsettled outcome refreshes the view instead of trusting the draft', () => {
  // The write may have landed; the view must be rebuilt from the host rather than
  // left showing input that could now conflict with a committed record version.
  for (const code of ['recovery-required','stale-file-session','stale-cursor','transport-failed','']) {
    assert.equal(decideWriteFailure(new HostError(code)), 'refresh-view', code || '(no code)');
  }
});

test('a failure carrying no host code is treated as unsettled', () => {
  assert.equal(decideWriteFailure(new Error('the bridge went away')), 'refresh-view');
  assert.equal(decideWriteFailure(undefined), 'refresh-view');
  assert.equal(decideWriteFailure(null), 'refresh-view');
  assert.equal(decideWriteFailure('validation'), 'refresh-view');
});

test('an unknown code is never mistaken for a confirmed refusal', () => {
  // A code this build does not recognise must not silently retain a draft over a
  // write that may have committed.
  assert.equal(decideWriteFailure(new HostError('some-future-code')), 'refresh-view');
});

test('errorCode reads the host code and tolerates anything else', () => {
  assert.equal(errorCode(new HostError('validation')), 'validation');
  assert.equal(errorCode({ code: 42 }), '42');
  assert.equal(errorCode(new Error('plain')), '');
  assert.equal(errorCode(null), '');
  assert.equal(errorCode('validation'), '');
});
