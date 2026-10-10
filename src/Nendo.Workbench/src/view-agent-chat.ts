import { fileScopedClearable, state } from './app-state';
import { client } from './client';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import type { AgentStatus, LaunchableAgents, LaunchedAgentView } from './host';
import { icon } from './icons';
import { chatActivity, chatTabStatus, composerState, emptyChat, itemMarkup, mergeChat, optionsMarkup, reviewHint, stateLabel, stateTone, threadItems, waitingForYou, type AgentChat, type ChatActivity } from './agent-chat-model';
import { announce, content, rerender, showError } from './shell';
import { drawTabs, onTabClosed, openTabOn, setTabStatus, tabsHolding } from './workspace-tabs';
import { clearPointedAt, mentionKey, pointedAt, resetMentions, wireMentions } from './agent-mention';

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
    resetMentions();
  },
});

/**
 * The conversation's tab says what the agent is doing (W-200): starting, working, thinking or
 * waiting for the person, so it shows from any other tab. The strip is redrawn only when that
 * changes, not on every word the agent streams.
 */
let shownActivity: ChatActivity = 'none';
setTabStatus((place) => place.view === 'agentChat' ? chatTabStatus(chatActivity(chat)) : null);

function noteActivity(): void {
  const now = chatActivity(chat);
  if (now === shownActivity) return;
  shownActivity = now;
  drawTabs();
  // A turn that ends, or a question, is when a proposal may have been made or accepted.
  void checkWaiting();
}

/**
 * The Agent page, opened in a tab of its own so the conversation keeps its tab: on Activity when
 * the person goes to review. The page registers how, since it imports this module.
 */
let openAgentPage: (review: boolean) => void = () => document.querySelector<HTMLButtonElement>('#nav-agent')?.click();
export function setAgentPageOpener(open: (review: boolean) => void): void {
  openAgentPage = open;
}

/** What waits for review, read again when the agent's activity changes and when the tab is drawn. */
let checking = false;
async function checkWaiting(): Promise<void> {
  if (checking || !state.session.hasFile || client.mode === 'unavailable') return;
  checking = true;
  try {
    state.agentStatus = await client.request<AgentStatus>('agent.getStatus');
  } catch {
    // The last status stands; the hint is a pointer, not a promise.
  } finally {
    checking = false;
  }
  patchReview();
}

function patchReview(): void {
  const slot = content.querySelector<HTMLElement>('[data-agent-chat] #chat-review');
  if (slot === null) return;
  const hint = reviewHint(chat.level, state.agentStatus?.pendingProposals.length ?? 0);
  const html = hint.waiting
    ? `<button id="chat-review-open" class="text-button chat-review-link" type="button">${escapeHtml(hint.text)}</button>`
    : escapeHtml(hint.text);
  if (slot.dataset.drawn === html) return;
  slot.dataset.drawn = html;
  slot.innerHTML = html;
  slot.classList.toggle('is-waiting', hint.waiting);
}

/**
 * Closing the conversation's tab ends the agent, and everything it started (ADR-0030). The tab
 * that owns it is the one whose trail holds it, wherever that tab has since gone: it ends when the
 * last such tab closes, not when any tab that happens to show it does (ACP-06).
 */
onTabClosed((places) => {
  if (!places.some((place) => place.view === 'agentChat') || tabsHolding('agentChat') > 0 || !chat.exists || chat.state === 'ended') return;
  void (async () => {
    try {
      const key = launchKey();
      const view = await client.request<LaunchedAgentView>('agentSession.end', withConversation({ after: chat.revision }));
      if (key === launchKey()) mergeChat(chat, view, key);
      noteActivity();
      announce(`${chat.name} ended with its tab.`);
    } catch (error) {
      showError(messageFor(error));
    }
  })();
});

/**
 * The agent's More panel closes when the person is done with it: a press anywhere else, Escape,
 * or a choice in it. It stayed open until More was pressed again.
 */
