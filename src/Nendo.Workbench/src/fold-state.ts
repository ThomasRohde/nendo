import { sectionFolds, state } from './app-state';
import type { SurfaceNodePlan } from './host';

type Fold = 'open' | 'closed';

/**
 * Whether a section is open on the page in front of the person (ADR-0004, 2026-09-20
 * amendment, and its 2026-09-24 addition).
 *
 * Two things answer it, one stored in the file and one not. An author says how a
 * section starts with `opens`, and that is in the file. What the person has done since
 * -- folded this one, opened that one -- is their own view of the page. It is kept for
 * this device the way the theme and the rail are, keyed by the file's application ID
 * and the section's node ID, and never written into the file. Until the person touches
 * a section the author's word stands; after that, theirs does. A closed section reads
 * nothing: the walkers that decide what a page is still waiting for stop at it.
 */
export function sectionIsOpen(node: SurfaceNodePlan): boolean {
  const folded = sectionFolds.get(node.semanticId) ?? currentFolds()[node.semanticId];
  if (folded !== undefined) return folded === 'open';
  return node.properties.opens !== 'closed';
}

/**
 * Remember what the person did with a section. `remember` is false for a section the
 * page opened by itself -- to show a required field inside it -- because that was not
 * the person's choice, and it lasts only as long as the file is open.
 */
export function foldSection(sectionId: string, open: boolean, remember = true): void {
  const fold: Fold = open ? 'open' : 'closed';
  sectionFolds.set(sectionId, fold);
  if (!remember) return;
  const applicationId = state.session.manifest?.applicationId;
  const storage = deviceStorage();
  if (!applicationId || storage === null) return;
  cache = { applicationId, folds: rememberFold(storage, applicationId, sectionId, fold) };
}

/**
 * The application ID rather than the instance ID: it follows a duplicate or a fork, so
 * a fold made in one copy shows in another on the same device. The instance ID would
 * forget folds on every copy, which reads as the feature not working.
 */
export function foldStorageKey(applicationId: string): string {
  return `nendo.sectionFolds.${applicationId}`;
}

/** What this device remembers for one file. Anything unreadable is simply not remembered. */
export function rememberedFolds(storage: Pick<Storage, 'getItem'>, applicationId: string): Record<string, Fold> {
  const folds: Record<string, Fold> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(foldStorageKey(applicationId)) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return folds;
    for (const [sectionId, value] of Object.entries(parsed)) {
      if (value === 'open' || value === 'closed') folds[sectionId] = value;
    }
  } catch {
    // Storage that refuses to answer, or answers with something else, leaves the
    // author's defaults in charge.
  }
  return folds;
}

/** Record one fold for one file and return the whole remembered set. */
export function rememberFold(storage: Pick<Storage, 'getItem' | 'setItem'>, applicationId: string, sectionId: string, fold: Fold): Record<string, Fold> {
  const folds = { ...rememberedFolds(storage, applicationId), [sectionId]: fold };
  try {
    storage.setItem(foldStorageKey(applicationId), JSON.stringify(folds));
  } catch {
    // The fold still holds for this session when device persistence is unavailable.
  }
  return folds;
}

// Parsed once per file rather than on every walk: sectionIsOpen runs for every section
// on every draw and every read chase.
let cache: { applicationId: string; folds: Record<string, Fold> } | null = null;

function currentFolds(): Record<string, Fold> {
  const applicationId = state.session.manifest?.applicationId;
  if (!applicationId) return {};
  if (cache?.applicationId !== applicationId) {
    const storage = deviceStorage();
    cache = { applicationId, folds: storage === null ? {} : rememberedFolds(storage, applicationId) };
  }
  return cache.folds;
}

function deviceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
