import { prepareApplication, recoverAfterWriteFailure, refreshStudioQuery, reloadReadWindows, runMutation } from './actions';
import { keptChoice, keptChoices, keptDefaultProposal, keptDefaultSentence, keptFromChoice, keptText } from './new-file';
import { type CellFocusedEvent, type CellKeyDownEvent, type CellValueChangedEvent, type ColDef, type ColumnResizedEvent, type FullWidthCellKeyDownEvent, type GridApi, type GridOptions, createGrid, themeQuartz } from 'ag-grid-community';
import { type StudioQuery, fileScopedClearable, recordWindows, state, studioQueries, studioWindows } from './app-state';
import { calculatedDisplay } from './calculated-fields';
import { client } from './client';
import { deviceStorage } from './device-storage';
import { choiceDisplay, escapeAttribute, escapeHtml, messageFor, mutationKey, storageLabel, valueDisplay } from './format';
import { type CalculationResult, type EntitySnapshot, type ReadPage, type RecordPlan, type RecordSnapshot } from './host';
import { icon } from './icons';
import { type MoveDirection, type OutlineNode, type OutlineRow, movePayload, moveTarget, visibleRows } from './outline-model';
import { activePlan, currentRecipe, derivedFor, recordPlanOf, recordsForEntity, sessionEntity, snapshotFieldPlans } from './plan-selection';
import { wireRecordPager } from './reads';
import { wireRecordForm } from './record-form';
import { recordSheetMarkup } from './record-markup';
import { emptyWindowQuery, windowRequest } from './record-window';
import { ratingMarkup, ratingScaleOf, ratingSteps } from './rating';
import { exactNumberText, parseScalar } from './scalars';
import { announce, content, requiredElement, rerender, setBusy, showError } from './shell';
import { recordTypeProposal, renameSchemaProposal } from './studio';
import { type ColumnWidths, nextSort, queryStatusText, rememberWidths, rememberedWidths, sortOf, withFilter, withSort } from './studio-columns';
import { StudioHeader, type StudioHeaderOptions } from './studio-header';
import { type StudioLayout, captureOutlineRead, outlineErrorIsCurrent, outlines, readOutlineLevel, refreshOutline, studioLayouts, studioOutlineErrors } from './studio-outline';
import { recordPagerMarkup } from './surface-markup';
import { choiceStyle } from './tones';
/**
 * Studio data: the permanent route into a file. It shows the records of one
 * record type in a grid with its own sort and filter, and keeps working when no
 * custom surface compiles at all.
 *
 * AG Grid lives here and nowhere else; the Use surfaces are hand-rolled DOM.
 */

export interface GridRow {
  recordId: string;
  recordVersion: number;
  values: Record<string, unknown>;
  referenceLabels?: Record<string, string | null>;
  /** Calculated results, kept out of `values` so no editor ever writes one back. */
  calculations?: Record<string, CalculationResult>;
  /** The record's own say in whether a new file keeps it (ADR-0022); null follows its type. */
  keptInNewFiles?: boolean | null;
  /** In the outline, where the row sits: a record's depth and children, or the row that reads more of a level. */
  outline?: { kind: 'node'; depth: number; childCount: number; expanded: boolean; label: string }
    | { kind: 'more'; depth: number; parentKey: string; loaded: number };
}

export const nendoGridTheme = themeQuartz
  .withParams({
    accentColor: '#005fb8',
    backgroundColor: '#ffffff',
    borderColor: '#e5e5e5',
    browserColorScheme: 'light',
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
    fontSize: 13,
    foregroundColor: '#1b1b1b',
    headerBackgroundColor: '#ffffff',
    headerTextColor: '#5d5d5d',
    oddRowBackgroundColor: '#ffffff',
    rowHoverColor: '#f3f3f4',
    selectedRowBackgroundColor: '#e5eff9',
    spacing: 6,
  }, 'light')
  .withParams({
    accentColor: '#60cdff',
    backgroundColor: '#2d2e30',
    borderColor: '#3b3c3e',
    browserColorScheme: 'dark',
    foregroundColor: '#ffffff',
    headerBackgroundColor: '#2d2e30',
    headerTextColor: '#c5c5c5',
    oddRowBackgroundColor: '#2d2e30',
    rowHoverColor: '#38393b',
    selectedRowBackgroundColor: '#1f3a4a',
  }, 'dark');

// The grid instance currently mounted, if any. It is disposed on every render:
// AG Grid owns DOM that replacing #studio-content would otherwise orphan.
let gridApi: GridApi<GridRow> | null = null;

/** The most a Studio cell's large-text editor holds: far past any note, short of a runaway paste. */
const largeTextCharacters = 1_000_000;

export function destroyGrid(): void {
  gridApi?.destroy();
  gridApi = null;
}

// ------------------------------------------------------------------------------------------
// Columns the person shapes: widths kept for this device, a header click that sorts every
// record of the type through the host, and a header rename that ends in a reviewed proposal.

// The widths of this file session, by record type. Storage seeds them and keeps them for the
// next session; when the device refuses storage they still hold until the file closes.
const columnWidths = new Map<string, ColumnWidths>();
fileScopedClearable({ clear() { columnWidths.clear(); headerFocusAfterDraw = null; } });
// A sort made from the keyboard puts the focus back on its header once the table is redrawn.
let headerFocusAfterDraw: string | null = null;

function widthsFor(entityId: string): ColumnWidths {
  let widths = columnWidths.get(entityId);
  if (widths === undefined) {
    const applicationId = state.session.manifest?.applicationId;
    const storage = deviceStorage();
    widths = applicationId && storage !== null ? rememberedWidths(storage, applicationId, entityId) : {};
    columnWidths.set(entityId, widths);
  }
  return widths;
}

