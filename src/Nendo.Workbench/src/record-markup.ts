import { choiceStyle } from './tones';
import { proportionBar, ring, type ChartStatus, columns, activityGrid as activityGridMarkup } from './chart-kit';
import { activityLevel, breakdownSegments, bucketLabel, bucketSegments, busiestBucket, chartContext, chartKey, chartTitle, isOverTimeKind, type ScopedChart } from './charts';
import { isSettledSummaryFailure, tileKey, tileScopeLabel, tileTitle, type ScopedTile, type TileScope } from './summary-tiles';
import { treeCommands } from './surface-model';
import { calculatedDisplay, isDerived, resultFor } from './calculated-fields';
import { referenceControl } from './reference-controls';
import { choiceDisplay, escapeAttribute, escapeHtml, fieldName, sameValue, storageLabel, valueDisplay } from './format';
import { ratingControlMarkup, ratingMarkup, ratingScaleOf } from './rating';
import { chartStates, chartTables, relatedWindows, state, summaryCounts } from './app-state';
import { applicationPlans, drillTarget } from './plan-selection';
import type { ApplicationPlan, DerivedFieldPlan, EntitySnapshot, FieldPlan, RecordPlan, SurfaceNodePlan } from './host';

/**
 * The pieces a screen is built from: one field, one card, one tile, one chart,
 * one related list. Each answers from what it is handed, so the page and surface
 * modules above can assemble them without knowing how any of them is drawn.
 */

/**
 * One field of one record as a reader sees it in a list, a card or a calendar.
 *
 * A calculated field is answered from its result rather than from `values`, where
 * it has nothing stored: reading it as a stored blank would put an empty cell
 * beside real blanks and make a number nobody computed look like one.
 */
export function recordFieldDisplay(
  record: RecordPlan,
  fieldId: string,
  derived: readonly DerivedFieldPlan[] | undefined,
): string {
  if (isDerived(derived, fieldId)) return calculatedDisplay(record.calculations?.[fieldId]).text;
  const field = state.session.entities.flatMap(entity => entity.fields).find(field => field.fieldId === fieldId);
  if (field?.presentation === 'singleChoice') return choiceDisplay(field, record.values[fieldId]);
  return record.referenceLabels && fieldId in record.referenceLabels && record.values[fieldId] != null
    ? record.referenceLabels[fieldId] || '(No target label)' : valueDisplay(record.values[fieldId]);
}

/**
 * One field of one record as escaped markup rather than text: dots for a rating, the
 * escaped display for everything else. Every surface that shows a value goes through
 * here, so a rating reads the same on a list row, a card and a timeline entry.
 */
export function fieldValueMarkup(
  plan: ApplicationPlan,
  record: RecordPlan,
  fieldId: string,
  fallback = '',
): string {
  const scale = ratingScaleOf(plan.entity.fields.find((field) => field.semanticId === fieldId));
  if (scale !== null && !isDerived(plan.entity.derivedFields, fieldId))
    return ratingMarkup(record.values[fieldId], scale, fallback);
  return escapeHtml(recordFieldDisplay(record, fieldId, plan.entity.derivedFields) || fallback);
}

/** A status dot in the tone of one record's choice value, or nothing when the value is unset. */
export function accentDot(plan: ApplicationPlan, fieldId: string | null, record: RecordPlan): string {
  if (fieldId === null) return '';
  const value = record.values[fieldId];
  if (value === null || value === undefined || value === '') return '';
  const field = plan.entity.fields.find((candidate) => candidate.semanticId === fieldId);
  return `<span class="status-dot" style="${choiceStyle(field, value)}" aria-hidden="true"></span>`;
}

/**
 * One record as a card. <paramref name="style" /> tones its edge where the surface names
 * an accent field, as the record page's header band is toned; a board card names none and
 * is unchanged.
 */
