import { client } from './client';
import { selectedSurfaces, state, type OutcomeNotice } from './app-state';
import { capitalise, releasedByNextInteraction } from './format';
import { icon } from './icons';
import type { AgentWork, EffectiveTheme, ThemePreference } from './host';
import { createAgentPill } from './agent-pill';
import { hasDeferredMove, runDeferredMove } from './busy-queue';

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
  // A Filter menu stays open across the redraw that lists a reference's records (W-172).
  // Help scrolls its index and its article rather than the pane, and a file-change redraw sent
  // an article being read back to its top once a second while an agent wrote (WST-01).
  return [content, ...content.querySelectorAll<HTMLElement>('.use-surface, .card-stack, .outline-surface-frame, .record-inspector, .quick-filter-panel, .help-index, .help-topics, .help-article, .preview-content, .grid-column-options')];
}

export function rerender(): void {
  const wasShowing = content.dataset.place ?? '';
  const wasAt = scrollPositions().map((element) => element.scrollTop);
  const focusAt = focusKey();
  renderer?.();
  restoreOutcome();
  if (content.dataset.place !== wasShowing) return;
  // A redraw replaces the pane, and a control that had the keyboard went with it: a record just
  // opened lost its inspector's focus when its related rows arrived a second later (UIK-04).
  if (focusAt !== null && (document.activeElement === null || document.activeElement === document.body))
    focusWithoutInteraction(content.querySelector<HTMLElement>(focusAt));
  const now = scrollPositions();
  // A different number of scrollers is a different shape of screen, and guessing which
  // one matched which would put somebody somewhere they never were.
  if (now.length !== wasAt.length) return;
  now.forEach((element, index) => {
    if (wasAt[index] > 0) element.scrollTop = wasAt[index];
  });
}

/** The control with the keyboard in the content pane, as a selector that finds it after a redraw. */
function focusKey(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !content.contains(active)) return null;
  if (active.id !== '') return `#${CSS.escape(active.id)}`;
  if (active.dataset.recordId !== undefined) return `[data-record-id="${CSS.escape(active.dataset.recordId)}"]`;
  const menu = active.parentElement?.closest<HTMLElement>('[data-testid]');
  if (active.tagName === 'SUMMARY' && menu?.dataset.testid !== undefined) return `[data-testid="${CSS.escape(menu.dataset.testid)}"] > summary`;
  return null;
}

/**
 * Keeps the notices true to the screen after a redraw (W-283).
 *
 * A notice used to be written into a slot in the view's own markup, so every redraw took it
 * away and this put it back; without that an outcome lasted exactly as long as the next
 * automatic read. The notices are the frame's now and a redraw leaves them where they are.
 * What a redraw still has to do is let go of a sentence about something the screen no longer
 * shows, which the view's markup used to do by replacing it.
 */
export function restoreOutcome(): void {
  const here = outcomeScreen();
  for (const earlier of noticeStack.querySelectorAll<HTMLElement>('.notice-earlier'))
    if (earlier.dataset.screen !== here) earlier.remove();
  const outcome = state.lastOutcome;
  if (outcome !== null && !saidHere(outcome, here)) state.lastOutcome = null;
  placeStack();
  if (state.lastOutcome === null) { emptySlot(); return; }
  if (outcomeSlot.hidden) drawOutcome(outcomeSlot, state.lastOutcome);
}

/**
 * The page's own action shelves, which a notice must never cover: a form's Save and Cancel, the
 * agent conversation's message box, a list's Previous and Next. They are right-aligned, which is
 * where the stack sits, and a refusal that covered Save until it was closed stood between the
 * person and the one button they needed (the shell lane's WDV-08, 2026-10-17).
 */
const actionShelves = '.form-actions, .chat-composer, .page-controls';

/**
 * Lifts the stack above any action shelf it would cover at its own place, the bottom right of
 * the layer, and puts it back there when nothing is under it. Called whenever a notice is drawn
 * and whenever the page under it is redrawn, scrolled, typed into or resized.
 */
function placeStack(): void {
  const layer = noticeStack.parentElement;
  noticeStack.style.removeProperty('bottom');
  if (layer === null || noticeStack.querySelector('.notice:not([hidden])') === null) return;
  const stack = noticeStack.getBoundingClientRect();
  const foot = layer.getBoundingClientRect().bottom;
  let lift = 0;
  for (const shelf of content.querySelectorAll<HTMLElement>(actionShelves)) {
    const box = shelf.getBoundingClientRect();
    const covered = box.width > 0 && box.right > stack.left && box.left < stack.right && box.bottom > stack.top && box.top < stack.bottom;
    if (covered) lift = Math.max(lift, foot - box.top);
  }
  if (lift > 0) noticeStack.style.bottom = `${Math.round(lift) + 8}px`;
}

