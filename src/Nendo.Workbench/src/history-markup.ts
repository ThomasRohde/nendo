import { escapeHtml, operationLabel, reversibilityLabel } from './format';
import type { OperationAttribution, StoredOperationSnapshot } from './host';

/**
 * The operations inside one History entry, as "View changes" draws them. An operation an
 * automatic action made says which one; Help and the guides said History records that
 * before the entry drew it (2026-10-10).
 */
export function operationDetailsMarkup(operations: readonly StoredOperationSnapshot[]): string {
  return `<ul class="operation-details">${operations.map(operation => `<li>${escapeHtml(operationLabel(operation.operationType))} · ${escapeHtml(reversibilityLabel(operation.reversibility))}${operation.attribution ? ` · <span class="operation-attribution">${escapeHtml(attributionLabel(operation.attribution))}</span>` : ''}</li>`).join('')}</ul>`;
}

/** The automatic action that made a change, by its trigger's name, or by its ID once it has left the file. */
export function attributionLabel(attribution: OperationAttribution): string {
  return attribution.triggerName
    ? `made by the automatic action “${attribution.triggerName}”`
    : `made by an automatic action no longer in this file (${attribution.triggerId})`;
}
