import { counted, escapeAttribute, escapeHtml } from './format';
import type { EntitySnapshot } from './host-types';

/**
 * Structure's calculated fields (UIT-19, accepted 2026-10-13): a read-only Calculated group with
 * each calculation's formula and result type, counted apart from the stored fields, and beside a
 * stored field the calculations that keep it from being retired. Structure listed stored fields
 * only and counted them as all the fields, so a calculation was missing from the type's own
 * definition, and a retirement it blocks was found only when the proposal was refused.
 */

type Calculated = NonNullable<EntitySnapshot['derivedFields']>[number];
type Named = Pick<EntitySnapshot, 'entityId' | 'displayName' | 'fields' | 'derivedFields'>;

const resultTypes = ['Integer', 'Decimal', 'Boolean', 'Text', 'Date'];

/** A calculation's result type as Structure's Stores column names a stored field's. */
export function resultTypeLabel(value: string | number): string {
  if (typeof value === 'number') return resultTypes[value] ?? 'Text';
  return value.length === 0 ? 'Text' : value[0].toUpperCase() + value.slice(1);
}

/** The heading's count: stored fields, and calculated ones apart. */
export function fieldCountLabel(entity: Pick<EntitySnapshot, 'fields' | 'derivedFields'>): string {
  const calculated = entity.derivedFields?.length ?? 0;
  return calculated === 0 ? counted(entity.fields.length, 'field') : `${counted(entity.fields.length, 'stored field')} · ${calculated} calculated`;
}

/** The name of a field a calculation reads: on its own record type first, then on any other. */
function readName(fieldId: string, owner: Named, entities: readonly Named[]): string {
  return owner.fields.find((field) => field.fieldId === fieldId)?.displayName
    ?? entities.flatMap((entity) => entity.fields).find((field) => field.fieldId === fieldId)?.displayName
    ?? fieldId;
}

/**
 * Every calculation in the file that reads a field with this ID, by name. The Engine refuses a
 * retirement under any of them by the field's ID alone, so this asks the same question.
 */
export function calculationsReading(fieldId: string, entities: readonly Named[]): string[] {
  return entities.flatMap((entity) => (entity.derivedFields ?? [])
    .filter((calculation) => (calculation.readsFieldIds ?? []).includes(fieldId))
    .map((calculation) => calculation.displayName));
}

/** The sentence under a stored field that a calculation reads; empty for any other. */
export function readByMarkup(fieldId: string, entities: readonly Named[]): string {
  const readers = calculationsReading(fieldId, entities);
  if (readers.length === 0) return '';
  const names = readers.join(', ');
  return `<p class="field-read-by" id="read-by-${escapeAttribute(token(fieldId))}">${escapeHtml(readers.length === 1
    ? `${names} reads this field, so it cannot be retired while that calculation stays.`
    : `${names} read this field, so it cannot be retired while those calculations stay.`)}</p>`;
}

/** An ID as one piece of an element ID. */
export function token(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** A calculation by its name, wherever in the file it is declared. */
function calculationName(calculationId: string, entities: readonly Named[]): string {
  return entities.flatMap((entity) => entity.derivedFields ?? []).find((calculation) => calculation.calculationId === calculationId)?.displayName ?? calculationId;
}

/** What a calculation reads: its stored fields, then the calculations it reads, each by name. */
export function calculationReads(calculation: Calculated, owner: Named, entities: readonly Named[]): string[] {
  return [...(calculation.readsFieldIds ?? []).map((fieldId) => readName(fieldId, owner, entities)),
    ...(calculation.readsCalculationIds ?? []).map((calculationId) => calculationName(calculationId, entities))];
}

/**
 * The calculations that keep a record type from being retired: its own, and any elsewhere that
 * reads it. The Engine refuses the retirement as retired-binding under either.
 */
export function calculationsHoldingType(entityId: string, entities: readonly Named[]): string[] {
  return entities.flatMap((entity) => (entity.derivedFields ?? [])
    .filter((calculation) => entity.entityId === entityId || (calculation.readsEntityIds ?? []).includes(entityId))
    .map((calculation) => calculation.displayName));
}

/** The sentence beside Retire record type when calculations keep the type; empty otherwise. */
export function typeHeldByMarkup(entityId: string, entities: readonly Named[]): string {
  const holders = calculationsHoldingType(entityId, entities);
  if (holders.length === 0) return '';
  return `<p class="field-read-by" id="type-held-by">${escapeHtml(holders.length === 1
    ? `The calculation ${holders[0]} belongs to or reads this record type, so it cannot be retired while that calculation stays.`
    : `The calculations ${holders.join(', ')} belong to or read this record type, so it cannot be retired while they stay.`)}</p>`;
}

function calculatedRow(calculation: Calculated, owner: Named, entities: readonly Named[]): string {
  const reads = calculationReads(calculation, owner, entities);
  return `<article class="field-row is-calculated" data-calculated-field="${escapeAttribute(calculation.fieldId)}">
        <div class="field-identity"><strong>${escapeHtml(calculation.displayName)}</strong><code>${escapeHtml(calculation.fieldId)}</code></div>
        <span class="field-kind">${escapeHtml(resultTypeLabel(calculation.resultType))}${calculation.resultNullable ? '<span class="calculated-empty">May be empty</span>' : ''}</span>
        <span class="field-presentation"><code class="calculated-formula">${escapeHtml(calculation.expression)}</code></span>
        <span class="field-requirement"><span class="requirement-value">${reads.length === 0 ? 'Reads no field' : escapeHtml(`Reads ${reads.join(', ')}`)}</span></span>
      </article>`;
}

/** The Calculated group under the stored fields, or nothing when the type has no calculation. */
export function calculatedFieldsMarkup(entity: Named, entities: readonly Named[]): string {
  const calculations = entity.derivedFields ?? [];
  if (calculations.length === 0) return '';
  return `<div class="field-list calculated-list" data-testid="calculated-fields" role="group" aria-labelledby="calculated-heading">
        <h3 id="calculated-heading" class="calculated-heading">Calculated <span>Read-only. Nendo works these out from the formula; nobody types them in.</span></h3>
        <div class="field-row field-row-head" aria-hidden="true"><span>Field</span><span>Result</span><span>Formula</span><span>Reads</span></div>
        ${calculations.map((calculation) => calculatedRow(calculation, entity, entities)).join('')}
      </div>`;
}
