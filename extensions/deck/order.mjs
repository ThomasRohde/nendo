// Where slides stand: the order a move, a paste or a duplicate leaves, and the fewest order
// numbers that say it. Pure, so the view and node's tests share it. A slide's place is its
// integer `order`; the list is read in rising order (model.mjs sortSlides).

/** The ids with `moving` taken out, in their present order, and put back as one block before `before` (an id, or null for the end). */
export function moveBlock(ids, moving, before) {
  const set = new Set(moving);
  const block = ids.filter(id => set.has(id));
  const rest = ids.filter(id => !set.has(id));
  // A place inside the block is the place after the block's last slide before it.
  let at = before === null ? -1 : ids.indexOf(before);
  if (at < 0) at = rest.length;
  else {
    while (at < ids.length && set.has(ids[at])) at++;
    at = at < ids.length ? rest.indexOf(ids[at]) : rest.length;
  }
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * The ids with each slide of `moving` one step up (delta -1) or down (+1), as PowerPoint moves a
 * selection: a slide steps over the unselected one beside it, and a run at the end stays put.
 */
export function nudge(ids, moving, delta) {
  const set = new Set(moving), list = [...ids];
  if (delta < 0) {
    for (let i = 1; i < list.length; i++) if (set.has(list[i]) && !set.has(list[i - 1])) [list[i - 1], list[i]] = [list[i], list[i - 1]];
  } else {
    for (let i = list.length - 2; i >= 0; i--) if (set.has(list[i]) && !set.has(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
  }
  return list;
}

/**
 * The orders to write so `list` ({id, order}, order null for a slide not yet made) reads in the
 * order given. The longest run of orders already rising stays as it is; the other slides go in the
 * gaps between, ten apart where there is room. A gap too narrow takes in its kept neighbours, the
 * side that adds more room first, until the slides fit: a paste of many slides between two others
 * writes the slides and a few neighbours, not the whole deck. Answers a Map of id to order for each
 * slide whose order must be written, its value changed.
 */
export function ordersFor(list) {
  const keep = risingRun(list.map(s => Number.isInteger(s.order) ? s.order : null));
  // The order each slide has once the windows so far are written; a slide a window took in is no
  // longer kept, and the next window stands between the kept slides that are left.
  const order = list.map(s => s.order);
  const at = x => x >= 0 && x < list.length ? order[x] : null;
  const keptAfter = x => { for (let y = x + 1; y < list.length; y++) if (keep.has(y)) return y; return list.length; };
  const keptBefore = x => { for (let y = x - 1; y >= 0; y--) if (keep.has(y)) return y; return -1; };
  const out = new Map();
  let i = 0;
  while (i < list.length) {
    if (keep.has(i)) { i++; continue; }
    // The window [a, b) is written; a - 1 and b are the kept slides it stands between.
    let a = i, b = keptAfter(i - 1), placed;
    while (!(placed = fill(at(a - 1), at(b), b - a))) {
      const right = keptAfter(b), left = keptBefore(a - 1) + 1;
      const gainRight = right === list.length ? Infinity : at(right) - at(b);
      const gainLeft = left === 0 ? at(a - 1) : at(a - 1) - at(left - 1);
      if (a === 0 || gainRight >= gainLeft) { keep.delete(b); b = right; } else { keep.delete(a - 1); a = left; }
    }
    for (let n = a; n < b; n++) { order[n] = placed[n - a]; out.set(list[n].id, placed[n - a]); }
    i = b;
  }
  for (const [id, value] of out) if (list.find(s => s.id === id).order === value) out.delete(id);
  return out;
}

/** k orders strictly between lo and hi (null for open), ten apart where they fit, kept above zero. */
function fill(lo, hi, k) {
  if (lo === null && hi === null) return Array.from({ length: k }, (_, n) => (n + 1) * 10);
  if (hi === null) return Array.from({ length: k }, (_, n) => lo + (n + 1) * 10);
  const floor = lo ?? 0;
  if (lo === null && hi - k * 10 > 0) return Array.from({ length: k }, (_, n) => hi - (k - n) * 10);
  const step = Math.min(10, Math.floor((hi - floor) / (k + 1)));
  if (step < 1) return null;
  return Array.from({ length: k }, (_, n) => floor + (n + 1) * step);
}

/** The indexes of the longest strictly rising run of known orders (patience sorting). */
function risingRun(orders) {
  const tails = [], tailAt = [], prev = new Array(orders.length).fill(-1);
  orders.forEach((o, i) => {
    if (o === null) return;
    let a = 0, b = tails.length;
    while (a < b) { const m = (a + b) >> 1; if (tails[m] < o) a = m + 1; else b = m; }
    tails[a] = o; tailAt[a] = i;
    prev[i] = a > 0 ? tailAt[a - 1] : -1;
  });
  const keep = new Set();
  for (let i = tailAt[tails.length - 1] ?? -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/** The ids a click picks: one, a Ctrl click's toggle, or a Shift click's run from the anchor. */
/**
 * The card a drop at (x, y) in a grid of cards lands before, or null for the end. The pointer's row is
 * the nearest one, so a pointer in the gap between two rows aims at one of those two. Boxes are in
 * reading order: { id, left, top, width, bottom }.
 */
export function aimGrid(boxes, x, y) {
  const rows = [];
  for (const b of boxes) {
    const row = rows.find(r => Math.abs(r.top - b.top) < 4);
    if (row) { row.boxes.push(b); row.bottom = Math.max(row.bottom, b.bottom); } else rows.push({ top: b.top, bottom: b.bottom, boxes: [b] });
  }
  if (!rows.length) return null;
  const away = r => y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  const row = rows.reduce((near, r) => away(r) < away(near) ? r : near);
  const hit = row.boxes.find(b => x < b.left + b.width / 2);
  if (hit) return hit.id;
  const next = rows[rows.indexOf(row) + 1];
  return next ? next.boxes[0].id : null;
}

export function pick(ids, selected, anchor, id, { ctrl = false, shift = false } = {}) {
  if (shift && anchor !== null && ids.includes(anchor)) {
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
    const run = ids.slice(a, b + 1);
    return { selected: ctrl ? [...new Set([...selected, ...run])] : run, anchor, current: id };
  }
  if (ctrl) {
    const has = selected.includes(id);
    const next = has ? selected.filter(x => x !== id) : [...selected, id];
    // The last slide is never taken out: something stays on the stage.
    if (!next.length) return { selected: [id], anchor: id, current: id };
    return { selected: next, anchor: id, current: has ? next.at(-1) : id };
  }
  return { selected: [id], anchor: id, current: id };
}
