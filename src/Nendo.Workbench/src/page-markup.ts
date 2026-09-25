import { activeTabSection, bindingFieldId, descendants, pageRoot, tabSections } from './surface-model';
import { visibleByCalculation } from './calculated-fields';
import { choiceStyle } from './tones';
import { icon } from './icons';
import { choiceDisplay, cssToken, escapeAttribute, escapeHtml } from './format';
import { selectedTabs, tabStateKey } from './app-state';
import { sectionIsOpen } from './fold-state';
import { formFields } from './plan-selection';
import { unsavedViewMarkup, viewPlaceholderMarkup, viewSpecFor } from './view-frame-markup';
import {
  chartTileMarkup, commandButtons, derivedFieldMarkup, fieldMarkup, fieldsMarkup, nodeTitle, recordFieldDisplay,
  recordFormMarkup, relatedListMarkup, summaryTileMarkup, visibilityFieldId,
} from './record-markup';
import type { ApplicationPlan, DerivedFieldPlan, FieldPlan, RecordPlan, SurfaceNodePlan } from './host';

/**
 * A record page, assembled. The walk keeps every node at the position it was
 * authored at — fields, sections, tabs, related lists and totals — because the
 * old flattening could not keep a related list between two sections and had
 * nowhere at all to put a tab.
 */

/**
 * What a record page is being rendered for. `rendered` is the one editor
 * authority: a field bound twice on the same page gets one control, at its first
 * authored position, and the repeat points at it. Two controls on one name would
 * give the field two draft values and two validation states.
 */
export interface PageContext {
  plan: ApplicationPlan;
  record: RecordPlan | null;
  pageId: string;
  fields: Map<string, FieldPlan>;
  /** The calculated fields of this record type. A binding may name one of these instead. */
  derived: Map<string, DerivedFieldPlan>;
  rendered: Map<string, string>;
  /** A new record has no relations or totals to scope to yet. */
  withRecordScoped: boolean;
  /** The section or tab being rendered, for the note a repeated field carries. */
  location: string;
}

/**
 * The record page, read depth first in authored order. Fields, sections, tabs,
 * related lists and totals keep the positions they were authored at; the old
 * flattening collected every field into a list of titled groups, which could not
 * keep a related list between two sections and had nowhere to put a tab.
 */
export function pageBodyMarkup(context: PageContext, nodes: SurfaceNodePlan[]): string {
  return nodes.map((node) => {
    // A calculation may say a node is not worth showing. It only ever hides: the
    // field stays in the form, its value still round-trips, and Studio is untouched.
    const hidden = !visibleByCalculation(context.record?.calculations, visibilityFieldId(node));
    switch (node.kind) {
      case 'fieldBinding': {
        const fieldId = bindingFieldId(node);
        if (fieldId === null) return '';
        // A calculated binding is shown, not wired: it has no draft value, no
        // validation state and nothing to submit, so it never enters `rendered`
        // and a second binding of it is simply shown again.
        const calculated = context.derived.get(fieldId);
        if (calculated !== undefined) return derivedFieldMarkup(context.record, calculated, false);
        const field = context.fields.get(fieldId);
        if (field === undefined) return '';
        const already = context.rendered.get(fieldId);
        if (already !== undefined)
          return `<p class="field-repeat">${escapeHtml(field.displayName)} is edited under ${escapeHtml(already)}.</p>`;
        context.rendered.set(fieldId, context.location);
        // Hidden, not removed: the control keeps its name and its value, so a save
        // carries exactly what it would have carried with the node on screen.
        return hidden
          ? `<div class="conditional-node" hidden>${fieldMarkup(context.record, field)}</div>`
          : fieldMarkup(context.record, field);
      }
      case 'section': {
        const title = nodeTitle(node, 'Section');
        // A disclosure whose heading is the control. Closed, its fields are still in the
        // form, as a hidden node's are, so a save carries what it would have carried. A
        // tab's body is drawn by its tab group and never comes through here.
        return `<details class="form-section" data-section="${escapeAttribute(node.semanticId)}" ${sectionIsOpen(node) ? 'open' : ''} ${hidden ? 'hidden' : ''}><summary>${escapeHtml(title)}</summary><div class="form-section-body">${withLocation(context, title, () => pageBodyMarkup(context, node.children))}</div></details>`;
      }
      case 'tabGroup':
        return tabGroupMarkup(context, node);
      // A relation renders its own tiles, so the walk does not descend into it.
      case 'relatedList':
        return context.withRecordScoped && context.record !== null ? relatedListMarkup(node, context.record) : '';
      case 'summaryTile':
        return context.withRecordScoped && context.record !== null
          ? summaryTileMarkup(node, { kind: 'page' })
          : '';
      case 'breakdownChart':
      case 'progressTile':
        return context.withRecordScoped && context.record !== null
          ? chartTileMarkup(context.plan, { node, scope: { kind: 'page' } })
          : '';
      // A custom view of this record, at the place it was authored (ADR-0013). The page draws
      // its placeholder; view-frames.ts runs the view in it once it scrolls into view. A record
      // not yet saved has no ID for a view to be about, so its placeholder says so instead.
      case 'extensionRecordPanel': {
        const recordId = context.withRecordScoped && context.record !== null ? context.record.semanticId : null;
        const spec = viewSpecFor(node, 'recordPage', context.plan.entity.semanticId, recordId);
        return recordId === null ? unsavedViewMarkup(spec) : viewPlaceholderMarkup(spec);
      }
      // A command is a page action, not a form control, and keeps its place in
      // the action area rather than moving inside a tab.
      default:
        return '';
    }
  }).join('');
}

