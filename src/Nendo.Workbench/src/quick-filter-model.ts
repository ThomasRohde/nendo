import { choiceDisplay, escapeAttribute, escapeHtml, storageLabel } from './format';
import type { FieldPlan, SurfaceNodePlan } from './host-types';
import { clauseFilters, type QueryFilter } from './record-window';

/**
 * A person narrowing a list, board or matrix by one value of one field (W-172, ADR-0004
 * 2026-10-05). Nothing here is declared or stored: the fields come from the schema, and the
 * pick is renderer state for the file session, one per screen.
 */
export interface QuickFilter {
  fieldId: string;
  /** The choice ID or target record ID to match, or null for records that hold none. */
  value: string | null;
  /** What the pill says is showing: the field's name and the value's label. */
  label: string;
}

/** The target records one reference field offers, read when the menu first opens. */
export type QuickFilterTargets =
  | { state: 'loading' }
  | { state: 'ready'; items: Array<{ recordId: string; label: string }> }
  | { state: 'overflowing'; ceiling: number }
  | { state: 'failed'; message: string };

/** The screens that offer Filter: their records come from one window the clause can narrow. */
export const quickFilterKinds: ReadonlySet<string> = new Set(['recordList', 'boardSurface', 'matrixSurface']);

/** The query's clause budget; a screen whose authored clauses spend it offers no Filter. */
export const maximumQueryClauses = 8;

/** The most target records a reference offers in the menu. */
export const maximumQuickFilterTargets = 100;

/** The fields a person may narrow a screen by: active single choices and bound references. */
export function quickFilterFields(fields: readonly FieldPlan[]): FieldPlan[] {
  return fields.filter(field => !field.retired && (
    field.presentation === 'singleChoice' && field.options.length > 0 ||
    storageLabel(field.storageKind) === 'Reference' && field.reference != null));
}

/** Whether a screen offers Filter: the right kind, a field to narrow by, and room for one clause. */
export function offersQuickFilter(surface: SurfaceNodePlan | null, fields: readonly FieldPlan[]): boolean {
  return surface !== null && quickFilterKinds.has(surface.kind) &&
    quickFilterFields(fields).length > 0 && clauseFilters(surface).length < maximumQueryClauses;
}

/** The one clause a pick adds to the screen's own. */
export function quickFilterClause(filter: QuickFilter): QueryFilter {
  return filter.value === null
    ? { fieldId: filter.fieldId, operator: 'isNull' }
    : { fieldId: filter.fieldId, operator: 'eq', value: filter.value };
}

/**
 * What a select's option carries: the empty value for Any, `none` for Not set, and `v:` before
 * a stored value. Every stored value is prefixed, so no choice ID or record ID, whatever it
 * spells, can be read as Any or Not set (review R-012).
 */
export const notSetValue = 'none';
export const optionValue = (value: string): string => `v:${value}`;

/** The pick a select's value makes, or null when it asks for every record again. */
export function quickFilterFor(field: FieldPlan, option: string, targets: QuickFilterTargets | undefined): QuickFilter | null {
  if (option === '') return null;
  if (option === notSetValue) return { fieldId: field.semanticId, value: null, label: `${field.displayName}: Not set` };
  if (!option.startsWith('v:')) return null;
  const selected = option.slice(2);
  const label = field.presentation === 'singleChoice'
    ? choiceDisplay(field, selected)
    : targets?.state === 'ready' ? targets.items.find(item => item.recordId === selected)?.label ?? selected : selected;
  return { fieldId: field.semanticId, value: selected, label: `${field.displayName}: ${label}` };
}

/** The pill that says what a screen is narrowed to, with the button that clears it. */
export function quickFilterPillMarkup(filter: QuickFilter | undefined, closeIcon: string): string {
  if (filter === undefined) return '';
  return `<span class="drill-pill" role="status" data-testid="quick-filter-pill">Showing ${escapeHtml(filter.label)}<button type="button" class="icon-button drill-clear" data-quick-filter-clear aria-label="Show all records">${closeIcon}</button></span>`;
}

/**
 * The Filter menu: one select per field, the current pick selected. A reference lists its
 * target records once they are read, and says why it cannot when there are too many.
 */
export function quickFilterMenuMarkup(
  fields: readonly FieldPlan[],
  current: QuickFilter | undefined,
  targets: (field: FieldPlan) => QuickFilterTargets | undefined,
  open: boolean,
  filterIcon: string,
): string {
  const selects = quickFilterFields(fields).map(field => {
    const name = escapeAttribute(field.semanticId);
    const chosen = current?.fieldId !== field.semanticId ? '' : current.value === null ? notSetValue : optionValue(current.value);
    const option = (value: string, label: string): string =>
      `<option value="${escapeAttribute(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    const notSet = field.required ? '' : option(notSetValue, 'Not set');
    if (field.presentation === 'singleChoice') {
      const options = field.options
        .filter(id => optionValue(id) === chosen || !field.choices?.some(choice => choice.id === id && choice.retired))
        .map(id => option(optionValue(id), choiceDisplay(field, id))).join('');
      return `<label>${escapeHtml(field.displayName)}<select data-quick-filter="${name}">${option('', 'Any')}${options}${notSet}</select></label>`;
    }
    const read = targets(field);
    const body = read?.state === 'ready'
      ? read.items.map(item => option(optionValue(item.recordId), item.label)).join('') + notSet
      : read?.state === 'overflowing'
        ? `<option disabled>More than ${read.ceiling} to list</option>`
        : read?.state === 'failed' ? '<option disabled>Could not be read</option>' : '<option disabled>Reading…</option>';
    return `<label>${escapeHtml(field.displayName)}<select data-quick-filter="${name}"${read?.state === 'ready' ? '' : ' disabled'}>${option('', 'Any')}${body}</select></label>`;
  }).join('');
  return `<details class="quick-filter" data-testid="quick-filter"${open ? ' open' : ''}><summary class="secondary-button"><span class="button-glyph" aria-hidden="true">${filterIcon}</span>Filter${current === undefined ? '' : ' (1)'}</summary>`
    + `<div class="quick-filter-panel" role="group" aria-label="Show only records with">${selects}</div></details>`;
}
