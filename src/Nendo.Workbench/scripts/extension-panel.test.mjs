import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// A custom view on a record page (ADR-0013, 2026-09-24; W-061), rendered by the function the
// page is rendered with. The page draws a placeholder at the authored position; nothing in
// it starts a view, and a record not yet saved has nothing for a view to be scoped to.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { pageFormBody } = await bundleOf('src/page-markup.ts');

const field = (id, name) => ({ semanticId: id, displayName: name, storageKind: 'text', required: false, options: [] });
const node = (id, kind, properties, children = []) => ({ semanticId: id, automationTarget: id, kind, properties, children });
const panel = node('schedule', 'extensionRecordPanel', { title: 'Schedule <b>', packageId: 'org.nendo.gantt', packageVersion: '0.1.0' });
const plan = {
  contractVersion: 3,
  entity: { semanticId: 'tasks', displayName: 'Task', fields: [field('title', 'Title'), field('owner', 'Owner')] },
  records: [],
  surfaces: [node('page', 'detailSurface', { entityId: 'tasks' }, [
    node('page-title', 'fieldBinding', { fieldId: 'title' }),
    panel,
    node('page-owner', 'fieldBinding', { fieldId: 'owner' }),
  ])],
};
const record = { semanticId: 't1', version: 3, values: { title: 'Task one', owner: 'Ada' } };

test('the placeholder sits where it was authored, for this record, and runs nothing', () => {
  const markup = pageFormBody(plan, record, true);
  const at = markup.indexOf('data-extension-panel="schedule"');
  assert.ok(at > 0, markup);
  assert.ok(markup.indexOf('name="title"') < at && at < markup.indexOf('name="owner"'), 'The view is not between the two fields it was authored between.');
  assert.match(markup, /data-record="t1"/);
  // The title is text, never markup.
  assert.ok(!markup.includes('Schedule <b>'), markup);
  assert.match(markup, /Schedule &lt;b&gt;/);
  // One next step, disabled until the host has said what it is, and Stop hidden until a view runs.
  assert.match(markup, /<button type="button" class="primary-button" data-panel-next disabled>Show view<\/button>/);
  assert.match(markup, /<button type="button" class="secondary-button" data-panel-stop hidden>Stop view<\/button>/);
  assert.match(markup, /data-panel-viewport hidden/);
});

test('a record not yet saved says why there is no view', () => {
  const markup = pageFormBody(plan, record, false);
  assert.ok(!markup.includes('data-extension-panel="'), markup);
  assert.match(markup, /Save this record to show its custom view\./);
  assert.ok(!/<button[^>]*data-panel-next/.test(markup), 'A record without an ID was offered a view it could not start.');
});
