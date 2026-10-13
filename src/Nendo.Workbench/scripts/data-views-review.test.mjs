import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// The broad review of 2026-10-10 on data views and markup (W-207): each case is one finding.
const charts = await bundleOf('src/charts.ts');
const { matrixViewOf } = await bundleOf('src/surface-model.ts');
const kit = await bundleOf('src/chart-kit.ts');
const { ratingMarkup, ratingControlMarkup } = await bundleOf('src/rating.ts');
const { fieldControlMarkup } = await bundleOf('src/record-markup.ts');
const { recentFileState } = await bundleOf('src/recent-files.ts');
const { tileLetters } = await bundleOf('src/type-icons.ts');
const { treeSurfaceCard, cardKindFor } = await bundleOf('src/surface-cards.ts');
const { surfacePreviewMarkup } = await bundleOf('src/surface-preview.ts');
const shared = await bundleOf('scripts/entries/plan-state.ts');
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const node = (semanticId, kind, properties, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const field = (semanticId, extra = {}) => ({ semanticId, displayName: semanticId[0].toUpperCase() + semanticId.slice(1), storageKind: 0, presentation: 'singleLine', required: false, options: [], choices: [], ...extra });

test('WDV-03: every drill clause uses an operator the record query accepts', () => {
  const accepted = [...source('../Nendo.Engine/RecordQuerySemantics.cs').match(/filter\.Operator is not \(([^)]*)\)/)[1].matchAll(/"(\w+)"/g)].map(([, op]) => op);
  assert.ok(accepted.includes('ge'), 'the accepted set was not read from RecordQuerySemantics.cs');
  const trend = node('t', 'trendChart', { dateFieldId: 'due', bucket: 'month' });
  const grid = node('m', 'matrixSurface', { rowByFieldId: 'urgent', columnByFieldId: 'status' });
  const clauses = [...charts.bucketDrillFilters(trend, 'month', '2026-02'), ...charts.cellDrillFilters(grid, 'true', null, [])];
  for (const clause of clauses) assert.ok(accepted.includes(clause.operator), `${clause.operator} is refused by the record query`);
});

test('WDV-04: a cell on a Boolean axis drills with the Boolean, and a Boolean clause narrows its lanes', () => {
  const urgent = field('urgent', { storageKind: 3, presentation: 'boolean' });
  const status = field('status', { presentation: 'singleChoice', options: ['open', 'done'] });
  const grid = node('m', 'matrixSurface', { rowByFieldId: 'urgent', columnByFieldId: 'status' });
  assert.deepEqual(charts.cellDrillFilters(grid, 'true', 'open', [urgent, status]), [
    { fieldId: 'urgent', operator: 'eq', value: true }, { fieldId: 'status', operator: 'eq', value: 'open' }]);
  const narrowed = node('m', 'matrixSurface', { rowByFieldId: 'urgent', columnByFieldId: 'status' }, [node('c', 'filterClause', { fieldId: 'urgent', operator: 'eq', value: true })]);
  assert.deepEqual(matrixViewOf(narrowed, [urgent, status]).rows, ['true'], 'a clause "urgent is true" still drew a No lane');
});

test('WDV-13: a rating outside its scale shows the number stored, digit for digit', () => {
  const huge = { $nendoNumber: '9223372036854775807' };
  assert.match(ratingMarkup(huge, { min: 1, max: 5 }), />9223372036854775807</);
  assert.match(ratingControlMarkup('confidence', 'Confidence', { min: 1, max: 5 }, huge, false), /Stored as 9223372036854775807,/);
});

test('WDV-15: totals of zero or less over real records are not called "No records"', () => {
  const segment = (key, lexeme, records) => ({ key, label: key, lexeme, amount: 0, style: '', records });
  const bar = kit.proportionBar({ key: 'k', title: 'Balance', context: '', status: { state: 'ready' }, segments: [segment('open', '-120.50', 3), segment('done', '-30', 2)], unrecognised: 0, tableOpen: false, drillable: false });
  assert.doesNotMatch(bar, /aria-label="No records"/);
  const empty = kit.proportionBar({ key: 'k', title: 'Balance', context: '', status: { state: 'ready' }, segments: [segment('open', null, 0)], unrecognised: 0, tableOpen: false, drillable: false });
  assert.match(empty, /aria-label="No records"/, 'a chart over no records says so');
});

