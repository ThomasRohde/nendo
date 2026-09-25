import type { CalculationResult, DerivedFieldPlan, RecordSnapshot } from './host';
import { exactNumberText } from './scalars';

/** How a calculated result should read on screen. */
export interface CalculatedDisplay {
  /** `value`, `empty`, `error` or `pending`, normalised from either wire shape. */
  state: 'value' | 'empty' | 'error' | 'pending';
  /** What to show. Never a fabricated number: an empty or failed result says so in words. */
  text: string;
  /** Present only for an error, so a surface can show the cause without inventing one. */
  detail?: string;
}

// The bridge may carry an enum as its name or its ordinal, depending on how the
// host serialised it. Both are accepted; anything else is treated as not yet known
// rather than guessed at.
const states = ['value', 'empty', 'error', 'pending'] as const;

function normalise(state: CalculationResult['state']): CalculatedDisplay['state'] {
  if (typeof state === 'number') return states[state] ?? 'pending';
  return states.includes(state as typeof states[number]) ? state as CalculatedDisplay['state'] : 'pending';
}

/** A result's state by name, from either wire shape; what a custom view is handed. */
export function calculationState(state: CalculationResult['state']): CalculatedDisplay['state'] {
  return normalise(state);
}

/**
 * Turns one result into what the reader should see.
 *
 * The four states stay four states. Showing an empty result as a blank cell beside
 * stored blanks, or an error as nothing at all, is how a number nobody computed ends
 * up being read as one — and then trusted, exported and totalled.
 *
 * A dependency failure is called out separately from an ordinary error: "this
 * depends on something that failed" tells the reader where to look, where a bare
 * error message about division would send them to the wrong field.
 */
export function calculatedDisplay(result: CalculationResult | undefined): CalculatedDisplay {
  if (result === undefined) return { state: 'pending', text: 'Calculating…' };
  const state = normalise(result.state);
  if (state === 'pending') return { state, text: 'Calculating…' };
  if (state === 'empty') return { state, text: 'Not set' };
  if (state === 'error') {
    return {
      state,
      text: result.errorCode === 'calculation-dependency-failed' ? 'Unavailable' : 'Cannot calculate',
      detail: result.errorMessage ?? undefined,
    };
  }
  return { state, text: valueText(result.value) };
}

/**
 * Exact text for a calculated value.
 *
 * Numbers go through the same exact-number decoding stored values use, because a
 * calculated decimal has exactly as much right to survive the trip as a typed one —
 * and it is the one most likely to be a total somebody relies on.
 */
function valueText(value: unknown): string {
  const exact = exactNumberText(value);
  if (exact !== null) return exact;
  if (value === null || value === undefined) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/**
 * Looks up one record's result for a derived field.
 *
 * A compiled record plan keys its results by field ID; a record read back from a
 * bounded query carries them as a list in dependency order. Both are the same
 * results, so both are read here rather than at every call site.
 */
export function resultFor(
  calculations: Record<string, CalculationResult> | readonly CalculationResult[] | undefined,
  fieldId: string,
): CalculationResult | undefined {
  if (calculations === undefined) return undefined;
  return Array.isArray(calculations)
    ? calculations.find((result) => result.fieldId === fieldId)
    : (calculations as Record<string, CalculationResult>)[fieldId];
}

/**
 * Whether a field ID names a calculated field rather than a stored one.
 * Used to keep an editor from being offered for something with no column behind it.
 */
export function isDerived(derivedFields: readonly DerivedFieldPlan[] | undefined, fieldId: string): boolean {
  return (derivedFields ?? []).some((field) => field.semanticId === fieldId);
}

/** The derived field a binding names, if it is one. */
export function derivedField(
  derivedFields: readonly DerivedFieldPlan[] | undefined,
  fieldId: string,
): DerivedFieldPlan | undefined {
  return (derivedFields ?? []).find((field) => field.semanticId === fieldId);
}

/**
 * A read record's calculated results, keyed the way a render plan keys them.
 *
 * A bounded read is the authority for what is on screen and replaces the compiled
 * plan's records wholesale, so anything the projection drops is gone from every
 * surface. Dropping the results is how a calculated field ends up reading
 * "Calculating…" forever while the host has had the answer all along.
 */
export function calculationsOf(record: RecordSnapshot): Record<string, CalculationResult> | undefined {
  if (record.calculations === undefined || record.calculations.length === 0) return undefined;
  return Object.fromEntries(record.calculations.map((result) => [result.fieldId, result]));
}

/**
 * Whether a node a surface marked `visibleWhen` should be shown.
 *
 * Only a definite no hides anything. A result that is empty, still being worked out
 * or impossible to calculate leaves the node on screen: hiding on uncertainty is how
 * a person stops being told something is there, and a blank page is indistinguishable
 * from a page with nothing to say.
 */
export function visibleByCalculation(
  calculations: Record<string, CalculationResult> | readonly CalculationResult[] | undefined,
  fieldId: string | null,
): boolean {
  if (fieldId === null) return true;
  const result = resultFor(calculations, fieldId);
  if (result === undefined) return true;
  const display = calculatedDisplay(result);
  return display.state !== 'value' || result.value !== false;
}
