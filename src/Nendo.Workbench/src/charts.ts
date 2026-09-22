import type { FieldPlan, RecordPlan, SurfaceNodePlan } from './host';
import { clauseFilters, type QueryFilter } from './record-window';
import { declaredScope, tileEntityId, tileFilters, tileKey, tileScopeLabel, type TileScope } from './summary-tiles';
import { choiceStyle } from './tones';
import { proportionOf, type ChartSegment } from './chart-kit';
import { exactNumberText } from './scalars';

// Pure composition for the first charts (ADR-0004, 2026-09-14 amendment, S1). A
// breakdown chart and a progress ring are tiles in the sense a summary tile is:
// they sit where it sits, they are scoped as it is scoped, and their reads compose
// from the same filters. What is theirs is the grouping, which is not a filter,
// and the two counts a ring is drawn from.

export const chartKinds = ['breakdownChart', 'progressTile', 'trendChart', 'activityGrid'] as const;

/** The two kinds whose groups are civil-date buckets (ADR-0004, 2026-09-16 amendment, S5). */
export function isOverTimeKind(kind: string): boolean {
  return kind === 'trendChart' || kind === 'activityGrid';
}

export function isChartKind(kind: string): boolean {
  return (chartKinds as readonly string[]).includes(kind);
}

export interface ScopedChart { node: SurfaceNodePlan; scope: TileScope }

const property = (node: SurfaceNodePlan, key: string): string | null =>
  typeof node.properties[key] === 'string' ? (node.properties[key] as string) : null;

const directCharts = (node: SurfaceNodePlan): SurfaceNodePlan[] =>
  node.children.filter((child) => isChartKind(child.kind));

/** Charts that cover the whole selected surface, in declared order. */
export function surfaceScopedCharts(surface: SurfaceNodePlan | null): SurfaceNodePlan[] {
  return surface === null ? [] : directCharts(surface).filter((chart) => declaredScope(chart) === 'surface');
}

/** Charts that cover one board column; only a direct child of a board may declare it. */
export function groupScopedCharts(surface: SurfaceNodePlan | null): SurfaceNodePlan[] {
  return surface === null || surface.kind !== 'boardSurface'
    ? []
    : directCharts(surface).filter((chart) => declaredScope(chart) === 'group');
}

/** Charts anywhere on a record page, each with the scope it covers. */
export function pageScopedCharts(page: SurfaceNodePlan | null, recordId: string): ScopedChart[] {
  if (page === null) return [];
  const walk = (nodes: SurfaceNodePlan[], relation: SurfaceNodePlan | null): ScopedChart[] =>
    nodes.flatMap((node) => isChartKind(node.kind)
      ? [{ node, scope: relation === null ? { kind: 'page' } as TileScope : { kind: 'relation', recordId, relation } }]
      : walk(node.children, node.kind === 'relatedList' ? node : relation));
  return walk(page.children, null);
}

/** One chart's cache identity: the same tuple a tile uses, over its own node. */
export const chartKey = tileKey;

/** One grouped read: the record type, the grouping, the aggregate and the effective filters. */
export interface GroupedRead {
  entityId: string;
  groupByFieldId: string;
  aggregate: string;
  fieldId: string | null;
  filters: QueryFilter[];
}

export function breakdownRead(node: SurfaceNodePlan, scope: TileScope, surfaceEntityId: string | null): GroupedRead | null {
  const entityId = tileEntityId(scope, surfaceEntityId);
  const groupByFieldId = property(node, 'groupByFieldId');
  if (entityId === null || groupByFieldId === null) return null;
  if (scope.kind === 'relation' && property(scope.relation, 'viaFieldId') === null) return null;
  const aggregate = property(node, 'aggregate') ?? 'count';
  return {
    entityId,
    groupByFieldId,
    aggregate,
    fieldId: aggregate === 'count' ? null : property(node, 'fieldId'),
    filters: tileFilters(node, scope),
  };
}

