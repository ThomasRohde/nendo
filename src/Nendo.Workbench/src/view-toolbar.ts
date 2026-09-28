import type { CommandSource } from './extension-api/protocol';
import { focusWithoutInteraction } from './shell';
import { showViewMenu } from './view-menu';
import { viewToolbarMarkup } from './view-toolbar-markup';
import type { CommandValue, ToolbarItem, ToolbarMenu, ViewToolbar } from './view-toolbar-model';

/**
 * A custom view's toolbar on the page (ADR-0013, 2026-09-28; W-090): drawn from what the view
 * declared, in the Workbench's own markup, and wired so that a press becomes the view's
 * `command`. On a screen it shares the Use toolbar's row with Nendo's Add (W-092), or where a
 * page has no such row it is a strip above the frame; on a record page it sits in the panel's
 * header, beside the view's title. Like the Development strip it is outside the frame,
 * so the view cannot reach it, and it is drawn again on every redraw from the mount's copy.
 *
 * A redraw of the strip keeps the person where they were: the control they had focus on keeps
 * it, and a search box they are typing in is kept as it is, caret and all, however often the
 * view declares its toolbar meanwhile.
 */

export interface ToolbarHost {
  readonly toolbar: ViewToolbar | null;
  readonly title: string;
  readonly placement: 'screen' | 'recordPage';
  /** Keeps the IDs that tie a label to its control apart between two views on one page. */
  readonly prefix: string;
  send(id: string, value: CommandValue, source: CommandSource): void;
}

/** How long typing in a view's search box rests before the view hears it. */
const searchRestMs = 180;

function findMenu(items: readonly ToolbarItem[], id: string): ToolbarMenu | null {
  for (const item of items) if (item.kind === 'menu' && item.id === id) return item;
  return null;
}

/** The control that stands for the same thing in another drawing of the strip. */
function counterpart(scope: ParentNode, element: Element): HTMLElement | null {
  const command = element.getAttribute('data-view-command');
  const menu = element.getAttribute('data-view-menu');
  const value = element.getAttribute('data-view-value');
  if (menu !== null) return scope.querySelector<HTMLElement>(`[data-view-menu="${CSS.escape(menu)}"]`);
  if (command === null) return null;
  const selector = value === null ? `[data-view-command="${CSS.escape(command)}"]:not([data-view-value])`
    : `[data-view-command="${CSS.escape(command)}"][data-view-value="${CSS.escape(value)}"]`;
  return scope.querySelector<HTMLElement>(selector);
}

/** The Use toolbar's place for a screen's controls, beside Add (W-092), when the page has one. */
function rowSlot(placeholder: HTMLElement): HTMLElement | null {
  return placeholder.closest('.use-page')?.querySelector<HTMLElement>(':scope > .use-toolbar > [data-view-toolbar-slot]') ?? null;
}

/** Where a drawn strip lives: the Use toolbar's row or the screen's mount, or a panel's header. */
function stripScope(placeholder: HTMLElement, placement: ToolbarHost['placement']): HTMLElement | null {
  if (placement === 'screen') return rowSlot(placeholder) ?? placeholder;
  return placeholder.querySelector<HTMLElement>(':scope > .view-header');
}

/** Where the strip goes: in the Use toolbar's row, else first in a screen's mount, or at the end of a panel's header. */
function slot(placeholder: HTMLElement, placement: ToolbarHost['placement']): { parent: HTMLElement; before: Node | null } | null {
  if (placement === 'screen') {
    const row = rowSlot(placeholder);
    return row !== null ? { parent: row, before: null } : { parent: placeholder, before: placeholder.firstChild };
  }
  const header = placeholder.querySelector<HTMLElement>(':scope > .view-header');
  return header === null ? null : { parent: header, before: null };
}

/**
 * Draw the view's toolbar into its placeholder, replacing the one drawn before, or take it
 * away when the view declares none.
 */
