import test from 'node:test';
import assert from 'node:assert/strict';
import { differing, readDrafts, writeDrafts, sortDrafts, withoutWritten } from '../../extensions/deck/drafts.mjs';

const record = (version, values) => ({ version, values });
const entry = (recordId, version, values, entityId = 'dk.slide') => ({ entityId, recordId, version, values });

test('drafts go through storage and back; another format reads as none', () => {
  const entries = [entry('s1', 3, { 'dk.slide.title': 'Mine' })];
  assert.deepEqual(readDrafts(writeDrafts(entries)), entries);
  assert.equal(writeDrafts([]), null);
  for (const text of [null, 'not json', '{"s1":{"title":"old format"}}', '{"format":2,"entries":[{"recordId":"s1"}]}'])
    assert.deepEqual(readDrafts(text), [], String(text));
});

test('a draft on the version it was typed over is fresh; one on a newer version is held', () => {
  const now = { s1: record(3, { 'dk.slide.title': 'Theirs' }), s2: record(5, { 'dk.slide.title': 'Theirs' }) };
  const { fresh, stale } = sortDrafts([entry('s1', 3, { 'dk.slide.title': 'Mine' }), entry('s2', 4, { 'dk.slide.title': 'Mine' })], (_, id) => now[id] ?? null);
  assert.deepEqual(fresh.map(e => e.recordId), ['s1']);
  assert.deepEqual(stale.map(e => e.recordId), ['s2']);
});

test('a draft the record already holds, or whose record is gone, drops out; only differing values stay', () => {
  const now = { s1: record(4, { 'dk.slide.title': 'Mine', 'dk.slide.body': 'Old' }) };
  const { fresh, stale } = sortDrafts([entry('s1', 4, { 'dk.slide.title': 'Mine', 'dk.slide.body': 'New' }), entry('s9', 1, { 'dk.slide.title': 'x' }), entry('s1', 4, { 'dk.slide.title': 'Mine' }, 'dk.deck')],
    (entityId, id) => entityId === 'dk.slide' ? now[id] ?? null : record(4, { 'dk.slide.title': 'Mine' }));
  assert.deepEqual(fresh, [entry('s1', 4, { 'dk.slide.body': 'New' })]);
  assert.deepEqual(stale, []);
  assert.deepEqual(differing({ a: '', b: null }, record(1, { a: '' })), {});
});

test('two drafts of one record become one: the later typing wins over the earliest version', () => {
  const now = { s1: record(2, { 'dk.slide.title': 'Theirs' }) };
  const { fresh, stale } = sortDrafts([entry('s1', 2, { 'dk.slide.title': 'Held', 'dk.slide.body': 'Held body' }), entry('s1', 3, { 'dk.slide.title': 'Newer' })], (_, id) => now[id]);
  assert.deepEqual(fresh, [entry('s1', 2, { 'dk.slide.title': 'Newer', 'dk.slide.body': 'Held body' })]);
  assert.deepEqual(stale, []);
});

test('a save that lands takes its fields out of what is held for that record', () => {
  const held = [entry('s1', 2, { 'dk.slide.title': 'Old', 'dk.slide.body': 'Old' }), entry('s2', 2, { 'dk.slide.title': 'Other' })];
  assert.deepEqual(withoutWritten(held, 'dk.slide', 's1', { 'dk.slide.title': 'New' }), [entry('s1', 2, { 'dk.slide.body': 'Old' }), held[1]]);
  assert.deepEqual(withoutWritten(held, 'dk.slide', 's2', { 'dk.slide.title': 'New' }), [held[0]]);
});