function keepColumnWidths(entityId: string, event: ColumnResizedEvent<GridRow>): void {
  // Only what the person did: a drag of the edge, or a double-click that fits the content.
  if (!event.finished || (event.source !== 'uiColumnResized' && event.source !== 'autosizeColumns')) return;
  const changed: ColumnWidths = {};
  for (const column of event.columns ?? []) changed[column.getColId()] = column.getActualWidth();
  if (Object.keys(changed).length === 0) return;
  const applicationId = state.session.manifest?.applicationId;
  const storage = deviceStorage();
  columnWidths.set(entityId, applicationId && storage !== null
    ? rememberWidths(storage, applicationId, entityId, changed)
    : { ...widthsFor(entityId), ...changed });
}

/** Where a column starts before the person sizes it: wide enough for what its kind holds. */
function defaultWidth(field: EntitySnapshot['fields'][number]): number {
  if (field.presentation === 'longText' || field.presentation === 'markdown') return 300;
  if (field.presentation === 'singleChoice') return 170;
  if (field.presentation === 'date') return 140;
  if (ratingScaleOf(field) !== null) return 150;
  const kind = storageLabel(field.storageKind);
  return kind === 'Boolean' ? 110 : kind === 'Integer' || kind === 'Decimal' || kind === 'Date' ? 130 : kind === 'Date time' ? 180 : kind === 'Reference' ? 210 : 200;
}

/** A remembered width replaces the column's own sizing, flex included. */
function withRememberedWidth(column: ColDef<GridRow>, widths: ColumnWidths): ColDef<GridRow> {
  const width = column.colId === undefined ? undefined : widths[column.colId];
  return width === undefined ? column : { ...column, width, flex: undefined };
}

function sortByColumn(entity: EntitySnapshot, columnId: string, byKeyboard: boolean): void {
  if (state.actionInFlight) return;
  const query = studioQueries.get(entity.entityId);
  const sort = nextSort(query, columnId);
  headerFocusAfterDraw = byKeyboard ? columnId : null;
  const name = [...entity.fields, ...(entity.derivedFields ?? [])].find(field => field.fieldId === columnId)?.displayName ?? columnId;
  void applyStudioQuery(entity.entityId, withSort(query, sort),
    sort.sortFieldId === null ? 'Back to record order.' : `Sorted by ${name}, ${sort.descending ? 'descending' : 'ascending'}.`);
}

function renameColumn(entity: EntitySnapshot, fieldId: string, name: string): void {
  const revision = state.session.manifest?.definitionRevision;
  if (revision === undefined) return;
  try {
    const proposal = renameSchemaProposal(entity.entityId, fieldId, name, revision);
    void prepareApplication({ actionLabel: String(proposal.title), applicationName: entity.displayName, proposalPayload: proposal }, 'data');
  } catch (error) { showError(messageFor(error)); }
}

function studioHeader(options: StudioHeaderOptions): Pick<ColDef<GridRow>, 'headerComponent' | 'headerComponentParams'> {
  return { headerComponent: StudioHeader, headerComponentParams: options };
}

// ------------------------------------------------------------------------------------------
// The outline of a declared hierarchy (ADR-0019 stage 5). A record type that declares one opens
// as an outline; the flat table stays one click away. Levels are read from the host a parent at
// a time and read again whenever the file has moved on.

let outlineFocus: string | null = null;
fileScopedClearable({ clear() { outlineFocus = null; } });
const moveKeys: Readonly<Record<string, MoveDirection>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'indent', ArrowLeft: 'outdent' };

function isMoveKey(event: KeyboardEvent): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && Object.hasOwn(moveKeys, event.key);
}

function layoutOf(entity: EntitySnapshot): StudioLayout {
  return entity.hierarchy ? studioLayouts.get(entity.entityId) ?? 'outline' : 'table';
}

async function toggleOutline(entity: EntitySnapshot, recordId: string): Promise<void> {
  const outline = outlines.get(entity.entityId);
  if (outline === undefined) return;
  outlineFocus = recordId;
  if (outline.expanded.delete(recordId)) { rerender(); return; }
  if (!outline.levels.has(recordId)) {
    const current = captureOutlineRead();
    const level = await readOutlineLevel(entity.entityId, recordId, null);
    if (!current()) return;
    if (level.changeSequence !== outline.changeSequence) { refreshOutline(entity); return; }
    outline.levels.set(recordId, level);
  }
  outline.expanded.add(recordId);
  rerender();
}

async function readMore(entity: EntitySnapshot, parentKey: string): Promise<void> {
  const outline = outlines.get(entity.entityId);
  const level = outline?.levels.get(parentKey);
  if (outline === undefined || level === undefined || level.nextCursor === null) return;
  const current = captureOutlineRead();
  const more = await readOutlineLevel(entity.entityId, parentKey, level.nextCursor);
  if (!current()) return;
  if (more.changeSequence !== outline.changeSequence) { refreshOutline(entity); return; }
  outline.levels.set(parentKey, { items: [...level.items, ...more.items], nextCursor: more.nextCursor });
  rerender();
}

async function moveInOutline(entity: EntitySnapshot, direction: MoveDirection): Promise<void> {
  const outline = outlines.get(entity.entityId);
  if (outline === undefined || outlineFocus === null || !state.session.capabilities.mutate) return;
  const target = moveTarget(outline, outlineFocus, direction);
  if (target === null) return;
  const payload = movePayload(outline, outlineFocus, target, mutationKey());
  if (payload === null) return;
  // Indenting puts the record under the sibling above; open it so the record stays in view.
  if (target.parentRecordId !== null) outline.expanded.add(target.parentRecordId);
  const label = { up: 'Moved up.', down: 'Moved down.', indent: 'Indented.', outdent: 'Outdented.' }[direction];
  await runMutation('data.moveRecord', payload, label, true);
}

