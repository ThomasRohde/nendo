import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// The two grid kinds (ADR-0004, 2026-09-17 amendment, S6): the shape of a matrix, the
// two-clause drill out of one of its cells, and the arithmetic behind a ranking.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { cellDrillFilters, cellRead, cellValue, rankNumerals, rankProportion, rankValue } = await bundleOf('src/charts.ts');
const { addedSurfaceSentence, matrixViewOf } = await bundleOf('src/surface-model.ts');
const { rankedRead, rankedLimit, rankedWindowKey } = await bundleOf('src/overview-model.ts');

const node = (semanticId, kind, properties, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const clause = (id, fieldId, operator, value) => node(id, 'filterClause', value === undefined ? { fieldId, operator } : { fieldId, operator, value });
const status = { semanticId: 'status', displayName: 'Status', storageKind: 'text', presentation: 'singleChoice', options: ['open', 'doing', 'done'], choices: [] };
const priority = { semanticId: 'priority', displayName: 'Priority', storageKind: 'text', presentation: 'singleChoice', options: ['low', 'high'], choices: [] };
const blocked = { semanticId: 'blocked', displayName: 'Blocked', storageKind: 3, presentation: null, options: [], choices: [] };
const fields = [status, priority, blocked];

test('a matrix draws the lanes it can contain, on both axes', () => {
  const plain = node('grid', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'priority' });
  assert.deepEqual(matrixViewOf(plain, fields).rows, ['open', 'doing', 'done']);
  assert.deepEqual(matrixViewOf(plain, fields).columns, ['low', 'high']);

  // The board's rule, twice: a lane the surface's own clauses exclude spends a row or a
  // column of screen saying something false, and in two dimensions it says it twice.
  const narrowed = node('grid', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'priority' },
    [clause('c1', 'status', 'ne', 'done'), clause('c2', 'priority', 'eq', 'high')]);
  assert.deepEqual(matrixViewOf(narrowed, fields).rows, ['open', 'doing']);
  assert.deepEqual(matrixViewOf(narrowed, fields).columns, ['high']);

  // A comparison says nothing definite about which options remain, so every lane stays.
  const compared = node('grid', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'priority' },
    [clause('c3', 'status', 'isNotNull')]);
  assert.deepEqual(matrixViewOf(compared, fields).rows, ['open', 'doing', 'done']);

  // A Boolean axis is two lanes, written false then true: the order the host folds them in.
  const boolean = node('grid', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'blocked' });
  assert.deepEqual(matrixViewOf(boolean, fields).columns, ['false', 'true']);

  assert.equal(matrixViewOf(node('list', 'recordList', {}), fields), null);
  assert.equal(matrixViewOf(node('grid', 'matrixSurface', { rowByFieldId: 'status' }), fields), null);
});

test('a matrix reads one crossed aggregate and counts, whatever its size', () => {
  const grid = node('grid', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'priority' },
    [clause('c1', 'blocked', 'eq', false)]);
  const read = cellRead(grid, 'work');

  assert.equal(read.entityId, 'work');
  assert.equal(read.aggregate, 'count');
  assert.equal(read.fieldId, null, 'A cell states a count beside the cards it holds; there is no field to total.');
  assert.deepEqual(read.filters, [{ fieldId: 'blocked', operator: 'eq', value: false }]);

  // A field against itself is a diagonal with empty corners; the renderer never asks.
  assert.equal(cellRead(node('same', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'status' }), 'work'), null);
});

test('a cell drills with one predicate per axis, and an unset lane drills with isNull', () => {
  const grid = node('grid', 'matrixSurface', { rowByFieldId: 'status', columnByFieldId: 'priority' });

  assert.deepEqual(cellDrillFilters(grid, 'open', 'high'), [
    { fieldId: 'status', operator: 'eq', value: 'open' },
    { fieldId: 'priority', operator: 'eq', value: 'high' },
  ]);
  assert.deepEqual(cellDrillFilters(grid, null, 'high'), [
    { fieldId: 'status', operator: 'isNull' },
    { fieldId: 'priority', operator: 'eq', value: 'high' },
  ]);
  assert.deepEqual(cellDrillFilters(grid, null, null), [
    { fieldId: 'status', operator: 'isNull' },
    { fieldId: 'priority', operator: 'isNull' },
  ]);
});

test('a cell reads its own number out of the answer, including the empty ones', () => {
  const result = {
    rowKeys: ['open', 'done'],
    columnKeys: ['low'],
    cells: [
      { rowKey: 'open', columnKey: 'low', valueLexeme: '3', contributingRecords: 3 },
      { rowKey: 'open', columnKey: null, valueLexeme: '0', contributingRecords: 0 },
      { rowKey: 'done', columnKey: 'low', valueLexeme: '0', contributingRecords: 0 },
      { rowKey: null, columnKey: null, valueLexeme: '1', contributingRecords: 1 },
    ],
    unrecognised: 0,
    changeSequence: 9,
  };

  assert.equal(cellValue(result, 'open', 'low'), 3);
  assert.equal(cellValue(result, 'done', 'low'), 0, 'An empty cell states zero rather than nothing.');
  assert.equal(cellValue(result, null, null), 1);
  assert.equal(cellValue(result, 'missing', 'low'), null);
});

