import { WorkbenchHostError, type AgentAccessMode, type AgentActivity, type ApplicationPlan, type RevisionSummary } from './host-types';
import { derivedField } from './calculated-fields';
import { exactNumberText } from './scalars';

/**
 * Values and labels as a person reads them. Nothing here touches the document or
 * the session, so every function is exercised directly by scripts/format.test.mjs
 * rather than through a rendered page.
 */

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

export function reversibilityLabel(value: string | number): string {
  const normalized = typeof value === 'number' ? value : ({ reversible: 0, reversibleWithRetainedState: 1, irreversibleDeclared: 2 } as Record<string, number>)[value] ?? 2;
  return normalized === 0 ? 'Reversible' : normalized === 1 ? 'Compensatable with retained state' : 'Not compensatable';
}

// The history a caller already holds decides this, not a module-level snapshot:
// a revision is compensatable until some later revision compensates it.
export function canCompensate(revision: RevisionSummary, history: RevisionSummary[]): boolean {
  return revision.canRequestCompensation && !history.some(candidate => candidate.compensationOfRevisionId === revision.revisionId);
}

export function operationLabel(value: string): string {
  const labels: Record<string, string> = {
    'data.createRecord': 'Create record',
    'data.deleteRecord': 'Delete record',
    'data.restoreDeletedRecord': 'Restore deleted record',
    'data.setField': 'Set field',
    'data.setKeptInNewFiles': 'Keep in new files',
    'schema.setKeptInNewFiles': 'Keep a type in new files',
    'application.setNewFileLabel': 'Name a new file',
    'schema.createEntity': 'Create entity',
    'schema.addField': 'Add field',
    'ui.addNode': 'Add surface node',
    'ui.setProperty': 'Set surface property',
  };
  return labels[value] ?? value;
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
    if (activity.name.includes('/manifest')) return 'Read workspace overview';
    if (activity.name.includes('/entities')) return 'Read app structure';
    if (activity.name.includes('/surfaces')) return 'Read app surfaces';
    if (activity.name.includes('/history')) return 'Read change history';
    if (activity.name.includes('/health')) return 'Checked workspace health';
    if (activity.name.includes('/records')) return 'Read records';
    return 'Read workspace details';
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
    'nendo.health.verify_integrity': 'Checked file integrity',
    'nendo.change_set.amend': 'Amended an app proposal',
    'nendo.change_set.accept': 'Accepted its own app proposal',
    'nendo.data.set_field': 'Edited a record',
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
  return labels[activity.name] ?? (activity.category === 'mutation' ? 'Changed workspace data' : 'Agent activity');
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
