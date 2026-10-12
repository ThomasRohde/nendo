import { storageLabel } from './format';
import type { EntitySnapshot } from './host';

/**
 * What the person typed in the Data filter, in the words the grid shows, as the value the field
 * stores: Yes and No for a Boolean, a choice by its label. The filter wanted "true" and the
 * hidden option ID, and refused "Yes" with a message that asked for Yes (UX-08).
 */
export function filterInput(field: EntitySnapshot['fields'][number], typed: string): string {
  const text = typed.trim();
  if (storageLabel(field.storageKind) === 'Boolean') {
    if (/^(yes|true)$/i.test(text)) return 'true';
    if (/^(no|false)$/i.test(text)) return 'false';
    return text;
  }
  const named = (field.choices ?? []).filter(candidate => candidate.displayName.localeCompare(text, undefined, { sensitivity: 'accent' }) === 0);
  const choice = named.find(candidate => !candidate.retired) ?? named[0];
  return choice?.id ?? text;
}
