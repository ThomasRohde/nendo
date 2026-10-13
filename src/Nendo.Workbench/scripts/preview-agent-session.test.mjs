import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// WAU-16 (broad review, 2026-10-13): the browser preview's scripted agent, which the agent-chat
// lane drives, let an old turn's timers write into the next conversation and run after Stop, and
// launched a second agent while one ran, where the Desktop host refuses. The lane could then read
// states production never reaches. Measured against the real class with a clock of its own.
const timers = [];
let now = 0;
globalThis.window = {
  setTimeout(step, delay) { timers.push({ at: now + delay, step }); return timers.length; },
  clearTimeout() {},
};
function advance(milliseconds) {
  const until = now + milliseconds;
  for (;;) {
    timers.sort((left, right) => left.at - right.at);
    if (timers.length === 0 || timers[0].at > until) break;
    const next = timers.shift();
    now = next.at;
    next.step();
  }
  now = until;
}

const { PreviewAgentSession } = await bundleOf('src/preview-agent-session.ts');

function ready() {
  const session = new PreviewAgentSession(() => ({ mode: 'editData', endpoint: 'http://127.0.0.1:41763/mcp', pendingProposals: [] }));
  session.handle('agentSession.launch', { agentId: 'copilot' });
  advance(500);
  assert.equal(session.handle('agentSession.read', { after: 0 }).state, 'ready');
  return session;
}

const kinds = (view) => view.entries.map((entry) => entry.kind);

test('WAU-16: an old turn writes nothing into the conversation that New session started', () => {
  const session = ready();
  session.handle('agentSession.prompt', { text: 'hello', after: 0 });
  advance(100);
  session.handle('agentSession.end', { after: 0 });
  session.handle('agentSession.launch', { agentId: 'copilot' });
  advance(1500);
  const fresh = session.handle('agentSession.read', { after: 0 });
  assert.equal(fresh.conversationId, 'preview-2');
  assert.deepEqual(kinds(fresh), [], `The new conversation holds the old turn's steps: ${kinds(fresh).join(', ')}.`);
});

test('WAU-16: a turn stopped by Stop asks nothing afterwards', () => {
  const session = ready();
  session.handle('agentSession.prompt', { text: 'hello', after: 0 });
  advance(100);
  session.handle('agentSession.cancel', { after: 0 });
  advance(1500);
  const after = session.handle('agentSession.read', { after: 0 });
  assert.equal(after.entries.at(-1)?.text, 'Stopped.', `Something came after Stopped.: ${kinds(after).join(', ')}.`);
  assert.equal(after.entries.some((entry) => entry.kind === 'permission' && entry.answer === null), false, 'A stopped turn asked permission afterwards.');
  assert.equal(after.working, false);
});

test('WAU-16: a second launch while an agent runs is refused, as the Desktop host refuses it', () => {
  const session = ready();
  assert.throws(() => session.handle('agentSession.launch', { agentId: 'opencode' }), (error) => error.code === 'agent-already-running',
    'A second agent was launched while one ran.');
  session.handle('agentSession.end', { after: 0 });
  assert.equal(session.handle('agentSession.launch', { agentId: 'opencode' }).conversationId, 'preview-2');
});
