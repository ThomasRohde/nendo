import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0030: the conversation with a launched agent, drawn as the owner's direction A (2026-10-08).
// Reads carry only what changed and are merged by entry; a run of steps folds into one line;
// everything an agent or a tool says is drawn as text, never as markup; and the agent's own
// options are drawn as it offers them.
const { chatActivity, chatTabStatus, composerState, emptyChat, itemMarkup, mergeChat, optionsMarkup, partitionOptions, reviewHint, stateLabel, stepsSummary, threadItems } =
  await bundleOf('src/agent-chat-model.ts');

const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function entry(fields) {
  return { id: 'e1', order: 1, revision: 1, kind: 'agent', text: '', title: null, toolKind: null, status: null, input: null, options: null, answer: null, plan: null, origin: null, ...fields };
}

function view(fields) {
  return {
    exists: true, agentId: 'copilot', name: 'GitHub Copilot CLI', commandLine: 'copilot --acp', endpoint: 'http://127.0.0.1:41763/mcp',
    level: 'Edit data', state: 'ready', working: false, notice: null, agentTitle: null, revision: 1, entries: [], more: false, signInMethods: [], options: [], ...fields,
  };
}

function option(fields) {
  return { id: 'model', name: 'Model', description: null, category: 'model', currentValue: 'b', values: [
    { value: 'a', name: 'Alpha', description: null, group: null }, { value: 'b', name: 'Beta', description: null, group: null }], ...fields };
}

test('a read updates entries in place and a late read changes nothing', () => {
  const chat = emptyChat();
  assert.deepEqual(mergeChat(chat, view({ revision: 2, entries: [entry({ id: 'e1', text: 'You said: ', revision: 2 })] }), 'k'), ['e1']);
  mergeChat(chat, view({ revision: 3, entries: [entry({ id: 'e1', text: 'You said: hello', revision: 3 })] }), 'k');
  assert.deepEqual(mergeChat(chat, view({ revision: 2, entries: [entry({ id: 'e1', text: 'You said: ', revision: 2 })] }), 'k'), []);
  assert.equal(chat.entries.get('e1').text, 'You said: hello');
});

test('a new launch starts the conversation again', () => {
  const chat = emptyChat();
  mergeChat(chat, view({ revision: 9, entries: [entry({ id: 'e1', revision: 9, text: 'old' })] }), 'first');
  mergeChat(chat, view({ revision: 1, entries: [entry({ id: 'e1', revision: 1, text: 'new' })] }), 'second');
  assert.equal(chat.revision, 1);
  assert.equal(chat.entries.get('e1').text, 'new');
});

test('the steps between two messages fold into one item, and a message or a question ends the run', () => {
  const chat = emptyChat();
  mergeChat(chat, view({ entries: [
    entry({ id: 'e1', order: 1, kind: 'you', text: 'Add due dates' }),
    entry({ id: 'e2', order: 2, kind: 'thought', text: 'Hmm' }),
    entry({ id: 'e3', order: 3, kind: 'tool', title: 'nendo-nendo-read-resource', status: 'completed', origin: 'nendo' }),
    entry({ id: 'e4', order: 4, kind: 'plan', plan: [{ text: 'Read Tasks', status: 'completed' }, { text: 'Propose a Due field', status: 'in_progress' }] }),
    entry({ id: 'e5', order: 5, kind: 'tool', title: 'Read its saved output', status: 'completed', origin: 'agent' }),
    entry({ id: 'e6', order: 6, kind: 'permission', title: 'Add operations', options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] }),
    entry({ id: 'e7', order: 7, kind: 'tool', title: 'nendo-nendo-change_set-add_operations', status: 'in_progress', origin: 'nendo' }),
    entry({ id: 'e8', order: 8, kind: 'agent', text: 'Proposed.' }),
  ] }), 'k');
  const items = threadItems(chat);
  assert.deepEqual(items.map((item) => `${item.type}:${item.key}`), ['you:e1', 'steps:g-e2', 'permission:e6', 'steps:g-e7', 'agent:e8']);
  assert.equal(stepsSummary(items[1].entries), 'Propose a Due field · 2 steps', 'The fold does not say what the agent is on.');
  const folded = itemMarkup(items[1], 'Copilot', new Set());
  assert.doesNotMatch(folded, /chat-steps-list/, 'A run of steps opened by itself.');
  const opened = itemMarkup(items[1], 'Copilot', new Set(['g-e2']));
  assert.match(opened, /chat-steps-list/);
  assert.match(opened, /<span class="chat-tag">Nendo<\/span>/);
  assert.match(opened, /Its own tool/, 'The agent\'s own tool is not told apart from Nendo\'s.');
  assert.match(itemMarkup(items[3], 'Copilot', new Set()), /is-running/);
  assert.equal(stateLabel(chat), 'Waiting for you');
});

