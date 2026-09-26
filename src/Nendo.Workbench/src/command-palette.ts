import { content, requiredElement } from './shell';
import { rankCommands, shortcut, type PaletteCommand, type RankedCommand, type ShortcutId } from './shortcuts';

/**
 * Ctrl K: one box that goes anywhere the window can go.
 *
 * The palette owns no behaviour of its own. Each command is a control already on screen
 * -- a rail item, a File action, a view in the picker, a theme button -- and running it
 * presses that control, so a command is refused, confirmed or announced exactly as the
 * click would be. What is disabled on screen is left out rather than offered and refused.
 *
 * It is a modal dialog, so every rule that stands aside for "a dialog is open" (Escape,
 * Alt+arrows, the redraw hold, file drops) already stands aside for it.
 */

const dialog = requiredElement<HTMLDialogElement>('#command-palette');
const input = requiredElement<HTMLInputElement>('#command-palette-input');
const list = requiredElement<HTMLUListElement>('#command-palette-list');
const empty = requiredElement<HTMLElement>('#command-palette-empty');

let ranked: RankedCommand[] = [];
let active = 0;
let returnFocus: HTMLElement | null = null;

/** The text a control shows, without the detail line or a key hint inside it. */
function labelOf(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const extra of clone.querySelectorAll('small, kbd, svg, .nav-symbol')) extra.remove();
  const strong = clone.querySelector('strong');
  return (strong?.textContent ?? clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function usable(element: Element | null): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement && !element.disabled && element.closest('[hidden]') === null;
}

const keysFor = (id: ShortcutId): string => shortcut(id).keys;

/** Every command the window can run right now, in the order the palette lists them. */
export function currentCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const press = (element: HTMLElement) => () => element.click();

  const go: [string, ShortcutId | null, string][] = [
    ['#nav-use', 'use', 'Use'], ['#nav-data', 'data', 'Data'], ['#nav-structure', 'structure', 'Structure'],
    ['#nav-surfaces', 'surfaces', 'Surfaces'], ['#nav-history', 'history', 'History'],
    ['#nav-health', 'health', 'Health'], ['#nav-agent', 'agent', 'Agent access'], ['#nav-help', 'help', 'Help'],
  ];
  for (const [selector, id, label] of go) {
    const button = document.querySelector(selector);
    if (usable(button)) commands.push({ id: selector, label, group: 'Go to', keys: id === null ? undefined : keysFor(id), run: press(button) });
  }
  for (const [selector, id] of [['#nav-back', 'back'], ['#nav-forward', 'forward']] as const) {
    const button = document.querySelector(selector);
    if (usable(button)) commands.push({ id: selector, label: button.getAttribute('aria-label') ?? '', group: 'Go to', keys: keysFor(id), run: press(button) });
  }

  // The record types and views of the screen on show. They exist only on a Use page, and
  // the palette offers what that page offers.
  const entity = content.querySelector<HTMLSelectElement>('#use-entity');
  if (entity !== null && !entity.disabled) {
    for (const option of entity.options) {
      if (option.selected || option.disabled) continue;
      commands.push({
        id: `entity:${option.value}`, label: `Show ${option.textContent?.trim() ?? option.value}`, group: 'Record types',
        run: () => { entity.value = option.value; entity.dispatchEvent(new Event('change', { bubbles: true })); },
      });
    }
  }
  for (const view of content.querySelectorAll<HTMLButtonElement>('.surface-picker-options button')) {
    if (!usable(view) || view.getAttribute('aria-pressed') === 'true') continue;
    commands.push({ id: `view:${view.dataset.selectSurface ?? labelOf(view)}`, label: `View ${labelOf(view)}`, group: 'Views', run: press(view) });
  }
  const create = content.querySelector('#new-record');
  if (usable(create)) commands.push({ id: '#new-record', label: labelOf(create), group: 'This page', run: press(create) });

  for (const action of document.querySelectorAll<HTMLButtonElement>('#file-actions [data-file-action]')) {
    if (!usable(action)) continue;
    commands.push({ id: `file:${action.dataset.fileAction}`, label: labelOf(action), group: 'File', run: press(action) });
  }

  for (const theme of document.querySelectorAll<HTMLButtonElement>('[data-theme-option]')) {
    if (theme.getAttribute('aria-pressed') === 'true') continue;
    commands.push({ id: `theme:${theme.dataset.themeOption}`, label: `${theme.getAttribute('aria-label')} theme`, group: 'Appearance', run: press(theme) });
  }
  const rail = document.querySelector('#rail-toggle');
  if (usable(rail) && rail.offsetParent !== null)
    commands.push({ id: '#rail-toggle', label: rail.getAttribute('aria-label') ?? 'Fold navigation', group: 'Appearance', keys: keysFor('rail'), run: press(rail) });
  const hints = document.querySelector('#shortcuts-toggle');
  if (usable(hints))
    commands.push({ id: '#shortcuts-toggle', label: hints.getAttribute('aria-pressed') === 'true' ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts', group: 'Appearance', keys: keysFor('hints'), run: press(hints) });
  return commands;
}

function draw(): void {
  list.replaceChildren();
  ranked.forEach((entry, index) => {
    const item = document.createElement('li');
    item.id = `command-option-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === active));
    item.dataset.commandId = entry.command.id;
    const previous = ranked[index - 1];
    if (previous === undefined || previous.command.group !== entry.command.group) item.dataset.group = entry.command.group;
    const label = document.createElement('span');
    label.className = 'command-label';
    const hit = new Set(entry.matched);
    [...entry.command.label].forEach((character, at) => {
      if (!hit.has(at)) { label.append(character); return; }
      const mark = document.createElement('mark');
      mark.textContent = character;
      label.append(mark);
    });
    const group = document.createElement('span');
    group.className = 'command-group';
    group.textContent = entry.command.group;
    item.append(label, group);
    if (entry.command.keys !== undefined) {
      const keys = document.createElement('kbd');
      keys.textContent = entry.command.keys;
      item.append(keys);
    }
    item.addEventListener('pointerdown', (event) => event.preventDefault());
    item.addEventListener('click', () => runAt(index));
    list.append(item);
  });
  empty.hidden = ranked.length > 0;
  if (ranked.length > 0) {
    input.setAttribute('aria-activedescendant', `command-option-${active}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function filter(): void {
  ranked = rankCommands(input.value, currentCommands());
  active = 0;
  draw();
}

function runAt(index: number): void {
  const entry = ranked[index];
  if (entry === undefined) return;
  returnFocus = null;
  dialog.close();
  // After the dialog has gone, so the command lands on the page rather than under a modal.
  entry.command.run();
}

export function openPalette(): void {
  if (dialog.open) { input.select(); return; }
  if (document.querySelector('dialog[open]') !== null) return;
  requiredElement<HTMLDetailsElement>('#file-menu').open = false;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  input.value = '';
  dialog.showModal();
  filter();
  input.focus();
}

input.addEventListener('input', filter);
input.addEventListener('keydown', (event) => {
  const last = ranked.length - 1;
  if (event.key === 'ArrowDown') active = active >= last ? 0 : active + 1;
  else if (event.key === 'ArrowUp') active = active <= 0 ? last : active - 1;
  else if (event.key === 'Home' && event.ctrlKey) active = 0;
  else if (event.key === 'End' && event.ctrlKey) active = last;
  else if (event.key === 'Enter') { event.preventDefault(); runAt(active); return; }
  else return;
  event.preventDefault();
  draw();
});
// A press on the backdrop is a press outside the box.
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
  const back = returnFocus;
  returnFocus = null;
  if (back !== null && back.isConnected) back.focus();
});
