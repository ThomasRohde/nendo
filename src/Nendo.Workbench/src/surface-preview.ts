import type { ApplicationPlan, FieldPlan, OverviewPlan, RecordPlan, SurfaceNodePlan } from './host';
import { exactNumberText } from './scalars';

import { choiceStyle } from './tones';
import { activityLevel, breakdownSegments, bucketLabel, bucketSegments, busiestBucket, chartTitle, isChartKind, isOverTimeKind, rangeLabel, sampleBucketed, sampleGrouped } from './charts';
import { proportionBar, columns, activityGrid as activityGridMarkup } from './chart-kit';
import { civilDate, groupByDate, monthGrid, monthLabel, monthOf, undatedItems, weekdayNames } from './calendar-model';
import { maximumReferenceBoardColumns } from './surface-model';
import { dayMonthLabel, groupByMonth, spanLabel, spanOf, yearNote } from './timeline-model';

/**
 * A read-only view of what a proposal builds. Contract versions 1 and 2 fill four
 * fixed slots; version 3 composes a node tree and leaves those slots null. Both
 * are projected onto one list of previewable surfaces here, so a version 3
 * proposal is no longer previewed as an empty panel.
 */
interface PreviewSurface {
  id: string;
  kind: string;
  label: string;
  node: SurfaceNodePlan | null;
}

const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Which tab a reviewer opened, for this preview only. The preview is a read-only
// view of a validated clone, so nothing it selects reaches a file.
const previewTabs = new Map<string, string>();
const text = (value: unknown): string => value == null ? 'Not set' : exactNumberText(value) ?? (typeof value === 'object' ? JSON.stringify(value) : String(value));
function valueText(app: ApplicationPlan, record: RecordPlan | undefined, fieldId: string): string {
  const field = app.entity.fields.find(field => field.semanticId === fieldId);
  const value = record?.values[fieldId];
  if (value != null && record?.referenceLabels && fieldId in record.referenceLabels) return record.referenceLabels[fieldId] ?? '(No target label)';
  return field?.choices?.find(choice => choice.id === value)?.displayName ?? text(value);
}
const name = (field: FieldPlan | undefined, id: string): string => field?.displayName ?? id;
const property = (node: SurfaceNodePlan, key: string): string | null =>
  typeof node.properties[key] === 'string' ? node.properties[key] as string : null;
// Every number crossing the desktop bridge is wrapped in a $nendoNumber envelope, so a
// plain typeof check never matches and the preview quietly printed its own default
// instead of the limit the node carries: "up to 10" over a node that says 5.
const limitOf = (node: SurfaceNodePlan, fallback: number): string => {
  const exact = exactNumberText(node.properties.limit);
  if (exact !== null) return exact;
  return typeof node.properties.limit === 'number' ? String(node.properties.limit) : String(fallback);
};
const childrenOf = (node: SurfaceNodePlan, kind: string): SurfaceNodePlan[] => node.children.filter(child => child.kind === kind);
// A tab is a section inside a group, so a tabbed field is still one of the
// surface's own fields; stopping at the group would hide it from the preview.
const bindings = (node: SurfaceNodePlan): string[] => node.children.flatMap(child =>
  child.kind === 'fieldBinding' ? [property(child, 'fieldId') ?? ''].filter(Boolean)
    : child.kind === 'section' || child.kind === 'tabGroup' ? bindings(child) : []);

function kindLabel(kind: string): string {
  switch (kind) {
    case 'detailSurface': return 'Record page';
    case 'recordForm': return 'Form';
    case 'recordList': return 'List';
    case 'boardSurface': return 'Board';
    case 'calendarSurface': return 'Calendar';
    case 'timelineSurface': return 'Timeline';
    case 'gallerySurface': return 'Gallery';
    case 'overviewSurface': return 'Front page';
    case 'recentList': return 'Recent records';
    case 'matrixSurface': return 'Matrix';
    case 'rankedList': return 'Ranking';
    case 'rangeTile': return 'Range';
    case 'recordCommand': return 'Action';
    default: return kind;
  }
}

/**
 * A tile as a preview describes it. The number is computed against live data,
 * which a frozen preview does not carry, so it states what will be counted
 * rather than fabricating a total from the bounded sample.
 */
function tileMarkup(node: SurfaceNodePlan, fieldName: (id: string) => string, context: string): string {
  const aggregate = property(node, 'aggregate') ?? 'count';
  const fieldId = property(node, 'fieldId');
  const scope = property(node, 'scope');
  return `<section class="summary-tile"><span class="summary-title">${escape(property(node, 'title') ?? aggregate)}</span><span class="preview-note">${escape(aggregate)}${fieldId ? ` of ${escape(fieldName(fieldId))}` : ''} over ${escape(scope === 'group' ? 'each board column' : context)}</span></section>`;
}

