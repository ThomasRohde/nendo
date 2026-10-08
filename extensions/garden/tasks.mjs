// A note's tasks as the strip under its title shows them (the owner, 2026-10-08): how many are done,
// the next one to do with its box, and every one under Show all. The body's checkboxes come as the
// draft says them now, each with what its record adds (the record to open, a due date); after them
// come the tasks somebody added by hand. Everything but drawTaskStrip is pure.
//
//   noteTasks(parsed, records, { before }) -> [{ id, text, done, line, recordId, version, due, manual }]
//   taskProgress(tasks)         -> { done, total, next }
//   dueText(date, today, locale) -> { text, late }, a due date in words: 9 Oct, and late when it has passed
//   drawTaskStrip(strip, tasks, { resolve, expanded, today })   fills the strip's markup in index.html

import { F, matchTasks } from './sync.mjs';
import { inline } from './render.mjs';

/**
 * The body's tasks (parse(body).tasks) joined to their Checkbox records as a save would match them
 * (matchTasks, against `before`, the body as saved), so a reworded line keeps its due date; then the
 * Manual ones.
 */
export function noteTasks(parsed, records = [], { before = '' } = {}) {
  const matched = matchTasks(parsed, records.filter(row => row.values[F.task.source] === 'Checkbox'), { before });
  const fromBody = parsed.map(task => {
    const row = matched.get(task) ?? null;
    return { id: `key:${task.key}`, text: task.text, done: task.done, line: task.line,
      recordId: row?.recordId ?? null, version: row?.version ?? null, due: row?.values[F.task.due] ?? null, manual: false };
  });
  const byHand = records.filter(row => row.values[F.task.source] !== 'Checkbox').map(row => ({
    id: `record:${row.recordId}`, text: String(row.values[F.task.title] ?? row.recordId), done: row.values[F.task.done] === true, line: null,
    recordId: row.recordId, version: row.version, due: row.values[F.task.due] ?? null, manual: true }));
  return [...fromBody, ...byHand];
}

export function taskProgress(tasks) {
  return { done: tasks.filter(task => task.done).length, total: tasks.length, next: tasks.find(task => !task.done) ?? null };
}

const asDay = text => { const [y, m, d] = String(text).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };

export function dueText(date, today, locale = 'en') {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const day = new Date(asDay(date));
  const sameYear = String(date).slice(0, 4) === String(today).slice(0, 4);
  return { text: day.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }) }), late: asDay(date) < asDay(today) };
}

const OPEN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

/** One task as a row: its box and its text in one label, then its due date and, in the full list, a way to its record. */
function taskRow(task, { resolve, today, openable }) {
  const item = document.createElement('li');
  item.className = `strip-task${task.done ? ' done' : ''}`;
  item.dataset.id = task.id;
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'box';
  box.checked = task.done;
  box.dataset.id = task.id;
  const text = document.createElement('span');
  text.className = 'text';
  text.innerHTML = inline(task.text, resolve);
  label.append(box, text);
  item.append(label);
  const due = task.done ? null : dueText(task.due, today, document.documentElement.lang || undefined);
  if (due) {
    const pill = document.createElement('span');
    pill.className = `due${due.late ? ' late' : ''}`;
    pill.textContent = `due ${due.text}`;
    item.append(pill);
  }
  if (openable && task.recordId) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open-task';
    open.dataset.record = task.recordId;
    open.title = "Open the task's record";
    open.setAttribute('aria-label', open.title);
    open.innerHTML = OPEN_ICON;
    item.append(open);
  }
  return item;
}

/** Fills the strip: hidden when the note has no tasks; the next task, or with `expanded` every task. */
export function drawTaskStrip(strip, tasks, { resolve, expanded, today }) {
  const progress = taskProgress(tasks);
  strip.hidden = progress.total === 0;
  if (strip.hidden) return progress;
  // A box redrawn under the person's keyboard keeps the focus: on the same task, or on the next one.
  const focused = strip.contains(document.activeElement) ? document.activeElement : null;
  const was = focused?.classList.contains('box') ? { id: focused.dataset.id, inNext: !!focused.closest('#task-next') } : focused?.id === 'task-all' ? 'all' : null;
  const $ = id => strip.querySelector(`#${id}`);
  $('task-ring-fill').setAttribute('stroke-dasharray', `${(100 * progress.done / progress.total).toFixed(1)} 100`);
  const count = $('task-count');
  count.replaceChildren(Object.assign(document.createElement('b'), { textContent: `${progress.done} of ${progress.total}` }),
    ` ${progress.total === 1 ? 'task' : 'tasks'} done`);
  const all = $('task-all');
  all.setAttribute('aria-expanded', String(expanded));
  all.querySelector('.label').textContent = expanded ? 'Show less' : 'Show all';
  const next = $('task-next'), finished = $('task-finished'), list = $('task-list');
  next.hidden = expanded || progress.next === null;
  finished.hidden = expanded || progress.next !== null;
  list.hidden = !expanded;
  $('task-next-row').replaceChildren(...(progress.next && !expanded ? [taskRow(progress.next, { resolve, today, openable: false })] : []));
  list.replaceChildren(...(expanded ? tasks.map(task => taskRow(task, { resolve, today, openable: true })) : []));
  if (was === 'all') all.focus();
  else if (was) (strip.querySelector(`#task-${expanded ? 'list' : 'next'} .box[data-id="${CSS.escape(was.id)}"]`) ?? (was.inNext ? strip.querySelector('#task-next .box') : null) ?? all).focus();
  return progress;
}
