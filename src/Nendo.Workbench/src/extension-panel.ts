import { state } from './app-state';
import { client } from './client';
import { messageFor } from './format';

/**
 * A custom view on a record page (ADR-0013, 2026-09-24 record-set amendment; W-061).
 *
 * The page draws a placeholder and nothing runs until the person presses Show view. The
 * host then runs the view in its own contained window, which floats over the Workbench
 * rather than inside it, so the page says where the placeholder is: its rectangle, and the
 * part of it the page actually shows. While the page scrolls, the view is hidden and put
 * back where the scrolling stopped, because a child window dragged along a scroll trails it.
 *
 * One view runs per window. Showing another stops the first, which is the host's rule; the
 * page only keeps its placeholders honest about it.
 */

interface Running { viewId: string; recordId: string; fileSessionId: string }
interface Placement {
  visible: boolean; x: number; y: number; width: number; height: number;
  clipX: number; clipY: number; clipWidth: number; clipHeight: number;
}
interface PanelStatus {
  packageState: string; isApproved: boolean;
  definition: { packageId: string; packageVersion: string }; notice: string | null;
}

let running: Running | null = null;
/** Why a view stopped without being asked, shown in its placeholder until it is shown again. */
const stopped = new Map<string, string>();
const key = (viewId: string, recordId: string): string => viewId + '\u0000' + recordId;

/** Wire every placeholder under <paramref name="root"/>, and keep a running view where its placeholder is. */
export function wireExtensionPanels(root: ParentNode): void {
  for (const panel of root.querySelectorAll<HTMLElement>('[data-extension-panel]')) wirePanel(panel);
  track();
  schedule();
}

function wirePanel(panel: HTMLElement): void {
  const viewId = panel.dataset.extensionPanel!;
  const recordId = panel.dataset.record!;
  const status = panel.querySelector<HTMLElement>('.extension-panel-status')!;
  const next = panel.querySelector<HTMLButtonElement>('[data-panel-next]')!;
  const stop = panel.querySelector<HTMLButtonElement>('[data-panel-stop]')!;
  const generation = state.session.fileSessionId;
  let step: 'install' | 'allow' | 'show' | null = null;
  const refresh = async (): Promise<void> => {
    if (isRunning(viewId, recordId)) { drawRunning(panel, true); return; }
    try {
      const view = await client.request<PanelStatus>('extension.status', { viewId });
      if (!panel.isConnected || state.session.fileSessionId !== generation) return;
      if (isRunning(viewId, recordId)) { drawRunning(panel, true); return; }
      const packageName = view.definition.packageId + ' ' + view.definition.packageVersion;
      if (view.packageState !== 'available') {
        step = 'install'; next.textContent = 'Install package…';
        status.textContent = view.packageState === 'missing'
          ? packageName + ' is not on this device yet. Install it from its .nendoview file, then allow this view.'
          : view.packageState === 'incompatible'
            ? packageName + ' speaks a different protocol than this view. Pin a package built for this view in Studio; your records are unchanged.'
            : packageName + ' is ' + view.packageState + ' on this device. Install the exact package again from its .nendoview file.';
      } else if (!view.isApproved) {
        step = 'allow'; next.textContent = 'Allow this view';
        status.textContent = packageName + ' is installed. Allow this view to read the fields it names about this record.';
      } else {
        step = 'show'; next.textContent = 'Show view';
        // Nothing runs until asked: a view costs a browser engine of its own.
        status.textContent = stopped.get(key(viewId, recordId))
          ?? 'Starts only when you ask, and reads only this record. One custom view runs at a time.';
      }
      if (view.notice) status.textContent += ' ' + view.notice;
      next.disabled = false;
    } catch (error) {
      if (!panel.isConnected || state.session.fileSessionId !== generation) return;
      step = null; next.disabled = true; next.textContent = 'Unavailable';
      status.textContent = messageFor(error) + ' The page is still yours to edit.';
    }
  };
  next.addEventListener('click', () => {
    void (async () => {
      next.disabled = true;
      try {
        if (step === 'install') await client.request('extension.install', { viewId });
        else if (step === 'allow') await client.request('extension.review', { viewId });
        else if (step === 'show') {
          status.textContent = 'Starting the view…';
          await client.request('extension.panel.show', { viewId, recordId });
          stopped.delete(key(viewId, recordId));
          // The host stopped whichever view was running; every other placeholder says so.
          for (const other of document.querySelectorAll<HTMLElement>('[data-extension-panel]'))
            if (other !== panel) drawRunning(other, false);
          if (generation === null) return;
          running = { viewId, recordId, fileSessionId: generation };
          lastSent = '';
          drawRunning(panel, true);
          schedule();
          return;
        }
      } catch (error) {
        if (panel.isConnected) status.textContent = messageFor(error) + ' The page is still yours to edit.';
      }
      await refresh();
    })();
  });
  stop.addEventListener('click', () => {
    void (async () => {
      running = null;
      drawRunning(panel, false);
      try { await client.request('extension.panel.close', { viewId, recordId }); }
      catch (error) { status.textContent = messageFor(error); }
      await refresh();
    })();
  });
  panel.addEventListener('nendo:panel-refresh', () => { void refresh(); });
  void refresh();
}