function tilesMarkup(app: ApplicationPlan, node: SurfaceNodePlan, fieldName: (id: string) => string, context: string): string {
  const tiles = childrenOf(node, 'summaryTile');
  const charts = node.children.filter(child => isChartKind(child.kind));
  if (tiles.length === 0 && charts.length === 0) return '';
  return `<div class="summary-tiles">${tiles.map(tile => tileMarkup(tile, fieldName, context)).join('')}${charts.map(chart => chartMarkup(app, chart, fieldName, context)).join('')}</div>`;
}

/**
 * A chart as a preview shows it. A breakdown is counted over the bounded sample —
 * records per group, whatever the live chart totals, because a sum over a sample
 * is not the sum — and says so. A ring is described: its two counts are live reads
 * the preview does not carry.
 */
function chartMarkup(app: ApplicationPlan, node: SurfaceNodePlan, fieldName: (id: string) => string, context: string): string {
  if (node.kind === 'progressTile') {
    const conditions = childrenOf(node, 'filterClause').length;
    return `<section class="summary-tile"><span class="summary-title">${escape(chartTitle(node, fieldName))}</span><span class="preview-note">A ring of the records matching its ${conditions === 1 ? 'condition' : `${conditions} conditions`} over ${escape(context)}; both counts are read live.</span></section>`;
  }
  if (isOverTimeKind(node.kind)) {
    // The preview generates its buckets from the range too, so a reviewer sees the empty
    // months the live screen will draw rather than only the ones the sample happened to
    // touch — which is the one thing about these kinds a summary could misrepresent.
    const sample = sampleBucketed(node, app.records, new Date());
    const bucket = node.kind === 'activityGrid' ? 'day' : property(node, 'bucket') ?? 'month';
    const covers = `in this read-only sample, over ${rangeLabel(property(node, 'range'))}; the live chart reads ${escape(context)}`;
    if (node.kind === 'trendChart')
      return columns({
        key: `preview:${node.semanticId}`,
        title: chartTitle(node, fieldName),
        context: `records per ${bucket} ${covers}`,
        status: { state: 'ready' },
        segments: bucketSegments(bucket, sample),
        tableOpen: false,
        drillable: false,
      });
    const busiest = busiestBucket(sample);
    return activityGridMarkup({
      key: `preview:${node.semanticId}`,
      title: chartTitle(node, fieldName),
      context: `records per day ${covers}`,
      status: { state: 'ready' },
      days: sample.groups.map((group) => ({
        key: group.key,
        label: bucketLabel('day', group.key),
        lexeme: group.valueLexeme,
        level: activityLevel(group.valueLexeme, busiest),
      })),
      tableOpen: false,
      drillable: false,
    });
  }
  const groupByFieldId = property(node, 'groupByFieldId') ?? '';
  const aggregate = property(node, 'aggregate') ?? 'count';
  const fieldId = property(node, 'fieldId');
  const field = app.entity.fields.find(candidate => candidate.semanticId === groupByFieldId);
  const sample = sampleGrouped(node, field, app.records);
  const live = aggregate === 'count' ? 'counts every matching record' : `totals ${fieldName(fieldId ?? '')} exactly`;
  return proportionBar({
    key: `preview:${node.semanticId}`,
    title: chartTitle(node, fieldName),
    context: `records per ${fieldName(groupByFieldId)} in this read-only sample; the live chart ${live} over ${context}`,
    status: { state: 'ready' },
    segments: breakdownSegments(field, sample),
    unrecognised: sample.unrecognised,
    tableOpen: false,
    drillable: false,
  });
}

function surfacesOf(app: ApplicationPlan): PreviewSurface[] {
  return app.surfaces.map(node => ({
    id: node.semanticId,
    kind: node.kind,
    label: property(node, 'title') ?? property(node, 'label') ?? kindLabel(node.kind),
    node,
  }));
}

export function surfacePreviewMarkup(
  app: ApplicationPlan,
  surfaceId: string,
  selected: number,
  total: number,
  // The other record types in the same proposal. A board grouped by a reference has
  // columns that are records of one of them, so it cannot be previewed from its own
  // plan alone -- every other surface can.
  peers: ApplicationPlan[] = [],
): string {
  const surfaces = surfacesOf(app);
  const surface = surfaces.find(candidate => candidate.id === surfaceId) ?? surfaces[0];
  const record = app.records[selected];
  const titleField = app.surfaces.flatMap(node => bindings(node))[0] ?? app.entity.fields[0]?.semanticId;
  const recordLabel = (item: RecordPlan): string => titleField ? valueText(app, item, titleField) : item.semanticId;
  const fieldName = (id: string): string => name(app.entity.fields.find(field => field.semanticId === id), id);
  const body = surface?.node == null ? '' : treeMarkup(app, surface.node, fieldName, record, peers);
  return `<div class="preview-controls"><label>Record type<select data-preview-entity></select></label><div class="view-switcher" role="group" aria-label="Preview surface">${surfaces.map(candidate => `<button type="button" data-preview-surface="${escape(candidate.id)}" aria-pressed="${candidate.id === surface?.id}">${escape(candidate.label)}</button>`).join('')}</div>
    <label>Preview record<select data-preview-selected>${app.records.map((record, index) => `<option value="${index}" ${index === selected ? 'selected' : ''}>${escape(recordLabel(record).slice(0, 100))} · ${escape(record.semanticId)} · v${record.version}</option>`).join('')}</select></label></div>
    <p class="preview-count" role="status">${app.records.length} of ${total} records in this read-only preview. Your active file is unchanged.</p><div class="preview-content">${body}</div>`;
}

