import type { StudioQuery } from './app-state';

/**
 * Studio data's columns: how wide the person made each one, and which one the records are
 * sorted by. Pure, so the rules are tested without a grid.
 *
 * A width is the person's own view of the table, kept for this device the way a section's
 * fold is (fold-state.ts): keyed by the file's application ID and the record type, and
 * never written into the file. A sort is a query the host answers over every record of the
 * type, never a reorder of the page that happens to be loaded.
 */

export type ColumnWidths = Record<string, number>;
export type SortDirection = 'asc' | 'desc';

const smallest = 48;
const widest = 2000;

export function columnWidthsKey(applicationId: string): string {
  return `nendo.studioColumns.${applicationId}`;
}

function storedTypes(storage: Pick<Storage, 'getItem'>, applicationId: string): Record<string, ColumnWidths> {
  const types: Record<string, ColumnWidths> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(columnWidthsKey(applicationId)) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return types;
    for (const [entityId, columns] of Object.entries(parsed)) {
      if (columns === null || typeof columns !== 'object' || Array.isArray(columns)) continue;
      const widths: ColumnWidths = {};
      for (const [columnId, width] of Object.entries(columns))
        if (typeof width === 'number' && Number.isFinite(width)) widths[columnId] = clampWidth(width);
      types[entityId] = widths;
    }
  } catch {
    // Storage that refuses to answer, or holds something else, leaves the default widths.
  }
  return types;
}

export function clampWidth(width: number): number {
  return Math.min(widest, Math.max(smallest, Math.round(width)));
}

/** The widths this device remembers for one record type of one file. */
export function rememberedWidths(storage: Pick<Storage, 'getItem'>, applicationId: string, entityId: string): ColumnWidths {
  return storedTypes(storage, applicationId)[entityId] ?? {};
}

/** Record the columns the person just resized, and return that type's whole set. */
export function rememberWidths(storage: Pick<Storage, 'getItem' | 'setItem'>, applicationId: string, entityId: string, changed: ColumnWidths): ColumnWidths {
  const types = storedTypes(storage, applicationId);
  const widths = { ...types[entityId] };
  for (const [columnId, width] of Object.entries(changed)) widths[columnId] = clampWidth(width);
  types[entityId] = widths;
  try {
    storage.setItem(columnWidthsKey(applicationId), JSON.stringify(types));
  } catch {
    // The widths still hold for this session when device persistence is unavailable.
  }
  return widths;
}

/** Forget one record type's widths, so its columns size themselves again. */
export function forgetWidths(storage: Pick<Storage, 'getItem' | 'setItem'>, applicationId: string, entityId: string): void {
  const types = storedTypes(storage, applicationId);
  delete types[entityId];
  try { storage.setItem(columnWidthsKey(applicationId), JSON.stringify(types)); } catch { /* Nothing to keep. */ }
}

/** The direction a column is sorted in by this query, if it is the sort column. */
export function sortOf(query: StudioQuery | undefined, columnId: string): SortDirection | null {
  return query?.sortFieldId === columnId ? (query.descending ? 'desc' : 'asc') : null;
}

/** A header click: ascending, then descending, then back to record order. */
export function nextSort(query: StudioQuery | undefined, columnId: string): { sortFieldId: string | null; descending: boolean } {
  const current = sortOf(query, columnId);
  return current === null ? { sortFieldId: columnId, descending: false }
    : current === 'asc' ? { sortFieldId: columnId, descending: true }
      : { sortFieldId: null, descending: false };
}

/**
 * The query with a new sort and the same filter. A query that neither sorts nor filters is no
 * query at all, so the table goes back to plain browsing.
 */
export function withSort(query: StudioQuery | undefined, sort: { sortFieldId: string | null; descending: boolean }): StudioQuery | null {
  const filters = query?.filters ?? [];
  if (sort.sortFieldId === null && filters.length === 0) return null;
  return {
    fieldId: query?.fieldId ?? '', operator: query?.operator ?? 'contains', text: query?.text ?? '', filters,
    sortFieldId: sort.sortFieldId, descending: sort.sortFieldId !== null && sort.descending,
  };
}

/** The query with a new filter and the same sort. */
export function withFilter(query: StudioQuery | undefined, filter: Pick<StudioQuery, 'fieldId' | 'operator' | 'text' | 'filters'>): StudioQuery | null {
  const sortFieldId = query?.sortFieldId ?? null;
  if (sortFieldId === null && filter.filters.length === 0) return null;
  return { ...filter, sortFieldId, descending: sortFieldId !== null && query?.descending === true };
}

const operatorWords: Readonly<Record<string, string>> = {
  contains: 'contains', eq: 'is', ne: 'is not', lt: 'is less than', le: 'is at most', gt: 'is greater than', ge: 'is at least',
  isNull: 'is not set', isNotNull: 'has a value',
};

/** One sentence that says what the table is showing, or nothing when it shows every record in record order. */
export function queryStatusText(query: StudioQuery | undefined, nameOf: (fieldId: string) => string): string {
  if (query === undefined) return '';
  const parts: string[] = [];
  if (query.sortFieldId !== null) parts.push(`Sorted by ${nameOf(query.sortFieldId)}, ${query.descending ? 'descending' : 'ascending'}`);
  for (const filter of query.filters) {
    const words = operatorWords[filter.operator] ?? filter.operator;
    parts.push(`Only where ${nameOf(filter.fieldId)} ${words}${'value' in filter ? ` ${String(filter.value)}` : ''}`);
  }
  return parts.length === 0 ? '' : `${parts.join(' · ')} · across every record of this type`;
}
