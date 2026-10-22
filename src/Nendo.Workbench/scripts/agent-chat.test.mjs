import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0030: the conversation with a launched agent.
// Reads carry only what changed and are merged by entry; a run of steps folds into one line;
// everything an agent or a tool says is drawn as text, never as markup; and the agent's own
// options are drawn as it offers them.
const { chatActivity, chatTabStatus, composerState, createMarkupCache, emptyChat, itemMarkup, mergeChat, optionsMarkup, partitionOptions, reviewHint, signInMarkup, stateLabel, stepsSummary, threadItems, usageChip, waitingForYou } =
  await bundleOf('src/agent-chat-model.ts');

const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function entry(fields) {
  return { id: 'e1', order: 1, revision: 1, kind: 'agent', text: '', title: null, toolKind: null, status: null, input: null, options: null, answer: null, plan: null, origin: null, ...fields };
}

function view(fields) {
  return {
    exists: true, agentId: 'copilot', name: 'GitHub Copilot CLI', commandLine: 'copilot --acp', endpoint: 'http://127.0.0.1:41763/mcp',
    conversationId: 'c1', level: 'Edit data', state: 'ready', working: false, notice: null, agentTitle: null, revision: 1, entries: [], more: false, signInMethods: [], options: [], firstOrder: 0, ...fields,
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
  // The owner: "indicate in the tab whether an agent is working, thinking, or wanting input".
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

// A read still out when New session starts can come back afterwards. Merged into the new
// conversation, it would show the old prompt, tools and answers and take its revision, so the new
// conversation's entries would never be read.
test('a late read from a replaced conversation changes nothing', () => {
  const chat = emptyChat();
  mergeChat(chat, view({ conversationId: 'old', revision: 10, entries: [entry({ id: 'e1', kind: 'you', text: 'Old prompt', revision: 10 })] }), 'f|1');
  mergeChat(chat, view({ conversationId: 'new', revision: 1, state: 'starting', entries: [] }), 'f|2');
  const late = mergeChat(chat, view({ conversationId: 'old', revision: 10, entries: [entry({ id: 'e1', kind: 'you', text: 'Old prompt', revision: 10 })] }), 'f|2');
  assert.deepEqual(late, []);
  assert.equal(chat.revision, 1, "The new conversation took the old one's revision.");
  assert.equal(chat.entries.size, 0, "The old conversation's entries were drawn in the new one.");
  assert.equal(chat.conversationId, 'new');
  mergeChat(chat, view({ conversationId: 'new', revision: 2, entries: [entry({ id: 'e1', kind: 'you', text: 'New prompt', revision: 2 })] }), 'f|2');
  assert.equal(chat.entries.get('e1').text, 'New prompt');
});

// The host keeps 1,000 entries, and the tab keeps no more: one open from the start would otherwise
// hold every entry it had ever read and scan them all on every update.
test('entries the host no longer keeps leave the tab too', () => {
  const chat = emptyChat();
  const entries = Array.from({ length: 1010 }, (_, index) => entry({ id: `e${index + 1}`, order: index + 1, revision: 1, kind: index === 0 ? 'permission' : 'tool', options: index === 0 ? [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] : null }));
  mergeChat(chat, view({ revision: 1, entries, firstOrder: 1 }), 'k');
  assert.equal(chat.entries.size, 1010);
  mergeChat(chat, view({ revision: 2, entries: [], firstOrder: 11 }), 'k');
  assert.equal(chat.entries.size, 1000, 'The tab kept entries the host had let go.');
  assert.equal(chat.entries.has('e1'), false);
  assert.equal(chat.entries.has('e11'), true);
  assert.equal(waitingForYou(chat), false, 'A question the host no longer keeps still waits for the person.');
});

// A permission request may supply its operation only as a diff. The card shows that too, so
// Allow and Reject never come with nothing to inspect.
test('a permission card shows the change the agent supplied, as text', () => {
  const asking = entry({ id: 'e4', kind: 'permission', title: 'Edit configuration', input: null,
    text: `Changes C:/work/config.json
Before:
${hostile}
After:
retries = 5`, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
  const item = { key: 'e4', type: 'permission', entry: asking };
  const closed = itemMarkup(item, 'Copilot', new Set());
  assert.match(closed, /data-toggle-input="e4"/, 'The card offers no way to see what the operation does.');
  const open = itemMarkup(item, 'Copilot', new Set(['e4']));
  assert.match(open, /retries = 5/);
  assert.match(open, /Changes C:\/work\/config\.json/);
  assert.doesNotMatch(open, /<img src=x/, 'What the agent sent was drawn as markup.');
});

// A request that Stop, End, the program or the file closing cancelled is not the person's
// choice, so it never reads "you chose Cancelled"; and the card names the tool's kind before
// Allow once, as the steps list does.
test('a cancelled request is not the person\'s choice, and the card names the tool\'s kind', () => {
  const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
  const cancelled = itemMarkup({ key: 'e5', type: 'permission', entry: entry({ id: 'e5', kind: 'permission', title: 'Update records', answer: 'Cancelled', options }) }, 'Copilot', new Set());
  assert.doesNotMatch(cancelled, /you chose/, 'A request nobody answered reads as the person\'s choice.');
  assert.match(cancelled, /cancelled when the turn stopped/);
  const chosen = itemMarkup({ key: 'e6', type: 'permission', entry: entry({ id: 'e6', kind: 'permission', title: 'Update records', answer: 'Allow', options }) }, 'Copilot', new Set());
  assert.match(chosen, /you chose Allow/);
  const asking = itemMarkup({ key: 'e7', type: 'permission', entry: entry({ id: 'e7', kind: 'permission', title: 'Update records', toolKind: 'delete', options }) }, 'Copilot', new Set());
  assert.match(asking, /chat-permission-head[\s\S]*>Delete</, 'The card does not say the tool deletes.');
});

// Only an item that changed is built again: building every item's markup, an agent's Markdown
// with it, on every read made each read of a long conversation cost close to a second.
test('one streamed chunk into a long conversation builds one item again', () => {
  const chat = emptyChat();
  const entries = [];
  for (let order = 1; order <= 1000; order += 1)
    entries.push(entry({ id: `e${order}`, order, revision: 1, kind: order % 2 === 0 ? 'agent' : 'you', text: order % 2 === 0 ? `**Answer** ${order}` : `Question ${order}` }));
  mergeChat(chat, view({ revision: 1, entries }), 'k');
  const cache = createMarkupCache();
  const draw = () => threadItems(chat).map((item) => cache.markup(item, chat.name, new Set(), false));
  const first = draw();
  assert.equal(cache.built, 1000);
  mergeChat(chat, view({ revision: 2, entries: [entry({ id: 'e1000', order: 1000, revision: 2, kind: 'agent', text: '**Answer** 1000 and more' })] }), 'k');
  const second = draw();
  assert.equal(cache.built - 1000, 1, `One chunk built ${cache.built - 1000} items again.`);
  assert.equal(second[999].includes('and more'), true, 'The changed item was not built again.');
  assert.equal(second[0], first[0]);
  assert.equal(draw().length, 1000);
  assert.equal(cache.built, 1001, 'A read with nothing new built an item again.');
});

// An open disclosure is named by its entry and the part it shows, not by its place in the item:
// a place moves to another step when a step earlier in the run gains one.
test('every disclosure in a run of steps is named by its entry and its part', () => {
  const run = [
    entry({ id: 'e2', order: 2, kind: 'tool', title: 'Count', status: 'completed', text: '42', input: '{}' }),
    entry({ id: 'e3', order: 3, kind: 'thought', text: 'Hmm' }),
    entry({ id: 'e4', order: 4, kind: 'tool', title: 'List', status: 'completed', text: 'Crew', input: '{"a":1}' }),
  ];
  const html = itemMarkup({ key: 'g-e2', type: 'steps', entries: run }, 'Copilot', new Set(['g-e2']));
  const parts = [...html.matchAll(/<details data-part="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(parts, ['e2:sent', 'e2:back', 'e3:thought', 'e4:sent', 'e4:back'], 'A disclosure has no identity of its own.');
  assert.equal((html.match(/<details/g) ?? []).length, parts.length, 'A disclosure is drawn without its identity.');
});

// The sign-in buttons are held while a sign-in runs, so a second press cannot start another.
test('the ways to sign in are held while a sign-in runs', () => {
  const chat = emptyChat();
  mergeChat(chat, view({ state: 'signIn', signInMethods: [{ id: 'browser', name: 'Sign in with a browser', description: null }], notice: 'Waiting…', signingIn: true }), 'k');
  assert.equal(chat.signingIn, true);
  assert.match(signInMarkup(chat), /data-sign-in="browser"[^>]*disabled/, 'A way to sign in is live while a sign-in runs.');
  mergeChat(chat, view({ state: 'signIn', revision: 2, signInMethods: [{ id: 'browser', name: 'Sign in with a browser', description: null }], signingIn: false }), 'k');
  assert.doesNotMatch(signInMarkup(chat), /disabled/);
  assert.equal(signInMarkup(emptyChat()), '');
});

// Entry IDs and revisions start again with every launch, so a cache keyed
// by them alone could draw the old launch's e1 for the new launch's e1.
test('a new launch never draws the old launch\'s markup for an entry of the same ID and revision', () => {
  const cache = createMarkupCache();
  const item = (text) => ({ key: 'e1', type: 'you', entry: entry({ id: 'e1', revision: 1, kind: 'you', text }) });
  assert.match(cache.markup(item('old conversation'), 'Copilot', new Set(), false, 'file|1'), /old conversation/);
  const fresh = cache.markup(item('new conversation'), 'Copilot', new Set(), false, 'file|2');
  assert.match(fresh, /new conversation/, 'The new launch drew the old launch\'s entry.');
  assert.equal(cache.built, 2);
});

test('the context chip says how full the agent says its context is, and warns when it is nearly full', () => {
  assert.equal(usageChip(null), null, 'a chip was drawn before the agent said its use');
  assert.equal(usageChip({ used: 5, size: 0, costAmount: null, costCurrency: null }), null);
  const half = usageChip({ used: 100_000, size: 200_000, costAmount: 1.5, costCurrency: 'USD' });
  assert.equal(half.label, '50% of context');
  assert.equal(half.high, false);
  assert.match(half.title, /100,000 of the 200,000 tokens/);
  assert.match(half.title, /\$1\.50 so far/);
  const full = usageChip({ used: 190_000, size: 200_000, costAmount: null, costCurrency: null });
  assert.equal(full.high, true);
  assert.doesNotMatch(full.title, /cost/);
  assert.equal(usageChip({ used: 250_000, size: 200_000, costAmount: null, costCurrency: null }).label, '100% of context');
  // A currency code no country uses is still said, by its code.
  assert.match(usageChip({ used: 1, size: 10, costAmount: 2, costCurrency: 'XQQ' }).title, /XQQ\s2\.00 so far/);
});

test('a read carries the agent\'s context use into the chat, and a new launch starts without one', () => {
  const chat = emptyChat();
  mergeChat(chat, { ...view(), usage: { used: 10, size: 100, costAmount: null, costCurrency: null } }, 'k1');
  assert.deepEqual(chat.usage, { used: 10, size: 100, costAmount: null, costCurrency: null });
  mergeChat(chat, { ...view(), usage: undefined }, 'k1');
  assert.equal(chat.usage, null, 'an older host\'s read left an old use standing');
});

test('an on/off setting of the agent\'s is a switch, and a select stays a select', () => {
  const verbose = { id: 'verbose', name: hostile, description: null, category: null, currentValue: 'true', type: 'boolean',
    values: [{ value: 'true', name: 'On', description: null, group: null }, { value: 'false', name: 'Off', description: null, group: null }] };
  const markup = optionsMarkup([option({}), verbose]);
  assert.match(markup, /<button type="button" class="chat-switch" data-config-switch="verbose" aria-pressed="true"/);
  assert.ok(!markup.includes('<select data-config-id="verbose"'), 'the on/off setting was drawn as a select');
  assert.match(markup, /<select data-config-id="model"/);
  assert.ok(!markup.includes('<img src=x'), markup);
  assert.match(optionsMarkup([{ ...verbose, currentValue: 'false' }]), /aria-pressed="false"/);
});