test('WDV-16: a drillable activity grid is one Tab stop', () => {
  const days = Array.from({ length: 30 }, (_, index) => ({ key: `2026-09-${String(index + 1).padStart(2, '0')}`, label: `Day ${index + 1}`, lexeme: '1', level: 1 }));
  const grid = kit.activityGrid({ key: 'g', title: 'Activity', context: '', status: { state: 'ready' }, days, tableOpen: false, drillable: true });
  assert.equal((grid.match(/tabindex="0"/g) ?? []).length, 1);
  assert.equal((grid.match(/class="chart-day"/g) ?? []).length, 30);
});

test('WDV-20: tiles hidden by a drill are not read', () => {
  const list = node('list', 'recordList', { definitionVersion: 3, entityId: 'e', title: 'All' }, [node('tile', 'summaryTile', { aggregate: 'count', title: 'Count' })]);
  const plan = { entity: { semanticId: 'e', displayName: 'E', fields: [] }, records: [], surfaces: [list] };
  assert.ok(shared.visibleTiles(plan).length > 0, 'the fixture has no surface tile; the check measures nothing');
  shared.drills.set('e', { listId: 'list', label: 'Drilled', filters: [] });
  assert.deepEqual(shared.visibleTiles(plan), []);
  shared.drills.delete('e');
});

test('WMX-03: a stored line break survives its control', () => {
  const single = fieldControlMarkup(field('title'), 'line one\nline two');
  assert.match(single, /<textarea[^>]*>\nline one\nline two<\/textarea>/, 'a text value with a line break is edited where it keeps it');
  const long = fieldControlMarkup(field('notes', { presentation: 'longText' }), '\nSecond line');
  assert.match(long, /<textarea[^>]*>\n\nSecond line<\/textarea>/, 'the parser drops the first line break after <textarea>, so one is written for it');
});

test('WMX-04: a related row shows a choice\'s label and a reference\'s target, not their IDs', () => {
  shared.state.session.entities = [{ entityId: 'task', displayName: 'Task', fields: [
    { fieldId: 'status', displayName: 'Status', presentation: 'singleChoice', options: ['in_progress'], choices: [{ id: 'in_progress', displayName: 'In progress' }] },
    { fieldId: 'owner', displayName: 'Owner', presentation: 'reference', reference: { targetEntityId: 'person', labelFieldId: 'name' } }], derivedFields: [] }];
  const related = { recordId: 't1', recordVersion: 1, values: { status: 'in_progress', owner: 'person-7f3a' }, referenceLabels: { owner: 'Ada Lovelace' }, calculations: [] };
  assert.deepEqual(shared.relatedRowTexts(['status', 'owner'], related, []), ['In progress', 'Ada Lovelace']);
});

test('WMX-05: long unbroken values wrap in cards, rows and the pill; a chip is cut', () => {
  const css = (source('src/styles/09-surfaces.css') + source('src/styles/13-refinements-pages.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const selector of ['.record-card > strong', '.card-values > span', '.related-row', '.drill-pill']) {
    const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, selectors, body]) => selectors.split(',').map(part => part.trim()).includes(selector) && /overflow-wrap:\s*anywhere/.test(body));
    assert.ok(rule, `${selector} does not wrap a long value`);
  }
  const chip = css.slice(css.indexOf('.card-chip {'), css.indexOf('}', css.indexOf('.card-chip {')));
  assert.match(chip, /text-overflow:\s*ellipsis/);
});

test('WMX-15: a recent file that cannot open says why in words', () => {
  for (const state of ['missing', 'changed', 'unavailable']) {
    const said = recentFileState(state);
    assert.notEqual(said, state);
    assert.ok(said.split(' ').length > 2, `${state} says only ${said}`);
  }
});

test('WMX-16: a glyph never cuts a character in half', () => {
  assert.ok(tileLetters('𠮷野家 orders').isWellFormed(), tileLetters('𠮷野家 orders'));
  assert.match(source('src/view-structure.ts'), /Array\.from\(entity\.displayName\)/, 'Structure\'s initial is taken by code unit');
});

