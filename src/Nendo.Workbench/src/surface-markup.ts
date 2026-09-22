import {
  boardView, excludedLanesNote, kindLabel as surfaceKindLabel, matrixViewOf, nodeFieldIds, referenceColumnsEmpty,
  referenceColumnsOverflow, surfaceLabel, useSurfaces, type BoardView, type MatrixView,
} from './surface-model';
import { civilDate, groupByDate, loadedStateLabel, monthGrid, monthLabel, sameMonth, weekdayNames } from './calendar-model';
import {
  dateFieldOf, dayMonthLabel, endDateFieldOf, groupByMonth, monthEmptyLabel, spanLabel, spanOf, spineDescending,
  timelineStateLabel, yearNote,
} from './timeline-model';
import { cellValue, groupLabel, groupScopedCharts, surfaceScopedCharts, type CellResult, type ScopedChart } from './charts';
import { groupScopedTiles, groupTileScope, surfaceScopedTiles, type TileScope } from './summary-tiles';
import { icon } from './icons';
import { choiceDisplay, escapeAttribute, escapeHtml, fieldName, stringValue } from './format';
import { choiceStyle } from './tones';
import { accumulatedWindows, boardColumns, matrixCells, state, surfaceErrors, surfaceWindows } from './app-state';
import {
  activeDrill, activeSurfaceQuery, applicationPlans, boardOf, calendarKeyFor, calendarModeFor, calendarMonthFor, listFieldIds,
  recordWindowFor, referenceColumnsOf, selectedSurfaceNode, surfaceAccentFieldId, timelineKeyFor, timelineModeFor,
  timelineYearFor, todayCivil,
} from './plan-selection';
import { accentDot, fieldValueMarkup, recordCardMarkup, recordFieldDisplay, summaryTileGroupMarkup } from './record-markup';
import type { ApplicationPlan, FieldPlan, RecordPlan, SurfaceNodePlan } from './host';

/**
 * What one selected surface looks like: a list, a board, a calendar, the totals
 * above it and the pager below it. The surface is handed its plan and answers
 * from the window that has already been read; it never asks for one.
 */

// The pager carries the surface it belongs to, so Next on the second list pages
// the second list rather than whichever window the record type last held.
export function recordPagerMarkup(entityId: string, surfaceId: string | null): string {
  const window = recordWindowFor(entityId, surfaceId);
  const count = window?.page.items.length ?? 0;
  const surface = surfaceId === null ? '' : ` data-page-surface="${escapeAttribute(surfaceId)}"`;
  return `<div class="page-controls" aria-label="Record pages"><span>${count} records shown · Page ${(window?.index ?? 0) + 1}</span><button class="text-button" type="button" data-record-page="-1" data-page-entity="${escapeAttribute(entityId)}"${surface} ${!window || window.index === 0 ? 'disabled' : ''}>Previous</button><button class="text-button" type="button" data-record-page="1" data-page-entity="${escapeAttribute(entityId)}"${surface} ${!window?.page.nextCursor ? 'disabled' : ''}>Next</button></div>`;
}

/**
 * The surface selector. Every root becomes its own button with its own stable ID;
 * show-board and show-list stay on the first of each kind so existing journeys
 * and checks keep a fixed handle, but they name one surface among several rather
 * than a mode.
 */
export function surfaceSelectorMarkup(plan: ApplicationPlan): string {
  const surfaces = useSurfaces(plan);
  if (surfaces.length === 0) return '';
  const selected = selectedSurfaceNode(plan);
  const firstOfKind = new Map<string, string>();
  for (const node of surfaces) if (!firstOfKind.has(node.kind)) firstOfKind.set(node.kind, node.semanticId);
  const alias = (node: SurfaceNodePlan): string => {
    if (firstOfKind.get(node.kind) !== node.semanticId) return '';
    if (node.kind === 'boardSurface') return ' id="show-board"';
    if (node.kind === 'recordList') return ' id="show-list"';
    if (node.kind === 'calendarSurface') return ' id="show-calendar"';
    if (node.kind === 'timelineSurface') return ' id="show-timeline"';
    if (node.kind === 'gallerySurface') return ' id="show-gallery"';
    if (node.kind === 'matrixSurface') return ' id="show-matrix"';
    return '';
  };
  return `<details class="surface-picker"><summary><span class="surface-picker-label">View</span><strong>${escapeHtml(selected === null ? 'Choose a view' : surfaceLabel(selected, surfaces))}</strong><span class="surface-picker-chevron" aria-hidden="true">${icon('chevron')}</span></summary><div class="surface-picker-options" role="group" aria-label="${escapeAttribute(plan.entity.displayName)} views">${surfaces.map(node => `<button type="button"${alias(node)} data-select-surface="${escapeAttribute(node.semanticId)}" aria-pressed="${node.semanticId === selected?.semanticId}">${escapeHtml(surfaceLabel(node, surfaces))}<small>${escapeHtml(surfaceKindLabel(node.kind))}</small></button>`).join('')}</div></details>`;
}

