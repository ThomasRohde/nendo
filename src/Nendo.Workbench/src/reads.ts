import { content } from './shell';
import { client } from './client';
import { refuseWhileDirty } from './draft-guard';
import { rerender, setBusy, showError } from './shell';
import { messageFor } from './format';
import { handlePageFailure } from './actions';
import { calendarQuery } from './calendar-model';
import { timelineQuery } from './timeline-model';
import { pageTarget, windowRequest, type WindowQuery } from './record-window';
import { accumulatedWindows, boardColumns, focusedRecords, rankedWindows, recentWindows, relatedWindows, state, surfaceErrors, surfaceWindows } from './app-state';
import { rankedRead, rankedWindowKey, recentRead, recentWindowKey } from './overview-model';
import {
  activePlan, calendarKeyFor, calendarModeFor, calendarMonthFor, effectiveSurfaceQuery, recordPlanOf, recordWindowSlot,
  relatedLists, relationQuery, timelineKeyFor, timelineModeFor, timelineYearFor, visibleNodes,
} from './plan-selection';
import { relatedKey } from './record-markup';
import { boardViewOf, maximumReferenceBoardColumns } from './surface-model';
import { WorkbenchHostError, type ApplicationPlan, type ReadPage, type RecordSnapshot, type SurfaceNodePlan } from './host';

/**
 * Every bounded read the views make, and nothing that draws.
 *
 * A window owns the query it was opened with, because the host hashes the whole
 * query into the cursor scope and refuses a continuation whose scope moved. A
 * page that comes back for a file that has since moved on is discarded rather
 * than shown beside current values.
 */

// Paging resends the window's own query snapshot. Reading the filters back out of
// whichever map the window sits in dropped a declared surface filter at page two:
// the host hashes the whole query into the cursor scope, so an unfiltered
// continuation of a filtered query is either refused or a different set of records.
export async function loadRecordWindow(entityId: string, direction: number, surfaceId: string | null = null): Promise<void> {
  const { windows, key } = recordWindowSlot(entityId, surfaceId);
  const window = windows.get(key);
  if (state.actionInFlight || !window) return;
  const target = pageTarget(window, direction);
  if (target === null) return;
  // Another page drops the selection and redraws, which is the record page's draft gone.
  if (refuseWhileDirty('showing another page of records')) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const page = await client.request<ReadPage<RecordSnapshot>>(
      'data.queryRecords', windowRequest(entityId, window.query, target.cursor));
    if (page.changeSequence !== state.session.manifest?.changeSequence) throw new WorkbenchHostError('stale-cursor', 'The file changed.');
    const cursors = [...window.cursors];
    cursors[target.index] = target.cursor;
    windows.set(key, { page, cursors, index: target.index, query: window.query });
    state.selectedRecordId = null;
    state.creatingRecord = false;
    rerender();
  } catch (error) { await handlePageFailure(error); }
  finally { state.actionInFlight = false; setBusy(false); }
}

export async function loadSurfaceWindow(entityId: string, node: SurfaceNodePlan): Promise<void> {
  if (node.kind === 'extensionGraphSurface') return; // The native host owns its coherent bounded projection.
  const query = effectiveSurfaceQuery(entityId, node);
  const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', windowRequest(entityId, query));
  if (page.changeSequence !== state.session.manifest?.changeSequence)
    throw new WorkbenchHostError('stale-cursor', 'The file changed.');
  surfaceWindows.set(node.semanticId, { page, cursors: [null], index: 0, query });
  surfaceErrors.delete(node.semanticId);
}

/**
 * One bounded page per recent list on the front page. There is no pager: a recent
 * list is the first page of a list's own window and nothing else, so it is read
 * once per change sequence and re-read when the file moves on. A list whose read
 * refuses is left without a window, and the front page states that in place
 * rather than showing another list's records under its heading.
 */