function treeMarkup(
  app: ApplicationPlan,
  root: SurfaceNodePlan,
  fieldName: (id: string) => string,
  record: RecordPlan | undefined,
  peers: ApplicationPlan[] = [],
): string {
  const title = property(root, 'title') ?? property(root, 'label') ?? kindLabel(root.kind);
  if (root.kind === 'recordList') {
    return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${tilesMarkup(app, root, fieldName, 'every matching record')}${sampleNote(app)}${listMarkup(app, bindings(root))}`;
  }
  if (root.kind === 'boardSurface') {
    const groupId = property(root, 'groupByFieldId') ?? '';
    const field = app.entity.fields.find(field => field.semanticId === groupId);
    // A reference board's columns are records of another record type, so they come from
    // that type's sample here rather than from this field. The live board reads every one
    // of them; the preview has a sample, and says so beside the count.
    const target = field?.reference == null ? null : peers.find(peer => peer.entity.semanticId === field.reference!.targetEntityId) ?? null;
    if (field?.reference != null && target === null)
      return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${tilesMarkup(app, root, fieldName, 'every matching record')}<p class="preview-note">This board has one column per ${escape(field.reference.targetEntityId)} record. Those records are not part of this preview, so its columns are not drawn here. The live board reads them when it opens and refuses to draw above ${maximumReferenceBoardColumns} of them.</p>`;
    // options is the authoritative ordered set of choice IDs; choices only carries
    // display metadata for the options that were given some, so a board grouped by
    // a plain single-choice field must read the former.
    const ids = target === null ? field?.options ?? [] : target.records.map(record => record.semanticId);
    const labelFieldId = field?.reference?.labelFieldId ?? '';
    const ungrouped = app.records.filter(record => !ids.includes(String(record.values[groupId] ?? '')));
    const columns = [...(ungrouped.length ? [{ id: null, label: 'Ungrouped', records: ungrouped, style: '' }] : []), ...ids.map(id => ({
      id,
      label: target === null
        ? field?.choices?.find(choice => choice.id === id)?.displayName ?? id
        : valueText(target, target.records.find(record => record.semanticId === id), labelFieldId),
      records: app.records.filter(record => record.values[groupId] === id),
      // The column takes its option's tone, as the running board does. A reference column
      // has no option and no tone, so the same call derives a hue from the record ID --
      // which is what an untoned option already gets.
      style: choiceStyle(field, id),
    }))];
    const note = target === null ? '' : `<p class="preview-note">One column per ${escape(target.entity.displayName)} record in this sample. The live board reads every one of them and refuses to draw above ${maximumReferenceBoardColumns}.</p>`;
    return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${tilesMarkup(app, root, fieldName, 'every matching record')}${sampleNote(app)}${note}${boardMarkup(app, columns, bindings(root), fieldName)}`;
  }
  if (root.kind === 'matrixSurface') {
    return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${tilesMarkup(app, root, fieldName, 'every matching record')}${sampleNote(app)}${matrixMarkup(app, root, fieldName)}`;
  }
  if (root.kind === 'calendarSurface') {
    return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${calendarMarkup(app, root, fieldName)}`;
  }
  if (root.kind === 'gallerySurface') {
    return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${tilesMarkup(app, root, fieldName, 'every matching record')}${sampleNote(app)}${galleryMarkup(app, root, fieldName)}`;
  }
  if (root.kind === 'timelineSurface') {
    return `<h4>${escape(title)}</h4>${filterNote(root, fieldName)}${timelineMarkup(app, root, fieldName)}`;
  }
  if (root.kind === 'recordCommand') {
    const steps = childrenOf(root, 'commandStep').map(step => {
      const fieldId = property(step, 'fieldId') ?? '';
      const kind = property(step, 'valueKind');
      // A choice value reads as its display name here, as it does everywhere else
      // a record shows it; the stored ID names nothing a reviewer recognises.
      const field = app.entity.fields.find(candidate => candidate.semanticId === fieldId);
      const literal = field?.choices?.find(choice => choice.id === step.properties.value)?.displayName
        ?? text(step.properties.value);
      const value = kind === 'today' ? "today's date" : kind === 'now' ? 'the current time' : kind === 'null' ? 'nothing'
        : literal;
      return `<li>Sets ${escape(fieldName(fieldId))} to ${escape(value)}.</li>`;
    }).join('');
    return `<h4>${escape(title)}</h4><ul class="command-steps">${steps}</ul><button type="button" class="command-button" disabled>${escape(title)}</button>`;
  }
  // detailSurface and recordForm: sections, bindings, related lists and tiles.
  return `<h4>${escape(title)}</h4>${heroMarkup(app, root, record)}<div class="record-form">${sectionMarkup(app, root, fieldName, record)}</div>`;
}