// Where a field is being rendered, for the one-editor note a repeat carries.
export function withLocation(context: PageContext, location: string, body: () => string): string {
  const previous = context.location;
  context.location = location;
  const markup = body();
  context.location = previous;
  return markup;
}

/**
 * One tab group. Every panel is rendered into the form, so switching tabs is a
 * visibility change rather than a re-render: an unsaved value in an inactive tab
 * is still in the form when the record is saved.
 */
export function tabGroupMarkup(context: PageContext, group: SurfaceNodePlan): string {
  const sections = tabSections(group);
  if (sections.length === 0) return '';
  const active = activeTabId(context, group);
  const controlId = (section: SurfaceNodePlan, part: string): string =>
    `${part}-${cssToken(context.pageId)}-${cssToken(group.semanticId)}-${cssToken(section.semanticId)}`;
  const tabs = sections.map((section) => {
    const selected = section.semanticId === active;
    return `<button type="button" role="tab" id="${controlId(section, 'tab')}" aria-controls="${controlId(section, 'panel')}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-tab-group="${escapeAttribute(group.semanticId)}" data-tab="${escapeAttribute(section.semanticId)}">${escapeHtml(nodeTitle(section, 'Tab'))}</button>`;
  }).join('');
  const panels = sections.map((section) => {
    const selected = section.semanticId === active;
    return `<div role="tabpanel" id="${controlId(section, 'panel')}" aria-labelledby="${controlId(section, 'tab')}" data-tab-panel="${escapeAttribute(section.semanticId)}" data-tab-group="${escapeAttribute(group.semanticId)}" ${selected ? '' : 'hidden'}>${withLocation(context, nodeTitle(section, 'Tab'), () => pageBodyMarkup(context, section.children))}</div>`;
  }).join('');
  const label = typeof group.properties.title === 'string' && group.properties.title.length > 0
    ? group.properties.title
    : `${context.plan.entity.displayName} details`;
  return `<div class="tab-group" data-tab-group-id="${escapeAttribute(group.semanticId)}"><div class="tablist" role="tablist" aria-label="${escapeAttribute(label)}">${tabs}</div>${panels}</div>`;
}

/**
 * Which tab is open. Remembered per file, record type, page and group — never in
 * the `.nendo` file, because which tab someone last looked at is not part of the
 * application. A remembered tab that no longer exists falls back to the first.
 */
export function activeTabId(context: PageContext, group: SurfaceNodePlan): string {
  return activeTabSection(group, selectedTabs.get(
    tabStateKey(context.plan.entity.semanticId, context.pageId, group.semanticId)))!.semanticId;
}