function saidHere(outcome: OutcomeNotice, here: string): boolean {
  // It belongs to the page it happened on. A message that followed somebody to the next
  // screen would be reporting an action they had already left behind.
  if (outcome.view !== state.view) return false;
  if (outcome.screen !== undefined && outcome.screen !== here) return false;
  // It was about the file at one change, and a redraw at another has already read it again.
  const sequence = outcome.changeSequence;
  return sequence === undefined || sequence === (state.session.manifest?.changeSequence ?? null);
}

/**
 * Which screen a sentence is said on, finer than the view: the record type, the file's view, the
 * screen chosen for each record type, and the record open beside it. A tab inside a record page
 * or a drill is not another screen, so neither is in it.
 */
export function outcomeScreen(): string {
  return JSON.stringify([state.view, state.selectedApplicationEntity, state.selectedEntityId, state.showOverview,
    state.fileView, [...selectedSurfaces].sort(([left], [right]) => left.localeCompare(right)), state.selectedRecordId]);
}

/** The slot in the shape the outcome asks for, with its Refresh view button when it has one. */
function drawOutcome(slot: HTMLElement, outcome: OutcomeNotice): void {
  slot.setAttribute('role', outcome.tone === 'done' ? 'status' : 'alert');
  drawNotice(slot, outcome, true, () => closeOutcome());
  shownOutcome = outcome;
  slot.hidden = false;
  placeStack();
}

/**
 * One notice, in the slot or above it. The ids are the slot's alone, because the buttons are
 * found by them; a notice kept above the slot carries the same buttons without them.
 */
function drawNotice(notice: HTMLElement, outcome: OutcomeNotice, ids: boolean, close: () => void, elapsed = 0): void {
  notice.classList.toggle('is-done', outcome.tone === 'done');
  notice.classList.toggle('is-kept', outcome.tone === 'alert' && outcome.kept === true);
  notice.replaceChildren();
  const mark = document.createElement('span');
  mark.className = 'notice-icon';
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = icon(outcome.tone === 'done' ? 'check' : 'alert');
  const text = document.createElement('span');
  text.className = 'notice-text';
  text.textContent = outcome.message;
  notice.append(mark, text);
  const action = outcome.action;
  const refresh = outcome.refresh;
  if (action !== undefined || refresh !== undefined) {
    const actions = document.createElement('span');
    actions.className = 'notice-actions';
    if (action !== undefined) {
      const button = document.createElement('button');
      if (ids) button.id = 'outcome-action';
      button.type = 'button';
      button.className = 'secondary-button';
      button.textContent = action.label;
      button.addEventListener('click', () => { void action.run().catch((error: unknown) => showError(error instanceof Error ? error.message : String(error))); });
      actions.append(button);
    }
    if (refresh !== undefined) {
      const button = document.createElement('button');
      if (ids) button.id = 'refresh-outcome-view';
      button.type = 'button';
      button.className = 'secondary-button';
      button.textContent = 'Refresh view';
      button.addEventListener('click', () => void refresh(button));
      actions.append(button);
    }
    notice.append(' ', actions);
  }
  // Every sentence can be put away (owner, 2026-10-16: "add a x to remove the message"). A
  // saved download's stayed until the person left the screen, since a success is kept.
  const closer = document.createElement('button');
  closer.type = 'button';
  closer.className = 'icon-button outcome-close';
  closer.dataset.outcomeClose = '';
  closer.setAttribute('aria-label', 'Close message');
  closer.title = 'Close';
  closer.innerHTML = icon('close');
  closer.addEventListener('click', close);
  notice.append(closer);
  // A success says its piece and goes (W-283). It was kept until the next action, which was
  // harmless while it sat in the page and is not once it floats over the work. The time runs
  // as the bar along its foot, and the bar stops while the pointer or the keyboard is on the
  // notice (07-studio.css), so a sentence being read, or a button about to be pressed, stays.
  // An alert has no timer: a refusal goes at the next press, the rest when they are dealt with.
  if (outcome.tone === 'done') {
    const timer = document.createElement('span');
    timer.className = 'notice-timer';
    timer.setAttribute('aria-hidden', 'true');
    timer.style.setProperty('--notice-time', `${noticeMilliseconds(outcome)}ms`);
    if (elapsed > 0) timer.style.animationDelay = `-${Math.round(elapsed)}ms`;
    timer.addEventListener('animationend', close, { once: true });
    notice.append(timer);
  }
}

