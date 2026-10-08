import { fileScopedClearable, state } from './app-state';
import { client } from './client';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import type { LaunchableAgents, LaunchedAgentView } from './host';
import { icon } from './icons';
import { composerState, emptyChat, itemMarkup, mergeChat, optionsMarkup, stateLabel, stateTone, threadItems, waitingForYou, type AgentChat } from './agent-chat-model';
import { announce, content, rerender, showError } from './shell';
import { openTabOn } from './workspace-tabs';

/**
 * The conversation with an agent launched from the Agent page, in a tab of its own (ADR-0030),
 * drawn as the owner's direction A (2026-10-08).
 *
 * The host sends a nudge whenever the conversation moves; this page reads only what changed
 * after the revision it holds and patches the thread item by item. It never redraws the
 * composer, and redraws the agent's options only when they changed and none is in use, because
 * a redraw of the whole page -- a write from the agent moves the file, and the file moving
 * redraws the screen -- would take the person's half-typed message or open list with it.
 */

const chat: AgentChat = emptyChat();
let launches = 0;
let draft = '';
let reading = false;
let readAgain = false;
/** The runs of steps the person opened, and the permission requests whose input they asked to see. */
const expanded = new Set<string>();
/** What each thread item last drew, so an unchanged item is left alone. */
const drawn = new Map<string, string>();
let drawnOptions = '';

fileScopedClearable({
  clear(): void {
    Object.assign(chat, emptyChat());
    draft = '';
    expanded.clear();
    drawn.clear();
    drawnOptions = '';
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
    expanded.clear();
    drawn.clear();
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
          mergeChat(chat, view, chat.key === '' ? launchKey() : chat.key);
          patchChat(false);
          more = view.more;
        }
      } while (readAgain);
    } catch (error) {
      if (state.view === 'agentChat') showError(messageFor(error));
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
    patchChat(false);
    return;
  }
  drawn.clear();
  drawnOptions = '';
  content.innerHTML = `<div class="agent-chat" data-agent-chat data-chat-key="${escapeAttribute(chat.key)}" data-testid="agent-chat">
    <header class="chat-heading">
      <div class="chat-title"><h2 id="chat-name"></h2><span id="chat-version" class="chat-version"></span></div>
      <span id="chat-access" class="chat-pill"><span class="chat-pill-key">Access</span><strong id="chat-level"></strong></span>
      <span id="chat-state" class="chat-pill"><span class="chat-dot" aria-hidden="true"></span><strong id="chat-state-label"></strong></span>
      <button id="end-agent" class="text-button" type="button">End</button>
    </header>
    <div class="message-slot" role="alert" hidden></div>
    <div id="chat-scroll" class="chat-scroll">
      <div class="chat-column">
        <div id="chat-sign-in" class="chat-sign-in" hidden></div>
        <div id="chat-thread" class="chat-thread" role="log" aria-live="polite" aria-relevant="additions"></div>
      </div>
    </div>
    <div class="chat-dock">
      <form id="chat-composer" class="chat-composer">
        <label class="visually-hidden" for="agent-prompt">Message to the agent</label>
        <textarea id="agent-prompt" rows="2"></textarea>
        <div class="chat-toolbar">
          <div id="chat-options" class="chat-options"></div>
          <span class="chat-hint">Enter sends</span>
          <button id="stop-agent" class="chat-icon-button" type="button" aria-label="Stop" title="Stop (Esc)">${icon('stop')}</button>
          <button id="send-prompt" class="chat-icon-button is-primary" type="submit" aria-label="Send" title="Send (Enter)">${icon('arrowUp')}</button>
        </div>
      </form>
    </div>
  </div>`;
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.value = draft;
  prompt.addEventListener('input', () => { draft = prompt.value; });
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && composerState(chat).canStop) { event.preventDefault(); void act('agentSession.cancel', {}, 'Stopping.'); return; }
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
  content.querySelector<HTMLElement>('#chat-options')!.addEventListener('change', (event) => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select === null || select.dataset.configId === undefined) return;
    const option = chat.options.find((candidate) => candidate.id === select.dataset.configId);
    void act('agentSession.setOption', { configId: select.dataset.configId, value: select.value },
      option === undefined ? null : `${option.name}: ${select.selectedOptions[0]?.text ?? select.value}.`).then((done) => {
      // A refusal puts the agent's own value back.
      if (!done) { drawnOptions = ''; patchChat(false); }
    });
  });
  const thread = content.querySelector<HTMLElement>('#chat-thread')!;
  thread.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const answer = target?.closest<HTMLButtonElement>('[data-answer-entry]');
    if (answer) {
      void act('agentSession.answer', { entryId: answer.dataset.answerEntry, optionId: answer.dataset.optionId }, `You chose ${answer.textContent ?? 'an answer'}.`);
      return;
    }
    const toggle = target?.closest<HTMLButtonElement>('[data-toggle-steps], [data-toggle-input]');
    if (toggle) {
      const key = toggle.dataset.toggleSteps ?? toggle.dataset.toggleInput!;
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      patchChat(false, key);
    }
  });
  content.querySelector<HTMLElement>('#chat-sign-in')!.addEventListener('click', (event) => {
    const method = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-sign-in]') : null;
    if (method !== null) void act('agentSession.authenticate', { methodId: method.dataset.signIn }, 'Signing in.');
  });
  patchChat(true);
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
    mergeChat(chat, view, chat.key === '' ? launchKey() : chat.key);
    patchChat(true);
    if (said !== null) announce(said);
    return true;
  } catch (error) {
    showError(messageFor(error));
    return false;
  }
}

