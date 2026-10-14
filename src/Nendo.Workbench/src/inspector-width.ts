import { deviceStorage } from './device-storage';

/**
 * How wide the record page beside a list, board or calendar is.
 *
 * The person drags its edge, or moves it with the arrow keys, and the width is kept for
 * the device the way the rail is: it is their view of the window, not part of any file,
 * so one width serves every file. The surface keeps at least `minimumSurfaceWidth`, so a
 * width remembered from a wide window narrows itself in a small one rather than pushing
 * the list out of sight; widening the window gives the remembered width back.
 */
export const inspectorWidthStorageKey = 'nendo.recordInspectorWidth';
export const defaultInspectorWidth = 420;
export const minimumInspectorWidth = 320;
export const minimumSurfaceWidth = 360;
const keyStep = 16;
const largeKeyStep = 64;

/** The width to draw, given the one asked for and the room the layout has. */
export function clampInspectorWidth(width: number, layoutWidth: number): number {
  const maximum = Math.max(minimumInspectorWidth, layoutWidth - minimumSurfaceWidth);
  return Math.round(Math.min(maximum, Math.max(minimumInspectorWidth, width)));
}

/** The remembered width, or null when there is none or it is not a width. */
export function readInspectorWidth(storage: Pick<Storage, 'getItem'> | null): number | null {
  if (storage === null) return null;
  try {
    const value = Number(storage.getItem(inspectorWidthStorageKey));
    return Number.isFinite(value) && value >= minimumInspectorWidth ? Math.round(value) : null;
  } catch {
    return null;
  }
}

export function writeInspectorWidth(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, width: number | null): void {
  if (storage === null) return;
  try {
    if (width === null) storage.removeItem(inspectorWidthStorageKey);
    else storage.setItem(inspectorWidthStorageKey, String(Math.round(width)));
  } catch {
    // The edge still moves in this window when device persistence is unavailable.
  }
}

/** Where a key moves the edge, or null for a key that does not. Left widens: the edge is the page's left side. */
export function keyedInspectorWidth(key: string, shift: boolean, current: number, layoutWidth: number): number | null {
  const step = shift ? largeKeyStep : keyStep;
  switch (key) {
    case 'ArrowLeft': return clampInspectorWidth(current + step, layoutWidth);
    case 'ArrowRight': return clampInspectorWidth(current - step, layoutWidth);
    case 'Home': return clampInspectorWidth(Number.MAX_SAFE_INTEGER, layoutWidth);
    case 'End': return minimumInspectorWidth;
    default: return null;
  }
}

export const inspectorResizerMarkup =
  '<div class="inspector-resizer" role="separator" aria-orientation="vertical" aria-label="Resize details pane" title="Drag to resize. Double-click to reset." tabindex="0" data-testid="inspector-resizer"></div>';

/**
 * Wire the edge of the record page in `layout`. Called after every draw: the layout is
 * new each time, so nothing here outlives it.
 */
export function wireInspectorResizer(layout: HTMLElement): void {
  const handle = layout.querySelector<HTMLElement>(':scope > .inspector-resizer');
  if (handle === null) return;
  let requested = readInspectorWidth(deviceStorage()) ?? defaultInspectorWidth;
  const apply = (width: number): void => {
    const shown = clampInspectorWidth(width, layout.clientWidth);
    layout.style.setProperty('--record-inspector-width', `${shown}px`);
    handle.setAttribute('aria-valuemin', String(minimumInspectorWidth));
    handle.setAttribute('aria-valuemax', String(clampInspectorWidth(Number.MAX_SAFE_INTEGER, layout.clientWidth)));
    handle.setAttribute('aria-valuenow', String(shown));
  };
  const commit = (width: number): void => {
    requested = clampInspectorWidth(width, layout.clientWidth);
    apply(requested);
    writeInspectorWidth(deviceStorage(), requested);
  };
  apply(requested);

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    layout.classList.add('is-resizing-inspector');
    const right = layout.getBoundingClientRect().right;
    const move = (moved: PointerEvent): void => apply(right - moved.clientX);
    const finish = (ended: PointerEvent): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      layout.classList.remove('is-resizing-inspector');
      if (ended.type === 'pointerup') commit(right - ended.clientX);
      else apply(requested);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('dblclick', () => {
    requested = defaultInspectorWidth;
    apply(requested);
    writeInspectorWidth(deviceStorage(), null);
  });
  handle.addEventListener('keydown', (event) => {
    const current = Number(handle.getAttribute('aria-valuenow'));
    const next = keyedInspectorWidth(event.key, event.shiftKey, current, layout.clientWidth);
    if (next === null) return;
    event.preventDefault();
    commit(next);
  });
  // A window made narrower takes width from the page before it takes it from the list,
  // and gives it back when the window widens again.
  new ResizeObserver(() => { if (layout.isConnected) apply(requested); }).observe(layout);
}
