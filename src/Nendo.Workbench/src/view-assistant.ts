import { fileScopedClearable } from './app-state';
import { agentToOffer, assistantStatus, conversationKey, messagePreview, nextAskStep, type AssistantConversation } from './assistant-model';
import { client } from './client';
import { confirmDialog } from './confirm-dialog';
import type { AssistantItem, AssistantReply, AssistantStatus } from './extension-api/protocol';
import type { BrokerAssistant, BrokerMount } from './extension-broker';
import { escapeHtml, messageFor } from './format';
import { WorkbenchHostError, type AgentTurn, type LaunchableAgents, type LaunchedAgentView, type ViewAgentAccess } from './host-types';
import { agentChatNow, followAgentChat, launchAgentForView, onAgentChatChanged, showAgentPage } from './view-agent-chat';

/**
 * A custom view messages the person's launched agent (ADR-0033).
 *
 * The broker checks what the view sent; this module asks the person, in Nendo's own cards, and
 * does the rest: launches the agent the Agent page last launched when none runs, waits while it
 * starts or signs in, sends the message marked with the view's title, and answers the view with
 * its own turn's reply once the turn ends. What to do next is worked out in assistant-model.ts.
 *
 * Nothing here is kept on the device. Not now holds for a package until the conversation
 * changes; Allow holds until the conversation ends. The Never, Ask and Always choice is the
 * Agent page's, kept by the host.
 */

/** Who a mount is, for the cards and the transcript. */
export interface AssistantViewIdentity { title: string; packageId: string }

/** How long a message waits for an agent to start or sign in before it is given up. */
const startPatienceMs = 6 * 60_000;

let access: ViewAgentAccess | null = null;
const declined = new Map<string, string>();
const allowed = new Map<string, string>();
/** The turn each mount's message started, so cancel stops its own turn and no other. */
const turns = new Map<string, { turnId: string; conversationId: string }>();
/** One card at a time: a second view's card waits for the first to close. */
let cards: Promise<unknown> = Promise.resolve();

fileScopedClearable({
  clear(): void {
    access = null;
    declined.clear();
    allowed.clear();
    turns.clear();
  },
});

function conversationNow(): AssistantConversation {
  const chat = agentChatNow();
  return { exists: chat.exists, conversationId: chat.conversationId, state: chat.state, working: chat.working, name: chat.exists ? chat.name : null };
}

async function launchable(): Promise<LaunchableAgents | null> {
  try {
    const offer = await client.request<LaunchableAgents>('agentSession.list');
    access = offer.viewAccess ?? 'ask';
    return offer;
  } catch (error) {
    if (error instanceof WorkbenchHostError && error.code === 'unknown-method') return null;
    throw error;
  }
}

async function accessNow(): Promise<ViewAgentAccess> {
  if (access === null) await launchable();
  return access ?? 'ask';
}

/** The conversation as the host has it, read once when this window has not followed it yet. */
async function ensureFollowed(): Promise<void> {
  if (agentChatNow().key !== '') return;
  await new Promise<void>((resolve) => {
    const stop = onAgentChatChanged(() => { stop(); resolve(); });
    followAgentChat();
    window.setTimeout(() => { stop(); resolve(); }, 3_000);
  });
}

