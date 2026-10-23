import { fileScopedClearable, state } from './app-state';
import { client } from './client';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import type { AgentStatus, LaunchableAgents, LaunchedAgentView } from './host';
import { icon } from './icons';
import { chatActivity, chatTabStatus, composerState, createMarkupCache, emptyChat, mergeChat, reviewHint, signInMarkup, stateLabel, stateTone, threadItems, usageChip, waitingForYou, type AgentChat, type ChatActivity } from './agent-chat-model';
import { announce, content, rerender, showError, showKeptAlert } from './shell';
import { drawTabs, onTabClosed, openTabOn, releaseOwnedPage, setTabStatus } from './workspace-tabs';
import { clearPictures, heldPictureCount, resetPictures, stagePictures, wirePictures } from './agent-images';
import { fillPictures, resetShownPictures, type PictureWindow } from './agent-pictures';
import { questionAnswer, type QuestionRaw } from './agent-question-model';
import { clearPointedAt, composerNote, mentionKey, pointedAt, resetMentions, wireMentions } from './agent-mention';
import { commandKey, commandsChanged, wireCommands } from './agent-command-menu';
import { keysLine } from './agent-command-model';

/**
 * The conversation with an agent launched from the Agent page, in a tab of its own (ADR-0030).
 *
 * The host sends a nudge whenever the conversation moves; this page reads only what changed
 * after the revision it holds and patches the thread item by item. It never redraws the
 * composer, because a redraw of the whole page -- a write from the agent moves the file, and the
 * file moving redraws the screen -- would take the person's half-typed message with it. The
 * agent's own options are set on the Agent page, which draws them from this chat (ADR-0033).
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
/** Each item's markup, built again only when something it draws changed. */
const markup = createMarkupCache();
/** The agent's commands as the menu last had them, so a read that did not change them leaves it alone. */
let shownCommands = '';
/** A launch or a message on its way: a second press waits for its answer. */
let launching = false;
let sending = false;

fileScopedClearable({
  clear(): void {
    Object.assign(chat, emptyChat());
    draft = '';
    expanded.clear();
    drawn.clear();
    markup.clear();
    askedPermissions.clear();
    resetMentions();
    resetPictures();
    toldSignIn = null;
  },
});

/**
 * Who hears that the chat moved: the Agent page, which draws the agent's options, and the
 * views that message the agent (ADR-0033). Told after every read is merged.
 */
const chatListeners = new Set<() => void>();
export function onAgentChatChanged(listener: () => void): () => void {
  chatListeners.add(listener);
  return () => { chatListeners.delete(listener); };
}

/** The conversation as this window holds it, to read and never to change. */
export function agentChatNow(): Readonly<AgentChat> {
  return chat;
}

/**
 * The permission requests already said in a notice, so each is said once; and the conversation
 * a sign-in notice was said for. A person on another page, perhaps in the view that started the
 * agent, would otherwise not know the agent waits for them.
 */
const askedPermissions = new Set<string>();
let toldSignIn: string | null = null;

function noteForOthers(): void {
  for (const listener of chatListeners) {
    try { listener(); } catch (error) { console.error(error); }
  }
  if (state.view === 'agentChat') return;
  if (chat.state === 'signIn' && chat.conversationId !== null && toldSignIn !== chat.conversationId) {
    toldSignIn = chat.conversationId;
    showKeptAlert(`${chat.name} needs you to sign in.`, { label: 'Open conversation', run: openAgentChat });
    return;
  }
  for (const entry of chat.entries.values()) {
    if (entry.kind !== 'permission' || entry.answer !== null || askedPermissions.has(`${chat.key}|${entry.id}`)) continue;
    askedPermissions.add(`${chat.key}|${entry.id}`);
    showKeptAlert(`${chat.name} is asking for permission: ${entry.title ?? 'a tool call'}.`, { label: 'Open conversation', run: openAgentChat });
    return;
  }
}

