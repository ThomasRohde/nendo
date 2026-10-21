import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0033: what a custom view's message to the launched agent needs next. Never refuses at once;
// Not now holds until the conversation changes; a launch is offered when none runs, and the agent
// card lists every agent installed and shown, the one last launched selected while it is still
// among them; Ask asks once per conversation; a running turn is no refusal, since the host keeps
// the message.
const { agentsToOffer, assistantStatus, changedSettings, conversationKey, declineHoldMs, messagePreview, nextAskStep } = await bundleOf('src/assistant-model.ts');

const agent = (id, found = true) => ({ id, name: id.toUpperCase(), commandLine: id, found, package: null, installCommand: null, renamedFrom: null, updateCommand: null });
const offer = (fields = {}) => ({ canLaunch: true, reason: null, agents: [agent('copilot'), agent('gemini', false), agent('claude')], customCommandLine: null, running: null, hidden: [], lastAgentId: null, viewAccess: 'ask', ...fields });
const none = { exists: false, conversationId: null, state: 'none', working: false, name: null };
const ready = { exists: true, conversationId: 'c1', state: 'ready', working: false, name: 'Claude' };
const facts = (fields) => ({ access: 'ask', conversation: ready, launchable: offer(), declined: undefined, now: 100_000, allowedFor: undefined, ...fields });
const saidNotNow = (key, secondsAgo = 1) => ({ key, at: 100_000 - secondsAgo * 1000 });

test('Never refuses before anything else, without a card', () => {
  assert.deepEqual(nextAskStep(facts({ access: 'never', conversation: none })).kind, 'refuse');
  assert.equal(nextAskStep(facts({ access: 'never' })).code, 'assistant-off');
});

test('with none running, a launch is offered, or why it cannot be', () => {
  const listed = [{ id: 'copilot', name: 'COPILOT', settings: null, last: false }, { id: 'claude', name: 'CLAUDE', settings: null, last: false }];
  assert.deepEqual(nextAskStep(facts({ conversation: none })), { kind: 'launch', agents: listed, selectedId: 'copilot' });
  assert.deepEqual(nextAskStep(facts({ conversation: { ...ready, state: 'ended' }, launchable: offer({ lastAgentId: 'claude' }) })),
    { kind: 'launch', agents: [listed[0], { ...listed[1], last: true }], selectedId: 'claude' }, 'The card did not list every installed agent with the last one launched selected.');
  assert.deepEqual(nextAskStep(facts({ conversation: none, launchable: offer({ canLaunch: false, reason: 'Choose Inspect first.' }) })),
    { kind: 'cannotLaunch', reason: 'Choose Inspect first.' });
  assert.deepEqual(nextAskStep(facts({ conversation: none, launchable: offer({ hidden: ['copilot', 'claude'] }) })), { kind: 'noAgent' });
  assert.equal(nextAskStep(facts({ conversation: none, launchable: null })).code, 'assistant-unavailable');
});

test('the card lists the agents installed and shown, the last one launched selected only while listed', () => {
  assert.deepEqual(agentsToOffer(offer({ lastAgentId: 'gemini' })).agents.map((listed) => listed.id), ['copilot', 'claude'], 'An agent not installed was listed.');
  assert.equal(agentsToOffer(offer({ lastAgentId: 'gemini' })).selectedId, 'copilot', 'An agent not installed was selected.');
  const hiding = agentsToOffer(offer({ lastAgentId: 'claude', hidden: ['claude'] }));
  assert.deepEqual([hiding.agents.map((listed) => listed.id), hiding.selectedId], [['copilot'], 'copilot'], 'A hidden agent was listed or selected.');
  assert.equal(agentsToOffer(offer({ agents: [agent('gemini', false)] })), null);
});

const effort = { id: 'effort', name: 'Effort', category: 'thought_level', value: 'medium',
  values: [{ value: 'low', name: 'Low', group: null }, { value: 'medium', name: 'Medium', group: null }, { value: 'high', name: 'High', group: null }] };

