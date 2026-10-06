import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Review R-003 (ADR-0004, 2026-10-06): a Filter pick and Studio's query belong to the place, so
// two tabs on one board keep their own. Driven through the real place capture (placeNow), the
// real tab move (switchTab) and the real restore (revisitCurrent), one bundle so they share the
// app's state, with the host replaced by a recorder.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [] };
globalThis.tabQueryHost = host;
const status = { semanticId: 'status', automationTarget: 'status', displayName: 'Status', presentation: 'singleChoice', storageKind: 'text', retired: false, required: false,
  options: ['ready', 'done'], choices: [{ id: 'ready', displayName: 'Ready', retired: false }, { id: 'done', displayName: 'Done', retired: false }] };
const plan = { entity: { semanticId: 'tasks', displayName: 'Task', fields: [status], derivedFields: [] },
  surfaces: [{ semanticId: 'tasks.list', automationTarget: 'tasks.list', kind: 'recordList', properties: { entityId: 'tasks' }, children: [] }] };
globalThis.tabQueryPlan = plan;
const stubs = {
  './client': `export const client={mode:'desktop',request:async(method,payload)=>{const h=globalThis.tabQueryHost;h.calls.push({method,payload});
    if(method==='semantic.compile')return {isValid:true,sourceChangeSequence:3,applications:[globalThis.tabQueryPlan],overview:null};
    if(method==='data.queryRecords'){const f=(payload.filters??[]).find(c=>c.fieldId==='status');const all=[['t1','ready'],['t2','done']];
      return {items:all.filter(([,s])=>!f||s===f.value).map(([id,s])=>({entityId:'tasks',recordId:id,recordVersion:1,values:{status:s}})),nextCursor:null,changeSequence:3};}
    if(method==='session.getSnapshot')return globalThis.tabQuerySession;
    return {items:[],nextCursor:null,changeSequence:3};}};`,
  './shell': 'export const content={querySelectorAll:()=>[],querySelector:()=>null,innerHTML:"",contains:()=>false};export const interactionInProgress=()=>false;export const rerender=()=>{};export const setBusy=()=>{};export const showError=(m)=>{globalThis.tabQueryHost.error=m;};export const clearError=()=>{};export const announce=()=>{};export const refreshChrome=()=>{};export const showRetainedNotice=()=>{};export const requiredElement=()=>({hidden:false,addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]});export const focusWithoutInteraction=()=>{};',
  './confirm-dialog': 'export const confirmDialog=async()=>false;',
};
const entry = [
  `export { placeNow, revisitCurrent } from ${JSON.stringify(resolve(root, 'src/navigation-actions.ts'))};`,
  `export { switchTab } from ${JSON.stringify(resolve(root, 'src/tab-set.ts'))};`,
  `export { navigationTrail } from ${JSON.stringify(resolve(root, 'src/navigation-trail.ts'))};`,
  `export { refreshDerived } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { quickFilters, studioQueries, state, surfaceWindows } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'tab-query-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('tab-query-entry')) return '\0tab-query-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0tab-query-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'tab-query-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const heading = { eyebrow: 'Use · Task', title: 'All tasks' };
const pick = value => ({ fieldId: 'status', value, label: `Status: ${value}` });
const shownIds = () => (p.surfaceWindows.get('tasks.list')?.page.items ?? []).map(item => item.recordId);
// The screen's own read, not Studio's sorted one.
const lastFilter = () => host.calls.filter(call => call.method === 'data.queryRecords' && call.payload.entityId === 'tasks' && call.payload.recordId === undefined && call.payload.sortFieldId === undefined)
  .at(-1)?.payload.filters ?? [];

test('R-003: two tabs on one list keep their own Filter pick and Studio query', async () => {
  p.state.session = { hasFile: true, fileSessionId: 'file-A', fileName: 'Tasks.nendo', manifest: { changeSequence: 3 },
    capabilities: { customSurfaces: true, readHistory: true, readData: true, mutate: true }, entities: [{ entityId: 'tasks' }], extensions: null };
  globalThis.tabQuerySession = p.state.session;
  p.state.view = 'use';
  p.state.selectedApplicationEntity = 'tasks';
  p.state.selectedEntityId = 'tasks';
  p.state.showOverview = false;
  await p.refreshDerived();

  // Tab A: Ready, and Studio sorted by status.
  p.quickFilters.set('tasks.list', pick('ready'));
  p.studioQueries.set('tasks', { sortFieldId: 'status', descending: false, fieldId: '', operator: 'contains', text: '', filters: [] });
  p.navigationTrail.record(p.placeNow(heading));
  // Tab B opens on the same place, then picks Done and sorts the other way.
  const set = { tabs: [{ id: 1, saved: null }, { id: 2, saved: p.navigationTrail.inspect() }], active: 0 };
  assert.equal(await p.switchTab(set, 1, p.navigationTrail, p.revisitCurrent), true, host.error);
  p.quickFilters.set('tasks.list', pick('done'));
  p.studioQueries.set('tasks', { sortFieldId: 'status', descending: true, fieldId: '', operator: 'contains', text: '', filters: [] });
  p.navigationTrail.record(p.placeNow(heading));

  for (const [index, value, descending, ids] of [[0, 'ready', false, ['t1']], [1, 'done', true, ['t2']], [0, 'ready', false, ['t1']]]) {
    assert.equal(await p.switchTab(set, index, p.navigationTrail, p.revisitCurrent), true, host.error);
    assert.equal(p.quickFilters.get('tasks.list')?.value, value, `Tab ${index} must show its own pick.`);
    assert.deepEqual(lastFilter().filter(clause => clause.fieldId === 'status').map(clause => clause.value), [value], `Tab ${index} must ask for its own records.`);
    assert.deepEqual(shownIds(), ids, `Tab ${index} must show its own records.`);
    assert.equal(p.studioQueries.get('tasks')?.descending, descending, `Tab ${index} must keep its own Studio sort.`);
  }
});

test('R-003: a place recorded with no pick clears the one standing', async () => {
  p.quickFilters.delete('tasks.list');
  p.navigationTrail.load({ places: [], cursor: -1 });
  p.navigationTrail.record(p.placeNow(heading));
  const set = { tabs: [{ id: 1, saved: null }, { id: 2, saved: p.navigationTrail.inspect() }], active: 0 };
  p.quickFilters.set('tasks.list', pick('done'));
  p.navigationTrail.record(p.placeNow(heading));
  assert.equal(await p.switchTab(set, 1, p.navigationTrail, p.revisitCurrent), true, host.error);
  assert.equal(p.quickFilters.has('tasks.list'), false);
  assert.deepEqual(shownIds(), ['t1', 't2']);
});