/**
 * The record-page header a reviewer sees before accepting: the title field, the
 * subtitle field and the accent choice's chip in its tone. Nothing is drawn when the
 * page names none of them.
 */
function heroMarkup(app: ApplicationPlan, root: SurfaceNodePlan, record: RecordPlan | undefined): string {
  if (root.kind !== 'detailSurface') return '';
  const titleId = property(root, 'titleFieldId');
  const subtitleId = property(root, 'subtitleFieldId');
  const accentId = property(root, 'accentFieldId');
  if (titleId === null && subtitleId === null && accentId === null) return '';
  const accentField = accentId === null ? undefined : app.entity.fields.find(field => field.semanticId === accentId);
  const accentValue = accentId === null ? undefined : record?.values[accentId];
  const toned = accentField !== undefined && accentId !== null && accentValue != null && accentValue !== '';
  const style = toned ? choiceStyle(accentField, accentValue) : '';
  const chip = toned ? `<span class="card-chip" style="${style}">${escape(valueText(app, record, accentId))}</span>` : '';
  const heading = titleId === null ? '' : `<h2>${escape(valueText(app, record, titleId))}</h2>`;
  const subtitle = subtitleId === null ? '' : `<p>${escape(valueText(app, record, subtitleId))}</p>`;
  return `<div class="record-hero" style="${style}">${chip}${heading}${subtitle}</div>`;
}

function tabGroupMarkup(
  app: ApplicationPlan,
  group: SurfaceNodePlan,
  fieldName: (id: string) => string,
  record: RecordPlan | undefined,
): string {
  const sections = childrenOf(group, 'section');
  if (sections.length === 0) return '';
  const remembered = previewTabs.get(group.semanticId);
  const active = sections.some(section => section.semanticId === remembered)
    ? remembered
    : sections[0].semanticId;
  const tabs = sections.map(section => {
    const selected = section.semanticId === active;
    return `<button type="button" role="tab" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-preview-tab-group="${escape(group.semanticId)}" data-preview-tab="${escape(section.semanticId)}">${escape(property(section, 'title') ?? 'Tab')}</button>`;
  }).join('');
  const panels = sections.map(section => `<div role="tabpanel" aria-label="${escape(property(section, 'title') ?? 'Tab')}" ${section.semanticId === active ? '' : 'hidden'}>${sectionMarkup(app, section, fieldName, record)}</div>`).join('');
  return `<div class="tab-group"><div class="tablist" role="tablist" aria-label="${escape(property(group, 'title') ?? 'Details')}">${tabs}</div>${panels}</div>`;
}

function sectionMarkup(
  app: ApplicationPlan,
  node: SurfaceNodePlan,
  fieldName: (id: string) => string,
  record: RecordPlan | undefined,
): string {
  return node.children.map(child => {
    if (child.kind === 'fieldBinding') {
      const fieldId = property(child, 'fieldId') ?? '';
      return `<label>${escape(fieldName(fieldId))}<textarea readonly aria-readonly="true" rows="2">${escape(valueText(app, record, fieldId))}</textarea></label>`;
    }
    if (child.kind === 'section') {
      // Drawn as it starts: a reviewer sees a section that opens closed as closed.
      return `<details class="form-section" ${property(child, 'opens') === 'closed' ? '' : 'open'}><summary>${escape(property(child, 'title') ?? 'Section')}</summary><div class="form-section-body">${sectionMarkup(app, child, fieldName, record)}</div></details>`;
    }
    if (child.kind === 'tabGroup') {
      return tabGroupMarkup(app, child, fieldName, record);
    }
    if (child.kind === 'relatedList') {
      const target = property(child, 'targetEntityId') ?? 'related records';
      const columns = bindings(child).map(id => escape(id)).join(', ');
      // The related records live on another record type, which this preview does
      // not carry. Describe the relation rather than invent rows for it — including
      // the two things it will do that a description of its columns does not say.
      return `<section class="related-list"><h3>${escape(property(child, 'title') ?? target)}</h3><p class="preview-note">Shows ${escape(target)} records that point at this one${columns ? `, with ${columns}` : ''}. On the record page it also adds one, already pointing here, and opens the one you click.</p>${sectionMarkup(app, child, fieldName, undefined)}</section>`;
    }
    if (child.kind === 'summaryTile') {
      // The rollup is computed against live data, which a frozen preview does not
      // carry. State what it will count rather than show a number that is not real.
      return tileMarkup(child, fieldName, 'every record of this type');
    }
    if (isChartKind(child.kind)) {
      return `<div class="summary-tiles">${chartMarkup(app, child, fieldName, 'every record of this type')}</div>`;
    }
    return '';
  }).join('');
}

