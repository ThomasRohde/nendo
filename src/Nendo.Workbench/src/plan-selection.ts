import { calculationsOf } from './calculated-fields';
import { sectionIsOpen } from './fold-state';
import { selectedEntity } from './studio';
import { applicationRecipeFor, type ApplicationRecipe } from './application-recipes';
import { accumulatesPages, activeTabSection, bindingFieldId, boardViewOf, descendants, nodeFieldIds, pageRoot, resolveSurface, useSurfaces, type BoardView } from './surface-model';
import { declaredQuery, emptyWindowQuery, type WindowQuery } from './record-window';
import { calendarWindowKey, type CalendarMode, type CivilMonth } from './calendar-model';
import { timelineWindowKey } from './timeline-model';
import { chartKey, groupScopedCharts, pageScopedCharts, surfaceScopedCharts, type ScopedChart } from './charts';
import { groupScopedTiles, groupTileScope, pageScopedTiles, surfaceScopedTiles, tileKey, type ScopedTile } from './summary-tiles';
import { cssToken } from './format';
import {
  accumulatedWindows, boardColumns, calendarModes, calendarMonths, chartStates, drills, recordWindows, selectedSurfaces,
  selectedTabs, state, studioQueries, studioWindows, summaryCounts, surfaceWindows, tabStateKey,
  timelineModes, timelineYears, type BoardColumn, type DrillState, type RecordWindow,
} from './app-state';
import type {
  ApplicationPlan, DerivedFieldPlan, EntitySnapshot, FieldPlan, OverviewPlan, RecordPlan, RecordSnapshot,
  SurfaceNodePlan,
} from './host';

/**
 * What is selected, and what the selection resolves to.
 *
 * These read the session and the remembered selections and answer in the plan
 * vocabulary the views render from. They never fetch: a window that has not been
 * read yet resolves to no records rather than to a request.
 */

export function sessionEntity(): EntitySnapshot | null {
  const entity = selectedEntity(state.view === 'structure' || state.showRetiredData ? state.session : { ...state.session, entities: state.session.entities.filter(entity => !entity.retired) }, state.selectedEntityId);
  state.selectedEntityId = entity?.entityId ?? null;
  return entity;
}
export function applicationPlans(): ApplicationPlan[] {
  return state.compilation?.isValid ? state.compilation.applications ?? [] : [];
}

/**
 * The file's front page, when the definition compiles and declares one. It is not
 * among the application plans: it belongs to the file rather than to a record
 * type, and Use offers it beside the types rather than among one type's surfaces.
 */
export function overviewPlan(): OverviewPlan | null {
  return state.compilation?.isValid ? state.compilation.overview ?? null : null;
}
export function activePlan(): ApplicationPlan | null {
  const plans = applicationPlans();
  const definition = plans.find(plan => plan.entity.semanticId === state.selectedApplicationEntity) ?? plans[0] ?? null;
  if (definition === null) return null;
  // The host digest describes the compiled definition. The visible record
  // window is a separate revision-bound data projection, never cached in it —
  // and it belongs to the selected surface, not to the record type.
  const surface = selectedSurfaceNode(definition);
  // A calendar or a timeline accumulates pages of its own, so its records are
  // the entries it has loaded for the range in view rather than one bounded window.
  const records = surface !== null && accumulatesPages(surface.kind)
    ? accumulatedRecords(surface)
    : recordsForEntity(definition.entity.semanticId, surface?.semanticId ?? null);
  return { ...definition, records };
}

/**
 * The surface in view for one record type: the remembered choice while it still
 * exists, otherwise the first compiled root. The remembered choice is not
 * rewritten by the fallback, so a surface removed by one proposal and restored by
 * the next comes back selected.
 */
export function selectedSurfaceNode(plan: ApplicationPlan): SurfaceNodePlan | null {
  return resolveSurface(plan, selectedSurfaces.get(plan.entity.semanticId) ?? null);
}

/**
 * The columns a reference board has read, or null when it has not read them yet, the
 * read refused, or the target type holds more records than a board can draw.
 *
 * Every caller that needs a board's columns goes through here, so a board grouped by a
 * reference has one answer about what its lanes are. Two answers would mean a tile
 * counting a column the board is not drawing.
 */