export async function loadRecentWindows(nodes: SurfaceNodePlan[]): Promise<void> {
  for (const node of nodes) {
    const read = recentRead(node);
    if (read === null) continue;
    const key = recentWindowKey(node);
    if (recentWindows.get(key)?.page.changeSequence === state.session.manifest?.changeSequence) continue;
    try {
      const page = await client.request<ReadPage<RecordSnapshot>>(
        'data.queryRecords', windowRequest(read.entityId, read.query, null, read.limit));
      recentWindows.set(key, { page, cursors: [null], index: 0, query: read.query });
      surfaceErrors.delete(node.semanticId);
    } catch (error) {
      recentWindows.delete(key);
      surfaceErrors.set(node.semanticId, messageFor(error));
    }
  }
}

/**
 * One bounded page per ranked list, on the same terms as a recent list: no pager, read
 * once per change sequence, and a refused read leaves the ranking without a window so
 * the front page can state it in place.
 *
 * The window is ordered by the rank field and carries the host's own isNotNull predicate,
 * because a record with no number cannot be ranked against one.
 */
export async function loadRankedWindows(nodes: SurfaceNodePlan[]): Promise<void> {
  for (const node of nodes) {
    const read = rankedRead(node);
    if (read === null) continue;
    const key = rankedWindowKey(node);
    if (rankedWindows.get(key)?.page.changeSequence === state.session.manifest?.changeSequence) continue;
    try {
      const page = await client.request<ReadPage<RecordSnapshot>>(
        'data.queryRecords', windowRequest(read.entityId, read.query, null, read.limit));
      rankedWindows.set(key, { page, cursors: [null], index: 0, query: read.query });
      surfaceErrors.delete(node.semanticId);
    } catch (error) {
      rankedWindows.delete(key);
      surfaceErrors.set(node.semanticId, messageFor(error));
    }
  }
}

/**
 * The columns of one board grouped by a reference: records of the target type, ordered by
 * the reference's label field, read once per change sequence.
 *
 * Every active record of that type is a column, not only the ones something points at. A
 * lane nobody has used yet is an answer -- the same reason an empty cell is a cell and an
 * empty month is a month -- and "the ones in use" could only be computed from this board's
 * own loaded window, which would make the lanes depend on which page is showing.
 *
 * One record past the ceiling is asked for, so the board learns it cannot draw from the
 * read it was making anyway. When it cannot, it draws no columns at all rather than the
 * first twenty-four: a board missing its last lanes looks exactly like a board. Only then
 * is a second, exact count read made, so the statement can name the number rather than say
 * "more than" -- and that read costs nothing in the case that works.
 */
export async function loadBoardColumns(plan: ApplicationPlan, nodes: SurfaceNodePlan[]): Promise<void> {
  for (const node of nodes) {
    const board = boardViewOf(node, plan.entity.fields);
    if (board?.reference == null) continue;
    const { targetEntityId, labelFieldId } = board.reference;
    const known = boardColumns.get(node.semanticId);
    if ((known?.state === 'ready' || known?.state === 'overflowing') &&
      known.changeSequence === state.session.manifest?.changeSequence) continue;
    const query: WindowQuery = { sortFieldId: labelFieldId, descending: false, filters: [] };
    try {
      const page = await client.request<ReadPage<RecordSnapshot>>(
        'data.queryRecords', windowRequest(targetEntityId, query, null, maximumReferenceBoardColumns + 1));
      if (page.items.length > maximumReferenceBoardColumns) {
        let count: number | null = null;
        try {
          count = (await client.request<{ count: number }>(
            'data.countRecords', { entityId: targetEntityId, filters: [] })).count;
        } catch { /* The board refuses either way; only the sentence loses its number. */ }
        boardColumns.set(node.semanticId, {
          state: 'overflowing', changeSequence: page.changeSequence, count,
          ceiling: maximumReferenceBoardColumns,
        });
        continue;
      }
      boardColumns.set(node.semanticId, {
        state: 'ready',
        changeSequence: page.changeSequence,
        // A target whose label is unset still gets a column: it is a record somebody made,
        // and hiding it would move its cards into Ungrouped, which means something else.
        columns: page.items.map((record) => ({
          recordId: record.recordId,
          label: String(record.values[labelFieldId] ?? '').trim() || '(No label)',
          version: record.recordVersion,
        })),
      });
    } catch (error) {
      boardColumns.set(node.semanticId, { state: 'failed', message: messageFor(error) });
    }
  }
}