/**
 * The body of the selected surface. A surface with no loaded window states that
 * it is loading or that its read refused; it never shows the records of another
 * surface, and never falls back to an unfiltered default.
 */
export function surfaceBodyMarkup(plan: ApplicationPlan): string {
  const node = selectedSurfaceNode(plan);
  // A form-only or command-only application has no Use surface of its own and
  // keeps its bounded record selection, which opens the host-owned inspector.
  if (node === null) return listMarkup(plan, null);
  const failure = surfaceErrors.get(node.semanticId);
  if (failure !== undefined)
    return `<div class="first-record-state" role="alert"><div class="record-glyph" aria-hidden="true">!</div><h3>This view could not be loaded</h3><p>${escapeHtml(failure)}</p><button class="secondary-button" type="button" data-retry-surface="${escapeAttribute(node.semanticId)}">Try again</button></div>`;
  // A calendar or a timeline owns its own accumulated pages and loading states.
  if (node.kind === 'calendarSurface') return calendarMarkup(plan, node);
  if (node.kind === 'extensionGraphSurface') return `<section class="empty-state" aria-labelledby="extension-title">
    <h2 id="extension-title">${escapeHtml(typeof node.properties.title === 'string' ? node.properties.title : 'Custom graph')}</h2>
    <p id="extension-status" role="status">Checking this device’s package and permission…</p>
    <p>The graph opens beside your records, which stay editable in Studio.</p>
    <div class="form-actions"><button id="extension-next" type="button" class="primary-button" disabled>Checking…</button>
    <button id="extension-studio" type="button" class="secondary-button">Open Studio</button>
    <button id="manage-extension" type="button" class="secondary-button">Manage packages…</button></div>
  </section>`;
  if (node.kind === 'timelineSurface') return timelineMarkup(plan, node);
  if (surfaceWindows.get(node.semanticId)?.page.changeSequence !== state.session.manifest?.changeSequence)
    return '<div class="first-record-state" aria-busy="true"><div class="record-glyph" aria-hidden="true">…</div><h3>Loading this view</h3><p>Reading the records this view shows.</p></div>';
  // A gallery reads a list's window, so it waits on the same staleness guard and only
  // then draws that window as cards.
  if (node.kind === 'gallerySurface') return galleryMarkup(plan, node);
  if (node.kind === 'matrixSurface') return matrixMarkup(plan, node);
  return node.kind === 'boardSurface' ? boardMarkup(plan, node) : listMarkup(plan, node);
}

// A declared filter that matches nothing is not an empty application, and a
// reviewer who cannot tell the two apart will misread the surface.
export function emptySurfaceMarkup(plan: ApplicationPlan): string {
  const filtered = activeSurfaceQuery(plan).filters.length > 0;
  return filtered
    ? `<div class="first-record-state"><div class="record-glyph" aria-hidden="true">≡</div><h3>No ${escapeHtml(plan.entity.displayName)} records match this view</h3><p>This surface declares a filter. Other records may exist outside it; Studio shows every record.</p></div>`
    : `<div class="first-record-state"><div class="record-glyph" aria-hidden="true">＋</div><h3>No ${escapeHtml(plan.entity.displayName)} records yet</h3><p>Add the first record to begin.</p></div>`;
}

// A surface tile covers everything the surface shows, so it sits above the
// record window rather than inside it, where it would read as a property of the
// loaded page.
export function surfaceTileMarkup(plan: ApplicationPlan): string {
  const surface = selectedSurfaceNode(plan);
  if (surface === null) return '';
  // While a drill narrows the list, its totals and charts would describe the
  // surface's own set rather than the records on screen; the pill stands in.
  if (activeDrill(plan, surface) !== null) return '';
  const scope: TileScope = { kind: 'surface', surface };
  return summaryTileGroupMarkup(
    surfaceScopedTiles(surface).map((tile) => ({ tile, scope })),
    surfaceScopedCharts(surface).map((node): ScopedChart => ({ node, scope })),
    plan);
}

// A column's tiles sit in that column, under its header. The value covers every
// matching record in the column, which is why the count beside the heading —
// the cards actually loaded — is labelled separately.
export function columnTileMarkup(plan: ApplicationPlan, surface: SurfaceNodePlan, board: BoardView, groupId: string | null): string {
  const scope = groupTileScope(surface, board.groupByFieldId, groupId);
  return summaryTileGroupMarkup(
    groupScopedTiles(surface).map((tile) => ({ tile, scope })),
    groupScopedCharts(surface).map((node): ScopedChart => ({ node, scope })),
    plan);
}

/**
 * One month of a Date calendar. The first page is not the month: a bounded page
 * holds fifty records and a month can hold more, so the entries placed are the
 * ones actually loaded and the state line says whether that is all of them. A
 * day with no loaded entry is not stated as empty while the cursor is open.
 */
