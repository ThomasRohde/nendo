import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// F-225: a Use list drew its first field and the next two, and dropped every later binding
// without a word; Archi's On views count, bound fourth, never appeared. Rendered through the
// function the app draws a list with.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { listMarkup } = await bundleOf('src/surface-markup.ts');

const node = (semanticId, kind, properties, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const text = (semanticId, displayName) => ({ semanticId, displayName, storageKind: 'text', presentation: 'singleLine', options: [], choices: [] });
const fields = [text('name', 'Name'), text('type', 'Type'), text('folder', 'Folder'), text('layer', 'Layer')];
const derived = [{ semanticId: 'uses', automationTarget: 'uses', displayName: 'On views', resultType: 'Integer', resultNullable: false, calculationId: 'c.uses', expression: 'n' }];
const record = (semanticId, values, uses) => ({ semanticId, version: 1, values, calculations: { uses: { calculationId: 'c.uses', fieldId: 'uses', state: 'value', resultType: 'Integer', value: uses } } });
const records = [record('a', { name: 'Accept', type: 'Process', folder: 'Processes', layer: 'Business' }, 3),
  record('b', { name: 'Admin Server', type: 'Device', folder: 'Technology', layer: 'Technology' }, 0)];
const planOf = surface => ({ entity: { semanticId: 'concept', displayName: 'Concept', fields, derivedFields: derived }, records, surfaces: [surface] });
const cells = (html, selector) => [...html.matchAll(new RegExp(`<${selector}[^>]*>(.*?)</${selector.split(' ')[0]}>`, 'g'))].map(match => match[1]);
const rows = html => html.split('role="listitem"').slice(1);

test('a list draws every field it binds, a calculated one fourth included, under a head that names each', () => {
  const list = node('l', 'recordList', { entityId: 'concept' }, ['name', 'type', 'folder', 'uses', 'layer'].map(id => node(`l.${id}`, 'fieldBinding', { fieldId: id })));
  const html = listMarkup(planOf(list), list);
  const head = html.slice(html.indexOf('record-list-head'), html.indexOf('role="listitem"'));
  assert.deepEqual([...cells(head, 'strong'), ...cells(head, 'span')], ['Name', 'Type', 'Folder', 'On views', 'Layer'], head);
  const first = rows(html)[0];
  assert.deepEqual(cells(first, 'strong'), ['Accept']);
  const values = cells(first, 'span').map(cell => cell.replace(/<[^>]+>/g, ''));
  assert.equal(values.length, 4, first);
  assert.deepEqual(values.slice(0, 2), ['Process', 'Processes']);
  assert.ok(values[2].includes('3'), `The fourth column is not the count: ${values[2]}`);
  assert.equal(values[3], 'Business');
});

test('a list that declares no fields shows its record type’s first three, not all of them', () => {
  const list = node('l', 'recordList', { entityId: 'concept' });
  const html = listMarkup(planOf(list), list);
  assert.equal(cells(rows(html)[0], 'span').length, 2);
  const head = html.slice(html.indexOf('record-list-head'), html.indexOf('role="listitem"'));
  assert.deepEqual(cells(head, 'span'), ['Type', 'Folder']);
});