function isRunning(viewId: string, recordId: string): boolean {
  return running !== null && running.viewId === viewId && running.recordId === recordId && running.fileSessionId === state.session.fileSessionId;
}

function drawRunning(panel: HTMLElement, on: boolean): void {
  const status = panel.querySelector<HTMLElement>('.extension-panel-status');
  const next = panel.querySelector<HTMLButtonElement>('[data-panel-next]');
  const stop = panel.querySelector<HTMLButtonElement>('[data-panel-stop]');
  const viewport = panel.querySelector<HTMLElement>('[data-panel-viewport]');
  if (!status || !next || !stop || !viewport) return;
  panel.classList.toggle('is-running', on);
  viewport.hidden = !on;
  next.hidden = on;
  stop.hidden = !on;
  if (on) status.textContent = 'Showing this record. The page stays editable; Stop view ends the view.';
  else if (!next.hidden && next.textContent === 'Show view' && !next.disabled)
    status.textContent = 'Starts only when you ask, and reads only this record. One custom view runs at a time.';
}

// --- Placement -------------------------------------------------------------------------

let tracking = false;
let frame = 0;
let settle = 0;
let scrolling = false;
let inFlight = false;
let again = false;
let lastSent = '';
let observed: HTMLElement | null = null;
const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());

function track(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  // Hidden at the first scroll event and put back once scrolling has stopped.
  document.addEventListener('scroll', () => {
    if (running === null) return;
    if (!scrolling) { scrolling = true; schedule(); }
    window.clearTimeout(settle);
    settle = window.setTimeout(() => { scrolling = false; schedule(); }, 150);
  }, { capture: true, passive: true });
  window.addEventListener('resize', () => schedule());
  // A redraw of the page, a folded section, a switched tab or an opened dialog all move
  // or cover the placeholder without scrolling anything.
  new MutationObserver(() => schedule()).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'class', 'style'],
  });
  client.onExtensionPanelStopped?.((event) => {
    if (running !== null && running.viewId === event.viewId && running.recordId === event.recordId) running = null;
    stopped.set(key(event.viewId, event.recordId), event.message);
    for (const panel of document.querySelectorAll<HTMLElement>('[data-extension-panel]')) {
      if (panel.dataset.extensionPanel !== event.viewId || panel.dataset.record !== event.recordId) continue;
      drawRunning(panel, false);
      panel.dispatchEvent(new Event('nendo:panel-refresh'));
    }
  });
}

function schedule(): void {
  if (running === null || typeof window === 'undefined' || frame !== 0) return;
  frame = window.requestAnimationFrame(() => { frame = 0; void place(); });
}