export function calendarMarkup(plan: ApplicationPlan, node: SurfaceNodePlan): string {
  const surfaceId = node.semanticId;
  const mode = calendarModeFor(surfaceId);
  const month = calendarMonthFor(surfaceId);
  const accumulated = accumulatedWindows.get(calendarKeyFor(node));
  const dateFieldId = typeof node.properties.dateFieldId === 'string' ? node.properties.dateFieldId : null;
  const complete = accumulated !== undefined && accumulated.cursor === null && !accumulated.loading;
  const titleFieldId = nodeFieldIds(node)[0] ?? plan.entity.fields[0]?.semanticId ?? '';
  const entries = plan.records;

  const controls = `<header class="calendar-toolbar">
    <div class="calendar-month"><button class="text-button" type="button" data-calendar-month="-1" ${mode === 'undated' ? 'disabled' : ''}>Previous month</button><strong>${escapeHtml(monthLabel(month))}</strong><button class="text-button" type="button" data-calendar-month="1" ${mode === 'undated' ? 'disabled' : ''}>Next month</button><button class="text-button" type="button" data-calendar-today ${mode === 'undated' ? 'disabled' : ''}>Today</button></div>
    <div class="view-switcher" role="group" aria-label="${escapeAttribute(`${plan.entity.displayName} calendar view`)}"><button type="button" data-calendar-mode="dated" aria-pressed="${mode === 'dated'}">Month</button><button type="button" data-calendar-mode="undated" aria-pressed="${mode === 'undated'}">Undated</button></div>
  </header>`;

  if (accumulated?.failure != null)
    return `${controls}<div class="first-record-state" role="alert"><div class="record-glyph" aria-hidden="true">!</div><h3>This calendar could not be read</h3><p>${escapeHtml(accumulated.failure)}</p><button class="secondary-button" type="button" data-calendar-retry>Try again</button></div>`;
  if (dateFieldId === null)
    return `${controls}<div class="first-record-state"><h3>This calendar has no date field</h3><p>The definition names no date to place records by.</p></div>`;
  if (accumulated === undefined || accumulated.changeSequence !== state.session.manifest?.changeSequence)
    return `${controls}<div class="first-record-state" aria-busy="true"><div class="record-glyph" aria-hidden="true">…</div><h3>Loading this calendar</h3><p>Reading the records it places.</p></div>`;

  const loadedLine = `<p class="calendar-state" role="status">${escapeHtml(loadedStateLabel(entries.length, complete, mode))}</p>`;
  const more = accumulated.cursor === null
    ? ''
    : `<button class="secondary-button" type="button" data-calendar-more ${accumulated.loading ? 'disabled' : ''}>${accumulated.loading ? 'Loading…' : 'Load more'}</button>`;

  const accentFieldId = surfaceAccentFieldId(plan, selectedSurfaceNode(plan));
  if (mode === 'undated') {
    const rows = entries.length === 0 && complete
      ? `<p class="empty-column">No ${escapeHtml(plan.entity.displayName)} records are missing a ${escapeHtml(fieldName(plan, dateFieldId))}.</p>`
      : `<div class="record-list" role="list">${entries.map((record) => `<button type="button" role="listitem" data-record-id="${escapeAttribute(record.semanticId)}">${accentDot(plan, accentFieldId, record)}<strong>${escapeHtml(recordFieldDisplay(record, titleFieldId, plan.entity.derivedFields) || `Untitled ${plan.entity.displayName}`)}</strong><small>v${record.version}</small></button>`).join('')}</div>`;
    return `${controls}${loadedLine}${rows}${more}`;
  }

  const byDate = groupByDate(entries, (record) => record.values[dateFieldId]);
  const today = todayCivil();
  const cells = monthGrid(month).map((cell) => {
    if (cell.date === null) return '<div class="calendar-cell is-padding" aria-hidden="true"></div>';
    const placed = byDate.get(cell.date) ?? [];
    const isToday = sameMonth(month, today.month) && cell.day === today.day;
    const empty = placed.length === 0
      ? complete
        ? '<p class="calendar-empty">No entries</p>'
        : '<p class="calendar-empty">None loaded yet</p>'
      : '';
    return `<div class="calendar-cell ${isToday ? 'is-today' : ''}" data-calendar-day="${escapeAttribute(cell.date)}"><span class="calendar-day">${cell.day}</span>${empty}${placed.map((record) => `<button class="calendar-entry" type="button" data-record-id="${escapeAttribute(record.semanticId)}" aria-label="${escapeAttribute(`${recordFieldDisplay(record, titleFieldId, plan.entity.derivedFields) || plan.entity.displayName} on ${cell.date}`)}">${accentDot(plan, accentFieldId, record)}${escapeHtml(recordFieldDisplay(record, titleFieldId, plan.entity.derivedFields) || `Untitled ${plan.entity.displayName}`)}</button>`).join('')}</div>`;
  }).join('');

  return `${controls}${loadedLine}<div class="record-calendar" role="grid" aria-label="${escapeAttribute(`${plan.entity.displayName} by ${fieldName(plan, dateFieldId)}, ${monthLabel(month)}`)}"><div class="calendar-weekdays" role="row">${weekdayNames.map((day) => `<span role="columnheader">${day}</span>`).join('')}</div>${cells}</div>${more}`;
}

