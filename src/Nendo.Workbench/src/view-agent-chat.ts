import { fileScopedClearable, state } from './app-state';
import { client } from './client';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import type { LaunchableAgents, LaunchedAgentView } from './host';
import { icon } from './icons';
import { composerState, emptyChat, entryMarkup, mergeChat, orderedEntries, stateLabel, type AgentChat } from './agent-chat-model';
import { announce, content, rerender, showError } from './shell';
import { openTabOn } from './workspace-tabs';

/**
 * The conversation with an agent launched from the Agent page, in a tab of its own (ADR-0030).
 *
 * The host sends a nudge whenever the conversation moves; this page reads only what changed
 * after the revision it holds and patches those entries in place. It never rebuilds the
 * composer while it is on screen, because a redraw of the whole page — a write from the agent
 * moves the file, and the file moving redraws the screen — would take the person's half-typed
 * message with it.
 */

const chat: AgentChat = emptyChat();
let launches = 0;
let draft = '';
let reading = false;
let readAgain = false;

fileScopedClearable({
  clear(): void {
    Object.assign(chat, emptyChat());
    draft = '';
  },
});

/** The key of the conversation this renderer is following: the file session and its launch. */
function launchKey(): string {
  return `${state.session.fileSessionId ?? ''}|${launches}`;
}

/** The tab's title: the agent's name. */
export function agentChatTitle(): string {
  return chat.exists ? chat.name : 'Agent';
}

/** Launch an agent from the Agent page and open its conversation in a new tab. */
export async function launchAgent(agentId: string): Promise<void> {
  if (state.actionInFlight) return;
  try {
    const view = await client.request<LaunchedAgentView>('agentSession.launch', { agentId });
    launches += 1;
    mergeChat(chat, view, launchKey());
    draft = '';
    await openTabOn('agentChat');
    announce(`${chat.name} is starting in a new tab.`);
    followAgentChat();
  } catch (error) {
    showError(messageFor(error));
  }
}

/** Open the running conversation: its tab if one shows it, otherwise a new one. */
export async function openAgentChat(): Promise<void> {
  if (chat.key === '') mergeChat(chat, await client.request<LaunchedAgentView>('agentSession.read', { after: 0 }), launchKey());
  await openTabOn('agentChat');
  followAgentChat();
}

/** Keep the person's own command line on this device. */
export async function saveAgentCommand(commandLine: string): Promise<LaunchableAgents> {
  return client.request<LaunchableAgents>('agentSession.setCommand', { commandLine });
}

/**
 * Catch the conversation up: read what changed after the revision held, as many times as the
 * host says there is more, and once more if a nudge arrived while reading.
 */
export function followAgentChat(): void {
  if (!state.session.hasFile || client.mode === 'unavailable') return;
  if (reading) { readAgain = true; return; }
  reading = true;
  void (async () => {
    try {
      do {
        readAgain = false;
        let more = true;
        while (more) {
          const view = await client.request<LaunchedAgentView>('agentSession.read', { after: chat.revision });
          const key = chat.key === '' ? launchKey() : chat.key;
          patchChat(mergeChat(chat, view, key));
          more = view.more;
        }
      } while (readAgain);
    } catch (error) {
      if (state.view === 'agentChat') chatError(messageFor(error));
    } finally {
      reading = false;
    }
  })();
}

export function renderAgentChat(): void {
  const page = content.querySelector<HTMLElement>('[data-agent-chat]');
  // The same conversation already on screen is patched, never rebuilt (see above).
  if (page !== null && page.dataset.chatKey === chat.key) {
    content.querySelector('#pending-save-notice')?.remove();
    patchChat(null);
    return;
  }
  const composer = composerState(chat);
  content.innerHTML = `<div class="agent-chat" data-agent-chat data-chat-key="${escapeAttribute(chat.key)}" data-testid="agent-chat">
    <header class="chat-heading">
      <div class="chat-title"><span class="chat-mark" aria-hidden="true">${icon('agent')}</span><div><h2 id="chat-name"></h2><p id="chat-detail"></p></div></div>
      <span id="chat-state" class="agent-ready"><span aria-hidden="true"></span><strong id="chat-state-label" class="chat-state-label"></strong></span>
      <button id="end-agent" class="secondary-button" type="button">End</button>
    </header>
    <p class="chat-disclosure" id="chat-disclosure"></p>
    <div class="message-slot" role="alert" hidden></div>
    <div id="chat-sign-in" class="chat-sign-in" hidden></div>
    <div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-relevant="additions"></div>
    <form id="chat-composer" class="chat-composer">
      <label class="visually-hidden" for="agent-prompt">Message to the agent</label>
      <textarea id="agent-prompt" rows="3" placeholder="${escapeAttribute(composer.placeholder)}"></textarea>
      <div class="chat-actions">
        <small>Enter sends · Shift+Enter starts a new line</small>
        <button id="stop-agent" class="secondary-button" type="button">Stop</button>
        <button id="send-prompt" class="primary-button" type="submit">Send</button>
      </div>
    </form>
  </div>`;
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.value = draft;
  prompt.addEventListener('input', () => { draft = prompt.value; });
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  });
  content.querySelector<HTMLFormElement>('#chat-composer')!.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });
  content.querySelector<HTMLButtonElement>('#stop-agent')!.addEventListener('click', () => void act('agentSession.cancel', {}, 'Stopping.'));
  content.querySelector<HTMLButtonElement>('#end-agent')!.addEventListener('click', () => void act('agentSession.end', {}, 'The conversation ended.'));
  const log = content.querySelector<HTMLElement>('#chat-log')!;
  log.addEventListener('click', (event) => {
    const answer = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-answer-entry]') : null;
    if (answer === null) return;
    void act('agentSession.answer', { entryId: answer.dataset.answerEntry, optionId: answer.dataset.optionId }, 'Answered.');
  });
  content.querySelector<HTMLElement>('#chat-sign-in')!.addEventListener('click', (event) => {
    const method = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-sign-in]') : null;
    if (method !== null) void act('agentSession.authenticate', { methodId: method.dataset.signIn }, 'Signing in.');
  });
  patchChat(null);
  if (chat.key === '' || !chat.exists) followAgentChat();
}

