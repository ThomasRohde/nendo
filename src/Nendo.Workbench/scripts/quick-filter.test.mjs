import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { bundleOf } from './bundle-of.mjs';

// W-172 (ADR-0004 2026-10-05): a person narrows a list, board or matrix by one value of one
// single-choice or reference field. The pick adds one clause to the screen's own and is held
// for the file session only.
const model = await bundleOf('src/quick-filter-model.ts');

// The pick and the query it opens live in two modules that share app-state, so they are
// bundled together: two bundles would each hold their own state.
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = [
  `export { effectiveSurfaceQuery, narrowed, quickClauses } from ${JSON.stringify(resolve(root, 'src/plan-selection.ts'))};`,
  `export { quickFilters, drills } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'quick-filter-entry', enforce: 'pre',
    resolveId(id) { return id.endsWith('quick-filter-entry') ? '\0quick-filter-entry' : null; },
    load(id) { return id === '\0quick-filter-entry' ? entry : null; },
  }],
  build: { ssr: 'quick-filter-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const selection = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

const field = (semanticId, presentation, extra = {}) => ({ semanticId, automationTarget: semanticId, displayName: semanticId[0].toUpperCase() + semanticId.slice(1), presentation, retired: false, required: false, storageKind: 'text', options: [], choices: [], ...extra });
const status = field('status', 'singleChoice', { options: ['open', 'done'], choices: [{ id: 'open', displayName: 'Open', retired: false }, { id: 'done', displayName: 'Done', retired: false }] });
const debate = field('debate', null, { storageKind: 'reference', reference: { targetEntityId: 'debates', labelFieldId: 'title' } });
const unbound = field('owner', null, { storageKind: 'reference', reference: null });
const fields = [field('title', 'singleLine'), status, debate, unbound, field('notes', 'longText')];
const node = (semanticId, kind, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties: {}, children });
const clause = (index) => node(`c${index}`, 'filterClause', []);
const withClauses = (surface, count) => ({ ...surface, children: Array.from({ length: count }, (_, index) => ({ ...clause(index), properties: { fieldId: 'status', operator: 'ne', value: `x${index}` } })) });

test('the fields a screen can be narrowed by are its single choices and bound references', () => {
  assert.deepEqual(model.quickFilterFields(fields).map(value => value.semanticId), ['status', 'debate']);
  assert.ok(model.offersQuickFilter(node('board', 'boardSurface'), fields));
  assert.ok(model.offersQuickFilter(node('list', 'recordList'), fields));
  assert.ok(model.offersQuickFilter(node('grid', 'matrixSurface'), fields));
  assert.ok(!model.offersQuickFilter(node('cal', 'calendarSurface'), fields), 'only a list, board or matrix');
  assert.ok(!model.offersQuickFilter(node('list', 'recordList'), [field('title', 'singleLine')]), 'nothing to narrow by');
  // A screen whose own clauses already spend the budget of eight offers none rather than one that is refused.
  assert.ok(model.offersQuickFilter(withClauses(node('list', 'recordList'), 7), fields));
  assert.ok(!model.offersQuickFilter(withClauses(node('list', 'recordList'), 8), fields));
});

test('a pick is one clause, eq on its value or isNull for Not set', () => {
  const pick = model.quickFilterFor(status, 'v:done', undefined);
  assert.deepEqual(pick, { fieldId: 'status', value: 'done', label: 'Status: Done' });
  assert.deepEqual(model.quickFilterClause(pick), { fieldId: 'status', operator: 'eq', value: 'done' });
  const none = model.quickFilterFor(debate, model.notSetValue, undefined);
  assert.deepEqual(model.quickFilterClause(none), { fieldId: 'debate', operator: 'isNull' });
  assert.equal(none.label, 'Debate: Not set');
  const targets = { state: 'ready', items: [{ recordId: 'd1', label: 'Should we ship?' }] };
  assert.equal(model.quickFilterFor(debate, 'v:d1', targets).label, 'Debate: Should we ship?');
  assert.equal(model.quickFilterFor(status, '', undefined), null, 'Any asks for every record again');
});

test('R-012: a stored value spelled like Any or Not set is still that value', () => {
  // Any legal choice ID or record ID, the old sentinel and the new words among them.
  const tricky = ['__nendo_not_set__', 'none', 'v:x', ''].filter(Boolean);
  const odd = field('status', 'singleChoice', { options: tricky, choices: tricky.map(id => ({ id, displayName: `Label ${id}`, retired: false })) });
  const ref = field('debate', null, { storageKind: 'reference', reference: { targetEntityId: 'debates', labelFieldId: 'title' } });
  const targets = { state: 'ready', items: tricky.map(recordId => ({ recordId, label: `Record ${recordId}` })) };
  for (const subject of [odd, ref]) {
    const markup = model.quickFilterMenuMarkup([subject], undefined, () => targets, true, '');
    const values = [...markup.matchAll(/<option value="([^"]*)"/g)].map(match => match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(new Set(values).size, values.length, `Two options of ${subject.semanticId} share a value: ${JSON.stringify(values)}`);
    for (const id of tricky) {
      const option = values.find(value => value !== '' && value !== model.notSetValue && model.quickFilterFor(subject, value, targets)?.value === id);
      assert.ok(option !== undefined, `No option of ${subject.semanticId} picks the stored value ${id}: ${JSON.stringify(values)}`);
      assert.deepEqual(model.quickFilterClause(model.quickFilterFor(subject, option, targets)), { fieldId: subject.semanticId, operator: 'eq', value: id },
        `The stored value ${id} was asked for as another clause.`);
    }
    assert.deepEqual(model.quickFilterClause(model.quickFilterFor(subject, model.notSetValue, targets)), { fieldId: subject.semanticId, operator: 'isNull' });
    // The pill's pick selects its own option when the menu is drawn again.
    const reopened = model.quickFilterMenuMarkup([subject], { fieldId: subject.semanticId, value: '__nendo_not_set__', label: 'x' }, () => targets, true, '');
    assert.match(reopened, /<option value="v:__nendo_not_set__" selected>/);
    assert.doesNotMatch(reopened, /<option value="none" selected>/);
  }
});

test('the menu lists choices at once and a reference once its targets are read', () => {
  const pick = { fieldId: 'status', value: 'done', label: 'Status: Done' };
  const reading = model.quickFilterMenuMarkup(fields, pick, () => ({ state: 'loading' }), false, '');
  assert.match(reading, /<select data-quick-filter="status"><option value="">Any<\/option><option value="v:open">Open<\/option><option value="v:done" selected>Done<\/option>/);
  assert.match(reading, /<select data-quick-filter="debate" disabled><option value="" selected>Any<\/option><option disabled>Reading…<\/option><\/select>/);
  assert.match(reading, /<option value="none">Not set<\/option>/);
  assert.match(reading, /Filter \(1\)/);
  const ready = model.quickFilterMenuMarkup(fields, undefined, () => ({ state: 'ready', items: [{ recordId: 'd1', label: '<b>Ship</b>' }] }), true, '');
  assert.match(ready, /<details class="quick-filter" data-testid="quick-filter" open>/);
  assert.match(ready, /<option value="v:d1">&lt;b&gt;Ship&lt;\/b&gt;<\/option>/);
  const many = model.quickFilterMenuMarkup(fields, undefined, () => ({ state: 'overflowing', ceiling: 100 }), false, '');
  assert.match(many, /More than 100 to list/);
});

test('a pick composes with the screen\'s own clauses, and a drill still replaces them', () => {
  const list = withClauses(node('list', 'recordList'), 1);
  selection.quickFilters.clear();
  selection.drills.clear();
  assert.deepEqual(selection.effectiveSurfaceQuery('issues', list).filters, [{ fieldId: 'status', operator: 'ne', value: 'x0' }]);
  selection.quickFilters.set('list', { fieldId: 'debate', value: 'd1', label: 'Debate: d1' });
  assert.deepEqual(selection.effectiveSurfaceQuery('issues', list).filters,
    [{ fieldId: 'status', operator: 'ne', value: 'x0' }, { fieldId: 'debate', operator: 'eq', value: 'd1' }]);
  // Another screen of the same record type is not narrowed by this one's pick.
  assert.deepEqual(selection.quickClauses(node('board', 'boardSurface')), []);
  const plan = { entity: { semanticId: 'issues', fields, derivedFields: [] }, records: [], surfaces: [list] };
  assert.ok(selection.narrowed(plan, list), 'the screen\'s own tiles step aside while it is narrowed');
  selection.drills.set('issues', { listId: 'list', label: 'Open', filters: [{ fieldId: 'status', operator: 'eq', value: 'open' }] });
  assert.deepEqual(selection.effectiveSurfaceQuery('issues', list).filters, [{ fieldId: 'status', operator: 'eq', value: 'open' }]);
  selection.quickFilters.clear();
  selection.drills.clear();
});
