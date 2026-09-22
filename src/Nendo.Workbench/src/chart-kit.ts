/**
 * The chart kit, ADR-0004 2026-09-14 amendment (S1). Pure markup from exact numbers
 * handed in: a proportion bar of toned segments and a progress ring. Nothing here
 * reads data, computes a statistic or animates; every number is shown beside the
 * shape and repeated in a table one toggle away, every segment is a named button,
 * and a chart whose number is absent says so rather than drawing a guess.
 */

export interface ChartSegment {
  /** The stored group key, or null for the unset group. */
  key: string | null;
  label: string;
  /** The exact lexeme to display, or null over a group that contributed nothing. */
  lexeme: string | null;
  /** The magnitude used for proportion only; never displayed. */
  amount: number;
  /** An inline style setting --status-color, or empty for the muted default. */
  style: string;
}

export type ChartStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; message: string; retry: boolean };

export interface BarInput {
  key: string;
  title: string;
  context: string;
  status: ChartStatus;
  segments: ChartSegment[];
  /** Records whose stored value is outside the configured groups. Stated, never drawn. */
  unrecognised: number;
  tableOpen: boolean;
  drillable: boolean;
}

export interface RingInput {
  key: string;
  title: string;
  context: string;
  status: ChartStatus;
  numerator: string | null;
  denominator: string | null;
  tableOpen: boolean;
  drillable: boolean;
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

const attribute = (value: string): string => escape(value);

/** The magnitude a lexeme contributes to a proportion: a non-negative finite number, else nothing. */
export function proportionOf(lexeme: string | null): number {
  if (lexeme === null) return 0;
  const parsed = Number(lexeme);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function tableToggle(key: string, open: boolean): string {
  return `<button type="button" class="text-button chart-table-toggle" data-chart-table="${attribute(key)}" aria-pressed="${open}">${open ? 'Hide table' : 'Table'}</button>`;
}

function statusMarkup(status: ChartStatus, key: string): string | null {
  if (status.state === 'loading') return '<span class="summary-value" aria-busy="true">…</span>';
  if (status.state === 'failed')
    return `<span class="summary-value summary-failed">Unavailable</span><span class="summary-context">${escape(status.message)}</span>${status.retry ? `<button class="text-button" type="button" data-chart-retry="${attribute(key)}">Retry</button>` : ''}`;
  return null;
}

/**
 * One stacked horizontal bar. Each segment's width is its share of the total; a
 * zero total draws an empty track and says so. The legend carries every group's
 * exact lexeme, the table repeats them, and each segment is a button named with
 * its label and number so a screen reader reads the chart as its numbers.
 */
export function proportionBar(input: BarInput): string {
  const pending = statusMarkup(input.status, input.key);
  const total = input.segments.reduce((sum, segment) => sum + segment.amount, 0);
  const track = pending !== null
    ? pending
    : total === 0
      ? '<div class="chart-track is-empty" role="img" aria-label="No records"><span class="chart-empty">No records</span></div>'
      : `<div class="chart-track" role="group" aria-label="${attribute(input.title)}">${input.segments.filter((segment) => segment.amount > 0).map((segment) => {
        const share = (segment.amount / total) * 100;
        const name = `${segment.label}: ${segment.lexeme ?? 'none'}`;
        const drill = input.drillable ? ` data-chart-drill="${attribute(input.key)}" data-chart-group="${segment.key === null ? '' : attribute(segment.key)}" data-chart-unset="${segment.key === null}"` : '';
        return `<button type="button" class="chart-segment" style="${attribute(segment.style)}; flex-basis: ${share.toFixed(3)}%" title="${attribute(name)}" aria-label="${attribute(name)}"${drill}${input.drillable ? '' : ' disabled'}></button>`;
      }).join('')}</div>`;
  const legend = pending !== null ? '' : `<ul class="chart-legend">${input.segments.map((segment) =>
    `<li><span class="status-dot" style="${attribute(segment.style)}" aria-hidden="true"></span><span class="chart-legend-label">${escape(segment.label)}</span><strong>${escape(segment.lexeme ?? 'none')}</strong></li>`).join('')}</ul>`;
  const issue = pending === null && input.unrecognised > 0
    ? `<p class="column-data-issue" role="status">${input.unrecognised} ${input.unrecognised === 1 ? 'record has' : 'records have'} a value outside this chart's groups, so ${input.unrecognised === 1 ? 'it is' : 'they are'} not drawn. Correct the value in Studio.</p>`
    : '';
  const table = pending === null && input.tableOpen
    ? `<table class="chart-table"><thead><tr><th scope="col">Group</th><th scope="col">Value</th></tr></thead><tbody>${input.segments.map((segment) =>
      `<tr><th scope="row">${escape(segment.label)}</th><td>${escape(segment.lexeme ?? 'none')}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `<figure class="chart-tile chart-bar" data-chart-key="${attribute(input.key)}"><figcaption><span class="summary-title">${escape(input.title)}</span><span class="summary-context">${escape(input.context)}</span></figcaption>${track}${legend}${issue}${table}${pending === null ? tableToggle(input.key, input.tableOpen) : ''}</figure>`;
}

/**
 * A progress ring: an arc filled to numerator over denominator, with both numbers
 * in the centre. It is drawn only when both have answered, because one number is
 * a count, not a proportion.
 */
export function ring(input: RingInput): string {
  const pending = statusMarkup(input.status, input.key);
  const numerator = proportionOf(input.numerator);
  const denominator = proportionOf(input.denominator);
  const ready = pending === null && input.numerator !== null && input.denominator !== null;
  const share = ready && denominator > 0 ? Math.min(1, numerator / denominator) : 0;
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const text = ready ? `${input.numerator} of ${input.denominator}` : '';
  const body = pending !== null
    ? pending
    : !ready
      ? '<span class="summary-value" aria-busy="true">…</span>'
      : `<div class="chart-ring-body">${input.drillable ? `<button type="button" class="chart-ring-button" data-chart-drill="${attribute(input.key)}" data-chart-ring="true" aria-label="${attribute(`${input.title}: ${text}. Show these records`)}">` : ''}<svg class="chart-ring" viewBox="0 0 64 64" role="img" aria-label="${attribute(`${input.title}: ${text}`)}"><circle class="chart-ring-track" cx="32" cy="32" r="${radius}" /><circle class="chart-ring-fill" cx="32" cy="32" r="${radius}" stroke-dasharray="${circumference.toFixed(3)}" stroke-dashoffset="${(circumference * (1 - share)).toFixed(3)}" /></svg>${input.drillable ? '</button>' : ''}<span class="chart-ring-text"><strong>${escape(input.numerator!)}</strong><span>of ${escape(input.denominator!)}</span></span></div>`;
  const table = ready && input.tableOpen
    ? `<table class="chart-table"><tbody><tr><th scope="row">Matching</th><td>${escape(input.numerator!)}</td></tr><tr><th scope="row">All</th><td>${escape(input.denominator!)}</td></tr></tbody></table>`
    : '';
  return `<figure class="chart-tile chart-progress" data-chart-key="${attribute(input.key)}"><figcaption><span class="summary-title">${escape(input.title)}</span><span class="summary-context">${escape(input.context)}</span></figcaption>${body}${table}${ready ? tableToggle(input.key, input.tableOpen) : ''}</figure>`;
}

export interface ColumnsInput {
  key: string;
  title: string;
  context: string;
  status: ChartStatus;
  segments: ChartSegment[];
  tableOpen: boolean;
  drillable: boolean;
}

/**
 * A trend, ADR-0004 2026-09-16 amendment (S5): one column per bucket of the range, in
 * order, every bucket drawn.
 *
 * A bucket with nothing in it is the point. It keeps its slot and its label and draws a
 * baseline tick rather than a column, so the gap is visible as a gap; leaving it out would
 * produce a chart that looks exactly like a busy one and means something else entirely.
 * Every number is beside the shape in the table one toggle away, as everywhere else here.
 */
export function columns(input: ColumnsInput): string {
  const pending = statusMarkup(input.status, input.key);
  const tallest = input.segments.reduce((most, segment) => Math.max(most, segment.amount), 0);
  const plot = pending !== null
    ? pending
    : `<div class="chart-columns" role="group" aria-label="${attribute(input.title)}">${input.segments.map((segment) => {
      const empty = segment.lexeme === null || segment.amount <= 0;
      const height = tallest <= 0 || empty ? 0 : Math.max(2, (segment.amount / tallest) * 100);
      const name = `${segment.label}: ${empty ? 'none' : segment.lexeme}`;
      const drill = input.drillable ? ` data-chart-drill="${attribute(input.key)}" data-chart-group="${segment.key === null ? '' : attribute(segment.key)}" data-chart-unset="false"` : '';
      return `<button type="button" class="chart-column${empty ? ' is-empty' : ''}" title="${attribute(name)}" aria-label="${attribute(name)}"${drill}${input.drillable ? '' : ' disabled'}>` +
        `<span class="chart-column-fill" style="height: ${height.toFixed(2)}%" aria-hidden="true"></span>` +
        `<span class="chart-column-label" aria-hidden="true">${escape(segment.label)}</span></button>`;
    }).join('')}</div>`;
  const table = pending === null && input.tableOpen
    ? `<table class="chart-table"><thead><tr><th scope="col">Period</th><th scope="col">Value</th></tr></thead><tbody>${input.segments.map((segment) =>
      `<tr><th scope="row">${escape(segment.label)}</th><td>${escape(segment.lexeme ?? 'none')}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `<figure class="chart-tile chart-trend" data-chart-key="${attribute(input.key)}"><figcaption><span class="summary-title">${escape(input.title)}</span><span class="summary-context">${escape(input.context)}</span></figcaption>${plot}${table}${pending === null ? tableToggle(input.key, input.tableOpen) : ''}</figure>`;
}

export interface GridInput {
  key: string;
  title: string;
  context: string;
  status: ChartStatus;
  /** One entry per day of the range, in order, including every quiet one. */
  days: Array<{ key: string | null; label: string; lexeme: string | null; level: number }>;
  tableOpen: boolean;
  drillable: boolean;
}

/**
 * An activity grid: one square per day of the range, in week columns, the way a
 * contribution graph reads. A day with nothing is the lightest step rather than a hole,
 * for the same reason an empty column is a gap: the shape a person reads is the shape of
 * the year, not of the days that happen to have records.
 *
 * Each row is a weekday, which is the whole of what makes a column a week. The first
 * build filled seven rows from the first day of the range, so a row meant "position
 * modulo seven" and a Tuesday could sit in the sixth row; the leading blanks below pad
 * the first column to its Monday so that a row means something.
 *
 * The table behind the toggle lists only the days that had any, because a table of 365
 * rows of zero is not a way to read a number — the grid itself already states the zeroes.
 */
export function activityGrid(input: GridInput): string {
  const pending = statusMarkup(input.status, input.key);
  // Monday-first, so the first column is a whole week even when the range does not start
  // on one. The blanks are inert: not buttons, not days, and not named to a screen reader.
  const first = input.days.find((day) => day.key !== null)?.key ?? null;
  const offset = first === null ? 0 : (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const blanks = '<span class="chart-day is-blank" aria-hidden="true"></span>'.repeat(offset);
  const plot = pending !== null
    ? pending
    : `<div class="chart-grid" role="group" aria-label="${attribute(input.title)}">${blanks}${input.days.map((day) => {
      const count = day.lexeme ?? '0';
      const name = `${day.label}: ${count}`;
      const drill = input.drillable ? ` data-chart-drill="${attribute(input.key)}" data-chart-group="${day.key === null ? '' : attribute(day.key)}" data-chart-unset="false"` : '';
      return `<button type="button" class="chart-day" data-level="${day.level}" title="${attribute(name)}" aria-label="${attribute(name)}"${drill}${input.drillable ? '' : ' disabled'}></button>`;
    }).join('')}</div>`;
  const busy = input.days.filter((day) => day.level > 0);
  const table = pending === null && input.tableOpen
    ? `<table class="chart-table"><thead><tr><th scope="col">Day</th><th scope="col">Records</th></tr></thead><tbody>${busy.length === 0
      ? '<tr><td colspan="2">No records in this range.</td></tr>'
      : busy.map((day) => `<tr><th scope="row">${escape(day.label)}</th><td>${escape(day.lexeme ?? '0')}</td></tr>`).join('')}</tbody></table>`
    : '';
  const legend = pending !== null ? '' : `<p class="chart-scale"><span>Less</span>${[0, 1, 2, 3, 4].map((level) =>
    `<span class="chart-day is-key" data-level="${level}" aria-hidden="true"></span>`).join('')}<span>More</span></p>`;
  return `<figure class="chart-tile chart-activity" data-chart-key="${attribute(input.key)}"><figcaption><span class="summary-title">${escape(input.title)}</span><span class="summary-context">${escape(input.context)}</span></figcaption>${plot}${legend}${table}${pending === null ? tableToggle(input.key, input.tableOpen) : ''}</figure>`;
}

export interface StripInput {
  key: string;
  title: string;
  context: string;
  status: ChartStatus;
  /** The exact lexemes of both ends, each null until that end has answered. */
  low: string | null;
  high: string | null;
  tableOpen: boolean;
}

/**
 * A range strip: both ends of one field, labelled (ADR-0004 2026-09-14 amendment,
 * S4). It is not a chart — there is no grouping, nothing is proportional and there
 * is nothing to drill into — so it draws a rule between two stated numbers rather
 * than a shape that implies a distribution it has not read.
 *
 * Both ends are shown or neither is: one end of a range is a bound, and drawing it
 * alone would say something the host was not asked. An empty set has no range at
 * all, and says so rather than reading zero to zero.
 */
export function strip(input: StripInput): string {
  const pending = statusMarkup(input.status, input.key);
  const answered = pending === null && input.low !== null && input.high !== null;
  const empty = pending === null && input.status.state === 'ready' && input.low === null && input.high === null;
  const body = pending !== null
    ? pending
    : empty
      ? '<div class="chart-track is-empty" role="img" aria-label="No records"><span class="chart-empty">No records</span></div>'
      : !answered
        ? '<span class="summary-value" aria-busy="true">…</span>'
        : `<div class="range-strip" role="img" aria-label="${attribute(`${input.title}: ${input.low} to ${input.high}`)}"><span class="range-end range-low">${escape(input.low!)}</span><span class="range-rule" aria-hidden="true"></span><span class="range-end range-high">${escape(input.high!)}</span></div>`;
  const table = answered && input.tableOpen
    ? `<table class="chart-table"><tbody><tr><th scope="row">Smallest</th><td>${escape(input.low!)}</td></tr><tr><th scope="row">Largest</th><td>${escape(input.high!)}</td></tr></tbody></table>`
    : '';
  return `<figure class="chart-tile chart-range" data-chart-key="${attribute(input.key)}"><figcaption><span class="summary-title">${escape(input.title)}</span><span class="summary-context">${escape(input.context)}</span></figcaption>${body}${table}${answered ? tableToggle(input.key, input.tableOpen) : ''}</figure>`;
}