test('nothing an agent or a tool says becomes markup', () => {
  const kinds = [
    { key: 'e1', type: 'you', entry: entry({ kind: 'you', text: hostile }) },
    { key: 'e1', type: 'agent', entry: entry({ kind: 'agent', text: hostile }) },
    { key: 'e1', type: 'notice', entry: entry({ kind: 'notice', text: hostile }) },
    { key: 'e1', type: 'permission', entry: entry({ kind: 'permission', title: hostile, input: hostile, origin: 'agent', options: [{ optionId: hostile, name: hostile, kind: 'allow_once' }] }) },
    { key: 'g-e1', type: 'steps', entries: [
      entry({ kind: 'thought', text: hostile }),
      entry({ id: 'e2', kind: 'tool', title: hostile, text: hostile, input: hostile, status: hostile }),
      entry({ id: 'e3', kind: 'plan', plan: [{ text: hostile, status: hostile }] })] },
  ];
  for (const item of kinds) {
    const markup = itemMarkup(item, hostile, new Set(['e1', 'g-e1']));
    assert.doesNotMatch(markup, /<img|<script/i, `${item.type} drew the agent's text as markup`);
    assert.match(markup, /&lt;img|&lt;script/, `${item.type} did not show the agent's text at all`);
  }
});

test('a permission request leads with Allow once, keeps Always quiet, and shows its input only when asked', () => {
  const asking = { key: 'e1', type: 'permission', entry: entry({ kind: 'permission', title: 'Write the record', input: '{"record":"r1"}', options: [
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }, { optionId: 'once', name: 'Allow once', kind: 'allow_once' }] }) };
  const closed = itemMarkup(asking, 'Copilot', new Set());
  assert.deepEqual([...closed.matchAll(/data-option-id="([^"]+)"/g)].map((match) => match[1]), ['once', 'deny', 'always']);
  assert.match(closed, /class="primary-button"[^>]*data-option-id="once"/);
  assert.match(closed, /class="text-button"[^>]*data-option-id="always"/);
  assert.doesNotMatch(closed, /"record":"r1"|&quot;record&quot;/, 'The input showed before it was asked for.');
  assert.match(itemMarkup(asking, 'Copilot', new Set(['e1'])), /&quot;record&quot;:&quot;r1&quot;/);
  const answered = itemMarkup({ ...asking, entry: { ...asking.entry, answer: 'Deny' } }, 'Copilot', new Set());
  assert.doesNotMatch(answered, /data-option-id/);
  assert.match(answered, /you chose Deny/);
});