/**
 * One year of a timeline: a spine of month headings with the loaded entries
 * placed by their date. As with a calendar, the first page is not the year — a
 * bounded page holds fifty records — so the entries placed are the ones loaded
 * and the state line says whether that is all of them. An end date turns an
 * entry into a span drawn from its start, and the year header states the scale
 * the bars are drawn to and that a span which began earlier is on that year's
 * spine.
 */
export function timelineMarkup(plan: ApplicationPlan, node: SurfaceNodePlan): string {
  const surfaceId = node.semanticId;
  const mode = timelineModeFor(surfaceId);
  const year = timelineYearFor(surfaceId);
  const accumulated = accumulatedWindows.get(timelineKeyFor(node));
  const dateFieldId = dateFieldOf(node);
  const endDateFieldId = endDateFieldOf(node);
  const complete = accumulated !== undefined && accumulated.cursor === null && !accumulated.loading;
  const titleFieldId = typeof node.properties.titleFieldId === 'string'
    ? node.properties.titleFieldId
    : nodeFieldIds(node)[0] ?? plan.entity.fields[0]?.semanticId ?? '';
  const bodyFieldIds = nodeFieldIds(node).filter((fieldId) => fieldId !== titleFieldId);
  const accentFieldId = typeof node.properties.accentFieldId === 'string' ? node.properties.accentFieldId : null;
  const displayName = plan.entity.displayName;
  const entries = plan.records;
  const disabled = mode === 'undated' ? 'disabled' : '';

  const controls = `<header class="timeline-toolbar">
    <div class="timeline-year"><button class="text-button" type="button" data-timeline-year="-1" ${disabled}>Earlier</button><strong>${year}</strong><button class="text-button" type="button" data-timeline-year="1" ${disabled}>Later</button><button class="text-button" type="button" data-timeline-this-year ${disabled}>This year</button></div>
    <div class="view-switcher" role="group" aria-label="${escapeAttribute(`${displayName} timeline view`)}"><button type="button" data-timeline-mode="dated" aria-pressed="${mode === 'dated'}">Year</button><button type="button" data-timeline-mode="undated" aria-pressed="${mode === 'undated'}">Undated</button></div>
  </header>`;

  if (accumulated?.failure != null)
    return `${controls}<div class="first-record-state" role="alert"><div class="record-glyph" aria-hidden="true">!</div><h3>This timeline could not be read</h3><p>${escapeHtml(accumulated.failure)}</p><button class="secondary-button" type="button" data-timeline-retry>Try again</button></div>`;
  if (dateFieldId === null)
    return `${controls}<div class="first-record-state"><h3>This timeline has no date field</h3><p>The definition names no date to place records by.</p></div>`;
  if (accumulated === undefined || accumulated.changeSequence !== state.session.manifest?.changeSequence)
    return `${controls}<div class="first-record-state" aria-busy="true"><div class="record-glyph" aria-hidden="true">…</div><h3>Loading this timeline</h3><p>Reading the records it places.</p></div>`;

  const loadedLine = `<p class="timeline-state" role="status">${escapeHtml(timelineStateLabel(entries.length, complete, mode, year))}</p>`;
  const more = accumulated.cursor === null
    ? ''
    : `<button class="secondary-button" type="button" data-timeline-more ${accumulated.loading ? 'disabled' : ''}>${accumulated.loading ? 'Loading…' : 'Load more'}</button>`;
  const titleOf = (record: RecordPlan): string =>
    recordFieldDisplay(record, titleFieldId, plan.entity.derivedFields) || `Untitled ${displayName}`;

  if (mode === 'undated') {
    const rows = entries.length === 0 && complete
      ? `<p class="empty-column">No ${escapeHtml(displayName)} records are missing a ${escapeHtml(fieldName(plan, dateFieldId))}.</p>`
      : `<div class="record-list" role="list">${entries.map((record) => `<button type="button" role="listitem" data-record-id="${escapeAttribute(record.semanticId)}">${accentDot(plan, accentFieldId, record)}<strong>${escapeHtml(titleOf(record))}</strong><small>v${record.version}</small></button>`).join('')}</div>`;
    return `${controls}${loadedLine}${rows}${more}`;
  }

  const note = endDateFieldId === null ? '' : `<p class="timeline-note">${escapeHtml(yearNote(year))}</p>`;
  const accentField = accentFieldId === null ? undefined : plan.entity.fields.find((field) => field.semanticId === accentFieldId);
  const months = groupByMonth(entries, year, (record) => record.values[dateFieldId], spineDescending(node)).map(({ month, items }) => {
    const body = items.length === 0
      ? `<p class="timeline-empty">${monthEmptyLabel(complete)}</p>`
      : items.map((record) => {
        const date = civilDate(record.values[dateFieldId]) ?? '';
        const title = titleOf(record);
        const outcome = endDateFieldId === null ? { kind: 'none' as const } : spanOf(date, record.values[endDateFieldId], year);
        const style = accentFieldId === null ? '' : choiceStyle(accentField, record.values[accentFieldId]);
        const span = outcome.kind === 'span'
          ? `<span class="timeline-span${outcome.span.clipped ? ' is-clipped' : ''}" style="--span: ${(outcome.span.proportion * 100).toFixed(1)}%" aria-hidden="true"></span><span class="timeline-span-text">${escapeHtml(spanLabel(date, outcome.span, year))}</span>`
          : outcome.kind === 'issue'
            ? `<span class="timeline-issue">${escapeHtml(outcome.message)}</span>`
            : '';
        const values = bodyFieldIds.map((fieldId) => `<span><small>${escapeHtml(fieldName(plan, fieldId))}</small>${fieldValueMarkup(plan, record, fieldId, 'Not set')}</span>`).join('');
        const label = outcome.kind === 'span' ? `${title}, ${spanLabel(date, outcome.span, year)}` : `${title} on ${date}`;
        return `<button class="timeline-entry" type="button" data-record-id="${escapeAttribute(record.semanticId)}" aria-label="${escapeAttribute(label)}" style="${style}"><span class="status-dot" aria-hidden="true"></span><span class="timeline-date">${escapeHtml(dayMonthLabel(date))}</span><span class="timeline-body"><strong class="timeline-title">${escapeHtml(title)}</strong>${span}${values === '' ? '' : `<span class="timeline-values">${values}</span>`}</span></button>`;
      }).join('');
    return `<section class="timeline-month" data-timeline-month="${month.year}-${String(month.month).padStart(2, '0')}"><h3>${escapeHtml(monthLabel(month))}</h3>${body}</section>`;
  }).join('');

  return `${controls}${loadedLine}${note}<div class="record-timeline" aria-label="${escapeAttribute(`${displayName} by ${fieldName(plan, dateFieldId)}, ${year}`)}">${months}</div>${more}`;
}

