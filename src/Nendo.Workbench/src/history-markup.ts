import { counted, escapeHtml, laneLabel, operationLabel, reversibilityLabel } from './format';
import type { EntitySnapshot, OperationAttribution, RevisionSummary, StoredOperationSnapshot } from './host';

/**
 * The operations inside one History entry, as "View changes" draws them. An operation an
 * automatic action made says which one; Help and the guides said History records that
 * before the entry drew it.
 */
export function operationDetailsMarkup(operations: readonly StoredOperationSnapshot[], entities: readonly EntitySnapshot[] = [], offered: boolean | null = false): string {
  return `<ul class="operation-details">${operations.map(operation => `<li>${escapeHtml(operationSentence(operation, entities))} · ${escapeHtml(historyReversibilityLabel(operation, offered))}${operation.attribution ? ` · <span class="operation-attribution">${escapeHtml(attributionLabel(operation.attribution))}</span>` : ''}</li>`).join('')}</ul>`;
}

/**
 * What History can do about one operation. A created record and a record an undo brought back
 * declare themselves irreversible, because the record ID stays reserved, yet History undoes both
 * by deleting the record (ADR-0023); "Cannot be undone" beside a working Undo button contradicted
 * it. Only where History offers the Undo. Elsewhere a class that can be undone says that
 * History will not do it: a view added with its settings is one entry History never offers, and
 * "Can be undone" beside "Cannot be undone here" read as a promise it did not keep.
 * Null says nothing either way: an entry History has already undone, or a host that cannot say.
 */
export function historyReversibilityLabel(operation: Pick<StoredOperationSnapshot, 'operationType' | 'reversibility'>, offered: boolean | null): string {
  return offered === true && (operation.operationType === 'data.createRecord' || operation.operationType === 'data.restoreDeletedRecord')
    ? 'Undone by deleting the record; its ID stays reserved'
    : offered !== false || reversibilityLabel(operation.reversibility) === 'Cannot be undone'
      ? reversibilityLabel(operation.reversibility)
      : `${reversibilityLabel(operation.reversibility)}, but not from History`;
}

/**
 * Whether History offers to undo a revision, for the labels beside its operations: true or false
 * where the native host says, and null for a revision already undone, which needs no warning that
 * History will not undo it, or a host that does not compute the offer (the browser preview).
 */
export function historyUndoOffer(
  revision: Pick<RevisionSummary, 'revisionId' | 'canRequestCompensation'> | undefined,
  history: readonly Pick<RevisionSummary, 'compensationOfRevisionId'>[],
  hostComputesOffer: boolean,
): boolean | null {
  if (revision === undefined || !hostComputesOffer) return null;
  if (history.some((candidate) => candidate.compensationOfRevisionId === revision.revisionId)) return null;
  return revision.canRequestCompensation;
}

/**
 * One operation and what it acts on: the field, the record type, and the record by its label.
 * Three deletes of the same type read as three identical lines, with nothing saying which
 * record each one took. The names come from the stored payload and the file's
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

/** The record an operation acts on, from its stored payload, or null for one that acts on no record. */
function operationRecordId(operation: Pick<StoredOperationSnapshot, 'canonicalJson'>): string | null {
  try {
    const parsed = JSON.parse(operation.canonicalJson) as { payload?: { recordId?: unknown } };
    return typeof parsed?.payload?.recordId === 'string' ? parsed.payload.recordId : null;
  } catch { return null; }
}

/** Whether History's Undo needs to read a revision's operations before it can say whether to ask. */
export function undoMayAsk(revision: Pick<RevisionSummary, 'lane' | 'operationCount'>): boolean {
  return laneLabel(revision.lane) !== 'Data' || revision.operationCount > 1;
}

/**
 * What History's Undo asks before it acts, or null where it acts at once.
 * An undo of one record's edit stays one press. An undo that reaches several records,
 * or a definition or a package, names the change and says what undoing it does first: one press
 * on the row beside a batch import deleted every record it made. The operations are the
 * revision's first page; `more` says the page did not hold them all.
 */
export function undoQuestion(
  revision: Pick<RevisionSummary, 'description' | 'lane' | 'operationCount'>,
  operations: readonly Pick<StoredOperationSnapshot, 'operationType' | 'canonicalJson'>[],
  more: boolean,
): { headingId: string; title: string; bodyHtml: string; confirmLabel: string } | null {
  const title = `Undo “${escapeHtml(revision.description)}”?`;
  const changes = counted(revision.operationCount, 'change');
  if (laneLabel(revision.lane) !== 'Data') {
    const code = operations.length > 0 && operations.every((operation) => operation.operationType.startsWith('extension.'));
    // Operations that could not be read leave open whether this is a package: both are said.
    const effect = operations.length === 0
      ? 'This puts the file’s definition, or its custom view code, back as it was before this change. Code that comes back runs wherever its view is shown.'
      : code
        ? 'This puts the file’s custom view code back as it was before this change. Code that comes back runs wherever its view is shown, and code this change added leaves the file.'
        : 'This puts the file’s definition back as it was before this change: record types, fields, screens, rules, or the file’s look or purpose. Records keep their stored values.';
    return { headingId: 'undo-heading', title, confirmLabel: 'Undo',
      bodyHtml: `<p>${escapeHtml(`${effect} It undoes ${changes}.`)}</p><p>History lists the undo as a new change. An undo of a definition change cannot itself be undone from History; make the change again instead.</p>` };
  }
  const records = new Set(operations.map(operationRecordId).filter((id): id is string => id !== null));
  if (!more && records.size <= 1) return null;
  // Where the page did not hold every operation, what it held is a floor, not a count.
  const reach = more ? `at least ${counted(records.size, 'record')}` : counted(records.size, 'record');
  const recordsOf = (types: readonly string[]): number =>
    new Set(operations.filter((operation) => types.includes(operation.operationType)).map(operationRecordId).filter((id) => id !== null)).size;
  const effects = [
    [recordsOf(['data.createRecord', 'data.restoreDeletedRecord']), 'deletes %s this change added or brought back; their IDs stay reserved'],
    [recordsOf(['data.deleteRecord']), 'brings back %s this change deleted'],
    [recordsOf(['data.setField', 'data.backfillRetiredField']), 'puts back the earlier values of %s'],
    [recordsOf(['data.setKeptInNewFiles']), 'puts back whether %s are kept in new files'],
  ].filter(([count]) => (count as number) > 0).map(([count, words]) => (words as string).replace('%s', counted(count as number, 'record')));
  const said = operations.length === 0 ? `It undoes ${changes}; Nendo could not list which records they touch.`
    : effects.length === 0 ? `It undoes ${changes} across ${reach}.` : `It ${effects.join(', ')}${more ? ', and more' : ''}: ${changes} across ${reach}.`;
  return { headingId: 'undo-heading', title, confirmLabel: 'Undo',
    bodyHtml: `<p>${escapeHtml(said)}</p><p>History lists the undo as a new change, which can be undone in turn.</p>` };
}
