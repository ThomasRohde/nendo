import { WorkbenchHostError, type AgentAccessMode, type AgentActivity, type ApplicationPlan, type BlockedCondition, type DesktopSessionView, type RevisionSummary } from './host-types';
import { derivedField } from './calculated-fields';
import { exactNumberText } from './scalars';

/**
 * Values and labels as a person reads them. Nothing here touches the document or
 * the session, so every function is exercised directly by scripts/format.test.mjs
 * rather than through a rendered page.
 */

/**
 * The sentence a save adds when an automatic action did not run because its condition could
 * not be worked out, or null when every action that should have run did. The save committed,
 * so this is said beside the outcome rather than as a refusal; until 2026-10-13 it was not
 * said at all, and a total the action keeps went stale with nobody told (EBH-01).
 */
export function blockedConditionsNotice(blocked: readonly BlockedCondition[] | undefined): string | null {
  if (blocked === undefined || blocked.length === 0) return null;
  if (blocked.length === 1) {
    const only = blocked[0]!;
    return `The automatic action '${only.displayName}' did not run: ${only.message} What it keeps may be out of date.`;
  }
  const names = blocked.map(condition => `'${condition.displayName}' (${condition.message})`).join('; ');
  return `${blocked.length} automatic actions did not run: ${names}. What they keep may be out of date.`;
}

/**
 * Whether the person's next key or press anywhere releases a retained sentence. A refusal is
 * about the thing just tried and is stale the moment they try the next thing. A success, a
 * notice held until its Refresh view button works, and a kept alert are not: a kept alert says
 * that an automatic action did not run, which is still true after the next keystroke.
 */
export function releasedByNextInteraction(outcome: { tone: 'done' | 'alert'; refresh?: unknown; kept?: boolean } | null): boolean {
  return outcome !== null && outcome.tone === 'alert' && outcome.refresh === undefined && outcome.kept !== true;
}

export function messageFor(error: unknown): string {
  if (error instanceof WorkbenchHostError || error instanceof Error) return error.message;
  return 'The Workbench could not complete the request.';
}

export function mutationKey(): string {
  return `studio-${crypto.randomUUID()}`;
}

export function stringValue(value: unknown): string {
  return exactNumberText(value) ?? (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
}

export function valueDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return stringValue(value);
}

export function sameValue(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown): unknown => value === undefined ? null : value;
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export function fieldName(plan: ApplicationPlan, fieldId: string): string {
  return plan.entity.fields.find((field) => field.semanticId === fieldId)?.displayName
    ?? derivedField(plan.entity.derivedFields, fieldId)?.displayName
    ?? fieldId;
}

export function choiceDisplay(field: { choices?: Array<{ id: string; displayName: string; retired: boolean }> }, value: unknown): string {
  const id = valueDisplay(value);
  const choice = field.choices?.find(choice => choice.id === id);
  return choice ? choice.displayName + (choice.retired ? ' (retired)' : '') : id;
}

export function storageLabel(value: string | number, unsupportedKind?: string | null): string {
  if (value === 8 || (typeof value === 'string' && value.toLowerCase() === 'unsupported')) {
    return unsupportedKind ? `Unsupported: ${unsupportedKind}` : 'Unsupported';
  }
  if (typeof value === 'string') return capitalise(value);
  return ['Text', 'Integer', 'Decimal', 'Boolean', 'Date', 'Date time', 'UUID', 'Reference'][value] ?? 'Unsupported';
}

// Presentation kinds are stored as camelCase identifiers. People read the screen, not the identifier.
export function presentationLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    singleLine: 'Single line',
    longText: 'Long text',
    markdown: 'Markdown text',
    singleChoice: 'Single choice',
    rating: 'Rating',
    date: 'Date',
    dateTime: 'Date and time',
    reference: 'Reference',
  };
  if (!value) return 'Stored value';
  return labels[value] ?? capitalise(value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
}

export function isAgentAccessMode(value: string): value is AgentAccessMode {
  return value === 'off' || value === 'inspect' || value === 'editData' ||
    value === 'shapeApp' || value === 'unattended';
}

export function agentModeLabel(value: AgentAccessMode): string {
  return ({
    off: 'Off', inspect: 'Inspect', editData: 'Edit data', shapeApp: 'Shape app',
    unattended: 'Unattended',
  })[value];
}