test('the agent\'s options: model, effort and mode in the composer, the rest under More, as it offers them', () => {
  const options = [
    option({ id: 'mode', name: 'Mode', category: 'mode', currentValue: 'agent', values: [{ value: 'agent', name: 'Agent', description: null, group: null }] }),
    option({ values: [{ value: 'a', name: 'Alpha', description: null, group: 'Fast' }, { value: 'b', name: 'Beta', description: null, group: 'Smart' }] }),
    option({ id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', currentValue: 'max', values: [{ value: 'max', name: 'Max', description: null, group: null }] }),
    option({ id: 'allow_all', name: 'Allow All', category: 'permissions', currentValue: 'off', values: [{ value: 'on', name: 'On', description: null, group: null }, { value: 'off', name: 'Off', description: null, group: null }] }),
    option({ id: 'agent', name: hostile, category: '_agent', currentValue: '', values: [{ value: '', name: hostile, description: null, group: null }] }),
  ];
  const { primary, more } = partitionOptions(options);
  assert.deepEqual(primary.map((item) => item.id), ['mode', 'model', 'reasoning_effort']);
  assert.deepEqual(more.map((item) => item.id), ['allow_all', 'agent']);
  const markup = optionsMarkup(options);
  assert.match(markup, /<optgroup label="Fast"><option value="a">Alpha<\/option><\/optgroup><optgroup label="Smart"><option value="b" selected>Beta<\/option>/);
  assert.match(markup, /<option value="off" selected>Off<\/option>/);
  assert.match(markup, /<details class="chat-more"><summary>More<\/summary>/);
  assert.doesNotMatch(markup, /<img|<script/i, 'An option the agent named drew as markup.');
  assert.equal(optionsMarkup([]), '');
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

test('the tab says whether the agent works, thinks or waits for you, and nothing when it waits for a message', () => {
  // W-200, the owner: "indicate in the tab whether an agent is working, thinking, or wanting input".
  const at = (fields, entries = []) => {
    const chat = emptyChat();
    mergeChat(chat, view({ revision: 5, entries, ...fields }), 'k');
    return chatActivity(chat);
  };
  assert.equal(chatActivity(emptyChat()), 'none');
  assert.equal(at({ state: 'starting' }), 'starting');
  assert.equal(at({}), 'idle');
  assert.equal(at({ working: true }, [entry({ id: 'e1', order: 1, kind: 'you' }), entry({ id: 'e2', order: 2, kind: 'tool' })]), 'working');
  assert.equal(at({ working: true }, [entry({ id: 'e1', order: 1, kind: 'you' }), entry({ id: 'e2', order: 2, kind: 'thought', text: 'Hmm' })]), 'thinking');
  assert.equal(at({ working: true }, [entry({ id: 'e2', order: 2, kind: 'thought' }), entry({ id: 'e3', order: 3, kind: 'agent', text: 'Done' })]), 'working',
    'An agent that wrote after thinking is still told as thinking.');
  assert.equal(at({ working: true }, [entry({ id: 'e1', order: 1, kind: 'permission', options: [], answer: null })]), 'waiting', 'A question for the person is not told.');
  assert.equal(at({ state: 'signIn' }), 'waiting');
  assert.equal(at({ state: 'ended' }), 'ended');
  assert.deepEqual(chatTabStatus('waiting'), { kind: 'waiting', label: 'Waiting for you' });
  assert.equal(chatTabStatus('idle'), null);
  assert.equal(chatTabStatus('ended'), null);
});

test('under the box: what waits for review when something does, and otherwise what the level does with a change', () => {
  // The owner, at Unattended: "Proposals waiting ... i went to the agent page and could not find any proposals".
  for (const level of ['Inspect', 'Edit data', 'Unattended']) {
    assert.doesNotMatch(reviewHint(level, 0).text, /wait/, `${level} sends the person looking for a proposal that cannot be there.`);
  }
  assert.match(reviewHint('Unattended', 0).text, /accept its own/);
  assert.match(reviewHint('Shape app', 0).text, /waits for your review/);
  assert.deepEqual(reviewHint('Unattended', 1), { text: '1 proposal waits for your review', waiting: true });
  assert.deepEqual(reviewHint('Edit data', 3), { text: '3 proposals wait for your review', waiting: true });
  assert.equal(reviewHint('Off', 0).text, '');
});
