import type { SurfaceNodePlan } from './host';
import { cacheKey, clauseFilters, declaredQuery, type WindowQuery } from './record-window';
import {
  type CalendarMode, type CivilMonth, civilDate, isLeapYear, loadedStateLabel, monthNames, monthOf, undatedQuery,
} from './calendar-model';

// Civil-year bounds, month grouping and spans for the timeline. As in the
// calendar model, nothing here constructs a JavaScript Date: a stored Date is a
// civil YYYY-MM-DD compared and grouped as the text it is, and day arithmetic
// is integer arithmetic over the civil calendar, so no span can be lengthened or
// shortened by a time zone or a daylight-saving change.

/** Which view a timeline surface is showing: the year's spine or the undated list. */
export type TimelineMode = CalendarMode;

export function yearStart(year: number): string {
  return `${year}-01-01`;
}

/** The exclusive upper bound of the year. */
export function nextYearStart(year: number): string {
  return `${year + 1}-01-01`;
}

export function yearEnd(year: number): string {
  return `${year}-12-31`;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

export function dateFieldOf(node: SurfaceNodePlan): string | null {
  return typeof node.properties.dateFieldId === 'string' ? node.properties.dateFieldId : null;
}

export function endDateFieldOf(node: SurfaceNodePlan): string | null {
  return typeof node.properties.endDateFieldId === 'string' ? node.properties.endDateFieldId : null;
}

/**
 * The query for one year: the timeline's own clauses plus two date bounds, which
 * the compiler reserves against the effective-filter ceiling exactly as it does
 * for a calendar month. Default order is the date itself, so entries arrive in
 * the order they will be read; a declared order overrides it and then orders
 * within each month.
 */
export function yearQuery(node: SurfaceNodePlan, year: number): WindowQuery {
  const declared = declaredQuery(node);
  const dateFieldId = dateFieldOf(node);
  if (dateFieldId === null) return declared;
  return {
    filters: [
      ...clauseFilters(node),
      { fieldId: dateFieldId, operator: 'ge', value: yearStart(year) },
      { fieldId: dateFieldId, operator: 'lt', value: nextYearStart(year) },
    ],
    sortFieldId: declared.sortFieldId ?? dateFieldId,
    descending: declared.descending,
  };
}

/** The undated view is the calendar's: the same root filters plus the date being absent. */
export function timelineQuery(node: SurfaceNodePlan, mode: TimelineMode, year: number): WindowQuery {
  return mode === 'undated' ? undatedQuery(node) : yearQuery(node, year);
}

/**
 * A timeline window is identified by its surface, its mode and its year, in a
 * namespace of its own so it can share one accumulator map with the calendar.
 */
export function timelineWindowKey(surfaceId: string, mode: TimelineMode, year: number): string {
  return mode === 'undated'
    ? cacheKey(['timeline', surfaceId, 'undated'])
    : cacheKey(['timeline', surfaceId, 'dated', year]);
}

/**
 * The spine runs December first only when the effective sort is the date
 * itself, descending. A declared order by another field orders entries within
 * a month, and the months stay January to December.
 */
export function spineDescending(node: SurfaceNodePlan): boolean {
  const declared = declaredQuery(node);
  const dateFieldId = dateFieldOf(node);
  return dateFieldId !== null && (declared.sortFieldId ?? dateFieldId) === dateFieldId && declared.descending === true;
}

/**
 * Days since 1970-01-01 for a civil date, by the days-from-civil algorithm:
 * integer arithmetic only, with the year taken to start in March so a leap day
 * falls at the end of it.
 */
export function dayNumber(civil: string): number {
  const year = Number(civil.slice(0, 4));
  const month = Number(civil.slice(5, 7));
  const day = Number(civil.slice(8, 10));
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export function daysBetween(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start);
}

/** What an end date makes of an entry. */
export interface Span {
  /** The end as stored. */
  end: string;
  /** Inclusive days from the start to the end, or to the year's last day when the end lies past it. */
  days: number;
  /** The days shown over the year's days, for a bar drawn to scale; both numbers are stated beside it. */
  proportion: number;
  /** True when the end lies past the year shown, so the bar is cut at 31 December and says so. */
  clipped: boolean;
}

export type SpanOutcome =
  | { kind: 'none' }
  | { kind: 'span'; span: Span }
  | { kind: 'issue'; end: string; message: string };

/**
 * A span is drawn from its start date. An end before the start is a data issue
 * the entry states rather than a bar drawn backwards; an end past the year is
 * cut at 31 December. Civil dates compare as text, so no Date is constructed.
 */
export function spanOf(start: string, endValue: unknown, year: number): SpanOutcome {
  const end = civilDate(endValue);
  if (end === null) return { kind: 'none' };
  if (end < start) return { kind: 'issue', end, message: `Ends ${dayMonthLabel(end, true)}, before it starts` };
  const last = yearEnd(year);
  const clipped = end > last;
  const days = daysBetween(start, clipped ? last : end) + 1;
  return { kind: 'span', span: { end, days, proportion: days / daysInYear(year), clipped } };
}

export const shortMonthNames = monthNames.map((name) => name.slice(0, 3));

/** "14 Sep", or "14 Sep 2026" when the year has to be said. */
export function dayMonthLabel(civil: string, withYear = false): string {
  const month = Number(civil.slice(5, 7));
  const day = Number(civil.slice(8, 10));
  const label = `${day} ${shortMonthNames[month - 1]}`;
  return withYear ? `${label} ${civil.slice(0, 4)}` : label;
}

/**
 * The sentence beside a span's bar: both dates and the count, so the bar is a
 * picture of numbers that are on screen. A cut span says how much of it is shown.
 */
export function spanLabel(start: string, span: Span, year: number): string {
  const endsElsewhere = Number(span.end.slice(0, 4)) !== year;
  const range = `${dayMonthLabel(start)} – ${dayMonthLabel(span.end, endsElsewhere)}`;
  const count = `${span.days} ${span.days === 1 ? 'day' : 'days'}`;
  return span.clipped
    ? `${range} · ${count} shown; continues past 31 Dec ${year}`
    : `${range} · ${count}`;
}

/** One month of the spine and the loaded entries placed in it. */
export interface MonthGroup<T> { month: CivilMonth; items: T[] }

/**
 * Every month of the year, in spine order, each with the loaded entries whose
 * date falls in it. A month with none is present and empty, because the spine
 * is the year rather than the records; whether empty means nothing or not
 * loaded yet is the caller's state line.
 */
export function groupByMonth<T>(
  items: readonly T[],
  year: number,
  dateOf: (item: T) => unknown,
  descending: boolean,
): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = Array.from({ length: 12 }, (_, index) => ({ month: { year, month: index + 1 }, items: [] }));
  for (const item of items) {
    const date = civilDate(dateOf(item));
    if (date === null) continue;
    const month = monthOf(date);
    if (month === null || month.year !== year) continue;
    groups[month.month - 1].items.push(item);
  }
  return descending ? groups.reverse() : groups;
}

/**
 * What the timeline can honestly say about what it is showing. While a cursor
 * is still open the year is a partial read: a month with no entry may simply
 * not have been loaded yet.
 */
export function timelineStateLabel(loaded: number, complete: boolean, mode: TimelineMode, year: number): string {
  if (mode === 'undated') return loadedStateLabel(loaded, complete, 'undated');
  const noun = loaded === 1 ? 'record' : 'records';
  if (!complete) return `${loaded} ${noun} loaded; more available. Months may hold entries that are not loaded yet.`;
  if (loaded === 1) return `The only record in ${year} is loaded.`;
  return `All ${loaded} ${noun} in ${year} are loaded.`;
}

/** A month with nothing loaded is not a month with nothing in it until the year has been read to the end. */
export function monthEmptyLabel(complete: boolean): string {
  return complete ? 'Nothing this month' : 'None loaded yet';
}

/**
 * The line under the year header when spans can be drawn: the denominator the
 * bars are scaled to, and the placement rule a reader would otherwise infer the
 * other way.
 */
export function yearNote(year: number): string {
  return `Spans are drawn to scale over the ${daysInYear(year)} days of ${year}; a span that began before 1 Jan ${year} is on that year's spine.`;
}