export function laneLabel(value: string | number): string {
  if (typeof value === 'string') return capitalise(value);
  return ['Genesis', 'Definition', 'Data', 'Checkpoint'][value] ?? 'Change';
}

/**
 * Whether History can take a change back, in a person's words. "Compensatable with retained
 * state" said nothing to someone deciding whether to accept (UX-06). None of them promises
 * universal undo: the retained-state class says when it holds.
 */
export function reversibilityLabel(value: string | number): string {
  const normalized = typeof value === 'number' ? value : ({ reversible: 0, reversibleWithRetainedState: 1, irreversibleDeclared: 2 } as Record<string, number>)[value] ?? 2;
  return normalized === 0 ? 'Can be undone' : normalized === 1 ? 'Can be undone if nothing has changed it since' : 'Cannot be undone';
}

/** A count and its noun, singular for one: "1 revisions shown" read wrong after every first edit (UX-16). */
export function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * Whether History's Undo stays available although the file cannot be edited: only when the one
 * thing withholding edits is approval of its automatic actions. An undo puts back what a
 * revision recorded and runs no action, so it is how a person recovers from an action they
 * have just withdrawn approval from (EBH-11, accepted 2026-10-13). A read-only or damaged file
 * keeps Undo off.
 */
export function undoAllowedWhileUnapproved(session: Pick<DesktopSessionView, 'health' | 'capabilities' | 'behaviourTrust'>): boolean {
  return approvalNeeded(session);
}

/** A healthy file whose editing waits on this device approving its automatic actions: the status pill's "Approval needed". */
export function approvalNeeded(session: Pick<DesktopSessionView, 'health' | 'capabilities' | 'behaviourTrust'>): boolean {
  return session.health === 'normal' && !session.capabilities.mutate &&
    session.behaviourTrust?.requiresApproval === true && !session.behaviourTrust.isApproved;
}

/**
 * Health's chip and File status sentence, in the words of the status pill. A file waiting on
 * approval read "Ready for editing" and "Changes are saved as you work" above the panel saying
 * editing was off (WSP-14).
 */
export function healthStatus(session: Pick<DesktopSessionView, 'health' | 'capabilities' | 'behaviourTrust' | 'fileName'>): { label: string; healthy: boolean; sentence: string } {
  if (approvalNeeded(session)) return { label: 'Approval needed', healthy: false,
    sentence: 'This file passed the checks required for editing. Editing waits until you approve its automatic actions below; reading, exports and backups work now.' };
  if (session.health === 'normal') return { label: 'Ready for editing', healthy: true, sentence: 'This file passed the checks required for editing. Changes are saved as you work.' };
  if (session.health === 'readOnly') return { label: 'Open read-only', healthy: false, sentence: 'You can inspect this file and create a backup without changing it. Editing and agent access are off.' };
  return { label: session.fileName === null ? 'No file open' : 'Recovery required', healthy: false, sentence: 'Choose Open file to inspect an application or a verified backup.' };
}

// The history a caller already holds decides this, not a module-level snapshot:
// a revision is compensatable until some later revision compensates it.
export function canCompensate(revision: RevisionSummary, history: RevisionSummary[]): boolean {
  return revision.canRequestCompensation && !history.some(candidate => candidate.compensationOfRevisionId === revision.revisionId);
}

/**
 * Every operation the Engine records, in a person's words. History drew 29 of them as their
 * identifiers (UX-07); a test reads the Engine's own list and fails on any left out.
 */
