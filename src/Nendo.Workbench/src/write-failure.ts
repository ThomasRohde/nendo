import { storageLabel } from './format';
import type { EntitySnapshot } from './host-types';
import { isConfirmedRejection } from './pending-mutations';

/**
 * What a caller should do with the view after a write failed.
 *
 * `retain-draft` — the host confirmed the file is unchanged and nothing is in
 * flight. Whatever the user typed is still the best copy of their intent, and it
 * lives in the DOM rather than in application state, so the form must be left
 * standing and only its error display updated. Re-rendering here discards the
 * draft to show values the host already holds.
 *
 * `refresh-view` — the outcome is not settled, or the session may have moved
 * underneath the view. Read the session again and rebuild, which is also what
 * drops a stale file, applies a read-only transition and disables submission.
 */
export type WriteFailureOutcome = 'retain-draft' | 'refresh-view';

/** The host's error code, or an empty string when the failure carries none. */
export function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}

/**
 * Decide between keeping the user's unsaved input and rebuilding the view.
 *
 * A confirmed refusal — a validation error, a version conflict, a retired choice —
 * is the case where rebuilding is both unnecessary and destructive: the file did
 * not move, so the saved values the rebuild would show are the same ones the user
 * was editing away from. Everything else keeps the existing recovery behaviour,
 * because an unknown outcome may mean the write did land.
 *
 * The choice deliberately does not depend on the error message, only on the code
 * the host classified it with.
 */
export function decideWriteFailure(error: unknown): WriteFailureOutcome {
  return isConfirmedRejection(errorCode(error)) ? 'retain-draft' : 'refresh-view';
}

/**
 * The field a record of this type is named by for a person, when a refusal has to say which
 * record: the label field references to the type are shown with, or else its first required
 * single-line text. A unique field is passed over, since it holds the very value refused.
 */
export function namingFieldId(entities: readonly EntitySnapshot[], entityId: string): string | null {
  const own = entities.find(entity => entity.entityId === entityId)?.fields ?? [];
  const usable = (fieldId: string): boolean => own.some(field => field.fieldId === fieldId && !field.retired && !field.unique);
  for (const entity of entities) {
    for (const field of entity.fields) {
      const labelFieldId = field.reference?.labelFieldId;
      if (!field.retired && field.reference?.targetEntityId === entityId && labelFieldId !== undefined && usable(labelFieldId)) return labelFieldId;
    }
  }
  return own.find(field => !field.retired && !field.unique && field.required && storageLabel(field.storageKind) === 'Text' &&
    (field.presentation === null || field.presentation === 'singleLine'))?.fieldId ?? null;
}

/**
 * A reference refusal with the target's record ID replaced by its label. The host names
 * the target by ID, which an agent's or a view's batch needs to find the write; the person's
 * records have generated IDs, so their own form shows the record as its picker did. Only the place
 * the sentence puts the target, after "points at ", is replaced.
 */
export function nameTarget(message: string, recordId: string, label: string): string {
  const token = ` points at ${recordId}`;
  const at = message.indexOf(token);
  const next = message.charAt(at + token.length);
  if (label.trim() === '' || at < 0 || (next !== ' ' && next !== ',')) return message;
  return `${message.slice(0, at)} points at “${label.trim()}”${message.slice(at + token.length)}`;
}

/** The reference refusals the host words with the target's record ID. */
export const referenceRefusalCodes: readonly string[] = Object.freeze(['target-version-required', 'target-not-found', 'target-version-conflict']);

/**
 * Which reference field of a write points at <paramref name="recordId" />, and so which record
 * type to read the target from and by which field to name it: a form's values, a single field's
 * value, or a batch's writes. Null when the write names no such reference.
 */
export function referenceTargetOf(entities: readonly EntitySnapshot[], payload: Record<string, unknown>, recordId: string):
  { targetEntityId: string; labelFieldId: string } | null {
  const writes = Array.isArray(payload.writes) ? payload.writes as Record<string, unknown>[] : [payload];
  for (const write of writes) {
    const entity = entities.find(candidate => candidate.entityId === write?.entityId);
    if (entity === undefined) continue;
    const values: Record<string, unknown> = typeof write.values === 'object' && write.values !== null
      ? write.values as Record<string, unknown>
      : typeof write.fieldId === 'string' ? { [write.fieldId]: write.value } : {};
    for (const [fieldId, value] of Object.entries(values)) {
      const reference = entity.fields.find(field => field.fieldId === fieldId)?.reference;
      if (value === recordId && reference) return { targetEntityId: reference.targetEntityId, labelFieldId: reference.labelFieldId };
    }
  }
  return null;
}

/**
 * A duplicate refusal with the holding record's ID replaced by its label (ADR-0020). The host
 * names the holder by ID because the same sentence reaches an agent's audit; the person who
 * owns the file reads it here, where the record's own words are theirs to see.
 *
 * Only the place the Engine's sentence puts the holder is replaced, between " used by " and
 * " in ". Every occurrence was, so a short ID such as C, inside the field's or the record type's
 * name, garbled the sentence: "That “Alice”ode is already used by “Alice” in “Alice”ontacts".
 * A sentence of another shape is left as the host wrote it.
 */
export function nameHolder(message: string, recordId: string, label: string): string {
  const holder = ` used by ${recordId} in `;
  const at = message.indexOf(holder);
  if (label.trim() === '' || at < 0) return message;
  return `${message.slice(0, at)} used by “${label.trim()}” in ${message.slice(at + holder.length)}`;
}
