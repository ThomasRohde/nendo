import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0030: the conversation with a launched agent. Reads carry only what changed and are merged
// by entry; everything an agent or a tool says is drawn as text, never as markup.
const { composerState, emptyChat, entryMarkup, mergeChat, orderedEntries, stateLabel } = await bundleOf('src/agent-chat-model.ts');

const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function entry(fields) {
  return { id: 'e1', order: 1, revision: 1, kind: 'agent', text: '', title: null, toolKind: null, status: null, input: null, options: null, answer: null, plan: null, ...fields };
}

function view(fields) {
  return {
    exists: true, agentId: 'copilot', name: 'GitHub Copilot CLI', commandLine: 'copilot --acp', endpoint: 'http://127.0.0.1:41763/mcp',
    level: 'Edit data', state: 'ready', working: false, notice: null, agentTitle: null, revision: 1, entries: [], more: false, signInMethods: [], ...fields,
  };
}

test('a read updates entries in place and a late read changes nothing', () => {
  const chat = emptyChat();
  assert.deepEqual(mergeChat(chat, view({ revision: 2, entries: [entry({ id: 'e1', text: 'You said: ', revision: 2 })] }), 'k'), ['e1']);
  assert.deepEqual(mergeChat(chat, view({ revision: 3, entries: [entry({ id: 'e1', text: 'You said: hello', revision: 3 }), entry({ id: 'e2', order: 2, kind: 'notice', text: 'Stopped.', revision: 3 })] }), 'k'), ['e1', 'e2']);
  assert.equal(chat.entries.get('e1').text, 'You said: hello');
  // An answer that was overtaken by a newer read leaves the newer one standing.
  assert.deepEqual(mergeChat(chat, view({ revision: 2, entries: [entry({ id: 'e1', text: 'You said: ', revision: 2 })] }), 'k'), []);
  assert.equal(chat.entries.get('e1').text, 'You said: hello');
  assert.deepEqual(orderedEntries(chat).map((item) => item.id), ['e1', 'e2']);
});

test('a new launch starts the conversation again', () => {
  const chat = emptyChat();
  mergeChat(chat, view({ revision: 9, entries: [entry({ id: 'e1', revision: 9, text: 'old' })] }), 'first');
  mergeChat(chat, view({ revision: 1, entries: [entry({ id: 'e1', revision: 1, text: 'new' })] }), 'second');
  assert.equal(chat.revision, 1);
  assert.equal(chat.entries.get('e1').text, 'new');
});

test('nothing an agent or a tool says becomes markup', () => {
  const kinds = [
    entry({ kind: 'you', text: hostile }),
    entry({ kind: 'agent', text: hostile }),
    entry({ kind: 'thought', text: hostile }),
    entry({ kind: 'tool', title: hostile, text: hostile, input: hostile, status: hostile }),
    entry({ kind: 'plan', plan: [{ text: hostile, status: hostile }] }),
    entry({ kind: 'permission', title: hostile, input: hostile, options: [{ optionId: hostile, name: hostile, kind: 'allow_once' }] }),
    entry({ kind: 'notice', text: hostile }),
  ];
  for (const item of kinds) {
    const markup = entryMarkup(item, hostile);
    assert.doesNotMatch(markup, /<img|<script/i, `${item.kind} drew the agent's text as markup`);
    assert.match(markup, /&lt;img|&lt;script/, `${item.kind} did not show the agent's text at all`);
  }
});

test('a permission request offers the agent its own options until it is answered', () => {
  const asking = entryMarkup(entry({ kind: 'permission', title: 'Write the record', options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] }), 'Agent');
  assert.match(asking, /data-option-id="allow"/);
  assert.match(asking, /data-option-id="reject"/);
  const answered = entryMarkup(entry({ kind: 'permission', title: 'Write the record', answer: 'Reject', options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }), 'Agent');
  assert.doesNotMatch(answered, /data-option-id/);
  assert.match(answered, /You answered: Reject/);
});

test('the composer sends only to a ready agent and stops only a working one', () => {
  const chat = emptyChat();
  mergeChat(chat, view({ state: 'starting' }), 'k');
  assert.deepEqual([composerState(chat).canSend, composerState(chat).canStop], [false, false]);
  mergeChat(chat, view({ state: 'ready', revision: 2 }), 'k');
  assert.deepEqual([composerState(chat).canSend, composerState(chat).canStop], [true, false]);
  mergeChat(chat, view({ state: 'ready', working: true, revision: 3 }), 'k');
  assert.deepEqual([composerState(chat).canSend, composerState(chat).canStop], [false, true]);
  assert.equal(stateLabel(chat), 'Working');
  mergeChat(chat, view({ state: 'ended', revision: 4 }), 'k');
  assert.equal(composerState(chat).canSend, false);
  assert.match(composerState(chat).placeholder, /Launch the agent again/);
});
