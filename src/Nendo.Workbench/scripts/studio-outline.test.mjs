import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Run the shipped controller and draft guard. Only the host, drawing boundary and
// clock are controlled, so delayed replies and file switches have deterministic order.
const root = fileURLToPath(new URL('..', import.meta.url));
const f = { requests: [], timers: [], now: 0, draws: 0, focused: false };
globalThis.studioOutlineFixture = f;
const stubs = {
  './client': `export const client = { request: (method, payload) => new Promise((resolve, reject) =>
    globalThis.studioOutlineFixture.requests.push({ method, payload, resolve, reject })) };`,
  './shell': `export const rerender = () => globalThis.studioOutlineFixture.draws++;
    export const interactionInProgress = () => globalThis.studioOutlineFixture.focused;
    export const showError = () => {};`,
  './read-chase': `import { createReadChase as create } from ${JSON.stringify(resolve(root, 'src/read-chase.ts'))};
    export const createReadChase = () => create({ now: () => globalThis.studioOutlineFixture.now,
      later: (run, ms) => globalThis.studioOutlineFixture.timers.push({ run, ms }) });`,
};
const entry = `export * from ${JSON.stringify(resolve(root, 'src/studio-outline.ts'))};
  export { state, clearFileScoped } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};
  export { referenceVersions } from ${JSON.stringify(resolve(root, 'src/reference-controls.ts'))};
  export { WorkbenchHostError } from ${JSON.stringify(resolve(root, 'src/host-types.ts'))};`;
