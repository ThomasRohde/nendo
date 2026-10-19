import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { breakLines, spaceAfter, setLines, termesWidth, timesWidth, texText, softHyphens, balancedSplit, drawnSpaces, TEX } from '../../extensions/manuscript/typeset.mjs';
import { hyphenate } from '../../extensions/manuscript/hyphenation.mjs';
import { BIBLIOGRAPHY } from '../../extensions/manuscript/export.mjs';

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
  assert.deepEqual(spaceAfter('U.S.', space), spaceAfter('word', space), 'a capital before the stop makes it an abbreviation');
  assert.deepEqual(spaceAfter('HTML,', space), spaceAfter('word', space), 'nor does a comma or colon after a capital raise the factor past 1000');
  assert.deepEqual(spaceAfter('HTML', space).stretch, 1.25 * 0.999, 'a capital itself sets 999');
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
  // TeX's badness (tex.web §108), in scaled points and truncating integers.
  const SP = 65536 * 72.27 / 72;
  const texBadness = (t, s) => {
    t = Math.round(t * SP); s = Math.round(s * SP);
    if (t <= 0) return 0;
    if (s <= 0) return 10000;
    const r = t <= 7230584 ? Math.floor(t * 297 / s) : s >= 1663497 ? Math.floor(t / Math.floor(s / 297)) : t;
    return r > 1290 ? 10000 : Math.floor((r * r * r + 0x20000) / 0x40000);
  };
  // TeX's demerits for one set of breaks between words, counted directly; a paragraph starts as
  // if after a decent line.
  const demerits = (words, breaks, width) => {
    let total = 0, fitness = 2, start = 0;
    for (const [n, at] of [...breaks, words.length].entries()) {
      const line = words.slice(start, at), last = at === words.length;
      const natural = line.reduce((a, b) => a + b) + 2.5 * (line.length - 1);
      const stretch = 1.25 * (line.length - 1), shrink = 0.833 * (line.length - 1);
      if (natural - width > shrink + 1e-9) return Infinity;
      const badness = natural > width ? texBadness(natural - width, shrink) : last ? 0 : texBadness(width - natural, stretch);
      if (badness > TEX.tolerance) return Infinity;
      const f = natural > width ? (badness > 12 ? 3 : 2) : badness > 99 ? 0 : badness > 12 ? 1 : 2;
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

// ---------- Against TeX itself ----------

const fixture = JSON.parse(fs.readFileSync(new URL('./typeset-fixture.json', import.meta.url), 'utf8'));
const pt = x => x * 72 / 72.27;
const COLUMN = pt(242.26653);
const flat = s => s.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const linesOf = (text, kind) => {
  const size = kind === 'body' ? pt(10) : pt(9), sp = timesWidth(' ', { size });
  const lines = setLines([{ text: kind === 'body' ? softHyphens(text, hyphenate) : text, style: { size } }], {
    measure: termesWidth, space: { width: sp, stretch: sp / 2, shrink: sp / 3, extra: sp / 3 }, params: kind === 'body' ? TEX : BIBLIOGRAPHY,
    widths: kind === 'body' ? n => n === 0 ? COLUMN - pt(9.03374) : COLUMN : n => n === 0 ? COLUMN : COLUMN - pt(9) });
  return (lines ?? []).map(l => flat(l.parts.map(p => p.space === undefined ? p.text : ' ').join('') + (l.hyphen ? '-' : '')));
};

test('paragraphs break into the lines XeTeX sets them in, body text and bibliography entries alike', () => {
  for (const [n, { kind, text, lines }] of fixture.paragraphs.entries()) {
    const ours = linesOf(text, kind);
    const at = lines.findIndex((line, i) => line !== ours[i]);
    assert.ok(at < 0 && ours.length === lines.length, `${kind} paragraph ${n} parts from TeX at line ${at < 0 ? lines.length : at}:\n  TeX:  ${lines[at < 0 ? lines.length - 1 : at]}\n  ours: ${ours[at < 0 ? lines.length - 1 : at]}`);
  }
});

test('words measure as XeTeX sets them in Termes: kerned, with ligatures, TeX\'s quotes and dashes', () => {
  // Widths TeX reported (\setbox0\hbox{...}\the\wd0) at 10pt, in TeX points.
  for (const [text, width] of [['hyphenation', 49.14], ['conventions', 47.68001], ['effective', 33.97], ['Tower.', 26.55]])
    assert.ok(Math.abs(termesWidth(text, { size: pt(10) }) * 72.27 / 72 - width) < 0.005, `${text}: ${termesWidth(text, { size: pt(10) }) * 72.27 / 72} against TeX's ${width}`);
  assert.ok(termesWidth('fi', { size: 10 }) < termesWidth('f', { size: 10 }) + termesWidth('i', { size: 10 }), 'fi is a ligature');
  assert.equal(texText("it's -- ``so''"), 'it’s – “so”');
});

test('plain TeX\'s English patterns, which LaTeX loads, not hyph-utf8\'s American set', () => {
  assert.equal(hyphenate('every', { hyphenChar: '-' }), 'ev-ery');
  assert.equal(hyphenate('behaviour', { hyphenChar: '-' }), 'be-haviour');
  assert.equal(hyphenate('table', { hyphenChar: '-' }), 'ta-ble', 'Knuth\'s exceptions');
});

test('two columns balanced as revtex balances them: 22 lines and 19, not 20 and 21', () => {
  // The paper's sixteen references, their lines in order, on 13pt with a 10pt first line.
  assert.equal(balancedSplit([2, 2, 3, 4, 4, 3, 2, 2, 1, 2, 1, 6, 3, 2, 2, 2], pt(13), pt(10)), 8);
  assert.equal(balancedSplit([1, 1, 1, 1], pt(13), pt(10)), 2);
});

test('drawn in another font, each word starts where TeX starts it and a justified line still ends at its width', () => {
  const size = pt(10), sp = timesWidth(' ', { size });
  const [line] = setLines([{ text: 'Every view of the AVA table waves at a Tower over the yard and back again', style: { size } }], {
    measure: termesWidth, space: { width: sp, stretch: sp / 2, shrink: sp / 3, extra: sp / 3 }, widths: () => 200 });
  const spaces = drawnSpaces(line, timesWidth);
  let tex = 0, drawn = 0, at = 0;
  for (const part of line.parts) {
    if (part.space === undefined) {
      assert.ok(Math.abs(tex - drawn) < 1e-9 || at === spaces.length, `"${part.text}" starts ${drawn - tex} from TeX`);
      tex += termesWidth(part.text, part.piece.style); drawn += timesWidth(part.text, part.piece.style);
    } else { tex += part.space; drawn += spaces[at++]; }
  }
  assert.ok(!line.last && Math.abs(drawn + (line.hyphen ? timesWidth('-', { size }) : 0) - 200) < 1e-9, `the line ends at ${drawn}`);
});
