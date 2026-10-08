import test from 'node:test';
import assert from 'node:assert/strict';
import { tend, quietFor, SPANS, DEFAULT_SPAN } from '../../extensions/garden/tend.mjs';

const TODAY = '2026-10-08';
const note = (recordId, stage, touched, body = 'Some words.', kind = 'Note') =>
  ({ recordId, version: 1, values: { 'gd.note.title': recordId.replace('gd.note.', ''), 'gd.note.stage': stage, 'gd.note.touched': touched, 'gd.note.body': body, 'gd.note.kind': kind } });

test('Tend asks for seeds and growing notes untended for the span, the longest first, and the notes not written yet', () => {
  const notes = [
    note('gd.note.fresh', 'Seed', '2026-10-05'),
    note('gd.note.quiet', 'Growing', '2026-09-20'),
    note('gd.note.older', 'Seed', '2026-08-01'),
    note('gd.note.never', 'Growing', null),
    note('gd.note.grown', 'Evergreen', '2026-01-01'),
    note('gd.note.day', 'Seed', '2026-07-01', 'What happened.', 'Daily'),
    note('gd.note.stub', 'Seed', '2026-10-07', ''),
    note('gd.note.blank', 'Seed', '2026-09-01', '  \n'),
  ];
  const { quiet, empty } = tend(notes, TODAY, 14);
  assert.deepEqual(quiet.map(item => item.id), ['gd.note.never', 'gd.note.older', 'gd.note.quiet']);
  assert.deepEqual(quiet.map(item => item.days), [null, 68, 18]);
  assert.deepEqual(empty.map(item => item.id), ['gd.note.blank', 'gd.note.stub'], 'the longest waiting first; evergreen and daily notes are never asked for');
  assert.deepEqual(tend(notes, TODAY, 30).quiet.map(item => item.id), ['gd.note.never', 'gd.note.older'], 'a longer span asks for fewer');
  assert.equal(quiet[2].excerpt, 'Some words.');
});

test('how long a note has waited, in words', () => {
  assert.deepEqual([null, 0, 1, 13, 14, 59, 60, 400, 800].map(quietFor),
    ['never tended', '0 days', '1 day', '13 days', '2 weeks', '8 weeks', '2 months', '13 months', '2 years']);
  assert.ok(SPANS.some(span => span.days === DEFAULT_SPAN));
});
