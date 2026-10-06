import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyExcerpt, createFinder, excerptNodes, localMatch } from '../../extensions/garden/search.mjs';

const BODY = 'gd.note.body';
const note = { title: 'Kitchen garden', slug: 'kitchen-garden', values: { [BODY]: 'Beans and leeks, and a café by the shed.' } };

test('local matching reads the title, the slug and the body, every word, folded', () => {
  assert.equal(localMatch(note, 'kitchen', BODY), true);
  assert.equal(localMatch(note, 'leeks shed', BODY), true, 'two body words');
  assert.equal(localMatch(note, 'cafe', BODY), true, 'an accent is folded');
  assert.equal(localMatch(note, 'garden -leeks', BODY), false, 'a left-out word that is there');
  assert.equal(localMatch(note, '"by the shed"', BODY), true, 'a phrase is its words here');
  assert.equal(localMatch(note, 'roses', BODY), false);
  assert.equal(localMatch(note, ' - ', BODY), true, 'no words matches everything, as an empty Find does');
});

test('the finder answers only the latest text, and stands aside when the index cannot answer', async () => {
  const calls = [];
  const results = [];
  const nendo = {
    has: name => name === 'records.search',
    records: {
      async search(text, options) {
        calls.push({ text, options });
        if (text === 'missing') throw Object.assign(new Error('No index.'), { code: 'search-index-missing' });
        return { items: [{ entityId: 'gd.note', recordId: `hit-${text}`, version: 1, label: null, score: 1, fields: [] }], nextCursor: null, changeSequence: 1 };
      },
    },
  };
  const finder = createFinder(nendo, { entityId: 'gd.note', pauseMs: 5, onResult: (hits, text, source) => results.push({ hits: hits && [...hits.keys()], text, source }) });
  finder.find('ga');
  finder.find('gard');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls.map(call => call.text), ['gard'], 'a pause in typing sends one search, of the latest text');
  assert.deepEqual(calls[0].options.entityIds, ['gd.note']);
  assert.deepEqual(results.at(-1), { hits: ['hit-gard'], text: 'gard', source: 'index' });
  finder.find('missing');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(results.at(-1), { hits: null, text: 'missing', source: 'search-index-missing' });
  finder.find('   ');
  assert.deepEqual(results.at(-1), { hits: null, text: '', source: 'empty' });

  const older = [];
  const plain = createFinder({ has: () => false }, { entityId: 'gd.note', onResult: (hits, text, source) => older.push(source) });
  plain.find('anything');
  assert.deepEqual(older, ['unavailable'], 'an older Nendo leaves Find to the view at once');
});

test('an excerpt becomes text and marks, never markup', () => {
  const made = [];
  const document = {
    createTextNode: text => ({ text }),
    createElement: name => { const element = { name, textContent: '' }; made.push(element); return element; },
  };
  const nodes = excerptNodes(document, { snippet: '<b>beans</b> and leeks', ranges: [{ start: 3, length: 5 }, { start: 17, length: 5 }, { start: 40, length: 2 }] });
  assert.deepEqual(nodes.map(node => node.text ?? `[${node.textContent}]`), ['<b>', '[beans]', '</b> and ', '[leeks]']);
  assert.equal(made.every(element => element.name === 'mark'), true);
  assert.deepEqual(bodyExcerpt({ fields: [{ fieldId: 'gd.note.title', snippet: 'x', ranges: [] }, { fieldId: BODY, snippet: 'y', ranges: [] }] }, 'gd.note.title'),
    { fieldId: BODY, snippet: 'y', ranges: [] });
  assert.equal(bodyExcerpt({ fields: [{ fieldId: 'gd.note.title', snippet: 'x', ranges: [] }] }, 'gd.note.title'), null, 'a title match shows no excerpt');
});