/**
 * The conversation's tab says what the agent is doing: starting, working, thinking or
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

/** Open the Agent page beside what the person is on, for a view's card that points there (ADR-0033). */
export function showAgentPage(): void {
  openAgentPage(false);
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
 * that owns it is the one that last showed it, wherever that tab has since gone, known by
 * the tab itself rather than by what its trail still holds, which Back and the trail's bound drop.
 * No other tab's close ends it.
 */
onTabClosed((_places, ownedConversation) => {
  if (!ownedConversation || !chat.exists || chat.state === 'ended') return;
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

/** The empty state as last written into the log. */
let drawnEmpty: string | null = null;

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
 * refuses it when that conversation has been replaced.
 */
function withConversation(payload: Record<string, unknown>): Record<string, unknown> {
  return chat.conversationId === null ? payload : { ...payload, conversationId: chat.conversationId };
}

/** The tab's title: the agent's name. */
export function agentChatTitle(): string {
  return chat.exists ? chat.name : 'Agent';
}

/**
 * Launch an agent for a custom view's message (ADR-0033), without opening its tab: the person
 * stays in the view. The conversation is followed as any other, and its tab opens from a notice
 * or the Agent page. Throws the host's refusal.
 */
export async function launchAgentForView(agentId: string, settings: Record<string, string> = {}): Promise<void> {
  if (launching) throw new Error('An agent is already being launched.');
  launching = true;
  try {
    const view = await client.request<LaunchedAgentView>('agentSession.launch', { agentId, ...(Object.keys(settings).length === 0 ? {} : { settings }) });
    launches += 1;
    expanded.clear();
    drawn.clear();
    markup.clear();
    mergeChat(chat, view, launchKey());
    draft = '';
    resetMentions();
    resetPictures();
    resetShownPictures();
    patchChat(false);
    announce(`${chat.name} is starting.`);
    followAgentChat();
  } finally {
    launching = false;
  }
}

/** Launch an agent from the Agent page and open its conversation in a new tab. */
export async function launchAgent(agentId: string): Promise<void> {
  // A second press while the launch is on its way was a second launch, refused as already running
  // and shown in the new tab as an error.
  if (state.actionInFlight || launching) return;
  launching = true;
  const held = [...content.querySelectorAll<HTMLButtonElement>('[data-launch-agent]:not(:disabled)')];
  for (const button of held) button.disabled = true;
  try {
    const view = await client.request<LaunchedAgentView>('agentSession.launch', { agentId });
    launches += 1;
    expanded.clear();
    drawn.clear();
    // Entry IDs and revisions start again with every launch: the old one's markup is never drawn for the new one.
    markup.clear();
    mergeChat(chat, view, launchKey());
    // The whole composer starts again: the message, and what it pointed at.
    draft = '';
    resetMentions();
    resetPictures();
    resetShownPictures();
    releaseOwnedPage();
    await openTabOn('agentChat');
    announce(`${chat.name} is starting in a new tab.`);
    followAgentChat();
    // The page was rebuilt; the keyboard goes where the next step is typed.
    content.querySelector<HTMLTextAreaElement>('#agent-prompt:not(:disabled)')?.focus();
  } catch (error) {
    showError(messageFor(error));
  } finally {
    launching = false;
    for (const button of held) if (button.isConnected) button.disabled = false;
  }
}

/** Open the running conversation: its tab if one shows it, otherwise a new one. */
export async function openAgentChat(): Promise<void> {
  if (chat.key === '') mergeChat(chat, await client.request<LaunchedAgentView>('agentSession.read', { after: 0 }), launchKey());
  await openTabOn('agentChat');
  followAgentChat();
}

/** Set one of the agent's own options, from the Agent page (ADR-0033). Answers whether the agent took it. */
export function setAgentOption(configId: string, value: string, said: string): Promise<boolean> {
  return act('agentSession.setOption', { configId, value }, said);
}

/** Keep the person's own command line on this device. */
export async function saveAgentCommand(commandLine: string): Promise<LaunchableAgents> {
  return client.request<LaunchableAgents>('agentSession.setCommand', { commandLine });
}

/** Hide an agent from Launch on this device, or show it again. */
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
          // New session, or after the file changed, belongs to the old one and is dropped.
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
    // transcript did not.
    followAgentChat();
    return;
  }
  drawn.clear();
  // Design A of the composer: what this conversation works on in small chips above the
  // box, + and Send inside it, and the keys under it. The agent's options are on the Agent page.
  content.innerHTML = `<div class="agent-chat" data-agent-chat data-chat-key="${escapeAttribute(chat.key)}" data-testid="agent-chat">
    <header class="chat-heading">
      <div class="chat-title"><h2 id="chat-name"></h2><span id="chat-session-title" class="chat-session-title" hidden></span></div>
      <span id="chat-state" class="chat-pill"><span class="chat-dot" aria-hidden="true"></span><strong id="chat-state-label"></strong></span>
      <button id="new-agent-session" class="chat-quiet" type="button" aria-label="New session" title="New session: end this conversation and start the agent again">${icon('newChat')}</button>
    </header>
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
        <span id="chat-usage" class="chat-chip" hidden>${icon('gauge')}<span id="chat-usage-label"></span></span>
      </div>
      <form id="chat-composer" class="chat-composer" data-media-drop>
        <div id="chat-attachments" class="chat-attachments" hidden></div>
        <div id="chat-pictures" class="chat-attachments" hidden></div>
        <p id="chat-composer-note" class="chat-composer-note" hidden></p>
        <label class="visually-hidden" for="agent-prompt">Message to the agent</label>
        <textarea id="agent-prompt" rows="2" aria-autocomplete="list" aria-controls="chat-mention" aria-haspopup="listbox"></textarea>
        <div class="chat-toolbar">
          <button id="chat-add-context" class="chat-quiet" type="button" aria-label="Point at something in this file" title="Point at something in this file (@)">${icon('plus')}</button>
          <button id="chat-add-picture" class="chat-quiet" type="button" aria-label="Add a picture" title="Add a picture. You can also paste one into the box or drop one on it." hidden>${icon('image')}</button>
          <input id="chat-picture-input" type="file" multiple hidden tabindex="-1">
          <span class="chat-toolbar-gap"></span>
          <button id="stop-agent" class="chat-round" type="button" aria-label="Stop" title="Stop (Esc in the message box)">${icon('stop')}</button>
          <button id="send-prompt" class="chat-round is-primary" type="submit" aria-label="Send" title="Send (Enter)">${icon('arrowUp')}</button>
        </div>
        <div id="chat-mention" class="chat-mention" role="listbox" aria-label="Point at something in this file" hidden></div>
        <div id="chat-commands" class="chat-mention chat-commands" role="listbox" aria-label="The agent's commands" hidden></div>
      </form>
      <div class="chat-under"><span id="chat-keys"></span><span id="chat-command-hint" class="chat-command-hint" hidden></span><span id="chat-review"></span></div>
    </div>
  </div>`;
  const chatPage = content.querySelector<HTMLElement>('[data-agent-chat]')!;
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  prompt.value = draft;
  prompt.addEventListener('input', () => { draft = prompt.value; });
  wireMentions(chatPage);
  wirePictures(chatPage, () => ({ takesImages: chat.takesImages, name: chat.name }));
  shownCommands = '';
  wireCommands(chatPage, () => ({ list: chat.commands, agent: chat.name }));
  content.querySelector<HTMLButtonElement>('#chat-access')!.addEventListener('click', () => openAgentPage(false));
  content.querySelector<HTMLElement>('#chat-review')!.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('#chat-review-open') !== null) openAgentPage(true);
  });
  prompt.addEventListener('keydown', (event) => {
    if (mentionKey(event, chatPage, prompt)) return;
    if (commandKey(event, chatPage, prompt)) return;
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
  const thread = content.querySelector<HTMLElement>('#chat-thread')!;
  thread.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const decline = target?.closest<HTMLButtonElement>('[data-question-decline]');
    if (decline) {
      void act('agentSession.respond', { entryId: decline.dataset.questionDecline, action: 'decline' }, 'You declined the question.');
      return;
    }
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
  // A question the agent asks in a form: the answer goes when the form is sent, by its button or Enter.
  thread.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement && event.target.matches('[data-question]') ? event.target : null;
    if (form === null) return;
    event.preventDefault();
    const entry = chat.entries.get(form.dataset.question!);
    if (entry === undefined || entry.fields === undefined || entry.fields === null) return;
    const answer = questionAnswer(entry.fields, questionRaw(form));
    const error = form.querySelector<HTMLElement>('.chat-question-error')!;
    if ('error' in answer) { error.textContent = answer.error; error.hidden = false; return; }
    error.hidden = true;
    void act('agentSession.respond', { entryId: entry.id, action: 'accept', content: answer.content }, 'Your answer was sent.');
  });
  content.querySelector<HTMLElement>('#chat-sign-in')!.addEventListener('click', (event) => {
    const method = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-sign-in]') : null;
    if (method === null || method.disabled || chat.signingIn) return;
    // Held at once, before the host's answer says a sign-in runs.
    for (const button of content.querySelectorAll<HTMLButtonElement>('#chat-sign-in [data-sign-in]')) button.disabled = true;
    void act('agentSession.authenticate', { methodId: method.dataset.signIn }, 'Signing in.');
  });
  patchChat(true);
  void checkWaiting();
  // Always read on showing the tab: the level may have changed on the Agent page.
  followAgentChat();
}

