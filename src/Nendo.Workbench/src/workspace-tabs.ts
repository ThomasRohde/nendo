import { fileScopedClearable, state, type ViewName } from './app-state';
import { recordFormIsDirty, refuseWhileDirty } from './draft-guard';
import { deferWhileBusy } from './busy-queue';
import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';
import { applicationPlans } from './plan-selection';
import { fileViewById, viewIcon } from './file-view-model';
import { typeGlyph } from './type-icons';
import { revisitCurrent } from './navigation-actions';
import { navigationTrail, type Place } from './navigation-trail';
import { closeTabAt, dragState, ownerIndex, putTabBack, readTabTrail, switchTab, trailForNewTab, trailOfTab, type Tab, type TabSet } from './tab-set';
import { announce, refreshChrome, requiredElement, rerender, showError } from './shell';
import { client } from './client';
import { messageFor } from './format';

/**
 * The places a person keeps open, as tabs in the title bar (G, Mica with tabs).
 *
 * A tab is a trail. The window draws from one trail, `navigationTrail`, and each tab keeps its own
 * places and cursor; switching tabs swaps the saved trail in and puts its current place back, the
 * way a step back does. So Back and Forward belong to the tab, as they do in File Explorer, and a
 * tab costs nothing while it is not on screen: no frame, no read, only a list of places.
 *
 * Tabs are the window's, not the file's. They are cleared with the file, like the trail.
 */

const set: TabSet = { tabs: [{ id: 1, saved: null }], active: 0 };
let nextId = 2;
/**
 * The tab that owns the page there is one of (a launched agent's conversation), by its ID: the
 * tab that last showed it. Ownership was read from the trails, which drop a place when the person
 * goes somewhere new from part-way back or after 50 more moves, so the conversation's own tab
 * then closed without ending the agent (WAU-01).
 */
let ownerTab: number | null = null;

fileScopedClearable({
  clear(): void {
    set.tabs = [{ id: nextId++, saved: null }];
    set.active = 0;
    ownerTab = null;
  },
});

const strip = requiredElement<HTMLElement>('#tab-strip');

function placeOf(tab: Tab, index: number): Place | null {
  if (index === set.active) return navigationTrail.current();
  const saved = tab.saved;
  return saved === null || saved.cursor < 0 ? null : saved.places[saved.cursor] ?? null;
}

/** What a tab is called: the record type and the view on a Use screen, Studio and its page elsewhere. */
export function tabLabel(place: Place | null): string {
  if (place === null) return state.session.fileName === null ? 'No file open' : 'New tab';
  if (place.eyebrow.startsWith('Use · ')) {
    const type = place.eyebrow.slice('Use · '.length);
    // A view named after its record type would read "Crew · Crew".
    return place.title === type ? type : `${type} · ${place.title}`;
  }
  if (place.eyebrow === 'Studio' && place.title !== 'Studio') return `Studio · ${place.title}`;
  return place.title;
}

/** A Use tab on a record type carries that type's icon, as the navigation does. */
function tabGlyph(place: Place | null): string {
  if (place?.view === 'use' && place.showOverview !== true && place.fileView === null && place.applicationEntityId !== null) {
    const plan = applicationPlans().find((candidate) => candidate.entity.semanticId === place.applicationEntityId);
    if (plan !== undefined) return typeGlyph(plan.entity.displayName);
  }
  return icon(tabIcon(place));
}

function tabIcon(place: Place | null): IconName {
  switch (place?.view) {
    case 'use': return place.showOverview === true ? 'home' : place.fileView !== null ? (fileViewById(place.fileView) === null ? 'surfaces' : viewIcon(fileViewById(place.fileView)!)) : 'box';
    case 'data': case 'structure': case 'surfaces': case 'history': case 'health': case 'help': return place.view;
    case 'agent': case 'agentProposal': case 'agentChat': return 'agent';
    case 'proposal': return 'studio';
    default: return 'file';
  }
}

/**
 * A mark a page may put on its own tab, such as a launched agent's activity (W-200), and what to
 * do when a tab showing a page is closed. Registered by the page, so the strip needs no page code.
 */
export interface TabStatus { kind: string; label: string }
let statusOf: (place: Place) => TabStatus | null = () => null;
const closedListeners: Array<(places: Place[], ownedOneOfAKind: boolean) => void> = [];

