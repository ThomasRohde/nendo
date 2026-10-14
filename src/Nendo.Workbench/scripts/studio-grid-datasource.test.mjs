import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/studio-grid-datasource.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { studioDatasource } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
const page = (start, count = 100, more = true) => ({ start, items: Array.from({ length: count }, (_, i) => ({ recordId: `r-${start + i}`, recordVersion: 1, values: {} })), hasMore: more, changeSequence: 7, queryToken: 'query-7', locatedIndex: null });
const get = (source, start) => new Promise(resolve => source.getRows({ startRow: start, endRow: start + 100, successCallback: (rows, last) => resolve({ rows, last }), failCallback: () => resolve({ failed: true }) }));
const options = request => ({ entityId: 'items', query: { filters: [{ fieldId: 'status', operator: 'eq', value: 'Open' }], sortFieldId: 'name', descending: true }, sequence: 7, request, current: () => true, row: row => row, loaded() {}, failed() {} });

test('distant blocks use the same query and token without walking intervening pages', async () => {
  const calls = [];
  const config = options(async request => { calls.push(request); return page(request.start); });
  const source = studioDatasource(config);
  config.query.filters[0].value = 'Changed after opening';
  assert.equal((await get(source, 0)).rows[0].recordId, 'r-0');
  assert.equal((await get(source, 90000)).rows[0].recordId, 'r-90000');
  assert.equal((await get(source, 0)).rows[0].recordId, 'r-0');
  assert.deepEqual(calls.map(call => call.start), [0, 90000, 0]);
  assert.equal(calls[1].queryToken, 'query-7');
  assert.deepEqual(calls[1].query, { entityId: 'items', filters: [{ fieldId: 'status', operator: 'eq', value: 'Open' }], sortFieldId: 'name', descending: true });
});

test('opening is shared by concurrent blocks and EOF is an exclusive row count', async () => {
  let release;
  const calls = [];
  const source = studioDatasource(options(request => { calls.push(request); return request.start === 0 ? new Promise(r => { release = r; }) : Promise.resolve(page(100, 23, false)); }));
  const first = get(source, 0), second = get(source, 100);
  assert.equal(calls.length, 1);
  release(page(0));
  assert.equal((await first).last, undefined);
  assert.equal((await second).last, 123);
  assert.equal(calls.length, 2);
  const empty = studioDatasource(options(async () => page(0, 0, false)));
  assert.deepEqual(await get(empty, 0), { rows: [], last: 0 });
  const exact = studioDatasource(options(async () => page(0, 100, false)));
  assert.equal((await get(exact, 0)).last, 100);
});

test('destroyed or superseded reads cannot publish rows, errors or location', async () => {
  for (const destroy of [false, true]) {
    let release, current = true, sideEffects = 0;
    const source = studioDatasource({ ...options(() => new Promise(r => { release = r; })), current: () => current,
      loaded() { sideEffects++; }, failed() { sideEffects++; }, located() { sideEffects++; } });
    const pending = get(source, 0);
    if (destroy) source.destroy(); else current = false;
    release(page(0));
    assert.deepEqual(await pending, { failed: true });
    assert.equal(sideEffects, 0, 'A late read changed the replacement view.');
  }
});

test('a failed opening can retry, and a mismatched revision is never displayed', async () => {
  let attempts = 0, errors = 0;
  const source = studioDatasource({ ...options(async () => { if (++attempts === 1) throw new Error('offline'); return page(0); }), failed() { errors++; } });
  assert.deepEqual(await get(source, 0), { failed: true });
  assert.equal((await get(source, 0)).rows.length, 100);
  assert.equal(errors, 1);
  const stale = studioDatasource(options(async () => ({ ...page(0), changeSequence: 8 })));
  assert.deepEqual(await get(stale, 0), { failed: true });
});

test('an anchor opens its neighborhood once and supplies the actual relocated index', async () => {
  const calls = [], locations = [];
  const source = studioDatasource({ ...options(async request => { calls.push(request); return { ...page(400), locatedIndex: 432 }; }),
    anchor: { recordId: 'moved', index: 910 }, located: (index, found) => locations.push([index, found]) });
  const result = await get(source, 400);
  assert.equal(result.rows[0].recordId, 'r-400');
  assert.deepEqual(locations, [[432, true]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].locateRecordId, 'moved');
  assert.equal(calls[0].start, 900);
});
