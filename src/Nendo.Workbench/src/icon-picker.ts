import { findIcons, iconGroups, knownIcon, setIconMarkup } from './chosen-icons';
import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';

/**
 * The icon picker (ADR-0038): a search over the set's names and search words, its groups, the
 * icons used last on this device, and a grid the arrow keys move through. It answers the chosen
 * icon's name, null for Use the guessed icon, or undefined when the person closes it unchanged.
 */

const recentKey = 'nendo.icons.recent';
const columns = 8;

function recentIcons(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(recentKey) ?? '[]');
    return Array.isArray(stored) ? stored.map(knownIcon).filter((name): name is string => name !== null).slice(0, 8) : [];
  } catch { return []; }
}

function keepRecent(name: string): void {
  try { window.localStorage.setItem(recentKey, JSON.stringify([name, ...recentIcons().filter(other => other !== name)].slice(0, 8))); }
  catch { /* A device that keeps nothing still chose the icon. */ }
}

function cell(name: string, selected: string | null): string {
  return `<button type="button" class="icon-cell" role="option" aria-selected="${name === selected}" aria-label="${escapeAttribute(name)}" title="${escapeAttribute(name)}" tabindex="-1" data-icon-name="${escapeAttribute(name)}">${setIconMarkup(name)}</button>`;
}

export function chooseIcon(request: { title: string; current: string | null; guessed: IconName }): Promise<string | null | undefined> {
  return new Promise(resolve => {
    let selected = knownIcon(request.current);
    let query = '';
    let group: string | null = null;
    const dialog = document.createElement('dialog');
    dialog.className = 'icon-picker';
    dialog.setAttribute('aria-labelledby', 'icon-picker-title');
    dialog.innerHTML = `<div class="icon-picker-head"><h2 id="icon-picker-title">${escapeHtml(request.title)}</h2><button type="button" class="icon-cell" data-icon-cancel aria-label="Close">${icon('close')}</button></div>
      <label class="visually-hidden" for="icon-picker-search">Find an icon</label>
      <input id="icon-picker-search" type="search" autocomplete="off" placeholder="Find an icon: chapter, people, date" />
      <div class="icon-picker-groups" role="group" aria-label="Groups"></div>
      <div class="icon-picker-body"></div>
      <div class="icon-picker-foot"><span class="icon-picker-name" aria-live="polite"></span><button type="button" class="text-button" data-icon-guessed>Use the guessed icon</button><button type="button" class="secondary-button" data-icon-cancel>Cancel</button><button type="button" class="primary-button" data-icon-choose>Choose</button></div>`;
    const search = dialog.querySelector<HTMLInputElement>('#icon-picker-search')!;
    const groups = dialog.querySelector<HTMLElement>('.icon-picker-groups')!;
    const body = dialog.querySelector<HTMLElement>('.icon-picker-body')!;
    const name = dialog.querySelector<HTMLElement>('.icon-picker-name')!;
    const choose = dialog.querySelector<HTMLButtonElement>('[data-icon-choose]')!;
    let answer: string | null | undefined;

    const finish = (value: string | null | undefined): void => {
      answer = value;
      if (typeof value === 'string') keepRecent(value);
      dialog.close();
    };
    const drawGroups = (): void => {
      groups.innerHTML = [null, ...iconGroups].map(item => `<button type="button" class="icon-chip" aria-pressed="${item === group}" data-icon-group="${escapeAttribute(item ?? '')}">${escapeHtml(item ?? 'All')}</button>`).join('');
    };
    const drawGrid = (): void => {
      const found = findIcons(query, group);
      const recent = query === '' && group === null ? recentIcons() : [];
      body.innerHTML = (recent.length > 0 ? `<p class="icon-picker-label" id="icon-recent-label">Used last</p><div class="icon-grid" role="listbox" aria-labelledby="icon-recent-label">${recent.map(item => cell(item, selected)).join('')}</div>` : '')
        + `<p class="icon-picker-label" id="icon-all-label">${query === '' ? escapeHtml(group ?? 'All icons') : `${found.length} found`}</p>`
        + (found.length === 0 ? '<p class="icon-picker-empty">No icon matches. Try another word.</p>'
          : `<div class="icon-grid" role="listbox" aria-labelledby="icon-all-label">${found.map(item => cell(item.name, selected)).join('')}</div>`);
      // One stop for Tab in each grid: the chosen icon, or the first.
      for (const grid of body.querySelectorAll<HTMLElement>('.icon-grid'))
        (grid.querySelector<HTMLElement>('[aria-selected="true"]') ?? grid.querySelector<HTMLElement>('.icon-cell'))?.setAttribute('tabindex', '0');
      name.textContent = selected ?? `Guessed: ${request.guessed}`;
      choose.disabled = selected === null;
    };
    const select = (value: string): void => {
      selected = value;
      for (const button of body.querySelectorAll<HTMLElement>('.icon-cell')) {
        const on = button.dataset.iconName === value;
        button.setAttribute('aria-selected', String(on));
      }
      name.textContent = value;
      choose.disabled = false;
    };

    search.addEventListener('input', () => { query = search.value; drawGrid(); });
    groups.addEventListener('click', event => {
      const chip = (event.target as Element).closest<HTMLElement>('[data-icon-group]');
      if (!chip) return;
      group = chip.dataset.iconGroup === '' ? null : chip.dataset.iconGroup!;
      drawGroups(); drawGrid();
      groups.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    });
    body.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-icon-name]');
      if (button) select(button.dataset.iconName!);
    });
    body.addEventListener('dblclick', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-icon-name]');
      if (button) finish(button.dataset.iconName!);
    });
    body.addEventListener('keydown', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-icon-name]');
      if (!button) return;
      const cells = [...button.parentElement!.querySelectorAll<HTMLElement>('.icon-cell')];
      const at = cells.indexOf(button);
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns, Home: -at, End: cells.length - 1 - at }[event.key];
      if (event.key === 'Enter') { event.preventDefault(); finish(button.dataset.iconName!); return; }
      if (event.key === ' ') { event.preventDefault(); select(button.dataset.iconName!); return; }
      if (step === undefined) return;
      event.preventDefault();
      const next = cells[Math.min(cells.length - 1, Math.max(0, at + step))];
      button.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
    });
    dialog.querySelector('[data-icon-guessed]')!.addEventListener('click', () => finish(null));
    for (const cancel of dialog.querySelectorAll('[data-icon-cancel]')) cancel.addEventListener('click', () => finish(undefined));
    choose.addEventListener('click', () => { if (selected !== null) finish(selected); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); });

    drawGroups();
    drawGrid();
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
  });
}
