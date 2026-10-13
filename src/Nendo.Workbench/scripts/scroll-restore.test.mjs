import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';

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
 * This reads shell.ts and every stylesheet and requires them to agree. It read two of the
 * stylesheets once, so Help's article, which scrolls on its own, went back to its top on every
 * file-change redraw with this test green (WST-01). The exemptions are named, because an
 * exemption nobody can read is the same hole in a different place.
 */
const shell = readFileSync(new URL('../src/shell.ts', import.meta.url), 'utf8');
const styles = new URL('../src/styles/', import.meta.url);
const stylesheets = readdirSync(styles).filter((name) => name.endsWith('.css')).map((name) => readFileSync(new URL(name, styles), 'utf8'));

/** A scroller a redraw must not move, and why it is left out. */
const EXEMPT = new Map([
  ['surface-picker-options', 'a dropdown: the redraw that would restore it has already closed it'],
  ['studio-content', 'the content pane itself, which scrollPositions puts back first'],
  ['file-menu-panel', 'the File menu, outside the content pane, which is all a redraw rebuilds'],
  ['primary-nav', 'the navigation rail, outside the content pane'],
  ['command-palette-list', 'the palette, a dialog, which holds every automatic redraw while it is open'],
  ['view-menu', "a custom view's menu, drawn on the body and holding every redraw while open"],
  ['package-file-text', 'a package file shown in a dialog, which holds every redraw'],
  ['studio-search-results', 'refilled by its own search after a redraw, so at redraw time there is nothing to put back'],
  ['reference-results', "a reference picker's results, listed only while its search box has the focus, which holds every redraw"],
  ['chat-scroll', 'the conversation keeps its own place: it follows the newest message (view-agent-chat.ts)'],
  ['chat-plain', 'inside the conversation, which draws its messages in place rather than through a page redraw'],
  ['chat-mention', 'the @ menu, which holds the conversation while it is open'],
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
  assert.ok(scrolling.has('help-article'), "Help's article no longer scrolls on its own; this guard needs rewriting");
  // An exemption for a class that no longer scrolls is a name nobody can check.
  const stale = [...EXEMPT.keys()].filter((name) => !scrolling.has(name));
  assert.deepEqual(stale, [], 'these exemptions name classes no stylesheet scrolls any more');

  const missing = [...scrolling].filter((name) => !restored.has(name) && !EXEMPT.has(name)).sort();
  assert.deepEqual(missing, [],
    `these scroll on their own account and a redraw would send the reader back to the top: ${missing.join(', ')}`);
});
