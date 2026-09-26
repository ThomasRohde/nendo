import type { SurfaceNodePlan } from './host';

// Pure query composition and window-request construction. A read window owns the
// query it was opened with, from page one onward: paging must resend exactly the
// arguments the first page used, or the cursor scope the host hashed no longer
// matches and the continuation is refused as invalid. Recomputing the filters at
// page two — or inferring their presence from which map the window sits in — is
// how a declared filter came to be dropped between pages.

export interface QueryFilter { fieldId: string; operator: string; value?: unknown }

/** The immutable query snapshot a window carries. An unfiltered window has an empty one. */
export interface WindowQuery {
  filters: QueryFilter[];
  sortFieldId?: string;
  descending?: boolean;
}

/** The one defined default for a window that declares nothing. */
export function emptyWindowQuery(): WindowQuery {
  return { filters: [] };
}

/** A window declares something when it narrows or orders the records it shows. */
export function hasWindowQuery(query: WindowQuery): boolean {
  return query.filters.length > 0 || query.sortFieldId !== undefined;
}

export interface ReadWindow<TPage> {
  page: TPage;
  cursors: Array<string | null>;
  index: number;
  /** Frozen at page one and resent verbatim on every continuation. */
  query: WindowQuery;
}

// The durable contract spells two comparisons differently from the record query.
export function queryOperatorFor(contractOperator: string): string {
  return contractOperator === 'lte' ? 'le' : contractOperator === 'gte' ? 'ge' : contractOperator;
}

/**
 * What a clause compares against, which is not always written down.
 *
 * `valueKind` is a closed vocabulary — `literal`, `today`, `now`, `null` — and only a
 * literal carries its value in the definition. `today` and `now` are resolved when the
 * query is built, which is the whole point of them: a definition written in January must
 * not still mean January in December, so it stores the word and not the date.
 *
 * This read the `value` property and nothing else, so a clause saying `today` sent no
 * value at all and the host refused the whole read with *Use isNull or isNotNull to query
 * missing values.* The tile then said Unavailable for ever, and — because a refused tile
 * used to count as still pending — the page rebuilt itself once a second behind it. One
 * unresolved word cost a filter kind, a tile, and the stillness of every screen it was on.
 *
 * Today is the person's civil date, not UTC's: a tile that says what is overdue has to
 * agree with the calendar on their wall. A Date field compares against that date,
 * `2026-09-26`. A DateTime field compares against the instant that date begins where the
 * person is, written with its offset, `2026-09-26T00:00:00+02:00`: the host refuses a
 * timestamp without an explicit zone, so the bare date refused every DateTime `today` read
 * (R-003). On a day that skips its midnight the day begins at the first local time it has.
 * `storageKind` is the field's stored kind by name (`date`, `dateTime`); unknown, a date.
 *
 * Exported for the custom-view client (extension-api/nendo-api.ts), which resolves a view's
 * authored filters when the view reads rather than when it started: a view left open past
 * midnight must not keep asking for yesterday.
 */
export function resolveClauseValue(valueKind: unknown, value: unknown, at: Date = new Date(), storageKind?: string): unknown {
  switch (valueKind) {
    case 'today':
      return storageKind === 'dateTime' ? startOfCivilDay(at) : civilDate(at);
    case 'now':
      return at.toISOString().replace(/\.\d+Z$/, 'Z');
    default:
      return value;
  }
}

const two = (value: number): string => String(value).padStart(2, '0');

