import { prepareApplication, recoverAfterWriteFailure, refreshStudioQuery, reloadReadWindows, runMutation } from './actions';
import { type CellValueChangedEvent, type ColDef, type GridApi, type GridOptions, createGrid, themeQuartz } from 'ag-grid-community';
import { type StudioQuery, recordWindows, state, studioQueries, studioWindows } from './app-state';
import { calculatedDisplay } from './calculated-fields';
import { client } from './client';
import { choiceDisplay, escapeAttribute, escapeHtml, messageFor, mutationKey, storageLabel, valueDisplay } from './format';
import { type CalculationResult, type EntitySnapshot, type ReadPage, type RecordPlan, type RecordSnapshot } from './host';
import { icon } from './icons';
import { activePlan, currentRecipe, derivedFor, recordsForEntity, sessionEntity, snapshotFieldPlans } from './plan-selection';
import { wireRecordPager } from './reads';
import { wireRecordForm } from './record-form';
import { fieldsMarkup, recordFormMarkup } from './record-markup';
import { emptyWindowQuery, windowRequest } from './record-window';
import { ratingMarkup, ratingScaleOf, ratingSteps } from './rating';
import { exactNumberText, parseScalar } from './scalars';
import { announce, content, requiredElement, rerender, setBusy, showError } from './shell';
import { recordTypeProposal } from './studio';
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
}

export const nendoGridTheme = themeQuartz
  .withParams({
    accentColor: '#2458e6',
    backgroundColor: '#ffffff',
    borderColor: '#d9dde6',
    browserColorScheme: 'light',
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
    fontSize: 13,
    foregroundColor: '#13213d',
    headerBackgroundColor: '#f7f8fb',
    headerTextColor: '#667085',
    oddRowBackgroundColor: '#fbfbfc',
    rowHoverColor: '#f1f4ff',
    selectedRowBackgroundColor: '#e9edff',
    spacing: 7,
  }, 'light')
  .withParams({
    accentColor: '#6597ff',
    backgroundColor: '#0a1c2b',
    borderColor: '#263e50',
    browserColorScheme: 'dark',
    foregroundColor: '#edf3ff',
    headerBackgroundColor: '#0e2435',
    headerTextColor: '#a8b5c8',
    oddRowBackgroundColor: '#0c2030',
    rowHoverColor: '#102d43',
    selectedRowBackgroundColor: '#142f5e',
  }, 'dark');

// The grid instance currently mounted, if any. It is disposed on every render:
// AG Grid owns DOM that replacing #studio-content would otherwise orphan.
let gridApi: GridApi<GridRow> | null = null;

export function destroyGrid(): void {
  gridApi?.destroy();
  gridApi = null;
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

  const records = recordsForEntity(entity.entityId, null);
  content.innerHTML = `<div class="data-workspace" data-testid="application-data-state">
    <aside class="entity-panel" aria-label="Record types">
      <div class="panel-heading"><span>Record types</span></div>
      <label class="checkbox-field"><input id="show-retired-data" type="checkbox" ${state.showRetiredData ? 'checked' : ''} />Show retired data</label>
      ${state.session.entities.filter(candidate => state.showRetiredData || !candidate.retired).map(candidate => `<button class="entity-row ${candidate.entityId === entity.entityId ? 'is-active' : ''}" data-entity-id="${escapeAttribute(candidate.entityId)}" type="button" ${candidate.entityId === entity.entityId ? 'aria-current="page"' : ''}><span>${escapeHtml(candidate.displayName)}${candidate.retired ? ' (retired)' : ''}</span></button>`).join('')}
      <button id="new-entity" class="text-button" data-action type="button">Create record type</button>
    </aside>
    <section class="data-panel" aria-label="${escapeAttribute(entity.displayName)} data">
      <header class="data-toolbar">
        <div><p>${entity.retired ? 'Retired record type. Stored values remain available for inspection.' : state.session.capabilities.mutate ? 'Edit a cell to save a change.' : 'Read-only data. Editing is off.'}</p></div>
        <button id="data-new-record" class="primary-button" data-action type="button" ${entity.retired ? 'disabled' : ''}>Add ${escapeHtml(entity.displayName)}</button>
      </header>
      ${studioQueryMarkup(entity)}
      <div class="message-slot data-message" role="alert" hidden></div>
      ${records.length > 0
        ? `<div id="record-grid" class="record-grid" data-testid="record-grid" aria-label="${escapeAttribute(entity.displayName)} records"></div>`
        : `<div class="first-record-state"><div class="record-glyph" aria-hidden="true">＋</div><h3>${studioQueries.has(entity.entityId) ? 'No matching records' : `No ${escapeHtml(entity.displayName)} records yet`}</h3><p>${studioQueries.has(entity.entityId) ? 'Change the filter or click Clear to see all records.' : 'Add the first record here.'}</p></div>`}
      <footer class="data-footer">${recordPagerMarkup(entity.entityId, null)}</footer>
    </section>
  </div>`;
  wireNewEntity();
  wireStudioQuery(entity);
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
  if (records.length > 0) mountRecordGrid(entity, records);
  wireRecordPager();
}