export function recordCardMarkup(plan: ApplicationPlan, record: RecordPlan, cardFieldIds: string[], style = ''): string {
  const [headingFieldId, ...detailFieldIds] = cardFieldIds;
  const heading = recordFieldDisplay(record, headingFieldId, plan.entity.derivedFields) || `Untitled ${plan.entity.displayName}`;
  // Choice values read as status, so they carry the same chip treatment as the board columns
  // they group into. Everything else stays a labelled value pair.
  const isChoice = (fieldId: string): boolean =>
    plan.entity.fields.find((field) => field.semanticId === fieldId)?.presentation === 'singleChoice';
  const chipFields = detailFieldIds.filter((fieldId) => isChoice(fieldId) && recordFieldDisplay(record, fieldId, plan.entity.derivedFields));
  const valueFields = detailFieldIds.filter((fieldId) => !chipFields.includes(fieldId));
  const chips = chipFields.length === 0 ? '' : `<div class="card-chips">${chipFields.map((fieldId) => {
    const display = recordFieldDisplay(record, fieldId, plan.entity.derivedFields);
    return `<span class="card-chip" style="${choiceStyle(plan.entity.fields.find((field) => field.semanticId === fieldId), record.values[fieldId])}" title="${escapeAttribute(fieldName(plan, fieldId))}">${escapeHtml(display)}</span>`;
  }).join('')}</div>`;
  const values = valueFields.length === 0 ? '' : `<div class="card-values">${valueFields.map((fieldId) => `<span><small>${escapeHtml(fieldName(plan, fieldId))}</small>${fieldValueMarkup(plan, record, fieldId, 'Not set')}</span>`).join('')}</div>`;
  return `<button class="record-card${style === '' ? '' : ' is-toned'}" data-record-id="${escapeAttribute(record.semanticId)}" type="button" style="${style}" aria-label="Open ${escapeAttribute(heading)}"><strong>${escapeHtml(heading)}</strong>${chips}${values}<footer><small>v${record.version}</small></footer></button>`;
}

export function relatedKey(node: SurfaceNodePlan, recordId: string): string {
  return `${node.semanticId}:${recordId}`;
}

/**
 * What a relation says when nothing points back.
 *
 * "No related records yet." named neither the record type nor the field, so it read the
 * same on a page with four relations on it, and it left a person unable to tell a relation
 * with nothing in it from one that had not loaded. The inverse is not a mystery — the node
 * carries both halves of it — so the sentence states them.
 *
 * It sits above the relation's own Add rather than instead of it (ADR-0004, 2026-09-18
 * amendment): an empty relation is the one most likely to be looked at by somebody about
 * to fill it, so the sentence states what is missing and the button beside it adds one.
 *
 * The record types are passed in rather than read from the session here, so the sentence
 * is a function of what it names and can be read back without a loaded file.
 */
export function relatedListEmpty(node: SurfaceNodePlan, entities: readonly EntitySnapshot[]): string {
  const targetEntityId = typeof node.properties.targetEntityId === 'string' ? node.properties.targetEntityId : null;
  const viaFieldId = typeof node.properties.viaFieldId === 'string' ? node.properties.viaFieldId : null;
  const target = entities.find((entity) => entity.entityId === targetEntityId);
  if (target === undefined || viaFieldId === null) return 'No related records yet.';
  const via = target.fields.find((field) => field.fieldId === viaFieldId);
  return via === undefined
    ? `No ${target.displayName} records point at this one yet.`
    : `No ${target.displayName} records point at this one through ${via.displayName} yet.`;
}

/**
 * Whether a related list can offer its actions, which is whether Use can show the record
 * type they lead to (ADR-0004, 2026-09-18 amendment).
 *
 * A record type earns a place in Use by having a compiled surface. Without one there is
 * nowhere for a new record to land after it is saved and no page for a row to open on, so
 * the relation offers neither action and says why. This is the boundary Use's own record
 * type picker already draws, read here rather than invented.
 */
export function relatedTargetHasScreen(targetEntityId: string | null): boolean {
  return targetEntityId !== null && applicationPlans().some((plan) => plan.entity.semanticId === targetEntityId);
}

/**
 * The heading of a related list, and the one action that belongs beside it.
 *
 * Add names the record type it makes, because a page can carry several relations and
 * “Add” alone would not say which. Where the type has no screen of its own the button is
 * replaced by the reason, rather than left out with nothing said: a reader looking for a
 * way in should not have to work out from its absence that there is none.
 *
 * The record type and whether it can be reached are passed in rather than read from the
 * session, for the reason <see cref="relatedListEmpty" /> is: what the heading offers is
 * then a function of what it is told, and can be read back without a loaded file.
 */
export function relatedHeadMarkup(
  node: SurfaceNodePlan,
  title: string,
  target: EntitySnapshot | undefined,
  hasScreen: boolean,
): string {
  const action = target === undefined
    ? ''
    : hasScreen
      ? `<button class="secondary-button related-add" type="button" data-related-add="${escapeAttribute(node.semanticId)}"><span class="button-glyph" aria-hidden="true">+</span>Add ${escapeHtml(target.displayName)}</button>`
      : `<span class="related-no-screen">${escapeHtml(target.displayName)} has no screen to add one on.</span>`;
  return `<header class="related-head"><h3>${escapeHtml(title)}</h3>${action}</header>`;
}

