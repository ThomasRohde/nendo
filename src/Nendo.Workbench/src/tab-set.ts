import type { Place, Trail } from './navigation-trail';

/**
 * The tabs of the window and which one is on screen, and the two moves that change them: going
 * to a tab and closing one (G, trial). The strip in `workspace-tabs.ts` draws this and wires the
 * clicks; what the moves do to the tabs and the trail lives here, without the page, so it is
 * measured as it runs.
 *
 * A move is a transaction (review R-002). Going to a tab swaps its trail in and shows its place;
 * a place that cannot be shown (its record type retired, its record unreadable) puts the tabs,
 * both trails and the window's trail back as they were, so the selected tab, the heading and
 * Back and Forward all keep describing the page still on screen.
 */
export interface SavedTrail { places: Place[]; cursor: number }
export interface Tab { id: number; saved: SavedTrail | null }
export interface TabSet { tabs: Tab[]; active: number }

/** Show the window trail's current place. False when it was refused and the old page still shows. */
export type ShowPlace = () => Promise<boolean>;

/** Go to tab `index`. True when it is on screen; false, with nothing changed, when its place was refused. */
export async function switchTab(set: TabSet, index: number, trail: Trail, show: ShowPlace): Promise<boolean> {
  if (index === set.active || index < 0 || index >= set.tabs.length) return false;
  const from = set.active;
  const leaving = trail.inspect();
  const arrivingSaved = set.tabs[index].saved;
  set.tabs[from].saved = leaving;
  set.tabs[index].saved = null;
  set.active = index;
  trail.load(arrivingSaved ?? { places: [], cursor: -1 });
  if (await show()) return true;
  set.tabs[index].saved = arrivingSaved;
  set.tabs[from].saved = null;
  set.active = from;
  trail.load(leaving);
  return false;
}

/**
 * Close tab `index`. The tab on screen goes only once the one beside it is shown, so nothing is
 * drawn from a trail that has gone and a refused neighbour leaves every tab where it was.
 */
export async function closeTabAt(set: TabSet, index: number, trail: Trail, show: ShowPlace): Promise<boolean> {
  if (set.tabs.length === 1 || index < 0 || index >= set.tabs.length) return false;
  if (index !== set.active) {
    set.tabs.splice(index, 1);
    if (index < set.active) set.active -= 1;
    return true;
  }
  const next = index + 1 < set.tabs.length ? index + 1 : index - 1;
  if (!(await switchTab(set, next, trail, show))) return false;
  set.tabs.splice(index, 1);
  if (index < set.active) set.active -= 1;
  return true;
}

/**
 * What a new tab starts from when the person asks for one beside `saved` (the + button, Ctrl T):
 * the place on screen, or, when that place is one of a kind in the window (a launched agent's
 * conversation, ADR-0030), the nearest place before it that is not. Two tabs never show one
 * conversation, so closing one of them cannot end the agent the other still shows (ACP-06).
 * An empty trail when there is no such place.
 */
export function trailForNewTab(saved: SavedTrail, oneOfAKind: (place: Place) => boolean): SavedTrail {
  for (let at = Math.min(saved.cursor, saved.places.length - 1); at >= 0; at -= 1) {
    const place = saved.places[at]!;
    if (!oneOfAKind(place)) return { places: [place], cursor: 0 };
  }
  return { places: [], cursor: -1 };
}

/**
 * Where the tab with ID `owner` stands now, or -1 when it has closed. A conversation's tab owns
 * the conversation by its ID, not by what its trail still holds: a trail drops a place when the
 * person goes somewhere new from part-way back, and after 50 more moves (WAU-01).
 */
export function ownerIndex(set: TabSet, owner: number | null): number {
  return owner === null ? -1 : set.tabs.findIndex((tab) => tab.id === owner);
}

/**
 * The trail of tab `index`, for moving it to a window of its own (W-277): the window's trail for
 * the tab on screen, the saved one for any other. Null when the tab has no place to show, or is
 * the window's only tab, which stays: a window always shows one.
 */
export function trailOfTab(set: TabSet, index: number, trail: Trail): SavedTrail | null {
  if (set.tabs.length === 1 || index < 0 || index >= set.tabs.length) return null;
  const saved = index === set.active ? trail.inspect() : set.tabs[index].saved;
  return saved === null || saved.cursor < 0 || saved.places.length === 0 ? null : saved;
}

/**
 * Put back a tab taken out for a window that did not open, where it stood, as a tab off screen
 * with its own trail. The tab on screen stays on screen.
 */
export function putTabBack(set: TabSet, index: number, tab: Tab, saved: SavedTrail): void {
  const at = Math.max(0, Math.min(index, set.tabs.length));
  set.tabs.splice(at, 0, { ...tab, saved });
  if (at <= set.active) set.active += 1;
}

/** A trail handed to this window by the host, read back from its text; null for anything else. */
export function readTabTrail(text: string): SavedTrail | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const { places, cursor } = value as { places?: unknown; cursor?: unknown };
  if (!Array.isArray(places) || places.length === 0 || !Number.isSafeInteger(cursor)) return null;
  if ((cursor as number) < 0 || (cursor as number) >= places.length) return null;
  if (!places.every((place) => typeof place === 'object' && place !== null && typeof (place as { view?: unknown }).view === 'string')) return null;
  return { places: places as Place[], cursor: cursor as number };
}

/** How far a press on a tab moves before it is a drag, in the page's pixels. */
export const dragThreshold = 6;

/** How far past the window's edge a tab must be let go to leave it, in the page's pixels. */
export const leaveMargin = 8;

/** How far below the tab strip a tab must be pulled to leave, in the page's pixels. */
export const pullDistance = 40;

/**
 * Where a tab dragged from (`startX`, `startY`) to (`x`, `y`) stands: still a press, a drag along
 * the strip, or out, where letting go opens the tab in a window of its own. A tab is out past the
 * window's edge, the page's viewport `width` by `height`, or pulled down more than `pullDistance`
 * below the strip's bottom edge at `stripBottom`: a window that fills the screen has no edge to
 * drag past, so pulling the tab down into the page is the way out there, as in a browser
 * (reported 2026-10-17).
 */
export function dragState(startX: number, startY: number, x: number, y: number, width: number, height: number, stripBottom: number): 'press' | 'inside' | 'out' {
  if (Math.hypot(x - startX, y - startY) < dragThreshold) return 'press';
  const out = x < -leaveMargin || y < -leaveMargin || x > width + leaveMargin || y > height + leaveMargin || y > stripBottom + pullDistance;
  return out ? 'out' : 'inside';
}
