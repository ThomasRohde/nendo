import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, uncertain, readDrafts, writeDrafts, readUnanswered, writeUnanswered, DRAFT_LIMITS } from '../../extensions/garden/drafts.mjs';

// The day is the person's: the formatter is checked under three zones, each set before the date
// is read, around midnight and across a change of daylight saving time.
function inZone(zone, run) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try { return run(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

test('Today is the local calendar day just after local midnight, east of UTC', () => {
  // 2026-10-07 00:30 in Copenhagen is still 2026-10-06 in UTC.
  const instant = new Date('2026-10-06T22:30:00Z');
  assert.equal(inZone('Europe/Copenhagen', () => localDate(instant)), '2026-10-07');
});

test('Today is the local calendar day just before local midnight, west of UTC', () => {
  // 2026-10-06 23:30 in Los Angeles is already 2026-10-07 in UTC.
  const instant = new Date('2026-10-07T06:30:00Z');
  assert.equal(inZone('America/Los_Angeles', () => localDate(instant)), '2026-10-06');
});

test('Today follows the local day across the end of daylight saving time', () => {
  // Copenhagen leaves summer time at 01:00 UTC on 2026-10-25; both sides are the 25th locally.
  assert.equal(inZone('Europe/Copenhagen', () => localDate(new Date('2026-10-24T22:30:00Z'))), '2026-10-25');
  assert.equal(inZone('Europe/Copenhagen', () => localDate(new Date('2026-10-25T22:59:00Z'))), '2026-10-25');
  assert.equal(inZone('Europe/Copenhagen', () => localDate(new Date('2026-10-25T23:00:00Z'))), '2026-10-26');
});

test('a timeout or a reconnect may have been kept; a refusal was not', () => {
  assert.equal(uncertain({ code: 'host-timeout' }), true);
  assert.equal(uncertain({ code: 'disconnected' }), true);
  assert.equal(uncertain({ code: 'record-version-conflict' }), false);
  assert.equal(uncertain(undefined), false);
});

function memory() {
  const items = new Map();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: key => items.delete(key) };
}

test('drafts come back as they were kept, by note, and none from storage that holds nothing or nonsense', () => {
  const storage = memory();
  const drafts = new Map([['gd.note.a', { title: 'A', body: 'alpha', version: 3, hash: '0badf00d', at: 2 }], ['new:1', { title: '', body: 'fresh', version: null, values: { 'gd.note.kind': 'Daily' }, at: 1 }]]);
  assert.deepEqual(writeDrafts(storage, 'k', drafts), { kept: 2, dropped: [], refused: false });
  const back = readDrafts(storage, 'k');
  assert.deepEqual([...back.keys()], ['gd.note.a', 'new:1']);
  assert.equal(back.get('gd.note.a').body, 'alpha');
  assert.equal(back.get('gd.note.a').version, 3);
  assert.equal(back.get('gd.note.a').hash, '0badf00d');
  assert.deepEqual(back.get('new:1').values, { 'gd.note.kind': 'Daily' });
  assert.equal(readDrafts(memory(), 'k').size, 0);
  storage.setItem('k', '{not json');
  assert.equal(readDrafts(storage, 'k').size, 0);
  assert.equal(readDrafts(null, 'k').size, 0);
});

test('past the bound the oldest drafts are not kept, and each one not kept is named (G-001)', () => {
  const storage = memory();
  const many = new Map(Array.from({ length: DRAFT_LIMITS.count + 5 }, (_, i) => [`gd.note.${i}`, { title: `${i}`, body: 'x', version: 1, at: i }]));
  const counted = writeDrafts(storage, 'k', many);
  assert.deepEqual(counted, { kept: DRAFT_LIMITS.count, dropped: ['gd.note.4', 'gd.note.3', 'gd.note.2', 'gd.note.1', 'gd.note.0'], refused: false });
  const kept = readDrafts(storage, 'k');
  assert.equal(kept.has(`gd.note.${DRAFT_LIMITS.count + 4}`), true, 'the newest is kept');
  assert.equal(kept.has('gd.note.0'), false, 'the oldest goes');
  const huge = new Map([['gd.note.big', { title: 'big', body: 'y'.repeat(DRAFT_LIMITS.characters), version: 1, at: 9 }], ['gd.note.small', { title: 's', body: 'z', version: 1, at: 1 }]]);
  assert.deepEqual(writeDrafts(storage, 'k', huge), { kept: 1, dropped: ['gd.note.big'], refused: false }, 'a draft over the bound is named, the rest are kept');
  assert.equal(readDrafts(storage, 'k').has('gd.note.small'), true);
  assert.deepEqual(writeDrafts(storage, 'k', new Map()), { kept: 0, dropped: [], refused: false });
  assert.equal(storage.items.has('k'), false);
  // A body at the 32 KiB a note may hold: twenty of them fit.
  const full = new Map(Array.from({ length: 20 }, (_, i) => [`gd.note.f${i}`, { title: `${i}`, body: 'é'.repeat(16 * 1024), version: 1, at: i }]));
  assert.deepEqual(writeDrafts(storage, 'k', full).dropped, []);
});

test('storage that refuses a write names every draft and leaves no stale copy to come back (G-001)', () => {
  const stale = memory();
  stale.setItem('k', JSON.stringify([{ id: 'gd.note.old', title: 'old', body: 'old', version: 1, at: 1 }]));
  const refusing = { ...stale, setItem: () => { throw Error('quota'); } };
  assert.deepEqual(writeDrafts(refusing, 'k', new Map([['a', { title: 'a', body: 'b', at: 2 }], ['new:x', { title: '', body: 'c', at: 1 }]])), { kept: 0, dropped: ['a', 'new:x'], refused: true });
  assert.equal(stale.items.has('k'), false, 'the older copy is removed');
  assert.deepEqual(writeDrafts(null, 'k', new Map([['a', { title: 'a', body: 'b', at: 1 }]])), { kept: 0, dropped: ['a'], refused: true }, 'no storage keeps nothing, and says so');
});

test('a save Nendo never answered is kept as it was sent, and let go with null (G-008)', () => {
  const storage = memory();
  const sent = { draftKey: 'new:abc', noteId: null, title: 'Unanswered', body: 'b', writes: [{ op: 'create', entityId: 'gd.note', recordId: 'gd.note.x', values: {} }], stubs: [], label: 'Save Unanswered', writeKey: 'k-1', draft: { not: 'kept' } };
  assert.equal(writeUnanswered(storage, 'u', sent), true);
  const back = readUnanswered(storage, 'u');
  assert.deepEqual([back.draftKey, back.writeKey, back.writes, back.title, back.draft], ['new:abc', 'k-1', sent.writes, 'Unanswered', undefined]);
  writeUnanswered(storage, 'u', null);
  assert.equal(readUnanswered(storage, 'u'), null);
  storage.setItem('u', '{"writes":"nonsense"}');
  assert.equal(readUnanswered(storage, 'u'), null);
});