/** One read over civil-date buckets: the record type, the date field, the closed words and the filters. */
export interface BucketRead {
  entityId: string;
  dateFieldId: string;
  bucket: string;
  range: string;
  aggregate: string;
  fieldId: string | null;
  filters: QueryFilter[];
}

/**
 * An activity grid counts days and declares no bucket or aggregate, because a square
 * toned by a sum is a heat map of a number nobody can read back off it. Both are
 * supplied here rather than stored, so the node carries only what an author chose.
 */
export function bucketRead(node: SurfaceNodePlan, scope: TileScope, surfaceEntityId: string | null): BucketRead | null {
  const entityId = tileEntityId(scope, surfaceEntityId);
  const dateFieldId = property(node, 'dateFieldId');
  const range = property(node, 'range');
  if (entityId === null || dateFieldId === null || range === null) return null;
  if (scope.kind === 'relation' && property(scope.relation, 'viaFieldId') === null) return null;
  const grid = node.kind === 'activityGrid';
  const aggregate = grid ? 'count' : property(node, 'aggregate') ?? 'count';
  return {
    entityId,
    dateFieldId,
    bucket: grid ? 'day' : property(node, 'bucket') ?? 'month',
    range,
    aggregate,
    fieldId: aggregate === 'count' ? null : property(node, 'fieldId'),
    filters: tileFilters(node, scope),
  };
}

