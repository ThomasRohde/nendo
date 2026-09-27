import { outlineErrors, outlineSurfaces, state, type SurfaceOutline } from './app-state';
import { escapeAttribute, escapeHtml, fieldName } from './format';
import type { ApplicationPlan, EntitySnapshot, RecordSnapshot, SurfaceNodePlan } from './host';
import { type MoveDirection, type OutlineNode, type OutlineRow, moveTarget, visibleRows } from './outline-model';
import { recordPlanOf } from './plan-selection';
import { accentDot, fieldValueMarkup, recordFieldDisplay } from './record-markup';
import { nodeFieldIds } from './surface-model';

/**
 * What an outline surface draws (ADR-0019 stage 6), as markup and nothing else, so the node
 * tests can render it through the real function. The reads and the gestures are in
 * outline-surface.ts, which this module never imports.
 */

/** How many records the find box reads, and so how many paths it opens at most. */
export const findLimit = 20;

export interface OutlineConfig {
  entityId: string;
  entity: EntitySnapshot | null;
  parentFieldId: string | null;
  ordered: boolean;
  titleFieldId: string | null;
  accentFieldId: string | null;
  expandDepth: number;
  reorder: boolean;
  columns: string[];
}

export function outlineConfig(plan: ApplicationPlan, node: SurfaceNodePlan): OutlineConfig {
  const entity = state.session.entities.find(candidate => candidate.entityId === plan.entity.semanticId) ?? null;
  const hierarchy = entity?.hierarchy ?? null;
  const parent = entity?.fields.find(field => field.fieldId === hierarchy?.parentFieldId);
  const declared = typeof node.properties.titleFieldId === 'string' ? node.properties.titleFieldId : null;
  const depth = typeof node.properties.expandDepth === 'number' ? node.properties.expandDepth : 2;
  const titleFieldId = declared ?? parent?.reference?.labelFieldId ?? null;
  return {
    entityId: plan.entity.semanticId,
    entity,
    parentFieldId: hierarchy?.parentFieldId ?? null,
    ordered: (hierarchy?.orderFieldId ?? null) !== null,
    titleFieldId,
    accentFieldId: typeof node.properties.accentFieldId === 'string' ? node.properties.accentFieldId : null,
    expandDepth: Math.min(4, Math.max(1, depth)),
    reorder: node.properties.reorder === true,
    columns: nodeFieldIds(node).filter(fieldId => fieldId !== titleFieldId),
  };
}

/** Whether a move can be offered at all: the surface allows it and the file is editable. */
export function canMove(config: OutlineConfig): boolean {
  return config.reorder && state.session.capabilities.mutate && state.session.health === 'normal' && config.entity?.retired !== true;
}

function rowLabel(plan: ApplicationPlan, config: OutlineConfig, node: OutlineNode): string {
  if (config.titleFieldId === null) return node.record.recordId;
  const text = recordFieldDisplay(recordPlanOf(node.record as RecordSnapshot), config.titleFieldId, plan.entity.derivedFields);
  return text === '' ? `Untitled (${node.record.recordId})` : text;
}