/** The access level changed on the Agent page: the tab shows it, and what it does with a change, at once. */
export function agentLevelChanged(): void {
  if (chat.exists) followAgentChat();
}

/**
 * The control in `item` that has keyboard focus, as a way to find its counterpart in the item
 * drawn to replace it: by what it does (a fold, an answer, a disclosure's own part), or else by
 * its place among the item's controls. Null when focus is elsewhere.
 */
function focusedControl(item: HTMLElement): ((next: HTMLElement) => HTMLElement | null) | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !item.contains(active)) return null;
  // A disclosure's summary by the entry and part it shows: by position, focus moved to another
  // step's when an earlier step gained a disclosure.
  const part = active.tagName === 'SUMMARY' ? active.parentElement?.dataset.part : undefined;
  if (part !== undefined) return (next) => next.querySelector<HTMLElement>(`details[data-part="${CSS.escape(part)}"] > summary`);
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

/** What a question's controls hold: a box's text, a list's value, yes or no, the ticked choices. */
function questionRaw(form: HTMLFormElement): QuestionRaw {
  const raw: QuestionRaw = {};
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-question-field]')) {
    const name = control.dataset.questionField!;
    if (control instanceof HTMLInputElement && control.type === 'checkbox' && control.closest('.chat-question-choices') !== null) {
      const ticked = Array.isArray(raw[name]) ? raw[name] : [];
      if (control.checked) ticked.push(control.value);
      raw[name] = ticked;
    } else if (control instanceof HTMLInputElement && control.type === 'checkbox') raw[name] = control.checked;
    else raw[name] = control.value;
  }
  return raw;
}