/**
 * One row of a related list: the values its bindings name, and the button that opens the
 * record they belong to.
 *
 * The button is inside the row rather than around it, so a relation whose target has no
 * screen keeps exactly the row it had. The first bound field titles the row, as it does on
 * a card and on a recent list, so what a screen reader hears is what the eye reads rather
 * than the stable ID.
 */
export function relatedRowMarkup(
  displays: readonly string[],
  recordId: string,
  targetEntityId: string | null,
  opens: boolean,
): string {
  const cells = displays.map((display, index) => index === 0
    ? `<strong>${escapeHtml(display || '—')}</strong>`
    : `<span>${escapeHtml(display || '—')}</span>`).join('');
  return opens
    ? `<li><button class="related-row" type="button" data-related-open="${escapeAttribute(recordId)}" data-related-entity="${escapeAttribute(targetEntityId ?? '')}" aria-label="Open ${escapeAttribute(displays[0] || recordId)}">${cells}</button></li>`
    : `<li>${cells}</li>`;
}

export function relatedListMarkup(node: SurfaceNodePlan, record: RecordPlan): string {
  const title = typeof node.properties.title === 'string' ? node.properties.title : 'Related records';
  const key = relatedKey(node, record.semanticId);
  const window = relatedWindows.get(key);
  // A page read against an older revision is not this relation's answer. It used to be
  // shown anyway, so adding a linked record left the list that should hold it looking
  // exactly as it had before; every other window here already compares the sequence.
  const page = window !== undefined && window.page.changeSequence === state.session.manifest?.changeSequence
    ? window.page
    : undefined;
  const targetEntityId = typeof node.properties.targetEntityId === 'string' ? node.properties.targetEntityId : null;
  const opens = relatedTargetHasScreen(targetEntityId);
  const head = relatedHeadMarkup(node, title,
    state.session.entities.find((entity) => entity.entityId === targetEntityId), opens);
  const fieldIds = node.children
    .filter((child) => child.kind === 'fieldBinding')
    .map((child) => child.properties.fieldId)
    .filter((fieldId): fieldId is string => typeof fieldId === 'string');
  // A tile inside a relation counts that relation, and belongs where it was
  // authored: inside the relation, above its rows. Collecting every tile of the
  // page and appending them all after the fields lost that place.
  const tiles = summaryTileGroupMarkup(node.children
    .filter((child) => child.kind === 'summaryTile')
    .map((tile) => ({ tile, scope: { kind: 'relation', recordId: record.semanticId, relation: node } as TileScope })));

  if (page === undefined) {
    return `<section class="related-list" data-related="${escapeAttribute(node.semanticId)}">${head}${tiles}<p class="related-empty">Loading…</p></section>`;
  }
  if (page.items.length === 0) {
    return `<section class="related-list" data-related="${escapeAttribute(node.semanticId)}">${head}${tiles}<p class="related-empty">${escapeHtml(relatedListEmpty(node, state.session.entities))}</p></section>`;
  }
  // A related row shows the related record type's calculated fields too, read from
  // that record's own results rather than from its stored values, where a
  // calculation has nothing.
  const relatedDerived = state.session.entities
    .find((entity) => entity.entityId === node.properties.targetEntityId)?.derivedFields;
  const rows = page.items.map((related) => relatedRowMarkup(
    fieldIds.map((fieldId) => (relatedDerived ?? []).some((field) => field.fieldId === fieldId)
      ? calculatedDisplay(resultFor(related.calculations, fieldId)).text
      : valueDisplay(related.values[fieldId])),
    related.recordId, targetEntityId, opens)).join('');
  const pager = `<div class="page-controls" aria-label="${escapeAttribute(title)} pages"><span>${page.items.length} shown · Page ${(window?.index ?? 0) + 1}</span><button class="text-button" type="button" data-related-page="-1" data-related-key="${escapeAttribute(key)}" ${(window?.index ?? 0) === 0 ? 'disabled' : ''}>Previous</button><button class="text-button" type="button" data-related-page="1" data-related-key="${escapeAttribute(key)}" ${page.nextCursor === null ? 'disabled' : ''}>Next</button></div>`;
  return `<section class="related-list" data-related="${escapeAttribute(node.semanticId)}">${head}${tiles}<ul class="related-rows">${rows}</ul>${page.nextCursor === null && (window?.index ?? 0) === 0 ? '' : pager}</section>`;
}