/**
 * A calendar as a preview shows it: the same civil-date grouping the Use renderer
 * uses, over the bounded sample the validated clone carries. The month shown is
 * the one the sample falls in, because the preview reads no live data and cannot
 * ask which month an owner is looking at.
 */
function calendarMarkup(
  app: ApplicationPlan,
  root: SurfaceNodePlan,
  fieldName: (id: string) => string,
): string {
  const dateFieldId = property(root, 'dateFieldId');
  if (dateFieldId === null) return '<p class="preview-note">This calendar names no date field.</p>';
  const dated = app.records.filter(record => civilDate(record.values[dateFieldId]) !== null);
  const undated = undatedItems(app.records, record => record.values[dateFieldId]);
  const month = monthOf(civilDate(dated[0]?.values[dateFieldId]) ?? '') ?? { year: 2026, month: 1 };
  const byDate = groupByDate(dated, record => record.values[dateFieldId]);
  const titleFieldId = bindings(root)[0] ?? app.entity.fields[0]?.semanticId ?? '';
  const cells = monthGrid(month).map(cell => {
    if (cell.date === null) return '<div class="calendar-cell is-padding" aria-hidden="true"></div>';
    const placed = byDate.get(cell.date) ?? [];
    return `<div class="calendar-cell"><span class="calendar-day">${cell.day}</span>${placed.map(record => `<span class="calendar-entry">${escape(valueText(app, record, titleFieldId))}</span>`).join('')}</div>`;
  }).join('');
  return `<p class="preview-note">Placing the ${dated.length} dated ${dated.length === 1 ? 'record' : 'records'} of this read-only sample by ${escape(fieldName(dateFieldId))}, in ${escape(monthLabel(month))}. The live calendar reads one month at a time and offers its own undated view.</p>
    <div class="record-calendar"><div class="calendar-weekdays">${weekdayNames.map(day => `<span>${day}</span>`).join('')}</div>${cells}</div>
    <p class="preview-note">${undated.length} ${undated.length === 1 ? 'record has' : 'records have'} no ${escape(fieldName(dateFieldId))} and appear in the Undated view.</p>`;
}

/**
 * A timeline as a preview shows it: the same month grouping and the same spans
 * the Use renderer draws, over the bounded sample the validated clone carries.
 * The year shown is the one the sample falls in, and only the months with a
 * sample entry are drawn, because the preview reads no live data and twelve
 * empty headings would describe the sample rather than the definition.
 */
function timelineMarkup(
  app: ApplicationPlan,
  root: SurfaceNodePlan,
  fieldName: (id: string) => string,
): string {
  const dateFieldId = property(root, 'dateFieldId');
  if (dateFieldId === null) return '<p class="preview-note">This timeline names no date field.</p>';
  const endDateFieldId = property(root, 'endDateFieldId');
  const accentFieldId = property(root, 'accentFieldId');
  const accentField = accentFieldId === null ? undefined : app.entity.fields.find(field => field.semanticId === accentFieldId);
  const titleFieldId = property(root, 'titleFieldId') ?? bindings(root)[0] ?? app.entity.fields[0]?.semanticId ?? '';
  const dated = app.records.filter(record => civilDate(record.values[dateFieldId]) !== null);
  const undated = undatedItems(app.records, record => record.values[dateFieldId]);
  const year = Number((civilDate(dated[0]?.values[dateFieldId]) ?? '2026').slice(0, 4));
  const months = groupByMonth(dated, year, record => record.values[dateFieldId], false)
    .filter(group => group.items.length > 0)
    .map(({ month, items }) => `<section class="timeline-month"><h3>${escape(monthLabel(month))}</h3>${items.map(record => {
      const date = civilDate(record.values[dateFieldId]) ?? '';
      const outcome = endDateFieldId === null ? { kind: 'none' as const } : spanOf(date, record.values[endDateFieldId], year);
      const span = outcome.kind === 'span'
        ? `<span class="timeline-span${outcome.span.clipped ? ' is-clipped' : ''}" style="--span: ${(outcome.span.proportion * 100).toFixed(1)}%" aria-hidden="true"></span><span class="timeline-span-text">${escape(spanLabel(date, outcome.span, year))}</span>`
        : outcome.kind === 'issue' ? `<span class="timeline-issue">${escape(outcome.message)}</span>` : '';
      const style = accentFieldId === null ? '' : choiceStyle(accentField, record.values[accentFieldId]);
      return `<span class="timeline-entry" style="${style}"><span class="status-dot" aria-hidden="true"></span><span class="timeline-date">${escape(dayMonthLabel(date))}</span><span class="timeline-body"><strong class="timeline-title">${escape(valueText(app, record, titleFieldId))}</strong>${span}</span></span>`;
    }).join('')}</section>`).join('');
  const spans = endDateFieldId === null ? '' : `, with spans to ${escape(fieldName(endDateFieldId))}`;
  const note = endDateFieldId === null ? '' : `<p class="preview-note">${escape(yearNote(year))}</p>`;
  return `<p class="preview-note">Placing the ${dated.length} dated ${dated.length === 1 ? 'record' : 'records'} of this read-only sample by ${escape(fieldName(dateFieldId))}, in ${year}${spans}. The live timeline reads one year at a time under every month heading and offers its own undated view.</p>${note}
    <div class="record-timeline">${months}</div>
    <p class="preview-note">${undated.length} ${undated.length === 1 ? 'record has' : 'records have'} no ${escape(fieldName(dateFieldId))} and appear in the Undated view.</p>`;
}

