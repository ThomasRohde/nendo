import assert from 'node:assert/strict';
import test from 'node:test';
import { breakLines, spaceAfter, TEX } from '../../extensions/manuscript/typeset.mjs';

const space = { width: 2.5, stretch: 1.25, shrink: 0.833, extra: 0.833 };
const box = width => ({ type: 'box', width });
const glue = () => ({ type: 'glue', width: 2.5, stretch: 1.25, shrink: 0.833 });
const end = [{ type: 'glue', width: 0, stretch: 0, shrink: 0, fil: true }, { type: 'penalty', width: 0, penalty: -10000 }];
const paragraph = widths => [...widths.flatMap((w, i) => i ? [glue(), box(w)] : [box(w)]), ...end];
// The words of each line, from the breaks: how many boxes lie between them.
const lines = (items, breaks) => {
  const out = []; let start = 0;
  for (const b of breaks) { out.push(items.slice(start, b).filter(i => i.type === 'box').length); start = b + 1; }
  return out;
};

test('the space after a word, as plain TeX sets it: a sentence\'s end wider and looser, an abbreviation not', () => {
  assert.deepEqual(spaceAfter('word', space), { type: 'glue', width: 2.5, stretch: 1.25, shrink: 0.833 });
  const stop = spaceAfter('end.', space);
  assert.equal(stop.width, 2.5 + 0.833); assert.equal(stop.stretch, 3.75); assert.ok(Math.abs(stop.shrink - 0.833 / 3) < 1e-9);
  assert.deepEqual(spaceAfter('U.S.', space), spaceAfter('A', space), 'a capital before the stop makes it an abbreviation');
  assert.equal(spaceAfter('end.)', space).width, stop.width, 'a closing bracket is transparent');
  assert.ok(Math.abs(spaceAfter('list,', space).shrink - 0.833 / 1.25) < 1e-9);
  assert.equal(spaceAfter('as:', space).width, 2.5 + 0.833, 'a colon adds the extra space too');
});

test('lines break where they fit, the last one filled by \\parfillskip', () => {
  // Ten words of 10 points with 2.5-point spaces in a 35-point line: three words to a line.
  const items = paragraph(Array(10).fill(10));
  const breaks = breakLines(items, () => 35);
  assert.deepEqual(lines(items, breaks), [3, 3, 3, 1]);
});

test('the whole paragraph is weighed: the breaks of least demerits, as trying every set of breaks finds', () => {
  // TeX's demerits for one set of breaks between words, counted directly.
  const demerits = (words, breaks, width) => {
    let total = 0, fitness = 1, start = 0;
    for (const [n, at] of [...breaks, words.length].entries()) {
      const line = words.slice(start, at), last = at === words.length;
      const natural = line.reduce((a, b) => a + b) + 2.5 * (line.length - 1);
      const stretch = 1.25 * (line.length - 1), shrink = 0.833 * (line.length - 1);
      const ratio = last ? (natural > width ? (width - natural) / shrink : 0) : natural < width ? (width - natural) / stretch : natural > width ? (width - natural) / shrink : 0;
      if (!(ratio >= -1)) return Infinity;
      const badness = Number.isFinite(ratio) ? Math.min(10000, Math.round(100 * Math.abs(ratio) ** 3)) : 10000;
      if (badness > TEX.tolerance) return Infinity;
      const f = ratio < -0.5 ? 3 : badness <= 12 ? 2 : ratio > 0 && badness >= 100 ? 0 : 1;
      total += (TEX.linepenalty + badness) ** 2 + (Math.abs(f - fitness) > 1 ? TEX.adjdemerits : 0);
      fitness = f; start = at; void n;
    }
    return total;
  };
  let random = 7;
  const next = () => (random = (random * 48271) % 2147483647) / 2147483647;
  for (let trial = 0; trial < 200; trial++) {
    const words = Array.from({ length: 4 + Math.floor(next() * 5) }, () => 5 + Math.round(next() * 20));
    const width = 40 + Math.round(next() * 30);
    let best = Infinity;
    for (let mask = 0; mask < 2 ** (words.length - 1); mask++) {
      const breaks = words.slice(1).map((_, i) => i + 1).filter((_, i) => mask & (1 << i));
      best = Math.min(best, demerits(words, breaks, width));
    }
    const items = paragraph(words), found = breakLines(items, () => width);
    if (!Number.isFinite(best)) { assert.equal(found, null, `${words} in ${width}`); continue; }
    // Back from item indices to word indices: the glue after word k is item 2k + 1.
    const breaks = found.slice(0, -1).map(at => (at + 1) / 2);
    assert.equal(demerits(words, breaks, width), best, `${words} in ${width}: ${breaks}`);
  }
});

test('a hyphen is used only in the second pass, and a box wider than the line breaks nothing', () => {
  // A word that only fits split: its soft hyphen is a break the first pass may not take.
  const items = [box(20), glue(), box(15), { type: 'penalty', width: 3, penalty: TEX.hyphenpenalty, flagged: true, soft: true }, box(15), ...end];
  assert.equal(breakLines(items, () => 42, { ...TEX, tolerance: TEX.pretolerance }, false), null);
  const breaks = breakLines(items, () => 42, TEX, true);
  assert.equal(breaks[0], 3, 'the line ends at the hyphen');
  assert.equal(breakLines([box(50), ...end], () => 40), null);
});
