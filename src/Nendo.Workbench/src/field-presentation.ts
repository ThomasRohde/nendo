import { escapeAttribute, storageLabel } from './format';
import type { EntitySnapshot } from './host-types';

/**
 * Long text shown as Markdown, or Markdown shown as plain long text again (W-173). Only between
 * those two here: no value changes either way, and a single line stays what its author chose.
 */
export function presentationToggleMarkup(entity: Pick<EntitySnapshot, 'retired'>, field: EntitySnapshot['fields'][number]): string {
  const next = field.presentation === 'longText' ? 'markdown' : field.presentation === 'markdown' ? 'longText' : null;
  if (next === null || storageLabel(field.storageKind) !== 'Text') return '';
  return `<button class="text-button" data-presentation-field="${escapeAttribute(field.fieldId)}" data-presentation="${next}" data-action type="button" ${entity.retired || field.retired ? 'disabled' : ''}>${next === 'markdown' ? 'Show as Markdown' : 'Show as long text'}</button>`;
}