/**
 * The preview shows a bounded sample of the validated clone, not a query result.
 * Labelling it is the difference between a reviewer reading a shape and reading
 * a count; an exact total would have to come from the clone through the typed
 * services, which the preview deliberately does not call.
 */
function sampleNote(app: ApplicationPlan): string {
  return `<p class="preview-note">Showing a sample of ${app.records.length} ${app.records.length === 1 ? 'record' : 'records'} from the validated proposal. Counts and totals are computed against live data when the proposal is accepted.</p>`;
}

function filterNote(node: SurfaceNodePlan, fieldName: (id: string) => string): string {
  const clauses = childrenOf(node, 'filterClause').map(clause => {
    const fieldId = property(clause, 'fieldId') ?? '';
    const operator = property(clause, 'operator') ?? 'eq';
    const value = operator === 'isNull' || operator === 'isNotNull' ? '' : ` ${text(clause.properties.value)}`;
    return `${fieldName(fieldId)} ${operator}${value}`;
  });
  return clauses.length === 0 ? '' : `<p class="preview-filter">Showing records where ${escape(clauses.join(' and '))}.</p>`;
}

function listMarkup(app: ApplicationPlan, fieldIds: string[]): string {
  return `<div class="record-list">${app.records.map((record, index) => `<button type="button" data-preview-record="${index}">${fieldIds.map(id => `<span>${escape(valueText(app, record, id))}</span>`).join('')}<small>v${record.version}</small></button>`).join('') || '<p>No records in this preview.</p>'}</div>`;
}

/**
 * A gallery as a preview shows it: the same cards the Use renderer draws, over the
 * bounded sample the validated clone carries, each toned by its accent option.
 */
function galleryMarkup(
  app: ApplicationPlan,
  root: SurfaceNodePlan,
  fieldName: (id: string) => string,
): string {
  const bound = bindings(root);
  const titleFieldId = property(root, 'titleFieldId') ?? bound[0] ?? app.entity.fields[0]?.semanticId ?? '';
  const bodyFieldIds = bound.filter(fieldId => fieldId !== titleFieldId);
  const accentFieldId = property(root, 'accentFieldId');
  const accentField = accentFieldId === null ? undefined : app.entity.fields.find(field => field.semanticId === accentFieldId);
  if (app.records.length === 0) return '<p class="preview-note">No records in this preview.</p>';
  return `<div class="record-gallery">${app.records.map(record => {
    const style = accentFieldId === null ? '' : choiceStyle(accentField, record.values[accentFieldId]);
    return `<span class="record-card${style === '' ? '' : ' is-toned'}" style="${style}" data-preview-record="${app.records.indexOf(record)}"><strong>${escape(valueText(app, record, titleFieldId))}</strong>${bodyFieldIds.map(id => `<span>${escape(fieldName(id))}: ${escape(valueText(app, record, id))}</span>`).join('')}</span>`;
  }).join('')}</div>`;
}

function boardMarkup(
  app: ApplicationPlan,
  columns: Array<{ id: string | null; label: string; records: RecordPlan[]; style?: string }>,
  cardFieldIds: string[],
  fieldName: (id: string) => string,
): string {
  return `<div class="record-board" style="--group-count:${columns.length}">${columns.map(column => `<section class="board-column"><header>${column.style ? `<span class="status-dot" style="${column.style}" aria-hidden="true"></span>` : ''}<h3>${escape(column.label)}</h3><strong>${column.records.length}</strong></header><div class="card-stack">${column.records.map(record => `<button type="button" class="record-card" data-preview-record="${app.records.indexOf(record)}"><strong>${escape(valueText(app, record, cardFieldIds[0] ?? ''))}</strong>${cardFieldIds.slice(1).map(id => `<span>${escape(fieldName(id))}: ${escape(valueText(app, record, id))}</span>`).join('')}</button>`).join('') || '<p class="empty-column">No records in this preview</p>'}</div></section>`).join('')}</div>`;
}


