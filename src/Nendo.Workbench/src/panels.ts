import { chartTables } from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { chartTileMarkup } from './record-markup';
import { content, showError } from './shell';
import { client } from './client';
import { rerender, setBusy } from './shell';
import { messageFor, fieldName } from './format';
import { breakdownRead, bucketDrillFilters, bucketRead, cellDrillFilters, cellRead, chartKey, drillFilter, drillLabel, isOverTimeKind, progressRead, ringDrillFilters, type BucketResult, type CellResult, type GroupedResult, type ScopedChart } from './charts';
import { tileKey, tileRead, type OverviewTileScope, type ScopedTile, type TileRead } from './summary-tiles';
import {
  overviewCharts, overviewRanges, overviewRankedLists, overviewRecentLists, overviewTiles, rangeEndKey,
  rangeReads, rankedMaxKey, rankedMaxRead,
} from './overview-model';
import { mapBounded } from './record-window';
import { surfaceById } from './surface-model';
import {
  chartStates, drills, leaveRecordContext, matrixCells, selectedSurfaces, state, summaryCounts, surfaceErrors,
  surfaceWindows, type ChartOutcome, type DrillFilter,
} from './app-state';
import { boardColumnsPending, chartPending, drillTarget, overviewReadIsPending, readIsPending, selectedSurfaceNode, tilePending, visibleCharts, visibleTiles } from './plan-selection';
import { loadSurfaceWindow } from './reads';
import { loadBoardColumns, loadRankedWindows, loadRecentWindows } from './reads';
import { WorkbenchHostError, type ApplicationPlan, type OverviewPlan, type SurfaceNodePlan } from './host';

/**
 * Reading the numbers beside a surface: the exact count behind a tile, the two
 * counts behind a ring, the grouped answer behind a bar, and the drill that
 * turns one of those groups into a filtered list.
 *
 * A tile counts the whole filtered set rather than the page in view, so each is
 * its own read. An answer captured under an older generation is discarded rather
 * than written over the current view.
 */

// At most four exact reads in flight. A board with a tile in every column would
// otherwise open one request per column against a single file.
export const summaryReadConcurrency = 4;

export async function loadSummaryCounts(scoped: ScopedTile[], surfaceEntityId: string | null): Promise<void> {
  const generation = ++state.summaryGeneration;
  const fileSessionId = state.session.fileSessionId;
  const pending = scoped.filter(tilePending);
  if (pending.length === 0) return;
  const keys = pending.map((item) => tileKey(item.tile, item.scope));
  for (const key of keys) summaryCounts.set(key, { state: 'loading' });

  // Deliberately not "the file has not moved since this read started". A read that
  // began at one revision and answered at a later one has answered about the later
  // one, and the result carries the revision it was read at. Discarding it meant a
  // file being written to continuously could never show a number at all: every
  // answer arrived after the file had moved, so every answer was thrown away and
  // every tile stayed pending. What must not happen is an answer landing on another
  // view or another file, and that is what these two guards are for.
  const current = (): boolean =>
    state.summaryGeneration === generation && state.session.fileSessionId === fileSessionId;

  try {
  await mapBounded(pending, summaryReadConcurrency, async (item) => {
    const key = tileKey(item.tile, item.scope);
    const read = tileRead(item.tile, item.scope, surfaceEntityId);
    if (read === null) {
      if (current()) summaryCounts.set(key, { state: 'failed', code: 'not-readable', message: 'This summary is not readable.' });
      return;
    }
    try {
      if (read.aggregate === 'count' || read.fieldId === null) {
        const result = await client.request<{ count: number; changeSequence: number }>(
          'data.countRecords', { entityId: read.entityId, filters: read.filters });
        if (current()) summaryCounts.set(key, { state: 'ready', value: String(result.count), changeSequence: result.changeSequence });
        return;
      }
      const result = await client.request<{ valueLexeme: string | null; changeSequence: number }>(
        'data.aggregateRecords',
        { entityId: read.entityId, aggregate: read.aggregate, fieldId: read.fieldId, filters: read.filters });
      if (current()) summaryCounts.set(key, { state: 'ready', value: result.valueLexeme, changeSequence: result.changeSequence });
    } catch (error) {
      if (current()) summaryCounts.set(key, { state: 'failed', code: error instanceof WorkbenchHostError ? error.code : 'host-error', message: messageFor(error) });
    }
  });
  } finally {
    // A load the view moved past wrote nothing, so its loading marks would
    // otherwise stand for an answer that is no longer coming.
    if (!current())
      for (const key of keys)
        if (summaryCounts.get(key)?.state === 'loading') summaryCounts.delete(key);
  }
}

