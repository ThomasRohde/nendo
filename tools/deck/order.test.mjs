import test from 'node:test';
import assert from 'node:assert/strict';
import { moveBlock, nudge, ordersFor, pick, aimGrid } from '../../extensions/deck/order.mjs';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const tens = list => list.map((id, i) => ({ id, order: (i + 1) * 10 }));
/** The orders a list reads in once the writes land. */
const applied = (list, writes) => list.map(s => ({ id: s.id, order: writes.has(s.id) ? writes.get(s.id) : s.order }));
const rising = list => list.every((s, i) => i === 0 || s.order > list[i - 1].order);

test('a block moves before a slide, to the end, and stays whole when dropped inside itself', () => {
  assert.deepEqual(moveBlock(ids, ['e'], 'b'), ['a', 'e', 'b', 'c', 'd', 'f']);
  assert.deepEqual(moveBlock(ids, ['b', 'd'], null), ['a', 'c', 'e', 'f', 'b', 'd']);
  assert.deepEqual(moveBlock(ids, ['b', 'e'], 'a'), ['b', 'e', 'a', 'c', 'd', 'f']);
  // Before one of its own slides: the block lands where its first unselected follower stands.
  assert.deepEqual(moveBlock(ids, ['b', 'c'], 'c'), ids);
  assert.deepEqual(moveBlock(ids, ['b', 'd'], 'd'), ['a', 'c', 'b', 'd', 'e', 'f']);
  assert.deepEqual(moveBlock(ids, ['e', 'f'], 'f'), ids);
});

test('a nudge steps each selected slide over its unselected neighbour, and a run at the edge stays', () => {
  assert.deepEqual(nudge(ids, ['c'], -1), ['a', 'c', 'b', 'd', 'e', 'f']);
  assert.deepEqual(nudge(ids, ['b', 'd'], -1), ['b', 'a', 'd', 'c', 'e', 'f']);
  assert.deepEqual(nudge(ids, ['a', 'b', 'd'], -1), ['a', 'b', 'd', 'c', 'e', 'f']);
  assert.deepEqual(nudge(ids, ['c', 'f'], 1), ['a', 'b', 'd', 'c', 'e', 'f']);
  assert.deepEqual(nudge(ids, ['e', 'f'], 1), ids);
});

test('a move writes the order of the moved slides only, in the gap where they land', () => {
  const list = tens(ids);
  const moved = moveBlock(ids, ['e'], 'b').map(id => list.find(s => s.id === id));
  const writes = ordersFor(moved);
  assert.deepEqual([...writes], [['e', 15]]);
  assert.ok(rising(applied(moved, writes)));
  const toEnd = moveBlock(ids, ['a', 'c'], null).map(id => list.find(s => s.id === id));
  assert.deepEqual([...ordersFor(toEnd)], [['a', 70], ['c', 80]]);
  const toStart = moveBlock(ids, ['d', 'f'], 'a').map(id => list.find(s => s.id === id));
  const startWrites = ordersFor(toStart);
  assert.equal(startWrites.size, 2);
  assert.ok(rising(applied(toStart, startWrites)) && [...startWrites.values()].every(o => o > 0));
});

test('new slides take orders in the gap after the current one; no room takes in a neighbour', () => {
  const list = [{ id: 'a', order: 10 }, { id: 'new1', order: null }, { id: 'new2', order: null }, { id: 'b', order: 20 }];
  const writes = ordersFor(list);
  assert.deepEqual([...writes], [['new1', 13], ['new2', 16]]);
  const tight = [{ id: 'a', order: 10 }, { id: 'n', order: null }, { id: 'b', order: 11 }, { id: 'c', order: 12 }];
  const again = ordersFor(tight);
  assert.equal(again.size, 2, `a narrow gap takes in the one neighbour that makes room: ${JSON.stringify([...again])}`);
  assert.ok(rising(applied(tight, again)) && [...again.values()].every(o => o > 0));
  assert.deepEqual([...ordersFor([{ id: 'x', order: null }, { id: 'y', order: null }])], [['x', 10], ['y', 20]]);
});

test('orders out of step with the list are put right with as few writes as keep it rising', () => {
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + (trial % 14);
    const list = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, order: trial % 3 === 0 ? i + 1 : Math.floor(Math.random() * 60) - 5 }));
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    if (trial % 5 === 0) list.splice(Math.floor(n / 2), 0, { id: 'fresh', order: null });
    const writes = ordersFor(list);
    const after = applied(list, writes);
    assert.ok(rising(after), `rising after ${JSON.stringify(list)} → ${JSON.stringify([...writes])}`);
    assert.ok(after.every(s => Number.isInteger(s.order)));
    if (list.some(s => s.id === 'fresh')) assert.ok(writes.has('fresh'));
  }
});

test('a click picks one, Ctrl toggles, Shift runs from the anchor, and the last slide stays picked', () => {
  assert.deepEqual(pick(ids, ['a'], 'a', 'c'), { selected: ['c'], anchor: 'c', current: 'c' });
  assert.deepEqual(pick(ids, ['a'], 'a', 'c', { ctrl: true }), { selected: ['a', 'c'], anchor: 'c', current: 'c' });
  assert.deepEqual(pick(ids, ['a', 'c'], 'c', 'c', { ctrl: true }), { selected: ['a'], anchor: 'c', current: 'a' });
  assert.deepEqual(pick(ids, ['b'], 'b', 'e', { shift: true }), { selected: ['b', 'c', 'd', 'e'], anchor: 'b', current: 'e' });
  assert.deepEqual(pick(ids, ['e'], 'e', 'b', { shift: true }), { selected: ['b', 'c', 'd', 'e'], anchor: 'e', current: 'b' });
  assert.deepEqual(pick(ids, ['a'], 'a', 'a', { ctrl: true }), { selected: ['a'], anchor: 'a', current: 'a' });
});

test('a drop in a grid aims at the nearest row, also in the gap between two rows', () => {
  // Three rows of three 100 x 100 cards, 18 apart.
  const boxes = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++)
    boxes.push({ id: `r${row}c${col}`, left: col * 118, top: row * 118, width: 100, bottom: row * 118 + 100 });
  assert.equal(aimGrid(boxes, 10, 50), 'r0c0');
  assert.equal(aimGrid(boxes, 140, 160), 'r1c1');
  // Past the last card of a row: before the first card of the next row.
  assert.equal(aimGrid(boxes, 330, 50), 'r1c0');
  // In the gap, outside any margin: the nearer row, never the last.
  assert.equal(aimGrid(boxes, 140, 109), 'r0c1');
  assert.equal(aimGrid(boxes, 140, 110), 'r1c1');
  // Above the first row and below the last.
  assert.equal(aimGrid(boxes, 10, -40), 'r0c0');
  assert.equal(aimGrid(boxes, 330, 400), null);
  assert.equal(aimGrid([], 0, 0), null);
});

test('many slides pasted between two others write them and a few neighbours, within one batch', () => {
  const deck = Array.from({ length: 128 }, (_, i) => ({ id: `s${i}`, order: (i + 1) * 10 }));
  const pasted = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, order: null }));
  const list = [deck[0], ...pasted, ...deck.slice(1)];
  const writes = ordersFor(list);
  const after = applied(list, writes);
  assert.ok(rising(after) && after.every(s => Number.isInteger(s.order) && s.order > 0));
  // 100 new slides and the eleven after them that make room: far under the 200 writes of a batch.
  assert.ok(writes.size <= 120, `a paste of 100 after the first of 128 slides writes ${writes.size} orders`);
});