/** How long a success stays: long enough to read it, and longer when it offers a step. */
export function noticeMilliseconds(outcome: Pick<OutcomeNotice, 'message' | 'action'>): number {
  const reading = Math.min(7_000, Math.max(0, outcome.message.length - 40) * 60);
  return 5_000 + reading + (outcome.action === undefined ? 0 : 3_000);
}

/** What the slot shows, which is not always state.lastOutcome: a new one is set before it is drawn. */
let shownOutcome: OutcomeNotice | null = null;

/** The most notices on screen at once, the one in the slot included. */
const noticesShown = 3;

/**
 * A success the next action would have wiped stays above the slot for the rest of its time
 * (W-283), so two things done in a row are both said. An alert is about the thing just tried,
 * and the next thing replaces it, as it always has.
 */
function keepAsEarlier(): void {
  const outcome = shownOutcome;
  if (outcome === null || outcome.tone !== 'done' || outcomeSlot.hidden) return;
  const timer = outcomeSlot.querySelector<HTMLElement>('.notice-timer');
  const elapsed = Number(timer?.getAnimations()[0]?.currentTime ?? 0);
  const earlier = document.createElement('div');
  earlier.className = 'notice notice-earlier';
  earlier.dataset.screen = outcome.screen ?? outcomeScreen();
  drawNotice(earlier, outcome, false, () => earlier.remove(), elapsed);
  outcomeSlot.before(earlier);
  const kept = noticeStack.querySelectorAll('.notice-earlier');
  for (let index = 0; index < kept.length - (noticesShown - 1); index += 1) kept[index].remove();
}

/** The slot, empty and out of sight. */
function emptySlot(): void {
  shownOutcome = null;
  outcomeSlot.hidden = true;
  outcomeSlot.replaceChildren();
  outcomeSlot.classList.remove('is-done', 'is-kept');
  placeStack();
}

