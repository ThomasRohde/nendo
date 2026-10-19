import { sameValue, storageLabel } from './format';
import type { EntitySnapshot } from './host';
import { ratingScaleOf } from './rating';
import { exactNumberText } from './scalars';

type GridField = EntitySnapshot['fields'][number];

/**
 * Whether a field is edited as a date: by its presentation or by what it stores, as the record
 * form decides (record-markup.ts). A Date field may have no presentation at all, and the grid
 * gave it free text that refused anything but yyyy-MM-dd.
 */
export function isDateField(field: GridField): boolean {
  return field.presentation === 'date' || storageLabel(field.storageKind) === 'Date';
}

/** The AG Grid editor a Studio cell opens for a field. */
export function gridCellEditor(field: GridField): string {
  if (field.presentation === 'singleChoice' || storageLabel(field.storageKind) === 'Boolean' || ratingScaleOf(field) !== null) return 'agSelectCellEditor';
  if (isDateField(field)) return 'agDateStringCellEditor';
  return field.presentation === 'longText' || field.presentation === 'markdown' ? 'agLargeTextCellEditor' : 'agTextCellEditor';
}

/** Where a column starts before the person sizes it: wide enough for what its kind holds. */
export function defaultColumnWidth(field: GridField): number {
  if (field.presentation === 'longText' || field.presentation === 'markdown') return 300;
  if (field.presentation === 'singleChoice') return 170;
  if (isDateField(field)) return 140;
  if (ratingScaleOf(field) !== null) return 150;
  const kind = storageLabel(field.storageKind);
  return kind === 'Boolean' ? 110 : kind === 'Integer' || kind === 'Decimal' ? 130 : kind === 'Date time' ? 180 : kind === 'Reference' ? 210 : 200;
}

/**
 * Studio's grid select editors, kept from rewriting what they did not change.
 *
 * AG Grid's select editor sets itself to the first value it is offered when the cell's value is
 * not among them, and leaving the editor commits that. A retired choice, or a rating outside its
 * scale, was replaced by the first option or by Not set just by opening the cell to look. The
 * cell's own value is therefore always offered too.
 */
export function editorValues(base: readonly unknown[], current: unknown): unknown[] {
  const value = exactNumberText(current) ?? current;
  if (value === null || value === undefined || value === '') return [...base];
  return base.some((offered) => offered === value) ? [...base] : [...base, value];
}

/** Whether an edit leaves the stored value as it was: then nothing is written, not even null over null. */
export function gridEditUnchanged(parsed: unknown, stored: unknown): boolean {
  const plain = (value: unknown): unknown => exactNumberText(value) ?? (value === '' || value === undefined ? null : value);
  return sameValue(plain(parsed), plain(stored));
}
