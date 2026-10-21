import { fileScopedClearable } from './app-state';
import { assistantStatus, changedSettings, conversationKey, messagePreview, nextAskStep, type AssistantConversation, type OfferedAgent } from './assistant-model';
import { client } from './client';
import { confirmDialog } from './confirm-dialog';
import type { AssistantItem, AssistantReply, AssistantStatus } from './extension-api/protocol';
import type { BrokerAssistant, BrokerMount } from './extension-broker';
import { escapeHtml, messageFor } from './format';
import { icon } from './icons';
import { WorkbenchHostError, type AgentTurn, type LaunchableAgents, type LaunchedAgentView, type ViewAgentAccess } from './host-types';
import { agentChatNow, followAgentChat, launchAgentForView, onAgentChatChanged, showAgentPage } from './view-agent-chat';

/**
 * A custom view messages the person's launched agent (ADR-0033).
 *
 * The broker checks what the view sent; this module asks the person, in Nendo's own cards, and
 * does the rest: launches the agent the person picks on the card when none runs, waits while it
 * starts or signs in, sends the message marked with the view's title, and answers the view with
 * its own turn's reply once the turn ends. What to do next is worked out in assistant-model.ts.
 *
 * Nothing here is kept on the device. Not now holds for a package until the conversation
 * changes; Allow holds until the conversation ends. The Never, Ask and Always choice is the
 * Agent page's, kept by the host, as are the settings the person picks for each agent.
 */

/** Who a mount is, for the cards and the transcript. */
export interface AssistantViewIdentity { title: string; packageId: string }

/** How long a message waits for an agent to start or sign in before it is given up. */
const startPatienceMs = 6 * 60_000;

let access: ViewAgentAccess | null = null;
const declined = new Map<string, string>();
const allowed = new Map<string, string>();
/** The conversation each package launched for an agent with no kept settings, until the person presses Send. */
const settingsFirst = new Map<string, string>();
/** The turn each mount's message started, so cancel stops its own turn and no other. */
const turns = new Map<string, { turnId: string; conversationId: string }>();
/** One card at a time: a second view's card waits for the first to close. */
let cards: Promise<unknown> = Promise.resolve();

