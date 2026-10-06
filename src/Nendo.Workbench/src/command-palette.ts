import { buildSearchIndex } from './actions';
import { state } from './app-state';
import { client } from './client';
import { openRecordFromView } from './extension-ui';
import { messageFor } from './format';
import { WorkbenchHostError } from './host-types';
import { highlightedSnippet, type SearchPageView } from './search-text';
import { content, requiredElement, showError } from './shell';
import { rankCommands, shortcut, type PaletteCommand, type RankedCommand, type ShortcutId } from './shortcuts';
import { viewPaletteCommands } from './view-frames';
import { closeViewMenu } from './view-menu';

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
 *
 * Below the commands it lists the records whose text holds what was typed (ADR-0028), from the
 * file's search index. That search waits for a pause in typing, and only the answer to the latest
 * text is shown. A file without an index offers to build one, which is the only thing here that
 * the palette does itself.
 */

const dialog = requiredElement<HTMLDialogElement>('#command-palette');
const input = requiredElement<HTMLInputElement>('#command-palette-input');
const list = requiredElement<HTMLUListElement>('#command-palette-list');
const empty = requiredElement<HTMLElement>('#command-palette-empty');

/** A record the search found, or the offer to build the index, listed after the commands. */
interface PaletteRecord {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly snippetHtml: string;
  readonly run: () => void;
}

let ranked: RankedCommand[] = [];
let records: PaletteRecord[] = [];
let active = 0;
let returnFocus: HTMLElement | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSequence = 0;

/** How long typing must pause before the records are searched, and the fewest characters searched. */
const searchPauseMs = 150;
const searchMinimum = 2;
const searchLimit = 8;

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

  // The record types and views of the screen on show. They exist only on a Use page, in the
  // breadcrumb since W-092, and the palette offers what that page offers.
  const entity = document.querySelector<HTMLSelectElement>('#place-pickers #use-entity');
  if (entity !== null && !entity.disabled) {
    for (const option of entity.options) {
      if (option.selected || option.disabled) continue;
      commands.push({
        id: `entity:${option.value}`, label: `Show ${option.textContent?.trim() ?? option.value}`, group: 'Record types',
        run: () => { entity.value = option.value; entity.dispatchEvent(new Event('change', { bubbles: true })); },
      });
    }
  }
  for (const view of document.querySelectorAll<HTMLButtonElement>('#place-pickers .surface-picker-options button')) {
    if (!usable(view) || view.getAttribute('aria-pressed') === 'true') continue;
    commands.push({ id: `view:${view.dataset.selectSurface ?? labelOf(view)}`, label: `View ${labelOf(view)}`, group: 'Views', run: press(view) });
  }
  const create = content.querySelector('#new-record');
  if (usable(create)) commands.push({ id: '#new-record', label: labelOf(create), group: 'This page', run: press(create) });
  // What the custom views on the page offer, under each view's title (W-090). Each runs as a
  // press of its control does, and what a view disabled is left out.
  commands.push(...viewPaletteCommands());

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

function entryCount(): number {
  return ranked.length + records.length;
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
  records.forEach((record, offset) => {
    const index = ranked.length + offset;
    const item = document.createElement('li');
    item.id = `command-option-${index}`;
    item.className = 'command-record';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === active));
    item.dataset.commandId = record.id;
    if (offset === 0) item.dataset.group = 'Records';
    const text = document.createElement('span');
    text.className = 'command-record-text';
    const label = document.createElement('span');
    label.className = 'command-label';
    label.textContent = record.label;
    text.append(label);
    if (record.snippetHtml.length > 0) {
      const snippet = document.createElement('span');
      snippet.className = 'command-snippet';
      // Built from the host's plain-text excerpt: escaped, with only <mark> added around matches.
      snippet.innerHTML = record.snippetHtml;
      text.append(snippet);
    }
    const group = document.createElement('span');
    group.className = 'command-group';
    group.textContent = record.detail;
    item.append(text, group);
    item.addEventListener('pointerdown', (event) => event.preventDefault());
    item.addEventListener('click', () => runAt(index));
    list.append(item);
  });
  empty.hidden = entryCount() > 0;
  if (entryCount() > 0) {
    input.setAttribute('aria-activedescendant', `command-option-${active}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function filter(): void {
  ranked = rankCommands(input.value, currentCommands());
  active = 0;
  scheduleSearch();
  draw();
}

/** Searches the records once typing pauses; an answer to text that has since changed is dropped. */
function scheduleSearch(): void {
  clearTimeout(searchTimer);
  const text = input.value.trim();
  const sequence = ++searchSequence;
  if (text.length < searchMinimum || state.session.fileSessionId === null || !state.session.capabilities.readData) {
    if (records.length > 0) { records = []; }
    return;
  }
  searchTimer = setTimeout(() => void searchRecords(text, sequence), searchPauseMs);
}

async function searchRecords(text: string, sequence: number): Promise<void> {
  let found: PaletteRecord[];
  try {
    const page = await client.request<SearchPageView>('data.searchRecords', { text, limit: searchLimit, entityIds: [], fieldIds: [] });
    found = page.items.map((hit) => {
      const entity = state.session.entities.find((candidate) => candidate.entityId === hit.entityId);
      const field = hit.fields[0];
      const fieldName = entity?.fields.find((candidate) => candidate.fieldId === field?.fieldId)?.displayName;
      return {
        id: `record:${hit.entityId}:${hit.recordId}`,
        label: hit.label ?? hit.recordId,
        detail: entity?.displayName ?? hit.entityId,
        // The title is already the label, so an excerpt of it would only say it twice.
        snippetHtml: field === undefined || field.snippet === hit.label ? '' :
          (fieldName === undefined ? '' : `${highlightedSnippet(fieldName, [])}: `) + highlightedSnippet(field.snippet, field.ranges),
        run: () => { void openRecordFromView(hit.entityId, hit.recordId).catch((error: unknown) => showError(messageFor(error))); },
      };
    });
  } catch (error) {
    if (!(error instanceof WorkbenchHostError) || error.code !== 'search-index-missing') found = [];
    else found = [{
      id: 'search:build-index', label: 'Build the search index', detail: 'Records',
      snippetHtml: highlightedSnippet('Find records by any word in their text. Nendo keeps the index current after this.', []),
      run: () => { void buildSearchIndex().then((built) => { if (built) openPalette(text); }); },
    }];
  }
  if (sequence !== searchSequence || !dialog.open) return;
  // Keep the highlight where it was when it sits on a command; the records arrive below them.
  const onCommand = active < ranked.length;
  records = found;
  if (!onCommand) active = ranked.length > 0 || records.length === 0 ? 0 : ranked.length;
  draw();
}

function runAt(index: number): void {
  const command = ranked[index];
  const record = records[index - ranked.length];
  if (command === undefined && record === undefined) return;
  returnFocus = null;
  dialog.close();
  // After the dialog has gone, so the command lands on the page rather than under a modal.
  if (command !== undefined) command.command.run();
  else record!.run();
}

export function openPalette(initial = ''): void {
  if (dialog.open) { input.select(); return; }
  if (document.querySelector('dialog[open]') !== null) return;
  requiredElement<HTMLDetailsElement>('#file-menu').open = false;
  closeViewMenu();
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  input.value = initial;
  records = [];
  dialog.showModal();
  filter();
  input.focus();
}

input.addEventListener('input', filter);
input.addEventListener('keydown', (event) => {
  const last = entryCount() - 1;
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
  clearTimeout(searchTimer);
  searchSequence += 1;
  const back = returnFocus;
  returnFocus = null;
  if (back !== null && back.isConnected) back.focus();
});
