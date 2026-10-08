import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../extensions/garden/parse.mjs';
import { agenda, weekEnd, tickWrites } from '../../extensions/garden/agenda.mjs';

const TODAY = '2026-10-08'; // a Thursday
const note = (recordId, title, body = '', version = 4, touched = '2026-10-01') =>
  ({ recordId, version, values: { 'gd.note.title': title, 'gd.note.body': body, 'gd.note.touched': touched } });
const task = (recordId, values, version = 2) => ({ recordId, version, values: { 'gd.task.done': false, 'gd.task.source': 'Manual', 'gd.task.key': null, ...values } });

test('a week runs Monday to Sunday', () => {
  assert.equal(weekEnd('2026-10-08'), '2026-10-11', 'Thursday\'s week ends on Sunday');
  assert.equal(weekEnd('2026-10-05'), '2026-10-11', 'Monday\'s week ends on Sunday');
  assert.equal(weekEnd('2026-10-11'), '2026-10-11', 'on a Sunday this week is today alone');
  assert.equal(weekEnd('2026-12-31'), '2027-01-03', 'a week crosses the year');
});

test('the open tasks fall into Overdue, Today, This week, Later and No date, soonest first, done ones left out', () => {
  const notes = [note('gd.note.plan', 'Plan'), note('gd.note.beds', 'Beds')];
  const tasks = [
    task('t.late', { 'gd.task.title': 'Late', 'gd.task.note': 'gd.note.plan', 'gd.task.due': '2026-10-01' }),
    task('t.today', { 'gd.task.title': 'Now', 'gd.task.note': 'gd.note.beds', 'gd.task.due': TODAY }),
    task('t.sun', { 'gd.task.title': 'Sunday', 'gd.task.note': 'gd.note.plan', 'gd.task.due': '2026-10-11' }),
    task('t.fri', { 'gd.task.title': 'Friday', 'gd.task.note': 'gd.note.plan', 'gd.task.due': '2026-10-09' }),
    task('t.mon', { 'gd.task.title': 'Monday', 'gd.task.note': 'gd.note.plan', 'gd.task.due': '2026-10-12' }),
    task('t.none.b', { 'gd.task.title': 'Water', 'gd.task.note': 'gd.note.plan' }),
    task('t.none.a', { 'gd.task.title': 'Dig', 'gd.task.note': 'gd.note.beds' }),
    task('t.done', { 'gd.task.title': 'Done long ago', 'gd.task.note': 'gd.note.plan', 'gd.task.done': true, 'gd.task.due': '2026-09-01' }),
  ];
  const view = agenda(tasks, notes, TODAY);
  assert.deepEqual(view.groups.map(group => [group.id, group.tasks.map(t => t.text)]), [
    ['overdue', ['Late']], ['today', ['Now']], ['week', ['Friday', 'Sunday']], ['later', ['Monday']], ['none', ['Dig', 'Water']],
  ]);
  assert.deepEqual([view.open, view.overdue], [7, 1]);
  const now = view.groups[1].tasks[0];
  assert.deepEqual([now.noteId, now.noteTitle, now.manual, now.due], ['gd.note.beds', 'Beds', true, TODAY]);
});

test('a task ticked while the Agenda is open stays in its group, ticked, and no longer counts as open', () => {
  const tasks = [task('t.a', { 'gd.task.title': 'A', 'gd.task.done': true, 'gd.task.due': TODAY }), task('t.b', { 'gd.task.title': 'B', 'gd.task.due': TODAY })];
  const view = agenda(tasks, [], TODAY, { keep: new Set(['t.a']) });
  assert.deepEqual(view.groups[1].tasks.map(t => [t.text, t.done]), [['A', true], ['B', false]]);
  assert.equal(view.open, 1);
  assert.equal(agenda(tasks, [], TODAY).groups[1].tasks.length, 1, 'a done task nobody ticked here is not shown');
});

test('ticking a body task writes - [x] into its line and tends the note, then marks the task, in one batch', () => {
  const body = ['# Beds', '- [ ] Dig the **bed**', '```', '- [ ] Dig the **bed**', '```', '- [x] Buy seeds'].join('\n');
  const key = parse(body).tasks.find(t => t.text === 'Dig the **bed**').key;
  const beds = note('gd.note.beds', 'Beds', body, 6);
  const [dig] = agenda([task('t.dig', { 'gd.task.title': 'Dig the **bed**', 'gd.task.note': 'gd.note.beds', 'gd.task.source': 'Checkbox', 'gd.task.key': key }, 3)], [beds], TODAY).groups.at(-1).tasks;
  const writes = tickWrites(dig, beds, true, TODAY);
  assert.deepEqual(writes, [
    { op: 'update', entityId: 'gd.note', recordId: 'gd.note.beds', version: 6, values: {
      'gd.note.body': ['# Beds', '- [x] Dig the **bed**', '```', '- [ ] Dig the **bed**', '```', '- [x] Buy seeds'].join('\n'), 'gd.note.touched': TODAY } },
    { op: 'update', entityId: 'gd.task', recordId: 't.dig', version: 3, values: { 'gd.task.done': true } },
  ]);
  // Unticking puts the space back, and a note tended today is not written a second date.
  const ticked = note('gd.note.beds', 'Beds', writes[0].values['gd.note.body'], 7, TODAY);
  assert.deepEqual(tickWrites({ ...dig, version: 4 }, ticked, false, TODAY)[0].values, { 'gd.note.body': body });
});

test('a task added by hand, or one its note no longer says, ticks its record alone', () => {
  const beds = note('gd.note.beds', 'Beds', '- [ ] Something else');
  const manual = { recordId: 't.call', version: 5, manual: true, key: null, noteId: 'gd.note.beds' };
  assert.deepEqual(tickWrites(manual, beds, true, TODAY), [{ op: 'update', entityId: 'gd.task', recordId: 't.call', version: 5, values: { 'gd.task.done': true } }]);
  const stale = { recordId: 't.gone', version: 2, manual: false, key: 'deadbeef', noteId: 'gd.note.beds' };
  assert.deepEqual(tickWrites(stale, beds, true, TODAY).map(w => w.entityId), ['gd.task']);
});