function outlineLabel(entity: EntitySnapshot, node: OutlineNode): string {
  const parent = entity.fields.find(field => field.fieldId === entity.hierarchy?.parentFieldId);
  const labelField = parent?.reference?.labelFieldId;
  const value = labelField === undefined ? null : node.record.values[labelField];
  return typeof value === 'string' && value !== '' ? value : node.record.recordId;
}

/** Enables each move button for the focused record, without redrawing the grid. */
function syncMoveButtons(entity: EntitySnapshot): void {
  const outline = outlines.get(entity.entityId);
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-move]')) {
    button.disabled = outline === undefined || outlineFocus === null || !state.session.capabilities.mutate || entity.retired === true ||
      moveTarget(outline, outlineFocus, button.dataset.move as MoveDirection) === null;
  }
}

function outlineToolbarMarkup(): string {
  const button = (direction: MoveDirection, label: string, keys: string): string =>
    `<button class="secondary-button" type="button" data-move="${direction}" aria-keyshortcuts="${keys}" disabled>${label}</button>`;
  return `<div class="outline-toolbar" role="toolbar" aria-label="Move the focused record">
    ${button('up', 'Move up', 'Alt+Shift+ArrowUp')}${button('down', 'Move down', 'Alt+Shift+ArrowDown')}${button('outdent', 'Outdent', 'Alt+Shift+ArrowLeft')}${button('indent', 'Indent', 'Alt+Shift+ArrowRight')}
    <p class="query-status">Alt, Shift and an arrow key move the focused record; Enter opens or closes it.</p>
  </div>`;
}

function outlineGridRows(entity: EntitySnapshot, rows: OutlineRow[]): GridRow[] {
  return rows.map<GridRow>(row => row.kind === 'more'
    ? { recordId: `more:${row.parentKey}`, recordVersion: 0, values: {}, outline: { kind: 'more', depth: row.depth, parentKey: row.parentKey, loaded: row.loaded } }
    : {
      recordId: row.node.record.recordId,
      recordVersion: row.node.record.recordVersion,
      values: { ...row.node.record.values },
      referenceLabels: (row.node.record as RecordSnapshot).referenceLabels ?? undefined,
      calculations: recordPlanOf(row.node.record as RecordSnapshot).calculations,
      keptInNewFiles: (row.node.record as RecordSnapshot).keptInNewFiles ?? null,
      outline: { kind: 'node', depth: row.depth, childCount: row.node.childCount, expanded: row.expanded, label: outlineLabel(entity, row.node) },
    });
}

function outlineColumn(entity: EntitySnapshot): ColDef<GridRow> {
  return {
    colId: 'outline',
    headerName: entity.displayName,
    pinned: 'left',
    minWidth: 260,
    flex: 2,
    editable: false,
    valueGetter: parameters => parameters.data?.outline?.kind === 'node' ? parameters.data.outline.label : '',
    cellRenderer: (parameters: { data?: GridRow }) => {
      const meta = parameters.data?.outline;
      const cell = document.createElement('span');
      cell.className = 'outline-cell';
      if (meta === undefined) return cell;
      cell.style.setProperty('--outline-depth', String(meta.depth - 1));
      if (meta.kind === 'more') {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'text-button outline-more';
        more.textContent = `Show more (${meta.loaded} shown)`;
        more.addEventListener('click', () => void readMore(entity, meta.parentKey).catch(error => showError(messageFor(error))));
        cell.append(more);
        return cell;
      }
      const recordId = parameters.data!.recordId;
      if (meta.childCount > 0) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'outline-toggle';
        toggle.dataset.outlineToggle = recordId;
        toggle.setAttribute('aria-expanded', String(meta.expanded));
        toggle.setAttribute('aria-label', `${meta.expanded ? 'Close' : 'Open'} ${meta.label}`);
        toggle.textContent = meta.expanded ? '\u25BE' : '\u25B8';
        toggle.addEventListener('click', () => void toggleOutline(entity, recordId).catch(error => showError(messageFor(error))));
        cell.append(toggle);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'outline-toggle-space';
        spacer.setAttribute('aria-hidden', 'true');
        cell.append(spacer);
      }
      const label = document.createElement('span');
      label.className = 'outline-label';
      label.textContent = meta.label;
      cell.append(label);
      if (meta.childCount > 0) {
        const count = document.createElement('span');
        count.className = 'outline-count';
        count.textContent = String(meta.childCount);
        count.setAttribute('aria-label', `${meta.childCount} ${meta.childCount === 1 ? 'child' : 'children'}`);
        cell.append(count);
      }
      return cell;
    },
  };
}

export async function selectDataEntity(entityId: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    state.selectedEntityId = entityId;
    state.creatingRecord = false;
    state.selectedRecordId = null;
    state.view = 'data';
    if (recordWindows.get(entityId)?.page.changeSequence !== state.session.manifest?.changeSequence) {
      // Browsing declares nothing, so the window carries the explicit empty query
      // rather than leaving later pages to guess what it was opened with.
      const query = emptyWindowQuery();
      const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', windowRequest(entityId, query));
      if (page.changeSequence !== state.session.manifest?.changeSequence) await reloadReadWindows();
      else recordWindows.set(entityId, { page, cursors: [null], index: 0, query });
    }
    if (studioQueries.has(entityId)) await refreshStudioQuery(entityId);
    for (const key of recordWindows.keys())
      if (key !== entityId && key !== activePlan()?.entity.semanticId) recordWindows.delete(key);
    rerender();
  } catch (error) { showError(messageFor(error)); }
  finally { state.actionInFlight = false; setBusy(false); }
}