/**
 * A gallery: one card per record of exactly the window a list would have read, so the
 * pager, the tiles and the charts above it are the list's unchanged. The title leads the
 * card, the accent option tones its edge, and the remaining bound fields are its body.
 */
export function galleryMarkup(plan: ApplicationPlan, node: SurfaceNodePlan): string {
  if (plan.records.length === 0) return emptySurfaceMarkup(plan);
  const bound = nodeFieldIds(node);
  const declaredTitle = typeof node.properties.titleFieldId === 'string' ? node.properties.titleFieldId : null;
  // A card with no declared title leads with its first bound field, as a timeline entry
  // does, so a gallery card and a board card are titled by one rule.
  const titleFieldId = declaredTitle ?? bound[0] ?? plan.entity.fields[0]?.semanticId ?? '';
  const bodyFieldIds = bound.filter((fieldId) => fieldId !== titleFieldId);
  const accentFieldId = typeof node.properties.accentFieldId === 'string' ? node.properties.accentFieldId : null;
  const accentField = accentFieldId === null ? undefined : plan.entity.fields.find((field) => field.semanticId === accentFieldId);
  return `<div class="record-gallery" role="list" aria-label="${escapeAttribute(`${plan.entity.displayName} cards`)}">${plan.records.map((record) =>
    recordCardMarkup(plan, record, [titleFieldId, ...bodyFieldIds],
      accentFieldId === null ? '' : choiceStyle(accentField, record.values[accentFieldId]))).join('')}</div>`;
}

/**
 * What a reference board says when it will not draw, and why it says nothing else.
 *
 * Over the ceiling it draws no columns at all: a board missing its last lanes looks
 * exactly like a board, and somebody would read the ones that are there as all there
 * are. The statement names the record type, how many records it holds and the bound, so
 * the answer is a number a person can act on rather than "too many".
 *
 * At zero the answer is not the same shape, and that is why this returns which it is
 * rather than one string. Above the ceiling there is nothing to lose by replacing the
 * board; at zero the Ungrouped lane holds every card there is, and replacing the board
 * would hide the records to explain the columns.
 */
type ColumnsNotice = { replace: string } | { note: string };

function referenceColumnsNotice(node: SurfaceNodePlan, targetEntityId: string): ColumnsNotice | null {
  const known = boardColumns.get(node.semanticId);
  const typeName = entityDisplayName(targetEntityId);
  if (known === undefined || known.state === 'loading')
    return { replace: `<p class="surface-empty" role="status">Reading the ${escapeHtml(typeName)} records this board's columns come from…</p>` };
  if (known.state === 'failed')
    return { replace: `<p class="surface-empty" role="status">This board's columns could not be read: ${escapeHtml(known.message)}<br /><button type="button" class="secondary-button" data-retry-columns="${escapeAttribute(node.semanticId)}">Try again</button></p>` };
  if (known.state === 'overflowing')
    return { replace: `<p class="surface-empty" role="status">${escapeHtml(referenceColumnsOverflow(typeName, known.count, known.ceiling))}</p>` };
  // Read, and there were none. A target type with no Use surface of its own is not in the
  // Showing picker, so the sentence sends a person to Studio instead of to a control that
  // is not on this screen.
  if (known.columns.length === 0) {
    const inPicker = applicationPlans().some((app) => app.entity.semanticId === targetEntityId);
    return { note: `<p class="surface-empty" role="status">${escapeHtml(referenceColumnsEmpty(typeName, inPicker))}</p>` };
  }
  return null;
}