/** A page there is one of in the window: a new tab beside it starts elsewhere (ACP-06). */
const oneOfAKindView = (view: ViewName): boolean => view === 'agentChat';
const oneOfAKind = (place: Place): boolean => oneOfAKindView(place.view);

/**
 * A new launch is a new conversation: no tab owns it until one shows it, so a tab that showed the
 * last one and has gone elsewhere is not taken over, and the launch opens in a tab of its own.
 */
export function releaseOwnedPage(): void {
  ownerTab = null;
}

/** The tab on screen shows the page there is one of: it owns it from now on. */
function noteOwner(): void {
  const here = navigationTrail.current();
  if (here !== null && oneOfAKind(here)) ownerTab = set.tabs[set.active]!.id;
}

export function setTabStatus(provider: (place: Place) => TabStatus | null): void {
  statusOf = provider;
}

/**
 * Called with every place in the closed tab's trail, and whether that tab owned the page there is
 * one of, wherever it has gone since (WAU-01).
 */
export function onTabClosed(listener: (places: Place[], ownedOneOfAKind: boolean) => void): void {
  closedListeners.push(listener);
}

/** What the window's other tabs show, for pointing a launched agent at it (W-200). */
export function placesInOtherTabs(): Place[] {
  return set.tabs.flatMap((tab, index) => {
    const place = index === set.active ? null : placeOf(tab, index);
    return place === null ? [] : [place];
  });
}

/** Draw the strip. Called with the rest of the chrome, so a tab's name follows every move. */
export function drawTabs(): void {
  // Drawn after every move, so the tab that shows the one-of-a-kind page is known to own it.
  noteOwner();
  const open = state.session.fileName !== null;
  strip.hidden = !open;
  if (!open) { strip.innerHTML = ''; return; }
  const only = set.tabs.length === 1;
  // A redraw keeps keyboard focus on the tab it was on: a page's own mark (an agent starting to
  // work) redraws the strip while the person may be moving along it.
  const focused = strip.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const refocus = focused?.dataset.tab !== undefined ? `[data-tab="${focused.dataset.tab}"]`
    : focused?.dataset.closeTab !== undefined ? `[data-close-tab="${focused.dataset.closeTab}"]` : null;
  // The list holds only tabs: a close button is the pointer's, as Delete and Ctrl W are the
  // keyboard's, and New tab stands after the list (UIK-11). One tab is a Tab stop; the arrows move
  // along them. The list scrolls once the tabs reach their narrowest, and the tab on screen is
  // brought into view, so a tab opened past the window's edge is still seen (UIS-01).
  const scrolled = strip.querySelector<HTMLElement>('.tab-list')?.scrollLeft ?? 0;
  strip.innerHTML = '<div class="tab-list" role="tablist" aria-label="Open places">' + set.tabs.map((tab, index) => {
    const place = placeOf(tab, index);
    const label = tabLabel(place);
    const selected = index === set.active;
    const status = place === null ? null : statusOf(place);
    const said = status === null ? label : `${label}, ${status.label.toLowerCase()}`;
    const mark = status === null ? '' : `<span class="tab-status is-${escapeAttribute(status.kind)}" aria-hidden="true"></span><span class="visually-hidden">, ${escapeHtml(status.label.toLowerCase())}</span>`;
    return `<div class="tab${selected ? ' is-active' : ''}" role="presentation" data-tab-index="${index}">
      <button class="tab-main" type="button" role="tab" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-tab="${index}" title="${escapeAttribute(said)}">${tabGlyph(place)}<span class="tab-label">${escapeHtml(label)}</span>${mark}</button>
      <button class="tab-close" type="button" data-close-tab="${index}" tabindex="-1" aria-hidden="true" title="Close tab (Ctrl+W)" ${only ? 'disabled' : ''}>${icon('close')}</button>
    </div>`;
  }).join('') + '</div>' + `<button id="tab-new" class="tab-new" type="button" aria-label="New tab" title="New tab (Ctrl+T)">${icon('plus')}</button>`;
  const list = strip.querySelector<HTMLElement>('.tab-list');
  const active = list?.querySelector<HTMLElement>('.tab.is-active');
  if (list && active) {
    // Where the person left the list, moved only as far as the tab on screen needs.
    list.scrollLeft = scrolled;
    const room = list.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    if (box.right > room.right) list.scrollLeft += box.right - room.right;
    else if (box.left < room.left) list.scrollLeft -= room.left - box.left;
  }
  if (refocus !== null) strip.querySelector<HTMLElement>(refocus)?.focus({ preventScroll: true });
}