/**
 * The front page's own reads, under the same bound and the same generation guard
 * as a surface's. Tiles, then ranges, then charts, then the recent windows, so no
 * more than the bounded number is ever in flight — a front page can hold more
 * tiles than any single surface does, which is exactly why the bound matters here.
 */
export async function refreshOverview(overview: OverviewPlan | null): Promise<void> {
  if (overview === null) return;
  const tiles = overviewTiles(overview);
  const ranges = overviewRanges(overview);
  const charts = overviewCharts(overview);
  if (tiles.length > 0) await loadSummaryCounts(tiles, null);
  if (ranges.length > 0) await loadRanges(ranges);
  if (charts.length > 0) await loadCharts(charts, null);
  await loadRecentWindows(overviewRecentLists(overview));
  const rankings = overviewRankedLists(overview);
  if (rankings.length > 0) {
    await loadRankedWindows(rankings);
    await loadRankedMaxima(rankings);
  }
}

/**
 * The largest value each ranking is drawn against, as one exact read per ranking. It is
 * folded into the summary map because it is the same kind of answer a tile carries, and
 * it is read separately from the window because the window is one page while the maximum
 * is about the whole set: bars drawn against the largest value on the page would rescale
 * themselves every time the page changed.
 */
export async function loadRankedMaxima(nodes: SurfaceNodePlan[]): Promise<void> {
  const generation = ++state.summaryGeneration;
  const fileSessionId = state.session.fileSessionId;
  const reads = nodes.flatMap((node) => {
    const read = rankedMaxRead(node);
    return read === null ? [] : [{ key: rankedMaxKey(node), read }];
  }).filter((item) => overviewReadIsPending(summaryCounts.get(item.key), state.session.manifest?.changeSequence));
  if (reads.length === 0) return;
  for (const item of reads) summaryCounts.set(item.key, { state: 'loading' });

  const current = (): boolean =>
    state.summaryGeneration === generation && state.session.fileSessionId === fileSessionId;
  try {
    await mapBounded(reads, summaryReadConcurrency, async (item) => {
      try {
        const result = await client.request<{ valueLexeme: string | null; changeSequence: number }>(
          'data.aggregateRecords',
          { entityId: item.read.entityId, aggregate: 'max', fieldId: item.read.fieldId, filters: item.read.filters });
        if (current()) summaryCounts.set(item.key, { state: 'ready', value: result.valueLexeme, changeSequence: result.changeSequence });
      } catch (error) {
        if (current()) summaryCounts.set(item.key, { state: 'failed', code: error instanceof WorkbenchHostError ? error.code : 'host-error', message: messageFor(error) });
      }
    });
  } finally {
    if (!current())
      for (const item of reads)
        if (summaryCounts.get(item.key)?.state === 'loading') summaryCounts.delete(item.key);
  }
}

/**
 * The one crossed read behind a matrix (ADR-0004, 2026-09-17 amendment, S6).
 *
 * A grid costs one read whatever its size, which is the whole reason a cell can state an
 * exact number over everything the surface covers while the cards inside it are the
 * surface's one loaded window. It is held per surface rather than per tile, because it
 * belongs to the surface: there is no tile here to hang it on.
 */