test("the card carries each agent's kept settings, and launches with only what the person changed", () => {
  const kept = offer({ agents: [{ ...agent('copilot'), settings: [effort] }, { ...agent('claude'), settings: [] }] });
  assert.deepEqual(agentsToOffer(kept).agents.map((listed) => listed.settings), [[effort], null], 'The kept settings were not offered, or an empty list counted as kept.');
  assert.deepEqual(changedSettings([effort], new Map([['effort', 'high']])), { effort: 'high' });
  assert.deepEqual(changedSettings([effort], new Map([['effort', 'medium']])), {}, 'A kept value left as it was was sent as a pick.');
  assert.deepEqual(changedSettings([effort], new Map([['effort', 'max'], ['mode', 'plan']])), {}, 'A value or setting the agent never offered was sent.');
  assert.deepEqual(changedSettings(null, new Map([['effort', 'high']])), {});
});

test('an agent launched with no kept settings shows its own before the message goes, once ready', () => {
  assert.equal(nextAskStep(facts({ conversation: { ...ready, state: 'starting' }, settingsFor: 'c1', allowedFor: 'c1' })).kind, 'wait');
  assert.deepEqual(nextAskStep(facts({ settingsFor: 'c1', allowedFor: 'c1' })), { kind: 'settings', conversationId: 'c1', agentName: 'Claude' },
    "The message went before the person saw the new agent's settings.");
  assert.deepEqual(nextAskStep(facts({ settingsFor: 'c0', allowedFor: 'c1' })), { kind: 'send', conversationId: 'c1' });
});

test('starting or signing in waits; Ask asks once per conversation; Always does not ask', () => {
  assert.equal(nextAskStep(facts({ conversation: { ...ready, state: 'starting' } })).kind, 'wait');
  assert.equal(nextAskStep(facts({ conversation: { ...ready, state: 'signIn' } })).kind, 'wait');
  assert.deepEqual(nextAskStep(facts({})), { kind: 'consent', agentName: 'Claude' });
  assert.deepEqual(nextAskStep(facts({ allowedFor: 'c1' })), { kind: 'send', conversationId: 'c1' });
  assert.deepEqual(nextAskStep(facts({ allowedFor: 'c0' })).kind, 'consent', 'Allow for an earlier conversation carried over.');
  assert.deepEqual(nextAskStep(facts({ access: 'always' })), { kind: 'send', conversationId: 'c1' });
});

test('a running turn is no refusal: the host keeps the message', () => {
  assert.deepEqual(nextAskStep(facts({ access: 'always', conversation: { ...ready, working: true } })), { kind: 'send', conversationId: 'c1' });
});

test('Not now holds until the conversation changes', () => {
  assert.equal(nextAskStep(facts({ declined: saidNotNow('c1') })).code, 'assistant-declined');
  assert.equal(nextAskStep(facts({ declined: saidNotNow('c0') })).kind, 'consent', 'Not now for an earlier conversation still held.');
  assert.equal(conversationKey(none), 'none');
  assert.equal(nextAskStep(facts({ conversation: none, declined: saidNotNow('none') })).code, 'assistant-declined');
  assert.equal(nextAskStep(facts({ declined: saidNotNow('none') })).kind, 'consent', 'Not now to a launch held once an agent ran.');
});

test('Not now holds for a moment only: with no agent running, the next press shows the card again', () => {
  const later = declineHoldMs / 1000 + 1;
  assert.equal(nextAskStep(facts({ conversation: none, declined: saidNotNow('none', later) })).kind, 'launch',
    'Not now to the launch card still refused the view once the moment had passed, with nothing that could change the conversation.');
  assert.equal(nextAskStep(facts({ declined: saidNotNow('c1', later) })).kind, 'consent', 'Not now to the consent card held past the moment.');
  assert.equal(nextAskStep(facts({ conversation: none, declined: saidNotNow('none', 5) })).code, 'assistant-declined',
    'A view asking again at once got the card back.');
});

test('the status says nothing of the agent but its state and name', () => {
  assert.deepEqual(assistantStatus(none, 'ask'), { state: 'none', name: null, working: false, access: 'ask' });
  assert.deepEqual(assistantStatus({ ...ready, working: true }, 'always'), { state: 'ready', name: 'Claude', working: true, access: 'always' });
  assert.deepEqual(assistantStatus({ ...ready, state: 'ended', working: true }, 'ask').working, false);
});

test('a card quotes the first line of the message, cut short', () => {
  assert.equal(messagePreview('  First line\nsecond'), 'First line');
  assert.equal(messagePreview('x'.repeat(300)).length, 200);
});
