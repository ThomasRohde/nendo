import type { SurfaceNodePlan } from './host';
import { cacheKey, clauseFilters, declaredQuery, type WindowQuery } from './record-window';

// Civil dates, arithmetic and grouping for the Date calendar. Nothing here
// constructs a JavaScript Date: `new Date('2026-03-01')` is parsed as UTC
// midnight and read back in the local zone, which moves the day west of
// Greenwich. A stored Date is a civil YYYY-MM-DD with no time and no offset, so
// it is compared and grouped as the text it is.

/** A civil month. `month` is 1-12, as it reads in a date. */
export interface CivilMonth { year: number; month: number }

export const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Monday first, because a week that starts on Sunday splits the weekend. */
export const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pad = (value: number): string => String(value).padStart(2, '0');

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(month: CivilMonth): number {
  if (month.month === 2) return isLeapYear(month.year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month.month) ? 30 : 31;
}

/**
 * The day of the week by Sakamoto's method: pure integer arithmetic over the
 * civil date, so no calendar cell can be shifted by a time zone. 0 is Monday.
 */
export function mondayFirstWeekday(year: number, month: number, day: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let value = year;
  if (month < 3) value -= 1;
  const sunday = (value + Math.floor(value / 4) - Math.floor(value / 100) + Math.floor(value / 400)
    + offsets[month - 1] + day) % 7;
  return (sunday + 6) % 7;
}

export function monthStart(month: CivilMonth): string {
  return `${month.year}-${pad(month.month)}-01`;
}

/** The exclusive upper bound of the month, which rolls the year over December. */
export function nextMonthStart(month: CivilMonth): string {
  return monthStart(shiftMonth(month, 1));
}

export function shiftMonth(month: CivilMonth, delta: number): CivilMonth {
  const zeroBased = month.year * 12 + (month.month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

export function monthLabel(month: CivilMonth): string {
  return `${monthNames[month.month - 1]} ${month.year}`;
}

export function sameMonth(left: CivilMonth, right: CivilMonth): boolean {
  return left.year === right.year && left.month === right.month;
}

/**
 * A civil date from a stored value, or null. A Date field stores YYYY-MM-DD; a
 * DateTime is refused by the compiler, so a longer value is truncated to its
 * date part rather than interpreted.
 */
export function civilDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match === null ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

export function monthOf(date: string): CivilMonth | null {
  const civil = civilDate(date);
  if (civil === null) return null;
  return { year: Number(civil.slice(0, 4)), month: Number(civil.slice(5, 7)) };
}

/** One cell of a Monday-first grid. A padding cell carries no date. */
export interface MonthCell { date: string | null; day: number | null }

/**
 * The month as whole Monday-first weeks. Padding cells belong to no date, so a
 * record can never be placed in one.
 */
export function monthGrid(month: CivilMonth): MonthCell[] {
  const lead = mondayFirstWeekday(month.year, month.month, 1);
  const total = daysInMonth(month);
  const cells: MonthCell[] = [];
  for (let index = 0; index < lead; index++) cells.push({ date: null, day: null });
  for (let day = 1; day <= total; day++)
    cells.push({ date: `${month.year}-${pad(month.month)}-${pad(day)}`, day });
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
  return cells;
}

/** Which view a calendar surface is showing: the month grid or the undated list. */
export type CalendarMode = 'dated' | 'undated';

/**
 * The query for one month: the calendar's own clauses plus two date bounds. The
 * compiler reserves those two against the published effective-filter ceiling, so
 * a calendar carries at most six declared clauses.
 */
export function monthQuery(node: SurfaceNodePlan, month: CivilMonth): WindowQuery {
  const declared = declaredQuery(node);
  const dateFieldId = typeof node.properties.dateFieldId === 'string' ? node.properties.dateFieldId : null;
  if (dateFieldId === null) return declared;
  return {
    filters: [
      ...clauseFilters(node),
      { fieldId: dateFieldId, operator: 'ge', value: monthStart(month) },
      { fieldId: dateFieldId, operator: 'lt', value: nextMonthStart(month) },
    ],
    // Default order is the date itself, so entries arrive in the order they will
    // be read; a declared order overrides it and then orders within each day.
    sortFieldId: declared.sortFieldId ?? dateFieldId,
    descending: declared.descending,
  };
}

/** The undated view: the same root filters, plus the date being absent. */
export function undatedQuery(node: SurfaceNodePlan): WindowQuery {
  const declared = declaredQuery(node);
  const dateFieldId = typeof node.properties.dateFieldId === 'string' ? node.properties.dateFieldId : null;
  if (dateFieldId === null) return declared;
  return {
    filters: [...clauseFilters(node), { fieldId: dateFieldId, operator: 'isNull' }],
    sortFieldId: declared.sortFieldId,
    descending: declared.descending,
  };
}

export function calendarQuery(node: SurfaceNodePlan, mode: CalendarMode, month: CivilMonth): WindowQuery {
  return mode === 'undated' ? undatedQuery(node) : monthQuery(node, month);
}

/**
 * A calendar window is identified by its surface, its mode and its month. A
 * generic record pager keyed by surface alone would mix March into April, or
 * show the undated records inside the grid.
 */
export function calendarWindowKey(surfaceId: string, mode: CalendarMode, month: CivilMonth): string {
  return mode === 'undated'
    ? cacheKey(['calendar', surfaceId, 'undated'])
    : cacheKey(['calendar', surfaceId, 'dated', month.year, month.month]);
}

/**
 * The loaded entries by civil date. Only the entries that have actually been
 * read are placed; a day with none of them is not thereby empty, which is why
 * the caller states whether the month is complete.
 */
export function groupByDate<T>(
  items: readonly T[],
  dateOf: (item: T) => unknown,
): Map<string, T[]> {
  const byDate = new Map<string, T[]>();
  for (const item of items) {
    const date = civilDate(dateOf(item));
    if (date === null) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), item]);
  }
  return byDate;
}

/** The entries with no date at all, for the undated view. */
export function undatedItems<T>(items: readonly T[], dateOf: (item: T) => unknown): T[] {
  return items.filter((item) => civilDate(dateOf(item)) === null);
}

/**
 * What the calendar can honestly say about what it is showing. While a cursor is
 * still open, the month is a partial read: an absent entry may simply not have
 * been loaded yet.
 */
export function loadedStateLabel(loaded: number, complete: boolean, mode: CalendarMode): string {
  const noun = loaded === 1 ? 'record' : 'records';
  if (!complete) return `${loaded} ${noun} loaded; more available. Days may hold entries that are not loaded yet.`;
  if (loaded === 1) return mode === 'undated'
    ? 'The only record with no date is loaded.'
    : 'The only record in this month is loaded.';
  return mode === 'undated'
    ? `All ${loaded} ${noun} with no date are loaded.`
    : `All ${loaded} ${noun} in this month are loaded.`;
}