/**
 * The grid a proposal will produce: one lane per option on each axis, and the sample's
 * records placed into the cells they belong to.
 *
 * The exact number in each cell is a live grouped read over the whole record type, which
 * a frozen preview does not have, so a cell counts only the records the sample carries
 * and the note under the grid says exactly that. Inventing a total from a bounded sample
 * would be the one thing worse than showing none.
 */
function matrixMarkup(app: ApplicationPlan, root: SurfaceNodePlan, fieldName: (id: string) => string): string {
  const rowId = property(root, 'rowByFieldId') ?? '';
  const columnId = property(root, 'columnByFieldId') ?? '';
  const rowField = app.entity.fields.find(field => field.semanticId === rowId);
  const columnField = app.entity.fields.find(field => field.semanticId === columnId);
  const rows = rowField?.options ?? [];
  const columns = columnField?.options ?? [];
  const cardFieldIds = bindings(root);
  const laneLabel = (field: typeof rowField, id: string): string =>
    field?.choices?.find(choice => choice.id === id)?.displayName ?? id;
  const header = `<div class="matrix-corner"><small>${escape(fieldName(rowId))}</small><small>${escape(fieldName(columnId))}</small></div>` +
    columns.map(column => `<div class="matrix-heading"><span class="status-dot" style="${choiceStyle(columnField, column)}" aria-hidden="true"></span><h3>${escape(laneLabel(columnField, column))}</h3></div>`).join('');
  const body = rows.map(row => {
    const heading = `<div class="matrix-heading matrix-row-heading"><span class="status-dot" style="${choiceStyle(rowField, row)}" aria-hidden="true"></span><h3>${escape(laneLabel(rowField, row))}</h3></div>`;
    return heading + columns.map(column => {
      const held = app.records.filter(record =>
        String(record.values[rowId] ?? '') === row && String(record.values[columnId] ?? '') === column);
      return `<section class="matrix-cell${held.length === 0 ? ' is-empty' : ''}"><header><strong>${held.length}</strong></header><div class="card-stack">${held.map(record =>
        `<button type="button" class="record-card" data-preview-record="${app.records.indexOf(record)}"><strong>${escape(valueText(app, record, cardFieldIds[0] ?? ''))}</strong></button>`).join('')}</div></section>`;
    }).join('');
  }).join('');
  return `<div class="record-matrix" style="--matrix-columns:${columns.length}">${header}${body}</div>` +
    '<p class="preview-note">Each cell will state an exact number read live over the whole record type. The numbers here count only the records in this preview.</p>';
}

// This module has no host/client reference. Its handlers only select a derivative view.
/**
 * The front page as a proposal shows it: every tile described by what it will
 * read, not drawn from numbers the preview does not have. A front-page tile's
 * number is a live read over the whole record type, and the clone carries a
 * bounded sample — so stating what each one will count is the only honest thing
 * to draw here, as it already is for a ring.
 */