export function renderData(): void {
  const entity = sessionEntity();
  if (entity === null) {
    const recipe = currentRecipe();
    content.innerHTML = `<section class="empty-state file-empty" data-testid="valid-empty-state">
      <img class="empty-brand-mark" src="/nendo-mark.png" alt="" />
      <h2>This file is ready</h2>
      <p>Create a record type and add your first record.</p>${state.session.entities.some(entity => entity.retired) ? '<button id="show-retired-empty" class="secondary-button" type="button">Show retired data</button>' : ''}
      <div class="action-row"><button id="new-entity" class="primary-button" data-action type="button">Create record type</button>
      ${recipe === null ? '' : `<button id="start-application" class="secondary-button" data-action type="button">${icon('plus')} ${escapeHtml(recipe.actionLabel)}</button>`}</div>
      <div class="message-slot" role="alert" hidden></div>
    </section>`;
    wireNewEntity();
    content.querySelector('#show-retired-empty')?.addEventListener('click', () => { state.showRetiredData = true; void selectDataEntity(state.session.entities[0].entityId); });
    content.querySelector<HTMLButtonElement>('#start-application')?.addEventListener('click', () => {
      if (recipe !== null) void prepareApplication(recipe, 'data');
    });
    return;
  }

  const layout = layoutOf(entity);
  const outline = layout === 'outline' ? outlines.get(entity.entityId) : undefined;
  const outlineError = studioOutlineErrors.get(entity.entityId);
  if (layout === 'outline' && !outlineErrorIsCurrent(entity.entityId) && (outline === undefined || outline.changeSequence !== state.session.manifest?.changeSequence)) refreshOutline(entity);
  const outlineRows = outline === undefined ? [] : visibleRows(outline);
  const outlineRecords = outlineRows.flatMap(row => row.kind === 'node' ? [recordPlanOf(row.node.record as RecordSnapshot)] : []);
  const records = layout === 'outline' ? outlineRecords : recordsForEntity(entity.entityId, null);
  const layoutControl = entity.hierarchy
    ? `<div class="theme-control layout-control" role="group" aria-label="Layout">${(['outline', 'table'] as const).map(option =>
      `<button type="button" data-layout="${option}" aria-pressed="${layout === option}">${option === 'outline' ? 'Outline' : 'Table'}</button>`).join('')}</div>`
    : '';
  const emptyGrid = layout === 'outline'
    ? `<div class="first-record-state"><div class="record-glyph" aria-hidden="true">＋</div><h3>${outline === undefined ? 'Reading the outline' : `No ${escapeHtml(entity.displayName)} records yet`}</h3><p>${outline === undefined ? 'The tree arrives a level at a time.' : 'Add the first record here.'}</p></div>`
    : `<div class="first-record-state"><div class="record-glyph" aria-hidden="true">＋</div><h3>${studioQueries.has(entity.entityId) ? 'No matching records' : `No ${escapeHtml(entity.displayName)} records yet`}</h3><p>${studioQueries.has(entity.entityId) ? 'Change the filter or click Clear to see all records.' : 'Add the first record here.'}</p></div>`;
  content.innerHTML = `<div class="data-workspace" data-testid="application-data-state">
    <aside class="entity-panel" aria-label="Record types">
      <div class="panel-heading"><span>Record types</span></div>
      <label class="checkbox-field"><input id="show-retired-data" type="checkbox" ${state.showRetiredData ? 'checked' : ''} />Show retired data</label>
      ${state.session.entities.filter(candidate => state.showRetiredData || !candidate.retired).map(candidate => `<button class="entity-row ${candidate.entityId === entity.entityId ? 'is-active' : ''}" data-entity-id="${escapeAttribute(candidate.entityId)}" type="button" ${candidate.entityId === entity.entityId ? 'aria-current="page"' : ''}><span>${escapeHtml(candidate.displayName)}${candidate.retired ? ' (retired)' : ''}</span></button>`).join('')}
      <button id="new-entity" class="text-button" data-action type="button">Create record type</button>
    </aside>
    <section class="data-panel" aria-label="${escapeAttribute(entity.displayName)} data">
      <header class="data-toolbar">
        <div class="data-toolbar-lead"><p>${entity.retired ? 'Retired record type. Stored values remain available for inspection.' : state.session.capabilities.mutate ? 'Edit a cell to save a change.' : 'Read-only data. Editing is off.'}</p>${layoutControl}${keptDefaultMarkup(entity)}</div>
        <button id="data-new-record" class="primary-button" data-action type="button" ${entity.retired ? 'disabled' : ''}>Add ${escapeHtml(entity.displayName)}</button>
      </header>
      ${layout === 'outline' ? outlineToolbarMarkup() : studioQueryMarkup(entity)}
      ${layout === 'outline' && outlineError !== undefined ? `<p class="query-status" role="alert">${escapeHtml(outlineError)} <button class="secondary-button" type="button" data-studio-outline-retry>Try reading again</button></p>` : ''}
      <div class="message-slot data-message" role="alert" hidden></div>
      ${(layout === 'outline' ? outlineRows.length : records.length) > 0
        ? `<div id="record-grid" class="record-grid${layout === 'outline' ? ' outline-grid' : ''}" data-testid="record-grid" aria-label="${escapeAttribute(entity.displayName)} ${layout === 'outline' ? 'outline' : 'records'}"></div>`
        : emptyGrid}
      <footer class="data-footer">${layout === 'outline' ? '' : recordPagerMarkup(entity.entityId, null)}</footer>
    </section>
  </div>`;
  wireNewEntity();
  content.querySelector<HTMLButtonElement>('[data-studio-outline-retry]')?.addEventListener('click', () => refreshOutline(entity));
  if (layout === 'table') wireStudioQuery(entity);
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-layout]')) {
    button.addEventListener('click', () => {
      studioLayouts.set(entity.entityId, button.dataset.layout as StudioLayout);
      if (button.dataset.layout === 'table') void selectDataEntity(entity.entityId); else rerender();
    });
  }
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-move]')) {
    button.addEventListener('click', () => void moveInOutline(entity, button.dataset.move as MoveDirection));
  }
  requiredElement<HTMLInputElement>('#show-retired-data').addEventListener('change', event => {
    state.showRetiredData = (event.currentTarget as HTMLInputElement).checked;
    const selected = sessionEntity();
    if (selected) void selectDataEntity(selected.entityId); else rerender();
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-entity-id]')) {
    button.addEventListener('click', () => void selectDataEntity(button.dataset.entityId!));
  }
  requiredElement<HTMLButtonElement>('#data-new-record').addEventListener('click', () => {
    state.creatingRecord = true;
    renderDataCreateDialog(entity);
  });
  content.querySelector<HTMLButtonElement>('#kept-default')?.addEventListener('click', () => {
    const revision = state.session.manifest?.definitionRevision;
    if (revision === undefined) return;
    const proposal = keptDefaultProposal(entity.entityId, entity.displayName, entity.keptInNewFiles !== true, revision);
    void prepareApplication({ actionLabel: String(proposal.title), applicationName: state.session.fileName ?? 'This file', proposalPayload: proposal }, 'data');
  });
  if (layout === 'outline') {
    if (outlineRows.length > 0) mountRecordGrid(entity, records, outlineRows);
    syncMoveButtons(entity);
  } else {
    if (records.length > 0) mountRecordGrid(entity, records);
    wireRecordPager();
  }
}

