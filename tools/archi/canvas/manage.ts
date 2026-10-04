// Archi's Specializations Manager, Properties Manager and Find and Replace (W-119): archi-online's own
// operations, each run on a store of its own around the mirror, as Generate View For is. What one
// changes is the difference between the mirror before and after, which the workbench writes with
// writesFor as one batch, so one revision and one step of its Undo.

import { createModelStore, type ModelStore } from '@archi/model/store';
import type { ConceptType, ModelState, ProfileDefinition } from '@archi/model/types';
import { profileUsageCount, replaceProfiles } from '@archi/model/ops/profiles';
import {
  capturePropertyManagerSession, displayPropertyKey, inspectPropertyUsage, previewPropertyDelete, previewPropertyRename,
} from '@archi/model/property-manager';
import { deletePropertyKey, renamePropertyKey } from '@archi/model/ops/property-manager';
import { captureFindReplaceSession, previewFindReplace, type FindReplaceOptions, type FindReplaceRow } from '@archi/model/find-replace';
import { applyFindReplace } from '@archi/model/ops/find-replace';

const storeOf = (model: ModelState, activeViewId: string | null = null): ModelStore =>
  createModelStore({ model: structuredClone(model), activeViewId, openViewIds: activeViewId ? [activeViewId] : [] });

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** The model's specializations by name, each with the number of concepts it is given to. */
export function specializationsOf(model: ModelState) {
  return Object.values(model.profiles).map(profile => ({ id: profile.id, name: profile.name, conceptType: profile.conceptType,
    used: profileUsageCount(model, profile.id) })).sort(byName);
}

export interface SpecializationEntry { id: string; name: string; conceptType: string }

/**
 * The model with its specializations made `list`, as archi-online's manager saves its table: a
 * name and concept type unique together, a used one keeping its type, one left out taken from
 * every concept that had it. Throws archi-online's sentence when the list breaks one of those.
 */
export function manageSpecializations(model: ModelState, list: SpecializationEntry[]): ModelState {
  const store = storeOf(model);
  const profiles: ProfileDefinition[] = list.map(entry => ({ id: entry.id, name: entry.name, conceptType: entry.conceptType as ConceptType,
    specialization: true }));
  replaceProfiles(profiles, store);
  return store.getState().model!;
}

/** Every property key in the model, in archi-online's order, with where each is used. */
export function propertyKeys(model: ModelState) {
  const store = storeOf(model);
  return inspectPropertyUsage(capturePropertyManagerSession(store)).map(usage => ({
    key: usage.key, displayKey: usage.displayKey, occurrenceCount: usage.occurrenceCount, ownerCount: usage.ownerCount,
    occurrences: usage.occurrences.map(occurrence => ({ ownerId: occurrence.ownerId, ownerType: occurrence.ownerType,
      location: occurrence.location, value: occurrence.value, navigation: { ...occurrence.navigation } })),
  }));
}

export { displayPropertyKey };

/**
 * A key renamed everywhere it is used. `collision` says the new key is in use already, and then
 * nothing is renamed until it is `acknowledged`, as archi-online asks: the rows stay separate.
 */
export function renamePropertyKeyIn(model: ModelState, key: string, newKey: string, acknowledged = false) {
  const store = storeOf(model);
  const preview = previewPropertyRename(capturePropertyManagerSession(store), key, newKey, acknowledged);
  if (!preview.valid) throw new Error(preview.error ?? 'The key cannot be renamed.');
  if (preview.collision && !acknowledged) return { model, applied: 0, collision: true, warning: preview.warning };
  const applied = renamePropertyKey(preview, store);
  return { model: store.getState().model!, applied, collision: preview.collision, warning: preview.warning };
}

/** A key's every property taken away. */
export function deletePropertyKeyIn(model: ModelState, key: string) {
  const store = storeOf(model);
  const preview = previewPropertyDelete(capturePropertyManagerSession(store), key);
  if (!preview.valid) throw new Error(preview.error ?? 'The key cannot be deleted.');
  const applied = deletePropertyKey(preview, store);
  return { model: store.getState().model!, applied };
}

export type FindOptions = FindReplaceOptions;
export type FoundRow = Pick<FindReplaceRow, 'id' | 'ownerId' | 'ownerKind' | 'ownerType' | 'location' | 'field' | 'before' | 'after' | 'count' | 'navigation'>;

/** What a replace would change: one row per name, text, documentation or property value that matches. */
export function findReplacePreview(model: ModelState, options: FindOptions, activeViewId: string | null = null) {
  const preview = previewFindReplace(captureFindReplaceSession(storeOf(model, activeViewId)), options);
  return { error: preview.valid ? null : preview.error, rows: preview.rows.map(row => ({ id: row.id, ownerId: row.ownerId, ownerKind: row.ownerKind,
    ownerType: row.ownerType, location: row.location, field: row.field, before: row.before, after: row.after, count: row.count,
    navigation: { ...row.navigation } })) as FoundRow[] };
}

/**
 * The model with the rows chosen from a preview replaced, previewed again on `model`: a row whose
 * value is no longer what the person was shown refuses the whole replace, as archi-online's does.
 */
export function findReplaceApply(model: ModelState, options: FindOptions, chosen: Pick<FoundRow, 'id' | 'before' | 'after'>[], activeViewId: string | null = null) {
  const store = storeOf(model, activeViewId);
  const preview = previewFindReplace(captureFindReplaceSession(store), options);
  if (!preview.valid) throw new Error(preview.error ?? 'The search is not valid.');
  const now = new Map(preview.rows.map(row => [row.id, row]));
  for (const row of chosen) {
    const current = now.get(row.id);
    if (!current || current.before !== row.before || current.after !== row.after) throw new Error('The model has changed since the preview. Preview again.');
  }
  const applied = applyFindReplace(preview, chosen.map(row => row.id), store);
  return { model: store.getState().model!, applied };
}