export function operationLabel(value: string): string {
  const labels: Record<string, string> = {
    'application.buildSearchIndex': 'Build the search index',
    'application.setLook': 'Change the file’s look',
    'application.setIcon': 'Change the file’s picture',
    'application.setNewFileLabel': 'Name a new file',
    'application.setPurpose': 'Say what the file is for',
    'behaviour.removeDefinition': 'Remove a calculation or action',
    'behaviour.setDefinition': 'Set a calculation or action',
    'data.backfillRetiredField': 'Fill a retired field',
    'data.convertLegacyReference': 'Convert old reference values',
    'data.createRecord': 'Add record',
    'data.deleteRecord': 'Delete record',
    'data.moveRecord': 'Move record',
    'data.restoreDeletedRecord': 'Restore deleted record',
    'data.setField': 'Set field',
    'data.setKeptInNewFiles': 'Keep a record in new files',
    'extension.putFile': 'Add or replace a custom-view file',
    'media.put': 'Embed a picture',
    'extension.removeFile': 'Remove a custom-view file',
    'extension.removePackage': 'Remove a custom-view package',
    'extension.setPackage': 'Add or update a custom-view package',
    'extension.setState': 'Save a custom view’s state',
    'identity.transition': 'Change the file’s identity',
    'schema.addChoice': 'Add a choice option',
    'schema.addField': 'Add field',
    'schema.configureReference': 'Point a reference at a record type',
    'schema.createEntity': 'Add record type',
    'schema.declareHierarchy': 'Keep records as a tree',
    'schema.declareLinkRule': 'Allow only listed links',
    'schema.removeChoice': 'Remove an added choice option',
    'schema.removeHierarchy': 'Stop keeping records as a tree',
    'schema.removeLinkRule': 'Stop checking links',
    'schema.renameEntity': 'Rename record type',
    'schema.renameField': 'Rename field',
    'schema.setChoiceMetadata': 'Change a choice',
    'schema.setFieldPresentation': 'Change how a field is shown',
    'schema.setFieldRequired': 'Make a field required or optional',
    'schema.setFieldSequence': 'Number a field automatically',
    'schema.setFieldUnique': 'Make a field unique or not',
    'schema.setKeptInNewFiles': 'Keep a record type in new files',
    'schema.setReferenceLabel': 'Change a reference’s label',
    'schema.setRetired': 'Retire or reactivate',
    'ui.addNode': 'Add to a screen',
    'ui.moveNode': 'Move on a screen',
    'ui.removeNode': 'Remove from a screen',
    'ui.removeProperty': 'Clear a screen setting',
    'ui.setProperty': 'Change a screen',
  };
  return labels[value] ?? value;
}

