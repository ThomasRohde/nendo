import type { IHeaderComp, IHeaderParams } from 'ag-grid-community';
import { icon } from './icons';
import type { SortDirection } from './studio-columns';

/**
 * A Studio data column header: the field's name, which sorts the records when clicked, and a
 * rename control beside it.
 *
 * The grid's own sorting is not used. It would reorder the page that happens to be loaded,
 * which reads as sorting every record and is not; a click here asks the host instead, so the
 * order holds across every page. Renaming changes the field's display name, a definition
 * change, so it ends in a proposal the person reviews rather than in a silent write.
 *
 * Keys: Enter on a focused header sorts, F2 renames. In the name box, Enter reviews the
 * rename and Escape puts the header back.
 */
export interface StudioHeaderOptions {
  sort: SortDirection | null;
  onSort: ((byKeyboard: boolean) => void) | null;
  onRename: ((name: string) => void) | null;
}

export class StudioHeader implements IHeaderComp {
  private gui = document.createElement('div');
  private params!: IHeaderParams & StudioHeaderOptions;
  private observer: MutationObserver | null = null;
  private readonly onHeaderKey = (event: KeyboardEvent): void => {
    if (event.target !== this.params.eGridHeader || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' && this.params.onSort !== null) { event.preventDefault(); this.params.onSort(true); }
    else if (event.key === 'F2' && this.params.onRename !== null) { event.preventDefault(); this.startRename(); }
  };

  init(params: IHeaderParams & StudioHeaderOptions): void {
    this.params = params;
    this.gui.className = 'studio-header';
    this.draw();
    const header = params.eGridHeader;
    header.addEventListener('keydown', this.onHeaderKey);
    // The grid clears aria-sort on a column it does not sort itself, after this header is set
    // up and again whenever its own sort changes. An observer puts the header's word back each
    // time; a timer or an animation frame would not do, because a hidden window runs neither.
    const sort = params.onSort === null ? null : params.sort === 'asc' ? 'ascending' : params.sort === 'desc' ? 'descending' : 'none';
    const keys = [params.onSort !== null ? 'Enter sorts' : '', params.onRename !== null ? 'F2 renames' : ''].filter(Boolean);
    const description = keys.length > 0 ? `${keys.join(', ')}.` : null;
    const state = (): void => {
      if (sort !== null && header.getAttribute('aria-sort') !== sort) header.setAttribute('aria-sort', sort);
      if (description !== null && header.getAttribute('aria-description') !== description) header.setAttribute('aria-description', description);
    };
    state();
    this.observer = new MutationObserver(state);
    this.observer.observe(header, { attributes: true, attributeFilter: ['aria-sort', 'aria-description'] });
  }

  getGui(): HTMLElement { return this.gui; }

  refresh(): boolean { return false; }

  destroy(): void {
    this.observer?.disconnect();
    this.params.eGridHeader.removeEventListener('keydown', this.onHeaderKey);
  }

  private draw(): void {
    const { displayName, sort, onSort, onRename } = this.params;
    this.gui.replaceChildren();
    const label = document.createElement(onSort === null ? 'span' : 'button');
    label.className = 'studio-header-label';
    if (label instanceof HTMLButtonElement) {
      label.type = 'button';
      label.tabIndex = -1;
      label.title = sort === null ? `Sort by ${displayName}` : sort === 'asc' ? `Sorted ascending. Click to sort descending` : 'Sorted descending. Click for record order';
      label.addEventListener('click', () => onSort?.(false));
    }
    const text = document.createElement('span');
    text.className = 'ag-header-cell-text';
    text.textContent = displayName;
    label.append(text);
    if (onSort !== null) {
      const indicator = document.createElement('span');
      indicator.className = 'studio-sort-indicator';
      indicator.dataset.sort = sort ?? 'none';
      indicator.innerHTML = icon(sort === 'desc' ? 'arrowDown' : 'arrowUp');
      label.append(indicator);
    }
    this.gui.append(label);
    if (onRename !== null) {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.tabIndex = -1;
      rename.className = 'studio-header-rename';
      rename.title = `Rename ${displayName}`;
      rename.setAttribute('aria-label', `Rename ${displayName}`);
      rename.innerHTML = icon('edit');
      rename.addEventListener('click', event => { event.stopPropagation(); this.startRename(); });
      this.gui.append(rename);
    }
  }

  private startRename(): void {
    const { displayName, onRename } = this.params;
    if (onRename === null) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'studio-header-input';
    input.value = displayName;
    input.maxLength = 120;
    input.setAttribute('aria-label', `New name for ${displayName}. Enter reviews the rename, Escape cancels.`);
    let settled = false;
    const cancel = (refocus: boolean): void => {
      if (settled) return;
      settled = true;
      this.draw();
      if (refocus) this.params.eGridHeader.focus();
    };
    // The grid moves focus with the arrow keys and sorts on Enter; neither may reach it from here.
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); cancel(true); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const name = input.value.trim();
      if (name === '' || name === displayName) { cancel(true); return; }
      settled = true;
      onRename(name);
    });
    for (const type of ['click', 'mousedown', 'dblclick'] as const) input.addEventListener(type, event => event.stopPropagation());
    // Leaving the box puts the header back. A rename is a reviewed change, so it is not sent by a stray click.
    input.addEventListener('blur', () => cancel(false));
    this.gui.replaceChildren(input);
    input.focus();
    input.select();
  }
}
