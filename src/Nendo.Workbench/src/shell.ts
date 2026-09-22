import { client } from './client';
import { state, type OutcomeNotice } from './app-state';
import { capitalise } from './format';
import { icon } from './icons';
import type { AgentWork, EffectiveTheme, ThemePreference } from './host';

/**
 * The frame index.html already provides, and the four things every view needs
 * from it: say something, show a failure, show that work is running, and follow
 * the device theme. Views own what goes inside #studio-content; nothing else in
 * the window belongs to them.
 */

const appearanceStorageKey = 'nendo.appearance';
const railStorageKey = 'nendo.rail';

/**
 * Re-render the current view, or just the frame around it.
 *
 * `render` and `updateChrome` live in main.ts, which imports every view module;
 * a view or an action importing them back would close the loop. The entry point
 * hands them over once at startup and everything else goes through here.
 *
 * The frame is separate from the content because a page holding unsaved typing
 * must not be rebuilt: after a refused save the chrome still has to follow the
 * session so the reader can leave, while the draft on screen stays exactly as
 * they left it.
 */
let renderer: (() => void) | null = null;
let chrome: (() => void) | null = null;

export function setRenderer(render: () => void, updateChrome: () => void): void {
  renderer = render;
  chrome = updateChrome;
}

/**
 * Redraw, and keep the reader's place.
 *
 * Every renderer replaces the content pane's markup, which sets its scroll back to the
 * top. That was invisible while a redraw only followed something the person had just
 * done — they were at the top anyway. It stopped being invisible the moment screens
 * started redrawing on their own account: a front page long enough to scroll would
 * haul somebody back to the top while they were reading the bottom of it.
 *
 * Only the same screen is restored. Moving to another view starts at the top, which is
 * what a new screen should do, and `data-place` is what tells the two apart — it sits on
 * the container rather than in the markup, so replacing the markup does not lose it.
 */
/**
 * Everything on screen that scrolls, in a stable order.
 *
 * The content pane is not the scroller on a Use screen — the surface inside it is, and it
 * is replaced by every redraw. Restoring the pane alone looks like a fix and changes
 * nothing, which is what the first attempt at this did.
 */
/**
 * Every element a redraw has to put back where it was.
 *
 * The page itself, each surface, and each stack of cards inside one: a matrix cell and a
 * board column scroll on their own account, and a redraw rebuilds them, so without this a
 * person who scrolled to the bottom of a cell was returned to the top by the next read
 * that happened to land. They are matched by position, which holds because the same
 * screen draws the same scrollers in the same order; a screen of a different shape is
 * refused below rather than guessed at.
 */
function scrollPositions(): HTMLElement[] {
  // The record inspector is the tallest scroller in the product and was the one left
  // out of this list. A page of tabs, related lists and calculated fields does not fit
  // its column, so a person reads down it — and every redraw put them back at the top,
  // which is how a screen refreshing behind a failed tile was reported as scrolling on
  // its own.
  return [content, ...content.querySelectorAll<HTMLElement>('.use-surface, .card-stack, .record-inspector')];
}

export function rerender(): void {
  const wasShowing = content.dataset.place ?? '';
  const wasAt = scrollPositions().map((element) => element.scrollTop);
  renderer?.();
  restoreOutcome();
  if (content.dataset.place !== wasShowing) return;
  const now = scrollPositions();
  // A different number of scrollers is a different shape of screen, and guessing which
  // one matched which would put somebody somewhere they never were.
  if (now.length !== wasAt.length) return;
  now.forEach((element, index) => {
    if (wasAt[index] > 0) element.scrollTop = wasAt[index];
  });
}

/** What is on screen, so a redraw can tell a repaint from a move to somewhere else. */
/**
 * Puts the last outcome back after a redraw. A view builds its own markup, so the slot
 * the message was written into no longer exists; without this an outcome lasted exactly
 * as long as the next automatic read.
 */
export function restoreOutcome(): void {
  if (state.lastOutcome === null) return;
  // It belongs to the page it happened on. A message that followed somebody to the next
  // screen would be reporting an action they had already left behind.
  if (state.lastOutcome.view !== state.view) { state.lastOutcome = null; return; }
  const slot = content.querySelector<HTMLElement>('.message-slot');
  if (slot === null || !slot.hidden) return;
  drawOutcome(slot, state.lastOutcome);
}