export function studioQueryMarkup(entity: EntitySnapshot): string {
  const query = studioQueries.get(entity.entityId);
  const options = (selected: string | null | undefined): string => entity.fields
    .filter(field => storageLabel(field.storageKind) !== 'Unsupported')
    .map(field => `<option value="${escapeAttribute(field.fieldId)}" ${selected === field.fieldId ? 'selected' : ''}>${escapeHtml(field.displayName)}</option>`).join('');
  return `<form id="studio-query" class="studio-query" aria-label="Sort and filter records">
    <label>Sort by<select name="sort"><option value="">Record order</option>${options(query?.sortFieldId)}</select></label>
    <label>Direction<select name="direction"><option value="asc">Ascending</option><option value="desc" ${query?.descending ? 'selected' : ''}>Descending</option></select></label>
    <label>Filter field<select name="field"><option value="">All records</option>${options(query?.fieldId)}</select></label>
    <label>Match<select name="operator">${[['contains','Contains text'],['eq','Equals'],['ne','Does not equal'],['lt','Less than'],['le','At most'],['gt','Greater than'],['ge','At least'],['isNull','Not set'],['isNotNull','Has a value']].map(([op,label])=>`<option value="${op}" ${query?.operator === op ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>Value<input name="value" type="text" value="${escapeAttribute(query?.text ?? '')}" /></label>
    <button class="secondary-button" data-action type="submit">Apply</button><button id="clear-query" class="text-button" data-action type="button">Clear</button>
    <p class="query-status" role="status">${query ? 'Filtered or sorted · applies to all records in this type' : ''}</p>
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
    const data = new FormData(form);
    const field = entity.fields.find(field => field.fieldId === fieldControl.value);
    try {
      const filters: StudioQuery['filters'] = field ? [{ fieldId: field.fieldId, operator: operator.value,
        ...(['isNull','isNotNull'].includes(operator.value) ? {} : { value: parseScalar(storageLabel(field.storageKind), value.value) }) }] : [];
      if (filters.some(filter => 'value' in filter && filter.value === null)) throw new Error('Choose Not set to find missing values.');
      void applyStudioQuery(entity.entityId, { sortFieldId: String(data.get('sort') || '') || null,
        descending: data.get('direction') === 'desc', fieldId: fieldControl.value, operator: operator.value, text: value.value, filters });
    } catch (error) { showError(messageFor(error)); }
  });
  requiredElement<HTMLButtonElement>('#clear-query').addEventListener('click', () => void applyStudioQuery(entity.entityId, null));
}

export async function applyStudioQuery(entityId: string, query: StudioQuery | null): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true; setBusy(true);
  const previous = studioQueries.get(entityId);
  try {
    if (query) studioQueries.set(entityId, query); else { studioQueries.delete(entityId); studioWindows.delete(entityId); }
    await reloadReadWindows();
    state.selectedRecordId = null; state.creatingRecord = false; rerender();
    announce(query ? 'Query applied.' : 'Showing all records.');
  } catch (error) {
    if (previous) studioQueries.set(entityId, previous); else studioQueries.delete(entityId);
    showError(messageFor(error));
  } finally { state.actionInFlight = false; setBusy(false); }
}

export function renderDataCreateDialog(entity: EntitySnapshot): void {
  const fields = snapshotFieldPlans(entity).filter(field => !field.retired);
  content.innerHTML = `<div class="dialog-page"><section class="record-form-card" aria-labelledby="new-record-heading">
    <header><button id="cancel-create" class="text-button" type="button" data-dismiss>Back to Data</button><h2 id="new-record-heading">Add ${escapeHtml(entity.displayName)}</h2></header>
    <div class="message-slot" role="alert" hidden></div>${recordFormMarkup(null, fields, `Add ${entity.displayName}`)}
  </section></div>`;
  wireRecordForm(null, entity.entityId, fields, () => { state.creatingRecord = false; state.view = 'data'; rerender(); });
  content.querySelector<HTMLInputElement>('#record-form input, #record-form select, #record-form textarea')?.focus();
}

