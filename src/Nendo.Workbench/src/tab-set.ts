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
