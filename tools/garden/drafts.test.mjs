import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, uncertain, readDrafts, writeDrafts, DRAFT_LIMITS } from '../../extensions/garden/drafts.mjs';

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
  const drafts = new Map([['gd.note.a', { title: 'A', body: 'alpha', version: 3, at: 2 }], ['new', { title: '', body: 'fresh', version: null, values: { 'gd.note.kind': 'Daily' }, at: 1 }]]);
  assert.equal(writeDrafts(storage, 'k', drafts), 2);
  const back = readDrafts(storage, 'k');
  assert.deepEqual([...back.keys()], ['gd.note.a', 'new']);
  assert.equal(back.get('gd.note.a').body, 'alpha');
  assert.equal(back.get('gd.note.a').version, 3);
  assert.deepEqual(back.get('new').values, { 'gd.note.kind': 'Daily' });
  assert.equal(readDrafts(memory(), 'k').size, 0);
  storage.setItem('k', '{not json');
  assert.equal(readDrafts(storage, 'k').size, 0);
  assert.equal(readDrafts(null, 'k').size, 0);
});

test('past the bound the oldest drafts go, and an empty set clears the key', () => {
  const storage = memory();
  const many = new Map(Array.from({ length: DRAFT_LIMITS.count + 5 }, (_, i) => [`gd.note.${i}`, { title: `${i}`, body: 'x', version: 1, at: i }]));
  assert.equal(writeDrafts(storage, 'k', many), DRAFT_LIMITS.count);
  const kept = readDrafts(storage, 'k');
  assert.equal(kept.has(`gd.note.${DRAFT_LIMITS.count + 4}`), true, 'the newest is kept');
  assert.equal(kept.has('gd.note.0'), false, 'the oldest goes');
  const huge = new Map([['gd.note.big', { title: 'big', body: 'y'.repeat(DRAFT_LIMITS.characters), version: 1, at: 9 }], ['gd.note.small', { title: 's', body: 'z', version: 1, at: 1 }]]);
  assert.equal(writeDrafts(storage, 'k', huge), 1, 'a draft over the bound is not kept, the rest are');
  assert.equal(readDrafts(storage, 'k').has('gd.note.small'), true);
  assert.equal(writeDrafts(storage, 'k', new Map()), 0);
  assert.equal(storage.items.has('k'), false);
});

test('storage that refuses a write keeps the view working', () => {
  const refusing = { getItem: () => null, setItem: () => { throw Error('quota'); }, removeItem: () => {} };
  assert.equal(writeDrafts(refusing, 'k', new Map([['a', { title: 'a', body: 'b', at: 1 }]])), null);
});
