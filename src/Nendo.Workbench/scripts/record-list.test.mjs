import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// F-225: a Use list drew its first field and the next two, and dropped every later binding
// without a word; Archi's On views count, bound fourth, never appeared. Rendered through the
// function the app draws a list with.
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

// Review R-013: a row that opens a record is a native button inside a list item, so a screen
// reader hears a button with the record's name, not a list item it cannot tell is actionable.
const { galleryMarkup } = await bundleOf('src/surface-markup.ts');
const { readFile, readdir } = await import('node:fs/promises');

function actionableRows(html) {
  // Each list item and what it holds, in order; a button carries no role of its own.
  const items = [...html.matchAll(/<div role="listitem" class="record-row">(<button\b[^>]*>)/g)].map(match => match[1]);
  const buttons = [...html.matchAll(/<button\b[^>]*data-record-id="[^"]*"[^>]*>/g)].map(match => match[0]);
  return { items, buttons };
}

test('R-013: every record row in a list or a gallery is a button inside a list item', () => {
  const list = node('l', 'recordList', { entityId: 'concept' });
  for (const [name, html] of [['list', listMarkup(planOf(list), list)], ['gallery', galleryMarkup(planOf(node('g', 'gallerySurface', { entityId: 'concept' })), node('g', 'gallerySurface', { entityId: 'concept' }))]]) {
    const { items, buttons } = actionableRows(html);
    assert.equal(buttons.length, records.length, `${name}: one button per record`);
    assert.deepEqual(items, buttons, `${name}: each record button must sit directly in a list item`);
    for (const button of buttons) assert.doesNotMatch(button, /\brole=/, `${name}: a record button must keep its own role: ${button}`);
    assert.match(html, /role="list"/, `${name}: the items sit in a list`);
  }
});

test('R-013: no markup in the Workbench gives a button the role of a list item', async () => {
  const folder = new URL('../src/', import.meta.url);
  const offenders = [];
  for (const name of (await readdir(folder)).filter(file => file.endsWith('.ts'))) {
    const text = await readFile(new URL(name, folder), 'utf8');
    for (const match of text.matchAll(/<button\b[^>`]*role="listitem"/g)) offenders.push(`${name}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});
