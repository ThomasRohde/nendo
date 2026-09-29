import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { northstarCsv } from './northstar-csv.mjs';

// The Engine imports northstar-capabilities.csv as a lane (W-075). That lane only means
// something while the file is the Northstar model, so this fails the moment they part.
test('the committed Northstar CSV is the model, parents named by code', () => {
  const committed = readFileSync(new URL('./northstar-capabilities.csv', import.meta.url), 'utf8');
  assert.equal(committed, northstarCsv(), 'northstar-capabilities.csv is stale: run node tools/bcm-atlas/northstar-csv.mjs');
  const rows = committed.trimEnd().split('\n').slice(1);
  assert.equal(rows.length, 635);
  assert.ok(rows.every((row) => !row.includes('bcm-cap-')), 'a parent is named by a record ID, not a code');
});
