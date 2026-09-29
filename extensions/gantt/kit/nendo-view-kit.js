// Nendo view kit 1.0.0 (W-064): what a custom view owes the person, in one file a package copies.
//
// A view draws its own document, so the Workbench's focus rings, keyboard traversal and text
// alternatives stop at its frame. This file carries them across: copy it into the package (the
// Gantt keeps it at kit/nendo-view-kit.js) and import what the view needs. It depends on nothing
// but the page and the --nendo-* tokens api.js sets, and it changes nothing until it is called.
// The source of truth is tools/view-kit/; a package's copy is checked against it byte for byte.
//
//   installFocusRing(document)                 a visible focus ring in the theme's own colour,
//                                              the system's in forced colours, and no motion
//                                              for a person who asked for less
//   roving(container, { items, orientation, onActivate }) -> { refresh, stop }
//                                              one tab stop for a list, a grid or a graph; the
//                                              arrow keys, Home and End move within it, Enter
//                                              and Space activate; refresh after a redraw
//   textAlternative(container, { label, items })
//                                              a list a screen reader reads for a drawing it
//                                              cannot, hidden from the eye
//   fitBox(content, viewport, padding)         the scale and offset that fit a drawing
//   toneFor(value, choices)                    the tone a status value takes, for a view that
//                                              does not read the schema's choices itself

export const version = '1.0.0';

const RING = 'nendo-view-kit-ring';

/** A focus ring the eye can find, in both themes and in forced colours; less motion when asked. */
export function installFocusRing(doc = document) {
  if (doc.getElementById(RING)) return;
  const style = doc.createElement('style');
  style.id = RING;
  style.textContent = [
    ':focus-visible{outline:2px solid var(--nendo-cobalt,#3b5bdb);outline-offset:2px}',
    '@media (forced-colors: active){:focus-visible{outline:2px solid Highlight}}',
    '@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}}',
    '.nendo-kit-sr-only{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  ].join('\n');
  doc.head.append(style);
}

/**
 * One tab stop for a set of items, and the keys to move between them.
 *
 * `items` is a selector inside `container`, read afresh on every key, so a redraw that replaces
 * the items keeps working. `orientation` is 'vertical' (Up and Down), 'horizontal' (Left and
 * Right) or 'spatial' (all four arrows, to the nearest item in that direction: a grid or a
 * graph). Enter and Space call `onActivate(item)`, or click it. Call `refresh()` after a redraw
 * replaces the items, so there is one tab stop again; `stop()` removes the keys.
 */
export function roving(container, { items, orientation = 'vertical', onActivate } = {}) {
  const list = () => [...container.querySelectorAll(items)];
  const current = () => list().find(item => item.tabIndex === 0) ?? list()[0] ?? null;
  const settle = focusOn => {
    for (const item of list()) item.tabIndex = item === focusOn ? 0 : -1;
  };
  const move = target => {
    if (!target) return;
    settle(target);
    target.focus();
  };
  settle(current());
  const next = (from, key) => {
    const all = list(), at = all.indexOf(from);
    if (key === 'Home') return all[0];
    if (key === 'End') return all.at(-1);
    if (orientation !== 'spatial') {
      const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
      const backward = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
      if (key === forward) return all[Math.min(all.length - 1, at + 1)];
      if (key === backward) return all[Math.max(0, at - 1)];
      return null;
    }
    const direction = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
    if (!direction) return null;
    const centre = element => { const box = element.getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; };
    const [x, y] = centre(from);
    let best = null, bestScore = Infinity;
    for (const item of all) {
      if (item === from) continue;
      const [ix, iy] = centre(item), dx = ix - x, dy = iy - y;
      const along = dx * direction[0] + dy * direction[1];
      if (along <= 0) continue;
      const across = Math.abs(dx * direction[1] - dy * direction[0]);
      const score = along + across * 2;
      if (score < bestScore) { best = item; bestScore = score; }
    }
    return best;
  };
  const onKey = event => {
    const from = event.target.closest?.(items);
    if (!from || !container.contains(from)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (onActivate) onActivate(from); else from.click();
      return;
    }
    const target = next(from, event.key);
    if (target === null) return;
    event.preventDefault();
    move(target);
  };
  const onFocus = event => {
    const item = event.target.closest?.(items);
    if (item && container.contains(item)) settle(item);
  };
  container.addEventListener('keydown', onKey);
  container.addEventListener('focusin', onFocus);
  return {
    refresh: () => settle(current()),
    stop() {
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('focusin', onFocus);
    },
  };
}

/** A list, hidden from the eye, that says what a drawing shows. Replaces the one before. */
export function textAlternative(container, { label, items }) {
  const doc = container.ownerDocument;
  let list = container.querySelector(':scope > .nendo-kit-text-alternative');
  if (!list) {
    list = doc.createElement('ul');
    list.className = 'nendo-kit-sr-only nendo-kit-text-alternative';
    container.append(list);
  }
  list.setAttribute('aria-label', label);
  list.replaceChildren(...items.map(({ name, detail }) => {
    const entry = doc.createElement('li');
    entry.textContent = detail ? `${name}: ${detail}` : name;
    return entry;
  }));
  return list;
}

/** The scale and offset that fit `content` ({x, y, width, height}) into `viewport` ({width, height}). */
export function fitBox(content, viewport, padding = 16) {
  if (!content.width || !content.height) return { scale: 1, x: padding, y: padding };
  const scale = Math.min((viewport.width - padding * 2) / content.width, (viewport.height - padding * 2) / content.height);
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2 - content.x * scale,
    y: (viewport.height - content.height * scale) / 2 - content.y * scale,
  };
}

/**
 * The tone a value takes: the choice whose ID or name it is, as the schema gives it
 * ([{ id, displayName, tone }]), as a CSS colour from the theme's tokens. Grey when the value
 * names no choice or its choice has no tone.
 */
export function toneFor(value, choices = []) {
  const choice = choices.find(candidate => candidate.id === value || candidate.displayName === value);
  return `var(--nendo-tone-${choice?.tone ?? 'grey'})`;
}
