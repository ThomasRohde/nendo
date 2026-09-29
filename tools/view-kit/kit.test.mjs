import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { version, fitBox, toneFor } from './nendo-view-kit.js';

// W-064: the view kit is one versioned file that packages copy. A copy that drifts from the
// source is a package carrying an older kit than its name says, so every copy is checked.
const source = readFileSync(new URL('./nendo-view-kit.js', import.meta.url));
const copies = ['../../extensions/gantt/kit/nendo-view-kit.js', '../../extensions/archi/kit/nendo-view-kit.js'];

test('the kit says its version, and every copy a package carries is the kit byte for byte', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(source.toString('utf8').includes(`Nendo view kit ${version}`), 'the header does not name the version the file exports');
  for (const copy of copies) {
    assert.ok(readFileSync(new URL(copy, import.meta.url)).equals(source), `${copy} is not the kit in tools/view-kit: copy it again`);
  }
});

test('fitBox centres a drawing within its padding and never divides by nothing', () => {
  const fit = fitBox({ x: 100, y: 50, width: 400, height: 200 }, { width: 832, height: 432 }, 16);
  assert.equal(fit.scale, 2);
  assert.deepEqual([fit.x, fit.y], [16 - 200, 16 - 100]);
  assert.deepEqual(fitBox({ x: 0, y: 0, width: 0, height: 0 }, { width: 100, height: 100 }), { scale: 1, x: 16, y: 16 });
});

test('toneFor reads a choice by ID or name, and is grey for anything else', () => {
  const choices = [{ id: 'live', displayName: 'Live', tone: 'teal' }, { id: 'draft', displayName: 'Draft', tone: null }];
  assert.equal(toneFor('live', choices), 'var(--nendo-tone-teal)');
  assert.equal(toneFor('Live', choices), 'var(--nendo-tone-teal)');
  assert.equal(toneFor('draft', choices), 'var(--nendo-tone-grey)');
  assert.equal(toneFor('unknown', choices), 'var(--nendo-tone-grey)');
});