// The lexeme is rendered verbatim. Parsing it would drop trailing zeros and
// digits past the float mantissa, which is the whole reason the host folds these
// exactly. A count of zero is a real zero; an aggregate with no contributing
// record is empty and says so; a read that failed offers Retry rather than a dash —
// unless the host said the number itself cannot be given, where a retry would only
// recompute the same refusal and the honest thing is to state it.
export function summaryTileMarkup(tile: SurfaceNodePlan, scope: TileScope): string {
  const key = tileKey(tile, scope);
  const known = summaryCounts.get(key);
  const title = tileTitle(tile);
  const context = tileScopeLabel(scope);
  const body = known === undefined || known.state === 'loading'
    ? '<span class="summary-value" aria-busy="true">…</span>'
    : known.state === 'failed'
      ? `<span class="summary-value summary-failed">Unavailable</span>${isSettledSummaryFailure(known.code) ? '' : `<button class="text-button" type="button" data-summary-retry="${escapeAttribute(key)}">Retry</button>`}`
      : `<span class="summary-value">${escapeHtml(known.value === null ? 'No records' : known.value)}</span>`;
  const note = known !== undefined && known.state === 'failed' ? escapeHtml(known.message) : context;
  return `<div class="summary-tile" data-summary="${escapeAttribute(tile.semanticId)}" data-summary-key="${escapeAttribute(key)}">${body}<span class="summary-title">${escapeHtml(title)}</span><span class="summary-context">${note}</span></div>`;
}

export function summaryTileGroupMarkup(tiles: ScopedTile[], charts: ScopedChart[] = [], plan: ApplicationPlan | null = null): string {
  const markup = [
    ...tiles.map((scoped) => summaryTileMarkup(scoped.tile, scoped.scope)),
    ...(plan === null ? [] : charts.map((scoped) => chartTileMarkup(plan, scoped))),
  ];
  return markup.length === 0 ? '' : `<div class="summary-tiles">${markup.join('')}</div>`;
}

/**
 * One chart as the view shows it: a proportion bar of the grouped answer, or a
 * ring of two counts. The markup comes from the chart kit; what is decided here
 * is only which state the chart is in and whether a segment can open the list.
 */
export function chartTileMarkup(plan: ApplicationPlan, scoped: ScopedChart): string {
  return chartTileMarkupFor(
    { fields: plan.entity.fields, names: (fieldId) => fieldName(plan, fieldId), drillable: drillTarget(plan) !== null },
    scoped);
}

/**
 * What a chart needs to draw itself, without needing a whole application plan.
 * The front page's charts each read a different record type, and one of those may
 * own no surfaces at all — so there is no single plan to hand in, and inventing
 * one would be the renderer answering a question it was not asked.
 */
export interface ChartRenderContext {
  fields: FieldPlan[];
  names: (fieldId: string) => string;
  /** Whether this view can open a narrowed list at all. A relation still cannot. */
  drillable: boolean;
}

export function chartTileMarkupFor(context: ChartRenderContext, scoped: ScopedChart): string {
  const key = chartKey(scoped.node, scoped.scope);
  const known = chartStates.get(key);
  const names = context.names;
  const status: ChartStatus = known === undefined || known.state === 'loading'
    ? { state: 'loading' }
    : known.state === 'failed'
      ? { state: 'failed', message: known.message, retry: !isSettledSummaryFailure(known.code) }
      : { state: 'ready' };
  const common = {
    key,
    title: chartTitle(scoped.node, names),
    context: chartContext(scoped.node, scoped.scope, names),
    status,
    tableOpen: chartTables.has(key),
    drillable: context.drillable && scoped.scope.kind !== 'relation',
  };
  if (scoped.node.kind === 'progressTile') {
    return ring({
      ...common,
      numerator: known?.state === 'ready' ? known.numerator ?? null : null,
      denominator: known?.state === 'ready' ? known.denominator ?? null : null,
    });
  }
  if (isOverTimeKind(scoped.node.kind)) {
    const bucketed = known?.state === 'ready' ? known.bucketed : undefined;
    const bucket = scoped.node.kind === 'activityGrid' ? 'day'
      : typeof scoped.node.properties.bucket === 'string' ? scoped.node.properties.bucket : 'month';
    if (scoped.node.kind === 'trendChart')
      return columns({ ...common, segments: bucketed === undefined ? [] : bucketSegments(bucket, bucketed) });
    const busiest = bucketed === undefined ? 0 : busiestBucket(bucketed);
    return activityGridMarkup({
      ...common,
      days: bucketed === undefined ? [] : bucketed.groups.map((group) => ({
        key: group.key,
        label: bucketLabel('day', group.key),
        lexeme: group.valueLexeme,
        level: activityLevel(group.valueLexeme, busiest),
      })),
    });
  }
  const groupByFieldId = typeof scoped.node.properties.groupByFieldId === 'string' ? scoped.node.properties.groupByFieldId : '';
  const field = context.fields.find((candidate) => candidate.semanticId === groupByFieldId);
  const grouped = known?.state === 'ready' ? known.grouped : undefined;
  return proportionBar({
    ...common,
    segments: grouped === undefined ? [] : breakdownSegments(field, grouped),
    unrecognised: grouped?.unrecognised ?? 0,
  });
}