const bundle = await build({ root, configFile: false, logLevel: 'error',
  plugins: [{ name: 'studio-outline-host', enforce: 'pre',
    resolveId(id) { if (id.endsWith('studio-outline-entry')) return '\0entry'; if (id in stubs) return '\0stub:' + id; return null; },
    load(id) { if (id === '\0entry') return entry; if (id.startsWith('\0stub:')) return stubs[id.slice(6)]; },
  }], build: { ssr: 'studio-outline-entry', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
const entity = { entityId: 'shared-entity' };
const page = name => ({ items: [{ record: { recordId: name, recordVersion: 1, values: { title: name } }, depth: 1, childCount: 0, parentRecordId: null }], nextCursor: null, changeSequence: 8 });
const settle = () => new Promise(resolve => setImmediate(resolve));
function reset() {
  m.clearFileScoped();
  Object.assign(f, { requests: [], timers: [], now: 0, draws: 0, focused: false });
  m.state.openDraft = null; m.state.retainedDraft = null;
  m.state.session = { fileSessionId: 'session-A', manifest: { changeSequence: 8 } };
}
function switchFile() { m.clearFileScoped(); m.state.session = { fileSessionId: 'session-B', manifest: { changeSequence: 8 } }; }
function wake() { f.now += 1000; const timers = f.timers.splice(0); for (const timer of timers) timer.run(); }
function name() { return [...m.outlines.get(entity.entityId).levels.values()][0].items[0].record.recordId; }

test('R02-009: file reset removes Studio layouts, cached records and the completed-read marker at an equal sequence', async () => {
  reset(); m.studioLayouts.set(entity.entityId, 'table'); m.refreshOutline(entity);
  f.requests[0].resolve(page('file A')); await settle();
  assert.equal(name(), 'file A');
  switchFile();
  assert.equal(m.outlines.size, 0, 'Studio outlines from the previous file survived file reset.');
  assert.equal(m.studioLayouts.size, 0, 'Studio layouts from the previous file survived file reset.');
  m.refreshOutline(entity);
  assert.equal(f.requests.length, 2, 'An equal change sequence suppressed the new file read.');
  f.requests[1].resolve(page('file B')); await settle(); assert.equal(name(), 'file B');
});

test('R02-009: a delayed old-file read cannot overwrite a completed new-file outline or redraw it', async () => {
  reset(); m.refreshOutline(entity); switchFile(); m.refreshOutline(entity);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(page('file B')); await settle(); const draws = f.draws;
  f.requests[0].resolve(page('file A')); await settle();
  assert.equal(name(), 'file B', 'A late reply from the previous file replaced the new outline.');
  assert.equal(f.draws, draws, 'A late reply from the previous file redrew the page.');
});

test('R02-010: a tree reply waits through typing, retained drafts and interaction, then draws once', async () => {
  for (const hold of ['typing', 'retained', 'focus']) {
    reset(); m.refreshOutline(entity);
    const draft = { edited: new Set(['title']), values: { title: 'KEEP THIS DRAFT' } };
    if (hold === 'typing') m.state.openDraft = draft;
    else if (hold === 'retained') m.state.retainedDraft = Object.freeze({ reason: 'read-only' });
    else f.focused = true;
    f.requests[0].resolve(page('file A')); await settle();
    assert.equal(f.draws, 0, `A completed outline redrew through ${hold}.`);
    wake(); assert.equal(f.draws, 0, `A deferred outline redrew through ${hold}.`);
    if (hold === 'typing') assert.equal(m.state.openDraft, draft);
    m.state.openDraft = null; m.state.retainedDraft = null; f.focused = false;
    wake(); assert.equal(f.draws, 1, 'The outline did not resume after the draft was released.');
    assert.equal(f.requests.length, 1);
  }
});

test('R02-011: a failed outline read can retry at the same revision, without stacking reads', async () => {
  reset(); m.refreshOutline(entity); m.refreshOutline(entity);
  assert.equal(f.requests.length, 1, 'Concurrent render passes stacked identical tree reads.');
  f.requests[0].reject(new Error('Temporary tree failure')); await settle();
  assert.equal(m.studioOutlineErrors.get(entity.entityId), 'Temporary tree failure');
  assert.equal(m.outlines.has(entity.entityId), false);
  f.now = 1000; m.refreshOutline(entity);
  assert.equal(f.requests.length, 2, 'A failed outline read suppressed retry at the same revision.');
  f.requests[1].resolve(page('recovered')); await settle();
  assert.equal(name(), 'recovered'); assert.equal(m.studioOutlineErrors.size, 0);
  m.refreshOutline(entity); assert.equal(f.requests.length, 2, 'A successful revision was unnecessarily reread.');
});

test('R02-011: an outline error is retried without the button once the file has moved on', async () => {
  reset(); m.refreshOutline(entity);
  f.requests[0].reject(new Error('Temporary tree failure')); await settle();
  assert.equal(m.outlineErrorIsCurrent(entity.entityId), true, 'A fresh failure did not wait for the retry control.');
  m.state.session = { ...m.state.session, manifest: { changeSequence: 9 } };
  assert.equal(m.outlineErrorIsCurrent(entity.entityId), false, 'An outline error outlived the revision it failed at.');
  f.now = 1000; m.refreshOutline(entity);
  assert.equal(f.requests.length, 2, 'A later revision did not read the outline again.');
  assert.equal(m.studioOutlineErrors.size, 0);
});

test('R02-012: native picker versions serialize every semantic ID, including reserved object keys', () => {
  const ids = ['__proto__', 'constructor', 'toString', 'ordinary'];
  const roots = ids.map((id, i) => ({ dataset: { referenceField: id, targetVersion: String(i + 7) } }));
  const values = Object.fromEntries(ids.map(id => [id, 'chosen-record']));
  const versions = m.referenceVersions({ querySelectorAll: () => roots }, values);
  const serialized = JSON.parse(JSON.stringify(versions));
  assert.equal(Object.hasOwn(serialized, '__proto__'), true, 'The selected __proto__ target version vanished from the native request.');
  assert.deepEqual(serialized, Object.fromEntries(ids.map((id, i) => [id, i + 7])));
});

// A refresh reads each level as far as Show more had read it: read again from its first page,
// the rows Show more had added would go, and an edited row past the first 200 would leave the
// view at its own save.
test('a refresh reads each level as far as Show more had read it', async () => {
  reset();
  const nodes = (from, count) => Array.from({ length: count }, (_, index) => ({ record: { recordId: `r${from + index}`, recordVersion: 1, values: {} }, depth: 1, childCount: 0, parentRecordId: null }));
  m.outlines.set(entity.entityId, { entityId: entity.entityId, levels: new Map([['', { items: nodes(0, 400), nextCursor: 'c400' }]]), expanded: new Set(), changeSequence: 7 });
  m.refreshOutline(entity);
  assert.equal(f.requests[0].payload.cursor, null);
  f.requests[0].resolve({ items: nodes(0, 200), nextCursor: 'c200', changeSequence: 8 }); await settle();
  assert.equal(f.requests.length, 2, 'the refresh stopped at the first page of a level read to 400 rows');
  assert.equal(f.requests[1].payload.cursor, 'c200');
  f.requests[1].resolve({ items: nodes(200, 200), nextCursor: 'c400', changeSequence: 8 }); await settle();
  const top = m.outlines.get(entity.entityId).levels.get('');
  assert.equal(top.items.length, 400, `a refresh dropped the level back to ${top.items.length} rows`);
  assert.equal(top.nextCursor, 'c400');
  assert.equal(f.requests.length, 2, 'the refresh read further than the level had been read');
});

// The host never answers a continued page from another
// change; it refuses the cursor as stale-cursor. That refusal is the file moving between pages,
// and the refresh starts over, rather than showing an outline error or closing an open record.
test('a stale cursor while a level is read again starts the refresh over', async () => {
  const nodes = (from, count, parent = null) => Array.from({ length: count }, (_, index) => ({ record: { recordId: `${parent ?? 'r'}${from + index}`, recordVersion: 1, values: {} }, depth: parent ? 2 : 1, childCount: 0, parentRecordId: parent }));
  const stale = () => new m.WorkbenchHostError('stale-cursor', 'The file changed. Restart paging.');
  // The top level.
  reset();
  m.outlines.set(entity.entityId, { entityId: entity.entityId, levels: new Map([['', { items: nodes(0, 400), nextCursor: 'c400' }]]), expanded: new Set(), changeSequence: 7 });
  m.refreshOutline(entity);
  f.requests[0].resolve({ items: nodes(0, 200), nextCursor: 'c200', changeSequence: 8 }); await settle();
  f.requests[1].reject(stale()); await settle();
  assert.equal(m.studioOutlineErrors.get(entity.entityId), undefined, `a stale cursor on the top level is shown as an outline error: ${m.studioOutlineErrors.get(entity.entityId)}`);
  assert.equal(f.requests.length, 3, 'a stale cursor on the top level did not start the refresh over');
  assert.equal(f.requests[2].payload.cursor, null);
  f.requests[2].resolve({ items: nodes(0, 200), nextCursor: 'c200', changeSequence: 9 }); await settle();
  f.requests[3].resolve({ items: nodes(200, 200), nextCursor: 'c400', changeSequence: 9 }); await settle();
  assert.equal(m.outlines.get(entity.entityId).levels.get('').items.length, 400);
  // An open record's children.
  reset();
  m.outlines.set(entity.entityId, { entityId: entity.entityId, levels: new Map([['', { items: nodes(0, 1), nextCursor: null }], ['r0', { items: nodes(0, 300, 'c'), nextCursor: null }]]), expanded: new Set(['r0']), changeSequence: 7 });
  m.refreshOutline(entity);
  f.requests[0].resolve({ items: nodes(0, 1), nextCursor: null, changeSequence: 8 }); await settle();
  assert.equal(f.requests[1].payload.rootRecordId, 'r0');
  f.requests[1].resolve({ items: nodes(0, 200, 'c'), nextCursor: 'k200', changeSequence: 8 }); await settle();
  f.requests[2].reject(stale()); await settle();
  assert.equal(f.requests.length, 4, 'a stale cursor on an open record’s children did not start the refresh over');
  f.requests[3].resolve({ items: nodes(0, 1), nextCursor: null, changeSequence: 9 }); await settle();
  f.requests[4].resolve({ items: nodes(0, 200, 'c'), nextCursor: 'k200', changeSequence: 9 }); await settle();
  f.requests[5].resolve({ items: nodes(200, 100, 'c'), nextCursor: null, changeSequence: 9 }); await settle();
  const outline = m.outlines.get(entity.entityId);
  assert.ok(outline.expanded.has('r0'), 'a stale cursor closed the open record as if it had gone');
  assert.equal(outline.levels.get('r0').items.length, 300);
});