// The inverse of a reference is an ordinary bounded, filtered record query, so it
// obeys the same cursor and staleness rules as every other read window.
export async function loadRelatedWindows(plan: ApplicationPlan, recordId: string): Promise<void> {
  for (const node of visibleNodes(plan, 'relatedList')) {
    const targetEntityId = node.properties.targetEntityId;
    const viaFieldId = node.properties.viaFieldId;
    if (typeof targetEntityId !== 'string' || typeof viaFieldId !== 'string') continue;
    const key = relatedKey(node, recordId);
    if (relatedWindows.get(key)?.page.changeSequence === state.session.manifest?.changeSequence) continue;
    const query = relationQuery(node, viaFieldId, recordId);
    const page = await client.request<ReadPage<RecordSnapshot>>(
      'data.queryRecords', windowRequest(targetEntityId, query));
    relatedWindows.set(key, { page, cursors: [null], index: 0, query });
  }
}

/**
 * One record read by its own ID, for a record opened from a related row
 * (ADR-0004, 2026-09-18 amendment).
 *
 * A relation is ordered as its author arranged it, over a record type whose own surface
 * is ordered some other way, so the row that was clicked need not be on the page that
 * surface has loaded. Reading it on its own is one bounded read and leaves the surface
 * showing what it was showing; the alternative, narrowing that surface to the one record
 * so it could be found there, would answer a question nobody asked about the surface.
 * <p>
 * A record that is no longer there leaves nothing behind, and the caller stays where it
 * was and says so rather than moving to a page with nothing on it.
 */
export async function loadFocusedRecord(entityId: string, recordId: string): Promise<void> {
  const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', { entityId, recordId, limit: 1 });
  const found = page.items[0];
  if (found === undefined) focusedRecords.delete(recordId);
  else focusedRecords.set(recordId, recordPlanOf(found));
}

/**
 * Whether any relation the open tabs show still owes a read for the current revision.
 *
 * Asked on every draw of a record page, because a relation goes stale for reasons that
 * are not a click: adding a record to it, an agent writing to the record type it reads,
 * or a compensation. The chase that acts on this is bounded, for the reason
 * `read-chase.ts` gives.
 */
export function relatedWindowsPending(plan: ApplicationPlan, recordId: string): boolean {
  return visibleNodes(plan, 'relatedList').some((node) =>
    relatedWindows.get(relatedKey(node, recordId))?.page.changeSequence !== state.session.manifest?.changeSequence);
}

/**
 * Paging a relation uses the same cursor discipline as every other read window: an
 * intervening change invalidates the cursor rather than silently skipping.
 *
 * It reads and does not draw. A relation is read-only content on a page whose form may
 * hold unsaved typing, and this used to redraw the whole page when the next page landed,
 * rebuilding the parent's form from stored values and losing the typing without a word
 * (W-049). The caller patches the relation in place instead, the way a tab change does.
 * True when the page moved and there is something to patch.
 */
export async function loadRelatedWindow(key: string, direction: number): Promise<boolean> {
  const plan = activePlan();
  const window = relatedWindows.get(key);
  if (state.actionInFlight || plan === null || window === undefined || state.selectedRecordId === null) return false;
  const node = relatedLists(plan).find((candidate) => relatedKey(candidate, state.selectedRecordId!) === key);
  if (node === undefined) return false;
  const targetEntityId = node.properties.targetEntityId;
  if (typeof targetEntityId !== 'string') return false;

  const target = pageTarget(window, direction);
  if (target === null) return false;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const page = await client.request<ReadPage<RecordSnapshot>>(
      'data.queryRecords', windowRequest(targetEntityId, window.query, target.cursor));
    if (page.changeSequence !== state.session.manifest?.changeSequence) throw new WorkbenchHostError('stale-cursor', 'The file changed.');
    const cursors = [...window.cursors];
    cursors[target.index] = target.cursor;
    relatedWindows.set(key, { page, cursors, index: target.index, query: window.query });
    return true;
  } catch (error) { showError(messageFor(error)); return false; }
  finally { state.actionInFlight = false; setBusy(false); }
}