/** The host's answer to a bucketed read: every bucket of the range, and the bounds it resolved to. */
export interface BucketResult {
  groups: Array<{ key: string | null; valueLexeme: string | null; contributingRecords: number }>;
  start: string;
  end: string;
  changeSequence: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A bucket's own dates, from its key. A month key is a month; a week key is its Monday. */
export function bucketSpan(bucket: string, key: string): { start: string; end: string } {
  if (bucket === 'month') {
    const [year, month] = key.split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${key}-01`, end: `${key}-${String(last).padStart(2, '0')}` };
  }
  if (bucket === 'week') {
    const monday = new Date(`${key}T00:00:00Z`);
    const sunday = new Date(monday.getTime() + 6 * 86_400_000);
    return { start: key, end: sunday.toISOString().slice(0, 10) };
  }
  return { start: key, end: key };
}

/** What a bucket is called on the axis: short enough to repeat twelve times without wrapping. */
export function bucketLabel(bucket: string, key: string | null): string {
  if (key === null) return 'Not set';
  const [year, month, day] = key.split('-').map(Number);
  if (bucket === 'month') return `${MONTHS[month - 1]} ${year}`;
  if (bucket === 'week') return `${day} ${MONTHS[month - 1]}`;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/**
 * The columns of a trend, in the host's order, every bucket of the range present. An
 * empty bucket keeps a null lexeme and a zero proportion, so it draws as a gap at zero
 * rather than being left out — the chart shows the shape of the range, not of the data.
 */
export function bucketSegments(bucket: string, result: BucketResult): ChartSegment[] {
  return result.groups.map((group) => ({
    key: group.key,
    label: bucketLabel(bucket, group.key),
    lexeme: group.valueLexeme,
    amount: proportionOf(group.valueLexeme),
    style: '',
  }));
}

/**
 * How dark one square of an activity grid is, from zero to four, the way a contribution
 * graph reads. Zero is its own step rather than the bottom of the scale, so a quiet day
 * is visibly quiet and not merely the palest active one.
 */
export function activityLevel(lexeme: string | null, busiest: number): number {
  const value = lexeme === null ? 0 : Number(lexeme);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (busiest <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / busiest) * 4)));
}

/** The busiest bucket, which every other square is toned against. */
export function busiestBucket(result: BucketResult): number {
  return result.groups.reduce((most, group) => {
    const value = group.valueLexeme === null ? 0 : Number(group.valueLexeme);
    return Number.isFinite(value) && value > most ? value : most;
  }, 0);
}

/** A bucket drills into its own two bounds, which is the one place a drill needs two clauses. */
export function bucketDrillFilters(node: SurfaceNodePlan, bucket: string, key: string | null): QueryFilter[] {
  const dateFieldId = property(node, 'dateFieldId');
  if (dateFieldId === null || key === null) return [];
  const span = bucketSpan(bucket, key);
  return [
    { fieldId: dateFieldId, operator: 'gte', value: span.start },
    { fieldId: dateFieldId, operator: 'lte', value: span.end },
  ];
}

/** One read over two crossed groupings: the record type, both axes and the effective filters. */
export interface CellRead {
  entityId: string;
  rowByFieldId: string;
  columnByFieldId: string;
  aggregate: string;
  fieldId: string | null;
  filters: QueryFilter[];
}

/**
 * A matrix counts, and takes no aggregate at all: a cell states its number beside the
 * cards it holds, and "showing 4 of 17" is only a sentence about counting. The aggregate
 * is supplied here rather than stored, so the node carries only what an author chose.
 */
export function cellRead(node: SurfaceNodePlan, entityId: string | null): CellRead | null {
  const rowByFieldId = property(node, 'rowByFieldId');
  const columnByFieldId = property(node, 'columnByFieldId');
  if (entityId === null || rowByFieldId === null || columnByFieldId === null) return null;
  if (rowByFieldId === columnByFieldId) return null;
  return {
    entityId,
    rowByFieldId,
    columnByFieldId,
    aggregate: 'count',
    fieldId: null,
    // The surface's own clauses, once. A tile composes its scope's clauses with its own,
    // and a matrix is its own scope: composing here would charge every clause twice
    // against the budget of eight and refuse a grid the compiler had allowed.
    filters: clauseFilters(node),
  };
}

/** The host's answer to a crossed read: every cell of the grid, and the shape to draw it in. */
export interface CellResult {
  rowKeys: string[];
  columnKeys: string[];
  cells: Array<{ rowKey: string | null; columnKey: string | null; valueLexeme: string | null; contributingRecords: number }>;
  unrecognised: number;
  changeSequence: number;
}

/** One cell's exact number, or null when the grid has not answered for that pair. */
export function cellValue(result: CellResult, rowKey: string | null, columnKey: string | null): number | null {
  const cell = result.cells.find((candidate) => candidate.rowKey === rowKey && candidate.columnKey === columnKey);
  if (cell === undefined) return null;
  const value = cell.valueLexeme === null ? 0 : Number(cell.valueLexeme);
  return Number.isFinite(value) ? value : null;
}

/**
 * A cell drills into its own two predicates, one per axis — the second two-clause drill
 * in the product, after a bucket's two bounds. An unset lane drills with isNull, which is
 * an operator the closed set already has.
 */
export function cellDrillFilters(
  node: SurfaceNodePlan, rowKey: string | null, columnKey: string | null): QueryFilter[] {
  const rowByFieldId = property(node, 'rowByFieldId');
  const columnByFieldId = property(node, 'columnByFieldId');
  if (rowByFieldId === null || columnByFieldId === null) return [];
  return [
    rowKey === null ? { fieldId: rowByFieldId, operator: 'isNull' } : { fieldId: rowByFieldId, operator: 'eq', value: rowKey },
    columnKey === null ? { fieldId: columnByFieldId, operator: 'isNull' } : { fieldId: columnByFieldId, operator: 'eq', value: columnKey },
  ];
}

/**
 * The rank numeral each row carries, over a window already in rank order.
 *
 * Equal numbers share a numeral and the next numeral skips it: two records holding the
 * same number are not first and second. The limit is a limit on rows, so a tie straddling
 * it is cut rather than drawn in full — a ranking of ten says "the top ten", not
 * "everyone who reached tenth".
 */
export function rankNumerals(values: Array<number | null>): number[] {
  const numerals: number[] = [];
  let previous: number | null = null;
  let numeral = 0;
  values.forEach((value, index) => {
    if (previous === null || value === null || value !== previous) numeral = index + 1;
    numerals.push(numeral);
    previous = value;
  });
  return numerals;
}

/**
 * How much of its row a bar fills, against the largest value over everything the ranking
 * covers. Nothing is drawn for a value that is absent or not positive: a proportion of a
 * non-positive maximum is a drawing of nothing, and a negative number has no share of a
 * positive one.
 */
export function rankProportion(value: number | null, largest: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(largest) || largest <= 0) return 0;
  return Math.min(100, Math.max(2, (value / largest) * 100));
}

/**
 * A stored number as a number, or null when the field holds nothing readable.
 *
 * Every exact number reaches the renderer in a `$nendoNumber` envelope that keeps its
 * digits, so reading the stored value directly answers NaN for every record that has
 * one. The bars were drawn at zero width against a maximum that was read correctly,
 * which looked like a ranking of records that all held nothing.
 */
export function rankValue(stored: unknown): number | null {
  const lexeme = exactNumberText(stored)
    ?? (typeof stored === 'number' || typeof stored === 'string' ? String(stored) : null);
  if (lexeme === null || lexeme === '') return null;
  const value = Number(lexeme);
  return Number.isFinite(value) ? value : null;
}

/** The two counts a ring is drawn from: its own clauses over its scope, and its scope alone. */
export interface ProgressRead { entityId: string; numerator: QueryFilter[]; denominator: QueryFilter[] }

export function progressRead(node: SurfaceNodePlan, scope: TileScope, surfaceEntityId: string | null): ProgressRead | null {
  const entityId = tileEntityId(scope, surfaceEntityId);
  if (entityId === null) return null;
  if (scope.kind === 'relation' && property(scope.relation, 'viaFieldId') === null) return null;
  return {
    entityId,
    numerator: tileFilters(node, scope),
    denominator: tileFilters({ ...node, children: [] }, scope),
  };
}

/** The host's answer to a grouped read. */
export interface GroupedResult {
  groups: Array<{ key: string | null; valueLexeme: string | null; contributingRecords: number }>;
  unrecognised: number;
  changeSequence: number;
}

/** Whether a field stores a Boolean; the bridge spells the kind as text or as its enum index. */
export function isBooleanField(field: FieldPlan | undefined): boolean {
  if (field === undefined) return false;
  return field.storageKind === 3 || String(field.storageKind).toLowerCase() === 'boolean';
}

/** What a group is called: the option's label, Yes and No for a Boolean, and Not set for the unset group. */
export function groupLabel(field: FieldPlan | undefined, key: string | null): string {
  if (key === null) return 'Not set';
  if (isBooleanField(field)) return key === 'true' ? 'Yes' : 'No';
  const choice = field?.choices?.find((candidate) => candidate.id === key);
  return choice ? choice.displayName + (choice.retired ? ' (retired)' : '') : key;
}

/** The colour a group is drawn in: its option's tone, a Boolean's yes or no, and nothing for unset. */
export function groupStyle(field: FieldPlan | undefined, key: string | null): string {
  if (key === null) return '';
  if (isBooleanField(field)) return key === 'true' ? '--status-color: var(--healthy)' : '--status-color: var(--muted)';
  return choiceStyle(field, key);
}

/** The segments of a breakdown, in the host's order: configured groups, then unset. */
export function breakdownSegments(field: FieldPlan | undefined, result: GroupedResult): ChartSegment[] {
  return result.groups.map((group) => ({
    key: group.key,
    label: groupLabel(field, group.key),
    lexeme: group.valueLexeme,
    amount: proportionOf(group.valueLexeme),
    style: groupStyle(field, group.key),
  }));
}

export function chartTitle(node: SurfaceNodePlan, fieldName: (fieldId: string) => string): string {
  const title = property(node, 'title');
  if (title !== null && title.length > 0) return title;
  if (node.kind === 'progressTile') return 'Progress';
  if (isOverTimeKind(node.kind)) {
    const dateFieldId = property(node, 'dateFieldId');
    if (dateFieldId === null) return node.kind === 'activityGrid' ? 'Activity' : 'Trend';
    return node.kind === 'activityGrid' ? `Activity by ${fieldName(dateFieldId)}` : `By ${fieldName(dateFieldId)}`;
  }
  const groupByFieldId = property(node, 'groupByFieldId');
  return groupByFieldId === null ? 'Breakdown' : `By ${fieldName(groupByFieldId)}`;
}

/** A closed range word, as a person would say it. */
export function rangeLabel(range: string | null): string {
  switch (range) {
    case 'last12Months': return 'the last 12 months';
    case 'last6Months': return 'the last 6 months';
    case 'last90Days': return 'the last 90 days';
    case 'last30Days': return 'the last 30 days';
    case 'thisYear': return 'this year';
    case 'lastTwelveMonths': return 'the last 12 months';
    default: return 'its range';
  }
}

/** What the numbers are and what they cover, in words. */
export function chartContext(node: SurfaceNodePlan, scope: TileScope, fieldName: (fieldId: string) => string): string {
  const covered = tileScopeLabel(scope);
  if (node.kind === 'progressTile') return `matching ${clauseFilters(node).length === 1 ? 'its condition' : 'its conditions'}, over ${covered}`;
  if (node.kind === 'activityGrid') return `records per day over ${rangeLabel(property(node, 'range'))}, ${covered}`;
  if (node.kind === 'trendChart') {
    const total = property(node, 'aggregate') ?? 'count';
    const amountField = property(node, 'fieldId');
    const measured = total === 'count' ? 'records' : `${total} of ${amountField === null ? 'a field' : fieldName(amountField)}`;
    const per = property(node, 'bucket') === 'week' ? 'week' : 'month';
    return `${measured} per ${per} over ${rangeLabel(property(node, 'range'))}, ${covered}`;
  }
  const aggregate = property(node, 'aggregate') ?? 'count';
  const fieldId = property(node, 'fieldId');
  const what = aggregate === 'count' ? 'records' : `${aggregate} of ${fieldId === null ? 'a field' : fieldName(fieldId)}`;
  return `${what} per group, ${covered}`;
}

/**
 * A breakdown computed from a bounded sample for the proposal preview: records
 * per group, in the field's order, with values outside the groups counted apart.
 * It counts records whatever the chart aggregates, because a sum over a sample is
 * not the sum, and says so where it is shown.
 */
export function sampleGrouped(node: SurfaceNodePlan, field: FieldPlan | undefined, records: readonly RecordPlan[]): GroupedResult {
  const groupByFieldId = property(node, 'groupByFieldId') ?? '';
  const keys = isBooleanField(field) ? ['false', 'true'] : [...(field?.options ?? [])];
  const counts = new Map<string, number>(keys.map((key) => [key, 0]));
  let unset = 0;
  let unrecognised = 0;
  for (const record of records) {
    const stored = record.values[groupByFieldId];
    const key = stored === null || stored === undefined || stored === '' ? null
      : typeof stored === 'boolean' ? String(stored) : String(stored);
    if (key === null) unset++;
    else if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
    else unrecognised++;
  }
  return {
    groups: [...keys.map((key) => ({ key, valueLexeme: String(counts.get(key)), contributingRecords: counts.get(key)! })),
      { key: null, valueLexeme: String(unset), contributingRecords: unset }],
    unrecognised,
    changeSequence: 0,
  };
}

/**
 * A bucketed result computed from a bounded sample for the proposal preview. The buckets
 * are produced from the range here too, so a preview shows the same empty months the
 * running screen will, rather than only the ones the sample happened to touch.
 */
export function sampleBucketed(node: SurfaceNodePlan, records: readonly RecordPlan[], today: Date): BucketResult {
  const bucket = node.kind === 'activityGrid' ? 'day' : property(node, 'bucket') ?? 'month';
  const range = property(node, 'range') ?? 'last12Months';
  const dateFieldId = property(node, 'dateFieldId') ?? '';
  const { start, end, keys } = sampleBuckets(range, bucket, today);
  const counts = new Map<string, number>(keys.map((key) => [key, 0]));
  for (const record of records) {
    const stored = record.values[dateFieldId];
    if (typeof stored !== 'string') continue;
    const day = stored.slice(0, 10);
    if (day < start || day > end) continue;
    const key = bucket === 'month' ? day.slice(0, 7) : bucket === 'week' ? mondayOf(day) : day;
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  return {
    groups: keys.map((key) => ({ key, valueLexeme: String(counts.get(key)), contributingRecords: counts.get(key)! })),
    start,
    end,
    changeSequence: 0,
  };
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return isoDay(new Date(date.getTime() - (((date.getUTCDay() + 6) % 7) * 86_400_000)));
}

/** The preview's own resolution of the same closed words the host resolves when it reads. */
function sampleBuckets(range: string, bucket: string, today: Date): { start: string; end: string; keys: string[] } {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const date = today.getUTCDate();
  const bounds = (): [Date, Date] => {
    switch (range) {
      case 'last6Months': return [new Date(Date.UTC(year, month - 5, 1)), new Date(Date.UTC(year, month + 1, 0))];
      case 'last90Days': return [new Date(Date.UTC(year, month, date - 89)), new Date(Date.UTC(year, month, date))];
      case 'last30Days': return [new Date(Date.UTC(year, month, date - 29)), new Date(Date.UTC(year, month, date))];
      case 'thisYear': return [new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 11, 31))];
      case 'lastTwelveMonths': return [new Date(Date.UTC(year - 1, month, date + 1)), new Date(Date.UTC(year, month, date))];
      default: return [new Date(Date.UTC(year, month - 11, 1)), new Date(Date.UTC(year, month + 1, 0))];
    }
  };
  const [from, to] = bounds();
  const keys: string[] = [];
  if (bucket === 'month') {
    for (let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); cursor <= to;
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)))
      keys.push(isoDay(cursor).slice(0, 7));
  } else if (bucket === 'week') {
    for (let cursor = new Date(`${mondayOf(isoDay(from))}T00:00:00Z`); cursor <= to;
      cursor = new Date(cursor.getTime() + 7 * 86_400_000))
      keys.push(isoDay(cursor));
  } else {
    for (let cursor = from; cursor <= to; cursor = new Date(cursor.getTime() + 86_400_000)) keys.push(isoDay(cursor));
  }
  return { start: isoDay(from), end: isoDay(to), keys };
}

/** The one predicate a segment click narrows the list by. */
export function drillFilter(node: SurfaceNodePlan, field: FieldPlan | undefined, key: string | null): QueryFilter | null {
  const groupByFieldId = property(node, 'groupByFieldId');
  if (groupByFieldId === null) return null;
  if (key === null) return { fieldId: groupByFieldId, operator: 'isNull' };
  return { fieldId: groupByFieldId, operator: 'eq', value: isBooleanField(field) ? key === 'true' : key };
}

/** What the pill says while a drill narrows the list. */
export function drillLabel(node: SurfaceNodePlan, field: FieldPlan | undefined, key: string | null, fieldName: (fieldId: string) => string): string {
  if (node.kind === 'progressTile') return chartTitle(node, fieldName);
  if (isOverTimeKind(node.kind)) {
    const bucket = node.kind === 'activityGrid' ? 'day' : property(node, 'bucket') ?? 'month';
    const dateFieldId = property(node, 'dateFieldId') ?? '';
    return `${fieldName(dateFieldId)}: ${bucketLabel(bucket, key)}`;
  }
  const groupByFieldId = property(node, 'groupByFieldId') ?? '';
  return `${fieldName(groupByFieldId)}: ${groupLabel(field, key)}`;
}

/** A ring drills into the records matching its own clauses, which the compiler bounded. */
export function ringDrillFilters(node: SurfaceNodePlan): QueryFilter[] {
  return clauseFilters(node);
}