async function send(): Promise<void> {
  const prompt = content.querySelector<HTMLTextAreaElement>('#agent-prompt');
  const text = prompt?.value.trim() ?? '';
  // A picture alone is a message.
  if (text === '' && heldPictureCount() === 0) return;
  // The message is on its way: a second Enter sent it again, and the host's refusal of the copy
  // was shown as an error although the first went through.
  if (sending) return;
  if (!composerState(chat).canSend) {
    // The text is kept; the person is told why it did not go, on screen as well as aloud: the
    // placeholder that says so is hidden once the box has text.
    const page = content.querySelector<HTMLElement>('[data-agent-chat]');
    const why = chat.working ? `${chat.name} is working. Your message waits here: stop it, or wait for it to finish, then send.`
      : chat.exists && chat.state !== 'ended' ? `${chat.name} is not ready yet. Wait for it, then send.` : null;
    if (why !== null && page !== null) composerNote(page, why);
    return;
  }
  sending = true;
  const sendButton = content.querySelector<HTMLButtonElement>('#send-prompt');
  if (sendButton !== null) sendButton.disabled = true;
  try {
    const context = pointedAt();
    let images: Array<{ uploadKey: string; name: string }> = [];
    try {
      images = await stagePictures((payload) => client.request('agentSession.attach', withConversation(payload)));
    } catch (error) {
      showError(messageFor(error));
      return;
    }
    const sent = await act('agentSession.prompt', { text, ...(context.length === 0 ? {} : { context }), ...(images.length === 0 ? {} : { images }) }, null);
    if (!sent) return;
    draft = '';
    if (prompt !== null) {
      prompt.value = '';
      // The menus and the command's hint follow the box, which is empty now.
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    clearPointedAt(content);
    clearPictures(content);
  } finally {
    sending = false;
    patchChat(false);
  }
}

/** One of the tab's own requests. It answers with a read, merged like any other. */
async function act(method: string, payload: Record<string, unknown>, said: string | null): Promise<boolean> {
  try {
    const key = launchKey();
    const view = await client.request<LaunchedAgentView>(method, withConversation({ ...payload, after: chat.revision }));
    // An answer for a conversation since replaced says nothing about the one on screen.
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
  noteForOthers();
  const page = content.querySelector<HTMLElement>('[data-agent-chat]');
  if (page === null || page.dataset.chatKey !== chat.key) {
    // Another conversation on screen: a new launch rebuilds through the renderer.
    if (page !== null && state.view === 'agentChat') rerender();
    return;
  }
  page.querySelector('#chat-name')!.textContent = chat.name;
  // The agent's own name for the conversation, beside its name; the tab keeps the agent's name.
  const sessionTitle = page.querySelector<HTMLElement>('#chat-session-title')!;
  sessionTitle.hidden = chat.sessionTitle === null;
  sessionTitle.textContent = chat.sessionTitle ?? '';
  sessionTitle.title = chat.sessionTitle ?? '';
  // The agent as it names itself, with its version where it says one; the heading already names it.
  page.querySelector('#chat-agent-name')!.textContent = chat.agentTitle ?? chat.name;
  page.querySelector('#chat-file-name')!.textContent = state.session.fileName ?? '';
  page.querySelector('#chat-level')!.textContent = chat.level;
  const usage = usageChip(chat.usage);
  const usageChipElement = page.querySelector<HTMLElement>('#chat-usage')!;
  usageChipElement.hidden = usage === null;
  usageChipElement.title = usage?.title ?? '';
  usageChipElement.dataset.level = usage?.high === true ? 'high' : 'normal';
  page.querySelector('#chat-usage-label')!.textContent = usage?.label ?? '';
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
  const roundFocused = document.activeElement === sendButton ? 'send' : document.activeElement === stopButton ? 'stop' : null;
  sendButton.disabled = !composer.canSend || sending;
  // The note that a message waits goes once it can be sent.
  if (composer.canSend) composerNote(page, null, 'waiting');
  sendButton.hidden = composer.canStop;
  stopButton.disabled = !composer.canStop;
  stopButton.hidden = !composer.canStop;
  // Hiding the focused button took the keyboard to the page's body: Send hands it to
  // Stop, and Stop to the message box, where the next message is typed.
  if (roundFocused === 'send' && sendButton.hidden) (stopButton.hidden ? prompt : stopButton).focus({ preventScroll: true });
  if (roundFocused === 'stop' && stopButton.hidden) prompt.focus({ preventScroll: true });
  page.querySelector<HTMLButtonElement>('#chat-add-context')!.disabled = chat.state === 'ended' || !chat.exists;
  // Only for an agent that reads pictures; a picture pasted or dropped for any other says why it did not go.
  const addPicture = page.querySelector<HTMLButtonElement>('#chat-add-picture')!;
  addPicture.hidden = !chat.takesImages;
  addPicture.disabled = chat.state === 'ended' || !chat.exists;
  page.querySelector<HTMLButtonElement>('#new-agent-session')!.disabled = chat.agentId === null || chat.state === 'starting';
  page.querySelector('#chat-keys')!.textContent = keysLine(chat.commands.length > 0);
  const commandsNow = JSON.stringify(chat.commands);
  if (commandsNow !== shownCommands) {
    shownCommands = commandsNow;
    commandsChanged(page);
  }

  const signIn = page.querySelector<HTMLElement>('#chat-sign-in')!;
  signIn.hidden = chat.state !== 'signIn';
  signIn.innerHTML = signInMarkup(chat);

  const scroller = page.querySelector<HTMLElement>('#chat-scroll')!;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const thread = page.querySelector<HTMLElement>('#chat-thread')!;
  const items = threadItems(chat);
  const live = chat.working && !waitingForYou(chat);
  const keys = new Set(items.map((item) => item.key));
  // The items on screen by key, found once rather than with a search of the thread per item.
  const onScreen = new Map<string, HTMLElement>();
  for (const child of [...thread.children] as HTMLElement[]) {
    // The empty state stays while there is still nothing to show; removing it each read wrote it again.
    if (items.length === 0 && child.classList.contains('chat-empty')) continue;
    if (child.dataset.item === undefined || !keys.has(child.dataset.item)) child.remove();
    else onScreen.set(child.dataset.item, child);
  }
  let previous: Element | null = null;
  items.forEach((item, index) => {
    const html = markup.markup(item, chat.name, expanded, live && index === items.length - 1 && item.type === 'steps', chat.key);
    const held = onScreen.get(item.key) ?? null;
    if (held !== null && drawn.get(item.key) === html && only !== item.key) {
      previous = held;
      return;
    }
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const next = template.content.firstElementChild as HTMLElement;
    if (held !== null) {
      // A details the person opened stays open as the item grows, and the control they were on
      // keeps the keyboard: replacing the item took it to the page's body. Each is known
      // by the entry and part it shows, not by its place: a step that gained a disclosure earlier
      // in the run moved the open one to another step.
      const opened = new Set([...held.querySelectorAll<HTMLElement>('details[data-part]')].filter((details) => (details as HTMLDetailsElement).open).map((details) => details.dataset.part!));
      const focused = focusedControl(held);
      let shown: HTMLElement = next;
      if (held.tagName === next.tagName) {
        // The same element, its contents renewed: replacing it was a removal and an addition, and
        // the log said the whole message again for every chunk.
        for (const name of held.getAttributeNames()) if (!next.hasAttribute(name)) held.removeAttribute(name);
        for (const name of next.getAttributeNames()) held.setAttribute(name, next.getAttribute(name)!);
        held.innerHTML = next.innerHTML;
        shown = held;
      } else held.replaceWith(next);
      for (const details of shown.querySelectorAll<HTMLDetailsElement>('details[data-part]')) if (opened.has(details.dataset.part!)) details.open = true;
      // An answered request has no control left: the keyboard goes to the message box.
      if (focused !== null) (focused(shown) ?? prompt).focus({ preventScroll: true });
      previous = shown;
      drawn.set(item.key, html);
      return;
    } else {
      thread.insertBefore(next, previous === null ? thread.firstChild : previous.nextSibling);
    }
    drawn.set(item.key, html);
    previous = next;
  });
  for (const key of [...drawn.keys()]) if (!keys.has(key)) drawn.delete(key);
  markup.forget(keys);
  // While the agent streams, the log is busy: it speaks once the turn ends or the agent asks.
  thread.setAttribute('aria-busy', String(live));
  if (items.length === 0) {
    const empty = `<div class="chat-empty"><strong>${escapeHtml(chat.exists ? `${chat.name} is ${chat.state === 'starting' ? 'starting' : 'ready'}` : 'No conversation')}</strong><p>${escapeHtml(chat.exists
      ? `Ask it to read this file, add records or shape a screen. It works at ${chat.level} through this file's address and keeps its own tools on this computer. ${reviewHint(chat.level, 0).text}.`
      : 'Launch an agent from the Agent page.')}</p></div>`;
    // Written only when it changed: each read wrote it again and the log said it again. The
    // markup is compared as written; read back, the browser spells its entities differently.
    if (drawnEmpty !== empty || thread.querySelector('.chat-empty') === null) { thread.innerHTML = empty; drawnEmpty = empty; }
  } else drawnEmpty = null;
  if ((force && only === undefined) || nearBottom) scroller.scrollTop = scroller.scrollHeight;
  // The pictures the agent showed are read once each, after the entries that show them are drawn.
  void fillPictures(thread, chat.key, (imageId, offset) => client.request<PictureWindow>('agentSession.image', withConversation({ imageId, offset })));
}
