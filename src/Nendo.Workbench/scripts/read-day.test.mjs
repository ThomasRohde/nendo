import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Nendo stays open overnight in the tray, so a read is not fresh merely because the change
// sequence stood still: a screen 'Due today' would list yesterday's tasks the next morning.
// The civil day is part of each answer's freshness. Driven through
// the real readIsPending and loadAccumulatedPage with the clock replaced and the host a counter.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], sequence: 7 };
globalThis.readDayHost = host;
const stubs = {
  './client': `export const client={mode:'desktop',request:async(method,payload)=>{const h=globalThis.readDayHost;h.calls.push({method,payload});
    if(method==='data.queryRecords')return {items:[],nextCursor:null,changeSequence:h.sequence};
    throw new Error('Unexpected '+method);}};`,
  './shell': 'export const content={querySelectorAll:()=>[],querySelector:()=>null,innerHTML:""};export const interactionInProgress=()=>false;export const rerender=()=>{};export const setBusy=()=>{};export const showError=()=>{};export const clearError=()=>{};export const announce=()=>{};export const refreshChrome=()=>{};export const showRetainedNotice=()=>{};export const showKeptAlert=()=>{};export const showOutcome=()=>{};export const requiredElement=()=>({hidden:false,addEventListener(){},querySelector:()=>null});export const focusWithoutInteraction=()=>{};',
  './confirm-dialog': 'export const confirmDialog=async()=>false;',
};
const entry = [
  `export { useReadClock, readDay, untilNextDay, clauseFilters, windowIsCurrent, accumulatorIsCurrent } from ${JSON.stringify(resolve(root, 'src/record-window.ts'))};`,
  `export { readIsPending } from ${JSON.stringify(resolve(root, 'src/plan-selection.ts'))};`,
  `export { createDayWatch } from ${JSON.stringify(resolve(root, 'src/day-watch.ts'))};`,
  `export { loadAccumulatedPage } from ${JSON.stringify(resolve(root, 'src/reads.ts'))};`,
  `export { state, accumulatedWindows } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'read-day-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('read-day-entry')) return '\0read-day-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0read-day-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'read-day-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

// A local clock, so the day turns at this computer's midnight whatever its zone.
let now = new Date(2026, 9, 12, 23, 59, 30);
p.useReadClock(() => now);
const node = (semanticId, kind, properties = {}, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const dueToday = node('due.today', 'recordList', { entityId: 'tasks' }, [node('c1', 'filterClause', { fieldId: 'due', operator: 'eq', valueKind: 'today' })]);
p.state.session = { hasFile: true, fileSessionId: 'file-A', manifest: { changeSequence: host.sequence } };
const queries = () => host.calls.filter((call) => call.method === 'data.queryRecords');

test('an answer read before midnight is pending after it, at an unchanged change sequence', () => {
  now = new Date(2026, 9, 12, 23, 59, 30);
  const tile = { state: 'ready', value: '3', changeSequence: 7, day: p.readDay() };
  assert.equal(p.readDay(), '2026-10-12');
  assert.equal(p.readIsPending(tile, 7), false, 'the same day and revision is still the answer');
  assert.equal(p.untilNextDay(), 30_000, 'the timer wakes at midnight itself, not a second late with screens loading and nothing asked');
  now = new Date(2026, 9, 13, 0, 0, 30);
  assert.equal(p.readIsPending(tile, 7), true, 'yesterday’s Due today is read again although nothing was written');
  assert.equal(p.readIsPending({ ...tile, day: p.readDay() }, 7), false);
  assert.equal(p.readIsPending({ state: 'failed', code: 'x', message: 'y' }, 7), false, 'a refusal still waits for Retry');
  const window = { page: { changeSequence: 7 }, cursors: [null], index: 0, query: { filters: [] }, day: '2026-10-12' };
  assert.equal(p.windowIsCurrent(window, 7), false, 'returning to a screen re-reads a window from yesterday');
  assert.equal(p.windowIsCurrent({ ...window, day: '2026-10-13' }, 7), true);
  assert.equal(p.accumulatorIsCurrent({ changeSequence: 7, day: '2026-10-12' }, 7), false);
});

test('a calendar’s pages from yesterday are read again, under today’s query, without a write', async () => {
  now = new Date(2026, 9, 12, 23, 59, 0);
  host.calls.length = 0;
  const opening = () => ({ filters: p.clauseFilters(dueToday) });
  await p.loadAccumulatedPage('tasks', 'calendar:due', opening(), false);
  assert.equal(queries().length, 1);
  assert.equal(queries()[0].payload.filters[0].value, '2026-10-12');
  // The whole range is loaded, so asking for more at the same revision and day reads nothing.
  await p.loadAccumulatedPage('tasks', 'calendar:due', opening(), true);
  assert.equal(queries().length, 1, 'a loaded range at the same revision and day was read again');
  now = new Date(2026, 9, 13, 0, 0, 5);
  await p.loadAccumulatedPage('tasks', 'calendar:due', opening(), true);
  assert.equal(queries().length, 2, 'the pages opened yesterday were kept past midnight at an unchanged change sequence');
  assert.equal(queries()[1].payload.filters[0].value, '2026-10-13', 'and read again with today’s date');
  assert.equal(p.accumulatedWindows.get('calendar:due').day, '2026-10-13');
});

test('the day watch turns once at midnight, again after a sleep through midnight on the first press, and not on an early timer', () => {
  now = new Date(2026, 9, 12, 23, 59, 30);
  const timers = [];
  let turns = 0;
  const watch = p.createDayWatch(() => { turns++; }, { set: (callback, ms) => timers.push({ callback, ms }) - 1, clear: () => {} });
  watch.wake();
  assert.equal(timers.at(-1).ms, 30_000);
  // A timer that fires 3 ms early finds the same day and arms for what is left.
  now = new Date(2026, 9, 12, 23, 59, 59, 997);
  timers.at(-1).callback();
  assert.equal(turns, 0);
  assert.equal(timers.at(-1).ms, 50);
  now = new Date(2026, 9, 13, 0, 0, 0, 2);
  timers.at(-1).callback();
  assert.equal(turns, 1, 'midnight passed and nothing re-read the screens');
  watch.check();
  assert.equal(turns, 1, 'a press on the same day turns nothing');
  // Asleep through the next midnight: the timer never fired, and the first key press notices.
  now = new Date(2026, 9, 14, 7, 30);
  watch.check();
  assert.equal(turns, 2, 'a computer that slept through midnight kept yesterday until the file moved');
});

test('the window wakes the watch at midnight, on any press and when it is shown again', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(state\.session\.hasFile\) followTheFile\(\);\n\s+viewsDayTurned\(\);/, 'a new day does not catch the page up as a file change does');
  assert.match(main, /addEventListener\('visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) dayWatch\.wake\(\); \}\)/);
  assert.match(main, /window\.addEventListener\('pointerdown', dayWatch\.check, true\);/);
  assert.match(main, /window\.addEventListener\('keydown', dayWatch\.check, true\);/);
  assert.match(main, /\ndayWatch\.wake\(\);/, 'nothing arms the first midnight');
});