/**
 * Bring the page on screen up to the chat: the heading, the composer's switches, the options,
 * and the thread item by item (`force` follows the newest line; `only` redraws one item).
 * Does nothing when the page is not shown.
 */
function patchChat(force: boolean, only?: string): void {
  const page = content.querySelector<HTMLElement>('[data-agent-chat]');
  if (page === null || page.dataset.chatKey !== chat.key) {
    // Another conversation on screen: a new launch rebuilds through the renderer.
    if (page !== null && state.view === 'agentChat') rerender();
    return;
  }
  page.querySelector('#chat-name')!.textContent = chat.name;
  page.querySelector('#chat-version')!.textContent = chat.agentTitle ?? chat.commandLine ?? '';
  page.querySelector('#chat-level')!.textContent = chat.level;
  page.querySelector<HTMLElement>('#chat-access')!.title = chat.exists
    ? `Nendo's access level for this file. ${chat.name} reaches this file only through ${chat.endpoint ?? 'its agent address'}, and keeps its own tools on this computer.`
    : 'No agent is running for this file.';
  page.querySelector<HTMLElement>('#chat-state')!.dataset.tone = stateTone(chat);
  page.querySelector('#chat-state-label')!.textContent = stateLabel(chat);
  const composer = composerState(chat);
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.placeholder = composer.placeholder;
  prompt.disabled = chat.state === 'ended' || !chat.exists;
  page.querySelector<HTMLButtonElement>('#send-prompt')!.disabled = !composer.canSend;
  page.querySelector<HTMLButtonElement>('#stop-agent')!.disabled = !composer.canStop;
  page.querySelector<HTMLButtonElement>('#end-agent')!.disabled = chat.state === 'ended' || !chat.exists;

  const options = page.querySelector<HTMLElement>('#chat-options')!;
  const optionsHtml = chat.state === 'ended' ? '' : optionsMarkup(chat.options);
  // An open list or More panel stays as the person has it until they are done with it.
  const inUse = options.contains(document.activeElement) || options.querySelector('details[open]') !== null;
  if (optionsHtml !== drawnOptions && !inUse) {
    options.innerHTML = optionsHtml;
    drawnOptions = optionsHtml;
  }

  const signIn = page.querySelector<HTMLElement>('#chat-sign-in')!;
  signIn.hidden = chat.state !== 'signIn';
  signIn.innerHTML = chat.state !== 'signIn' ? ''
    : `<p>${escapeHtml(chat.notice ?? `Sign in to ${chat.name}.`)}</p><div class="chat-sign-in-methods">${chat.signInMethods.map((method) =>
      `<button type="button" class="secondary-button" data-sign-in="${escapeAttribute(method.id)}" title="${escapeAttribute(method.description ?? '')}">${escapeHtml(method.name)}</button>`).join('')}</div>`;

  const scroller = page.querySelector<HTMLElement>('#chat-scroll')!;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const thread = page.querySelector<HTMLElement>('#chat-thread')!;
  const items = threadItems(chat);
  const live = chat.working && !waitingForYou(chat);
  const keys = new Set(items.map((item) => item.key));
  for (const child of [...thread.children] as HTMLElement[]) {
    if (child.dataset.item === undefined || !keys.has(child.dataset.item)) child.remove();
  }
  let previous: Element | null = null;
  items.forEach((item, index) => {
    const html = itemMarkup(item, chat.name, expanded, live && index === items.length - 1 && item.type === 'steps');
    const held = thread.querySelector<HTMLElement>(`[data-item="${CSS.escape(item.key)}"]`);
    if (held !== null && drawn.get(item.key) === html && only !== item.key) {
      previous = held;
      return;
    }
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const next = template.content.firstElementChild as HTMLElement;
    if (held !== null) {
      // A details the person opened stays open as the item grows.
      const opened = [...held.querySelectorAll('details')].map((details) => details.open);
      held.replaceWith(next);
      [...next.querySelectorAll('details')].forEach((details, at) => { if (opened[at]) details.open = true; });
    } else {
      thread.insertBefore(next, previous === null ? thread.firstChild : previous.nextSibling);
    }
    drawn.set(item.key, html);
    previous = next;
  });
  for (const key of [...drawn.keys()]) if (!keys.has(key)) drawn.delete(key);
  if (items.length === 0) {
    thread.innerHTML = `<div class="chat-empty"><strong>${escapeHtml(chat.exists ? `${chat.name} is ${chat.state === 'starting' ? 'starting' : 'ready'}` : 'No conversation')}</strong><p>${escapeHtml(chat.exists
      ? `Ask it to read this file, add records or shape a screen. It works at ${chat.level} through this file's address and keeps its own tools on this computer. Changes it proposes wait on the Agent page for you.`
      : 'Launch an agent from the Agent page.')}</p></div>`;
  }
  if ((force && only === undefined) || nearBottom) scroller.scrollTop = scroller.scrollHeight;
}