export async function loadMatrix(surface: SurfaceNodePlan, entityId: string): Promise<void> {
  const generation = ++state.chartGeneration;
  const fileSessionId = state.session.fileSessionId;
  const key = surface.semanticId;
  const read = cellRead(surface, entityId);
  if (read === null) {
    matrixCells.set(key, { state: 'failed', code: 'not-readable', message: 'This matrix is not readable.' });
    return;
  }
  matrixCells.set(key, { state: 'loading' });
  const current = (): boolean =>
    state.chartGeneration === generation && state.session.fileSessionId === fileSessionId;
  try {
    const cells = await client.request<CellResult>('data.cellAggregateRecords', {
      entityId: read.entityId,
      rowByFieldId: read.rowByFieldId,
      columnByFieldId: read.columnByFieldId,
      aggregate: read.aggregate,
      fieldId: read.fieldId,
      filters: read.filters,
    });
    if (current()) matrixCells.set(key, { state: 'ready', changeSequence: cells.changeSequence, cells });
  } catch (error) {
    if (current())
      matrixCells.set(key, { state: 'failed', code: error instanceof WorkbenchHostError ? error.code : 'host-error', message: messageFor(error) });
  } finally {
    if (!current() && matrixCells.get(key)?.state === 'loading') matrixCells.delete(key);
  }
}

/**
 * Whether the selected matrix still owes an answer for the file as it now stands. A
 * refused read waits for Retry, for the reason `tilePending` gives: asking again
 * immediately is a redraw loop, not a recovery.
 */
export function matrixPending(plan: ApplicationPlan): boolean {
  const surface = selectedSurfaceNode(plan);
  if (surface === null || surface.kind !== 'matrixSurface') return false;
  return readIsPending(matrixCells.get(surface.semanticId), state.session.manifest?.changeSequence);
}

/**
 * Both ends of every range, as two exact reads each. They are folded into the
 * summary map because they are the same kind of answer a tile carries — one exact
 * lexeme, or a stated refusal — and the strip is drawn only once both have
 * arrived, so neither end can be shown as though it were the range.
 */
export async function loadRanges(scoped: ScopedTile[]): Promise<void> {
  const generation = ++state.summaryGeneration;
  const fileSessionId = state.session.fileSessionId;
  const sequence = state.session.manifest?.changeSequence;
  const ranges = scoped.flatMap((item) => {
    const scope = item.scope as OverviewTileScope;
    const reads = rangeReads(item.tile, scope);
    return reads === null
      ? []
      : [{ minKey: rangeEndKey(item.tile, scope, 'min'), maxKey: rangeEndKey(item.tile, scope, 'max'), reads }];
  }).filter((range) => [range.minKey, range.maxKey].some((key) => overviewReadIsPending(summaryCounts.get(key), sequence)));
  if (ranges.length === 0) return;
  const keys = ranges.flatMap((range) => [range.minKey, range.maxKey]);
  for (const key of keys) summaryCounts.set(key, { state: 'loading' });

  const current = (): boolean =>
    state.summaryGeneration === generation && state.session.fileSessionId === fileSessionId;
  const aggregate = (read: TileRead) => () =>
    client.request<{ valueLexeme: string | null; changeSequence: number }>(
      'data.aggregateRecords', { entityId: read.entityId, aggregate: read.aggregate, fieldId: read.fieldId, filters: read.filters });
  try {
    await mapBounded(ranges, summaryReadConcurrency, async (range) => {
      try {
        // Both ends from one revision, or neither: a low from before a write and a high from
        // after it can draw a range that is inverted or never existed (R-009).
        const pair = await sameRevision(aggregate(range.reads.min), aggregate(range.reads.max));
        if (!current()) return;
        if (pair === null) { summaryCounts.delete(range.minKey); summaryCounts.delete(range.maxKey); return; }
        const [low, high] = pair;
        summaryCounts.set(range.minKey, { state: 'ready', value: low.valueLexeme, changeSequence: low.changeSequence });
        summaryCounts.set(range.maxKey, { state: 'ready', value: high.valueLexeme, changeSequence: high.changeSequence });
      } catch (error) {
        if (!current()) return;
        const failed = { state: 'failed' as const, code: error instanceof WorkbenchHostError ? error.code : 'host-error', message: messageFor(error) };
        summaryCounts.set(range.minKey, failed);
        summaryCounts.set(range.maxKey, failed);
      }
    });
  } finally {
    if (!current())
      for (const key of keys)
        if (summaryCounts.get(key)?.state === 'loading') summaryCounts.delete(key);
  }
}

