import { fileScopedClearable, selectedTabs, type DrillState, type ReturnTo, type ViewName } from './app-state';
import type { CalendarMode, CivilMonth } from './calendar-model';

/**
 * Where somebody has been in this file, so there is a way back from anywhere.
 *
 * W-033 gave a related row one step back to the record it was opened from. Everything
 * else a person navigates -- a record type, a surface, a drill into a chart, a tab, a
 * month on a calendar, a view -- had no way back at all, and no way forward after going
 * back.
 *
 * This module is the trail itself and nothing else: no reads, no DOM, no view. Capturing
 * a place and putting one back are in `navigation-actions.ts`, because those need the
 * session and the reads and this does not. Keeping them apart is what makes the rules
 * below testable in the node lane rather than only in the gate.
 */

/**
 * Everywhere a person can be, in enough detail to be put back there.
 *
 * `markPlace` in main.ts already computes a key from some of this, and that key is
 * deliberately left alone: `rerender` compares it to tell a repaint from a move, and
 * widening it would make changing the month on a calendar count as a new screen and
 * throw the reader's scroll position away. So the trail carries its own record, captured
 * in the same draw.
 *
 * The drill, the open tabs and the calendar or timeline position are values rather than
 * keys because they live in maps that the app keeps rewriting. A place that named the
 * map entry would restore whatever the entry holds now -- so going back to a board you
 * had since un-drilled would put the drill back on.
 */
export interface Place {
  view: ViewName;
  /** What `updateChrome` called this place when it was left. The name on the button. */
  eyebrow: string;
  title: string;
  applicationEntityId: string | null;
  studioEntityId: string | null;
  showOverview: boolean | null;
  surfaceId: string | null;
  recordId: string | null;
  /** W-033's one step back, so it comes back with the page it belongs to. */
  returnTo: ReturnTo | null;
  drill: DrillState | null;
  /** The open tab of each tab group on the record page, as `[key, sectionId]`. */
  tabs: Array<[string, string]>;
  calendar: { surfaceId: string; month: CivilMonth; mode: CalendarMode } | null;
  timeline: { surfaceId: string; year: number; mode: CalendarMode } | null;
  helpTopicId: string;
  proposalId: string | null;
  agentProposalId: string | null;
  /**
   * Where a proposal review closes to, for a place that is one.
   *
   * It decides both which section the rail shows as current while the review is open and
   * where its Close button goes, and it is set by whatever opened the review. A place
   * that did not carry it came back to a review whose Close led wherever the last review
   * had been opened from.
   */
  proposalReturnView: ViewName | null;
}

/**
 * What makes two places the same place.
 *
 * The heading is left out on purpose. A file renamed under a reader, or a surface
 * retitled by an accepted proposal, changes what a place is called without moving
 * anybody, and a trail that pushed for that would fill with entries leading to the
 * screen already on view.
 */
export function placeKey(place: Place): string {
  return JSON.stringify([
    place.view,
    place.applicationEntityId,
    place.studioEntityId,
    place.showOverview,
    place.surfaceId,
    place.recordId,
    place.returnTo?.recordId ?? null,
    place.drill === null ? null : [place.drill.listId, place.drill.filters],
    [...place.tabs].sort(([left], [right]) => left.localeCompare(right)),
    place.calendar,
    place.timeline,
    place.helpTopicId,
    place.proposalId,
    place.agentProposalId,
    place.proposalReturnView,
  ]);
}

/**
 * The open tab of every tab group on one record type's page.
 *
 * `tabStateKey` builds its key as `[fileSessionId, entityId, pageId, groupId]`, so the
 * entries belonging to one record type are read back out of the key rather than by
 * walking the page for its groups. Only this record type's are taken: a place that
 * carried every tab in the file would, on the way back, also undo a tab somebody had
 * since changed on another record type.
 *
 * It lives here rather than beside the rest of the capture because switching a tab
 * patches the page without redrawing it, so the tab has to reach the trail from
 * `record-form.ts` — and this module imports nothing that could cycle back through it.
 */
export function tabsOf(entityId: string | null): Array<[string, string]> {
  if (entityId === null) return [];
  const mine: Array<[string, string]> = [];
  for (const [key, sectionId] of selectedTabs) {
    let parts: unknown;
    try { parts = JSON.parse(key); } catch { continue; }
    if (Array.isArray(parts) && parts[1] === entityId) mine.push([key, sectionId]);
  }
  return mine;
}

