import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { version, fitBox, toneFor } from './nendo-view-kit.js';

// The view kit is one versioned file that packages copy. A copy that drifts from the
// source is a package carrying an older kit than its name says, so every copy is checked: every
// extensions/<package>/kit/nendo-view-kit.js there is, found rather than listed, so a
// package that copies the kit is checked from the day it does. NENDO_PACKAGES_ROOT names another
// repository whose packages to check, such as nendo-apps (ADR-0040), and NENDO_PACKAGES_KNOWN the
// copies it must find.
const source = readFileSync(new URL('./nendo-view-kit.js', import.meta.url));
const repository = process.env.NENDO_PACKAGES_ROOT ? pathToFileURL(path.resolve(process.env.NENDO_PACKAGES_ROOT) + path.sep) : new URL('../../', import.meta.url);
const extensions = new URL('extensions/', repository);
const known = (process.env.NENDO_PACKAGES_ROOT ? process.env.NENDO_PACKAGES_KNOWN ?? '' : process.env.NENDO_PACKAGES_KNOWN)?.split(',').filter(name => name.endsWith('nendo-view-kit.js')) ?? ['extensions/systems-lens/kit/nendo-view-kit.js'];
const copies = readdirSync(extensions, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(new URL(`${entry.name}/kit/nendo-view-kit.js`, extensions)))
  .map(entry => `extensions/${entry.name}/kit/nendo-view-kit.js`).sort();

test('the kit says its version, and every copy a package carries is the kit byte for byte', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(source.toString('utf8').includes(`Nendo view kit ${version}`), 'the header does not name the version the file exports');
  assert.ok(known.length > 0 && known.every(copy => copies.includes(copy)),
    `the search for kit copies did not find every one known (${JSON.stringify(known)}; NENDO_PACKAGES_KNOWN names them for another repository): ` + JSON.stringify(copies));
  for (const copy of copies) {
    assert.ok(readFileSync(new URL(copy, repository)).equals(source), `${copy} is not the kit in tools/view-kit: copy it again`);
  }
});

test('fitBox centres a drawing within its padding and never divides by nothing', () => {
  const fit = fitBox({ x: 100, y: 50, width: 400, height: 200 }, { width: 832, height: 432 }, 16);
  assert.equal(fit.scale, 2);
  assert.deepEqual([fit.x, fit.y], [16 - 200, 16 - 100]);
});

test('fitBox draws a single point in the middle of the frame, and from the padding in an unsized one', () => {
  // A drawing that is one point at (10, 20) lands at the frame's centre, not in its padding corner.
  const point = fitBox({ x: 10, y: 20, width: 0, height: 0 }, { width: 100, height: 80 }, 16);
  assert.equal(point.scale, 1);
  assert.deepEqual([point.x + 10, point.y + 20], [50, 40], `a single point is drawn at ${point.x + 10},${point.y + 20}, not at the frame's centre 50,40`);
  // A frame not sized yet has no centre: the point is drawn from the padding, at scale 1.
  assert.deepEqual(fitBox({ x: 10, y: 20, width: 0, height: 0 }, { width: 0, height: 0 }, 16), { scale: 1, x: 6, y: -4 });
});

test('fitBox fits a drawing flat in one direction by the other, centred on where it is', () => {
  // A row of points from x 100 to 900 at y 50, in a 400x300 frame: it spans the frame between
  // its paddings, rather than being drawn from x 116 to 916, mostly off-screen.
  const fit = fitBox({ x: 100, y: 50, width: 800, height: 0 }, { width: 400, height: 300 }, 16);
  const left = fit.x + 100 * fit.scale, right = fit.x + 900 * fit.scale, row = fit.y + 50 * fit.scale;
  assert.ok(Math.abs(left - 16) < 1e-9 && Math.abs(right - 384) < 1e-9,
    `a drawing with no height is not fitted across the frame: it runs from ${left} to ${right}, not 16 to 384 (${JSON.stringify(fit)})`);
  assert.ok(Math.abs(row - 150) < 1e-9, `a drawing with no height is not centred vertically: its row is at ${row}, not 150`);
});

test('fitBox never returns a scale that mirrors the drawing, in a small or a hidden frame', () => {
  const small = fitBox({ x: 0, y: 0, width: 100, height: 100 }, { width: 20, height: 20 }, 16);
  assert.ok(small.scale > 0, `a frame smaller than its padding gave the scale ${small.scale}, which mirrors the drawing`);
  const hidden = fitBox({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 }, 16);
  assert.ok(hidden.scale > 0, `a hidden frame (0x0) gave the scale ${hidden.scale}, which mirrors the drawing`);
  assert.equal(hidden.scale, 1, 'a frame not sized yet has nothing to fit into, so the scale stays 1');
});

test('toneFor reads a choice by ID or name, and is grey for anything else', () => {
  const choices = [{ id: 'live', displayName: 'Live', tone: 'teal' }, { id: 'draft', displayName: 'Draft', tone: null }];
  assert.equal(toneFor('live', choices), 'var(--nendo-tone-teal)');
  assert.equal(toneFor('Live', choices), 'var(--nendo-tone-teal)');
  assert.equal(toneFor('draft', choices), 'var(--nendo-tone-grey)');
  assert.equal(toneFor('unknown', choices), 'var(--nendo-tone-grey)');
});
