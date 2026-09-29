import { fileScopedClearable } from './app-state';
import type { Json } from './extension-api/protocol';

/**
 * Where each custom view is, as the view itself declared it (ADR-0013, 2026-09-29; W-127).
 *
 * A view keeps its own state in its frame: which diagram is open, what is selected. The trail
 * knew only Nendo's places, so Back from a record a view had opened rebuilt the screen and the
 * view started over, and moving between two of a view's own pages was never a step at all.
 * Now a view names its place with `nendo.ui.setPlace`, the place is kept here against the
 * screen it was declared on, and the trail carries it like any other part of where somebody is.
 *
 * Kept against an anchor — the Nendo place the view is on, narrowed to what puts a view there —
 * and the view's own identity on it. A place the trail leaves behind is still here, so a view
 * that is started again on its screen starts where it was. Nothing here is written to the file.
 */

/** One view's place: the value the view declared, and what the Back button calls it. */
export interface ViewPlace {
  /** The view on the screen, as `viewPlaceKey` names it. */
  view: string;
  value: Json;
  label: string;
}

/** The parts of a Nendo place that decide which views are on it. */
export interface ViewAnchor {
  view: string;
  applicationEntityId: string | null;
  showOverview: boolean | null;
  surfaceId: string | null;
  recordId: string | null;
}

/** How many places are kept before the one kept longest ago is forgotten. */
export const viewPlaceCeiling = 200;

// Registered where it is declared, so closing the file forgets its views' places with the trail.
const kept = fileScopedClearable(new Map<string, { anchor: string; place: ViewPlace }>());

export function viewAnchor(place: ViewAnchor): string {
  return JSON.stringify([place.view, place.applicationEntityId, place.showOverview, place.surfaceId, place.recordId]);
}

/** A view's identity on its page: the same view on another record is another view. */
export function viewPlaceKey(view: { placement: string; viewId: string; recordId: string | null }): string {
  return JSON.stringify([view.placement, view.viewId, view.recordId]);
}

function entryKey(anchor: string, view: string): string {
  return `${anchor}\u0000${view}`;
}

/** Every view's place on this anchor, in a fixed order so two readings compare equal. */
export function viewPlacesAt(anchor: string): ViewPlace[] {
  const found: ViewPlace[] = [];
  for (const entry of kept.values()) if (entry.anchor === anchor) found.push(entry.place);
  return found.sort((left, right) => left.view.localeCompare(right.view));
}

/** The place one view has on this anchor, or null when it declared none. */
export function viewPlaceOf(anchor: string, view: string): ViewPlace | null {
  return kept.get(entryKey(anchor, view))?.place ?? null;
}

/** Keep a view's place. Answers whether it differs from the one kept, value or label. */
export function keepViewPlace(anchor: string, place: ViewPlace): boolean {
  const key = entryKey(anchor, place.view);
  const before = kept.get(key)?.place ?? null;
  const same = before !== null && before.label === place.label && JSON.stringify(before.value) === JSON.stringify(place.value);
  // Kept anew either way, so the ceiling forgets the places used longest ago rather than the
  // ones declared first.
  kept.delete(key);
  kept.set(key, { anchor, place });
  while (kept.size > viewPlaceCeiling) kept.delete(kept.keys().next().value!);
  return !same;
}

/**
 * Put back the places a trail entry carried: its views are where they were then, and a view
 * that had declared nothing then has no place now.
 */
export function restoreViewPlaces(anchor: string, places: readonly ViewPlace[]): void {
  for (const [key, entry] of [...kept]) if (entry.anchor === anchor) kept.delete(key);
  for (const place of places) kept.set(entryKey(anchor, place.view), { anchor, place });
}
