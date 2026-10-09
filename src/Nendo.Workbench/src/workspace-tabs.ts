import { fileScopedClearable, state, type ViewName } from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';
import { applicationPlans } from './plan-selection';
import { fileViewById, viewIcon } from './file-view-model';
import { typeGlyph } from './type-icons';
import { revisitCurrent } from './navigation-actions';
import { navigationTrail, type Place } from './navigation-trail';
import { closeTabAt, switchTab, type Tab, type TabSet } from './tab-set';
import { announce, refreshChrome, requiredElement, rerender } from './shell';

/**
 * The places a person keeps open, as tabs in the title bar (G, trial; the Mica-with-tabs canvas).
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

fileScopedClearable({
  clear(): void {
    set.tabs = [{ id: nextId++, saved: null }];
    set.active = 0;
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
const closedListeners: Array<(place: Place) => void> = [];

export function setTabStatus(provider: (place: Place) => TabStatus | null): void {
  statusOf = provider;
}

export function onTabClosed(listener: (place: Place) => void): void {
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
  const open = state.session.fileName !== null;
  strip.hidden = !open;
  if (!open) { strip.innerHTML = ''; return; }
  const only = set.tabs.length === 1;
  // A redraw keeps keyboard focus on the tab it was on: a page's own mark (an agent starting to
  // work) redraws the strip while the person may be moving along it.
  const focused = strip.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const refocus = focused?.dataset.tab !== undefined ? `[data-tab="${focused.dataset.tab}"]`
    : focused?.dataset.closeTab !== undefined ? `[data-close-tab="${focused.dataset.closeTab}"]` : null;
  strip.innerHTML = set.tabs.map((tab, index) => {
    const place = placeOf(tab, index);
    const label = tabLabel(place);
    const selected = index === set.active;
    const status = place === null ? null : statusOf(place);
    const said = status === null ? label : `${label}, ${status.label.toLowerCase()}`;
    const mark = status === null ? '' : `<span class="tab-status is-${escapeAttribute(status.kind)}" aria-hidden="true"></span><span class="visually-hidden">, ${escapeHtml(status.label.toLowerCase())}</span>`;
    return `<div class="tab${selected ? ' is-active' : ''}" data-tab-index="${index}">
      <button class="tab-main" type="button" role="tab" aria-selected="${selected}" data-tab="${index}" title="${escapeAttribute(said)}">${tabGlyph(place)}<span class="tab-label">${escapeHtml(label)}</span>${mark}</button>
      <button class="tab-close" type="button" data-close-tab="${index}" aria-label="Close ${escapeAttribute(label)}" title="Close tab (Ctrl+W)" ${only ? 'disabled' : ''}>${icon('close')}</button>
    </div>`;
  }).join('') + `<button id="tab-new" class="tab-new" type="button" aria-label="New tab" title="New tab (Ctrl+T)">${icon('plus')}</button>`;
  if (refocus !== null) strip.querySelector<HTMLElement>(refocus)?.focus({ preventScroll: true });
}

/** Keep the place on screen in a second tab, and move to it. Nothing redraws: it is the same place. */
export function newTab(): void {
  if (state.session.fileName === null) return;
  const here = navigationTrail.current();
  set.tabs[set.active].saved = navigationTrail.inspect();
  const tab: Tab = { id: nextId++, saved: null };
  set.tabs.splice(set.active + 1, 0, tab);
  set.active += 1;
  navigationTrail.load(here === null ? { places: [], cursor: -1 } : { places: [here], cursor: 0 });
  refreshChrome();
  announce('New tab opened.');
}

/**
 * Show `view` in a tab of its own: the tab already on it, or a new one beside this tab. For a page
 * that is one of a kind in the window, such as a launched agent's conversation (ADR-0030).
 */
export async function openTabOn(view: ViewName): Promise<void> {
  const index = set.tabs.findIndex((tab, at) => placeOf(tab, at)?.view === view);
  if (index === set.active) { state.view = view; rerender(); return; }
  if (index >= 0) { await activateTab(index); return; }
  newTab();
  state.view = view;
  rerender();
}

export async function activateTab(index: number): Promise<void> {
  if (index === set.active || index < 0 || index >= set.tabs.length) return;
  if (state.actionInFlight || refuseWhileDirty('switching tabs')) return;
  // A refused place leaves the tab that was on screen selected, with its trail (tab-set.ts).
  if (!(await switchTab(set, index, navigationTrail, revisitCurrent))) refreshChrome();
  focusActiveTab();
}

export async function closeTab(index: number): Promise<void> {
  if (set.tabs.length === 1 || index < 0 || index >= set.tabs.length) return;
  if (index === set.active && (state.actionInFlight || refuseWhileDirty('switching tabs'))) return;
  const closing = placeOf(set.tabs[index]!, index);
  const closed = await closeTabAt(set, index, navigationTrail, revisitCurrent);
  refreshChrome();
  focusActiveTab();
  if (closed && closing !== null) for (const listener of closedListeners) listener(closing);
}

function focusActiveTab(): void {
  strip.querySelector<HTMLButtonElement>(`[data-tab="${set.active}"]`)?.focus({ preventScroll: true });
}

strip.addEventListener('click', (event) => {
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

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key !== 'Tab') return;
  if (document.querySelector('dialog[open]') !== null || state.session.fileName === null) return;
  event.preventDefault();
  cycleTab(-1);
});

/**
 * Open something from the navigation in a new tab: a Ctrl+click, or a middle click, on any of its
 * routes. The tab is made first, so the route then moves the new tab rather than the old one.
 */
export function wireOpenInNewTab(rail: HTMLElement): void {
  rail.addEventListener('click', (event) => {
    if (!event.ctrlKey) return;
    const route = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.nav-item, .nav-place') : null;
    if (route === null || route.disabled) return;
    newTab();
  }, true);
  rail.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const route = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.nav-item, .nav-place') : null;
    if (route === null || route.disabled) return;
    event.preventDefault();
    newTab();
    route.click();
  });
}