export function drawViewToolbar(placeholder: HTMLElement, host: ToolbarHost): void {
  const scope = stripScope(placeholder, host.placement);
  const previous = scope?.querySelector<HTMLElement>(':scope > [data-view-toolbar]') ?? null;
  const inRow = host.placement === 'screen' && rowSlot(placeholder) !== null;
  const markup = host.toolbar === null ? '' : viewToolbarMarkup(host.toolbar, { title: host.title, compact: host.placement !== 'screen', inline: inRow, prefix: host.prefix });
  placeholder.classList.toggle('has-toolbar', markup !== '' && !inRow);
  if (markup === '') { previous?.remove(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  const strip = holder.firstElementChild as HTMLElement;
  wire(strip, host);
  const focused = previous !== null && document.activeElement !== null && previous.contains(document.activeElement) ? document.activeElement : null;
  if (previous !== null) previous.after(strip);
  else {
    const place = slot(placeholder, host.placement);
    if (place === null) return;
    place.parent.insertBefore(strip, place.before);
  }
  if (focused instanceof HTMLInputElement && focused.hasAttribute('data-view-search')) {
    // The person is typing: the box they type in stays, caret and all, and only what is
    // around it is new. moveBefore keeps its focus; without it the new box takes the text.
    const fresh = strip.querySelector<HTMLInputElement>(`input[data-view-command="${CSS.escape(focused.dataset.viewCommand ?? '')}"]`);
    const parent = fresh?.parentElement as (HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }) | null | undefined;
    if (fresh !== null && fresh !== undefined && parent !== null && parent !== undefined) {
      let moved = false;
      if (typeof parent.moveBefore === 'function') {
        try { parent.moveBefore(focused, fresh); moved = true; } catch { moved = false; }
      }
      if (moved) fresh.remove();
      else {
        const [start, end] = [focused.selectionStart, focused.selectionEnd];
        fresh.value = focused.value;
        focusWithoutInteraction(fresh);
        fresh.setSelectionRange(start, end);
      }
    }
  }
  previous?.remove();
  if (focused !== null && !strip.contains(focused) && document.activeElement !== focused) focusWithoutInteraction(counterpart(strip, focused));
}

function wire(strip: HTMLElement, host: ToolbarHost): void {
  strip.addEventListener('click', (event) => {
    const target = event.target as Element;
    const menuButton = target.closest<HTMLButtonElement>('button[data-view-menu]');
    if (menuButton !== null) { void openMenu(menuButton, host); return; }
    const button = target.closest<HTMLButtonElement>('button[data-view-command]');
    if (button === null || button.disabled) return;
    const id = button.dataset.viewCommand!;
    const value = button.dataset.viewValue;
    if (value !== undefined) {
      if (button.getAttribute('aria-pressed') !== 'true') host.send(id, value, 'toolbar');
    } else if (button.hasAttribute('aria-pressed')) host.send(id, button.getAttribute('aria-pressed') !== 'true', 'toolbar');
    else host.send(id, null, 'toolbar');
  });
  strip.addEventListener('change', (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement && select.dataset.viewCommand !== undefined) host.send(select.dataset.viewCommand, select.value, 'toolbar');
  });
  let resting: number | null = null;
  const search = (input: HTMLInputElement): void => {
    if (resting !== null) { window.clearTimeout(resting); resting = null; }
    host.send(input.dataset.viewCommand!, input.value, 'toolbar');
  };
  strip.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-view-search')) return;
    if (resting !== null) window.clearTimeout(resting);
    resting = window.setTimeout(() => search(input), searchRestMs);
  });
  strip.addEventListener('keydown', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-view-search')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter sends the text at once, and sends it again if it has only just gone, so a view
      // always hears the same text twice for an Enter and can go to the first match.
      if (resting !== null) search(input);
      search(input);
    }
    // Escape empties the box first, as a search field does, and leaves the page alone.
    else if (event.key === 'Escape' && input.value !== '') { event.preventDefault(); input.value = ''; search(input); }
  });
}

async function openMenu(button: HTMLButtonElement, host: ToolbarHost): Promise<void> {
  if (button.disabled || host.toolbar === null) return;
  const menu = findMenu(host.toolbar.items, button.dataset.viewMenu ?? '');
  if (menu === null) return;
  button.setAttribute('aria-expanded', 'true');
  const index = await showViewMenu(menu.items, { below: button.getBoundingClientRect() }, menu.label, button);
  button.setAttribute('aria-expanded', 'false');
  const item = index === null ? undefined : menu.items[index];
  if (item === undefined) return;
  if (item.kind === 'item' && !item.disabled) host.send(item.id, null, 'menu');
  else if (item.kind === 'check' && !item.disabled) host.send(item.id, !item.checked, 'menu');
  else if (item.kind === 'radio' && !item.disabled) host.send(item.id, item.value, 'menu');
}

/** Put the person in a view's search box, as its key or its Ctrl K entry asks. */
export function focusViewSearch(placeholder: HTMLElement, id: string): boolean {
  const scope = placeholder.classList.contains('is-screen') ? rowSlot(placeholder) ?? placeholder : placeholder;
  const input = scope.querySelector<HTMLInputElement>(`[data-view-toolbar] input[data-view-command="${CSS.escape(id)}"]`);
  if (input === null || input.disabled) return false;
  input.focus();
  input.select();
  return true;
}
