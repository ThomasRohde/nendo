/**
 * The keys of a drillable activity grid (WDV-16). Every day was its own Tab stop, up to 366 of
 * them before the records below. The grid is one Tab stop: the arrow keys move by day and by week,
 * Home and End go to its first and last day, and Enter or Space drills, as a button does. The day
 * last moved to keeps the Tab stop, so Tab into the grid comes back to it.
 */
if (typeof document !== 'undefined') document.addEventListener('keydown', (event) => {
  const day = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('.chart-grid .chart-day:not(.is-blank)') : null;
  if (day === null || event.altKey || event.ctrlKey || event.metaKey) return;
  // A week is a column (styles: grid-auto-flow: column), so Down and Up move a day, Right and Left a week.
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' ? 7 : event.key === 'ArrowLeft' ? -7 : null;
  const days = [...day.closest('.chart-grid')!.querySelectorAll<HTMLButtonElement>('.chart-day:not(.is-blank)')];
  const at = days.indexOf(day);
  const to = step !== null ? at + step : event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : null;
  if (to === null || to < 0 || to >= days.length) return;
  event.preventDefault();
  for (const each of days) each.tabIndex = -1;
  days[to].tabIndex = 0;
  days[to].focus();
});