/** The record page body for one plan, or the flat field list when it has no page. */
export function pageFormBody(plan: ApplicationPlan, record: RecordPlan | null, withRecordScoped: boolean): string {
  const root = pageRoot(plan);
  const fields = formFields(plan);
  if (root === null) return fieldsMarkup(record, fields);
  const context: PageContext = {
    plan,
    record,
    pageId: root.semanticId,
    fields: new Map(fields.map((field) => [field.semanticId, field])),
    derived: new Map((plan.entity.derivedFields ?? []).map((field) => [field.semanticId, field])),
    rendered: new Map(),
    withRecordScoped,
    location: 'this page',
  };
  const body = pageBodyMarkup(context, root.children);
  // A page that renders nothing at all falls back to the record type's own
  // fields, as it did before tabs existed. A page that shows only a related
  // list has rendered something, and keeps it.
  return body.length > 0 ? body : fieldsMarkup(record, fields);
}

export function pageHasTabs(plan: ApplicationPlan): boolean {
  const root = pageRoot(plan);
  return root !== null && descendants(root.children, 'tabGroup').length > 0;
}

/**
 * The record-page header (ADR-0004, 2026-09-14): the field that heads the page, the
 * field shown under it, and the choice whose tone colours the band. Nothing is drawn
 * when the page names none of them, so a page authored before headers existed is
 * unchanged. The values are read from the record, never edited here: the form
 * below is still the only place a value changes.
 */
export function recordHeroMarkup(plan: ApplicationPlan, record: RecordPlan): string {
  const root = pageRoot(plan);
  if (root === null || root.kind !== 'detailSurface') return '';
  const named = (key: string): string | null => {
    const value = root.properties[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const titleFieldId = named('titleFieldId');
  const subtitleFieldId = named('subtitleFieldId');
  const accentFieldId = named('accentFieldId');
  if (titleFieldId === null && subtitleFieldId === null && accentFieldId === null) return '';
  const accentField = accentFieldId === null ? undefined : plan.entity.fields.find((field) => field.semanticId === accentFieldId);
  const accentValue = accentFieldId === null ? null : record.values[accentFieldId];
  const toned = accentField !== undefined && accentValue !== null && accentValue !== undefined && accentValue !== '';
  const style = accentField !== undefined && toned ? choiceStyle(accentField, accentValue) : '';
  const chip = accentField !== undefined && toned
    ? `<span class="card-chip" style="${style}" title="${escapeAttribute(accentField.displayName)}">${escapeHtml(choiceDisplay(accentField, accentValue))}</span>`
    : '';
  const title = titleFieldId === null ? '' : `<h2>${escapeHtml(recordFieldDisplay(record, titleFieldId, plan.entity.derivedFields) || `Untitled ${plan.entity.displayName}`)}</h2>`;
  const subtitle = subtitleFieldId === null ? '' : `<p>${escapeHtml(recordFieldDisplay(record, subtitleFieldId, plan.entity.derivedFields) || 'Not set')}</p>`;
  return `<div class="record-hero" data-testid="record-hero" style="${style}">${chip}${title}${subtitle}</div>`;
}

/**
 * The record's commands, directly under the header and above the form. A command
 * is the action a person came to the page for; under the Save button of a long
 * form it was the one thing nobody scrolled to.
 */
export function recordActionsMarkup(plan: ApplicationPlan, record: RecordPlan): string {
  const buttons = commandButtons(plan, record);
  return buttons === '' ? '' : `<div class="record-actions" data-testid="record-actions">${buttons}</div>`;
}

export function inspectorMarkup(plan: ApplicationPlan, record: RecordPlan): string {
  return `<aside class="record-inspector"><header><span>${escapeHtml(plan.entity.displayName)} details</span><button id="close-inspector" class="icon-button" type="button" aria-label="Close" data-dismiss>${icon('close')}</button></header>${recordHeroMarkup(plan, record)}${recordActionsMarkup(plan, record)}${recordFormMarkup(record, formFields(plan), 'Save changes', pageFormBody(plan, record, true), '', pageHasTabs(plan))}<p class="version-note">Record version ${record.version}</p></aside>`;
}