export function fieldsMarkup(record: RecordPlan | null, fields: FieldPlan[], derived: DerivedFieldPlan[] = []): string {
  return fields.map((field) => fieldMarkup(record, field)).join('') +
    derived.map((field) => derivedFieldMarkup(record, field)).join('');
}

/**
 * A calculated field, shown rather than offered for editing.
 *
 * It deliberately does not look like a disabled input. A disabled control says
 * "you may not change this right now"; a calculated field is not a thing anyone
 * changes at all, and saying so — with the formula beside it — is the difference
 * between a reader understanding the number and wondering why they cannot touch it.
 */
export function derivedFieldMarkup(record: RecordPlan | null, field: DerivedFieldPlan, showFormula = true): string {
  const display = record === null
    ? { state: 'pending' as const, text: 'Calculated after saving', detail: undefined }
    : calculatedDisplay(record.calculations?.[field.semanticId]);
  // The formula names the author's binding aliases, which mean something in Studio
  // and nothing to a person using the finished screen.
  return `<div class="derived-field" data-derived-field="${escapeAttribute(field.semanticId)}" data-state="${display.state}" data-testid="${escapeAttribute(field.automationTarget)}">
    <span class="derived-label">${escapeHtml(field.displayName)}</span>
    <output class="derived-value">${escapeHtml(display.text)}</output>
    ${display.detail === undefined ? '' : `<p class="derived-detail" role="status">${escapeHtml(display.detail)}</p>`}
    <p class="derived-formula"><abbr title="This field is calculated and cannot be edited.">Calculated</abbr>${showFormula ? ` <code>${escapeHtml(field.expression)}</code>` : ''}</p>
  </div>`;
}

export function fieldMarkup(record: RecordPlan | null, field: FieldPlan): string {
  return field.retired
    ? `<fieldset disabled><legend>${escapeHtml(field.displayName)} (retired)</legend>${fieldControlMarkup(field, record?.values[field.semanticId])}</fieldset>`
    : fieldControlMarkup(field, record?.values[field.semanticId]);
}

export function fieldControlMarkup(field: FieldPlan, currentValue: unknown): string {
  const value = valueDisplay(currentValue);
  const definition = state.session.entities.flatMap(entity => entity.fields).find(candidate => candidate.fieldId === field.semanticId);
  if (definition && storageLabel(field.storageKind) === 'Reference') return referenceControl(definition, value);
  const required = field.required ? 'required' : '';
  const name = escapeAttribute(field.semanticId);
  const label = escapeHtml(field.displayName);
  const textControl = (markup: string): string => field.required ? markup : `<div class="scalar-field">${markup}<label class="checkbox-field"><input type="checkbox" name="__unset:${name}" data-null-field="${name}" value="true" ${currentValue === null || currentValue === undefined ? 'checked' : ''} />Not set</label></div>`;
  if (field.presentation === 'longText') {
    return textControl(`<label>${label}<textarea name="${name}" rows="4" ${required}>${escapeHtml(value)}</textarea></label>`);
  }
  if (field.presentation === 'singleChoice') {
    return `<label>${label}<select name="${name}" ${required}>${field.required ? '' : '<option value="">Not set</option>'}${field.options.filter(id => id === value || !field.choices?.some(choice => choice.id === id && choice.retired)).map(id => `<option value="${escapeAttribute(id)}" ${id === value ? 'selected' : ''} ${field.choices?.some(choice => choice.id === id && choice.retired) ? 'disabled' : ''}>${escapeHtml(choiceDisplay(field, id))}</option>`).join('')}</select></label>`;
  }
  const scale = ratingScaleOf(field);
  if (scale !== null) {
    return ratingControlMarkup(field.semanticId, field.displayName, scale, currentValue, field.required);
  }
  if (field.presentation === 'date' || storageLabel(field.storageKind) === 'Date') {
    return `<label>${label}<input name="${name}" type="date" value="${escapeAttribute(value)}" ${required} /></label>`;
  }
  if (storageLabel(field.storageKind) === 'Boolean') {
    return `<label>${label}<select name="${name}" ${required}><option value="" ${currentValue == null ? 'selected' : ''}>${field.required ? 'Choose Yes or No' : 'Not set'}</option><option value="true" ${currentValue === true ? 'selected' : ''}>Yes</option><option value="false" ${currentValue === false ? 'selected' : ''}>No</option></select></label>`;
  }
  const numeric = ['Integer', 'Decimal'].includes(storageLabel(field.storageKind));
  const markup = `<label>${label}<input name="${name}" type="text" ${numeric ? 'inputmode="decimal"' : ''} value="${escapeAttribute(value)}" ${required} /></label>`;
  return storageLabel(field.storageKind) === 'Text' ? textControl(markup) : markup;
}

