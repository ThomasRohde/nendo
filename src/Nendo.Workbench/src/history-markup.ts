import { escapeHtml, operationLabel, reversibilityLabel } from './format';
import type { EntitySnapshot, OperationAttribution, StoredOperationSnapshot } from './host';

/**
 * The operations inside one History entry, as "View changes" draws them. An operation an
 * automatic action made says which one; Help and the guides said History records that
 * before the entry drew it (2026-10-10).
 */
export function operationDetailsMarkup(operations: readonly StoredOperationSnapshot[], entities: readonly EntitySnapshot[] = []): string {
  return `<ul class="operation-details">${operations.map(operation => `<li>${escapeHtml(operationSentence(operation, entities))} · ${escapeHtml(reversibilityLabel(operation.reversibility))}${operation.attribution ? ` · <span class="operation-attribution">${escapeHtml(attributionLabel(operation.attribution))}</span>` : ''}</li>`).join('')}</ul>`;
}

/**
 * One operation and what it acts on: the field, the record type, and the record by its label.
 * Three deletes of the same type read as three identical lines, with nothing saying which
 * record each one took (UX-07). The names come from the stored payload and the file's
 * current names; the record's label from the host, which reads it even for a deleted record.
 */
export function operationSentence(operation: StoredOperationSnapshot, entities: readonly EntitySnapshot[]): string {
  const label = operationLabel(operation.operationType);
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(operation.canonicalJson) as { payload?: unknown };
    if (parsed !== null && typeof parsed === 'object' && parsed.payload !== null && typeof parsed.payload === 'object') payload = parsed.payload as Record<string, unknown>;
  } catch { /* a payload that does not parse still has its type */ }
  const text = (key: string): string | null => typeof payload[key] === 'string' ? payload[key] as string : null;
  const edit = payload.edit !== null && typeof payload.edit === 'object' ? payload.edit as Record<string, unknown> : null;
  const entityId = text('entityId') ?? (typeof edit?.entityId === 'string' ? edit.entityId : null);
  const fieldId = text('fieldId') ?? (typeof edit?.fieldId === 'string' ? edit.fieldId : null);
  const entity = entityId === null ? undefined : entities.find(candidate => candidate.entityId === entityId);
  const field = fieldId === null ? undefined : entities.flatMap(candidate => candidate.fields).find(candidate => candidate.fieldId === fieldId);
  const parts: string[] = [];
  if (field !== undefined) parts.push(entity !== undefined ? `${field.displayName} on ${entity.displayName}` : field.displayName);
  else if (entity !== undefined) parts.push(entity.displayName);
  if (operation.recordLabel) parts.push(`“${operation.recordLabel}”`);
  return parts.length === 0 ? label : `${label}: ${parts.join(' ')}`;
}

/** The automatic action that made a change, by its trigger's name, or by its ID once it has left the file. */
export function attributionLabel(attribution: OperationAttribution): string {
  return attribution.triggerName
    ? `made by the automatic action “${attribution.triggerName}”`
    : `made by an automatic action no longer in this file (${attribution.triggerId})`;
}