/** Resolve once `done` holds of the conversation, or reject after `patience`. */
function waitForConversation(done: (conversation: AssistantConversation) => boolean, patience: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (done(conversationNow())) { resolve(); return; }
    const timer = window.setTimeout(() => {
      stop();
      reject(new WorkbenchHostError('assistant-unavailable', 'The agent did not become ready in time. Nothing was sent.'));
    }, patience);
    const stop = onAgentChatChanged(() => {
      if (!done(conversationNow())) return;
      window.clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** Show a card once the one before it has closed. */
function card(question: { title: string; bodyHtml: string; confirmLabel: string }): Promise<boolean> {
  const shown = cards.then(() => confirmDialog({ headingId: 'assistant-card-heading', ...question }));
  cards = shown.catch(() => undefined);
  return shown;
}

function quoted(text: string): string {
  return `<blockquote class="assistant-card-message">${escapeHtml(messagePreview(text))}</blockquote>`;
}

/** Tell the person why no agent can run, with the way to the Agent page. */
function sayCannot(view: AssistantViewIdentity, why: string): void {
  void card({
    title: `${escapeHtml(view.title)} cannot reach an agent`,
    bodyHtml: `<p>${escapeHtml(why)}</p>`,
    confirmLabel: 'Open Agent page',
  }).then((open) => { if (open) showAgentPage(); });
}

async function ask(view: AssistantViewIdentity, mountKey: string, message: { text: string; context: AssistantItem[] }): Promise<AssistantReply> {
  await ensureFollowed();
  let offer: LaunchableAgents | null | undefined;
  // A launch, a wait and a consent at most, then the message: a loop that goes round more is a bug.
  for (let round = 0; round < 6; round += 1) {
    const conversation = conversationNow();
    const needsOffer = !conversation.exists || conversation.state === 'ended' || conversation.state === 'none';
    if (needsOffer || access === null) offer = await launchable();
    const step = nextAskStep({
      access: await accessNow(), conversation, launchable: offer ?? null,
      declinedFor: declined.get(view.packageId), allowedFor: allowed.get(view.packageId),
    });
    switch (step.kind) {
      case 'refuse':
        throw new WorkbenchHostError(step.code, step.message);
      case 'cannotLaunch':
        sayCannot(view, step.reason);
        throw new WorkbenchHostError('assistant-unavailable', step.reason);
      case 'noAgent':
        sayCannot(view, 'No agent is installed on this computer, or every one is hidden. The Agent page shows how to install one.');
        throw new WorkbenchHostError('assistant-unavailable', 'No agent is installed on this computer.');
      case 'launch': {
        const launch = await card({
          title: `Let ${escapeHtml(view.title)} ask an agent?`,
          bodyHtml: `<p>${escapeHtml(view.title)} wants to send this to an agent:</p>${quoted(message.text)}
            <p>No agent is running. Launch ${escapeHtml(step.agentName)}? It works at the access level on the Agent page, and the message shows in its conversation. Its settings are on the Agent page.</p>`,
          confirmLabel: `Launch ${escapeHtml(step.agentName)}`,
        });
        if (!launch) {
          declined.set(view.packageId, conversationKey(conversationNow()));
          throw new WorkbenchHostError('assistant-declined', 'The person did not launch an agent for this view.');
        }
        try {
          await launchAgentForView(step.agentId);
        } catch (error) {
          throw new WorkbenchHostError('assistant-unavailable', messageFor(error));
        }
        // Launching from the card is the person's consent for this view and this conversation.
        const launched = agentChatNow().conversationId;
        if (launched !== null) allowed.set(view.packageId, launched);
        continue;
      }
      case 'wait':
        await waitForConversation((current) => current.state === 'ready' || current.state === 'ended' || !current.exists, startPatienceMs);
        continue;
      case 'consent': {
        const conversationId = conversation.conversationId!;
        const allow = await card({
          title: `Let ${escapeHtml(view.title)} message ${escapeHtml(step.agentName)}?`,
          bodyHtml: `<p>${escapeHtml(view.title)} wants to send this to ${escapeHtml(step.agentName)}:</p>${quoted(message.text)}
            <p>Allow holds until this conversation ends. Every message it sends shows in the conversation with its name. Choose Always or Never for views on the Agent page.</p>`,
          confirmLabel: 'Allow',
        });
        if (!allow) {
          declined.set(view.packageId, conversationId);
          throw new WorkbenchHostError('assistant-declined', 'The person did not let this view message the agent.');
        }
        allowed.set(view.packageId, conversationId);
        continue;
      }
      case 'send':
        return send(view, mountKey, message, step.conversationId);
    }
  }
  throw new WorkbenchHostError('assistant-unavailable', 'The agent could not be reached. Nothing was sent.');
}

async function send(view: AssistantViewIdentity, mountKey: string, message: { text: string; context: AssistantItem[] }, conversationId: string): Promise<AssistantReply> {
  let sent: LaunchedAgentView;
  try {
    sent = await client.request<LaunchedAgentView>('agentSession.prompt', {
      text: message.text, ...(message.context.length === 0 ? {} : { context: message.context.map((item) => ({ uri: item.uri, title: item.title, text: item.text ?? '' })) }),
      from: view.title.slice(0, 120), conversationId, after: agentChatNow().revision,
    });
  } catch (error) {
    if (error instanceof WorkbenchHostError && (error.code === 'agent-working' || error.code === 'agent-not-ready'))
      throw new WorkbenchHostError('assistant-busy', error.message);
    throw error;
  }
  followAgentChat();
  const turnId = sent.turnId;
  if (typeof turnId !== 'string') throw new WorkbenchHostError('assistant-unavailable', 'This Nendo did not say which turn the message started.');
  turns.set(mountKey, { turnId, conversationId });
  try {
    return await turnEnd(turnId, conversationId);
  } finally {
    if (turns.get(mountKey)?.turnId === turnId) turns.delete(mountKey);
  }
}

/** Read the turn until it ends: on each change of the conversation, and every two seconds besides. */
async function turnEnd(turnId: string, conversationId: string): Promise<AssistantReply> {
  for (;;) {
    let turn: AgentTurn;
    try {
      turn = await client.request<AgentTurn>('agentSession.turn', { turnId, conversationId });
    } catch (error) {
      // Replaced or gone with its file: the conversation ended before the turn did.
      if (error instanceof WorkbenchHostError && (error.code === 'agent-conversation-replaced' || error.code === 'agent-not-launched'))
        return { reply: '', stopReason: 'ended' };
      throw error;
    }
    if (turn.done) return { reply: turn.reply ?? '', stopReason: turn.stopReason ?? 'end_turn' };
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => { stop(); resolve(); }, 2_000);
      const stop = onAgentChatChanged(() => { window.clearTimeout(timer); stop(); resolve(); });
    });
  }
}

