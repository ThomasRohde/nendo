import { fileCapabilities, type AgentProposalPreview, type AgentStatus, type CompileResult, type DesktopSessionView, type ProposalPreview, type ReadPage, type RecentFiles, type RecordPlan, type RecordSnapshot, type RevisionSummary } from './host';
import type { BucketResult, CellResult, GroupedResult } from './charts';
import type { CalendarMode, CivilMonth } from './calendar-model';
import { cacheKey, type ReadWindow, type WindowQuery } from './record-window';
import type { DraftSession } from './draft-state';

/**
 * Everything the renderer remembers about the open file, in one place.
 *
 * It lives in its own module because every view and every action reads and writes
 * it, and because a view that owned part of it would have to be imported by
 * whatever else needed that part. Nothing here imports a view, so nothing can
 * cycle back through it. None of it reaches the file: this is what is on screen,
 * not what is stored.
 */

export type ViewName = 'use' | 'data' | 'structure' | 'surfaces' | 'history' | 'health' | 'agent' | 'proposal' | 'agentProposal' | 'help';

// A window owns the query it was opened with. Paging resends exactly those
// arguments, because the host hashes the whole query into the cursor scope and
// refuses a continuation whose scope moved.
export type RecordWindow = ReadWindow<ReadPage<RecordSnapshot>>;
// One bounded page per related list, keyed by the record it is shown for. The
// inverse of a reference is an ordinary filtered query, so the existing cursor
// and staleness rules apply unchanged.
export type RelatedWindow = RecordWindow;
// A tile counts the whole filtered set, not the page in view, so it is its own
// exact read rather than a length taken from a loaded window. Loading, empty and
// failed are distinct states: a count of zero is a real zero, an aggregate over
// no contributing records is empty, and a refused read is neither.
export type SummaryState =
  | { state: 'loading' }
  | { state: 'ready'; value: string | null; changeSequence: number }
  | { state: 'failed'; code: string; message: string };
// A chart is its own exact read, or two for a ring. Loading, ready and failed are
// distinct, and an answer captured under an older generation is discarded.
export type ChartOutcome =
  | { state: 'loading' }
  | { state: 'ready'; changeSequence: number; grouped?: GroupedResult; bucketed?: BucketResult; cells?: CellResult; numerator?: string | null; denominator?: string | null }
  | { state: 'failed'; code: string; message: string };
/**
 * One column of a board grouped by a reference: the target record's ID, the label that
 * heads the column, and the version a drag must carry.
 *
 * The version is here because a reference write is refused without the target's current
 * version, where a choice literal needs none. The board has read the target type to draw
 * the columns at all, so it is carrying the answer already.
 */
export interface BoardColumn { recordId: string; label: string; version: number }
/**
 * What a reference board knows about its own columns.
 *
 * `overflowing` is the ceiling, and it draws no columns at all rather than the first
 * few: a board missing its last lanes looks exactly like a board. It carries the exact
 * count, read separately once the page read has already shown there are too many, so the
 * statement names a number rather than "more than".
 */
export type BoardColumnsState =
  | { state: 'loading' }
  | { state: 'ready'; changeSequence: number; columns: BoardColumn[] }
  | { state: 'overflowing'; changeSequence: number; count: number | null; ceiling: number }
  | { state: 'failed'; message: string };
// A drill narrows one list to one group. Renderer state per record type; it never
// reaches the file, and it is cleared with the rest of the view on a file switch.
export type DrillFilter = WindowQuery['filters'][number];
export interface DrillState { listId: string; label: string; filters: DrillFilter[] }
export type StudioQuery = { sortFieldId: string | null; descending: boolean; fieldId: string; operator: string; text: string; filters: Array<{ fieldId: string; operator: string; value?: unknown }> };
/**
 * A calendar or a timeline accumulates bounded pages until its cursor is
 * exhausted, because a month or a year is not a page: fifty records is one page
 * and April can hold more. What a day or a month shows is only what has been
 * loaded, so the accumulator states whether the range is complete rather than
 * letting an unread day read as an empty one.
 */
export interface PageAccumulator {
  items: RecordSnapshot[];
  cursor: string | null;
  changeSequence: number;
  query: WindowQuery;
  loading: boolean;
  failure: string | null;
}
export interface HistoryWindow { page: ReadPage<RevisionSummary>; cursors: Array<string | null>; index: number }
/**
 * The form currently on screen and what the user has typed into it.
 *
 * It lives here rather than inside the form's own wiring because the question it
 * answers — is this typing still savable? — is asked from outside, when the session
 * is re-read after a save whose outcome was not settled. The draft exists exactly as
 * long as the DOM that holds it, so `render` clears it and `wireRecordForm` sets it.
 */
export interface OpenDraft { session: DraftSession; edited: Set<string> }

