import { escapeAttribute, escapeHtml } from './format';

/**
 * Controls that only read or move between pages, marked `data-reads` so the read-only sweep in
 * main.ts leaves them live. In a read-only or recovery session, or a file waiting for approval of
 * its automatic actions, the record-type pickers and Show retired data were disabled with every
 * edit, although none of them writes the file.
 */

/** The record-type picker on Structure and on Screens. */
export function recordTypePicker(id: 'structure-entity' | 'surface-entity', options: ReadonlyArray<{ value: string; label: string; selected: boolean }>): string {
  return `<label class="select-field">Record type<select id="${id}" data-reads>${options
    .map(option => `<option value="${escapeAttribute(option.value)}" ${option.selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('')}</select></label>`;
}

/** Data's Show retired data switch. */
export function retiredDataToggle(checked: boolean): string {
  return `<label class="checkbox-field"><input id="show-retired-data" type="checkbox" data-reads ${checked ? 'checked' : ''} />Show retired data</label>`;
}