/** One bounded page of a calendar month, or of its undated view, appended to what is already loaded. */
export function loadCalendarPage(plan: ApplicationPlan, node: SurfaceNodePlan, append: boolean): Promise<void> {
  return loadAccumulatedPage(plan.entity.semanticId, calendarKeyFor(node),
    calendarQuery(node, calendarModeFor(node.semanticId), calendarMonthFor(node.semanticId)), append);
}

/** One bounded page of a timeline year, or of its undated view, appended to what is already loaded. */
export function loadTimelinePage(plan: ApplicationPlan, node: SurfaceNodePlan, append: boolean): Promise<void> {
  return loadAccumulatedPage(plan.entity.semanticId, timelineKeyFor(node),
    timelineQuery(node, timelineModeFor(node.semanticId), timelineYearFor(node.semanticId)), append);
}

/**
 * One bounded page of a surface that accumulates its pages — a calendar month,
 * a timeline year, or either one's undated view — appended to what is already
 * loaded under its key. The query given is the one a fresh read opens with; a
 * continuation resends the query the accumulator was opened with, so the cursor
 * scope the host hashed still matches. Pages are discarded on a revision change
 * rather than merged, so the surface never mixes two snapshots or shows one
 * record twice.
 */
export async function loadAccumulatedPage(entityId: string, key: string, opening: WindowQuery, append: boolean): Promise<void> {
  const sequence = state.session.manifest?.changeSequence ?? -1;
  const fileSessionId = state.session.fileSessionId;
  const existing = accumulatedWindows.get(key);
  const fresh = !append || existing === undefined || existing.changeSequence !== sequence;
  const query = fresh ? opening : existing!.query;
  const cursor = fresh ? null : existing!.cursor;
  if (!fresh && cursor === null) return;
  accumulatedWindows.set(key, {
    items: fresh ? [] : existing!.items,
    cursor,
    changeSequence: sequence,
    query,
    loading: true,
    failure: null,
  });
  try {
    const page = await client.request<ReadPage<RecordSnapshot>>(
      'data.queryRecords', windowRequest(entityId, query, cursor));
    // A page from another revision belongs to another snapshot of the range.
    if (state.session.fileSessionId !== fileSessionId || page.changeSequence !== sequence) {
      accumulatedWindows.delete(key);
      throw new WorkbenchHostError('stale-cursor', 'The file changed.');
    }
    const carried = accumulatedWindows.get(key);
    if (carried === undefined || carried.changeSequence !== sequence) return;
    accumulatedWindows.set(key, {
      items: [...carried.items, ...page.items],
      cursor: page.nextCursor,
      changeSequence: sequence,
      query,
      loading: false,
      failure: null,
    });
  } catch (error) {
    accumulatedWindows.set(key, {
      items: fresh ? [] : existing!.items,
      cursor,
      changeSequence: sequence,
      query,
      loading: false,
      failure: messageFor(error),
    });
    throw error;
  }
}

/**
 * The surface's own pager. A relation's pager is wired by the record page
 * (`wireRelatedPager` in `record-form.ts`), because what it does after the read is patch
 * that page in place, and this module cannot know the page.
 */
export function wireRecordPager(): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-record-page]'))
    button.addEventListener('click', () => void loadRecordWindow(
      button.dataset.pageEntity!, Number(button.dataset.recordPage), button.dataset.pageSurface ?? null));
}
