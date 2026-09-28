import type { WindowTitleBar } from './host-types';

/**
 * What the page claims of the window's title bar (W-093), as pure arithmetic over the boxes the
 * page measured, so a suite can hold it without a window. title-bar.ts does the measuring.
 */

/** A rectangle in the page's CSS pixels, from its top left. */
export interface TitleBarBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The most rectangles the host takes in one report; it refuses more. */
export const maximumTitleBarControls = 64;

/**
 * The title bar the host answered with, or null for anything that is not one. The numbers are
 * drawn into the page's layout, so they are bounded here as well as at the host.
 */
export function readTitleBar(value: unknown): WindowTitleBar | null {
  if (typeof value !== 'object' || value === null) return null;
  const bar = value as Partial<Record<keyof WindowTitleBar, unknown>>;
  const within = (number: unknown, most: number): number | null =>
    typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= most ? number : null;
  const height = within(bar.height, 200);
  const left = within(bar.left, 1000);
  const right = within(bar.right, 1000);
  return height === null || left === null || right === null ? null : { height, left, right };
}

export function sameTitleBar(a: WindowTitleBar | null, b: WindowTitleBar | null): boolean {
  return a === b || (a !== null && b !== null && a.height === b.height && a.left === b.left && a.right === b.right);
}

/**
 * The rectangles the page claims in the title bar: the part of each control's box inside the
 * bar's height, grown outwards to whole pixels so no edge of a control is left to the window.
 * A box inside another one (a select inside its label) is claimed once.
 *
 * While a menu or a dialog is open the page claims the whole bar up to Windows' own buttons, so
 * a press on the bar reaches the page and closes the menu, as it did before the bar was the
 * window's; the window moves again once it is closed. A bar with more controls than the host
 * takes is claimed whole too: every control keeps working and only dragging is lost, where a
 * list cut short would leave a control that neither works nor moves the window.
 */
export function titleBarControls(
  boxes: readonly TitleBarBox[], bar: WindowTitleBar, viewportWidth: number, layerOpen: boolean,
): TitleBarBox[] {
  const width = Math.ceil(viewportWidth);
  const height = Math.ceil(bar.height);
  if (width <= 0 || height <= 0) return [];
  const wholeLeft = Math.floor(bar.left);
  const wholeWidth = Math.max(0, Math.ceil(viewportWidth - bar.right) - wholeLeft);
  const whole = wholeWidth > 0 ? [{ x: wholeLeft, y: 0, width: wholeWidth, height }] : [];
  if (layerOpen) return whole;
  const claimed: TitleBarBox[] = [];
  for (const box of boxes) {
    if (!(box.width > 0 && box.height > 0)) continue;
    const left = Math.max(0, Math.floor(box.x));
    const top = Math.max(0, Math.floor(box.y));
    const right = Math.min(width, Math.ceil(box.x + box.width));
    const bottom = Math.min(height, Math.ceil(box.y + box.height));
    if (right > left && bottom > top) claimed.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  const inside = (a: TitleBarBox, b: TitleBarBox): boolean =>
    a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  const kept = claimed.filter((box, index) =>
    !claimed.some((other, at) => at !== index && inside(box, other) && (!inside(other, box) || at < index)));
  if (kept.length > maximumTitleBarControls) return whole;
  return kept.sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height);
}

export function sameBoxes(a: readonly TitleBarBox[], b: readonly TitleBarBox[]): boolean {
  return a.length === b.length && a.every((box, index) =>
    box.x === b[index].x && box.y === b[index].y && box.width === b[index].width && box.height === b[index].height);
}