export function referenceColumnsOf(node: SurfaceNodePlan | null): BoardColumn[] | null {
  if (node === null) return null;
  const known = boardColumns.get(node.semanticId);
  return known?.state === 'ready' ? known.columns : null;
}

/**
 * Whether the board in view still owes a read of its own columns.
 *
 * A board grouped by a choice never does: its lanes are in the definition. A reference
 * board does until the records arrive, and again whenever the file moves on, because a
 * column is a record and somebody may have just made one. A refused read waits for Retry,
 * as every other refused read does.
 */
export function boardColumnsPending(plan: ApplicationPlan): boolean {
  const node = selectedSurfaceNode(plan);
  if (node === null || node.kind !== 'boardSurface') return false;
  const field = typeof node.properties.groupByFieldId === 'string' ? node.properties.groupByFieldId : null;
  if (field === null || plan.entity.fields.find((candidate) => candidate.semanticId === field)?.reference == null) return false;
  const known = boardColumns.get(node.semanticId);
  if (known === undefined) return true;
  if (known.state === 'failed' || known.state === 'loading') return false;
  return known.changeSequence !== state.session.manifest?.changeSequence;
}

/** A board's view, carrying the reference columns it has read when those are its lanes. */
export function boardOf(plan: ApplicationPlan, node: SurfaceNodePlan | null): BoardView | null {
  return boardViewOf(node, plan.entity.fields, referenceColumnsOf(node)?.map((column) => column.recordId) ?? null);
}

/** The columns of the selected board, or null when the selection is not a board. */
export function selectedBoard(plan: ApplicationPlan): BoardView | null {
  return boardOf(plan, selectedSurfaceNode(plan));
}

/**
 * Today in the device's own calendar. The local accessors are used deliberately:
 * an ISO instant read back in UTC names a different day either side of midnight,
 * and Today has to mean the owner's today.
 */
export function todayCivil(): { month: CivilMonth; day: number } {
  const now = new Date();
  return { month: { year: now.getFullYear(), month: now.getMonth() + 1 }, day: now.getDate() };
}

/** The month one calendar surface is showing. The current month at first open. */
export function calendarMonthFor(surfaceId: string): CivilMonth {
  return calendarMonths.get(surfaceId) ?? todayCivil().month;
}

export function calendarModeFor(surfaceId: string): CalendarMode {
  return calendarModes.get(surfaceId) ?? 'dated';
}

export function calendarKeyFor(node: SurfaceNodePlan): string {
  return calendarWindowKey(node.semanticId, calendarModeFor(node.semanticId), calendarMonthFor(node.semanticId));
}

/** The year one timeline surface is showing. This year, in the device's calendar, at first open. */
export function timelineYearFor(surfaceId: string): number {
  return timelineYears.get(surfaceId) ?? todayCivil().month.year;
}

export function timelineModeFor(surfaceId: string): CalendarMode {
  return timelineModes.get(surfaceId) ?? 'dated';
}

export function timelineKeyFor(node: SurfaceNodePlan): string {
  return timelineWindowKey(node.semanticId, timelineModeFor(node.semanticId), timelineYearFor(node.semanticId));
}

/** The window key of a surface that accumulates its own pages, by its kind. */
export function accumulatedKeyFor(node: SurfaceNodePlan): string {
  return node.kind === 'timelineSurface' ? timelineKeyFor(node) : calendarKeyFor(node);
}

/**
 * One read record as a surface shows it. A window carries the host's snapshot —
 * recordId, recordVersion, calculations in dependency order — and every renderer
 * speaks the plan's vocabulary, so the projection lives here once rather than
 * being repeated wherever a window is drawn.
 */
export function recordPlanOf(record: RecordSnapshot): RecordPlan {
  return {
    semanticId: record.recordId,
    automationTarget: `record-${record.recordId}`,
    version: record.recordVersion,
    values: record.values,
    referenceLabels: record.referenceLabels,
    calculations: calculationsOf(record),
  };
}

/** The records a calendar or a timeline has actually loaded, as record plans. */
export function accumulatedRecords(node: SurfaceNodePlan): RecordPlan[] {
  const accumulated = accumulatedWindows.get(accumulatedKeyFor(node));
  if (accumulated === undefined || accumulated.changeSequence !== state.session.manifest?.changeSequence) return [];
  return accumulated.items.map(recordPlanOf);
}