export function boardMarkup(plan: ApplicationPlan, node: SurfaceNodePlan): string {
  const board = boardOf(plan, node);
  if (board === null) return '';
  // A reference board's columns are records, so it cannot draw until they are read, and
  // will not draw at all when there are more of them than a board can hold.
  let columnsNote = '';
  if (board.reference !== null) {
    const notice = referenceColumnsNotice(node, board.reference.targetEntityId);
    if (notice !== null && 'replace' in notice) return notice.replace;
    if (notice !== null) columnsNote = notice.note;
  }
  const columnTiles = groupScopedTiles(node).length > 0;
  // A configured column stays visible even with nothing in it once it carries a
  // total: the number is the answer, and hiding the column hides the answer.
  if (plan.records.length === 0 && !columnTiles) return `${columnsNote}${emptySurfaceMarkup(plan)}`;
  const groupField = fieldName(plan, board.groupByFieldId);
  // A choice board reaches zero lanes the other way: its own eq and ne clauses can
  // exclude every option the field has, and the board then drew one nameless lane
  // without saying that its own filter is what emptied it.
  if (board.reference === null && board.groups.length === 0)
    columnsNote = `<p class="surface-empty" role="status">${escapeHtml(excludedLanesNote(groupField, 'columns'))}</p>`;
  const ungrouped = plan.records.filter((record) => !board.groups.includes(stringValue(record.values[board.groupByFieldId])));
  // A card whose stored choice is neither absent nor one of the configured
  // options is a data issue. Its record is not counted by the Ungrouped total,
  // which asks for a missing value, so the difference is stated rather than
  // folded into the null total.
  const malformed = ungrouped.filter((record) => record.values[board.groupByFieldId] != null &&
    stringValue(record.values[board.groupByFieldId]).length > 0);
  const showFallback = ungrouped.length > 0 || columnTiles;
  // A stored value the board has no column for is a data issue either way, but not the
  // same one: a choice outside the options is a value nobody configured, and a reference
  // to a record that is not in the target type is a target that is not there.
  const issue = board.reference === null ? "value outside this board's choices" : 'reference to a record that is not there';
  const labels = referenceColumnsOf(node);
  const columnLabel = (group: string): string => board.reference === null
    ? choiceDisplay(groupingField(plan, board), group)
    : labels?.find((column) => column.recordId === group)?.label ?? group;
  // The lane's own advice has to be true of the board it is on. "Move a card to a named
  // column" was written for a board that has some, and it kept saying so on a board with
  // none — which is the half of the finding a person actually read. The first sentence
  // stays, because it is still what the lane means; only the instruction goes.
  const assign = board.groups.length === 0
    ? 'This board has no named column to move a card to.'
    : 'Move a card to a named column to assign it.';
  const fallback = !showFallback ? '' : `<section class="board-column" data-group-ungrouped="true"><header><h3>Ungrouped</h3><strong>${ungrouped.length}</strong></header>${columnTileMarkup(plan, node, board, null)}<div class="card-stack"><p class="empty-column">${escapeHtml(groupField)} is not set or is outside this board's groups. ${escapeHtml(assign)}</p>${malformed.length === 0 ? '' : `<p class="column-data-issue" role="status">${malformed.length} loaded ${malformed.length === 1 ? 'record has' : 'records have'} a ${escapeHtml(groupField)} ${issue}, so ${malformed.length === 1 ? 'it is' : 'they are'} not part of the total above. Correct the value in Studio.</p>`}${ungrouped.map((record) => recordCardMarkup(plan, record, board.cardFieldIds)).join('')}</div></section>`;
  return `${columnsNote}<div class="record-board" style="--group-count: ${board.groups.length + (showFallback ? 1 : 0)}" aria-label="${escapeAttribute(plan.entity.displayName)} grouped by ${escapeAttribute(groupField)}">${fallback}${board.groups.map((group) => {
    const cards = plan.records.filter((record) => stringValue(record.values[board.groupByFieldId]) === group);
    const field = groupingField(plan, board);
    // A retired option cannot be a drop target. A referenced record has no retirement,
    // so every reference column takes cards.
    const retired = board.reference === null && field.choices?.some(choice => choice.id === group && choice.retired);
    return `<section class="board-column" ${retired ? '' : `data-group="${escapeAttribute(group)}"`}><header><span class="status-dot" style="${choiceStyle(field, group)}" aria-hidden="true"></span><h3>${escapeHtml(columnLabel(group))}</h3><strong>${cards.length}</strong></header>${columnTileMarkup(plan, node, board, group)}<div class="card-stack">${cards.map((record) => recordCardMarkup(plan, record, board.cardFieldIds)).join('')}${cards.length === 0 ? '<p class="empty-column">No records</p>' : ''}</div></section>`;
  }).join('')}</div>`;
}

