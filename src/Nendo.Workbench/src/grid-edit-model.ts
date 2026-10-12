import { sameValue } from './format';
import { exactNumberText } from './scalars';

/**
 * Studio's grid select editors, kept from rewriting what they did not change (WDV-02).
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