/**
 * What a new file keeps of this record type by default (ADR-0022), and the change that turns
 * it. A definition change, so it is offered as a proposal the person reviews.
 */
function keptDefaultMarkup(entity: EntitySnapshot): string {
  const keeps = entity.keptInNewFiles === true;
  const canChange = state.session.capabilities.mutate && !entity.retired;
  return `<p class="kept-default" data-testid="kept-default">${escapeHtml(keptDefaultSentence(entity.displayName, keeps))}
    ${canChange ? `<button id="kept-default" class="text-button" data-action type="button">${keeps ? 'Leave them out by default' : 'Keep them by default'}</button>` : ''}</p>`;
}

/**
 * The filter above the table. Sorting is the column headers' job: a click on a field's name
 * sorts every record of the type by it, so the form only says which records to show.
 */
export function studioQueryMarkup(entity: EntitySnapshot): string {
  const query = studioQueries.get(entity.entityId);
  const options = (selected: string | null | undefined): string => entity.fields
    .filter(field => storageLabel(field.storageKind) !== 'Unsupported')
    .map(field => `<option value="${escapeAttribute(field.fieldId)}" ${selected === field.fieldId ? 'selected' : ''}>${escapeHtml(field.displayName)}</option>`).join('');
  const nameOf = (fieldId: string): string => [...entity.fields, ...(entity.derivedFields ?? [])].find(field => field.fieldId === fieldId)?.displayName ?? fieldId;
  return `<form id="studio-query" class="studio-query" aria-label="Filter records">
    <label>Filter field<select name="field"><option value="">All records</option>${options(query?.fieldId)}</select></label>
    <label>Match<select name="operator">${[['contains','Contains text'],['eq','Equals'],['ne','Does not equal'],['lt','Less than'],['le','At most'],['gt','Greater than'],['ge','At least'],['isNull','Not set'],['isNotNull','Has a value']].map(([op,label])=>`<option value="${op}" ${query?.operator === op ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>Value<input name="value" type="text" value="${escapeAttribute(query?.text ?? '')}" /></label>
    <button class="secondary-button" data-action type="submit">Apply</button><button id="clear-query" class="text-button" data-action type="button" ${query ? '' : 'hidden'}>Clear</button>
    <p class="query-status" role="status">${escapeHtml(queryStatusText(query, nameOf))}</p>
  </form>`;
}

export function wireStudioQuery(entity: EntitySnapshot): void {
  const form = requiredElement<HTMLFormElement>('#studio-query');
  const fieldControl = form.elements.namedItem('field') as HTMLSelectElement;
  const operator = form.elements.namedItem('operator') as HTMLSelectElement;
  const value = form.elements.namedItem('value') as HTMLInputElement;
  const update = (): void => {
    const field = entity.fields.find(field => field.fieldId === fieldControl.value);
    const contains = operator.querySelector<HTMLOptionElement>('[value="contains"]')!;
    contains.disabled = !field || storageLabel(field.storageKind) !== 'Text';
    if (contains.disabled && operator.value === 'contains') operator.value = 'eq';
    value.disabled = !field || ['isNull','isNotNull'].includes(operator.value);
    operator.disabled = !field;
    value.placeholder = field && storageLabel(field.storageKind) === 'Boolean' ? 'true or false' : '';
  };
  fieldControl.addEventListener('change', update); operator.addEventListener('change', update); update();
  form.addEventListener('submit', event => {
    event.preventDefault();
    const field = entity.fields.find(field => field.fieldId === fieldControl.value);
    try {
      const filters: StudioQuery['filters'] = field ? [{ fieldId: field.fieldId, operator: operator.value,
        ...(['isNull','isNotNull'].includes(operator.value) ? {} : { value: parseScalar(storageLabel(field.storageKind), value.value) }) }] : [];
      if (filters.some(filter => 'value' in filter && filter.value === null)) throw new Error('Choose Not set to find missing values.');
      void applyStudioQuery(entity.entityId, withFilter(studioQueries.get(entity.entityId), { fieldId: fieldControl.value, operator: operator.value, text: value.value, filters }));
    } catch (error) { showError(messageFor(error)); }
  });
  requiredElement<HTMLButtonElement>('#clear-query').addEventListener('click', () => void applyStudioQuery(entity.entityId, null));
}

export async function applyStudioQuery(entityId: string, query: StudioQuery | null, message?: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true; setBusy(true);
  const previous = studioQueries.get(entityId);
  try {
    if (query) studioQueries.set(entityId, query); else { studioQueries.delete(entityId); studioWindows.delete(entityId); }
    await reloadReadWindows();
    state.selectedRecordId = null; state.creatingRecord = false; rerender();
    announce(message ?? (query ? 'Query applied.' : 'Showing all records.'));
  } catch (error) {
    if (previous) studioQueries.set(entityId, previous); else studioQueries.delete(entityId);
    showError(messageFor(error));
  } finally { state.actionInFlight = false; setBusy(false); }
}

export function renderDataCreateDialog(entity: EntitySnapshot): void {
  const fields = snapshotFieldPlans(entity).filter(field => !field.retired);
  content.innerHTML = `<div class="record-sheet-page" role="region" aria-labelledby="new-record-heading">${recordSheetMarkup(entity.displayName, null, fields, [],
    { backId: 'cancel-create', backLabel: 'Back to Data', headingId: 'new-record-heading', heading: `Add ${entity.displayName}`, submitLabel: `Add ${entity.displayName}` })}</div>`;
  wireRecordForm(null, entity.entityId, fields, () => { state.creatingRecord = false; state.view = 'data'; rerender(); });
  content.querySelector<HTMLInputElement>('#record-form .record-sheet-body :is(input, select, textarea)')?.focus();
}

export function renderDataRecordDialog(entity: EntitySnapshot, record: RecordPlan): void {
  destroyGrid();
  const fields = snapshotFieldPlans(entity);
  content.innerHTML = `<div class="record-sheet-page" role="region" aria-labelledby="record-details-heading">${recordSheetMarkup(entity.displayName, record, fields, derivedFor(entity),
    { backId: 'close-inspector', backLabel: 'Back to Data', headingId: 'record-details-heading', heading: `${entity.displayName} details`, submitLabel: 'Save changes' })}</div>`;
  wireRecordForm(record, entity.entityId, fields, () => { state.view = 'data'; rerender(); });
  if (!state.session.capabilities.mutate) {
    for (const control of content.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, [data-action]')) control.disabled = true;
  }
  requiredElement<HTMLButtonElement>('#close-inspector').focus();
}

export function wireNewEntity(): void {
  content.querySelector<HTMLButtonElement>('#new-entity')?.addEventListener('click', () => {
    content.innerHTML = `<div class="dialog-page"><section class="record-form-card">
      <header><button id="cancel-entity" class="text-button" type="button" data-dismiss>Back to Data</button><h2>Create record type</h2><p>Start with a required text field. Review the change before adding it to this file.</p></header>
      <form id="entity-form" class="record-form"><label>Record type<input id="entity-name" name="entityName" required maxlength="120" autocomplete="off" /></label>
      <label>First field<input id="entity-field-name" name="fieldName" required maxlength="120" value="Name" autocomplete="off" /></label>
      <div class="message-slot" role="alert" hidden></div><div class="form-actions"><button class="primary-button" data-action type="submit">Preview record type</button></div></form>
    </section></div>`;
    requiredElement<HTMLButtonElement>('#cancel-entity').addEventListener('click', () => { state.view = 'data'; rerender(); });
    requiredElement<HTMLFormElement>('#entity-form').addEventListener('submit', event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      try {
        const payload = recordTypeProposal(String(values.get('entityName')), String(values.get('fieldName')));
        void prepareApplication({ actionLabel: 'Create record type', applicationName: String(values.get('entityName')), proposalPayload: payload }, 'data');
      } catch (error) { showError(messageFor(error)); }
    });
    requiredElement<HTMLInputElement>('#entity-name').focus();
  });
}

export function mountRecordGrid(entity: EntitySnapshot, records: RecordPlan[], outlineRows?: OutlineRow[]): void {
  const rowData = outlineRows !== undefined ? outlineGridRows(entity, outlineRows) : records.map<GridRow>((record) => ({
    recordId: record.semanticId,
    recordVersion: record.version,
    values: { ...record.values },
    referenceLabels: record.referenceLabels,
    calculations: record.calculations,
    keptInNewFiles: record.keptInNewFiles ?? null,
  }));
  // The outline keeps the tree's order, so only the flat table sorts.
  const query = outlineRows === undefined ? studioQueries.get(entity.entityId) : undefined;
  const sorts = outlineRows === undefined;
  // One text column takes the room the others leave, so the table fills the panel without
  // squeezing every column to its minimum; the rest start at a width that suits their kind.
  const primaryFieldId = outlineRows === undefined
    ? entity.fields.find(field => !field.retired && storageLabel(field.storageKind) === 'Text' && field.presentation !== 'singleChoice' && field.presentation !== 'longText' && field.presentation !== 'markdown')?.fieldId
    : undefined;
  const editable = (field: EntitySnapshot['fields'][number]): ColDef<GridRow> => ({
    colId: field.fieldId,
    headerName: field.displayName,
    ...studioHeader({
      sort: sortOf(query, field.fieldId),
      onSort: sorts && !field.retired && storageLabel(field.storageKind) !== 'Unsupported' ? byKeyboard => sortByColumn(entity, field.fieldId, byKeyboard) : null,
      onRename: state.session.capabilities.mutate && !entity.retired && !field.retired ? name => renameColumn(entity, field.fieldId, name) : null,
    }),
    editable: (parameters) => parameters.data?.outline?.kind !== 'more' &&
      state.session.capabilities.mutate && !entity.retired && !field.retired && storageLabel(field.storageKind) !== 'Reference',
    ...(field.fieldId === primaryFieldId ? { minWidth: 220, flex: 1 } : { minWidth: 90, width: defaultWidth(field) }),
    valueGetter: (parameters) => {
      const value = parameters.data?.values[field.fieldId] ?? null;
      return exactNumberText(value) ?? value;
    },
    cellDataType: false,
    // A choice cell carries its option's tone beside the label. Studio never reads a
    // surface definition, but a tone is the option's own metadata, so it shows here too.
    cellRenderer: field.presentation === 'singleChoice'
      ? (parameters: { value?: unknown }) => {
        const value = parameters.value;
        if (value === null || value === undefined || value === '') return '';
        const cell = document.createElement('span');
        cell.className = 'studio-choice-cell';
        const dot = document.createElement('span');
        dot.className = 'status-dot';
        dot.setAttribute('style', choiceStyle(field, value));
        dot.setAttribute('aria-hidden', 'true');
        cell.append(dot, document.createTextNode(choiceDisplay(field, value)));
        return cell;
      }
      // A rating reads as its dots and its number, so a column of them is scannable and
      // a value outside the scale is still legible as the number it is.
      : ratingScaleOf(field) !== null
        ? (parameters: { value?: unknown }) => {
          const cell = document.createElement('span');
          cell.className = 'rating-cell';
          cell.innerHTML = ratingMarkup(parameters.value, ratingScaleOf(field)!, '');
          return cell;
        }
        : undefined,
    valueFormatter: (parameters) => storageLabel(field.storageKind) === 'Reference' && parameters.value != null
      ? parameters.data?.referenceLabels?.[field.fieldId] ?? '(No target label)' : field.presentation === 'singleChoice' ? choiceDisplay(field, parameters.value) : valueDisplay(parameters.value),
    valueSetter: (parameters) => {
      if (parameters.data === undefined) return false;
      parameters.data.values[field.fieldId] = parameters.newValue;
      return true;
    },
    cellEditor: field.presentation === 'singleChoice' || storageLabel(field.storageKind) === 'Boolean' || ratingScaleOf(field) !== null
      ? 'agSelectCellEditor'
      : field.presentation === 'date'
        ? 'agDateStringCellEditor'
        : field.presentation === 'longText' || field.presentation === 'markdown' ? 'agLargeTextCellEditor' : 'agTextCellEditor',
    cellEditorPopup: field.presentation === 'longText' || field.presentation === 'markdown',
    cellEditorParams: field.presentation === 'singleChoice'
      ? { values: [...(field.required ? [] : ['']), ...field.options.filter(id => !field.choices?.some(choice => choice.id === id && choice.retired))] }
      : storageLabel(field.storageKind) === 'Boolean' ? { values: field.required ? [true, false] : [null, true, false] }
        // A rating is edited by choosing one of the scale's numbers. The values are the
        // lexemes the cell already carries, so a chosen one needs no conversion on the
        // way back in; the dots are how it reads, not how it is typed.
        : ratingScaleOf(field) !== null
          ? { values: [...(field.required ? [] : ['']), ...ratingSteps(ratingScaleOf(field)!).map(String)] }
          // The large-text editor cuts what it holds at 200 characters unless told otherwise.
          : field.presentation === 'longText' || field.presentation === 'markdown' ? { maxLength: largeTextCharacters, rows: 12, cols: 60 }
            : undefined,
  });
  // A calculated column reads like the record page does: the same four states, the
  // same words, never an editor. Studio is the permanent route into a file, so a
  // number that disagrees between the table and the form is a number nobody can trust.
  const calculated = (field: NonNullable<EntitySnapshot['derivedFields']>[number]): ColDef<GridRow> => ({
    colId: field.fieldId,
    headerName: field.displayName,
    headerTooltip: `Calculated: ${field.expression}`,
    // The host sorts by a calculated value as it sorts by a stored one.
    ...studioHeader({ sort: sortOf(query, field.fieldId), onSort: sorts ? byKeyboard => sortByColumn(entity, field.fieldId, byKeyboard) : null, onRename: null }),
    editable: false,
    minWidth: 135,
    cellClass: 'calculated-cell',
    cellDataType: false,
    valueGetter: (parameters) => calculatedDisplay(parameters.data?.calculations?.[field.fieldId]).text,
  });
  const openRow = (recordId: string | undefined): void => {
    const record = records.find(item => item.semanticId === recordId);
    if (record && !state.actionInFlight) renderDataRecordDialog(entity, record);
  };
  const widths = widthsFor(entity.entityId);
  const options: GridOptions<GridRow> = {
    theme: nendoGridTheme,
    // In the outline, Alt, Shift and an arrow key move the record; the grid must not move the focus first.
    // Alt alone with Left or Right stays the app's Back and Forward.
    defaultColDef: outlineRows === undefined ? { sortable: false }
      : { sortable: false, suppressKeyboardEvent: parameters => isMoveKey(parameters.event) },
    rowData,
    columnDefs: [
      ...(outlineRows !== undefined ? [outlineColumn(entity)] : []),
      // Opening a record is a quiet icon at the row's start: faint until the row is pointed
      // at or focused, so a column of identical buttons no longer outweighs the data.
      { colId: 'openRecord', headerName: '', width: 40, pinned: 'left', resizable: false, cellClass: 'record-open-cell', editable: false, sortable: false,
        cellRenderer: (parameters: { data?: GridRow }) => {
          if (parameters.data?.outline?.kind === 'more') return '';
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'record-open-button';
          button.tabIndex = -1;
          button.innerHTML = icon('expand');
          button.title = 'Open the record';
          button.setAttribute('aria-label', `Open ${entity.displayName} record`);
          button.addEventListener('click', () => openRow(parameters.data?.recordId));
          return button;
        } },
      ...[
        ...entity.fields.filter(field => state.showRetiredData || !field.retired).map(editable),
        ...(entity.derivedFields ?? []).map(calculated),
        keptColumn(entity),
        { field: 'recordVersion', colId: 'recordVersion', headerName: 'Version', width: 90, editable: false,
          valueFormatter: parameters => parameters.data?.outline?.kind === 'more' ? '' : String(parameters.value ?? '') } satisfies ColDef<GridRow>,
      ].map(column => withRememberedWidth(column, widths)),
    ],
    onCellValueChanged: (event) => void commitGridEdit(event),
    onColumnResized: (event) => keepColumnWidths(entity.entityId, event),
    // Enter or Space on the open cell opens the record, as a click on its icon does.
    onCellKeyDown: (event: CellKeyDownEvent<GridRow> | FullWidthCellKeyDownEvent<GridRow>) => {
      const key = event.event instanceof KeyboardEvent ? event.event : null;
      if (key === null || !('colDef' in event) || (key.key !== 'Enter' && key.key !== ' ')) return;
      if (event.colDef.colId === 'openRecord' && event.data?.outline?.kind !== 'more') {
        key.preventDefault();
        openRow(event.data?.recordId);
      } else if (outlineRows !== undefined && event.data?.outline?.kind === 'node' && event.colDef.colId === 'outline' && event.data.outline.childCount > 0) {
        key.preventDefault();
        void toggleOutline(entity, event.data.recordId).catch(error => showError(messageFor(error)));
      }
    },
    ...(outlineRows === undefined ? {} : {
      onCellFocused: (event: CellFocusedEvent<GridRow>) => {
        // The outline grid neither sorts nor filters, so a displayed index is an index into its rows.
        const row = event.rowIndex === null ? undefined : rowData[event.rowIndex];
        outlineFocus = row?.outline?.kind === 'node' ? row.recordId : null;
        syncMoveButtons(entity);
      },
    }),
    ensureDomOrder: true,
    // Every column is drawn, not only those in view. A record type has tens of fields at most
    // and a page of rows is bounded, so this costs little, and a column scrolled out of sight
    // still exists for a screen reader, a find in the page and a measurement.
    suppressColumnVirtualisation: true,
    getRowId: (parameters) => parameters.data.recordId,
    singleClickEdit: false,
    stopEditingWhenCellsLoseFocus: true,
    suppressMovableColumns: true,
  };
  const gridElement = requiredElement<HTMLElement>('#record-grid');
  gridApi = createGrid<GridRow>(gridElement, options);
  // A move key is taken here, in the capture phase, before the grid or the app's own shortcuts see it.
  if (outlineRows !== undefined) gridElement.addEventListener('keydown', event => {
    if (!isMoveKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void moveInOutline(entity, moveKeys[event.key]);
  }, true);
  if (headerFocusAfterDraw !== null) {
    gridApi.setFocusedHeader(headerFocusAfterDraw);
    headerFocusAfterDraw = null;
  }
  // The focused record keeps its place across a move, an open or a redraw.
  if (outlineRows !== undefined && outlineFocus !== null) {
    const index = rowData.findIndex(row => row.recordId === outlineFocus);
    if (index >= 0) { gridApi.ensureIndexVisible(index); gridApi.setFocusedCell(index, 'outline'); }
  }
}

/**
 * Whether a new file of this application keeps the record (ADR-0022): its own mark, or its
 * type's default. A fact about the record rather than a value of it, so a choice here writes
 * no field and moves no version.
 */
function keptColumn(entity: EntitySnapshot): ColDef<GridRow> {
  const typeKeeps = entity.keptInNewFiles === true;
  return {
    colId: 'keptInNewFiles',
    headerName: 'In new files',
    headerTooltip: keptDefaultSentence(entity.displayName, typeKeeps),
    width: 150,
    editable: (parameters) => parameters.data?.outline?.kind !== 'more' && state.session.capabilities.mutate,
    cellDataType: false,
    cellClass: 'kept-cell',
    valueGetter: (parameters) => parameters.data?.outline?.kind === 'more' ? '' : keptChoice(parameters.data?.keptInNewFiles),
    valueFormatter: (parameters) => parameters.data?.outline?.kind === 'more' ? '' : keptText(typeKeeps, parameters.data?.keptInNewFiles),
    valueSetter: (parameters) => {
      if (parameters.data === undefined) return false;
      parameters.data.keptInNewFiles = keptFromChoice(parameters.newValue);
      return true;
    },
    cellEditor: 'agSelectCellEditor',
    cellEditorParams: { values: [...keptChoices] },
  };
}

export async function commitGridEdit(event: CellValueChangedEvent<GridRow>): Promise<void> {
  if (event.data === undefined || event.newValue === event.oldValue || event.colDef.colId === undefined) return;
  if (event.colDef.colId === 'keptInNewFiles') {
    const target = sessionEntity();
    if (target === null || target === undefined) return;
    await runMutation('data.setKeptInNewFiles', {
      entityId: target.entityId,
      recordId: event.data.recordId,
      kept: event.data.keptInNewFiles ?? null,
      idempotencyKey: mutationKey(),
    }, 'Saved what a new file keeps.', true);
    return;
  }
  const entity = sessionEntity();
  const field = entity?.fields.find((candidate) => candidate.fieldId === event.colDef.colId);
  if (entity === null || entity === undefined || field === undefined) return;
  let value: unknown = typeof event.newValue === 'string' && storageLabel(field.storageKind) !== 'Text'
    ? event.newValue.trim() : event.newValue;
  if (field.required && (value === '' || value === null || value === undefined)) {
    showError(`${field.displayName} must not be blank.`);
    await recoverAfterWriteFailure();
    return;
  }
  try {
    value = value === null || value === undefined || (field.presentation === 'singleChoice' && value === '') ? null : parseScalar(storageLabel(field.storageKind), exactNumberText(value) ?? String(value));
  } catch (error) { showError(messageFor(error)); await recoverAfterWriteFailure(); return; }
  await runMutation('data.setField', {
    entityId: entity.entityId,
    recordId: event.data.recordId,
    expectedRecordVersion: event.data.recordVersion,
    fieldId: field.fieldId,
    value,
    idempotencyKey: mutationKey(),
  }, `${field.displayName} saved.`, true);
}

