import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../extensions/garden/parse.mjs';
import { noteTasks, taskProgress, dueText } from '../../extensions/garden/tasks.mjs';

const body = ['# Plan', '', '- [x] Read **History**', '- [ ] Water the seeds', '```', '- [ ] not a task, inside a fence', '```', '- [ ] Write it up'].join('\n');
const record = (recordId, values, version = 3) => ({ recordId, version, values: { 'gd.task.note': 'gd.note.plan', ...values } });

test('the body\'s tasks come in its order, as the draft says them, with what their records add', () => {
  const parsed = parse(body).tasks;
  const water = parsed.find(task => task.text === 'Water the seeds');
  const records = [
    record('gd.task.water', { 'gd.task.title': 'Water the seeds', 'gd.task.done': true, 'gd.task.source': 'Checkbox', 'gd.task.key': water.key, 'gd.task.due': '2026-10-09' }, 7),
    record('gd.task.gone', { 'gd.task.title': 'A line the body no longer says', 'gd.task.done': false, 'gd.task.source': 'Checkbox', 'gd.task.key': 'deadbeef' }),
  ];
  const tasks = noteTasks(parsed, records);
  assert.deepEqual(tasks.map(task => [task.text, task.done, task.line]), [['Read **History**', true, 2], ['Water the seeds', false, 3], ['Write it up', false, 7]]);
  // The draft decides whether a body task is done; its record adds the record to open and the due date.
  assert.deepEqual([tasks[1].recordId, tasks[1].version, tasks[1].due, tasks[1].manual], ['gd.task.water', 7, '2026-10-09', false]);
  assert.equal(tasks[2].recordId, null, 'a task not saved yet has no record');
  assert.ok(!tasks.some(task => task.recordId === 'gd.task.gone'), 'a record the body no longer says is not shown');
});

test('tasks added by hand follow the body\'s, with no line, and tick their record', () => {
  const tasks = noteTasks(parse(body).tasks, [record('gd.task.call', { 'gd.task.title': 'Call the nursery', 'gd.task.done': false, 'gd.task.source': 'Manual' })]);
  const last = tasks.at(-1);
  assert.deepEqual([last.id, last.text, last.line, last.manual, last.version], ['record:gd.task.call', 'Call the nursery', null, true, 3]);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length, 'every task has its own id');
});

test('progress counts the done tasks and names the first open one', () => {
  const tasks = noteTasks(parse(body).tasks, []);
  const progress = taskProgress(tasks);
  assert.deepEqual([progress.done, progress.total, progress.next.text], [1, 3, 'Water the seeds']);
  assert.deepEqual(taskProgress([]), { done: 0, total: 0, next: null }, 'a note with no tasks has nothing to show');
  assert.equal(taskProgress(noteTasks(parse('- [x] one\n- [x] two').tasks, [])).next, null);
});

test('a due date reads as a day, with the year only when it is not this one, and is late once it has passed', () => {
  assert.deepEqual(dueText('2026-10-09', '2026-10-08', 'en-GB'), { text: '9 Oct', late: false });
  assert.deepEqual(dueText('2026-10-07', '2026-10-08', 'en-GB'), { text: '7 Oct', late: true });
  assert.deepEqual(dueText('2027-01-02', '2026-10-08', 'en-GB'), { text: '2 Jan 2027', late: false });
  assert.equal(dueText(null, '2026-10-08'), null);
  assert.equal(dueText('soon', '2026-10-08'), null);
});