export function currentRecipe(): ApplicationRecipe | null {
  return applicationRecipeFor(state.session);
}

/**
 * Where the window for one view lives, and the key it lives under. A surface owns
 * its window by stable ID; Studio's own query and the plain browse window stay
 * keyed by record type. What query a window carries is read from the window
 * itself, never inferred from the map it landed in.
 */
export function recordWindowSlot(
  entityId: string,
  surfaceId: string | null,
): { windows: Map<string, RecordWindow>; key: string } {
  if (surfaceId !== null) return { windows: surfaceWindows, key: surfaceId };
  if (state.view === 'data' && studioQueries.has(entityId)) return { windows: studioWindows, key: entityId };
  return { windows: recordWindows, key: entityId };
}

export function recordWindowFor(entityId: string, surfaceId: string | null): RecordWindow | undefined {
  const slot = recordWindowSlot(entityId, surfaceId);
  return slot.windows.get(slot.key);
}

export function recordsForEntity(entityId: string, surfaceId: string | null): RecordPlan[] {
  const page = recordWindowFor(entityId, surfaceId)?.page;
  return (page !== undefined && page.changeSequence === state.session.manifest?.changeSequence ? page.items : []).map(recordPlanOf);
}

export function snapshotFieldPlans(entity: EntitySnapshot): FieldPlan[] {
  return entity.fields.filter(field => state.showRetiredData || !field.retired).map((field) => ({
    semanticId: field.fieldId,
    automationTarget: `field-${cssToken(field.fieldId)}`,
    displayName: field.displayName,
    storageKind: field.storageKind,
    required: field.required,
    presentation: field.presentation,
    options: field.options,
    choices: field.choices,
    scale: field.scale,
    retired: field.retired,
  }));
}

/** The first single-choice field a surface binds, whose tone marks each entry. */
export function surfaceAccentFieldId(plan: ApplicationPlan, node: SurfaceNodePlan | null): string | null {
  for (const child of node?.children ?? []) {
    if (child.kind !== 'fieldBinding') continue;
    const fieldId = typeof child.properties.fieldId === 'string' ? child.properties.fieldId : null;
    if (fieldId !== null && plan.entity.fields.find((field) => field.semanticId === fieldId)?.presentation === 'singleChoice') return fieldId;
  }
  return null;
}

export function formFields(plan: ApplicationPlan): FieldPlan[] {
  const byId = new Map(plan.entity.fields.map((field) => [field.semanticId, field]));
  const declared = treeFieldIds(plan) ?? plan.entity.fields.map((field) => field.semanticId);
  // A field bound twice on one page is one logical field with one draft value
  // and one validation state, so it is wired once, in first-authored order.
  return [...new Set(declared)]
    .map((fieldId) => byId.get(fieldId))
    .filter((field): field is FieldPlan => field !== undefined);
}

// The selected list, board or calendar root governs the window. Its query is a
// snapshot taken once and carried by the window, not recomputed per page.
export function activeSurfaceQuery(plan: ApplicationPlan): WindowQuery {
  const root = selectedSurfaceNode(plan);
  return root === null ? emptyWindowQuery() : declaredQuery(root);
}

export function relatedLists(plan: ApplicationPlan): SurfaceNodePlan[] {
  const root = pageRoot(plan);
  return root === null ? [] : descendants(root.children, 'relatedList');
}

/**
 * The nodes of a kind that the open tabs actually show. A relation in a closed
 * tab is not queried until the tab is opened, so opening a record page does not
 * read every relation the page could ever show.
 */
export function visibleNodes(plan: ApplicationPlan, kind: string): SurfaceNodePlan[] {
  const root = pageRoot(plan);
  if (root === null) return [];
  const walk = (nodes: SurfaceNodePlan[]): SurfaceNodePlan[] => nodes.flatMap((node) => {
    if (node.kind === kind) return [node];
    // A closed section's relations and totals are not read until it is opened, as a
    // closed tab's are not.
    if (node.kind === 'section' && !sectionIsOpen(node)) return [];
    if (node.kind !== 'tabGroup') return walk(node.children);
    const active = activeTabSection(node, selectedTabs.get(
      tabStateKey(plan.entity.semanticId, root.semanticId, node.semanticId)));
    return active === null ? [] : walk(active.children);
  });
  return walk(root.children);
}

