import { escapeAttribute, escapeHtml } from './format';
import { exactNumberText } from './scalars';

// A rating is an Integer field drawn on a closed scale (ADR-0004, 2026-09-14 amendment,
// S2). The scale bounds the drawing, not the column: a stored number outside it is shown
// as itself with the issue stated, never rounded into range and never drawn as a count
// nobody chose. The dots are decoration; the accessible name always carries the number.

export interface RatingScale { min: number; max: number }

export interface RatingField {
  displayName?: string;
  presentation?: string | null;
  scale?: RatingScale | null;
}

/** The scale a field is drawn on, or null when it is not a rating. */
export function ratingScaleOf(field: RatingField | undefined): RatingScale | null {
  if (field === undefined || field.presentation !== 'rating') return null;
  const scale = field.scale;
  if (scale == null || !Number.isFinite(scale.min) || !Number.isFinite(scale.max) || scale.max <= scale.min) return null;
  return scale;
}

/**
 * The whole number a stored value carries, however it arrived: the exact-number envelope
 * the bridge wraps every JSON number in, or a plain number from the browser-mode host.
 * Anything else is absent rather than guessed at.
 */
export function ratingValue(value: unknown): number | null {
  const lexeme = exactNumberText(value);
  if (lexeme !== null) return /^-?\d+$/.test(lexeme) ? Number(lexeme) : null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * What a rating is called for a screen reader. "4 of 5" reads correctly only when the
 * scale starts at one; any other scale says both of its ends, because "4 of 5" on a scale
 * of two to six is a different fact.
 */
export function ratingLabel(value: number, scale: RatingScale): string {
  return scale.min === 1 ? `${value} of ${scale.max}` : `${value} on a scale of ${scale.min} to ${scale.max}`;
}

/** Every value of the scale, lowest first. */
export function ratingSteps(scale: RatingScale): number[] {
  return Array.from({ length: scale.max - scale.min + 1 }, (_, index) => scale.min + index);
}

/**
 * One record's rating as markup: dots when the value sits on the scale, the number and
 * the issue when it does not, and nothing pretending to be a value when it is unset.
 */
export function ratingMarkup(value: unknown, scale: RatingScale, fallback = 'Not set'): string {
  const rating = ratingValue(value);
  if (rating === null) return escapeHtml(fallback);
  if (rating < scale.min || rating > scale.max)
    return `<span class="rating is-outside">${escapeHtml(String(rating))}<span class="rating-issue">outside ${scale.min}–${scale.max}</span></span>`;
  const dots = ratingSteps(scale)
    .map((step) => `<span class="rating-dot${step <= rating ? ' is-filled' : ''}"></span>`)
    .join('');
  return `<span class="rating" role="img" aria-label="${escapeAttribute(ratingLabel(rating, scale))}">${dots}</span>`;
}

/**
 * The control that edits one: native radios in a fieldset, one per value of the scale,
 * plus Not set when the field is optional. Radios carry the field's name, so the form
 * reads them back, the draft tracks them and a validation failure can focus them; a
 * button group would need all three written by hand.
 *
 * The radio is the dot. Drawing a dot beside it gave every value two marks of the same
 * shape, one chosen by the browser and one by the stylesheet, which read as two separate
 * selections; one element carries both the state and the drawing, and Not set keeps a
 * mark of its own because it is a radio like the rest.
 */
export function ratingControlMarkup(
  fieldId: string,
  label: string,
  scale: RatingScale,
  value: unknown,
  required: boolean,
): string {
  const rating = ratingValue(value);
  const outside = rating !== null && (rating < scale.min || rating > scale.max);
  const name = escapeAttribute(fieldId);
  const steps = ratingSteps(scale)
    .map((step) => `<label class="rating-step"><input type="radio" name="${name}" value="${step}" ${rating === step ? 'checked' : ''} />${step}</label>`)
    .join('');
  // A value outside the scale leaves every dot unchosen rather than selecting the
  // nearest: the number is shown beside the control so the person can see what is
  // stored and decide, and leaving the control alone never rewrites it.
  const note = outside
    ? `<p class="rating-issue" role="status">Stored as ${escapeHtml(String(rating))}, outside ${scale.min}–${scale.max}. Choose a value to correct it.</p>`
    : '';
  const unset = required
    ? ''
    : `<label class="rating-step is-unset"><input type="radio" name="${name}" value="" ${rating === null ? 'checked' : ''} />Not set</label>`;
  return `<fieldset class="rating-field"><legend>${escapeHtml(label)}</legend>${note}<div class="rating-picker">${steps}${unset}</div></fieldset>`;
}
