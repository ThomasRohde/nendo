// Slides moved by hand, as in PowerPoint's slide pane and slide sorter: a press and a drag lifts the
// selected slides, a line shows where they will land, the list scrolls when the pointer nears its
// edge, and the drop moves them as one block. Ctrl held at the drop copies them instead; Escape
// puts them back. The same drag runs down the slide list and across the sorter's grid.

import { moveBlock, aimGrid as aimBoxes } from './order.mjs';

const EDGE = 40, SPEED = 16, THRESHOLD = 5;
const reduced = () => matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A drag over `list`, whose items are `item` elements carrying `data-id`. `grid` lays the insertion
 * mark as a bar between cards rather than a line between rows. The host answers the ids in order
 * (`ids`), the ids a press on one would lift (`lift`), a picture of them (`ghost`), and takes the
 * drop (`drop(ids, before, {copy})`, `before` an id or null for the end). The host leaves the list
 * as it is while a drag is on (`active`), and `ended` says when it may draw it again.
 */
export function createSlideDrag({ list, item = '[data-id]', grid = false, ids, lift, ghost, drop, ended = () => {}, readOnly = () => false }) {
  let press = null, drag = null, swallow = false;
  const mark = Object.assign(document.createElement('div'), { className: grid ? 'drop-mark bar' : 'drop-mark line' });
  mark.setAttribute('aria-hidden', 'true');
  const items = () => [...list.querySelectorAll(item)];

  list.addEventListener('pointerdown', e => {
    if (e.button !== 0 || readOnly()) return;
    const el = e.target.closest(item);
    if (!el || !list.contains(el)) return;
    press = { id: el.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  });
  list.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < THRESHOLD) return;
      begin(e);
    }
    move(e);
  });
  list.addEventListener('pointerup', e => {
    if (!press || e.pointerId !== press.pointerId) return;
    const was = drag;
    press = null;
    if (was) finish(e.ctrlKey || e.metaKey);
  });
  // A logo or a picture on a slide would start the browser's own drag, which ends this one.
  list.addEventListener('dragstart', e => e.preventDefault());
  list.addEventListener('pointercancel', () => cancel());
  list.addEventListener('lostpointercapture', () => { if (drag) cancel(); });
  // The click that ends a drag is not a click on a slide.
  list.addEventListener('click', e => { if (swallow) { swallow = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  const keys = e => {
    if (!drag) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Control' || e.key === 'Meta') drag.ghost.classList.toggle('copy', e.type === 'keydown');
  };
  addEventListener('keydown', keys, true);
  addEventListener('keyup', keys, true);

  function begin(e) {
    const lifted = lift(press.id);
    drag = { ids: lifted, before: undefined, x: e.clientX, y: e.clientY, speed: 0, frame: 0 };
    try { list.setPointerCapture(press.pointerId); } catch { /* the pointer is gone; the drag ends at once */ }
    for (const el of items()) el.classList.toggle('lifted', lifted.includes(el.dataset.id));
    drag.ghost = makeGhost(ghost(lifted), lifted.length);
    drag.ghost.classList.toggle('copy', e.ctrlKey || e.metaKey);
    document.body.append(drag.ghost);
    if (getComputedStyle(list).position === 'static') list.style.position = 'relative';
    list.append(mark);
    document.body.classList.add('dragging-slides');
    list.setAttribute('aria-busy', 'true');
    if (window.deck) window.deck.drag = { ids: lifted, before: null, active: true };
  }

  function move(e) {
    drag.x = e.clientX; drag.y = e.clientY;
    drag.ghost.style.transform = `translate(${drag.x + 14}px, ${drag.y + 10}px)`;
    const r = list.getBoundingClientRect();
    const near = drag.y < r.top + EDGE ? -(r.top + EDGE - drag.y) : drag.y > r.bottom - EDGE ? drag.y - (r.bottom - EDGE) : 0;
    drag.speed = Math.max(-SPEED, Math.min(SPEED, near / EDGE * SPEED));
    if (drag.speed && !drag.frame) drag.frame = requestAnimationFrame(scroll);
    aim();
  }

  function scroll() {
    if (!drag) return;
    drag.frame = 0;
    if (!drag.speed) return;
    const before = list.scrollTop;
    list.scrollTop += drag.speed;
    if (list.scrollTop !== before) aim();
    drag.frame = requestAnimationFrame(scroll);
  }

  /** Where the block would land under the pointer, and the mark drawn there. */
  function aim() {
    const els = items();
    const before = grid ? aimGrid(els) : aimList(els);
    drag.before = before;
    const order = ids();
    const moves = drag.ghost.classList.contains('copy') || moveBlock(order, drag.ids, before).some((id, i) => id !== order[i]);
    if (window.deck?.drag) Object.assign(window.deck.drag, { before, moves });
    mark.hidden = !moves;
    if (!moves || !els.length) return;
    const box = list.getBoundingClientRect();
    const at = before === null ? null : els.find(el => el.dataset.id === before);
    const last = els.at(-1).getBoundingClientRect();
    const place = (left, top, width, height) => Object.assign(mark.style, {
      left: `${left - box.left + list.scrollLeft}px`, top: `${top - box.top + list.scrollTop}px`, width: `${width}px`, height: `${height}px` });
    if (grid) {
      const r = (at ?? els.at(-1)).getBoundingClientRect();
      const gap = gapX(els);
      place((at ? r.left : r.right) + (at ? -gap / 2 : gap / 2) - 2, r.top, 4, r.height);
    } else {
      const r = at ? at.getBoundingClientRect() : last;
      const gap = gapY(els);
      place(r.left, (at ? r.top - gap / 2 : r.bottom + gap / 2) - 2, r.width, 4);
    }
  }
  function aimList(els) {
    for (const el of els) { const r = el.getBoundingClientRect(); if (drag.y < r.top + r.height / 2) return el.dataset.id; }
    return null;
  }
  function aimGrid(els) {
    return aimBoxes(els.map(el => { const r = el.getBoundingClientRect(); return { id: el.dataset.id, left: r.left, top: r.top, width: r.width, bottom: r.bottom }; }), drag.x, drag.y);
  }
  const gapY = els => els.length > 1 ? Math.max(2, els[1].getBoundingClientRect().top - els[0].getBoundingClientRect().bottom) : 8;
  const gapX = els => {
    for (let i = 1; i < els.length; i++) {
      const a = els[i - 1].getBoundingClientRect(), b = els[i].getBoundingClientRect();
      if (Math.abs(a.top - b.top) < 4) return Math.max(2, b.left - a.right);
    }
    return 12;
  };

  function finish(copy) {
    const { ids: lifted, before } = drag;
    const moves = !mark.hidden;
    end();
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
    if (before !== undefined && (moves || copy)) drop(lifted, before, { copy });
  }
  function cancel() {
    if (!drag) { press = null; return; }
    press = null;
    end();
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
  }
  function end() {
    cancelAnimationFrame(drag.frame);
    drag.ghost.remove();
    mark.remove();
    for (const el of items()) el.classList.remove('lifted');
    document.body.classList.remove('dragging-slides');
    list.removeAttribute('aria-busy');
    if (window.deck?.drag) window.deck.drag.active = false;
    drag = null;
    ended();
  }

  return { active: () => !!drag, cancel };
}

/** The lifted slides under the pointer: the first drawn, the others as cards behind, and how many. */
function makeGhost(picture, count) {
  const el = document.createElement('div');
  el.className = 'drag-ghost';
  el.setAttribute('aria-hidden', 'true');
  for (let i = Math.min(count, 3) - 1; i > 0; i--) { const back = document.createElement('div'); back.className = 'ghost-back'; back.style.setProperty('--n', String(i)); el.append(back); }
  picture.classList.add('ghost-front');
  el.append(picture);
  const badge = document.createElement('span');
  badge.className = 'ghost-count';
  badge.textContent = String(count);
  badge.hidden = count < 2;
  const plus = document.createElement('span');
  plus.className = 'ghost-copy';
  plus.textContent = '+';
  el.append(badge, plus);
  return el;
}

/** Where each item stands now, by id, so a redraw can slide them from there (flip). */
export function places(list, item = '[data-id]') {
  const map = new Map();
  for (const el of list.querySelectorAll(item)) map.set(el.dataset.id, el.getBoundingClientRect());
  return map;
}

/** Slides each item from where it stood to where it is drawn now; a new one fades in. */
export function flip(list, before, { item = '[data-id]', moved = [] } = {}) {
  if (!before?.size || reduced() || !list.animate) return;
  const settled = new Set(moved);
  for (const el of list.querySelectorAll(item)) {
    const was = before.get(el.dataset.id);
    const now = el.getBoundingClientRect();
    if (!was) { el.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' }); continue; }
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  for (const el of list.querySelectorAll(item)) if (settled.has(el.dataset.id)) el.querySelector('.thumb')?.animate([{ boxShadow: '0 0 0 4px var(--accent)' }, { boxShadow: '0 0 0 2px var(--accent)' }], { duration: 600, easing: 'ease-out' });
}

/**
 * A menu of the view's own, for a frame without Nendo's (`ui.showMenu`): the same items, drawn with
 * the text menu's look. Answers the id picked, or null.
 */
export function ownMenu(items, x, y) {
  return new Promise(resolve => {
    const menu = document.createElement('div');
    menu.className = 'tx-popup';
    const list = document.createElement('div');
    list.className = 'tx-menu';
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', 'Slides');
    for (const it of items) {
      if (it.kind === 'separator') { const s = document.createElement('div'); s.className = 'tx-sep'; s.setAttribute('role', 'separator'); list.append(s); continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1; b.dataset.id = it.id;
      b.setAttribute('role', it.kind === 'check' ? 'menuitemcheckbox' : 'menuitem');
      if (it.kind === 'check') b.setAttribute('aria-checked', String(!!it.checked));
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      const markEl = document.createElement('span'); markEl.className = 'tx-mark'; markEl.textContent = it.checked ? '✓' : '';
      const label = document.createElement('span'); label.className = 'tx-text'; label.textContent = it.label;
      const keys = document.createElement('span'); keys.className = 'tx-keys'; keys.textContent = it.keys ?? '';
      if (it.danger) b.classList.add('danger');
      b.append(markEl, label, keys);
      list.append(b);
    }
    menu.append(list);
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    const back = document.activeElement;
    const buttons = () => [...list.querySelectorAll('button:not([aria-disabled="true"])')];
    const done = id => {
      menu.remove();
      removeEventListener('pointerdown', outside, true);
      removeEventListener('blur', dismiss);
      back?.focus?.({ preventScroll: true });
      resolve(id);
    };
    const outside = e => { if (!menu.contains(e.target)) done(null); };
    const dismiss = () => done(null);
    addEventListener('pointerdown', outside, true);
    addEventListener('blur', dismiss);
    menu.addEventListener('mousedown', e => e.preventDefault());
    menu.addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.getAttribute('aria-disabled') !== 'true') done(b.dataset.id); });
    menu.addEventListener('mouseover', e => e.target.closest('button')?.focus({ preventScroll: true }));
    menu.addEventListener('keydown', e => {
      const all = buttons(), at = all.indexOf(document.activeElement);
      const go = n => { e.preventDefault(); all[(n + all.length) % all.length]?.focus(); };
      if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at < 0 ? all.length - 1 : at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(all.length - 1);
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); done(null); }
      else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) { e.preventDefault(); done(all[at].dataset.id); }
    });
    buttons()[0]?.focus({ preventScroll: true });
    if (window.deck) window.deck.menus = (window.deck.menus ?? 0) + 1;
  });
}