/**
 * The field a board groups by. A reference field carries no choices, so choiceStyle finds
 * no tone on it and falls back to the hue it derives from the stored value — which is the
 * renderer's existing habit for a value nobody coloured, applied unchanged rather than
 * replaced by a rule of its own.
 */
function groupingField(plan: ApplicationPlan, board: BoardView): FieldPlan {
  return plan.entity.fields.find((field) => field.semanticId === board.groupByFieldId)!;
}

function entityDisplayName(entityId: string): string {
  return applicationPlans().find((app) => app.entity.semanticId === entityId)?.entity.displayName ?? entityId;
}

/**
 * One matrix (ADR-0004, 2026-09-17 amendment, S6): two crossed choice fields, the
 * surface's window placed into cells, and one exact number in each of them.
 *
 * The number and the cards are two different quantities and the cell says so. The number
 * is the grid's own read, exact over everything the surface covers; the cards are this
 * surface's one loaded window. Where the two differ the cell states how many it is not
 * showing, which a board column has never been able to do without a tile of its own.
 *
 * A configured lane is always drawn, empty or not, because an option is something a person
 * arranged and its emptiness is the answer. The unset lane on each axis is drawn only when
 * its own exact number is not zero: nobody arranged it, and an empty one would spend a row
 * and a column of screen saying nothing.
 */
export function matrixMarkup(plan: ApplicationPlan, node: SurfaceNodePlan): string {
  const matrix = matrixViewOf(node, plan.entity.fields);
  if (matrix === null) return '';
  const answer = matrixCells.get(node.semanticId);
  if (answer === undefined || answer.state === 'loading')
    return '<div class="first-record-state" aria-busy="true"><div class="record-glyph" aria-hidden="true">…</div><h3>Counting the cells</h3><p>Reading one number for every cell of this grid.</p></div>';
  if (answer.state === 'failed')
    return `<div class="first-record-state" role="alert"><div class="record-glyph" aria-hidden="true">!</div><h3>This grid could not be counted</h3><p>${escapeHtml(answer.message)}</p><button class="secondary-button" type="button" data-retry-matrix="${escapeAttribute(node.semanticId)}">Try again</button></div>`;
  const cells = answer.cells;
  if (cells === undefined) return '';

  const rowField = plan.entity.fields.find((field) => field.semanticId === matrix.rowByFieldId);
  const columnField = plan.entity.fields.find((field) => field.semanticId === matrix.columnByFieldId);
  const lanes = (keys: string[], unsetTotal: number): Array<string | null> =>
    unsetTotal > 0 ? [...keys, null] : [...keys];
  const unsetRowTotal = matrix.columns.reduce((total, column) => total + (cellValue(cells, null, column) ?? 0), 0) +
    (cellValue(cells, null, null) ?? 0);
  const unsetColumnTotal = matrix.rows.reduce((total, row) => total + (cellValue(cells, row, null) ?? 0), 0) +
    (cellValue(cells, null, null) ?? 0);
  const rows = lanes(matrix.rows, unsetRowTotal);
  const columns = lanes(matrix.columns, unsetColumnTotal);
  const rowName = fieldName(plan, matrix.rowByFieldId);
  const columnName = fieldName(plan, matrix.columnByFieldId);

  // An axis with no options is refused when the grid is authored (NUI410, NUI411), so the
  // only way here is the grid's own eq and ne clauses excluding every one of them. It drew
  // a bare corner and no cells, which reads as a grid that failed rather than one its own
  // filter emptied. The unset lane is not a lane for this purpose: it is drawn only when
  // its number is not zero, so an axis can still end up with nothing on it.
  if (rows.length === 0 || columns.length === 0) {
    const empty = rows.length === 0
      ? excludedLanesNote(rowName, 'rows')
      : excludedLanesNote(columnName, 'columns');
    return `<div class="first-record-state"><div class="record-glyph" aria-hidden="true">≡</div><h3>This grid has no ${rows.length === 0 ? 'rows' : 'columns'}</h3><p>${escapeHtml(empty)}</p></div>`;
  }

  const header = `<div class="matrix-corner"><small>${escapeHtml(rowName)}</small><small>${escapeHtml(columnName)}</small></div>` +
    columns.map((column) => `<div class="matrix-heading">${column === null
      ? '<h3>Not set</h3>'
      : `<span class="status-dot" style="${choiceStyle(columnField, column)}" aria-hidden="true"></span><h3>${escapeHtml(groupLabel(columnField, column))}</h3>`}</div>`).join('');

  const body = rows.map((row) => {
    const heading = `<div class="matrix-heading matrix-row-heading">${row === null
      ? '<h3>Not set</h3>'
      : `<span class="status-dot" style="${choiceStyle(rowField, row)}" aria-hidden="true"></span><h3>${escapeHtml(groupLabel(rowField, row))}</h3>`}</div>`;
    return heading + columns.map((column) => matrixCellMarkup(plan, node, matrix, cells, row, column)).join('');
  }).join('');

  const issue = cells.unrecognised === 0
    ? ''
    : `<p class="column-data-issue" role="status">${cells.unrecognised} ${cells.unrecognised === 1 ? 'record has' : 'records have'} a ${escapeHtml(rowName)} or ${escapeHtml(columnName)} value outside this record type's choices, so ${cells.unrecognised === 1 ? 'it is' : 'they are'} in no cell. Correct the value in Studio.</p>`;
  return `<div class="record-matrix" style="--matrix-columns: ${columns.length}" aria-label="${escapeAttribute(plan.entity.displayName)} by ${escapeAttribute(rowName)} and ${escapeAttribute(columnName)}">${header}${body}</div>${issue}`;
}

