import { counted, escapeAttribute, escapeHtml, storageLabel, valueDisplay } from './format';
import type { EntitySnapshot, RecordSnapshot } from './host-types';
import { referenceControl } from './reference-controls';

/**
 * Structure's calculated fields: a read-only Calculated group with
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

/**
 * A record as a person knows it on a Studio form: by its first current text value, else by its
 * ID. The reference conversion headed every record with its ID alone.
 */
export function recordHeading(entity: Pick<EntitySnapshot, 'fields'>, record: Pick<RecordSnapshot, 'recordId' | 'values'>, exceptFieldId: string): string {
  const label = entity.fields.find((candidate) => candidate.fieldId !== exceptFieldId && !candidate.retired && storageLabel(candidate.storageKind) === 'Text');
  return (label === undefined ? '' : valueDisplay(record.values[label.fieldId])) || record.recordId;
}

/** One record of a reference conversion: named, its ID beside, its old value, and the picker for its target. */
export function conversionRecordMarkup(entity: Pick<EntitySnapshot, 'fields'>, field: EntitySnapshot['fields'][number], record: Pick<RecordSnapshot, 'recordId' | 'values'>): string {
  const original = record.values[field.fieldId];
  return `<form class="record-form conversion-record"><h3>${escapeHtml(recordHeading(entity, record, field.fieldId))}</h3><code>${escapeHtml(record.recordId)}</code>`
    + `<p>Original value: <code>${escapeHtml(original === null ? '(null)' : valueDisplay(original))}</code></p>${referenceControl(field, '')}</form>`;
}

/**
 * The title of a Make required or Reactivate proposal. A batch that only fills values says so:
 * accepting the first of three batches announced "Make Status required accepted." while Status
 * was still optional.
 */
export function requirementTitle(fieldName: string, change: { reactivate: boolean; required: boolean; batch: number | null }): string {
  if (change.batch !== null) return `Fill missing ${fieldName} values (first ${change.batch})`;
  return change.reactivate ? `Reactivate ${fieldName}` : `Make ${fieldName} ${change.required ? 'required' : 'optional'}`;
}

type Field = EntitySnapshot['fields'][number];
type Entities = readonly Pick<EntitySnapshot, 'entityId' | 'displayName' | 'retired' | 'fields'>[];

/**
 * The text fields a bound reference may show its records by instead of its label
 * (ADR-0003): the target's active Text fields, its current label left out. The
 * Engine applies the same rule, so a choice offered here is one it accepts.
 */
export function referenceLabelChoices(field: Field, entities: Entities): Field[] {
  const reference = field.reference;
  if (!reference) return [];
  const target = entities.find(candidate => candidate.entityId === reference.targetEntityId);
  if (target === undefined || target.retired) return [];
  return target.fields.filter(candidate => !candidate.retired && storageLabel(candidate.storageKind) === 'Text' && candidate.fieldId !== reference.labelFieldId);
}

/**
 * A bound reference's target and label in its Stores column, with Label by… to change the label.
 * A label could be chosen once, when the reference was bound, and then held its field from
 * retirement with nothing that moved it.
 */
export function referenceLabelMarkup(entity: Pick<EntitySnapshot, 'retired'>, field: Field, entities: Entities): string {
  const reference = field.reference;
  if (!reference) return '';
  const target = entities.find(candidate => candidate.entityId === reference.targetEntityId);
  const label = target?.fields.find(candidate => candidate.fieldId === reference.labelFieldId);
  const choices = referenceLabelChoices(field, entities);
  const off = entity.retired || field.retired || choices.length === 0;
  const why = choices.length === 0 && !(entity.retired || field.retired)
    ? ` title="${escapeAttribute(target === undefined || target.retired
      ? `${target?.displayName ?? 'The target record type'} is retired. Reactivate it to choose another label.`
      : `${target.displayName} has no other active text field to show its records by.`)}"` : '';
  return `<span class="reference-target">${escapeHtml(target?.displayName ?? reference.targetEntityId)} by ${escapeHtml(label?.displayName ?? reference.labelFieldId)}</span>`
    + `<button class="text-button" data-reference-label="${escapeAttribute(field.fieldId)}" data-action type="button" ${off ? 'disabled' : ''}${why} aria-label="Label ${escapeAttribute(field.displayName)} by another field">Label by…</button>`;
}