/** How many pairs one pass compares before it leaves two reads that disagree for the next pass. */
export const sameRevisionAttempts = 3;

/**
 * Two reads that are drawn as one answer, both from the same revision of the file (R-009).
 *
 * Each read answers with the change sequence it was read at, and a write can commit between
 * the two: a ring once divided a count of 10 read before a write by a total of 1 read after
 * it and showed 1000%, labelled as current. A revision only moves forward, so the earlier of
 * the two is read again until they agree, `sameRevisionAttempts - 1` times at most, so a pass
 * costs at most one read more than it has attempts. Null when the file kept moving: nothing is kept, the entry stays pending, and the
 * next bounded pass tries again, so the answer comes once the writing stops.
 */
export async function sameRevision<A extends { changeSequence: number }, B extends { changeSequence: number }>(
  first: () => Promise<A>,
  second: () => Promise<B>,
  attempts = sameRevisionAttempts,
): Promise<[A, B] | null> {
  let a = await first();
  let b = await second();
  for (let read = 1; a.changeSequence !== b.changeSequence; read++) {
    if (read >= attempts) return null;
    if (a.changeSequence < b.changeSequence) a = await first();
    else b = await second();
  }
  return [a, b];
}

export async function refreshVisibleTiles(plan: ApplicationPlan): Promise<void> {
  // A reference board's columns come first, because a column-scoped tile counts one
  // column and there are no columns to count until they have been read. The pass after
  // this one sees them and reads their tiles; nothing is drawn against a lane that is
  // not there.
  const columns = boardColumnsPending(plan) ? selectedSurfaceNode(plan) : null;
  if (columns !== null) await loadBoardColumns(plan, [columns]);
  const tiles = visibleTiles(plan);
  const charts = visibleCharts(plan);
  const matrix = matrixPending(plan) ? selectedSurfaceNode(plan) : null;
  if (tiles.length === 0 && charts.length === 0 && matrix === null) return;
  // Tiles first, then charts, so no more than the bounded number is ever in flight.
  if (tiles.length > 0) await loadSummaryCounts(tiles, plan.entity.semanticId);
  if (charts.length > 0) await loadCharts(charts, plan.entity.semanticId);
  if (matrix !== null) await loadMatrix(matrix, plan.entity.semanticId);
}

/**
 * Load the charts for one view under the same bound and the same generation
 * guard as the tiles. A breakdown is one grouped read; a ring is two counts, and
 * it is not drawn until both have answered.
 */