export function recordFormMarkup(
  record: RecordPlan | null,
  fields: FieldPlan[],
  submitLabel: string,
  body?: string,
  extra = '',
  ownedValidation = false,
): string {
  // A required field in a hidden tab panel is not focusable, so the browser
  // blocks the submit with an error nobody can act on. Where the page owns tabs
  // it owns validation too: every declared field is checked, the first invalid
  // one has its tab opened, and only then is the failure reported.
  return `<form id="record-form" class="record-form" ${ownedValidation ? 'novalidate' : ''}>
    ${body ?? fieldsMarkup(record, fields)}${extra}
    <div class="form-actions">${record !== null && state.session.capabilities.mutate ? '<button id="delete-record" data-action type="button">Delete record…</button>' : ''}${record === null ? '<button id="cancel-create" class="secondary-button" type="button" data-dismiss>Cancel</button>' : ''}<button class="primary-button" data-action type="submit">${escapeHtml(submitLabel)}</button></div>
  </form>`;
}

/** The calculated field a node's visibility reads, when it declares one. */
export function visibilityFieldId(node: SurfaceNodePlan): string | null {
  const value = node.properties.visibleWhen;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function nodeTitle(node: SurfaceNodePlan, fallback: string): string {
  return typeof node.properties.title === 'string' && node.properties.title.length > 0
    ? node.properties.title
    : fallback;
}

// A step is applied when the record already holds the value it would assign.
// today and now resolve at execution, so a step using them is never "applied".
export function stepSatisfied(step: SurfaceNodePlan, record: RecordPlan): boolean {
  const fieldId = step.properties.fieldId;
  if (typeof fieldId !== 'string') return false;
  return step.properties.valueKind === 'literal'
    ? sameValue(record.values[fieldId], step.properties.value)
    : step.properties.valueKind === 'null' && (record.values[fieldId] ?? null) === null;
}

// An entity may own eight commands, so two of them may carry the same label.
// The button keeps the label as its text and takes its stable ID into the
// accessible name, so a screen reader does not announce two identical buttons.
export function treeCommandMarkup(node: SurfaceNodePlan, record: RecordPlan, ambiguous: boolean): string {
  const label = typeof node.properties.label === 'string' ? node.properties.label : 'Run';
  // today and now cannot be compared against a stored value, so a command is
  // spent only when every step that names a fixed value already holds it.
  const comparable = node.children.filter((child) =>
    child.kind === 'commandStep' && (child.properties.valueKind === 'literal' || child.properties.valueKind === 'null'));
  const applied = comparable.length > 0 && comparable.every((step) => stepSatisfied(step, record));
  const accessibleName = ambiguous ? ` aria-label="${escapeAttribute(`${label} (${node.semanticId})`)}"` : '';
  return `<button class="command-button" data-run-command="${escapeAttribute(node.semanticId)}"${accessibleName} data-action type="button" ${applied ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
}

export function commandButtons(plan: ApplicationPlan, record: RecordPlan): string {
  const commands = treeCommands(plan);
  const labels = commands.map((node) => typeof node.properties.label === 'string' ? node.properties.label : 'Run');
  return commands
    .map((node, index) => treeCommandMarkup(node, record,
      labels.some((label, other) => other !== index && label === labels[index])))
    .join('');
}