export function renderDataRecordDialog(entity: EntitySnapshot, record: RecordPlan): void {
  destroyGrid();
  const fields = snapshotFieldPlans(entity);
  content.innerHTML = `<div class="dialog-page"><section class="record-form-card" aria-labelledby="record-details-heading">
    <header><button id="close-inspector" class="text-button" type="button" data-dismiss>Back to Data</button><h2 id="record-details-heading">${escapeHtml(entity.displayName)} details</h2><p>Version ${record.version}</p></header>
    <div class="message-slot" role="alert" hidden></div>${recordFormMarkup(record, fields, 'Save changes', fieldsMarkup(record, fields, derivedFor(entity)))}
  </section></div>`;
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

export function mountRecordGrid(entity: EntitySnapshot, records: RecordPlan[]): void {
  const rowData = records.map<GridRow>((record) => ({
    recordId: record.semanticId,
    recordVersion: record.version,
    values: { ...record.values },
    referenceLabels: record.referenceLabels,
    calculations: record.calculations,
  }));
  const editable = (field: EntitySnapshot['fields'][number]): ColDef<GridRow> => ({
    colId: field.fieldId,
    headerName: field.displayName,
    editable: state.session.capabilities.mutate && !entity.retired && !field.retired && storageLabel(field.storageKind) !== 'Reference',
    minWidth: 135,
    flex: field.presentation === 'longText' || field.required ? 1 : undefined,
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
        : field.presentation === 'longText' ? 'agLargeTextCellEditor' : 'agTextCellEditor',
    cellEditorPopup: field.presentation === 'longText',
    cellEditorParams: field.presentation === 'singleChoice'
      ? { values: [...(field.required ? [] : ['']), ...field.options.filter(id => !field.choices?.some(choice => choice.id === id && choice.retired))] }
      : storageLabel(field.storageKind) === 'Boolean' ? { values: field.required ? [true, false] : [null, true, false] }
        // A rating is edited by choosing one of the scale's numbers. The values are the
        // lexemes the cell already carries, so a chosen one needs no conversion on the
        // way back in; the dots are how it reads, not how it is typed.
        : ratingScaleOf(field) !== null
          ? { values: [...(field.required ? [] : ['']), ...ratingSteps(ratingScaleOf(field)!).map(String)] }
          : undefined,
  });
  // A calculated column reads like the record page does: the same four states, the
  // same words, never an editor. Studio is the permanent route into a file, so a
  // number that disagrees between the table and the form is a number nobody can trust.
  const calculated = (field: NonNullable<EntitySnapshot['derivedFields']>[number]): ColDef<GridRow> => ({
    colId: field.fieldId,
    headerName: field.displayName,
    headerTooltip: `Calculated: ${field.expression}`,
    editable: false,
    minWidth: 135,
    cellClass: 'calculated-cell',
    cellDataType: false,
    valueGetter: (parameters) => calculatedDisplay(parameters.data?.calculations?.[field.fieldId]).text,
  });
  const options: GridOptions<GridRow> = {
    theme: nendoGridTheme,
    defaultColDef: { sortable: false },
    rowData,
    columnDefs: [
      { colId: 'openRecord', headerName: '', width: 92, cellClass: 'record-open-cell', editable: false, sortable: false,
        cellRenderer: (parameters: { data?: GridRow }) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'record-open-button';
          button.textContent = 'Open';
          button.setAttribute('aria-label', `Open ${entity.displayName} record`);
          button.addEventListener('click', () => {
            const record = records.find(item => item.semanticId === parameters.data?.recordId);
            if (record && !state.actionInFlight) renderDataRecordDialog(entity, record);
          });
          return button;
        } },
      ...entity.fields.filter(field => state.showRetiredData || !field.retired).map(editable),
      ...(entity.derivedFields ?? []).map(calculated),
      { field: 'recordVersion', colId: 'recordVersion', headerName: 'Version', width: 90, editable: false },
    ],
    onCellValueChanged: (event) => void commitGridEdit(event),
    ensureDomOrder: true,
    getRowId: (parameters) => parameters.data.recordId,
    singleClickEdit: false,
    stopEditingWhenCellsLoseFocus: true,
    suppressMovableColumns: true,
  };
  gridApi = createGrid<GridRow>(requiredElement<HTMLElement>('#record-grid'), options);
}

export async function commitGridEdit(event: CellValueChangedEvent<GridRow>): Promise<void> {
  if (event.data === undefined || event.newValue === event.oldValue || event.colDef.colId === undefined) return;
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