fileScopedClearable({
  clear(): void {
    access = null;
    declined.clear();
    allowed.clear();
    settingsFirst.clear();
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
function card(question: { title: string; bodyHtml: string; confirmLabel: string; prepare?: (dialog: HTMLDialogElement) => void }): Promise<boolean> {
  const shown = cards.then(() => confirmDialog({ headingId: 'assistant-card-heading', ...question }));
  cards = shown.catch(() => undefined);
  return shown;
}

function quoted(text: string): string {
  return `<blockquote class="assistant-card-message">${escapeHtml(messagePreview(text))}</blockquote>`;
}

/**
 * Pickers for an agent's settings: one select each, set to `value`, its values grouped as the agent
 * groups them. `data-assistant-setting` names the option.
 */
function settingsMarkup(settings: ReadonlyArray<{ id: string; name: string; value: string; values: ReadonlyArray<{ value: string; name: string; group: string | null }> }>): string {
  return settings.map((setting) => {
    const groups = new Map<string, Array<{ value: string; name: string }>>();
    for (const value of setting.values) groups.set(value.group ?? '', [...(groups.get(value.group ?? '') ?? []), value]);
    const choice = (value: { value: string; name: string }): string =>
      `<option value="${escapeHtml(value.value)}" ${value.value === setting.value ? 'selected' : ''}>${escapeHtml(value.name)}</option>`;
    const options = [...groups].map(([group, values]) => group === ''
      ? values.map(choice).join('')
      : `<optgroup label="${escapeHtml(group)}">${values.map(choice).join('')}</optgroup>`).join('');
    return `<label><span>${escapeHtml(setting.name)}</span><select data-assistant-setting="${escapeHtml(setting.id)}">${options}</select></label>`;
  }).join('');
}

/** The settings pane for `agent`: its kept settings as pickers, or why there are none yet. */
function launchSettingsMarkup(agent: OfferedAgent | undefined): string {
  if (agent === undefined) return '';
  const heading = `<div class="assistant-launch-heading"><h3>${escapeHtml(agent.name)} settings</h3>${agent.settings === null ? '' : '<span>As you left them last time</span>'}</div>`;
  return agent.settings === null
    ? `${heading}<div class="assistant-launch-unseen">${icon('info')}<p class="assistant-card-note">${escapeHtml(agent.name)} has not run on this computer yet. Nendo learns its settings when it starts, and shows them before the message goes.</p></div>`
    : `${heading}<div class="assistant-card-settings">${settingsMarkup(agent.settings)}</div>`;
}

/** What the agents pane says under each agent's name. */
function agentNote(agent: OfferedAgent): string {
  if (agent.settings === null) return 'Not run here yet';
  return agent.last ? 'Launched last' : 'Installed';
}

/**
 * The launch card's body: the message, then the agents installed and shown on the left, the one
 * last launched selected, and the chosen one's kept settings on the right, with a button that
 * names the agent chosen. `picked` collects what the person sets, by agent.
 */
function launchCard(view: AssistantViewIdentity, text: string, agents: OfferedAgent[], selectedId: string, choose: (id: string) => void,
  picked: Map<string, Map<string, string>>): { bodyHtml: string; confirmLabel: string; prepare: (dialog: HTMLDialogElement) => void } {
  const agentOf = (id: string): OfferedAgent | undefined => agents.find((agent) => agent.id === id);
  const nameOf = (id: string): string => agentOf(id)?.name ?? id;
  const list = agents.map((agent) =>
    `<label class="assistant-launch-agent"><input class="visually-hidden" type="radio" name="assistant-card-agent" value="${escapeHtml(agent.id)}" data-assistant-agent="${escapeHtml(agent.id)}" ${agent.id === selectedId ? 'checked' : ''} /><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agentNote(agent))}</small></label>`).join('');
  const bodyHtml = `<div class="assistant-launch-message"><strong>${escapeHtml(view.title)} asks:</strong> <blockquote>${escapeHtml(messagePreview(text))}</blockquote></div>
    <div class="assistant-launch-panes">
      <fieldset class="assistant-launch-agents"><legend>Launch</legend>${list}</fieldset>
      <div class="assistant-launch-settings" data-assistant-settings>${launchSettingsMarkup(agentOf(selectedId))}</div>
    </div>`;
  return {
    bodyHtml,
    confirmLabel: `Launch ${escapeHtml(nameOf(selectedId))}`,
    prepare(dialog) {
      dialog.classList.add('assistant-launch-dialog');
      const actions = dialog.querySelector('.form-actions');
      actions?.insertAdjacentHTML('afterbegin', '<span class="assistant-launch-footnote">No agent is running. It works at the access level on the Agent page.</span>');
      const button = dialog.querySelector<HTMLButtonElement>('[data-confirm]');
      const box = dialog.querySelector<HTMLElement>('[data-assistant-settings]');
      let current = selectedId;
      for (const radio of dialog.querySelectorAll<HTMLInputElement>('input[name="assistant-card-agent"]'))
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          current = radio.value;
          choose(current);
          if (button !== null) button.textContent = `Launch ${nameOf(current)}`;
          const agent = agentOf(current);
          if (box === null || agent === undefined) return;
          // Each agent's picks stay as the person left them while they look at another.
          const mine = picked.get(current);
          box.innerHTML = launchSettingsMarkup(agent.settings === null ? agent
            : { ...agent, settings: agent.settings.map((setting) => ({ ...setting, value: mine?.get(setting.id) ?? setting.value })) });
        });
      box?.addEventListener('change', (event) => {
        const select = event.target instanceof HTMLSelectElement ? event.target : null;
        const id = select?.dataset.assistantSetting;
        if (select === null || id === undefined) return;
        const mine = picked.get(current) ?? new Map<string, string>();
        mine.set(id, select.value);
        picked.set(current, mine);
      });
    },
  };
}

/**
 * The card after launching an agent that had no kept settings: its own settings, set on the agent
 * as the person picks each, and Send. What they pick is kept for the next launch by the host.
 */
function settingsCard(view: AssistantViewIdentity, text: string, agentName: string, conversationId: string): { title: string; bodyHtml: string; confirmLabel: string; prepare: (dialog: HTMLDialogElement) => void } {
  const options = agentChatNow().options;
  const settings = options.map((option) => ({ id: option.id, name: option.name, value: option.currentValue, values: option.values }));
  return {
    title: `Send to ${escapeHtml(agentName)}?`,
    bodyHtml: `<p>${escapeHtml(view.title)} wants to send this to ${escapeHtml(agentName)}:</p>${quoted(text)}
      <p>${settings.length === 0 ? `${escapeHtml(agentName)} offers no settings.` : `Choose ${escapeHtml(agentName)}'s settings before it goes. This computer keeps them for its next start.`}</p>
      <div class="assistant-card-settings" data-assistant-settings>${settingsMarkup(settings)}</div>`,
    confirmLabel: 'Send',
    prepare(dialog) {
      dialog.querySelector('[data-assistant-settings]')?.addEventListener('change', (event) => {
        const select = event.target instanceof HTMLSelectElement ? event.target : null;
        const id = select?.dataset.assistantSetting;
        if (select === null || id === undefined) return;
        const before = agentChatNow().options.find((option) => option.id === id)?.currentValue ?? select.value;
        select.disabled = true;
        void client.request<LaunchedAgentView>('agentSession.setOption', { configId: id, value: select.value, conversationId, after: agentChatNow().revision })
          .then(() => { followAgentChat(); }, () => { select.value = before; })
          .finally(() => { select.disabled = false; });
      });
    },
  };
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
      declinedFor: declined.get(view.packageId), allowedFor: allowed.get(view.packageId), settingsFor: settingsFirst.get(view.packageId),
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
        let chosen = step.selectedId;
        const picked = new Map<string, Map<string, string>>();
        const launch = await card({ title: `Let ${escapeHtml(view.title)} ask an agent?`, ...launchCard(view, message.text, step.agents, step.selectedId, (id) => { chosen = id; }, picked) });
        if (!launch) {
          declined.set(view.packageId, conversationKey(conversationNow()));
          throw new WorkbenchHostError('assistant-declined', 'The person did not launch an agent for this view.');
        }
        const agent = step.agents.find((candidate) => candidate.id === chosen);
        try {
          await launchAgentForView(chosen, changedSettings(agent?.settings ?? null, picked.get(chosen) ?? new Map()));
        } catch (error) {
          throw new WorkbenchHostError('assistant-unavailable', messageFor(error));
        }
        // Launching from the card is the person's consent for this view and this conversation.
        const launched = agentChatNow().conversationId;
        if (launched !== null) allowed.set(view.packageId, launched);
        // An agent never seen here shows its own settings once it is ready, before the message goes.
        if (launched !== null && (agent?.settings ?? null) === null) settingsFirst.set(view.packageId, launched);
        continue;
      }
      case 'settings': {
        const send = await card(settingsCard(view, message.text, step.agentName, step.conversationId));
        settingsFirst.delete(view.packageId);
        if (!send) {
          declined.set(view.packageId, step.conversationId);
          throw new WorkbenchHostError('assistant-declined', 'The person did not send the message.');
        }
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