export async function loadCharts(scoped: ScopedChart[], surfaceEntityId: string | null): Promise<void> {
  const generation = ++state.chartGeneration;
  const fileSessionId = state.session.fileSessionId;
  const pending = scoped.filter(chartPending);
  if (pending.length === 0) return;
  const keys = pending.map((item) => chartKey(item.node, item.scope));
  for (const key of keys) chartStates.set(key, { state: 'loading' });
  const current = (): boolean =>
    state.chartGeneration === generation && state.session.fileSessionId === fileSessionId;
  const settle = (key: string, outcome: ChartOutcome): void => { if (current()) chartStates.set(key, outcome); };
  try {
    await mapBounded(pending, summaryReadConcurrency, async (item) => {
      const key = chartKey(item.node, item.scope);
      try {
        if (item.node.kind === 'progressTile') {
          const read = progressRead(item.node, item.scope, surfaceEntityId);
          if (read === null) { settle(key, { state: 'failed', code: 'not-readable', message: 'This ring is not readable.' }); return; }
          const count = (filters: unknown[]) => () =>
            client.request<{ count: number; changeSequence: number }>('data.countRecords', { entityId: read.entityId, filters });
          const pair = await sameRevision(count(read.numerator), count(read.denominator));
          if (pair === null) { if (current()) chartStates.delete(key); return; }
          const [numerator, denominator] = pair;
          settle(key, { state: 'ready', changeSequence: denominator.changeSequence, numerator: String(numerator.count), denominator: String(denominator.count) });
          return;
        }
        if (isOverTimeKind(item.node.kind)) {
          const overTime = bucketRead(item.node, item.scope, surfaceEntityId);
          if (overTime === null) { settle(key, { state: 'failed', code: 'not-readable', message: 'This chart is not readable.' }); return; }
          const bucketed = await client.request<BucketResult>('data.bucketAggregateRecords', {
            entityId: overTime.entityId,
            dateFieldId: overTime.dateFieldId,
            bucket: overTime.bucket,
            range: overTime.range,
            aggregate: overTime.aggregate,
            fieldId: overTime.fieldId,
            filters: overTime.filters,
          });
          settle(key, { state: 'ready', changeSequence: bucketed.changeSequence, bucketed });
          return;
        }
        const read = breakdownRead(item.node, item.scope, surfaceEntityId);
        if (read === null) { settle(key, { state: 'failed', code: 'not-readable', message: 'This chart is not readable.' }); return; }
        const result = await client.request<GroupedResult>('data.groupAggregateRecords',
          { entityId: read.entityId, groupByFieldId: read.groupByFieldId, aggregate: read.aggregate, fieldId: read.fieldId, filters: read.filters });
        settle(key, { state: 'ready', changeSequence: result.changeSequence, grouped: result });
      } catch (error) {
        settle(key, { state: 'failed', code: error instanceof WorkbenchHostError ? error.code : 'host-error', message: messageFor(error) });
      }
    });
  } finally {
    if (!current())
      for (const key of keys)
        if (chartStates.get(key)?.state === 'loading') chartStates.delete(key);
  }
}

export async function drillInto(plan: ApplicationPlan, scoped: ScopedChart, group: { key: string | null } | null): Promise<void> {
  const list = drillTarget(plan);
  if (list === null) return;
  const names = (fieldId: string): string => fieldName(plan, fieldId);
  const groupByFieldId = typeof scoped.node.properties.groupByFieldId === 'string' ? scoped.node.properties.groupByFieldId : '';
  const field = plan.entity.fields.find((candidate) => candidate.semanticId === groupByFieldId);
  const bucket = scoped.node.kind === 'activityGrid' ? 'day'
    : typeof scoped.node.properties.bucket === 'string' ? scoped.node.properties.bucket : 'month';
  const filters: DrillFilter[] = group === null
    ? ringDrillFilters(scoped.node)
    : isOverTimeKind(scoped.node.kind)
      ? bucketDrillFilters(scoped.node, bucket, group.key)
      : [drillFilter(scoped.node, field, group.key)].filter((filter): filter is DrillFilter => filter !== null);
  if (filters.length === 0) return;
  drills.set(plan.entity.semanticId, { listId: list.semanticId, label: drillLabel(scoped.node, field, group?.key ?? null, names), filters });
  await reopenDrilledList(plan, list);
}

/**
 * Drill from one cell of a matrix: the row's predicate and the column's, into the record
 * type's first list. Two clauses, as a bucket's two bounds are, and stored nowhere.
 */