function matrixCellMarkup(
  plan: ApplicationPlan,
  node: SurfaceNodePlan,
  matrix: MatrixView,
  cells: CellResult,
  row: string | null,
  column: string | null,
): string {
  // A cell the answer does not carry is not a zero. The grid draws its lanes from the
  // definition and takes each number from the read, so the two can disagree — and
  // printing 0 for a cell nobody answered states a count the file never gave. It reads
  // as absent instead, which is what made the first version of this guard pass against
  // a read that had stopped answering its empty cells at all.
  const answered = cellValue(cells, row, column);
  const exact = answered ?? 0;
  const inCell = plan.records.filter((record) =>
    laneOf(record.values[matrix.rowByFieldId], matrix.rows) === row &&
    laneOf(record.values[matrix.columnByFieldId], matrix.columns) === column);
  const hidden = exact - inCell.length;
  // The two numbers are different claims, so the cell never prints one as the other:
  // the total covers everything the surface shows, the cards are the window it loaded.
  const shown = hidden > 0 ? `<small>showing ${inCell.length} of ${exact}</small>` : '';
  const label = `${row === null ? 'Not set' : groupLabel(plan.entity.fields.find((field) => field.semanticId === matrix.rowByFieldId), row)}` +
    ` and ${column === null ? 'Not set' : groupLabel(plan.entity.fields.find((field) => field.semanticId === matrix.columnByFieldId), column)}`;
  const drill = exact > 0
    ? ` data-matrix-drill="${escapeAttribute(node.semanticId)}" data-matrix-row="${row === null ? '' : escapeAttribute(row)}" data-matrix-row-unset="${row === null}" data-matrix-column="${column === null ? '' : escapeAttribute(column)}" data-matrix-column-unset="${column === null}"`
    : '';
  return `<section class="matrix-cell${exact === 0 ? ' is-empty' : ''}"><header><button type="button" class="matrix-total" aria-label="${escapeAttribute(`${answered === null ? 'No number for' : `${exact} with`} ${label}`)}"${drill}${drill === '' ? ' disabled' : ''}><strong>${answered === null ? '—' : exact}</strong></button>${shown}</header><div class="card-stack">${inCell.map((record) => recordCardMarkup(plan, record, matrix.cardFieldIds)).join('')}</div></section>`;
}

/** Which lane a stored value belongs to: its own option, or the unset lane. */
function laneOf(stored: unknown, lanes: string[]): string | null {
  if (stored === null || stored === undefined) return null;
  const text = typeof stored === 'boolean' ? String(stored) : stringValue(stored);
  return lanes.includes(text) ? text : null;
}

export function listMarkup(plan: ApplicationPlan, node: SurfaceNodePlan | null): string {
  if (plan.records.length === 0) return emptySurfaceMarkup(plan);
  // The status dot reads the entity's first board grouping, which is a display
  // convenience of the record type rather than of the selected list.
  const board = boardView(plan);
  const [headingFieldId, ...detailFieldIds] = listFieldIds(plan, node);
  return `<div class="record-list" role="list">${plan.records.map((record) => `<button type="button" role="listitem" data-record-id="${escapeAttribute(record.semanticId)}">${accentDot(plan, board?.groupByFieldId ?? surfaceAccentFieldId(plan, selectedSurfaceNode(plan)), record)}<strong>${escapeHtml(recordFieldDisplay(record, headingFieldId, plan.entity.derivedFields) || `Untitled ${plan.entity.displayName}`)}</strong>${detailFieldIds.slice(0, 2).map((fieldId) => `<span>${fieldValueMarkup(plan, record, fieldId, '—')}</span>`).join('')}<small>v${record.version}</small></button>`).join('')}</div>`;
}

export function drillPillMarkup(plan: ApplicationPlan): string {
  const drill = activeDrill(plan, selectedSurfaceNode(plan));
  if (drill === null) return '';
  return `<span class="drill-pill" role="status" data-testid="drill-pill">Showing ${escapeHtml(drill.label)}<button type="button" class="icon-button drill-clear" data-drill-clear aria-label="Show all records">${icon('close')}</button></span>`;
}