/** The person put the sentence away, or its time ran out: it goes, and a redraw does not bring it back. */
function closeOutcome(): void {
  state.lastOutcome = null;
  emptySlot();
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
/**
 * Where every sentence is said (W-283): a stack over the bottom right of the layer, above the
 * status line, that floats over the page instead of taking a row in it. The slot used to sit in
 * each view's markup between its toolbar and its content, and every notice moved the content
 * down by its own height, and back up when it went (owner, 2026-10-17: "it pushes the main
 * content down"). The newest notice is the slot; a success said before it waits above it.
 */
const noticeStack = requiredElement<HTMLElement>('#notice-stack');
const outcomeSlot = requiredElement<HTMLElement>('#outcome-slot');
// Not every way a page is drawn goes through rerender: moving to another screen draws it
// directly. Every way replaces the pane's children, so watching them is what lets a notice go
// with the screen it was said on, whichever path drew the next one.
new MutationObserver(() => restoreOutcome()).observe(content, { childList: true });
window.addEventListener('resize', () => placeStack());
for (const kind of ['scroll', 'input'] as const) content.addEventListener(kind, () => placeStack(), { capture: true, passive: true });
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
  railToggle.innerHTML = icon('menu');
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
 * What an agent is doing, as last pushed by the host, and when the pill says so.
 *
 * Module state rather than app state because two unrelated things read it: the status
 * bar, which draws it, and the busy bar, which names it as the reason a request is
 * taking a while. Neither owns it. The pill comes down once the agent has been quiet
 * for agentIdleMs.
 */
const agentIdleMs = 1_200;
const agentPill = createAgentPill(
  { set: (run, ms) => window.setTimeout(run, ms), clear: (handle) => window.clearTimeout(handle) },
  () => drawAgentPill(), busyBarDelayMs, agentIdleMs);

/**
 * Records what the host pushed; agent-pill.ts decides when the pill is drawn. The pill waits as
 * long as the busy bar, and comes down once the agent has been quiet for agentIdleMs: a gap
 * between two calls must not blink it, and an agent that has stopped must not leave it up.
 */
export function setAgentWork(work: AgentWork): void {
  agentPill.signal(work);
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
  if (!agentPill.shown) { pill.hidden = true; return; }
  const agentWork = agentPill.work;
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
  // A custom view's menu is open on the page (W-090): it lives on the body, so the test below does not see it.
  if (document.querySelector('[data-view-menu-open]') !== null) return true;
  // An open details is a menu or a picker somebody is inside -- except a section
  // folded open, which is part of the page and stays open for as long as they like.
  // Counting it held every read on a page with one open section (W-040).
  if (content.querySelector('details[open]:not([data-section])') !== null) return true;
  // The View picker and the record-type list stand in the breadcrumb, outside the content pane,
  // and a redraw replaces them too (UIS-03).
  if (placePickers?.querySelector('details[open]') != null) return true;
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

const placePickers = document.getElementById('place-pickers');
for (const kind of ['pointerdown', 'keydown', 'focusin'] as const)
  for (const area of [content, placePickers])
    area?.addEventListener(kind, () => {
      if (restoringFocus) return;
      lastInteractionAt = Date.now();
    }, true);
// Reading is using the page. A wheel never reaches the three above, so somebody moving
// down a long screen looked idle to the hold and could be redrawn out from under. Captured,
// because a scroll does not bubble: reading down a Help article, the record inspector or a
// column of cards scrolls that element, never the pane, and was not seen (WST-01).
content.addEventListener('scroll', () => {
  if (restoringFocus) return;
  lastInteractionAt = Date.now();
}, { passive: true, capture: true });

export function setBusy(busy: boolean): void {
  content.setAttribute('aria-busy', String(busy));
  setBusyBar(busy);
  // The breadcrumb's record-type picker is held with the page's controls, as it was when it
  // stood in the Use toolbar (W-092).
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-action], [data-file-action], [data-busy-hold], .studio-content input, .studio-content select, .studio-content textarea, #place-pickers select')) {
    // A custom view's own controls are not the Workbench's work to hold (W-090); a person
    // typing in its search box keeps the box while a save runs.
    if (control.closest('[data-view-toolbar]') !== null) continue;
    // Revoking an agent's edit access is how a person ends the write their own request is queued
    // behind, which the busy bar and the agent pill both send them to (WCS-20).
    if (control.id === 'revoke-agent') continue;
    if (busy) {
      control.dataset.busyWasDisabled ??= String(control.disabled);
      control.disabled = true;
    } else if (control.dataset.busyWasDisabled !== undefined) {
      control.disabled = control.dataset.busyWasDisabled === 'true';
      delete control.dataset.busyWasDisabled;
    }
  }
  // A move pressed while the action ran is made now it has ended (busy-queue.ts, WCS-16).
  if (!busy && hasDeferredMove()) window.setTimeout(runDeferredMove, 0);
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
    const agentWork = agentPill.work;
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
  keepAsEarlier();
  state.lastOutcome = null;
  emptySlot();
}

/** The one slot every sentence is said in, ready for the next one. */
function messageSlot(): HTMLElement {
  keepAsEarlier();
  return outcomeSlot;
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
  state.lastOutcome = { view: state.view, screen: outcomeScreen(), message, tone: 'alert' };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
  slot.tabIndex = -1;
  focusWithoutInteraction(slot);
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
    if (!releasedByNextInteraction(outcome)) return;
    if (event.target instanceof Node && noticeStack.contains(event.target)) return;
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
export function showOutcome(message: string, action?: OutcomeNotice['action']): void {
  state.lastOutcome = { view: state.view, screen: outcomeScreen(), message, tone: 'done', ...(action === undefined ? {} : { action }) };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
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
/**
 * Something finished, and something about it is wrong in a way that stays true: an automatic
 * action the save did not run (EBH-01). Said in the tone of an alert, but kept the way a
 * success is, until the next action clears it, and without taking the focus: a grid edit that
 * moved the focus to this sentence on every save would stop the person typing. It keeps the
 * step a success offers.
 */
export function showKeptAlert(message: string, action?: OutcomeNotice['action']): void {
  state.lastOutcome = { view: state.view, screen: outcomeScreen(), message, tone: 'alert', kept: true, ...(action === undefined ? {} : { action }) };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
  announce(message);
}

export function showRetainedNotice(message: string, refresh: (button: HTMLButtonElement) => Promise<void>, takeFocus = true): void {
  state.lastOutcome = { view: state.view, screen: outcomeScreen(), message, tone: 'alert', refresh };
  const slot = messageSlot();
  drawOutcome(slot, state.lastOutcome);
  slot.tabIndex = -1;
  // A background read that failed says so where it can be seen, without moving anybody (WCS-07).
  if (takeFocus) focusWithoutInteraction(slot);
  announce(message);
}

export function announce(message: string): void {
  announcement.textContent = '';
  window.setTimeout(() => { announcement.textContent = message; }, 0);
}