/**
 * Keep the place on screen in a second tab, and move to it. Nothing redraws: it is the same place.
 * A page that is one of a kind (a launched agent's conversation) is not copied: the new tab goes
 * to the place before it, or the Agent page, so one conversation never has two tabs (ACP-06).
 * `show` is false when the caller moves the new tab itself at once.
 */
export function newTab(show = true): void {
  if (state.session.fileName === null) return;
  const here = navigationTrail.current();
  const saved = navigationTrail.inspect();
  set.tabs[set.active].saved = saved;
  const tab: Tab = { id: nextId++, saved: null };
  set.tabs.splice(set.active + 1, 0, tab);
  set.active += 1;
  const copied = here !== null && oneOfAKind(here) ? trailForNewTab(saved, oneOfAKind) : here === null ? { places: [], cursor: -1 } : { places: [here], cursor: 0 };
  navigationTrail.load(copied);
  if (show && here !== null && oneOfAKind(here)) {
    if (copied.cursor < 0) { state.view = 'agent'; rerender(); }
    else void revisitCurrent();
  }
  refreshChrome();
  announce('New tab opened.');
}

/**
 * Show `view` in a tab of its own: the tab already on it, or a new one beside this tab. A page that
 * is one of a kind in the window, such as a launched agent's conversation (ADR-0030), goes to the
 * tab that owns it, wherever that tab has gone since: Open conversation opened a second tab on it
 * when its own had moved on, though one conversation never has two tabs (WAU-15).
 */
export async function openTabOn(view: ViewName): Promise<void> {
  const owner = oneOfAKindView(view) ? ownerIndex(set, ownerTab) : -1;
  const index = owner >= 0 ? owner : set.tabs.findIndex((tab, at) => placeOf(tab, at)?.view === view);
  if (index === set.active) { state.view = view; rerender(); noteOwner(); return; }
  if (index >= 0) {
    const wanted = set.tabs[index]!;
    await activateTab(index);
    // Refused, or made later when the running action ends: the tab on screen stays as it is.
    if (set.tabs[set.active] !== wanted) return;
    if (navigationTrail.current()?.view !== view) { state.view = view; rerender(); }
    noteOwner();
    return;
  }
  newTab(false);
  state.view = view;
  rerender();
  noteOwner();
}

export async function activateTab(index: number): Promise<void> {
  if (index === set.active || index < 0 || index >= set.tabs.length) return;
  // A press while a save or a read runs is made when it ends, rather than dropped (WCS-16).
  // The tab itself is held, not its place in the strip, which a tab opened or closed meanwhile moves.
  const wanted = set.tabs[index];
  if (deferWhileBusy(() => { const at = set.tabs.indexOf(wanted); if (at >= 0) void activateTab(at); })) return;
  if (refuseWhileDirty('switching tabs')) return;
  // A refused place leaves the tab that was on screen selected, with its trail (tab-set.ts).
  if (!(await switchTab(set, index, navigationTrail, revisitCurrent))) refreshChrome();
  focusActiveTab();
}

export async function closeTab(index: number): Promise<void> {
  if (set.tabs.length === 1 || index < 0 || index >= set.tabs.length) return;
  const closingTab = set.tabs[index];
  if (index === set.active && deferWhileBusy(() => { const at = set.tabs.indexOf(closingTab); if (at >= 0) void closeTab(at); })) return;
  if (index === set.active && refuseWhileDirty('switching tabs')) return;
  const closing = index === set.active ? navigationTrail.inspect() : set.tabs[index]!.saved;
  const owned = closingTab.id === ownerTab;
  const closed = await closeTabAt(set, index, navigationTrail, revisitCurrent);
  if (closed && owned) ownerTab = null;
  refreshChrome();
  focusActiveTab();
  if (closed) for (const listener of closedListeners) listener(closing?.places ?? [], owned);
}

function focusActiveTab(): void {
  strip.querySelector<HTMLButtonElement>(`[data-tab="${set.active}"]`)?.focus({ preventScroll: true });
}