export async function drillIntoCell(
  plan: ApplicationPlan,
  surface: SurfaceNodePlan,
  rowKey: string | null,
  columnKey: string | null,
  label: string,
): Promise<void> {
  const list = drillTarget(plan);
  if (list === null) return;
  const filters = cellDrillFilters(surface, rowKey, columnKey);
  if (filters.length === 0) return;
  drills.set(plan.entity.semanticId, { listId: list.semanticId, label, filters });
  await reopenDrilledList(plan, list);
}

export async function clearDrill(plan: ApplicationPlan): Promise<void> {
  const drill = drills.get(plan.entity.semanticId);
  if (drill === undefined) return;
  if (refuseWhileDirty('widening the list')) return;
  drills.delete(plan.entity.semanticId);
  const list = surfaceById(plan, drill.listId);
  if (list === null) { rerender(); return; }
  await reopenDrilledList(plan, list);
}

export async function reopenDrilledList(plan: ApplicationPlan, list: SurfaceNodePlan): Promise<void> {
  if (state.actionInFlight) return;
  // A drill leaves the record beside the list and redraws; not over unsaved typing. The
  // drill itself was stored by the caller before this, and stands until the list is
  // reopened, which is what the next read of it does.
  if (refuseWhileDirty('narrowing the list')) return;
  const entityId = plan.entity.semanticId;
  selectedSurfaces.set(entityId, list.semanticId);
  leaveRecordContext();
  surfaceErrors.delete(list.semanticId);
  surfaceWindows.delete(list.semanticId);
  state.actionInFlight = true;
  setBusy(true);
  try {
    await loadSurfaceWindow(entityId, list);
  } catch (error) {
    surfaceErrors.set(list.semanticId, messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
}

/** Retry, the table toggle, a segment's drill and the pill's dismissal. */
export function wireCharts(plan: ApplicationPlan): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-chart-retry]'))
    button.addEventListener('click', () => {
      const key = button.dataset.chartRetry;
      if (key === undefined || state.actionInFlight || refuseWhileDirty('reading again')) return;
      chartStates.delete(key);
      void refreshVisibleTiles(plan).then(rerender).catch(error => showError(messageFor(error)));
    });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-chart-table]'))
    button.addEventListener('click', () => {
      const key = button.dataset.chartTable;
      if (key === undefined) return;
      if (chartTables.has(key)) chartTables.delete(key); else chartTables.add(key);
      patchCharts(plan);
      content.querySelector<HTMLElement>(`[data-chart-table="${CSS.escape(key)}"]`)?.focus();
    });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-chart-drill]'))
    button.addEventListener('click', () => {
      const key = button.dataset.chartDrill;
      if (key === undefined || state.actionInFlight) return;
      const scoped = visibleCharts(plan).find((candidate) => chartKey(candidate.node, candidate.scope) === key);
      if (scoped === undefined) return;
      const group = button.dataset.chartRing === 'true' ? null : { key: button.dataset.chartUnset === 'true' ? null : (button.dataset.chartGroup ?? '') };
      void drillInto(plan, scoped, group);
    });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-drill-clear]'))
    button.addEventListener('click', () => { void clearDrill(plan); });
}

export function patchCharts(plan: ApplicationPlan): void {
  const charts = new Map(visibleCharts(plan).map((scoped) => [chartKey(scoped.node, scoped.scope), scoped]));
  for (const element of content.querySelectorAll<HTMLElement>('[data-chart-key]')) {
    const scoped = charts.get(element.dataset.chartKey ?? '');
    if (scoped !== undefined) element.outerHTML = chartTileMarkup(plan, scoped);
  }
  wireCharts(plan);
}

/** Open the list under its effective query. Its window is keyed by the surface, so the page loaded under the other query must not stand in. */
export function wireSummaryRetry(plan: ApplicationPlan): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-summary-retry]'))
    button.addEventListener('click', () => {
      const key = button.dataset.summaryRetry;
      if (key === undefined || state.actionInFlight || refuseWhileDirty('reading again')) return;
      summaryCounts.delete(key);
      void refreshVisibleTiles(plan).then(rerender).catch(error => showError(messageFor(error)));
    });
}

