import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../extensions/garden/parse.mjs';
import { plan, F, BODY_BYTES } from '../../extensions/garden/sync.mjs';

const today = '2026-10-06';
let n = 0;
const newId = (entity, hint) => `${entity}.${hint}-${++n}`;
const index = [
  { recordId: 'gd.note.start-here', version: 3, slug: 'start-here', title: 'Start here' },
  { recordId: 'gd.note.how-links-work', version: 2, slug: 'how-links-work', title: 'How links work' },
];
const note = { recordId: 'gd.note.start-here', version: 3, values: { [F.note.title]: 'Start here', [F.note.slug]: 'start-here', [F.note.body]: 'old', [F.note.pinned]: true, [F.note.touched]: '2026-10-01' } };
const tags = [{ recordId: 'gd.tag.garden', version: 1, values: { [F.tag.name]: 'garden' } }];
const row = (entityId, recordId, values, version = 1) => ({ entityId, recordId, version, values });
const save = (body, existing = {}, extra = {}) => plan({ note, title: 'Start here', body, parsed: parse(body), index, existing, tags, today, newId, ...extra });
const ofType = (writes, entityId, op) => writes.filter(w => w.entityId === entityId && (!op || w.op === op));

test('a save writes the note, plants a stub for an unknown link, links with context, tags and tasks, in one batch', () => {
  const body = 'Read [[How links work]] and [[A brand new note]]. #garden #planted\n- [ ] Water the seeds';
  const { writes, problems, stubs } = save(body);
  assert.deepEqual(problems, []);
  const noteWrite = writes[0];
  assert.equal(noteWrite.op, 'update');
  assert.deepEqual(noteWrite.values, { [F.note.body]: body, [F.note.touched]: today });
  assert.equal(stubs.length, 1);
  const stub = ofType(writes, 'gd.note', 'create')[0];
  assert.deepEqual(stub.values, { [F.note.title]: 'A brand new note', [F.note.slug]: 'a-brand-new-note', [F.note.kind]: 'Note', [F.note.stage]: 'Seed', [F.note.pinned]: false, [F.note.touched]: today });
  const links = ofType(writes, 'gd.link', 'create');
  assert.equal(links.length, 2);
  const known = links.find(l => l.values[F.link.to] === 'gd.note.how-links-work');
  assert.equal(known.values[F.link.kind], 'Mentions');
  assert.equal(known.values[F.link.source], 'Body');
  assert.ok(known.values[F.link.context].includes('[[How links work]]'));
  assert.deepEqual(known.targetVersions, { [F.link.to]: 2 }, 'the note was written earlier in the batch, so only the target carries a version');
  const toStub = links.find(l => l.values[F.link.to] === stub.recordId);
  assert.equal(toStub.targetVersions, undefined, 'a reference to a record created in the batch carries no version');
  assert.deepEqual(ofType(writes, 'gd.tag', 'create').map(w => [w.recordId, w.values[F.tag.name]]), [['gd.tag.planted', 'planted']]);
  const noteTags = ofType(writes, 'gd.noteTag', 'create');
  assert.deepEqual(noteTags.map(w => w.values[F.noteTag.tag]).sort(), ['gd.tag.garden', 'gd.tag.planted']);
  assert.deepEqual(noteTags.find(w => w.values[F.noteTag.tag] === 'gd.tag.garden').targetVersions, { [F.noteTag.tag]: 1 });
  const tasks = ofType(writes, 'gd.task', 'create');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].values[F.task.title], 'Water the seeds');
  assert.equal(tasks[0].values[F.task.done], false);
  assert.equal(tasks[0].values[F.task.source], 'Checkbox');
  assert.ok(writes.indexOf(stub) < writes.indexOf(toStub), 'the stub is written before the link that points at it');
  assert.ok(writes.indexOf(noteWrite) === 0);
});

