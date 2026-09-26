import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// The front page's range strips, ranking maxima and progress rings, read through the real
// panels.ts with the host and the page replaced by stand-ins. Two defects are measured here:
// the range and ranking loaders kept an answer from an old revision for ever, so the front
// page chased a refresh once a second and nothing was read (R-008); and two reads drawn as
// one answer could come from different revisions, which drew a ring of 1000% (R-009).
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], reply: () => { throw new Error('No reply is set.'); } };
globalThis.summaryRefreshHost = host;
const stubs = {
  './client': 'export const client={request:async(method,payload)=>{const h=globalThis.summaryRefreshHost;h.calls.push({method,payload});return h.reply(method,payload);}};',
  './shell': 'export const content={querySelectorAll:()=>[]};export const interactionInProgress=()=>false;export const rerender=()=>{};export const setBusy=()=>{};export const showError=()=>{};',
  './record-markup': 'export const chartTileMarkup=()=>"";',
  './reads': 'export const loadSurfaceWindow=async()=>{};export const loadBoardColumns=async()=>{};export const loadRankedWindows=async()=>{};export const loadRecentWindows=async()=>{};',
};
const entry = [
  `export * from ${JSON.stringify(resolve(root, 'src/panels.ts'))};`,
  `export { state, summaryCounts, chartStates } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
  `export { rangeEndKey, rankedMaxKey } from ${JSON.stringify(resolve(root, 'src/overview-model.ts'))};`,
  `export { chartKey } from ${JSON.stringify(resolve(root, 'src/charts.ts'))};`,
  `export { overviewReadIsPending } from ${JSON.stringify(resolve(root, 'src/plan-selection.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'summary-refresh-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('summary-refresh-entry')) return '\0summary-refresh-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0summary-refresh-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'summary-refresh-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const scope = { kind: 'overview', entityId: 'tasks' };
const range = { semanticId: 'range', automationTarget: 'range', kind: 'rangeTile', properties: { entityId: 'tasks', fieldId: 'amount' }, children: [] };
const ranking = { semanticId: 'ranking', automationTarget: 'ranking', kind: 'rankedList', properties: { entityId: 'tasks', rankByFieldId: 'amount' }, children: [] };
const ring = { semanticId: 'ring', automationTarget: 'ring', kind: 'progressTile', properties: { entityId: 'tasks' }, children: [] };

function openFile(sequence) {
  p.summaryCounts.clear();
  p.chartStates.clear();
  p.state.session.fileSessionId = 'file-A';
  p.state.session.manifest = { changeSequence: sequence };
  host.calls = [];
}
const minKey = () => p.rangeEndKey(range, scope, 'min');
const maxKey = () => p.rangeEndKey(range, scope, 'max');
const aggregates = () => host.calls.filter((call) => call.method === 'data.aggregateRecords').length;

test('a range and a ranking maximum are read again when the file moves, and stop being read once they have caught up (R-008)', async () => {
  openFile(1);
  host.reply = (_method, payload) => ({ valueLexeme: payload.aggregate === 'min' ? '1' : '10', changeSequence: 1 });
  await p.loadRanges([{ tile: range, scope }]);
  await p.loadRankedMaxima([ranking]);
  assert.equal(aggregates(), 3, 'The first pass did not read both ends and the maximum.');

  // A write: the file is at revision 2 and the numbers have changed.
  p.state.session.manifest.changeSequence = 2;
  host.reply = (_method, payload) => ({ valueLexeme: payload.aggregate === 'min' ? '2' : '20', changeSequence: 2 });
  await p.loadRanges([{ tile: range, scope }]);
  await p.loadRankedMaxima([ranking]);
  assert.equal(aggregates(), 6, 'The file moved and the range and ranking were not read again.');
  assert.deepEqual(p.summaryCounts.get(minKey()), { state: 'ready', value: '2', changeSequence: 2 });
  assert.deepEqual(p.summaryCounts.get(maxKey()), { state: 'ready', value: '20', changeSequence: 2 });
  assert.deepEqual(p.summaryCounts.get(p.rankedMaxKey(ranking)), { state: 'ready', value: '20', changeSequence: 2 });
  for (const key of [minKey(), maxKey(), p.rankedMaxKey(ranking)])
    assert.equal(p.overviewReadIsPending(p.summaryCounts.get(key), 2), false, `${key} is still pending, so the front page would chase it for ever.`);

  // Caught up: another pass reads nothing.
  await p.loadRanges([{ tile: range, scope }]);
  await p.loadRankedMaxima([ranking]);
  assert.equal(aggregates(), 6, 'An answer for the current revision was read again.');
});

test('a ring whose two counts straddle a write is never drawn from both; the older count is read again (R-009)', async () => {
  openFile(3);
  // 10 counted at revision 2, then a write, then a total of 1 at revision 3.
  const replies = [{ count: 10, changeSequence: 2 }, { count: 1, changeSequence: 3 }, { count: 1, changeSequence: 3 }];
  host.reply = () => replies.shift();
  await p.loadCharts([{ node: ring, scope }], 'tasks');
  const ready = p.chartStates.get(p.chartKey(ring, scope));
  assert.deepEqual(ready, { state: 'ready', changeSequence: 3, numerator: '1', denominator: '1' },
    'A count from revision 2 was divided by a total from revision 3.');
  assert.equal(host.calls.length, 3);
  assert.deepEqual(host.calls[2].payload, host.calls[0].payload, 'The count read again was not the older one.');
});

test('while the file keeps moving a ring stays unread rather than wrong, within a bounded number of reads, and is drawn once the writing stops (R-009)', async () => {
  openFile(1);
  let sequence = 1;
  host.reply = () => ({ count: sequence * 10, changeSequence: sequence++ });
  await p.loadCharts([{ node: ring, scope }], 'tasks');
  assert.equal(p.chartStates.get(p.chartKey(ring, scope)), undefined, 'Two counts from different revisions were kept as an answer.');
  // Both counts once, then the older one again until the pass has made its attempts.
  assert.equal(host.calls.length, p.sameRevisionAttempts + 1, 'One pass did not stop at its bound.');

  // The writing stops at revision 9; the next pass, which the pending ring asks for, draws it.
  p.state.session.manifest.changeSequence = 9;
  host.reply = (_method, payload) => ({ count: payload.filters.length === 0 ? 4 : 1, changeSequence: 9 });
  await p.loadCharts([{ node: ring, scope }], 'tasks');
  const ready = p.chartStates.get(p.chartKey(ring, scope));
  assert.equal(ready.state, 'ready');
  assert.equal(ready.changeSequence, 9);
});

test('a range whose ends straddle a write is not drawn inverted; it is read again, and stays unread while the file keeps moving (R-009)', async () => {
  openFile(3);
  // The low end read before a write raised every value, the high end after it: 5 > 3.
  const replies = [{ valueLexeme: '5', changeSequence: 2 }, { valueLexeme: '3', changeSequence: 3 }, { valueLexeme: '1', changeSequence: 3 }];
  host.reply = () => replies.shift();
  await p.loadRanges([{ tile: range, scope }]);
  assert.deepEqual(p.summaryCounts.get(minKey()), { state: 'ready', value: '1', changeSequence: 3 });
  assert.deepEqual(p.summaryCounts.get(maxKey()), { state: 'ready', value: '3', changeSequence: 3 });
  assert.equal(host.calls[2].payload.aggregate, 'min', 'The end read again was not the older one.');

  openFile(1);
  let sequence = 1;
  host.reply = () => ({ valueLexeme: String(sequence), changeSequence: sequence++ });
  await p.loadRanges([{ tile: range, scope }]);
  assert.equal(p.summaryCounts.get(minKey()), undefined, 'An end from one revision was kept beside an end from another.');
  assert.equal(p.summaryCounts.get(maxKey()), undefined);
  assert.equal(p.overviewReadIsPending(p.summaryCounts.get(minKey()), sequence), true, 'The range is not pending, so it would never be read again.');
});