document.addEventListener('pointerdown', (event) => {
  const target = event.target instanceof Node ? event.target : null;
  for (const more of content.querySelectorAll<HTMLDetailsElement>('[data-agent-chat] details.chat-more[open]')) {
    if (target === null || !more.contains(target)) more.open = false;
  }
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const more = content.querySelector<HTMLDetailsElement>('[data-agent-chat] details.chat-more[open]');
  if (more === null) return;
  // Escape closes the panel and does nothing else: it would also stop a working agent.
  event.preventDefault();
  event.stopImmediatePropagation();
  more.open = false;
  more.querySelector('summary')?.focus();
}, true);

/** End this conversation and start the same agent again, in this tab. */
async function newSession(): Promise<void> {
  const agentId = chat.agentId;
  if (agentId === null) return;
  if (chat.exists && chat.state !== 'ended' && !(await act('agentSession.end', {}, null))) return;
  await launchAgent(agentId);
}

/** The key of the conversation this renderer is following: the file session and its launch. */
function launchKey(): string {
  return `${state.session.fileSessionId ?? ''}|${launches}`;
}

/**
 * A request names the conversation it was meant for, once a read has said which, so the host
 * refuses it when that conversation has been replaced (ACP-07).
 */
function withConversation(payload: Record<string, unknown>): Record<string, unknown> {
  return chat.conversationId === null ? payload : { ...payload, conversationId: chat.conversationId };
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
    // The whole composer starts again: the message, and what it pointed at (ACP-02).
    draft = '';
    resetMentions();
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

/** Hide an agent from Launch on this device, or show it again (W-199). */
export async function setAgentHidden(agentId: string, hidden: boolean): Promise<LaunchableAgents> {
  return client.request<LaunchableAgents>('agentSession.setHidden', { agentId, hidden });
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
          // The launch this read is of is fixed before it goes out: an answer that arrives after
          // New session, or after the file changed, belongs to the old one and is dropped (ACP-07).
          const key = launchKey();
          const view = await client.request<LaunchedAgentView>('agentSession.read', { after: chat.revision });
          if (key !== launchKey()) { readAgain = true; break; }
          mergeChat(chat, view, key);
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
    // Read again: the access level and what it does with a change may have moved while the
    // transcript did not (ACP-12).
    followAgentChat();
    return;
  }
  drawn.clear();
  drawnOptions = '';
  // Design A of the composer (W-200): what this conversation works on in small chips above the
  // box, the agent's own options quietly inside it with + and Send, and the keys under it.
  content.innerHTML = `<div class="agent-chat" data-agent-chat data-chat-key="${escapeAttribute(chat.key)}" data-testid="agent-chat">
    <header class="chat-heading">
      <div class="chat-title"><h2 id="chat-name"></h2></div>
      <span id="chat-state" class="chat-pill"><span class="chat-dot" aria-hidden="true"></span><strong id="chat-state-label"></strong></span>
      <button id="new-agent-session" class="chat-quiet" type="button" aria-label="New session" title="New session: end this conversation and start the agent again">${icon('newChat')}</button>
    </header>
    <div class="message-slot" role="alert" hidden></div>
    <div id="chat-scroll" class="chat-scroll">
      <div class="chat-column">
        <div id="chat-sign-in" class="chat-sign-in" hidden></div>
        <div id="chat-thread" class="chat-thread" role="log" aria-live="polite" aria-relevant="additions"></div>
      </div>
    </div>
    <div class="chat-dock">
      <div class="chat-context-row">
        <span class="chat-chip" title="The file this conversation works on">${icon('file')}<span id="chat-file-name"></span></span>
        <button id="chat-access" class="chat-chip is-link" type="button">${icon('health')}<span id="chat-level"></span></button>
        <span class="chat-chip"><span class="chat-chip-dot" aria-hidden="true"></span><span id="chat-agent-name"></span></span>
      </div>
      <form id="chat-composer" class="chat-composer">
        <div id="chat-attachments" class="chat-attachments" hidden></div>
        <label class="visually-hidden" for="agent-prompt">Message to the agent</label>
        <textarea id="agent-prompt" rows="2" aria-autocomplete="list" aria-controls="chat-mention" aria-expanded="false"></textarea>
        <div class="chat-toolbar">
          <button id="chat-add-context" class="chat-quiet" type="button" aria-label="Point at something in this file" title="Point at something in this file (@)">${icon('plus')}</button>
          <div id="chat-options" class="chat-options"></div>
          <span class="chat-toolbar-gap"></span>
          <button id="stop-agent" class="chat-round" type="button" aria-label="Stop" title="Stop (Esc)">${icon('stop')}</button>
          <button id="send-prompt" class="chat-round is-primary" type="submit" aria-label="Send" title="Send (Enter)">${icon('arrowUp')}</button>
        </div>
        <div id="chat-mention" class="chat-mention" role="listbox" aria-label="Point at something in this file" hidden></div>
      </form>
      <div class="chat-under"><span>Enter sends · Shift+Enter for a new line · @ points at something in the file</span><span id="chat-review"></span></div>
    </div>
  </div>`;
  const chatPage = content.querySelector<HTMLElement>('[data-agent-chat]')!;
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.value = draft;
  prompt.addEventListener('input', () => { draft = prompt.value; });
  wireMentions(chatPage);
  content.querySelector<HTMLButtonElement>('#chat-access')!.addEventListener('click', () => openAgentPage(false));
  content.querySelector<HTMLElement>('#chat-review')!.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('#chat-review-open') !== null) openAgentPage(true);
  });
  prompt.addEventListener('keydown', (event) => {
    if (mentionKey(event, chatPage, prompt)) return;
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
  content.querySelector<HTMLButtonElement>('#new-agent-session')!.addEventListener('click', () => void newSession());
  content.querySelector<HTMLElement>('#chat-options')!.addEventListener('change', (event) => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select === null || select.dataset.configId === undefined) return;
    // A choice in More is the person done with it.
    const more = select.closest<HTMLDetailsElement>('details.chat-more');
    if (more !== null) more.open = false;
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
  void checkWaiting();
  // Always read on showing the tab: the level may have changed on the Agent page (ACP-12).
  followAgentChat();
}

/** The access level changed on the Agent page: the tab shows it, and what it does with a change, at once (ACP-12). */
export function agentLevelChanged(): void {
  if (chat.exists) followAgentChat();
}

/**
 * The control in `item` that has keyboard focus, as a way to find its counterpart in the item
 * drawn to replace it: by what it does (a fold, an answer), or else by its place among the
 * item's controls. Null when focus is elsewhere.
 */
function focusedControl(item: HTMLElement): ((next: HTMLElement) => HTMLElement | null) | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !item.contains(active)) return null;
  for (const name of ['toggleSteps', 'toggleInput', 'optionId'] as const) {
    const value = active.dataset[name];
    if (value === undefined) continue;
    const attribute = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return (next) => next.querySelector<HTMLElement>(`[data-${attribute}="${CSS.escape(value)}"]`);
  }
  const controls = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('button, summary, a[href], [tabindex]')];
  const at = controls(item).indexOf(active);
  return at < 0 ? null : (next) => controls(next)[at] ?? null;
}

