import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Review R-014: every move between screens re-read the History page, the Agent status and
// compiled the definition again, and could read one record window twice, even when the file
// had not moved. Measured through the real refreshDerived with the host replaced by a counter.
const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], sequence: 7 };
globalThis.navigationReadsHost = host;
const page = (sequence) => ({ items: [], nextCursor: null, changeSequence: sequence });
const stubs = {
  './client': `export const client={mode:'desktop',request:async(method,payload)=>{const h=globalThis.navigationReadsHost;h.calls.push({method,payload});
    if(method==='semantic.compile')return {isValid:true,sourceChangeSequence:h.sequence,applications:[{entity:{semanticId:'tasks',displayName:'Task',fields:[],derivedFields:[]},surfaces:[{semanticId:'tasks.list',automationTarget:'tasks.list',kind:'recordList',properties:{entityId:'tasks'},children:[]}]}],overview:null};
    if(method==='history.query'||method==='data.queryRecords')return {items:[],nextCursor:null,changeSequence:h.sequence};
    if(method==='agent.getStatus')return {mode:'inspect',state:'ready'};
    if(method==='session.getSnapshot')return globalThis.navigationReadsSession();
    throw new Error('Unexpected '+method);}};`,
  './shell': 'export const content={querySelectorAll:()=>[],querySelector:()=>null,innerHTML:""};export const interactionInProgress=()=>false;export const rerender=()=>{};export const setBusy=()=>{};export const showError=()=>{};export const clearError=()=>{};export const announce=()=>{};export const refreshChrome=()=>{};export const showRetainedNotice=()=>{};export const requiredElement=()=>({hidden:false,addEventListener(){},querySelector:()=>null});export const focusWithoutInteraction=()=>{};',
  './confirm-dialog': 'export const confirmDialog=async()=>false;',
};
const entry = [
  `export { refreshDerived } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { state } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'navigation-reads-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('navigation-reads-entry')) return '\0navigation-reads-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0navigation-reads-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'navigation-reads-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const p = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

function openFile() {
  const session = {
    hasFile: true, fileSessionId: 'file-A', fileName: 'Tasks.nendo', manifest: { changeSequence: host.sequence },
    capabilities: { customSurfaces: true, readHistory: true, readData: true, mutate: true }, entities: [], extensions: null,
  };
  globalThis.navigationReadsSession = () => ({ ...session, manifest: { changeSequence: host.sequence } });
  p.state.session = session;
  p.state.selectedApplicationEntity = 'tasks';
  p.state.showOverview = false;
}
const count = (method) => host.calls.filter(call => call.method === method).length;
const reads = () => Object.fromEntries(['semantic.compile', 'history.query', 'agent.getStatus', 'data.queryRecords'].map(m => [m, count(m)]));

test('R-014: a move between screens on an unchanged file reads no History, no Agent status and compiles nothing again', async () => {
  openFile();
  p.state.view = 'use';
  await p.refreshDerived(0, { navigation: true });
  host.calls = [];
  // Use, Data, Use: three moves, the file standing still.
  for (const view of ['data', 'use', 'data']) { p.state.view = view; await p.refreshDerived(0, { navigation: true }); }
  const moved = reads();
  assert.equal(moved['history.query'], 0, `History was read on moves that do not show it: ${JSON.stringify(moved)}`);
  assert.equal(moved['agent.getStatus'], 0, `Agent status was read on moves that do not show it: ${JSON.stringify(moved)}`);
  assert.equal(moved['semantic.compile'], 0, `The definition was compiled again with the file unchanged: ${JSON.stringify(moved)}`);
});

test('R-014: no record window is read twice in one refresh', async () => {
  openFile();
  p.state.view = 'use';
  host.calls = [];
  await p.refreshDerived(0, { navigation: true });
  const requests = host.calls.filter(call => call.method === 'data.queryRecords').map(call => JSON.stringify(call.payload));
  assert.ok(requests.length >= 1, 'The list was not read at all.');
  assert.equal(new Set(requests).size, requests.length, `One refresh read the same window twice: ${requests.join(' | ')}`);
});

test('R-014: History and Agent are read when they are the screen, and a moved file compiles again', async () => {
  openFile();
  p.state.view = 'use';
  await p.refreshDerived(0, { navigation: true });
  host.calls = [];
  p.state.view = 'history';
  await p.refreshDerived(0, { navigation: true });
  assert.equal(count('history.query'), 1, 'Opening History must read its page.');
  p.state.view = 'agent';
  await p.refreshDerived(0, { navigation: true });
  assert.equal(count('agent.getStatus'), 1, 'Being on the Agent page must read its status.');
  host.calls = [];
  host.sequence += 1;
  p.state.session = globalThis.navigationReadsSession();
  p.state.view = 'use';
  await p.refreshDerived(0, { navigation: true });
  assert.equal(count('semantic.compile'), 1, 'An accepted change moves the revision, and the definition is compiled again at once.');
  host.calls = [];
  await p.refreshDerived();
  assert.equal(count('semantic.compile'), 1, 'A refresh that is not a move between screens always compiles.');
});
