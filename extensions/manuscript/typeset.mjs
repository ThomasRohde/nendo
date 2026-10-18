// Where TeX breaks a paragraph into lines, for the paper's preview (W-293): Knuth and Plass's
// total-fit algorithm over boxes, glue and penalties, with the parameters the AASTeX reference
// sets. Pure: the view measures the words and draws the lines (tools/manus/typeset.test.mjs).

/** What the reference's TeX sets: AASTeX's tolerance and the plain penalties and demerits. */
export const TEX = { pretolerance: 100, tolerance: 9999, hyphenpenalty: 50, exhyphenpenalty: 50, linepenalty: 10,
  adjdemerits: 10000, doublehyphendemerits: 10000, finalhyphendemerits: 5000 };

const INFINITE = 10000;

/**
 * The glue TeX puts after a character, from its space factor with plain TeX's sfcodes (LaTeX's
 * \nonfrenchspacing): wider and more stretchable after a sentence's end or a colon, less
 * shrinkable after a comma or semicolon; a capital before the stop makes it an abbreviation.
 * `space` is {width, stretch, shrink, extra} for the type.
 */
export function spaceAfter(text, space) {
  let factor = 1000;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (/[)\]’'”"]/.test(c)) continue;            // transparent: the factor of what is before
    factor = /[.?!]/.test(c) ? (/[A-Z]/.test(text[i - 1] ?? '') ? 999 : 3000) : c === ':' ? 2000 : c === ';' ? 1500 : c === ',' ? 1250 : /[A-Z]/.test(c) ? 999 : 1000;
    break;
  }
  return { type: 'glue', width: space.width + (factor >= 2000 ? space.extra : 0), stretch: space.stretch * factor / 1000, shrink: space.shrink * 1000 / factor };
}

/**
 * Breaks a list of items into lines: boxes {type:'box', width}, glue {type:'glue', width,
 * stretch, shrink} and penalties {type:'penalty', width, penalty, flagged}, ending with TeX's
 * \parfillskip and a forced break; a penalty marked `soft` is a hyphenation point, which TeX's
 * first pass (`hyphenate` false) does not use. `widths(n)` is the width of line n (0 first).
 * Returns the indices of the breaks, or null when no sequence of breaks fits.
 */
export function breakLines(items, widths, { tolerance, linepenalty, adjdemerits, doublehyphendemerits, finalhyphendemerits } = TEX, hyphenate = true) {
  // Running sums of width, stretch and shrink up to each item, so a line's sums are differences.
  const sum = [{ width: 0, stretch: 0, shrink: 0, fil: 0 }];
  for (const item of items) {
    const last = sum.at(-1);
    sum.push(item.type === 'box' ? { ...last, width: last.width + item.width }
      : item.type === 'glue' ? { width: last.width + item.width, stretch: last.stretch + (item.fil ? 0 : item.stretch), shrink: last.shrink + item.shrink, fil: last.fil + (item.fil ? 1 : 0) }
      : last);
  }
  // Where a line after a break at b starts: past the glue and penalties that vanish at a break.
  const startAfter = b => { let i = b + 1; while (i < items.length && items[i].type !== 'box' && !(items[i].type === 'penalty' && items[i].penalty <= -INFINITE)) i++; return i; };
  let active = [{ position: -1, start: 0, line: 0, fitness: 1, demerits: 0, flagged: false, previous: null }];
  const legal = (i) => {
    const item = items[i];
    if (item.type === 'penalty') return item.penalty < INFINITE && (hyphenate || !item.soft);
    return item.type === 'glue' && i > 0 && items[i - 1].type === 'box';
  };
  for (let i = 0; i < items.length; i++) {
    if (!legal(i)) continue;
    const item = items[i], penalty = item.type === 'penalty' ? item.penalty : 0, flagged = item.type === 'penalty' && !!item.flagged;
    const best = [null, null, null, null];
    const keep = [];
    for (const a of active) {
      const width = sum[i].width - sum[a.start].width + (item.type === 'penalty' ? item.width : 0);
      const target = widths(a.line);
      let ratio;
      if (width < target) {
        const fil = sum[i].fil - sum[a.start].fil, stretch = sum[i].stretch - sum[a.start].stretch;
        ratio = fil > 0 ? 0 : stretch > 0 ? (target - width) / stretch : Infinity;
      } else if (width > target) {
        const shrink = sum[i].shrink - sum[a.start].shrink;
        ratio = shrink > 0 ? (target - width) / shrink : -Infinity;
      } else ratio = 0;
      if (ratio >= -1) {
        const badness = ratio === Infinity ? INFINITE : Math.min(INFINITE, Math.round(100 * Math.abs(ratio) ** 3));
        if (badness <= tolerance) {
          let demerits = (linepenalty + badness) ** 2;
          if (penalty >= 0) demerits += penalty ** 2; else if (penalty > -INFINITE) demerits -= penalty ** 2;
          if (flagged && a.flagged) demerits += doublehyphendemerits;
          if (penalty <= -INFINITE && a.flagged) demerits += finalhyphendemerits;
          const fitness = ratio < -0.5 ? 3 : badness <= 12 ? 2 : ratio > 0 && badness >= 100 ? 0 : 1;
          if (Math.abs(fitness - a.fitness) > 1) demerits += adjdemerits;
          const total = a.demerits + demerits;
          if (!best[fitness] || total < best[fitness].demerits)
            best[fitness] = { position: i, start: startAfter(i), line: a.line + 1, fitness, demerits: total, flagged, previous: a };
        }
      }
      // A node stays active while a line from it can still shrink to fit, until a forced
      // break; an overfull line ends it, as no later break could start a line from it.
      if (ratio >= -1 && penalty > -INFINITE) keep.push(a);
    }
    active = keep;
    for (const node of best) if (node) active.push(node);
    if (!active.length) return null;
  }
  const end = active.filter(a => a.position === items.length - 1).sort((x, y) => x.demerits - y.demerits)[0];
  if (!end) return null;
  const breaks = [];
  for (let node = end; node && node.position >= 0; node = node.previous) breaks.unshift(node.position);
  return breaks;
}