// Contract version 3 keeps field order in the tree, so the flat list a form
// wires against is the tree read depth first.
export function treeFieldIds(plan: ApplicationPlan): string[] | null {
  const root = pageRoot(plan);
  if (root === null) return null;
  // A related list binds the related record type, so its children are not fields
  // of this surface and must not be collected as if they were.
  const collect = (nodes: SurfaceNodePlan[]): string[] =>
    nodes.flatMap((node) => node.kind === 'fieldBinding'
      ? [bindingFieldId(node)].filter((id): id is string => id !== null)
      : node.kind === 'relatedList' ? []
      : collect(node.children));
  return collect(root.children);
}

/**
 * The calculated fields of one record type, as render plans.
 *
 * Studio reads them off the session rather than a compiled surface, because Studio
 * is the permanent route into a file and must keep working when no custom surface
 * compiles at all.
 */
export function derivedFor(entity: EntitySnapshot): DerivedFieldPlan[] {
  return (entity.derivedFields ?? []).map((field) => ({
    semanticId: field.fieldId,
    automationTarget: `nendo-${field.fieldId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`,
    displayName: field.displayName,
    resultType: field.resultType,
    resultNullable: field.resultNullable,
    calculationId: field.calculationId,
    expression: field.expression,
  }));
}

// The columns of the list in view. A form-only application has no list node, so
// it falls back to the record page's own fields as it always did.
export function listFieldIds(plan: ApplicationPlan, node: SurfaceNodePlan | null): string[] {
  const declared = node ?? pageRoot(plan);
  const fromTree = declared === null ? [] : nodeFieldIds(declared);
  if (fromTree.length > 0) return fromTree;
  const fromPage = declared === null ? [] : treeFieldIds(plan) ?? [];
  if (fromPage.length > 0) return fromPage;
  return plan.entity.fields.map((field) => field.semanticId);
}

/** The list a chart drills into: the record type's first list, or none. */
export function drillTarget(plan: ApplicationPlan): SurfaceNodePlan | null {
  return useSurfaces(plan).find((node) => node.kind === 'recordList') ?? null;
}

export function activeDrill(plan: ApplicationPlan, surface: SurfaceNodePlan | null): DrillState | null {
  const drill = drills.get(plan.entity.semanticId);
  return drill !== undefined && surface !== null && drill.listId === surface.semanticId ? drill : null;
}

/**
 * The query a surface's window opens under. A drill replaces the list's own
 * clauses rather than composing with them, so it spends one filter and can never
 * refuse a list that compiled; the declared order is kept.
 */
export function effectiveSurfaceQuery(entityId: string, node: SurfaceNodePlan): WindowQuery {
  const declared = declaredQuery(node);
  const drill = drills.get(entityId);
  return drill !== undefined && drill.listId === node.semanticId
    ? { filters: drill.filters, sortFieldId: declared.sortFieldId, descending: declared.descending }
    : declared;
}

// A relation window's query is the reference predicate plus the relation's own
// declared clauses. It is composed once, when the window opens.
export function relationQuery(node: SurfaceNodePlan, viaFieldId: string, recordId: string): WindowQuery {
  const declared = declaredQuery(node);
  return {
    filters: [{ fieldId: viaFieldId, operator: 'eq', value: recordId }, ...declared.filters],
    sortFieldId: declared.sortFieldId,
    descending: declared.descending,
  };
}

/**
 * Load the tiles for one view. Every read captures the generation and change
 * sequence it was issued under and is discarded if either moved, so a file
 * switch, a mutation or a newer selection cannot be overwritten by an answer to
 * the previous question. A failing tile records its own failure and leaves the
 * others alone.
 */
/**
 * Whether one tile still needs reading: never read, or answered for an earlier
 * revision. A tile already in flight is not pending, so the renderer does not reissue
 * it — which is why a discarded load has to clear its own loading marks, or the tile
 * would wait on an answer nobody is fetching.
 *
 * **A refused read waits for Retry**, which is what `chartPending` has always said and
 * this did not. A tile the host refuses for a reason that will not change on its own —
 * a filter it cannot read, a field that is gone — was pending again the moment it
 * failed, so the chase asked again a second later, redrew the page, found it pending,
 * and asked again. The owner saw the whole screen flicker once a second behind one
 * Unavailable tile, and a record page scrolled back to the top every time (F-... , the
 * station's component page). The button beside the message is the retry.
 */