test('a link the body no longer says is deleted; a Manual link and a Manual tag are never touched', () => {
  const existing = {
    links: [
      row('gd.link', 'gd.link.body1', { [F.link.from]: 'gd.note.start-here', [F.link.to]: 'gd.note.how-links-work', [F.link.source]: 'Body', [F.link.context]: 'x' }, 4),
      row('gd.link', 'gd.link.manual1', { [F.link.from]: 'gd.note.start-here', [F.link.to]: 'gd.note.how-links-work', [F.link.source]: 'Manual', [F.link.kind]: 'See also' }, 1),
    ],
    noteTags: [row('gd.noteTag', 'gd.noteTag.manual', { [F.noteTag.note]: 'gd.note.start-here', [F.noteTag.tag]: 'gd.tag.garden', [F.noteTag.source]: 'Manual' })],
  };
  const { writes } = save('No links any more.', existing);
  assert.deepEqual(ofType(writes, 'gd.link'), [{ op: 'delete', entityId: 'gd.link', recordId: 'gd.link.body1', version: 4 }]);
  assert.deepEqual(ofType(writes, 'gd.noteTag'), []);
  assert.ok(!writes.some(w => w.recordId === 'gd.link.manual1'), 'the Manual link was touched');
  const kept = save('Still [[how-links-work]] here.', existing);
  assert.deepEqual(ofType(kept.writes, 'gd.link'), [{ op: 'update', entityId: 'gd.link', recordId: 'gd.link.body1', version: 4, values: { [F.link.context]: 'Still [[how-links-work]] here.' } }]);
});

test('ticking a checkbox updates the same task record, matched by key, rather than making a new one', () => {
  const key = parse('- [ ] Water the seeds').tasks[0].key;
  const existing = { tasks: [row('gd.task', 'gd.task.t1', { [F.task.title]: 'Water the seeds', [F.task.note]: 'gd.note.start-here', [F.task.done]: false, [F.task.source]: 'Checkbox', [F.task.key]: key }, 2)] };
  const { writes } = save('- [x] Water the seeds', existing);
  assert.deepEqual(ofType(writes, 'gd.task'), [{ op: 'update', entityId: 'gd.task', recordId: 'gd.task.t1', version: 2, values: { [F.task.done]: true } }]);
  const gone = save('Nothing to do.', existing);
  assert.deepEqual(ofType(gone.writes, 'gd.task'), [{ op: 'delete', entityId: 'gd.task', recordId: 'gd.task.t1', version: 2 }]);
  const manual = { tasks: [row('gd.task', 'gd.task.m', { [F.task.title]: 'By hand', [F.task.note]: 'gd.note.start-here', [F.task.done]: false, [F.task.source]: 'Manual' })] };
  assert.deepEqual(ofType(save('Nothing.', manual).writes, 'gd.task'), [], 'a Manual task is the person\'s');
});

test('a new note is created first, with a slug no other note has, and its rows point at it without versions', () => {
  const { writes } = plan({ note: null, title: 'Start here', body: 'Link to [[start-here]]. #garden', parsed: parse('Link to [[start-here]]. #garden'), index, tags, today, newId });
  assert.equal(writes[0].op, 'create');
  assert.equal(writes[0].entityId, 'gd.note');
  assert.equal(writes[0].values[F.note.slug], 'start-here-2');
  const link = ofType(writes, 'gd.link', 'create')[0];
  assert.deepEqual(link.targetVersions, { [F.link.to]: 3 });
  assert.equal(link.values[F.link.from], writes[0].recordId);
  assert.equal(ofType(writes, 'gd.noteTag', 'create')[0].targetVersions[F.noteTag.note], undefined);
});

test('a self-link makes no link, and an unchanged note makes no writes at all', () => {
  const same = { ...note, values: { ...note.values, [F.note.body]: 'Me: [[start-here]]', [F.note.touched]: today } };
  const { writes } = plan({ note: same, title: 'Start here', body: 'Me: [[start-here]]', parsed: parse('Me: [[start-here]]'), index, existing: {}, tags, today, newId });
  assert.deepEqual(writes, []);
});

test('a body past the MCP value bound, or a save past 200 writes, is refused whole', () => {
  const big = save('x'.repeat(BODY_BYTES + 1));
  assert.deepEqual(big.writes, []);
  assert.match(big.problems[0], /32,768/);
  const many = save(Array.from({ length: 201 }, (_, i) => `- [ ] task ${i}`).join('\n'));
  assert.deepEqual(many.writes, []);
  assert.match(many.problems[0], /at most 200/);
  assert.match(save('x', {}, { title: '  ' }).problems[0], /needs a title/);
});
