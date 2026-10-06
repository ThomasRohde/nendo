import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// Search on the Workbench side (ADR-0028): the syntax the preview host matches, which mirrors the
// Engine's, and the highlighting that turns a plain-text excerpt into markup without trusting it.
const search = await bundleOf('src/search-text.ts');

const session = {
  manifest: { changeSequence: 7 },
  entities: [
    { entityId: 'notes', displayName: 'Notes', fields: [
      { fieldId: 'title', displayName: 'Title', storageKind: 'Text', required: false, presentation: null, options: [] },
      { fieldId: 'body', displayName: 'Body', storageKind: 'Text', required: false, presentation: 'longText', options: [] },
      { fieldId: 'stage', displayName: 'Stage', storageKind: 'Text', required: false, presentation: null, options: [], choices: [{ id: 'garden', displayName: 'Garden', retired: false }] },
    ] },
    { entityId: 'old', displayName: 'Old', retired: true, fields: [
      { fieldId: 'old-title', displayName: 'Title', storageKind: 'Text', required: false, presentation: null, options: [] },
    ] },
  ],
  records: [
    { entityId: 'notes', recordId: 'n1', recordVersion: 1, values: { title: 'Kitchen garden', body: 'Beans and leeks.', stage: 'garden' } },
    { entityId: 'notes', recordId: 'n2', recordVersion: 3, values: { title: 'Wildflower meadow', body: 'A corner of the garden left wild, to bring pollinators back.' } },
    { entityId: 'notes', recordId: 'n3', recordVersion: 1, values: { title: 'Café visits', body: null } },
    { entityId: 'old', recordId: 'o1', recordVersion: 1, values: { 'old-title': 'An old garden' } },
  ],
};

const ids = (page) => page.items.map((hit) => hit.recordId);

test('words match across fields, a left-out word removes a record, and the last word is a prefix', () => {
  assert.deepEqual(ids(search.previewSearch(session, { text: 'wildflower pollinators' })), ['n2']);
  assert.deepEqual(ids(search.previewSearch(session, { text: 'garden -pollinators' })), ['n1']);
  assert.deepEqual(ids(search.previewSearch(session, { text: 'gard' })).sort(), ['n1', 'n2']);
  assert.deepEqual(ids(search.previewSearch(session, { text: 'gard ' })), [], 'a word followed by a space is whole');
  assert.deepEqual(ids(search.previewSearch(session, { text: '"bring pollinators"' })), ['n2']);
  assert.deepEqual(ids(search.previewSearch(session, { text: 'cafe' })), ['n3'], 'an accent is folded');
  assert.deepEqual(ids(search.previewSearch(session, { text: '* ( -' })), [], 'no words, no records');
});

test('a choice and a retired record type are not searched, and the title match ranks first', () => {
  const page = search.previewSearch(session, { text: 'garden' });
  assert.deepEqual(ids(page), ['n1', 'n2'], 'a choice ID or a retired type was searched, or the order is wrong');
  assert.equal(page.items[0].label, 'Kitchen garden');
  assert.equal(page.changeSequence, 7);
  const title = page.items[0].fields.find((field) => field.fieldId === 'title');
  assert.deepEqual(title.ranges, [{ start: 8, length: 6 }]);
});

test('paging and scope', () => {
  const first = search.previewSearch(session, { text: 'garden', limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor, '1');
  assert.deepEqual(ids(search.previewSearch(session, { text: 'garden', limit: 1, cursor: first.nextCursor })), ['n2']);
  assert.deepEqual(ids(search.previewSearch(session, { text: 'garden', fieldIds: ['body'] })), ['n2']);
  assert.deepEqual(ids(search.previewSearch(session, { text: 'garden', entityIds: ['nope'] })), []);
});

test('an excerpt is escaped and only its matched ranges are marked', () => {
  assert.equal(search.highlightedSnippet('<b>garden</b> & co', [{ start: 3, length: 6 }]), '&#60;b&#62;<mark>garden</mark>&#60;/b&#62; &#38; co');
  assert.equal(search.highlightedSnippet('abc', [{ start: 2, length: 5 }]), 'abc', 'a range past the end is ignored');
  assert.equal(search.highlightedSnippet('abcdef', [{ start: 3, length: 2 }, { start: 0, length: 1 }]), '<mark>a</mark>bc<mark>de</mark>f');
});