/**
 * A tab let go outside the window has moved, and the click its release makes on the tab is not a
 * press of it: the tab it names has gone, and another stands at its index.
 */
let swallowClick = false;

strip.addEventListener('click', (event) => {
  if (swallowClick) { swallowClick = false; event.preventDefault(); event.stopPropagation(); return; }
  const target = event.target instanceof Element ? event.target : null;
  const close = target?.closest<HTMLButtonElement>('[data-close-tab]');
  if (close) { void closeTab(Number(close.dataset.closeTab)); return; }
  const main = target?.closest<HTMLButtonElement>('[data-tab]');
  if (main) { void activateTab(Number(main.dataset.tab)); return; }
  if (target?.closest('#tab-new')) newTab();
});

// A middle click closes a tab, as it does in every tabbed Windows app.
strip.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  const tab = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tab-index]') : null;
  if (tab) { event.preventDefault(); void closeTab(Number(tab.dataset.tabIndex)); }
});

strip.addEventListener('keydown', (event) => {
  const main = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-tab]') : null;
  if (main === null) return;
  const at = Number(main.dataset.tab);
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    const to = (at + (event.key === 'ArrowRight' ? 1 : -1) + set.tabs.length) % set.tabs.length;
    strip.querySelector<HTMLButtonElement>(`[data-tab="${to}"]`)?.focus();
  } else if (event.key === 'Delete') {
    event.preventDefault();
    void closeTab(at);
  }
});

/** The next tab, or the one before it: Ctrl Tab is in the shortcut table, Ctrl Shift Tab here. */
export function cycleTab(step: 1 | -1): void {
  void activateTab((set.active + step + set.tabs.length) % set.tabs.length);
}

/** The tab on screen goes, as Ctrl W does. */
export function closeActiveTab(): void {
  void closeTab(set.active);
}

/**
 * Whether the tabs are on screen. A narrow window hides the strip (tabs wait for a wider window,
 * docs/design/mica-direction.md), and the tab keys then acted on tabs nobody could see: Ctrl W
 * closed a conversation's tab and ended its agent (UIK-08).
 */
export function tabsShown(): boolean {
  return !strip.hidden && strip.offsetParent !== null;
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key !== 'Tab') return;
  if (document.querySelector('dialog[open]') !== null || state.session.fileName === null || !tabsShown()) return;
  event.preventDefault();
  cycleTab(-1);
});

/**
 * Open something from the navigation in a new tab: a Ctrl+click, or a middle click, on any of its
 * routes. The tab is made first, so the route then moves the new tab rather than the old one.
 *
 * Only when the route will move. A page holding unsaved typing refuses to be left, and a tab made
 * before that refusal stayed open and selected beside the sentence saying nothing had moved
 * (WCS-17): the route alone answers then, in its own words. While an action runs, the new tab and
 * the move both wait for it to end.
 */
export function wireOpenInNewTab(rail: HTMLElement): void {
  const openInNewTab = (route: HTMLButtonElement): boolean => {
    if (recordFormIsDirty()) return false;
    if (deferWhileBusy(() => { if (!route.disabled && route.isConnected) { newTab(false); route.click(); } })) return true;
    newTab(false);
    return false;
  };
  rail.addEventListener('click', (event) => {
    if (!event.ctrlKey) return;
    const route = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.nav-item, .nav-place') : null;
    if (route === null || route.disabled) return;
    if (openInNewTab(route)) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  rail.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const route = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.nav-item, .nav-place') : null;
    if (route === null || route.disabled) return;
    event.preventDefault();
    if (recordFormIsDirty()) { route.click(); return; }
    if (deferWhileBusy(() => { if (!route.disabled && route.isConnected) { newTab(false); route.click(); } })) return;
    newTab(false);
    route.click();
  });
}

/** How many tabs the window holds. */
export function tabCount(): number {
  return set.tabs.length;
}

/**
 * Whether a tab can move to a window of its own (W-277): in the Desktop host, with a file open,
 * the tabs on screen and more than one of them. A window keeps its last tab.
 */
export function tabsCanMove(): boolean {
  return client.mode === 'desktop' && state.session.fileName !== null && set.tabs.length > 1 && tabsShown();
}