/** Stop this mount's own turn: dropped while it waits, cancelled while it runs. */
async function cancel(mountKey: string): Promise<void> {
  const turn = turns.get(mountKey);
  if (turn === undefined || agentChatNow().conversationId !== turn.conversationId) return;
  await client.request<LaunchedAgentView>('agentSession.cancel', { conversationId: turn.conversationId, turnId: turn.turnId, after: agentChatNow().revision });
}

/** The status views hear, from the conversation this window follows and the person's choice. */
function statusNow(): AssistantStatus {
  return assistantStatus(conversationNow(), access ?? 'ask');
}

/**
 * The launched agent for the broker. `identify` names a mount; `tell` hands every connected view
 * the status when it changes.
 */
export function createAssistant(identify: (mount: BrokerMount) => AssistantViewIdentity, tell: (status: AssistantStatus) => void): BrokerAssistant {
  // What this broker's views last heard, so a change that leaves the status as it was says nothing.
  let lastStatus = '';
  const notify = (): void => {
    const status = statusNow();
    const json = JSON.stringify(status);
    if (json === lastStatus) return;
    lastStatus = json;
    tell(status);
  };
  onAgentChatChanged(notify);
  listeners.add(notify);
  return {
    async status() {
      await ensureFollowed();
      await accessNow();
      return statusNow();
    },
    ask: (mount, message) => ask(identify(mount), mount.key, message),
    cancel: (mount) => cancel(mount.key),
  };
}

const listeners = new Set<() => void>();

/** The person changed what views may do, on the Agent page: views hear it at once. */
export function assistantAccessChanged(next: ViewAgentAccess): void {
  access = next;
  for (const listener of listeners) listener();
}

/** For the node lane: the agent a card would offer. */
export { agentToOffer };