export interface Trail {
  /** Note where the person is now. A repaint of the same place is not a move. */
  record(place: Place): void;
  /** The place the person is on, or null before there is one. */
  current(): Place | null;
  /**
   * Correct the place the person is on, without it counting as a move.
   *
   * For something that changes where somebody is without redrawing the page. Switching
   * a tab is the one that matters: it patches the tablist in place on purpose, so the
   * entry would otherwise keep the tab from the last draw — restoring the wrong one, and
   * then recording a phantom move the first time anything else redrew.
   */
  amendCurrent(update: (place: Place) => Place): void;
  peekBack(): Place | null;
  peekForward(): Place | null;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /** Take the step, once the place has actually been restored. */
  stepBack(): void;
  stepForward(): void;
  /** Forget a place that is no longer there, without moving off the current one. */
  dropBack(): void;
  dropForward(): void;
  /**
   * Hold the trail still while a place is being put back.
   *
   * Restoring redraws, and a draw records. Without this a restore would push the place
   * it had just restored and eat everything ahead of it, so forward would work once.
   */
  setRestoring(restoring: boolean): void;
  isRestoring(): boolean;
  clear(): void;
  /** The trail's length and where in it the person is. For the tests, and for nothing else. */
  inspect(): { places: Place[]; cursor: number };
}

/**
 * How far back the trail goes.
 *
 * Long enough that nobody reaches the end of it in a sitting, short enough that it is
 * bounded. It is a session's movements, not a record of anything: nothing here is
 * written to the file.
 */
export const trailCeiling = 50;

export function createTrail(ceiling: number = trailCeiling): Trail {
  let places: Place[] = [];
  let cursor = -1;
  let restoring = false;
  return {
    record(place: Place): void {
      if (restoring) return;
      if (cursor >= 0 && placeKey(places[cursor]) === placeKey(place)) {
        // The same place, drawn again. Keep the newer heading and stay put.
        places[cursor] = place;
        return;
      }
      // Going somewhere new from part-way back abandons what was ahead, which is what
      // every trail does: the way forward was to places this person has just not taken.
      places = places.slice(0, cursor + 1);
      places.push(place);
      if (places.length > ceiling) places = places.slice(places.length - ceiling);
      cursor = places.length - 1;
    },
    current: () => (cursor >= 0 ? places[cursor] : null),
    amendCurrent(update: (place: Place) => Place): void {
      if (cursor < 0) return;
      places[cursor] = update(places[cursor]);
    },
    peekBack: () => (cursor > 0 ? places[cursor - 1] : null),
    peekForward: () => (cursor >= 0 && cursor < places.length - 1 ? places[cursor + 1] : null),
    canGoBack: () => cursor > 0,
    canGoForward: () => cursor >= 0 && cursor < places.length - 1,
    stepBack(): void { if (cursor > 0) cursor -= 1; },
    stepForward(): void { if (cursor >= 0 && cursor < places.length - 1) cursor += 1; },
    dropBack(): void {
      if (cursor <= 0) return;
      places.splice(cursor - 1, 1);
      cursor -= 1;
    },
    dropForward(): void {
      if (cursor < 0 || cursor >= places.length - 1) return;
      places.splice(cursor + 1, 1);
    },
    setRestoring(value: boolean): void { restoring = value; },
    isRestoring: () => restoring,
    clear(): void { places = []; cursor = -1; restoring = false; },
    inspect: () => ({ places: [...places], cursor }),
  };
}

/**
 * The trail of the file that is open.
 *
 * Registered where it is declared, like every other cache that belongs to one file, so
 * `resetFileView` empties it through `clearFileScoped` and there is no second place to
 * remember. Switching files clears the way back, because the places in it are gone.
 */
export const navigationTrail = fileScopedClearable(createTrail());

/**
 * A tab was switched on this record type's page, so the place the person is on has
 * changed without the page being redrawn.
 */
export function noteTabsChanged(entityId: string): void {
  const here = navigationTrail.current();
  if (here === null || here.applicationEntityId !== entityId) return;
  navigationTrail.amendCurrent((place) => ({ ...place, tabs: tabsOf(entityId) }));
}