/**
 * Move tab `index` to a window of its own (W-277, ADR-0002 2026-10-16). The tab leaves this
 * window first, as a close would take it but without being closed: no listener hears it, so a
 * launched agent's conversation keeps running in the window it went to. The host then opens the
 * window on its trail, at the pointer when it was let go outside this one. A window that did not
 * open puts the tab back where it stood.
 */
export async function moveTabToWindow(index: number, atPointer: boolean): Promise<void> {
  if (!tabsCanMove() || index < 0 || index >= set.tabs.length) return;
  const moving = set.tabs[index]!;
  if (index === set.active && deferWhileBusy(() => { const at = set.tabs.indexOf(moving); if (at >= 0) void moveTabToWindow(at, atPointer); })) return;
  if (index === set.active && refuseWhileDirty('moving the tab')) return;
  const saved = trailOfTab(set, index, navigationTrail);
  if (saved === null) return;
  const owned = moving.id === ownerTab;
  if (!(await closeTabAt(set, index, navigationTrail, revisitCurrent))) { refreshChrome(); return; }
  if (owned) ownerTab = null;
  refreshChrome();
  try {
    await client.request('window.detachTab', { trail: JSON.stringify(saved), atPointer });
    announce('The tab moved to a new window.');
  } catch (error) {
    putTabBack(set, index, moving, saved);
    if (owned) ownerTab = moving.id;
    refreshChrome();
    showError(messageFor(error));
  }
  focusActiveTab();
}

/** The tab on screen moves to a window of its own, as the command palette's Move tab to new window does. */
export function moveActiveTabToWindow(): void {
  void moveTabToWindow(set.active, false);
}

/**
 * This window was opened for a tab moved out of another (W-277): its one tab takes that tab's
 * trail, and shows the place it was on. A trail that cannot be read leaves the window where it
 * opened, on the file's first screen.
 */
export async function adoptTab(text: string): Promise<void> {
  const saved = readTabTrail(text);
  if (saved === null) return;
  set.tabs = [{ id: nextId++, saved: null }];
  set.active = 0;
  navigationTrail.load(saved);
  if (!(await revisitCurrent())) navigationTrail.clear();
  refreshChrome();
}

/**
 * A tab dragged out of the strip and let go outside the window moves to a window of its own, where
 * it was let go. The browser keeps sending a held mouse's moves and its release to the page after
 * the pointer leaves the window, aimed at the document rather than the strip, so the drag listens
 * on the window from the press until the release. A drag let go inside the window, or a press that
 * never moved, is the click it always was.
 */
let drag: { index: number; pointerId: number; startX: number; startY: number; tab: HTMLElement; out: boolean } | null = null;

strip.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || drag !== null || !tabsCanMove()) return;
  const main = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tab]') : null;
  const tab = main?.closest<HTMLElement>('[data-tab-index]');
  if (!main || !tab) return;
  drag = { index: Number(main.dataset.tab), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, tab, out: false };
  window.addEventListener('pointermove', moveDrag, true);
  window.addEventListener('pointerup', releaseDrag, true);
  window.addEventListener('pointercancel', cancelDrag, true);
});

function moveDrag(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  const where = dragState(drag.startX, drag.startY, event.clientX, event.clientY, window.innerWidth, window.innerHeight);
  if (where === 'press') return;
  drag.tab.classList.add('is-dragging');
  drag.out = where === 'out';
  drag.tab.classList.toggle('is-leaving', drag.out);
}

function endDrag(event: PointerEvent, cancelled: boolean): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  const ended = drag;
  drag = null;
  window.removeEventListener('pointermove', moveDrag, true);
  window.removeEventListener('pointerup', releaseDrag, true);
  window.removeEventListener('pointercancel', cancelDrag, true);
  ended.tab.classList.remove('is-dragging', 'is-leaving');
  // Where it was let go, not where it was last seen moving: a quick flick ends past the edge.
  const out = !cancelled && dragState(ended.startX, ended.startY, event.clientX, event.clientY, window.innerWidth, window.innerHeight) === 'out';
  if (!out) return;
  swallowClick = true;
  // The click a release makes comes straight after it, or not at all when the release was off the tab.
  window.setTimeout(() => { swallowClick = false; }, 0);
  void moveTabToWindow(ended.index, true);
}

function releaseDrag(event: PointerEvent): void { endDrag(event, false); }
function cancelDrag(event: PointerEvent): void { endDrag(event, true); }