/** The person's own date at `at`, as yyyy-MM-dd. */
function civilDate(at: Date): string {
  return `${String(at.getFullYear()).padStart(4, '0')}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** The instant the person's civil day of `at` begins, as an ISO timestamp with its local offset. */
function startOfCivilDay(at: Date): string {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const offset = -start.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const minutes = Math.abs(offset);
  return `${civilDate(start)}T${two(start.getHours())}:${two(start.getMinutes())}:${two(start.getSeconds())}${sign}${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
}

/**
 * Which stored kind a field has, by field ID, so that `today` resolves to a date or an
 * instant. The Workbench registers its session's fields once (main.ts); field IDs are unique
 * across the file. Until then every field reads as a Date.
 */
let fieldKinds: (fieldId: string) => string | undefined = () => undefined;

export function useFieldKinds(kinds: (fieldId: string) => string | undefined): void {
  fieldKinds = kinds;
}

function clauseValue(fieldId: string, properties: Record<string, unknown>, at: Date): unknown {
  return resolveClauseValue(properties.valueKind, properties.value, at, properties.valueKind === 'today' ? fieldKinds(fieldId) : undefined);
}

/** The ANDed filter clauses declared directly on one node. */
export function clauseFilters(node: SurfaceNodePlan, at: Date = new Date()): QueryFilter[] {
  return node.children
    .filter((child) => child.kind === 'filterClause')
    .map((child) => {
      const fieldId = child.properties.fieldId;
      const operator = child.properties.operator;
      if (typeof fieldId !== 'string' || typeof operator !== 'string') return null;
      const queryOperator = queryOperatorFor(operator);
      return operator === 'isNull' || operator === 'isNotNull'
        ? { fieldId, operator: queryOperator }
        : { fieldId, operator: queryOperator, value: clauseValue(fieldId, child.properties, at) };
    })
    .filter((clause): clause is QueryFilter => clause !== null);
}

/**
 * The query one surface, board, related list or calendar root declares. Always a
 * query: a root that narrows nothing still owns an explicit empty one rather than
 * leaving the caller to decide what absence means.
 */
export function declaredQuery(node: SurfaceNodePlan): WindowQuery {
  const sortFieldId = typeof node.properties.orderByFieldId === 'string' ? node.properties.orderByFieldId : undefined;
  const descending = node.properties.orderDirection === 'descending' ? true : undefined;
  return { filters: clauseFilters(node), sortFieldId, descending };
}

export interface WindowRequest {
  entityId: string;
  limit: number;
  cursor?: string | null;
  filters: QueryFilter[];
  sortFieldId?: string;
  descending?: boolean;
  /** The host adapter takes a plain payload map. */
  [key: string]: unknown;
}

/** The host payload for one page of a window, built from the window's own query. */
export function windowRequest(
  entityId: string,
  query: WindowQuery,
  cursor: string | null = null,
  limit = 50,
): WindowRequest {
  return {
    entityId,
    limit,
    cursor,
    filters: query.filters,
    sortFieldId: query.sortFieldId,
    descending: query.descending,
  };
}

/**
 * Where a Previous/Next step lands, or null when the step is not available. The
 * cursor for a forward step is the page's own continuation; a backward step
 * replays the cursor that opened that page.
 */
export function pageTarget<TPage extends { nextCursor: string | null }>(
  window: ReadWindow<TPage>,
  direction: number,
): { index: number; cursor: string | null } | null {
  const index = window.index + direction;
  if (index < 0) return null;
  if (direction > 0 && window.page.nextCursor === null) return null;
  const cursor = direction > 0 ? window.page.nextCursor : window.cursors[index] ?? null;
  return { index, cursor };
}

/**
 * A cache key over a structured tuple. Concatenating identifiers with a delimiter
 * cannot tell a missing group from the literal text of one, and an identifier
 * containing the delimiter collides with a different tuple.
 */
export function cacheKey(parts: ReadonlyArray<string | number | boolean | null>): string {
  return JSON.stringify(parts);
}

/**
 * Run an async step over every item with at most `limit` in flight. A board with
 * a tile in each of a dozen columns would otherwise open a dozen simultaneous
 * exact reads against one file. Each step handles its own failure, so one
 * refusing read does not abandon the rest.
 */
export async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  step: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await step(next);
  });
  await Promise.all(workers);
}
