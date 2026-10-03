import type { WindowTitleBar, WorkbenchClient } from './host-types';
import { readTitleBar, sameBoxes, sameTitleBar, titleBarControls, type TitleBarBox } from './title-bar-model';

/**
 * Nendo's top bar is the window's title bar (W-093; docs/design/console-direction.md).
 *
 * The host draws no title bar of its own. The page starts at the window's top edge, and Windows
 * draws its Minimise, Maximise and Close over the right end of the top bar and moves the window
 * from every part of the title bar's height that the page has not claimed. So the page claims
 * its controls: whenever one moves, appears or goes, the boxes of the controls in that band go to
 * the host, which has Windows pass them through. The rest of the band is the caption. It drags,
 * snaps, maximises on a double-click and opens the window's menu on a right-click, and the page
 * never hears a press there.
 *
 * The host answers with the title bar, its height and the width Windows keeps for its buttons,
 * and says so again when a new display scale changes it. The page keeps that width free, from
 * data-title-bar="window" and --title-bar-right (styles/20-title-bar.css). Outside the Desktop
 * host none of this runs, and the top bar is a plain bar.
 */

/** Everything a person can press, type in or open. A label counts: pressing one reaches its control. */
const controlSelector = [
  'button', 'a[href]', 'input', 'select', 'textarea', 'summary', 'label', 'iframe',
  '[tabindex]:not([tabindex="-1"])', '[role="button"]', '[contenteditable="true"]',
].join(', ');

/**
 * Where the title bar's controls are: the top bar, and the rail, whose head is the bar's left end
 * and which is itself the bar across the top of a narrow window.
 */
const bandSelector = '.workspace-header, .rail, .tab-strip';

/** A menu or a dialog: while one is open, a press anywhere closes it, so the page takes the whole bar. */
const layerSelector = 'dialog[open], [data-view-menu-open], .workspace-header details[open], .rail details[open]';

/** The bar before the host has answered: Windows' tall title bar, which is what the host asks for. */
const provisional: WindowTitleBar = { height: 48, left: 0, right: 0 };

let client: WorkbenchClient | null = null;
let bar: WindowTitleBar | null = null;
let sent: TitleBarBox[] | null = null;
let scheduled = false;
let sending = false;
let again = false;

export function startTitleBar(host: WorkbenchClient): void {
  if (host.mode !== 'desktop' || client !== null) return;
  client = host;
  host.onTitleBarChanged?.((next) => {
    apply(next);
    // Windows holds the boxes in the screen's own pixels, so a new scale needs them again.
    sent = null;
    schedule();
  });
  const measure = (): void => { schedule(); };
  window.addEventListener('resize', measure);
  const resize = new ResizeObserver(measure);
  const bands = new MutationObserver(measure);
  for (const band of document.querySelectorAll<HTMLElement>(bandSelector)) {
    resize.observe(band);
    bands.observe(band, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  // The rail's fold and the key hints move the bar's controls without resizing it.
  bands.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rail', 'data-shortcuts'] });
  // A dialog or a details opens anywhere, and a view's menu is put on the body itself. One
  // observer each, because a second observe of one node replaces the first's options, and a
  // body watched for every child anywhere would measure the bar on every redraw of the page.
  new MutationObserver(measure).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  new MutationObserver(measure).observe(document.body, { childList: true });
  void document.fonts.ready.then(measure);
  schedule();
}

function apply(next: WindowTitleBar): void {
  bar = next;
  const root = document.documentElement;
  root.style.setProperty('--title-bar-height', `${next.height}px`);
  root.style.setProperty('--title-bar-right', `${next.right}px`);
  root.dataset.titleBar = 'window';
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    void report();
  });
}

/**
 * The part of a control a person can see: its box cut by every ancestor inside the band that
 * clips what overflows it, like the rail's row of Studio pages scrolled sideways in a narrow
 * window. A control scrolled out of sight claims nothing.
 */
function visibleBox(control: HTMLElement, band: HTMLElement): TitleBarBox | null {
  const box = control.getBoundingClientRect();
  let left = box.left, top = box.top, right = box.right, bottom = box.bottom;
  for (let ancestor = control.parentElement; ancestor !== null && band.contains(ancestor); ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = ancestor.getBoundingClientRect();
    left = Math.max(left, clip.left); top = Math.max(top, clip.top);
    right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function measureControls(within: WindowTitleBar): TitleBarBox[] {
  const boxes: TitleBarBox[] = [];
  for (const band of document.querySelectorAll<HTMLElement>(bandSelector)) {
    for (const control of band.querySelectorAll<HTMLElement>(controlSelector)) {
      if (control.getBoundingClientRect().top >= within.height) continue;
      const box = visibleBox(control, band);
      if (box !== null) boxes.push(box);
    }
  }
  return titleBarControls(boxes, within, document.documentElement.clientWidth, document.querySelector(layerSelector) !== null);
}

async function report(): Promise<void> {
  if (client === null) return;
  if (sending) {
    again = true;
    return;
  }
  const controls = measureControls(bar ?? provisional);
  if (sent !== null && sameBoxes(sent, controls)) return;
  sending = true;
  try {
    const answer = readTitleBar(await client.request<unknown>('window.setTitleBarControls', { controls }));
    sent = controls;
    if (answer !== null && !sameTitleBar(bar, answer)) {
      apply(answer);
      // The bar's height or its free width changed, so its controls may have moved.
      again = true;
    }
  } catch {
    // The window keeps the controls it had. Ask again in a second, as well as at the next change
    // to the bar: a bar that never changed again would otherwise keep a control Windows drags by.
    sent = null;
    window.setTimeout(schedule, 1000);
  } finally {
    sending = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}