/** The slot in the shape the outcome asks for, with its Refresh view button when it has one. */
function drawOutcome(slot: HTMLElement, outcome: OutcomeNotice): void {
  slot.classList.toggle('is-done', outcome.tone === 'done');
  slot.setAttribute('role', outcome.tone === 'done' ? 'status' : 'alert');
  slot.textContent = outcome.message;
  slot.hidden = false;
  const refresh = outcome.refresh;
  if (refresh === undefined) return;
  const button = document.createElement('button');
  button.id = 'refresh-outcome-view';
  button.type = 'button';
  button.className = 'secondary-button';
  button.textContent = 'Refresh view';
  button.addEventListener('click', () => void refresh(button));
  slot.append(' ', button);
}

export function markPlace(place: string): void {
  content.dataset.place = place;
}

export function refreshChrome(): void {
  chrome?.();
}

export function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Required Workbench element is missing: ${selector}`);
  return element;
}

export const root = document.documentElement;
export const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
export const content = requiredElement<HTMLElement>('#studio-content');
export const workspaceTitle = requiredElement<HTMLElement>('#workspace-title');
export const sessionContext = requiredElement<HTMLElement>('#session-context');
export const sessionHealth = requiredElement<HTMLElement>('#session-health');
export const sessionStatus = requiredElement<HTMLElement>('#session-status');
export const sessionFile = requiredElement<HTMLElement>('#session-file');
export const sessionVersion = requiredElement<HTMLElement>('#session-version');
export const announcement = requiredElement<HTMLElement>('#announcement');
export const themeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-theme-option]'));
// The way back and the way forward, in the header's control group beside File and the
// theme. They belong to the frame rather than to any view, so they are looked up here
// with the rest of the chrome.
export const historyBack = requiredElement<HTMLButtonElement>('#nav-back');
export const historyForward = requiredElement<HTMLButtonElement>('#nav-forward');
export const railToggle = requiredElement<HTMLButtonElement>('#rail-toggle');
export const navigation = {
  use: requiredElement<HTMLButtonElement>('#nav-use'),
  studio: requiredElement<HTMLButtonElement>('#nav-studio'),
  data: requiredElement<HTMLButtonElement>('#nav-data'),
  structure: requiredElement<HTMLButtonElement>('#nav-structure'),
  surfaces: requiredElement<HTMLButtonElement>('#nav-surfaces'),
  history: requiredElement<HTMLButtonElement>('#nav-history'),
  health: requiredElement<HTMLButtonElement>('#nav-health'),
  agent: requiredElement<HTMLButtonElement>('#nav-agent'),
  help: requiredElement<HTMLButtonElement>('#nav-help'),
};

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(appearanceStorageKey);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function effectiveTheme(preference: ThemePreference): EffectiveTheme {
  return preference === 'system' ? (systemDark.matches ? 'dark' : 'light') : preference;
}

export function applyTheme(preference: ThemePreference, persist = false): void {
  const effective = effectiveTheme(preference);
  root.dataset.themePreference = preference;
  root.dataset.theme = effective;
  document.body.dataset.agThemeMode = effective;
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === preference));
  }
  if (persist) {
    try {
      window.localStorage.setItem(appearanceStorageKey, preference);
    } catch {
      // The current preference still applies when device persistence is unavailable.
    }
    announce(preference === 'system' ? 'Using the Windows theme.' : `${capitalise(preference)} theme selected.`);
  }
  if (persist && client.mode !== 'unavailable') {
    void client.request<{ notice?: string | null }>('appearance.set', { preference, effective }).then((result) => {
      if (result.notice) showError(result.notice);
    }).catch(() => {
      showError('Appearance changed in this view, but the native window could not save it. Try selecting the theme again.');
    });
  }
}

/**
 * Whether the rail is folded down to its icons.
 *
 * Like the theme, this is the person's own view of the window rather than anything in
 * the file, so it is kept for the device and survives a restart. Unlike the theme it
 * never reaches the host: the native frame draws nothing that depends on it, so a
 * bridge method and a version bump would buy nothing. Storage that refuses to answer
 * leaves the rail open, which is the state every screen is designed around.
 */
export function readRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(railStorageKey) === 'collapsed';
  } catch {
    return false;
  }
}

export function applyRail(collapsed: boolean, persist = false): void {
  root.dataset.rail = collapsed ? 'collapsed' : 'expanded';
  railToggle.setAttribute('aria-expanded', String(!collapsed));
  // The label says what pressing it does, which is the opposite of the state it is in.
  const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
  railToggle.setAttribute('aria-label', label);
  railToggle.title = label;
  railToggle.innerHTML = icon(collapsed ? 'chevronRight' : 'chevronLeft');
  if (!persist) return;
  try {
    window.localStorage.setItem(railStorageKey, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // The rail still folds in this window when device persistence is unavailable.
  }
  announce(collapsed ? 'Navigation collapsed to icons.' : 'Navigation expanded.');
}

/**
 * How long a request may run before the window offers a way out of it.
 *
 * Short enough that a person who is waiting finds the Stop button, long enough that
 * ordinary work never flashes one up. A calculation is bounded, not instant.
 */
const busyBarDelayMs = 700;
let busyBarTimer: number | null = null;

/**
 * What an agent is doing, as last pushed by the host.
 *
 * Module state rather than app state because two unrelated things read it: the status
 * bar, which draws it, and the busy bar, which names it as the reason a request is
 * taking a while. Neither owns it.
 */
let agentWork: AgentWork = { busy: false, client: '', activity: '' };
let agentPillTimer: number | null = null;
let agentPillHideTimer: number | null = null;
let agentPillShown = false;
let lastAgentWorkAt = 0;

/**
 * How long the agent has to be quiet before the indicator comes down.
 *
 * An agent at work is a burst of short calls with gaps between them, not one long one.
 * Hiding on the first gap made the indicator flicker; worse, restarting the appear timer
 * on every call meant it never reached its delay at all, and the whole of an unattended
 * build ran with nothing on screen. Measured against a real build: 27 signals, every one
 * of them under the 700 ms the pill waits for.
 */
const agentIdleMs = 1_200;

/** Whether an agent is working on the file this instant. */
export function agentIsWorking(): boolean { return agentPillShown; }

/**
 * Records what the host pushed and draws it after the same delay the busy bar uses.
 *
 * A read takes a few milliseconds and there are a lot of them, so reporting every one
 * would leave the corner of the window flickering for the whole of a build. The delay is
 * what makes the indicator mean "this is taking long enough that you noticed", which is
 * the only version of it worth having. Going idle is immediate: a stale "still writing"
 * is the one wrong thing this can say.
 */
export function setAgentWork(work: AgentWork): void {
  // An idle signal carries no client and no activity -- there is nothing running to name
  // -- so taking it whole blanked the pill to "An agent is working" the moment the run
  // ended, having never shown who it was. What is drawn keeps the last thing that was
  // actually happening; only `busy` comes from every signal.
  agentWork = {
    busy: work.busy,
    client: work.client.length > 0 ? work.client : agentWork.client,
    activity: work.activity.length > 0 ? work.activity : agentWork.activity,
  };
  if (work.busy) {
    lastAgentWorkAt = Date.now();
    if (agentPillHideTimer !== null) { window.clearTimeout(agentPillHideTimer); agentPillHideTimer = null; }
  }
  if (agentPillShown) {
    drawAgentPill();
    if (!work.busy) hideTheAgentPillSoon();
    return;
  }
  // One countdown, from the first sign of work. It is neither restarted by the next call
  // nor cancelled by the gap before it: both of those were tried, and both meant a burst
  // of short calls never reached the delay, so a whole unattended build ran behind an
  // empty status bar.
  if (!work.busy || agentPillTimer !== null) return;
  agentPillTimer = window.setTimeout(() => {
    agentPillTimer = null;
    // The agent may have finished inside the wait. Nothing appears for work that is
    // already over.
    if (!agentWork.busy && Date.now() - lastAgentWorkAt >= agentIdleMs) return;
    agentPillShown = true;
    drawAgentPill();
    if (!agentWork.busy) hideTheAgentPillSoon();
  }, busyBarDelayMs);
}

/** Takes the indicator down once the agent has been quiet for its own bounded wait. */
function hideTheAgentPillSoon(): void {
  if (agentPillHideTimer !== null) return;
  agentPillHideTimer = window.setTimeout(() => {
    agentPillHideTimer = null;
    agentPillShown = false;
    drawAgentPill();
  }, agentIdleMs);
}

/**
 * The status-bar pill, on every screen.
 *
 * It lives in the footer beside the health pill rather than on the Agent page, because
 * the Agent page is the one screen where a person already knows. Somebody in Use whose
 * window stops answering is the reader this is for.
 */
function drawAgentPill(): void {
  const pill = document.querySelector<HTMLElement>('#agent-working');
  if (pill === null) return;
  if (!agentPillShown) { pill.hidden = true; return; }
  const who = agentWork.client.length > 0 ? agentWork.client : 'An agent';
  const label = pill.querySelector<HTMLElement>('#agent-working-text');
  if (label !== null) label.textContent = `${who} is working`;
  pill.title = agentWork.activity.length > 0
    ? `${who} · ${agentWork.activity}. End it under Agent → Revoke edit access.`
    : `${who} is using this file. End it under Agent → Revoke edit access.`;
  pill.hidden = false;
}

/**
 * Whether the person currently has hold of something on this page.
 *
 * A redraw replaces the content pane, so it takes an open menu with it — the picker
 * closes under the pointer and the click lands on nothing. Nothing that redraws on
 * its own account may do so while this is true; the rule already applied to the
 * Agent page's poll, and now applies to the reads a surface chases as well.
 *
 * An open menu, a focused control and an open dialog all count. A pointer merely
 * hovering does not: waiting for somebody to move the mouse would stop the screen
 * updating for as long as it rested there.
 */
export function interactionInProgress(): boolean {
  if (document.querySelector('dialog[open]') !== null) return true;
  // An open details is a menu or a picker somebody is inside -- except a section
  // folded open, which is part of the page and stays open for as long as they like.
  // Counting it held every read on a page with one open section (W-040).
  if (content.querySelector('details[open]:not([data-section])') !== null) return true;
  if (Date.now() - lastInteractionAt < quietMs) return true;
  const focused = document.activeElement;
  return focused !== null && content.contains(focused) &&
    (focused instanceof HTMLSelectElement || focused instanceof HTMLInputElement ||
      focused instanceof HTMLTextAreaElement);
}

/**
 * Moves focus without it counting as the person doing something.
 *
 * Focus is restored across a redraw so that a keyboard user is not dropped back to the
 * top of the page, and `element.focus()` fires `focusin`, which is one of the events
 * that says somebody is interacting. So a screen that restored focus while it redrew
 * declared an interaction, held its own reads, redrew a second later, restored focus
 * again, and never got past its loading state -- for as long as the page was left alone.
 * Clicking anywhere else broke the cycle, which is exactly how it was reported: "the
 * matrix shows immediately when clicking in an empty space".
 *
 * The app moving focus is not the person touching the screen, and this is where the two
 * are told apart.
 */
export function focusWithoutInteraction(element: HTMLElement | null | undefined): void {
  if (element === null || element === undefined) return;
  restoringFocus = true;
  try { element.focus({ preventScroll: true }); } finally { restoringFocus = false; }
}

/**
 * How long the page is left alone after somebody touches it.
 *
 * An open menu is not the whole of "in use". A redraw that lands between the pointer
 * going down and the menu opening moves the target out from under the click, which is
 * the difference between a picker that works and one that has to be fought. So any
 * interaction quiets the automatic redraws briefly, and a person clicking steadily
 * keeps them quiet — the numbers resume a moment after they stop.
 */
const quietMs = 750;
let lastInteractionAt = 0;

// Focus the app moves itself is not somebody using the app; see focusWithoutInteraction.
let restoringFocus = false;

for (const kind of ['pointerdown', 'keydown', 'focusin'] as const)
  content.addEventListener(kind, () => {
    if (restoringFocus) return;
    lastInteractionAt = Date.now();
  }, true);
// Reading is using the page. A wheel never reaches the three above, so somebody moving
// down a long screen looked idle to the hold and could be redrawn out from under.
content.addEventListener('scroll', () => {
  if (restoringFocus) return;
  lastInteractionAt = Date.now();
}, { passive: true });

export function setBusy(busy: boolean): void {
  content.setAttribute('aria-busy', String(busy));
  setBusyBar(busy);
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-action], [data-file-action], .studio-content input, .studio-content select, .studio-content textarea')) {
    if (busy) {
      control.dataset.busyWasDisabled ??= String(control.disabled);
      control.disabled = true;
    } else if (control.dataset.busyWasDisabled !== undefined) {
      control.disabled = control.dataset.busyWasDisabled === 'true';
      delete control.dataset.busyWasDisabled;
    }
  }
}

/**
 * The Stop affordance for work that is taking a while.
 *
 * The host answers a stop only after the work has actually stopped, so the bar stays
 * up — saying what it is doing — until the join returns. Hiding it on the click would
 * tell the reader the file was idle while it was still being written.
 */
export function setBusyBar(busy: boolean): void {
  const bar = document.querySelector<HTMLElement>('#busy-bar');
  if (bar === null) return;
  if (busyBarTimer !== null) { window.clearTimeout(busyBarTimer); busyBarTimer = null; }
  if (!busy) { bar.hidden = true; return; }
  if (client.cancelInFlight === undefined) return;
  busyBarTimer = window.setTimeout(() => {
    busyBarTimer = null;
    // Name the cause when there is one. An agent write holds the file's one gate, so this
    // request is not slow -- it is queued behind somebody else's. Stop keeps its meaning:
    // it stops waiting for this view, and the sentence does not pretend otherwise, because
    // the thing that stops the agent is Revoke edit access on the Agent page.
    requiredElement<HTMLElement>('#busy-message').textContent = agentWork.busy
      ? `${agentWork.client.length > 0 ? agentWork.client : 'An agent'} is writing to this file…`
      : 'Still working…';
    const stop = requiredElement<HTMLButtonElement>('#stop-request');
    stop.disabled = false;
    bar.hidden = false;
  }, busyBarDelayMs);
}

export async function stopInFlightWork(): Promise<void> {
  if (client.cancelInFlight === undefined) return;
  const stop = requiredElement<HTMLButtonElement>('#stop-request');
  const message = requiredElement<HTMLElement>('#busy-message');
  stop.disabled = true;
  message.textContent = 'Stopping…';
  const outcome = await client.cancelInFlight();
  // An ignored request is one the host asked to stop and that did not. Saying so is
  // the only honest answer: the next action would otherwise race it.
  message.textContent = outcome.ignored > 0
    ? 'This is taking longer to stop than expected. Wait before starting anything else.'
    : 'Stopping…';
}

export function clearError(): void {
  state.lastOutcome = null;
  const slot = content.querySelector<HTMLElement>('.message-slot');
  if (slot !== null) {
    slot.hidden = true;
    slot.textContent = '';
    slot.classList.remove('is-done');
  }
}

/** The one slot a view says something in, made if the view has not got one. */
function messageSlot(): HTMLElement {
  const existing = content.querySelector<HTMLElement>('.message-slot');
  if (existing !== null) return existing;
  const slot = document.createElement('div');
  slot.className = 'message-slot';
  content.prepend(slot);
  return slot;
}

/**
 * Something was refused, said where the person can see it and kept there.
 *
 * A refusal is retained the way an outcome is, and for the same reason: on a Use screen
 * the reads a surface chases redraw it when they land, under a second apart, and a
 * sentence written into the pane alone lasted exactly that long. The sentence about a
 * place that had gone was once wiped before the authoring gate could read it, and a
 * person pressing Back at that moment saw nothing at all (F-086). It is put back after
 * every redraw of the view it was said on, and released by the next thing the person
 * does -- the listener below -- or by leaving the view.
 */
export function showError(message: string): void {
  state.lastOutcome = { view: state.view, message, tone: 'alert' };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
  slot.tabIndex = -1;
  focusWithoutInteraction(slot);
  slot.scrollIntoView({ block: 'nearest' });
  announce(message);
}

/**
 * A refusal is about the thing just tried, and it is stale the moment the person tries
 * the next thing. Their next press or key anywhere releases it, and the redraw that
 * follows takes it -- which is what happened before it was retained; only the redraws
 * nobody asked for are new. Not a press on the sentence itself, which somebody may be
 * selecting to copy. A notice with a Refresh view button is held until that button
 * succeeds, and a success is harmless to keep until an action clears it.
 */
for (const kind of ['pointerdown', 'keydown'] as const)
  document.addEventListener(kind, (event) => {
    const outcome = state.lastOutcome;
    if (outcome === null || outcome.tone !== 'alert' || outcome.refresh !== undefined) return;
    if (event.target instanceof Node && content.querySelector('.message-slot')?.contains(event.target) === true) return;
    state.lastOutcome = null;
  }, true);

/**
 * Something finished, said where a person can see it.
 *
 * `announce` writes into a visually hidden region, so an outcome went to a screen
 * reader and to nobody else: accepting a proposal made the panel disappear and said
 * nothing at all to the person who had just clicked the button. This is the same slot
 * an error uses, in the tone of a thing that worked rather than a thing that failed,
 * and it does not steal focus — nobody needs taking somewhere after a success.
 */
export function showOutcome(message: string): void {
  state.lastOutcome = { view: state.view, message, tone: 'done' };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
  slot.scrollIntoView({ block: 'nearest' });
  announce(message);
}

/**
 * Something finished, but the view could not be read afterwards: said in the tone of
 * a failure, with a Refresh view button, and kept until the refresh succeeds or the
 * person leaves the page. It is retained the way an outcome is because it is one:
 * written through `showError` it lasted exactly as long as the next chased read, and
 * on a Use screen that is under a second, so the sentence that said "accepted, refresh
 * to see it" and the only button that would was gone before anybody saw either (F-085).
 */
export function showRetainedNotice(message: string, refresh: (button: HTMLButtonElement) => Promise<void>): void {
  state.lastOutcome = { view: state.view, message, tone: 'alert', refresh };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
  slot.tabIndex = -1;
  focusWithoutInteraction(slot);
  slot.scrollIntoView({ block: 'nearest' });
  announce(message);
}

export function announce(message: string): void {
  announcement.textContent = '';
  window.setTimeout(() => { announcement.textContent = message; }, 0);
}