async function send(): Promise<void> {
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt');
  const text = prompt?.value.trim() ?? '';
  if (text === '' || !composerState(chat).canSend) return;
  const sent = await act('agentSession.prompt', { text }, null);
  if (!sent) return;
  draft = '';
  if (prompt !== null) prompt.value = '';
}

/** One of the tab's own requests. It answers with a read, merged like any other. */
async function act(method: string, payload: Record<string, unknown>, said: string | null): Promise<boolean> {
  try {
    const view = await client.request<LaunchedAgentView>(method, { ...payload, after: chat.revision });
    patchChat(mergeChat(chat, view, chat.key === '' ? launchKey() : chat.key));
    if (said !== null) announce(said);
    return true;
  } catch (error) {
    chatError(messageFor(error));
    return false;
  }
}

function chatError(message: string): void {
  showError(message);
}

/**
 * Bring the page on screen up to the chat: the heading, the state, the composer's switches,
 * and the entries named (all of them when null). Does nothing when the page is not shown.
 */
function patchChat(changed: string[] | null): void {
  const page = content.querySelector<HTMLElement>('[data-agent-chat]');
  if (page === null || page.dataset.chatKey !== chat.key) {
    // Another conversation on screen, or none: a new launch rebuilds through the renderer.
    if (page !== null && state.view === 'agentChat') rerender();
    return;
  }
  page.querySelector('#chat-name')!.textContent = chat.name;
  page.querySelector('#chat-detail')!.textContent = [chat.agentTitle, chat.commandLine].filter((part) => part !== null).join(' · ');
  const chip = page.querySelector<HTMLElement>('#chat-state')!;
  chip.className = `agent-ready ${chat.state === 'ready' ? (chat.working ? 'working' : 'ready') : chat.state}`;
  page.querySelector('#chat-state-label')!.textContent = stateLabel(chat);
  page.querySelector('#chat-disclosure')!.textContent = chat.exists
    ? `Works at ${chat.level} through ${chat.endpoint ?? 'this file’s agent address'}. It is the program you would run in a terminal, with its own tools on this computer; Nendo gives it this file and nothing else.`
    : 'No agent is running for this file. Launch one from the Agent page.';
  const composer = composerState(chat);
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.placeholder = composer.placeholder;
  prompt.disabled = chat.state === 'ended' || !chat.exists;
  page.querySelector<HTMLButtonElement>('#send-prompt')!.disabled = !composer.canSend;
  page.querySelector<HTMLButtonElement>('#stop-agent')!.disabled = !composer.canStop;
  page.querySelector<HTMLButtonElement>('#end-agent')!.disabled = chat.state === 'ended' || !chat.exists;

  const signIn = page.querySelector<HTMLElement>('#chat-sign-in')!;
  const signingIn = chat.state === 'signIn';
  signIn.hidden = !signingIn && chat.notice === null;
  signIn.innerHTML = signingIn
    ? `<p>${escapeHtml(chat.notice ?? `Sign in to ${chat.name}.`)}</p><div class="chat-options">${chat.signInMethods.map((method) =>
      `<button type="button" class="secondary-button" data-sign-in="${escapeAttribute(method.id)}" title="${escapeAttribute(method.description ?? '')}">${escapeHtml(method.name)}</button>`).join('')}</div>`
    : chat.notice === null || chat.state === 'ended' ? '' : `<p>${escapeHtml(chat.notice)}</p>`;
  if (!signingIn && (chat.notice === null || chat.state === 'ended')) signIn.hidden = true;

  const log = page.querySelector<HTMLElement>('#chat-log')!;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const ids = changed ?? orderedEntries(chat).map((entry) => entry.id);
  if (changed === null) log.innerHTML = '';
  for (const id of ids) {
    const entry = chat.entries.get(id);
    if (entry === undefined) continue;
    const held = log.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
    const template = document.createElement('template');
    template.innerHTML = entryMarkup(entry, chat.name).trim();
    const next = template.content.firstElementChild as HTMLElement;
    if (held !== null) {
      // A details the person opened stays open as the entry grows.
      const opened = [...held.querySelectorAll('details'), ...(held instanceof HTMLDetailsElement ? [held] : [])].map((details) => details.open);
      held.replaceWith(next);
      [...next.querySelectorAll('details'), ...(next instanceof HTMLDetailsElement ? [next] : [])].forEach((details, index) => {
        if (opened[index]) details.open = true;
      });
    } else {
      const after = [...log.children].find((child) => (chat.entries.get((child as HTMLElement).dataset.entryId ?? '')?.order ?? 0) > entry.order);
      log.insertBefore(next, after ?? null);
    }
  }
  if (log.children.length === 0) {
    log.innerHTML = `<div class="quiet-state chat-empty"><strong>${escapeHtml(chat.exists ? `${chat.name} is here` : 'No conversation')}</strong><p>${escapeHtml(chat.exists
      ? 'Ask it to read this file, add records or shape a screen. Changes it proposes wait on the Agent page for you to review.'
      : 'Launch an agent from the Agent page.')}</p></div>`;
  } else {
    log.querySelector('.chat-empty')?.remove();
  }
  if (nearBottom || changed === null) log.scrollTop = log.scrollHeight;
}
