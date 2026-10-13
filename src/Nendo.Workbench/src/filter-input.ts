import { isDateTimeKind, storageLabel } from './format';
import type { EntitySnapshot } from './host';
import { startOfCivilDay, type QueryFilter } from './record-window';
import { parseScalar } from './scalars';

type FilterField = EntitySnapshot['fields'][number];

/**
 * What the person typed in the Data filter, in the words the grid shows, as the value the field
 * stores: Yes and No for a Boolean, a choice by its label. The filter wanted "true" and the
 * hidden option ID, and refused "Yes" with a message that asked for Yes (UX-08).
 */
export function filterInput(field: FilterField, typed: string): string {
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

/** A plain yyyy-MM-dd the calendar has, as the local midnight that begins it; null for anything else. */
function plainDay(text: string): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date === null) return null;
  const day = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  return day.getFullYear() === Number(date[1]) && day.getMonth() === Number(date[2]) - 1 && day.getDate() === Number(date[3]) ? day : null;
}

/** What the status line says of a comparison against the start of a typed day. */
const dayWords: Readonly<Record<string, string>> = {
  lt: 'is before', le: 'is at or before the start of', gt: 'is after the start of', ge: 'is on or after',
};

/**
 * The clauses the Data filter sends for one field, operator and typed value, and what the status
 * line says of them when that is not the typed value itself.
 *
 * A plain date against a date and time is a day where the person is (W-217): the host refuses an
 * instant without a zone, and an exact instant at midnight is not what a person means by a date.
 * Equals becomes the whole local day, from its start to the next day's start. Does not equal
 * would need an "or" a filter cannot say, so it is refused with what does work. The comparisons
 * are made against the start of the day, and the status line says so.
 */
export function studioFilter(field: FilterField, operator: string, typed: string): { filters: QueryFilter[]; phrase: string | null } {
  if (operator === 'isNull' || operator === 'isNotNull') return { filters: [{ fieldId: field.fieldId, operator }], phrase: null };
  const text = typed.trim();
  const day = isDateTimeKind(field.storageKind) ? plainDay(text) : null;
  if (day !== null) {
    const start = startOfCivilDay(day);
    if (operator === 'eq') {
      const next = startOfCivilDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
      return { filters: [{ fieldId: field.fieldId, operator: 'ge', value: start }, { fieldId: field.fieldId, operator: 'lt', value: next }],
        phrase: `is on ${text}, this device\u2019s day` };
    }
    if (operator === 'ne')
      throw new Error(`Does not equal cannot leave out a whole day of ${field.displayName}, because a filter cannot say \u201cor\u201d. Choose Less than or At least with ${text}, or type a time with its offset.`);
    const words = dayWords[operator];
    if (words !== undefined)
      return { filters: [{ fieldId: field.fieldId, operator, value: start }], phrase: `${words} ${text}${operator === 'lt' || operator === 'ge' ? ', this device\u2019s day' : ' here'}` };
  }
  return { filters: [{ fieldId: field.fieldId, operator, value: parseScalar(storageLabel(field.storageKind), filterInput(field, typed)) }], phrase: null };
}

/** What the Value box shows while empty: the form the field's values are typed in. */
export function filterPlaceholder(field: FilterField): string {
  const kind = storageLabel(field.storageKind);
  if (kind === 'Boolean') return 'Yes or No';
  return kind === 'Date' || isDateTimeKind(field.storageKind) ? 'YYYY-MM-DD' : '';
}

/** The touch keypad the Value box asks for: none a whole number would refuse (W-217). */
export function filterInputMode(field: FilterField): '' | 'numeric' | 'decimal' {
  const kind = storageLabel(field.storageKind);
  return kind === 'Integer' ? 'numeric' : kind === 'Decimal' ? 'decimal' : '';
}
