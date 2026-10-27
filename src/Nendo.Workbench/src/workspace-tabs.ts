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
import { arrivalIndex, closeTabAt, dragState, moveTab, ownerIndex, putTabBack, readTabTrail, slotFor, switchTab, trailForNewTab, trailOfTab, type Tab, type TabSet, type TabSpan } from './tab-set';
import { windowRole } from './window-role';
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
 * then closed without ending the agent.
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
    case 'settings': return 'settings';
    case 'proposal': return 'studio';
    default: return 'file';
  }
}

/**
 * A mark a page may put on its own tab, such as a launched agent's activity, and what to
 * do when a tab showing a page is closed. Registered by the page, so the strip needs no page code.
 */
export interface TabStatus { kind: string; label: string }
let statusOf: (place: Place) => TabStatus | null = () => null;
const closedListeners: Array<(places: Place[], ownedOneOfAKind: boolean) => void> = [];

/** A page there is one of in the window: a new tab beside it starts elsewhere. */
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
 * one of, wherever it has gone since.
 */
export function onTabClosed(listener: (places: Place[], ownedOneOfAKind: boolean) => void): void {
  closedListeners.push(listener);
}

/** What the window's other tabs show, for pointing a launched agent at it. */
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
  // keyboard's, and New tab stands after the list. One tab is a Tab stop; the arrows move
  // along them. The list scrolls once the tabs reach their narrowest, and the tab on screen is
  // brought into view, so a tab opened past the window's edge is still seen.
  const scrolled = strip.querySelector<HTMLElement>('.tab-list')?.scrollLeft ?? 0;
  strip.innerHTML = '<div class="tab-list" role="tablist" aria-label="Open places">' + set.tabs.map((tab, index) => {
    const place = placeOf(tab, index);
    const label = tabLabel(place);
    const selected = index === set.active;
    const status = place === null ? null : statusOf(place);
    const said = status === null ? label : `${label}, ${status.label.toLowerCase()}`;
    const mark = status === null ? '' : `<span class="tab-status is-${escapeAttribute(status.kind)}" aria-hidden="true"></span><span class="visually-hidden">, ${escapeHtml(status.label.toLowerCase())}</span>`;
    return `<div class="tab${selected ? ' is-active' : ''}" role="presentation" data-tab-index="${index}" data-tab-id="${tab.id}">
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
  // A redraw in the middle of a drag (an agent's mark, a write) draws the dragged tab afresh.
  restyleDrag();
  drawDropMarker();
}

/**
 * Keep the place on screen in a second tab, and move to it. Nothing redraws: it is the same place.
 * A page that is one of a kind (a launched agent's conversation) is not copied: the new tab goes
 * to the place before it, or the Agent page, so one conversation never has two tabs.
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
 * when its own had moved on, though one conversation never has two tabs.
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
  // A press while a save or a read runs is made when it ends, rather than dropped.
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
 * closed a conversation's tab and ended its agent.
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
 * before that refusal stayed open and selected beside the sentence saying nothing had moved:
 * the route alone answers then, in its own words. While an action runs, the new tab and
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

/**
 * Whether a tab can move to a window of its own: in the Desktop host, with a file open,
 * the tabs on screen and more than one of them. A window keeps its last tab.
 */
export function tabsCanMove(): boolean {
  return client.mode === 'desktop' && state.session.fileName !== null && set.tabs.length > 1 && tabsShown();
}

/**
 * Move tab `index` to a window of its own (ADR-0002). The tab leaves this
 * window first, as a close would take it but without being closed: no listener hears it, so a
 * launched agent's conversation keeps running in the window it went to. The host then opens the
 * window on its trail, at the pointer when it was let go outside this one, or hands it to the
 * window of the same file whose tabs it was let go over. A window that did not open puts the tab
 * back where it stood.
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
    const answer = await client.request<DetachOutcome | null>('window.detachTab', { trail: JSON.stringify(saved), atPointer });
    announce(answer?.outcome === 'joined' ? 'The tab moved to the other window.' : 'The tab moved to a new window.');
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
 * This window was opened for a tab moved out of another: its one tab takes that tab's
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

/** What the host did with a tab let go: opened a window, gave it to another, or moved this one. */
interface DetachOutcome { outcome?: 'window' | 'joined' | 'moved' }

/**
 * A tab window's only tab, let go outside it: over another window's tabs it joins that window,
 * and this one, left with nothing to show, closes; anywhere else this window goes there, as a
 * window dragged by its tab does. The host does both, so the tab never leaves this strip first.
 */
async function moveLastTab(): Promise<void> {
  if (windowRole() !== 'tab' || set.tabs.length !== 1 || !tabsShown()) return;
  if (deferWhileBusy(() => { void moveLastTab(); })) return;
  if (refuseWhileDirty('moving the tab')) return;
  const saved = navigationTrail.inspect();
  if (saved.cursor < 0 || saved.places.length === 0) return;
  try {
    const answer = await client.request<DetachOutcome | null>('window.detachTab', { trail: JSON.stringify(saved), atPointer: true, last: true });
    if (answer?.outcome === 'moved') announce('The window moved.');
  } catch (error) {
    showError(messageFor(error));
  }
}

/**
 * A tab moved here from another window of this file, let go over this strip at `x` (the page's
 * pixels from its left edge; null when the strip could not be told). It stands where it was let
 * go and is shown, as a tab opened there would be. A conversation this window already shows in a
 * tab of its own is not shown twice: the tab arrives on the place before it, or the conversation's
 * own tab is shown instead.
 */
export async function receiveTab(text: string, x: number | null): Promise<void> {
  dropAt = null;
  drawDropMarker();
  let saved = readTabTrail(text);
  if (saved === null || state.session.fileName === null) return;
  const owner = ownerIndex(set, ownerTab);
  const current = saved.places[saved.cursor];
  if (owner >= 0 && current !== undefined && oneOfAKind(current)) {
    const kept = trailForNewTab(saved, oneOfAKind);
    if (kept.cursor < 0) { await activateTab(owner); announce('The conversation is already open here.'); return; }
    saved = kept;
  }
  const at = arrivalIndex(tabsShown() ? tabSpans() : [], tabsShown() ? x : null, set.active);
  const arriving: Tab = { id: nextId++, saved: null };
  putTabBack(set, at, arriving, saved);
  refreshChrome();
  // Shown at once, unless the page here holds unsaved typing or an action is running: then it
  // waits beside the others, where it was let go, until the person goes to it.
  const index = set.tabs.findIndex((tab) => tab.id === arriving.id);
  if (index >= 0) await activateTab(index);
  announce('A tab moved here from another window.');
}

/** Where a tab from another window would land in this strip, while one is held over it. */
let dropAt: number | null = null;

/** The host says a tab held over this window's strip would land at `x`, or that none is held. */
export function showTabDropTarget(x: number | null): void {
  dropAt = x;
  drawDropMarker();
}

function drawDropMarker(): void {
  strip.querySelector('.tab-drop-marker')?.remove();
  strip.classList.toggle('is-drop-target', dropAt !== null);
  if (dropAt === null || strip.hidden) return;
  const spans = tabSpans();
  const at = arrivalIndex(spans, dropAt, set.active);
  const room = strip.getBoundingClientRect();
  const edge = spans.length === 0 ? room.left + 8 : at < spans.length ? spans[at]!.left - 2 : spans[spans.length - 1]!.left + spans[spans.length - 1]!.width + 2;
  const marker = document.createElement('span');
  marker.className = 'tab-drop-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.style.left = `${Math.round(edge - room.left - 1)}px`;
  strip.append(marker);
}

/** The tabs as drawn, left to right, where they stand in the strip without a drag's offset. */
function tabElements(): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>('.tab[data-tab-id]')];
}

function tabSpans(): TabSpan[] {
  const list = strip.querySelector<HTMLElement>('.tab-list');
  const left = strip.getBoundingClientRect().left - (list?.scrollLeft ?? 0);
  // offsetLeft is the tab's place in the strip and ignores the transform a dragged tab carries.
  return tabElements().map((tab) => ({ left: left + tab.offsetLeft, width: tab.offsetWidth }));
}

/** Whether a tab can be dragged along the strip to stand somewhere else. */
function tabsCanReorder(): boolean {
  return state.session.fileName !== null && set.tabs.length > 1 && tabsShown();
}

/** Whether a tab can be dragged off the strip: to a window of its own, or a tab window's last one away. */
function tabsCanTearOff(): boolean {
  return client.mode === 'desktop' && state.session.fileName !== null && tabsShown() && (set.tabs.length > 1 || windowRole() === 'tab');
}

/**
 * A tab being dragged (ADR-0002), as every tabbed Windows app drags one. Along the strip it
 * follows the pointer and the others make room. Pulled off the strip, past the window's edge or
 * down into the page, it leaves: the host shows a picture of it under the pointer, inside the
 * window and outside it, and letting go opens it in a window there, or gives it to the window of
 * this file whose tabs it is let go over. Escape, the window losing focus, the pointer cancelled,
 * or a move with the button no longer held (its release went elsewhere) ends the drag with every
 * tab where it stood. A press that never moved is the click it always was.
 *
 * The browser keeps sending a held mouse's moves and its release to the page after the pointer
 * leaves the window, aimed at the document rather than the strip, so the drag listens on the
 * window from the press until the release. It does not take the pointer with setPointerCapture:
 * in the Desktop host the capture is lost part-way along the strip, and nothing it gives is
 * missing without it. The drag follows the tab by its ID, since a redraw while it runs makes the
 * strip afresh and an agent's tab opened meanwhile moves the others along.
 */
interface TabDrag {
  tabId: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** Where in the tab it was pressed, so the tab keeps its place under the pointer. */
  grabX: number;
  grabY: number;
  stripBottom: number;
  /** Where the tab stood when pressed, for a drag that ends with nothing moved. */
  from: number;
  phase: 'press' | 'strip' | 'out';
  /** The tab's offset from its place in the strip while it follows the pointer along it. */
  offset: number;
  /** The host was asked to show the tab's picture under the pointer. */
  picture: boolean;
}

let drag: TabDrag | null = null;

strip.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  // A drag whose release never came (the pointer taken by the system) ends here rather than
  // leaving every later press ignored.
  if (drag !== null) cancelDrag();
  if (!tabsCanReorder() && !tabsCanTearOff()) return;
  const main = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tab]') : null;
  const tab = main?.closest<HTMLElement>('[data-tab-id]');
  if (!main || !tab) return;
  const box = tab.getBoundingClientRect();
  drag = { tabId: Number(tab.dataset.tabId), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    grabX: event.clientX - box.left, grabY: event.clientY - box.top, stripBottom: strip.getBoundingClientRect().bottom,
    from: set.tabs.findIndex((candidate) => candidate.id === Number(tab.dataset.tabId)), phase: 'press', offset: 0, picture: false };
  window.addEventListener('pointermove', moveDrag, true);
  window.addEventListener('pointerup', releaseDrag, true);
  window.addEventListener('pointercancel', abandonDrag, true);
  window.addEventListener('keydown', escapeDrag, true);
  window.addEventListener('blur', abandonDrag);
});

function draggedIndex(): number {
  return drag === null ? -1 : set.tabs.findIndex((tab) => tab.id === drag!.tabId);
}

function moveDrag(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  // The button is no longer held: its release reached something else (another window took the
  // pointer), so the drag ends here rather than following a pointer nobody is holding.
  if (event.type === 'pointermove' && (event.buttons & 1) === 0) { cancelDrag(); return; }
  let where = dragState(drag.startX, drag.startY, event.clientX, event.clientY, window.innerWidth, window.innerHeight, drag.stripBottom);
  if (where === 'press' && drag.phase === 'press') return;
  if (drag.phase === 'press') {
    strip.classList.add('is-tab-dragging');
    document.documentElement.dataset.tabDrag = '';
  }
  if (where === 'out' && !tabsCanTearOff()) where = 'inside';
  if (where === 'out') {
    if (drag.phase !== 'out') {
      drag.phase = 'out';
      drag.offset = 0;
      restyleDrag();
      void showPicture(drag);
    }
    return;
  }
  if (drag.phase === 'out') endPicture(drag, false);
  drag.phase = 'strip';
  followAlongStrip(event.clientX);
}

/** The dragged tab under the pointer along the strip, the others making room as it passes their middle. */
function followAlongStrip(x: number): void {
  if (drag === null) return;
  let index = draggedIndex();
  if (index < 0) { cancelDrag(); return; }
  const left = x - drag.grabX;
  if (tabsCanReorder()) {
    const slot = slotFor(tabSpans(), index, left);
    if (moveTab(set, index, slot)) { index = slot; drawTabs(); }
  }
  const spans = tabSpans();
  const own = spans[index];
  if (own === undefined) return;
  // Kept within the strip's tabs, as a tab cannot be dragged past the first or the last.
  const first = spans[0]!.left;
  const last = spans[spans.length - 1]!;
  drag.offset = Math.max(first, Math.min(left, last.left + last.width - own.width)) - own.left;
  restyleDrag();
}

/** The dragged tab drawn for where the drag has got to, on whichever element the strip now holds for it. */
function restyleDrag(): void {
  for (const tab of strip.querySelectorAll<HTMLElement>('.tab.is-dragging, .tab.is-leaving')) {
    tab.classList.remove('is-dragging', 'is-leaving');
    tab.style.transform = '';
  }
  if (drag === null || drag.phase === 'press') return;
  const tab = strip.querySelector<HTMLElement>(`.tab[data-tab-id="${drag.tabId}"]`);
  // The tab closed while it was dragged: the drag ends, after the redraw that lost it.
  if (tab === null) { queueMicrotask(() => { if (drag !== null && draggedIndex() < 0) cancelDrag(); }); return; }
  tab.classList.add('is-dragging');
  if (drag.phase === 'out' && drag.picture) tab.classList.add('is-leaving');
  tab.style.transform = drag.phase === 'strip' && drag.offset !== 0 ? `translateX(${Math.round(drag.offset)}px)` : '';
}

/**
 * Ask the host for the tab's picture under the pointer. The host takes it from what the page last
 * drew, so the tab is put back in its place first and drawn as it is, and dimmed in the strip only
 * once the picture is taken.
 */
async function showPicture(held: TabDrag): Promise<void> {
  if (client.mode !== 'desktop') return;
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (drag !== held || held.phase !== 'out') return;
  const tab = strip.querySelector<HTMLElement>(`.tab[data-tab-id="${held.tabId}"]`);
  if (tab === null) return;
  const box = tab.getBoundingClientRect();
  const look = getComputedStyle(strip.querySelector<HTMLElement>('.tab.is-active') ?? tab);
  // The dashed outline the strip draws on a leaving tab, read from that rule, so the picture under
  // the pointer carries the same one.
  const probe = document.createElement('div');
  probe.className = 'tab is-leaving';
  probe.hidden = true;
  strip.append(probe);
  const leaving = getComputedStyle(probe);
  const outline = { outline: rgb(leaving.outlineColor), outlineWidth: leaving.outlineStyle === 'none' ? 0 : Number.parseFloat(leaving.outlineWidth) || 0 };
  probe.remove();
  held.picture = true;
  try {
    await client.request('window.beginTabDrag', {
      box: { x: box.left, y: box.top, width: box.width, height: box.height },
      grab: { x: held.grabX, y: held.grabY },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      background: rgb(look.backgroundColor), border: rgb(look.borderTopColor),
      radius: Number.parseFloat(look.borderTopLeftRadius) || 0,
      ...outline,
    });
  } catch {
    // No picture: the drag still ends where it is let go.
  }
  restyleDrag();
}

/** A computed colour as its red, green and blue, for the host to draw the tab's picture on. */
function rgb(colour: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return [r, g, b];
}

/**
 * The tab came back to the strip, or the drag ended: the picture goes. Let go off the strip, the
 * host keeps where the pointer was let go and over which window, for the move that follows, which
 * may wait on a running action and must not open where the pointer has gone since.
 */
function endPicture(held: TabDrag, dropped: boolean): Promise<unknown> {
  held.picture = false;
  if (client.mode !== 'desktop') return Promise.resolve();
  return client.request('window.endTabDrag', { dropped }).catch(() => undefined);
}

function endListening(): TabDrag | null {
  const ended = drag;
  drag = null;
  window.removeEventListener('pointermove', moveDrag, true);
  window.removeEventListener('pointerup', releaseDrag, true);
  window.removeEventListener('pointercancel', abandonDrag, true);
  window.removeEventListener('keydown', escapeDrag, true);
  window.removeEventListener('blur', abandonDrag);
  strip.classList.remove('is-tab-dragging');
  delete document.documentElement.dataset.tabDrag;
  restyleDrag();
  return ended;
}

/** The click a release makes comes straight after it, or not at all when the release was off the tab. */
function swallowReleaseClick(): void {
  swallowClick = true;
  window.setTimeout(() => { swallowClick = false; }, 0);
}

function releaseDrag(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) return;
  // Where it was let go, not where it was last seen moving: a quick flick ends past the edge.
  if (drag.phase !== 'press') moveDrag(event);
  const ended = endListening();
  if (ended !== null && ended.phase !== 'press') swallowReleaseClick();
  if (ended === null || ended.phase !== 'out') return;
  void (async () => {
    await endPicture(ended, true);
    const index = set.tabs.findIndex((tab) => tab.id === ended.tabId);
    if (index < 0) return;
    if (set.tabs.length === 1) await moveLastTab();
    else await moveTabToWindow(index, true);
  })();
}

/** End the drag with nothing moved: the tab back where it stood, and its picture gone. */
function cancelDrag(): void {
  const ended = endListening();
  if (ended === null) return;
  if (ended.phase === 'out') void endPicture(ended, false);
  const index = set.tabs.findIndex((tab) => tab.id === ended.tabId);
  if (index >= 0 && ended.from >= 0 && moveTab(set, index, ended.from)) drawTabs();
}

function abandonDrag(event: Event): void {
  if (drag === null) return;
  if (event instanceof PointerEvent && event.pointerId !== drag.pointerId) return;
  cancelDrag();
}

function escapeDrag(event: KeyboardEvent): void {
  if (drag === null || event.key !== 'Escape') return;
  // Only a drag under way: the Escape of a press that has not moved is the page's.
  if (drag.phase === 'press') return;
  event.preventDefault();
  event.stopPropagation();
  cancelDrag();
}

// Another window of this file hands this one a tab let go over its strip, and says where one held
// over it would land.
client.onTabArrived?.((arrival) => { void receiveTab(arrival.trail, arrival.x); });
client.onTabDropTarget?.((x) => { showTabDropTarget(x); });
