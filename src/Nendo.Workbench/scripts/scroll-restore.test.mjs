import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * A redraw rebuilds the page, so every element that scrolls on its own account has to be
 * put back where it was. `scrollPositions` in shell.ts is that list, and it is a CSS
 * selector: nothing connects it to the stylesheet that decides which elements scroll, so
 * a scroller added to the CSS is silently not restored.
 *
 * That is how it went wrong. `.record-inspector` — the record page on the right, the
 * tallest scroller in the product — had `overflow: auto` and was not in the list, so
 * every redraw returned the reader to the top. The owner reported it as a page that
 * scrolled up by itself once a second, and the once-a-second part was a different defect
 * behind it.
 *
 * This reads both files and requires them to agree. The exemptions are named, because an
 * exemption nobody can read is the same hole in a different place.
 */
const shell = readFileSync(new URL('../src/shell.ts', import.meta.url), 'utf8');
const stylesheets = ['08-panels.css', '09-surfaces.css'].map((name) =>
  readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8'));

/** A scroller a redraw must not move, and why it is left out. */
const EXEMPT = new Map([
  ['surface-picker-options', 'a dropdown: the redraw that would restore it has already closed it'],
]);

/** Every class this stylesheet gives its own scrollbar. */
function scrollingClasses(css) {
  const found = new Set();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/overflow(-y)?\s*:\s*(auto|scroll)/.test(body)) continue;
    for (const part of selector.split(',')) {
      const classes = [...part.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]);
      if (classes.length !== 0) found.add(classes.at(-1));
    }
  }
  return found;
}

test('every scroller a redraw rebuilds is one a redraw puts back', () => {
  const selector = /scrollPositions[\s\S]*?querySelectorAll<HTMLElement>\('([^']+)'\)/.exec(shell);
  assert.notEqual(selector, null, 'shell.ts no longer collects scroll positions by selector');
  const restored = new Set([...selector[1].matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]));

  const scrolling = new Set(stylesheets.flatMap((css) => [...scrollingClasses(css)]));
  // The guard must not be able to pass by finding nothing: the record page on the right
  // is the case it was written for, and it scrolls.
  assert.ok(scrolling.has('record-inspector'), 'the record inspector no longer scrolls; this guard needs rewriting');

  const missing = [...scrolling].filter((name) => !restored.has(name) && !EXEMPT.has(name)).sort();
  assert.deepEqual(missing, [],
    `these scroll on their own account and a redraw would send the reader back to the top: ${missing.join(', ')}`);
});