test('equal numbers share a rank numeral and the next numeral skips it', () => {
  assert.deepEqual(rankNumerals([9, 7, 7, 5]), [1, 2, 2, 4]);
  assert.deepEqual(rankNumerals([4, 4, 4]), [1, 1, 1]);
  assert.deepEqual(rankNumerals([]), []);
  assert.deepEqual(rankNumerals([3]), [1]);
});

test('a bar is a proportion of the largest, and nothing at all when a proportion would lie', () => {
  assert.equal(rankProportion(10, 10), 100);
  assert.equal(Math.round(rankProportion(5, 10)), 50);
  // A value at the bottom of a wide range still shows as something rather than vanishing.
  assert.equal(rankProportion(1, 1000), 2);

  assert.equal(rankProportion(0, 10), 0);
  assert.equal(rankProportion(-4, 10), 0, 'A negative number has no share of a positive one.');
  assert.equal(rankProportion(null, 10), 0);
  assert.equal(rankProportion(5, 0), 0, 'A proportion of a non-positive maximum is a drawing of nothing.');
  assert.equal(rankProportion(5, -2), 0);

  // Every exact number arrives in its envelope, which is where the value actually is.
  assert.equal(rankValue({ $nendoNumber: '4' }), 4);
  assert.equal(rankValue({ $nendoNumber: '12.50' }), 12.5);
  assert.equal(rankValue('12.50'), 12.5);
  assert.equal(rankValue(null), null);
  assert.equal(rankValue(''), null);
  assert.equal(rankValue('nope'), null);
});

test('a ranking reads its window in rank order, with the predicate the host adds', () => {
  const ranking = node('top', 'rankedList', { entityId: 'work', rankByFieldId: 'value', limit: 5 },
    [clause('c1', 'status', 'ne', 'done')]);
  const read = rankedRead(ranking);

  assert.equal(read.entityId, 'work');
  assert.equal(read.limit, 5);
  assert.equal(read.query.sortFieldId, 'value');
  assert.equal(read.query.descending, true, 'A leaderboard counts down unless the author says otherwise.');
  assert.deepEqual(read.query.filters, [
    { fieldId: 'status', operator: 'ne', value: 'done' },
    { fieldId: 'value', operator: 'isNotNull' },
  ]);

  const smallest = rankedRead(node('low', 'rankedList', { entityId: 'work', rankByFieldId: 'value', orderDirection: 'ascending' }));
  assert.equal(smallest.query.descending, undefined);
  assert.equal(smallest.limit, 50, 'Without a limit a ranking ranks the published ceiling.');
  assert.equal(rankedLimit(ranking), 5);

  // Two rankings differing only in how many rows they show are two different windows.
  assert.notEqual(rankedWindowKey(ranking),
    rankedWindowKey(node('top', 'rankedList', { entityId: 'work', rankByFieldId: 'value', limit: 10 })));

  assert.equal(rankedRead(node('bad', 'rankedList', { entityId: 'work' })), null);
});

test('accepting a proposal says where the screen it added went', () => {
  const before = new Set(['work-list', 'work-board']);
  const entities = [{ entityId: 'work', displayName: 'Work items' }, { entityId: 'note', displayName: 'Notes' }];
  const surfaces = [
    { nodeId: 'work-list', kind: 'recordList', title: 'All work', entityId: 'work' },
    { nodeId: 'work-board', kind: 'boardSurface', title: 'Roadmap', entityId: 'work' },
    { nodeId: 'work-grid', kind: 'matrixSurface', title: 'Horizon against status', entityId: 'work' },
  ];

  assert.equal(addedSurfaceSentence(before, surfaces, entities),
    'Horizon against status, under View in Work items, is new.');

  // Nothing added, nothing claimed.
  assert.equal(addedSurfaceSentence(new Set(surfaces.map((s) => s.nodeId)), surfaces, entities), '');

  // A record page, a form and a command are reached through a record, so pointing
  // somebody at the view picker for one would send them to the wrong place.
  assert.equal(addedSurfaceSentence(before, [...surfaces.slice(0, 2),
    { nodeId: 'work-page', kind: 'detailSurface', title: 'Work page', entityId: 'work' },
    { nodeId: 'work-done', kind: 'recordCommand', title: 'Complete', entityId: 'work' }], entities), '');

  // The front page is not behind a picker at all: Use opens on it.
  assert.equal(addedSurfaceSentence(before, [...surfaces.slice(0, 2),
    { nodeId: 'front', kind: 'overviewSurface', title: 'Front page', entityId: null }], entities),
    'This file has a front page now. Use opens on it.');

  const two = addedSurfaceSentence(before, [...surfaces,
    { nodeId: 'note-list', kind: 'recordList', title: 'All notes', entityId: 'note' }], entities);
  assert.match(two, /^2 new views: Horizon against status, All notes\./);
});