export function outlineSurfaceMarkup(plan: ApplicationPlan, node: SurfaceNodePlan): string {
  const config = outlineConfig(plan, node);
  const entry = outlineSurfaces.get(node.semanticId);
  if (config.parentFieldId === null)
    return `<div class="first-record-state" role="alert"><div class="record-glyph" aria-hidden="true">!</div><h3>${escapeHtml(plan.entity.displayName)} is not kept as a tree</h3><p>This outline needs the record type's hierarchy. Studio shows every record.</p></div>`;
  if (entry === undefined) {
    return outlineErrors.has(node.semanticId)
      ? `<div class="first-record-state" role="alert"><div class="record-glyph" aria-hidden="true">!</div><h3>This outline could not be read</h3><p>${escapeHtml(outlineErrors.get(node.semanticId)!)}</p><button class="secondary-button" type="button" data-outline-retry>Try again</button></div>`
      : '<div class="first-record-state" aria-busy="true"><div class="record-glyph" aria-hidden="true">…</div><h3>Loading this outline</h3><p>Reading the top of the tree.</p></div>';
  }
  const rows = visibleRows(entry.state);
  const title = typeof node.properties.title === 'string' && node.properties.title !== '' ? node.properties.title : `${plan.entity.displayName} outline`;
  const movable = canMove(config);
  const focus = entry.focus !== null && rows.some(row => row.kind === 'node' && row.node.record.recordId === entry.focus)
    ? entry.focus : rows.find((row): row is Extract<OutlineRow, { kind: 'node' }> => row.kind === 'node')?.node.record.recordId ?? null;
  const toolbar = `<div class="outline-surface-toolbar">
    <form class="outline-find" role="search" data-outline-find><label class="visually-hidden" for="outline-find-${escapeAttribute(node.semanticId)}">Find in ${escapeHtml(title)}</label><input id="outline-find-${escapeAttribute(node.semanticId)}" type="search" name="find" placeholder="Find" value="${escapeAttribute(entry.found?.text ?? '')}" autocomplete="off"${config.titleFieldId === null ? ' disabled' : ''}><button class="secondary-button" type="submit"${config.titleFieldId === null ? ' disabled' : ''}>Find</button></form>
    ${entry.found === null ? '' : `<p class="query-status" role="status">${escapeHtml(foundText(entry.found))}</p>`}
    ${movable ? moveButtonsMarkup(entry, focus, config) : ''}
  </div>`;
  if (rows.length === 0)
    return `${toolbar}<div class="first-record-state"><div class="record-glyph" aria-hidden="true">＋</div><h3>No ${escapeHtml(plan.entity.displayName)} records yet</h3><p>Add the first record to begin the tree.</p></div>`;
  const header = `<tr role="row"><th role="columnheader" scope="col">${escapeHtml(config.titleFieldId === null ? plan.entity.displayName : fieldName(plan, config.titleFieldId))}</th>${config.columns.map(fieldId => `<th role="columnheader" scope="col">${escapeHtml(fieldName(plan, fieldId))}</th>`).join('')}</tr>`;
  const body = rows.map(row => row.kind === 'more'
    ? `<tr class="outline-more-row" role="row" aria-level="${row.depth}"><td role="gridcell" colspan="${config.columns.length + 1}" style="--outline-depth:${row.depth - 1}"><button class="text-button" type="button" data-outline-more="${escapeAttribute(row.parentKey)}" tabindex="-1">Show more <span class="outline-more-count">(${row.loaded} shown)</span></button></td></tr>`
    : nodeRowMarkup(plan, config, entry, row, rows, focus, movable)).join('');
  return `${toolbar}<div class="outline-surface-frame"><table class="outline-table" role="treegrid" aria-label="${escapeAttribute(title)}" data-outline-surface="${escapeAttribute(node.semanticId)}"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
}

function foundText(found: NonNullable<SurfaceOutline['found']>): string {
  if (found.ids.size === 0) return `Nothing matches “${found.text}”.`;
  const opened = `${found.ids.size} ${found.ids.size === 1 ? 'match' : 'matches'} for “${found.text}”, opened where ${found.ids.size === 1 ? 'it sits' : 'they sit'}`;
  return found.more ? `${opened}. More match; the first ${findLimit} are shown.` : `${opened}.`;
}

function moveButtonsMarkup(entry: SurfaceOutline, focus: string | null, config: OutlineConfig): string {
  const button = (direction: MoveDirection, label: string, keys: string): string => {
    const off = focus === null || moveTarget(entry.state, focus, direction, config.ordered) === null;
    return `<button class="secondary-button" type="button" data-outline-move="${direction}" aria-keyshortcuts="${keys}"${off ? ' disabled' : ''}>${label}</button>`;
  };
  return `<div class="outline-moves" role="toolbar" aria-label="Move the focused record">${config.ordered ? `${button('up', 'Move up', 'Alt+Shift+ArrowUp')}${button('down', 'Move down', 'Alt+Shift+ArrowDown')}` : ''}${button('outdent', 'Outdent', 'Alt+Shift+ArrowLeft')}${button('indent', 'Indent', 'Alt+Shift+ArrowRight')}</div><p class="query-status outline-move-hint">Drag a row, or press Alt, Shift and an arrow key, to move it.</p>`;
}

function nodeRowMarkup(
  plan: ApplicationPlan, config: OutlineConfig, entry: SurfaceOutline,
  row: Extract<OutlineRow, { kind: 'node' }>, rows: OutlineRow[], focus: string | null, movable: boolean,
): string {
  const node = row.node;
  const id = node.record.recordId;
  const record = recordPlanOf(node.record as RecordSnapshot);
  const label = rowLabel(plan, config, node);
  const siblings = rows.filter((candidate): candidate is Extract<OutlineRow, { kind: 'node' }> =>
    candidate.kind === 'node' && candidate.node.parentRecordId === node.parentRecordId);
  const expanded = node.childCount > 0 ? ` aria-expanded="${row.expanded}"` : '';
  const selected = state.selectedRecordId === id;
  const toggle = node.childCount > 0
    ? `<button class="outline-toggle" type="button" data-outline-toggle="${escapeAttribute(id)}" tabindex="-1" aria-label="${row.expanded ? 'Close' : 'Open'} ${escapeAttribute(label)}"><span aria-hidden="true">${row.expanded ? '▾' : '▸'}</span></button>`
    : '<span class="outline-toggle-space" aria-hidden="true"></span>';
  const count = node.childCount > 0 ? `<span class="outline-count" title="${node.childCount} directly under it">${node.childCount}</span>` : '';
  const classes = ['outline-row', entry.found?.ids.has(id) ? 'is-found' : '', selected ? 'is-selected' : '', movable ? 'can-drag' : ''].filter(Boolean).join(' ');
  return `<tr class="${classes}" role="row" data-outline-row="${escapeAttribute(id)}" aria-level="${row.depth}" aria-setsize="${siblings.length}" aria-posinset="${siblings.indexOf(row) + 1}"${expanded}${selected ? ' aria-selected="true"' : ''} tabindex="${id === focus ? 0 : -1}">`
    + `<td role="gridcell" class="outline-title-cell" style="--outline-depth:${row.depth - 1}"><div class="outline-title">${toggle}${accentDot(plan, config.accentFieldId, record)}<button class="outline-open" type="button" data-outline-open="${escapeAttribute(id)}" tabindex="-1">${escapeHtml(label)}</button>${count}</div></td>`
    + config.columns.map(fieldId => `<td role="gridcell">${fieldValueMarkup(plan, record, fieldId)}</td>`).join('')
    + '</tr>';
}