async function send(): Promise<void> {
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt');
  const text = prompt?.value.trim() ?? '';
  if (text === '' || !composerState(chat).canSend) return;
  const context = pointedAt();
  const sent = await act('agentSession.prompt', context.length === 0 ? { text } : { text, context }, null);
  if (!sent) return;
  draft = '';
  if (prompt !== null) prompt.value = '';
  clearPointedAt(content);
}

/** One of the tab's own requests. It answers with a read, merged like any other. */
async function act(method: string, payload: Record<string, unknown>, said: string | null): Promise<boolean> {
  try {
    const key = launchKey();
    const view = await client.request<LaunchedAgentView>(method, withConversation({ ...payload, after: chat.revision }));
    // An answer for a conversation since replaced says nothing about the one on screen (ACP-07).
    if (key !== launchKey()) return true;
    mergeChat(chat, view, key);
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
  // The tab's mark follows the chat whether or not its page is on screen.
  noteActivity();
  const page = content.querySelector<HTMLElement>('[data-agent-chat]');
  if (page === null || page.dataset.chatKey !== chat.key) {
    // Another conversation on screen: a new launch rebuilds through the renderer.
    if (page !== null && state.view === 'agentChat') rerender();
    return;
  }
  page.querySelector('#chat-name')!.textContent = chat.name;
  // The agent as it names itself, with its version where it says one; the heading already names it.
  page.querySelector('#chat-agent-name')!.textContent = chat.agentTitle ?? chat.name;
  page.querySelector('#chat-file-name')!.textContent = state.session.fileName ?? '';
  page.querySelector('#chat-level')!.textContent = chat.level;
  patchReview();
  page.querySelector<HTMLElement>('#chat-access')!.title = chat.exists
    ? `Nendo's access level for this file; open the Agent page to change it. ${chat.name} reaches this file only through ${chat.endpoint ?? 'its agent address'}, and keeps its own tools on this computer.`
    : 'No agent is running for this file.';
  page.querySelector<HTMLElement>('#chat-state')!.dataset.tone = stateTone(chat);
  page.querySelector('#chat-state-label')!.textContent = stateLabel(chat);
  const composer = composerState(chat);
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.placeholder = composer.placeholder;
  prompt.disabled = chat.state === 'ended' || !chat.exists;
  // One round button: Send, or Stop while the agent works.
  const sendButton = page.querySelector<HTMLButtonElement>('#send-prompt')!;
  const stopButton = page.querySelector<HTMLButtonElement>('#stop-agent')!;
  sendButton.disabled = !composer.canSend;
  sendButton.hidden = composer.canStop;
  stopButton.disabled = !composer.canStop;
  stopButton.hidden = !composer.canStop;
  page.querySelector<HTMLButtonElement>('#chat-add-context')!.disabled = chat.state === 'ended' || !chat.exists;
  page.querySelector<HTMLButtonElement>('#new-agent-session')!.disabled = chat.agentId === null || chat.state === 'starting';

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
      // A details the person opened stays open as the item grows, and the control they were on
      // keeps the keyboard: replacing the item took it to the page's body (ACP-05).
      const opened = [...held.querySelectorAll('details')].map((details) => details.open);
      const focused = focusedControl(held);
      held.replaceWith(next);
      [...next.querySelectorAll('details')].forEach((details, at) => { if (opened[at]) details.open = true; });
      if (focused !== null) focused(next)?.focus({ preventScroll: true });
    } else {
      thread.insertBefore(next, previous === null ? thread.firstChild : previous.nextSibling);
    }
    drawn.set(item.key, html);
    previous = next;
  });
  for (const key of [...drawn.keys()]) if (!keys.has(key)) drawn.delete(key);
  if (items.length === 0) {
    thread.innerHTML = `<div class="chat-empty"><strong>${escapeHtml(chat.exists ? `${chat.name} is ${chat.state === 'starting' ? 'starting' : 'ready'}` : 'No conversation')}</strong><p>${escapeHtml(chat.exists
      ? `Ask it to read this file, add records or shape a screen. It works at ${chat.level} through this file's address and keeps its own tools on this computer. ${reviewHint(chat.level, 0).text}.`
      : 'Launch an agent from the Agent page.')}</p></div>`;
  }
  if ((force && only === undefined) || nearBottom) scroller.scrollTop = scroller.scrollHeight;
}
