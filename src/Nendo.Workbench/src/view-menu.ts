import { viewMenuMarkup } from './view-toolbar-markup';
import type { MenuItem } from './view-toolbar-model';

/**
 * Nendo's own menu for a custom view (ADR-0013, 2026-09-28; W-090): a toolbar menu under its
 * button, or the menu a view asked for at a point in its frame. It is the Workbench's markup,
 * in the Workbench's document, drawn from a checked declaration, so a view's right-click
 * reads and behaves like every other menu in Nendo and can reach nothing here.
 *
 * One menu is open at a time. It lives on the body rather than in the page, so a redraw does
 * not take it from under the pointer, and shell.interactionInProgress holds the page while it
 * is open. It closes on a pick, on Escape or Tab, on a press anywhere else, and when the window
 * loses focus, scrolls or resizes. Arrow keys, Home and End move between items; Enter or
 * Space picks.
 */

interface OpenMenu {
  element: HTMLElement;
  finish: (index: number | null) => void;
}

let current: OpenMenu | null = null;

/** Whether a view's menu is open: the page is being used while it is. */
export function viewMenuOpen(): boolean {
  return current !== null;
}

/** Dismiss the open menu, if any, as a press elsewhere would. */
export function closeViewMenu(): void {
  current?.finish(null);
}

/** Where a menu goes: at a point, or under (or beside) the control that opened it. */
export type MenuAnchor = { x: number; y: number } | { below: DOMRect };

function items(element: HTMLElement): HTMLButtonElement[] {
  return [...element.querySelectorAll<HTMLButtonElement>('.view-menu-item:not(:disabled)')];
}

function place(element: HTMLElement, anchor: MenuAnchor): void {
  const margin = 8;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let left: number;
  let top: number;
  if ('below' in anchor) {
    left = anchor.below.left;
    top = anchor.below.bottom + 4;
    // A menu that would run off the right edge lines up with its button's right edge instead,
    // and one that would run off the bottom opens above its button.
    if (left + width > window.innerWidth - margin) left = anchor.below.right - width;
    if (top + height > window.innerHeight - margin) top = anchor.below.top - 4 - height;
  } else {
    left = anchor.x;
    top = anchor.y;
    if (left + width > window.innerWidth - margin) left = anchor.x - width;
    if (top + height > window.innerHeight - margin) top = anchor.y - height;
  }
  element.style.left = `${Math.round(Math.max(margin, Math.min(left, window.innerWidth - margin - width)))}px`;
  element.style.top = `${Math.round(Math.max(margin, Math.min(top, window.innerHeight - margin - height)))}px`;
}

/**
 * Draw a menu and answer the index of the item picked, or null when the person dismisses it.
 * Opening a menu dismisses the one that was open. Focus returns to `returnFocus` when the menu
 * closes, unless the pick has already moved it.
 */
export function showViewMenu(menu: readonly MenuItem[], anchor: MenuAnchor, label: string, returnFocus: HTMLElement | null): Promise<number | null> {
  closeViewMenu();
  const holder = document.createElement('div');
  holder.innerHTML = viewMenuMarkup(menu, label);
  const element = holder.firstElementChild as HTMLElement;
  element.style.position = 'fixed';
  element.style.left = '0px';
  element.style.top = '0px';
  element.style.visibility = 'hidden';
  document.body.append(element);
  place(element, anchor);
  element.style.visibility = '';

  return new Promise<number | null>((resolve) => {
    const controller = new AbortController();
    const listen = <K extends keyof WindowEventMap>(target: Window | Document, type: K, handler: (event: WindowEventMap[K]) => void, capture = true): void =>
      target.addEventListener(type, handler as EventListener, { capture, signal: controller.signal });
    const finish = (index: number | null): void => {
      if (current?.element !== element) return;
      current = null;
      controller.abort();
      element.remove();
      const keepFocus = index !== null && document.activeElement !== null && document.activeElement !== document.body && !element.contains(document.activeElement);
      if (!keepFocus && returnFocus !== null && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      resolve(index);
    };
    current = { element, finish };

    element.addEventListener('click', (event) => {
      const item = (event.target as Element).closest<HTMLButtonElement>('.view-menu-item');
      if (item === null || item.disabled) return;
      finish(Number(item.dataset.menuIndex));
    });
    // The item under the pointer is the one the keys start from.
    element.addEventListener('pointermove', (event) => {
      const item = (event.target as Element).closest<HTMLButtonElement>('.view-menu-item');
      if (item !== null && !item.disabled && document.activeElement !== item) item.focus({ preventScroll: true });
    });
    element.addEventListener('keydown', (event) => {
      const all = items(element);
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const move = (to: number): void => { event.preventDefault(); all[(to + all.length) % all.length]?.focus({ preventScroll: true }); };
      switch (event.key) {
        case 'ArrowDown': move(at + 1); break;
        case 'ArrowUp': move(at < 0 ? all.length - 1 : at - 1); break;
        case 'Home': move(0); break;
        case 'End': move(all.length - 1); break;
        case 'Escape':
          // Escape closes the menu and nothing else: main.ts's Escape stands aside for it.
          event.preventDefault();
          event.stopPropagation();
          finish(null);
          break;
        case 'Tab': event.preventDefault(); finish(null); break;
        case 'Enter':
        case ' ':
          if (at >= 0) { event.preventDefault(); finish(Number(all[at].dataset.menuIndex)); }
          break;
        default: break;
      }
    });
    listen(document, 'pointerdown', (event) => { if (!element.contains(event.target as Node)) finish(null); });
    listen(window, 'blur', () => finish(null), false);
    listen(window, 'resize', () => finish(null), false);
    listen(document, 'scroll', (event) => { if (!element.contains(event.target as Node)) finish(null); });
    items(element)[0]?.focus({ preventScroll: true });
  });
}