/** A local date and time from a datetime-local control, as an exact timestamp with this device's offset (WDV-18). */
export function withLocalOffset(local: string): string {
  const seconds = /T\d\d:\d\d$/.test(local) ? `${local}:00` : local;
  const minutes = -new Date(seconds).getTimezoneOffset();
  if (Number.isNaN(minutes)) return local;
  const sign = minutes >= 0 ? '+' : '-';
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${seconds}${sign}${pad(minutes / 60)}:${pad(minutes % 60)}`;
}

/**
 * The day a fold date names on screen: the person's own date, written yyyy-MM-dd as the
 * checkpoint text writes its dates (W-217). The UTC day can be tomorrow or yesterday where the
 * person is, so it stays in the stored checkpoint text and is never shown as their date; the
 * regional format gave the dialog '12.10.2026' beside a checkpoint's '2026-10-11'.
 */
export function foldDate(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const two = (part: number): string => String(part).padStart(2, '0');
  return `${String(at.getFullYear()).padStart(4, '0')}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** Whether a storage kind holds a date and time, however the host spells it. */
export function isDateTimeKind(kind: string | number): boolean {
  return kind === 5 || (typeof kind === 'string' && kind.toLowerCase() === 'datetime');
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 15)}…` : value;
}

export function cssToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function capitalise(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!);
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

export function isProposalPreviewable(state: string | number): boolean {
  return state === 3 || String(state).toLowerCase() === 'previewable';
}

export function proposalStateLabel(state: string | number): string {
  if (isProposalPreviewable(state)) return 'Ready to review';
  if (state === 6 || String(state).toLowerCase() === 'stale') return 'Needs a new preview';
  return 'Cannot apply';
}

export function activityLabel(activity: AgentActivity): string {
  if (activity.category === 'session') return activity.name === 'connected' ? 'Agent connected' : 'Agent disconnected';
  if (activity.category === 'resource') {
    if (activity.name.includes('/manifest')) return 'Read the file overview';
    if (activity.name.includes('/entities')) return 'Read app structure';
    if (activity.name.includes('/surfaces')) return 'Read app screens';
    if (activity.name.includes('/history')) return 'Read change history';
    if (activity.name.includes('/health')) return 'Checked the file’s health';
    if (activity.name.includes('/records')) return 'Read records';
    return 'Read file details';
  }
  // Every tool, so each call reads as what happened: a call is one entry since
  // 2026-09-27, and a tool with no label here would read only as "Agent activity".
  const labels: Record<string, string> = {
    'nendo.lease.acquire': 'Took edit access',
    'nendo.lease.status': 'Checked who has edit access',
    'nendo.lease.renew': 'Renewed edit access',
    'nendo.lease.release': 'Gave back edit access',
    'nendo.data.get_receipt': 'Read the outcome of a write',
    'nendo.read.resource': 'Read workspace details',
    'nendo.read.list': 'Listed what it can read',
    'nendo.data.create_record': 'Created a record',
    'nendo.data.create_records': 'Created records',
    'nendo.data.import_records': 'Imported records',
    'nendo.data.delete_record': 'Deleted a record',
    'nendo.data.move_record': 'Moved a record',
    'nendo.data.set_kept_in_new_files': 'Said whether a new file keeps a record',
    'nendo.data.put_media': 'Embedded a picture',
    'nendo.health.verify_integrity': 'Checked file integrity',
    'nendo.change_set.amend': 'Amended an app proposal',
    'nendo.change_set.accept': 'Accepted its own app proposal',
    'nendo.data.set_field': 'Edited a record',
    'nendo.data.update_record': 'Edited a record',
    'nendo.data.apply_writes': 'Wrote several records',
    'nendo.data.undo_revision': 'Undid one of its writes',
    'nendo.change_set.revalidate': 'Checked an app proposal again',
    'nendo.data.execute_command': 'Ran an app action',
    'nendo.change_set.begin': 'Began an app proposal',
    'nendo.change_set.add_operations': 'Added proposed changes',
    'nendo.change_set.validate': 'Validated an app proposal',
    'nendo.change_set.preview': 'Reviewed a proposal preview',
    'nendo.change_set.reject': 'Rejected an app proposal',
    'change set validated': 'Validated an app proposal',
    'editing revoked': 'Edit access revoked',
    'mode.off': 'Agent access turned off',
    'mode.inspect': 'Agent access: Inspect',
    'mode.editData': 'Agent access: Edit data',
    'mode.shapeApp': 'Agent access: Shape app',
  };
  return labels[activity.name] ?? (activity.category === 'mutation' ? 'Changed the file’s data' : 'Agent activity');
}

/**
 * Who made a revision, as its History entry says it: the person, in Studio or on a screen; an
 * agent, by the pseudonym the Agent page shows (ADR-0009); a custom view, by its package; or Nendo
 * itself. The guides and Help said History shows this before the entry drew it (2026-10-10).
 */
export function originLabel(origin: string, packages: ReadonlyArray<{ packageId: string; title: string }>): string {
  // The host records a Studio delete, a keep mark, a search-index build and History's own Undo
  // as 'studio' when the page names no writer; all are the person's own (UIT-06).
  if (origin === 'workbench' || origin === 'surface' || origin === 'studio') return 'you';
  // The person's own CSV import is recorded under its own origin, and History drew it as
  // "by csv" (R2AP-10).
  if (origin === 'csv') return 'you (CSV import)';
  if (origin.startsWith('agent-')) return `an agent (${origin})`;
  if (origin.startsWith('extension:')) {
    const packageId = origin.slice('extension:'.length);
    return `the custom view ${packages.find((pkg) => pkg.packageId === packageId)?.title ?? packageId}`;
  }
  if (origin === 'kernel') return 'Nendo';
  if (origin === 'recovery') return 'Nendo, in recovery';
  return origin;
}

/**
 * The sentence under a proposal's title. A proposal a custom view prepared names the view's
 * package (ADR-0013 Phase 3), so the person knows who is asking before reading what.
 */
export function proposalAuthorLine(preview: { origin?: string }, packages: ReadonlyArray<{ packageId: string; title: string }>): string {
  const prefix = 'extension:';
  if (typeof preview.origin !== 'string' || !preview.origin.startsWith(prefix)) return 'Your active file is unchanged until you accept.';
  const packageId = preview.origin.slice(prefix.length);
  const title = packages.find((pkg) => pkg.packageId === packageId)?.title;
  return `Prepared by the custom view ${title === undefined ? packageId : `${title} (${packageId})`}. Nothing changes until you accept.`;
}