// Exported so the front page's own sentences can be measured. They are what a person
// reads when a proposal adds a tile, and they were printing a default in place of the
// number the node carries.
export function overviewPreviewMarkup(overview: OverviewPlan): string {
  const entityName = (entityId: string | null): string =>
    overview.entities.find(entity => entity.semanticId === entityId)?.displayName ?? entityId ?? 'records';
  const fieldName = (entityId: string | null, fieldId: string): string =>
    overview.entities.find(entity => entity.semanticId === entityId)?.fields
      .find(field => field.semanticId === fieldId)?.displayName ?? fieldId;
  const describe = (node: SurfaceNodePlan): string => {
    const entityId = property(node, 'entityId');
    const title = property(node, 'title');
    switch (node.kind) {
      case 'summaryTile': {
        const aggregate = property(node, 'aggregate') ?? 'count';
        const fieldId = property(node, 'fieldId');
        return `${escape(title ?? aggregate)} — ${escape(aggregate)}${fieldId ? ` of ${escape(fieldName(entityId, fieldId))}` : ''} over ${escape(entityName(entityId))}`;
      }
      case 'breakdownChart':
        return `${escape(title ?? 'Breakdown')} — ${escape(entityName(entityId))} per ${escape(fieldName(entityId, property(node, 'groupByFieldId') ?? ''))}`;
      case 'progressTile':
        return `${escape(title ?? 'Progress')} — a ring over ${escape(entityName(entityId))}, both counts read live`;
      case 'rangeTile':
        return `${escape(title ?? 'Range')} — the smallest and largest ${escape(fieldName(entityId, property(node, 'fieldId') ?? ''))} of ${escape(entityName(entityId))}`;
      case 'recentList':
        return `${escape(title ?? 'Recent')} — up to ${limitOf(node, 10)} of ${escape(entityName(entityId))}`;
      case 'rankedList': {
        const direction = property(node, 'orderDirection') === 'ascending' ? 'smallest' : 'largest';
        return `${escape(title ?? 'Ranking')} — the top ${limitOf(node, 50)} of ${escape(entityName(entityId))} by ` +
          `${escape(fieldName(entityId, property(node, 'rankByFieldId') ?? ''))}, ${direction} first`;
      }
      // Without these two a section holding them lists no children at all, so a proposal
      // adding a trend and a grid was previewed as adding an empty heading.
      // Without these two a section holding them lists no children at all, so a proposal
      // adding a trend and a grid was previewed as adding an empty heading.
      case 'trendChart': {
        const aggregate = property(node, 'aggregate') ?? 'count';
        const fieldId = property(node, 'fieldId');
        return `${escape(title ?? 'Trend')} — ${escape(entityName(entityId))} per ` +
          `${property(node, 'bucket') === 'week' ? 'week' : 'month'} by ` +
          `${escape(fieldName(entityId, property(node, 'dateFieldId') ?? ''))}` +
          `${aggregate === 'count' || !fieldId ? '' : `, ${escape(aggregate)} of ${escape(fieldName(entityId, fieldId))}`}`;
      }
      case 'activityGrid':
        return `${escape(title ?? 'Activity')} — one square per day of ${escape(entityName(entityId))} by ` +
          `${escape(fieldName(entityId, property(node, 'dateFieldId') ?? ''))}`;
      default:
        return '';
    }
  };
  const walk = (nodes: SurfaceNodePlan[]): string => nodes.map(node => {
    if (node.kind === 'section')
      return `<li>${escape(property(node, 'title') ?? 'Section')}${property(node, 'opens') === 'closed' ? ' — starts closed' : ''}<ul>${walk(node.children)}</ul></li>`;
    if (node.kind === 'tabGroup') return walk(node.children);
    const described = describe(node);
    return described === '' ? '' : `<li>${described}</li>`;
  }).join('');
  const description = property(overview.surface, 'description');
  return `<section class="preview-overview"><h4>${escape(property(overview.surface, 'title') ?? 'Front page')}</h4>` +
    `${description === null ? '' : `<p class="preview-note">${escape(description)}</p>`}` +
    `<ul class="preview-overview-list">${walk(overview.surface.children)}</ul>` +
    '<p class="preview-note">The front page belongs to the file rather than to a record type. Every number here is read live against the whole record type it names when the proposal is accepted.</p></section>';
}

export function renderSurfacePreview(
  root: HTMLElement,
  plans: ApplicationPlan[],
  counts: Record<string, number> = {},
  overview: OverviewPlan | null = null,
): void {
  if (!plans.length && overview === null) { root.remove(); return; }
  if (!plans.length) {
    root.innerHTML = `<h3>Read-only screen preview</h3>${overviewPreviewMarkup(overview!)}`;
    return;
  }
  const overviewBlock = overview === null ? '' : overviewPreviewMarkup(overview);
  let entityIndex = 0;
  let selected = 0;
  let surfaceId = surfacesOf(plans[0])[0]?.id ?? '';
  const render = (): void => {
    const app = plans[entityIndex];
    root.innerHTML = `<h3>Read-only screen preview</h3>${overviewBlock}${surfacePreviewMarkup(app, surfaceId, selected, counts[app.entity.semanticId] ?? app.records.length, plans)}`;
    const entities = root.querySelector<HTMLSelectElement>('[data-preview-entity]')!;
    entities.innerHTML = plans.map((plan, index) => `<option value="${index}" ${index === entityIndex ? 'selected' : ''}>${escape(plan.entity.displayName)}</option>`).join('');
    entities.addEventListener('change', () => {
      entityIndex = Number(entities.value);
      selected = 0;
      surfaceId = surfacesOf(plans[entityIndex])[0]?.id ?? '';
      render();
    });
    root.querySelector<HTMLSelectElement>('[data-preview-selected]')?.addEventListener('change', event => { selected = Number((event.currentTarget as HTMLSelectElement).value); render(); });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-preview-surface]'))
      button.addEventListener('click', () => { surfaceId = button.dataset.previewSurface ?? surfaceId; render(); });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-preview-tab]'))
      button.addEventListener('click', () => {
        previewTabs.set(button.dataset.previewTabGroup!, button.dataset.previewTab!);
        render();
      });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-preview-record]'))
      button.addEventListener('click', () => {
        selected = Number(button.dataset.previewRecord);
        const detail = surfacesOf(app).find(candidate => candidate.kind === 'detailSurface' || candidate.kind === 'recordForm');
        if (detail) surfaceId = detail.id;
        render();
      });
  };
  render();
}
