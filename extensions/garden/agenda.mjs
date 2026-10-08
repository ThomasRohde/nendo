// The Agenda (W-184): the garden's open tasks by when they are due, Overdue, Today, This week,
// Later and No date, and the writes one tick makes. A task that a note's body says ticks its line in
// that note as well as its record, so the next save of the note keeps the tick rather than taking
// it back. A task added by hand has no line and ticks its record alone. Pure: it reads nothing.
//
//   agenda(tasks, notes, today, { keep })  -> { groups: [{ id, title, tasks }], open, overdue }
//   weekEnd(today)                         -> the Sunday that ends today's week, as YYYY-MM-DD
//   tickWrites(task, note, done, today)    -> the records.batch writes that tick or untick it

import { parse } from './parse.mjs';
import { F } from './sync.mjs';

const TASK_LINE = /^(\s*[-*+]\s+\[)( |x|X)(\])/;
const DAY = 86_400_000;
const asDay = text => { const [y, m, d] = String(text).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);

export const GROUPS = [
  { id: 'overdue', title: 'Overdue' },
  { id: 'today', title: 'Today' },
  { id: 'week', title: 'This week' },
  { id: 'later', title: 'Later' },
  { id: 'none', title: 'No date' },
];

/** A week runs Monday to Sunday, so on a Sunday this week is today alone. */
export function weekEnd(today) {
  const day = asDay(today);
  return iso(day + ((7 - new Date(day).getUTCDay()) % 7) * DAY);
}

function groupOf(due, today, end) {
  if (!isDate(due)) return 'none';
  const day = String(due).slice(0, 10);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return day <= end ? 'week' : 'later';
}

/**
 * The open tasks in their groups, soonest first, then by note, and within a note in the order its
 * body says them, since a note's steps are often meant in that order; the tasks added by hand come
 * after the body's, by their words. `keep` names tasks ticked while the Agenda was open: they stay
 * where they were, ticked, so a slip can be unticked.
 */
export function agenda(tasks = [], notes = [], today, { keep = new Set() } = {}) {
  const titles = new Map(notes.map(note => [note.recordId, String(note.values[F.note.title] ?? note.recordId)]));
  // Where each task's line sits in its note, read only for the notes that have open tasks.
  const lines = new Map();
  const lineOf = (noteId, key) => {
    if (noteId === null || !key) return Infinity;
    if (!lines.has(noteId)) {
      const body = notes.find(note => note.recordId === noteId)?.values[F.note.body] ?? '';
      lines.set(noteId, new Map(parse(String(body)).tasks.map(task => [task.key, task.line])));
    }
    return lines.get(noteId).get(key) ?? Infinity;
  };
  const end = weekEnd(today);
  const groups = GROUPS.map(group => ({ ...group, tasks: [] }));
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const row of tasks) {
    const done = row.values[F.task.done] === true;
    if (done && !keep.has(row.recordId)) continue;
    const due = isDate(row.values[F.task.due]) ? String(row.values[F.task.due]).slice(0, 10) : null;
    const noteId = row.values[F.task.note] ?? null;
    const manual = row.values[F.task.source] !== 'Checkbox', key = row.values[F.task.key] ?? null;
    byId.get(groupOf(due, today, end)).tasks.push({
      id: row.recordId, recordId: row.recordId, version: row.version, entityId: 'gd.task',
      text: String(row.values[F.task.title] ?? row.recordId), done, due, key,
      manual, noteId, noteTitle: noteId === null ? null : titles.get(noteId) ?? null, line: manual ? Infinity : lineOf(noteId, key),
    });
  }
  const order = (a, b) => (a.due ?? '').localeCompare(b.due ?? '') || (a.noteTitle ?? '').localeCompare(b.noteTitle ?? '')
    || (a.noteId ?? '').localeCompare(b.noteId ?? '') || (a.line === b.line ? 0 : a.line < b.line ? -1 : 1) || a.text.localeCompare(b.text);
  for (const group of groups) group.tasks.sort(order);
  const open = groups.reduce((total, group) => total + group.tasks.filter(task => !task.done).length, 0);
  return { groups, open, overdue: byId.get('overdue').tasks.filter(task => !task.done).length };
}

/** The writes one tick makes: the note's line first when its body says the task, then the task. */
export function tickWrites(task, note, done, today) {
  const writes = [];
  if (!task.manual && note && task.key) {
    const body = String(note.values[F.note.body] ?? '');
    const line = parse(body).tasks.find(candidate => candidate.key === task.key)?.line;
    const lines = body.split('\n');
    if (line !== undefined && TASK_LINE.test(lines[line] ?? '')) {
      lines[line] = lines[line].replace(TASK_LINE, `$1${done ? 'x' : ' '}$3`);
      const values = { [F.note.body]: lines.join('\n') };
      if (note.values[F.note.touched] !== today) values[F.note.touched] = today;
      writes.push({ op: 'update', entityId: 'gd.note', recordId: note.recordId, version: note.version, values });
    }
  }
  writes.push({ op: 'update', entityId: 'gd.task', recordId: task.recordId, version: task.version, values: { [F.task.done]: done } });
  return writes;
}