test('WMX-17: a matrix screen is described as a matrix, by its fields', () => {
  const plan = { entity: { semanticId: 'e', displayName: 'Task', fields: [field('urgent'), field('status')] }, records: [], surfaces: [] };
  const card = treeSurfaceCard(plan, node('m', 'matrixSurface', { definitionVersion: 3, entityId: 'e', title: 'Grid', rowByFieldId: 'urgent', columnByFieldId: 'status' }));
  assert.doesNotMatch(card, /matrixSurface/);
  assert.match(card, /Matrix/);
  assert.equal(cardKindFor('matrixSurface'), 'Matrix');
});

test('WMX-18 and WDV-19: the proposal preview names its bindings and draws a Boolean matrix', () => {
  const urgent = field('urgent', { storageKind: 3, presentation: 'boolean' });
  const status = field('status', { presentation: 'singleChoice', options: ['open'], choices: [{ id: 'open', displayName: 'Open' }] });
  const task = { entity: { semanticId: 'task', displayName: 'Task', fields: [field('title')] }, records: [], surfaces: [] };
  const app = { entity: { semanticId: 'e', displayName: 'Project', fields: [field('title'), urgent, status],
    derivedFields: [{ semanticId: 'daysOpen', displayName: 'Days open', fieldId: 'daysOpen' }] },
    records: [{ semanticId: 'r', version: 1, values: { title: 'P', urgent: true, status: 'open' }, calculations: {} }],
    surfaces: [
      node('page', 'detailSurface', { definitionVersion: 3, entityId: 'e', title: 'Page' }, [node('b1', 'fieldBinding', { fieldId: 'daysOpen' }),
        node('rel', 'relatedList', { title: 'Tasks', targetEntityId: 'task', referenceFieldId: 'project' }, [node('b2', 'fieldBinding', { fieldId: 'title' })])]),
      node('grid', 'matrixSurface', { definitionVersion: 3, entityId: 'e', title: 'Grid', rowByFieldId: 'urgent', columnByFieldId: 'status' }, [node('b3', 'fieldBinding', { fieldId: 'title' })]),
    ] };
  const page = surfacePreviewMarkup(app, 'page', 0, 1, [task]);
  assert.doesNotMatch(page, />daysOpen</, 'a calculated binding is labelled by its ID');
  assert.match(page, /Days open/);
  assert.match(page, /Shows Task records/);
  const grid = surfacePreviewMarkup(app, 'grid', 0, 1, [task]);
  assert.equal((grid.match(/matrix-row-heading/g) ?? []).length, 2, 'a Boolean axis drew no lanes');
  assert.match(grid, />Yes</);
});

const { defaultColumnWidth, editorValues, gridCellEditor, gridEditUnchanged } = await bundleOf('src/grid-edit-model.ts');
const { withLocalOffset } = await bundleOf('src/format.ts');
const markup = await bundleOf('src/record-markup.ts');