/** Where the running view's placeholder is, and how much of it the page shows. */
export function measure(viewport: HTMLElement, hidden: boolean): Placement {
  const rect = viewport.getBoundingClientRect();
  let left = Math.max(rect.left, 0), top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth), bottom = Math.min(rect.bottom, window.innerHeight);
  // Every scrolling ancestor cuts it to its own box.
  for (let parent = viewport.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent);
    if (!/(auto|scroll|hidden|clip)/.test(overflow.overflowX + overflow.overflowY)) continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left); top = Math.max(top, box.top);
    right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
    // A scroller's stuck header and Save bar stay on top of whatever scrolls under them;
    // the view's window would otherwise cover them, since it is above the whole page.
    for (const bar of parent.querySelectorAll<HTMLElement>(':scope > header, .form-actions')) {
      if (bar.contains(viewport) || getComputedStyle(bar).position !== 'sticky') continue;
      const edge = bar.getBoundingClientRect();
      if (bar.compareDocumentPosition(viewport) & Node.DOCUMENT_POSITION_FOLLOWING) top = Math.max(top, edge.bottom);
      else bottom = Math.min(bottom, edge.top);
    }
  }
  const shown = !hidden && rect.width >= 1 && rect.height >= 1 && right - left >= 1 && bottom - top >= 1 &&
    (typeof viewport.checkVisibility !== 'function' || viewport.checkVisibility()) &&
    document.querySelector('dialog[open]') === null && !covered(viewport, left, top, right, bottom);
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    visible: shown, x: round(rect.left), y: round(rect.top), width: round(Math.max(1, rect.width)), height: round(Math.max(1, rect.height)),
    clipX: round(left), clipY: round(top), clipWidth: round(Math.max(0, right - left)), clipHeight: round(Math.max(0, bottom - top)),
  };
}

/**
 * Whether anything of the page's own is drawn over the part of the placeholder it shows: the
 * File menu, a popover, a toast. The view's window sits above the whole page, so it would
 * cover them; the owner met it drawn over the File menu. Asking the page what is on top at
 * points across the box finds any of them without a list of which ones there are.
 */
function covered(viewport: HTMLElement, left: number, top: number, right: number, bottom: number): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  // Inset from the edges: the placeholder has rounded corners, and a point outside one is
  // the parent's, which would read as a cover on every placement.
  const inset = (low: number, high: number): [number, number] =>
    high - low > 24 ? [low + 12, high - 12] : [(low + high) / 2, (low + high) / 2];
  const [x0, x1] = inset(left, right), [y0, y1] = inset(top, bottom);
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * j) / steps;
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && hit !== viewport && !viewport.contains(hit)) return true;
    }
  }
  return false;
}

async function place(): Promise<void> {
  if (running === null) return;
  if (inFlight) { again = true; return; }
  const current = running;
  if (current.fileSessionId !== state.session.fileSessionId) { running = null; return; }
  const panel = [...document.querySelectorAll<HTMLElement>('[data-extension-panel]')]
    .find((candidate) => candidate.dataset.extensionPanel === current.viewId && candidate.dataset.record === current.recordId);
  const viewport = panel?.querySelector<HTMLElement>('[data-panel-viewport]') ?? null;
  inFlight = true;
  try {
    if (viewport === null) {
      // The page let go of it: another record, another screen, or the record was closed.
      running = null;
      await client.request('extension.panel.close', { viewId: current.viewId, recordId: current.recordId });
      return;
    }
    if (viewport.hidden) drawRunning(panel!, true);
    if (observed !== viewport) { if (observed !== null) resize?.unobserve(observed); resize?.observe(viewport); observed = viewport; }
    const placement = measure(viewport, scrolling);
    const sent = JSON.stringify(placement);
    if (sent === lastSent) return;
    lastSent = sent;
    const answer = await client.request<{ running: boolean }>('extension.panel.place', { viewId: current.viewId, recordId: current.recordId, ...placement });
    if (!answer.running && running === current) {
      running = null;
      drawRunning(panel!, false);
      panel!.dispatchEvent(new Event('nendo:panel-refresh'));
    }
  } catch {
    // The host answers a stopped view with its own event; nothing here is the person's to act on.
  } finally {
    inFlight = false;
    if (again) { again = false; schedule(); }
  }
}