export function tilePending(scoped: ScopedTile): boolean {
  return readIsPending(summaryCounts.get(tileKey(scoped.tile, scoped.scope)), state.session.manifest?.changeSequence);
}

/**
 * The one rule every exact read on a surface follows, written once because it was
 * written three times and one of the three said something different.
 *
 * Nothing known means read it. An answer from an earlier revision means read it again.
 * A read in flight is not pending, so the renderer does not reissue it. And a refusal is
 * an answer: it waits for the person to press Retry, because asking again immediately is
 * a redraw loop rather than a recovery.
 */
export function readIsPending(
  known: { state: string; changeSequence?: number } | undefined,
  changeSequence: number | undefined,
): boolean {
  return known === undefined || (known.state === 'ready' && known.changeSequence !== changeSequence);
}

/** Every tile the current Use view shows, with the scope each one covers. */
export function visibleTiles(plan: ApplicationPlan): ScopedTile[] {
  const surface = selectedSurfaceNode(plan);
  // The columns come from the board in view. Reading the plan's first board
  // would total the second board's tiles by the first one's grouping field.
  const board = boardOf(plan, surface);
  const groupTiles = groupScopedTiles(surface);
  const columns = surface === null || board === null || groupTiles.length === 0
    ? []
    : [...board.groups.map((group): string | null => group), null];
  return [
    ...(surface === null ? [] : surfaceScopedTiles(surface).map((tile): ScopedTile => ({ tile, scope: { kind: 'surface', surface } }))),
    ...(surface === null ? [] : groupTiles.flatMap((tile) => columns.map((groupId): ScopedTile =>
      ({ tile, scope: groupTileScope(surface, board!.groupByFieldId, groupId) })))),
    // A tile in a closed tab is not read either; the scope still comes from the
    // tree, so a relation tile inside an open tab keeps its relation scope.
    ...(state.selectedRecordId === null
      ? []
      : pageScopedTiles(pageRoot(plan), state.selectedRecordId)
        .filter((scoped) => visibleTileIds(plan).has(scoped.tile.semanticId))),
  ];
}

export function visibleTileIds(plan: ApplicationPlan): Set<string> {
  return new Set(visibleNodes(plan, 'summaryTile').map((tile) => tile.semanticId));
}

/** A chart is read when nothing is known for it, or what is known is from an earlier revision. A failed read waits for Retry. */
export function chartPending(scoped: ScopedChart): boolean {
  return readIsPending(chartStates.get(chartKey(scoped.node, scoped.scope)), state.session.manifest?.changeSequence);
}

/** Every chart the current Use view shows, with the scope each one covers. */
export function visibleCharts(plan: ApplicationPlan): ScopedChart[] {
  const surface = selectedSurfaceNode(plan);
  const drilled = surface !== null && activeDrill(plan, surface) !== null;
  const board = boardOf(plan, surface);
  const groupCharts = drilled ? [] : groupScopedCharts(surface);
  const columns = surface === null || board === null || groupCharts.length === 0
    ? []
    : [...board.groups.map((group): string | null => group), null];
  const shown = visibleChartIds(plan);
  return [
    ...(surface === null || drilled ? [] : surfaceScopedCharts(surface).map((node): ScopedChart => ({ node, scope: { kind: 'surface', surface } }))),
    ...(surface === null ? [] : groupCharts.flatMap((node) => columns.map((groupId): ScopedChart =>
      ({ node, scope: groupTileScope(surface, board!.groupByFieldId, groupId) })))),
    ...(state.selectedRecordId === null
      ? []
      : pageScopedCharts(pageRoot(plan), state.selectedRecordId)
        .filter((scoped) => scoped.scope.kind === 'page' && shown.has(scoped.node.semanticId))),
  ];
}

export function visibleChartIds(plan: ApplicationPlan): Set<string> {
  return new Set([...visibleNodes(plan, 'breakdownChart'), ...visibleNodes(plan, 'progressTile')].map((node) => node.semanticId));
}