test('WDV-02: a grid select editor always offers the cell\'s own value, and an unchanged edit writes nothing', () => {
  assert.deepEqual(editorValues(['', 'open', 'done'], 'legacy'), ['', 'open', 'done', 'legacy'], 'a retired choice is not offered, so the editor falls to the first one');
  assert.deepEqual(editorValues(['', '1', '2', '3', '4', '5'], { $nendoNumber: '9' }), ['', '1', '2', '3', '4', '5', '9'], 'a rating outside the scale is not offered');
  assert.deepEqual(editorValues(['', 'open'], null), ['', 'open']);
  assert.equal(gridEditUnchanged(null, null), true, 'null over null is written');
  assert.equal(gridEditUnchanged(null, ''), true);
  assert.equal(gridEditUnchanged('9', { $nendoNumber: '9' }), true);
  assert.equal(gridEditUnchanged('open', 'done'), false);
  const view = source('src/view-data.ts');
  assert.equal((view.match(/editorValues\(/g) ?? []).length, 2, 'the choice and rating editors do not offer the cell\'s own value');
  assert.match(view, /if \(gridEditUnchanged\(value, event\.oldValue\)\) \{/, 'commitGridEdit writes an unchanged value');
});

test('W-217 R2LAT-12: a Date field is edited with the date editor and sized as a date, with or without the date presentation', () => {
  const held = { fieldId: 'held', displayName: 'Held on', storageKind: 4, required: false, presentation: null, options: [] };
  assert.equal(gridCellEditor(held), 'agDateStringCellEditor', 'a Date field without a presentation got free text');
  assert.equal(gridCellEditor({ ...held, storageKind: 'date' }), 'agDateStringCellEditor');
  assert.equal(gridCellEditor({ ...held, presentation: 'date' }), 'agDateStringCellEditor');
  assert.equal(defaultColumnWidth(held), defaultColumnWidth({ ...held, presentation: 'date' }));
  assert.equal(gridCellEditor({ ...held, storageKind: 0 }), 'agTextCellEditor');
  assert.equal(gridCellEditor({ ...held, storageKind: 5 }), 'agTextCellEditor', 'a date and time is edited as text, as the contract says');
  assert.equal(gridCellEditor({ ...held, storageKind: 3 }), 'agSelectCellEditor');
  assert.equal(gridCellEditor({ ...held, storageKind: 0, presentation: 'longText' }), 'agLargeTextCellEditor');
  assert.match(source('src/view-data.ts'), /cellEditor: gridCellEditor\(field\),/, 'the grid chooses its editor somewhere else');
});

test('WDV-09: Studio\'s outline asks for the moves of the hierarchy it shows', () => {
  const view = source('src/view-data.ts');
  assert.equal((view.match(/moveTarget\(outline, outlineFocus, [^)]*, entity\.hierarchy\?\.orderFieldId != null\)/g) ?? []).length, 2,
    'a hierarchy with no order field is offered Move up, Move down and an ordered outdent');
});

test('WDV-18: a date-time reads and is typed in local time, and is saved as the same instant', () => {
  const stored = '2026-10-10T06:30:00Z';
  const local = markup.localDateTimeInput(stored);
  assert.match(local, /^2026-10-1\dT\d\d:30:00$/);
  assert.equal(new Date(withLocalOffset(local)).toISOString(), '2026-10-10T06:30:00.000Z', 'the instant moved on the way through the form');
  assert.match(withLocalOffset(local), /[+-]\d\d:\d\d$/, 'a saved value carries its offset');
  const control = markup.fieldControlMarkup(field('due', { storageKind: 5, presentation: null }), stored);
  assert.match(control, /type="datetime-local"/);
});

test('WDV-22: a field revealed in a closed tab opens it with the record', () => {
  const form = source('src/record-form.ts');
  assert.match(form, /activateTab\(plan, record, panel\.dataset\.tabGroup!/);
  assert.equal((form.match(/revealField\(page, [^)]*, record\)/g) ?? []).length, 2);
});

test('WDV-14: a calendar or timeline that could not read during a save reads once it is done', () => {
  // The preview host cannot read a calendar or a timeline (typed filtering), so no browser lane
  // measures this; the retry itself is what is held here.
  const use = source('src/view-use.ts');
  assert.match(use, /if \(state\.actionInFlight\) \{ retryAfterSave\(calendarKeyFor\(node\), surfaceId, reload\); return; \}/, 'the calendar gives up for good when a save is running');
  assert.match(use, /if \(state\.actionInFlight && !append\) \{ retryAfterSave\(timelineKeyFor\(node\), surfaceId, \(\) => read\(false\)\); return; \}/, 'the timeline gives up for good when a save is running');
  assert.match(use, /if \(waitingRetries\.has\(key\)\) return;/, 'every redraw during a save starts another retry');
});

test('WDV-18: a date-time left as shown is the stored value, not a new spelling of it', () => {
  const stored = '2026-10-10T06:30:00.250Z';
  assert.equal(markup.dateTimeFormValue(markup.localDateTimeInput(stored), stored), stored, 'an untouched date-time is written back as another lexeme');
  assert.notEqual(markup.dateTimeFormValue('2026-10-10T09:15:00', stored), stored);
  assert.equal(markup.dateTimeFormValue('', stored), null);
});
