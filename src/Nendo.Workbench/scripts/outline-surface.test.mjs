import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// ADR-0019 stage 6: the outline surface in Use. The model rules -- where a drop lands, what a
// tree with no order field can do, which rows start open and what the device remembers -- and
// the real markup function over a stored outline state.
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = [
  `export * from ${JSON.stringify(resolve(root, 'src/outline-model.ts'))};`,
  `export { outlineSurfaceMarkup } from ${JSON.stringify(resolve(root, 'src/outline-surface-markup.ts'))};`,
  `export { state, emptySession, outlineSurfaces, outlineErrors } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'outline-surface-entry', enforce: 'pre',
    resolveId(id) { return id.endsWith('outline-surface-entry') ? '\0outline-surface-entry' : null; },
    load(id) { return id === '\0outline-surface-entry' ? entry : null; },
  }],
  build: { ssr: 'outline-surface-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const o = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const node = (recordId, parentRecordId, childCount = 0, values = {}) =>
  ({ record: { recordId, recordVersion: 1, values: { name: recordId.toUpperCase(), ...values } }, parentRecordId, depth: 1, childCount });
const tree = () => {
  const state = o.emptyOutline('areas', 7);
  state.levels.set(o.TOP, { items: [node('a', null, 2), node('b', null, 1), node('c', null)], nextCursor: null });
  state.levels.set('a', { items: [node('a1', 'a'), node('a2', 'a')], nextCursor: null });
  state.levels.set('b', { items: [node('b1', 'b')], nextCursor: null });
  state.expanded.add('a');
  return state;
};

test('the middle of a row takes a record in as its last child; the top and bottom quarters place it beside', () => {
  assert.equal(o.dropZoneAt(2, 40, true), 'before');
  assert.equal(o.dropZoneAt(20, 40, true), 'inside');
  assert.equal(o.dropZoneAt(38, 40, true), 'after');
  // Without an order field there is no between: a whole row takes the record in.
  assert.equal(o.dropZoneAt(2, 40, false), 'inside');
  const state = tree();
  assert.deepEqual(o.dropTarget(state, 'c', 'a', 'inside'), { parentRecordId: 'a', beforeRecordId: null });
  assert.deepEqual(o.dropTarget(state, 'c', 'a1', 'before'), { parentRecordId: 'a', beforeRecordId: 'a1' });
  assert.deepEqual(o.dropTarget(state, 'c', 'a1', 'after'), { parentRecordId: 'a', beforeRecordId: 'a2' });
  assert.deepEqual(o.dropTarget(state, 'c', 'a2', 'after'), { parentRecordId: 'a', beforeRecordId: null });
});

test('a drop that would put a record under itself, or leave it where it is, is not offered', () => {
  const state = tree();
  assert.equal(o.dropTarget(state, 'a', 'a1', 'inside'), null, 'under its own child');
  assert.equal(o.dropTarget(state, 'a', 'a', 'inside'), null, 'onto itself');
  assert.equal(o.dropTarget(state, 'a1', 'a2', 'before'), null, 'a1 already precedes a2');
  assert.equal(o.dropTarget(state, 'a2', 'a', 'inside'), null, 'a2 is already a\'s last child');
  assert.deepEqual(o.dropTarget(state, 'a1', 'a', 'inside'), { parentRecordId: 'a', beforeRecordId: null }, 'a1 can still go last');
  assert.equal(o.isWithin(state, 'a1', 'a'), true);
  assert.equal(o.isWithin(state, 'b1', 'a'), false);
});

test('a tree with no order field changes parents only', () => {
  const state = tree();
  assert.equal(o.moveTarget(state, 'b', 'up', false), null);
  assert.equal(o.moveTarget(state, 'b', 'down', false), null);
  assert.deepEqual(o.moveTarget(state, 'b', 'indent', false), { parentRecordId: 'a', beforeRecordId: null });
  assert.deepEqual(o.moveTarget(state, 'a1', 'outdent', false), { parentRecordId: null, beforeRecordId: null });
  assert.equal(o.dropTarget(state, 'c', 'a1', 'before', false), null);
  assert.equal(o.dropTarget(state, 'a2', 'a', 'inside', false), null, 'already its child, and there is no position to change');
});

test('a row starts open by what the person last did here, else by the author\'s depth', () => {
  assert.equal(o.startsOpen(1, 2, undefined), true);
  assert.equal(o.startsOpen(2, 2, undefined), false);
  assert.equal(o.startsOpen(1, 1, undefined), false, 'expandDepth 1 shows the top level only');
  assert.equal(o.startsOpen(3, 2, 'open'), true);
  assert.equal(o.startsOpen(1, 4, 'closed'), false);
});

test('the device keeps each outline\'s rows apart, by application and node', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  o.rememberRow(storage, 'app-1', 'tree', 'a', 'closed');
  o.rememberRow(storage, 'app-1', 'tree', 'b', 'open');
  o.rememberRow(storage, 'app-1', 'other', 'a', 'open');
  assert.deepEqual(o.rememberedRows(storage, 'app-1', 'tree'), { a: 'closed', b: 'open' });
  assert.deepEqual(o.rememberedRows(storage, 'app-1', 'other'), { a: 'open' });
  assert.deepEqual(o.rememberedRows(storage, 'app-2', 'tree'), {});
  store.set(o.outlineRowsKey('app-3'), 'not json');
  assert.deepEqual(o.rememberedRows(storage, 'app-3', 'tree'), {}, 'unreadable storage is simply not remembered');
});

const plan = {
  entity: {
    semanticId: 'areas', displayName: 'Areas', derivedFields: [],
    fields: [
      { semanticId: 'name', displayName: 'Name', storageKind: 0, presentation: 'singleLine', options: [] },
      { semanticId: 'parent', displayName: 'Part of', storageKind: 6, presentation: null, options: [] },
      { semanticId: 'stage', displayName: 'Stage', storageKind: 0, presentation: 'singleChoice', options: ['open', 'done'] },
    ],
  },
  surfaces: [], records: [],
};
const outlineNode = (properties = {}) => ({
  semanticId: 'tree', automationTarget: 'tree', kind: 'outlineSurface',
  properties: { definitionVersion: 3, entityId: 'areas', title: 'Area map', ...properties },
  children: [{ semanticId: 'tree.stage', automationTarget: 'tree.stage', kind: 'fieldBinding', properties: { fieldId: 'stage' }, children: [] }],
});
function openFile({ mutate = true, orderFieldId = 'ord' } = {}) {
  const empty = o.emptySession();
  o.state.session = {
    ...empty, fileSessionId: 'file-A', hasFile: true, health: 'normal',
    capabilities: { ...empty.capabilities, readData: true, mutate },
    manifest: { changeSequence: 7, applicationId: 'app-1' },
    entities: [{ entityId: 'areas', displayName: 'Areas', retired: false, hierarchy: { parentFieldId: 'parent', orderFieldId },
      fields: [{ fieldId: 'name' }, { fieldId: 'parent', reference: { targetEntityId: 'areas', labelFieldId: 'name' } }, { fieldId: 'stage' }] }],
  };
  o.state.selectedRecordId = null;
  o.outlineSurfaces.clear();
  o.outlineErrors.clear();
}

test('the outline draws a treegrid: levels, open state, positions and child counts, titled by the parent\'s label field', () => {
  openFile();
  o.outlineSurfaces.set('tree', { state: tree(), error: null, focus: null, found: null });
  const html = o.outlineSurfaceMarkup(plan, outlineNode({ reorder: true }));
  assert.match(html, /role="treegrid" aria-label="Area map"/);
  const rows = [...html.matchAll(/data-outline-row="([^"]+)" aria-level="(\d)" aria-setsize="(\d)" aria-posinset="(\d)"( aria-expanded="(\w+)")?/g)]
    .map((m) => `${m[1]}:${m[2]}:${m[4]}/${m[3]}${m[6] === undefined ? '' : m[6] === 'true' ? ':open' : ':closed'}`);
  assert.deepEqual(rows, ['a:1:1/3:open', 'a1:2:1/2', 'a2:2:2/2', 'b:1:2/3:closed', 'c:1:3/3']);
  assert.match(html, /<th role="columnheader" scope="col">Name<\/th><th role="columnheader" scope="col">Stage<\/th>/);
  assert.match(html, /data-outline-open="a" tabindex="-1">A<\/button><span class="outline-count"[^>]*>2<\/span>/);
  assert.match(html, /style="--outline-depth:1"/, 'a child is indented one step');
  // The first row takes the tab stop until the person puts focus somewhere.
  assert.match(html, /data-outline-row="a"[^>]*tabindex="0"/);
  assert.match(html, /data-outline-move="up"[^>]*disabled/, 'nothing is above the first row');
  assert.match(html, /Drag a row, or press Alt, Shift and an arrow key/);
});

test('moving is offered only when the surface asks for it and the file can be changed', () => {
  openFile({ mutate: false });
  o.outlineSurfaces.set('tree', { state: tree(), error: null, focus: 'b', found: null });
  assert.doesNotMatch(o.outlineSurfaceMarkup(plan, outlineNode({ reorder: true })), /data-outline-move/);
  openFile();
  o.outlineSurfaces.set('tree', { state: tree(), error: null, focus: 'b', found: null });
  assert.doesNotMatch(o.outlineSurfaceMarkup(plan, outlineNode()), /data-outline-move/);
  // Without an order field only indent and outdent exist.
  openFile({ orderFieldId: null });
  o.outlineSurfaces.set('tree', { state: tree(), error: null, focus: 'b', found: null });
  const moves = [...o.outlineSurfaceMarkup(plan, outlineNode({ reorder: true })).matchAll(/data-outline-move="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(moves, ['outdent', 'indent']);
});

test('an outline says when the record type keeps no tree, when it is reading, when a read failed and what find found', () => {
  openFile();
  o.state.session.entities[0].hierarchy = null;
  assert.match(o.outlineSurfaceMarkup(plan, outlineNode()), /Areas is not kept as a tree/);
  openFile();
  assert.match(o.outlineSurfaceMarkup(plan, outlineNode()), /aria-busy="true"/);
  o.outlineErrors.set('tree', 'The host refused.');
  assert.match(o.outlineSurfaceMarkup(plan, outlineNode()), /could not be read[\s\S]*The host refused\.[\s\S]*data-outline-retry/);
  o.outlineErrors.clear();
  o.outlineSurfaces.set('tree', { state: tree(), error: null, focus: null, found: { text: 'a2', ids: new Set(['a2']), more: false } });
  const html = o.outlineSurfaceMarkup(plan, outlineNode());
  assert.match(html, /1 match for “a2”, opened where it sits\./);
  assert.match(html, /class="outline-row is-found"[^>]*data-outline-row="a2"/);
});
