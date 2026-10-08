// Tend (W-184): the notes that want a gardener. Seeds and growing notes nobody has tended within the
// span chosen, the longest untended first, and notes that are still only a name, as a link plants
// them. Daily notes are a record of their day and evergreen notes are grown, so neither is asked
// for. Pure: it reads nothing.
//
//   tend(notes, today, days) -> { quiet: [card], empty: [card] }
//   quietFor(days)           -> how long a note has waited, in words: 9 days, 3 weeks, 2 months
//   SPANS, DEFAULT_SPAN      -> the spans the screen offers, in days

import { F } from './sync.mjs';
import { excerpt } from './home-data.mjs';

export const SPANS = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
];
export const DEFAULT_SPAN = 14;
const TENDED = new Set(['Seed', 'Growing']);

const DAY = 86_400_000;
const asDay = text => { const [y, m, d] = String(text).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);

function card(note, today) {
  const touched = isDate(note.values[F.note.touched]) ? String(note.values[F.note.touched]).slice(0, 10) : null;
  return {
    id: note.recordId, record: note, title: String(note.values[F.note.title] ?? note.recordId), stage: note.values[F.note.stage] ?? null,
    touched, days: touched === null ? null : Math.round((asDay(today) - asDay(touched)) / DAY), excerpt: excerpt(note.values, 140),
  };
}

export function quietFor(days) {
  if (days === null || days === undefined) return 'never tended';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (days < 14) return plural(Math.max(days, 0), 'day');
  if (days < 60) return plural(Math.floor(days / 7), 'week');
  if (days < 730) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
}

export function tend(notes = [], today, days = DEFAULT_SPAN) {
  const quiet = [], empty = [];
  for (const note of notes) {
    const stage = note.values[F.note.stage] ?? null;
    if (note.values[F.note.kind] === 'Daily' || stage === 'Evergreen') continue;
    const item = card(note, today);
    if (!String(note.values[F.note.body] ?? '').trim()) empty.push(item);
    else if (TENDED.has(stage) && (item.days === null || item.days >= days)) quiet.push(item);
  }
  // Never tended counts as longest; then the longest untended; the title settles a tie.
  const longest = (a, b) => (b.days ?? Infinity) - (a.days ?? Infinity) || a.title.localeCompare(b.title);
  quiet.sort(longest);
  empty.sort(longest);
  return { quiet, empty };
}