/**
 * The related record being added, and the record it will point back at
 * (ADR-0004, 2026-09-18 amendment).
 *
 * The reference back is filled in before the form is shown, so the parent's version
 * travels with it: a non-null reference write is refused without the target's current
 * version, and the record it points at is the one on screen, so nothing has to be read
 * to learn it. The label travels too, because a reference nobody has picked in a picker
 * would otherwise show the stable ID, which names nothing to a reader.
 * <p>
 * Setting this does not clear `selectedRecordId`: the record the relation belongs to is
 * still the record in view, so closing the form or saving returns to it rather than to an
 * empty pane.
 */
export interface CreateRelated {
  targetEntityId: string;
  viaFieldId: string;
  parentRecordId: string;
  parentVersion: number;
  parentLabel: string;
}

/**
 * The record a related row was opened from, so there is one step back to it.
 *
 * One step, not a history. Opening a third record replaces this rather than stacking
 * behind it: a trail nobody asked to keep is state that only accumulates. It is renderer
 * state in the sense a drill or a selected surface is — it never reaches the file, and it
 * is cleared with the rest of the view whenever the record context is left.
 */
export interface ReturnTo { entityId: string; recordId: string; label: string }

/**
 * An outcome kept across redraws: on which view, in what words, in which tone, and,
 * when the view could not be read after the outcome, the refresh that would read it.
 * A refusal is one too, in the alert tone and without a refresh, released by the
 * person's next touch (W-054).
 */
export interface OutcomeNotice {
  view: string;
  message: string;
  tone: 'done' | 'alert';
  refresh?: (button: HTMLButtonElement) => Promise<void>;
}

export function emptySession(): DesktopSessionView {
  return {
    fileSessionId: null,
    capabilities: fileCapabilities(false),
    findings: [],
    hasFile: false,
    fileName: null,
    health: 'noFile',
    manifest: null,
    entities: [],
    records: [],
    uiNodes: [],
    storage: null,
  };
}

export interface AppState {
  session: DesktopSessionView;
  compilation: CompileResult | null;
  history: RevisionSummary[];
  // Bumped whenever what the tiles cover changes. A response captured under an
  // older generation is discarded rather than written over the current view.
  summaryGeneration: number;
  chartGeneration: number;
  historyWindow: HistoryWindow | null;
  proposal: ProposalPreview | null;
  agentStatus: AgentStatus | null;
  agentProposal: AgentProposalPreview | null;
  agentScreenPreview: ProposalPreview | null;
  view: ViewName;
  proposalReturnView: ViewName;
  selectedRecordId: string | null;
  showRetiredData: boolean;
  selectedEntityId: string | null;
  selectedApplicationEntity: string | null;
  /**
   * Whether Use is showing the file's front page rather than a record type.
   * Renderer state per open file, like the selected surface: it never reaches the
   * .nendo file, and it is cleared with the rest of the view on a file switch.
   * <p>
   * Null means no choice has been made for the file that is open, and the answer
   * is settled once its definition arrives: a file with a front page opens on it.
   * It is settled there rather than lazily, so accepting a proposal that adds one
   * never moves a person off the screen they were reading.
   */
  showOverview: boolean | null;
  creatingRecord: boolean;
  /** A record being added from a related list, or null when none is. */
  createRelated: CreateRelated | null;
  /** Where to go back to after opening a related row, or null when nothing was opened. */
  returnTo: ReturnTo | null;
  actionInFlight: boolean;
  recentFiles: RecentFiles;
  openDraft: OpenDraft | null;
  /** Which Help topic is open, and what is typed in its search box. */
  /**
   * What the last thing a person did came to, kept until they do the next thing.
   *
   * A message written straight into the content pane is destroyed by the next redraw,
   * and screens redraw on their own account now — so an outcome could be on screen for
   * a fraction of a second or not at all, depending on what else was reading. The
   * notice that something finished but the view could not be read afterwards is one of
   * these too, and it carries the Refresh view button that answers it.
   */
  lastOutcome: OutcomeNotice | null;
  helpTopicId: string;
  helpQuery: string;
}

export const state: AppState = {
  session: emptySession(),
  compilation: null,
  history: [],
  summaryGeneration: 0,
  chartGeneration: 0,
  historyWindow: null,
  proposal: null,
  agentStatus: null,
  agentProposal: null,
  agentScreenPreview: null,
  view: 'data',
  proposalReturnView: 'structure',
  selectedRecordId: null,
  showRetiredData: false,
  selectedEntityId: null,
  selectedApplicationEntity: null,
  showOverview: null,
  creatingRecord: false,
  createRelated: null,
  returnTo: null,
  actionInFlight: false,
  recentFiles: { files: [], notice: null },
  openDraft: null,
  lastOutcome: null,
  helpTopicId: 'start',
  helpQuery: '',
};

/**
 * Everything below belongs to the file that is open, and is emptied when another one is.
 *
 * Declared through this rather than as plain maps because the rule was already being
 * missed. resetFileView cleared the caches that existed when it was written and then four
 * more arrived -- the matrix reads, the ranked and recent windows, and a reference
 * board's columns -- each keyed by a node ID that another file could also carry. Listing
 * them in a second place meant remembering a second place. A map made here registers
 * itself, so forgetting is no longer possible.
 */
const fileScoped: Array<{ clear(): void }> = [];

function fileScopedMap<K, V>(): Map<K, V> {
  const map = new Map<K, V>();
  fileScoped.push(map);
  return map;
}

function fileScopedSet<T>(): Set<T> {
  const set = new Set<T>();
  fileScoped.push(set);
  return set;
}

/**
 * Register something that is not a map or a set but still belongs to the open file.
 *
 * The navigation trail is the first of these: it is a ring with a cursor rather than a
 * cache, and it has to be emptied on a file switch for the same reason every cache here
 * does -- the places in it name a file that is no longer open. It is exported so the
 * trail can register itself where it is declared, which is the whole point of this list.
 */
export function fileScopedClearable<T extends { clear(): void }>(value: T): T {
  fileScoped.push(value);
  return value;
}

/** Empty every cache that belongs to the file being closed. */
export function clearFileScoped(): void {
  for (const cache of fileScoped) cache.clear();
}

export const recordWindows = fileScopedMap<string, RecordWindow>();
export const relatedWindows = fileScopedMap<string, RelatedWindow>();
export const summaryCounts = fileScopedMap<string, SummaryState>();
export const chartStates = fileScopedMap<string, ChartOutcome>();
// One crossed read per matrix surface, keyed by its stable semantic ID. It is the
// surface's own number rather than a tile's, so it is not in chartStates: the cards in
// a cell are the loaded window and the number beside them covers everything the surface
// shows, and the cell states both.
export const matrixCells = fileScopedMap<string, ChartOutcome>();
// One window per ranked list on the front page, and one exact maximum per ranking, which
// every bar is drawn against.
export const rankedWindows = fileScopedMap<string, RecordWindow>();
// The columns of each board grouped by a reference, keyed by the board's semantic ID.
// They are records of another record type rather than a field's options, so they are read
// rather than taken from the definition, and the board cannot draw until they arrive.
export const boardColumns = fileScopedMap<string, BoardColumnsState>();
// Which charts show their table of numbers. Renderer state, per chart.
export const chartTables = fileScopedSet<string>();
export const drills = fileScopedMap<string, DrillState>();
export const studioQueries = fileScopedMap<string, StudioQuery>();
export const studioWindows = fileScopedMap<string, RecordWindow>();
// A version 3 list, board or calendar declares its own query, so each gets its
// own window, keyed by its stable semantic ID. Keying by entity could hold one
// window per record type, which is why two lists on one entity shared a page.
export const surfaceWindows = fileScopedMap<string, RecordWindow>();
// One remembered surface per record type, for the file that is open. A global
// board/list mode could address only the first root of each kind, so seven of
// eight lists on an entity had no way to be shown at all.
export const selectedSurfaces = fileScopedMap<string, string>();
// One window per recent list on the front page, keyed by the node and its limit.
// Separate from the surface windows because a recent list has no pager and no
// selection: it is one bounded page, re-read when the file moves on.
export const recentWindows = fileScopedMap<string, RecordWindow>();
// One record read on its own, because it was opened from a related row rather than
// chosen from a list. A relation shows records of another type under its own order, so
// the one that was clicked need not be on the first page of whichever surface that type
// opens on — and narrowing that surface to the one record, to make it findable there,
// would answer a question nobody asked about the surface. Keyed by record ID, and read
// again when the file moves on, like every other window here.
export const focusedRecords = fileScopedMap<string, RecordPlan>();
// A surface whose own read refused states it in place, rather than showing the
// records of whichever surface was loaded before.
export const surfaceErrors = fileScopedMap<string, string>();
// Which tab is open, per file, record type, page and group. Which tab someone
// last looked at is not part of the application, so it never reaches the file.
export const selectedTabs = fileScopedMap<string, string>();
// Which sections the person has folded or opened, per file. How a section starts is
// the author's and stored; what was done with it since is not (ADR-0004, 2026-09-20).
export const sectionFolds = fileScopedMap<string, 'open' | 'closed'>();
// Which month and view each calendar surface is showing, and which year and
// view each timeline surface is showing, for the open file.
export const calendarMonths = fileScopedMap<string, CivilMonth>();
export const calendarModes = fileScopedMap<string, CalendarMode>();
export const timelineYears = fileScopedMap<string, number>();
export const timelineModes = fileScopedMap<string, CalendarMode>();
// The pages a calendar or a timeline has accumulated, under the namespaced
// window key each surface builds for its range and mode.
export const accumulatedWindows = fileScopedMap<string, PageAccumulator>();

/** Which tab is open, per file, record type, page and group. */
export function tabStateKey(entityId: string, pageId: string, groupId: string): string {
  return cacheKey([state.session.fileSessionId ?? '', entityId, pageId, groupId]);
}
/**
 * Leaving the record in view. Switching surface and switching record type do the
 * same thing here, so an unsaved inspector is handled one way rather than two.
 */
export function leaveRecordContext(): void {
  state.selectedRecordId = null;
  state.creatingRecord = false;
  // A half-filled related record and a way back both belong to the record being left.
  // Carrying either into another surface would offer a return to a page nobody is on.
  state.createRelated = null;
  state.returnTo = null;
}

