import fs from 'node:fs/promises';
import path from 'node:path';

const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, PID and output directory are required.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
let socket;
const pending = new Map();
const pageErrors = [];
let nextId = 0;
async function waitFor(read, label) {
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function connect() {
  const target = await waitFor(async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
      const matches = targets.filter(t => t.type === 'page' && t.url === 'https://app.nendo.local/index.html');
      return matches.length === 1 ? matches[0] : null;
    } catch { return null; }
  }, 'the owned local Workbench');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.text);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector) {
  const state = await waitFor(async()=>{const value=await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e ? {disabled:!!e.disabled, text:e.textContent} : null; })()`);return value&&!value.disabled?value:null;},`enabled ${selector}`);
  assert(state && !state.disabled, `Missing or disabled control ${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function ready() { await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'idle Workbench'); }
async function screenshot(name) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
}


let fileSessionId = null;
async function envelope(method, payload = {}, generation = fileSessionId) {
  const request = { protocolVersion: 5, requestId: crypto.randomUUID(), method, payload, fileSessionId: generation };
  return evaluate(`new Promise((resolve,reject)=>{
    const b=chrome.webview,request=${JSON.stringify(request)};
    const timer=setTimeout(()=>{b.removeEventListener('message',receive);reject(new Error('Owned host timeout'));},12000);
    function receive(e){let r=e.data;if(typeof r==='string')r=JSON.parse(r);if(r.requestId!==request.requestId)return;
      clearTimeout(timer);b.removeEventListener('message',receive);resolve(r);}
    b.addEventListener('message',receive);b.postMessage(request);
  })`);
}
async function host(method, payload = {}) {
  const r = await envelope(method, payload);
  assert(r.ok, `${method}: ${r.error?.code}`);
  if (r.result?.fileSessionId) fileSessionId = r.result.fileSessionId;
  return r.result;
}
async function snapshot() { return host('session.getSnapshot'); }
async function refresh() { await command('Page.reload'); await sleep(400); await ready(); await snapshot(); }
async function fill(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function addType(name, reject = false) {
  await click('#nav-data'); await ready();
  await click('#new-entity');
  await fill('#entity-name', name); await fill('#entity-field-name', 'Label');
  await evaluate(`document.querySelector('#entity-form').requestSubmit()`); await ready();
  assert(await evaluate(`document.querySelector('#accept-proposal')?.disabled === false`), 'Schema-only proposal is not acceptable.');
  assert(await evaluate(`document.querySelector('.proposal-summary')?.textContent.includes('Validated for Studio')`), 'Schema-only review lacks an honest Studio preview.');
  await click(reject ? '#reject-proposal' : '#accept-proposal'); await ready();
  return (await snapshot()).entities.find(entity => entity.displayName === name);
}
async function selectEntity(entity) {
  await click('#nav-data'); await ready(); await click(`[data-entity-id="${entity.entityId}"]`); await ready();
}
async function addRecord(entity, label) {
  await selectEntity(entity); await click('#data-new-record');
  assert(await evaluate(`document.querySelector('#new-record-heading')?.textContent === ${JSON.stringify('Add '+entity.displayName)}`), 'Studio Add switched to another entity/custom form.');
  await fill(`[name="${entity.fields[0].fieldId}"]`, label);
  await evaluate(`document.querySelector('#record-form').requestSubmit()`); await ready();
  const records = (await snapshot()).records.filter(r=>r.entityId===entity.entityId);
  assert(records.some(r=>r.values[entity.fields[0].fieldId]===label), 'Studio create did not persist on its selected entity.');
  return records.find(r=>r.values[entity.fields[0].fieldId]===label);
}
async function editCell(entity, record, value) {
  await selectEntity(entity);
  const selector = `.ag-row[row-id="${record.recordId}"] .ag-cell[col-id="${entity.fields[0].fieldId}"]`;
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'F2',code:'F2',windowsVirtualKeyCode:113});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'F2',code:'F2',windowsVirtualKeyCode:113});
  await waitFor(()=>evaluate(`!!document.querySelector('.ag-cell-inline-editing input')`),'Studio cell editor');
  await fill('.ag-cell-inline-editing input', value);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await ready();
  await waitFor(async()=> (await snapshot()).records.find(r=>r.entityId===entity.entityId&&r.recordId===record.recordId)?.values[entity.fields[0].fieldId]===value, 'durable selected-entity edit');
}

const phase = process.argv[5];
try {
  await connect(); await command('Runtime.enable'); await ready();
  const stateFile = path.join(output, 'pilot-state.json');
  if (phase === 'create') {
    assert((await snapshot()).entities.length === 0, 'Pilot must start empty.');
    const entity = await addType('Pilot Notes');
    const record = await addRecord(entity, 'Installed create proof');
    await editCell(entity, record, 'Installed durable edit');
    await (await import('./Journey-McpRefresh.mjs')).verifyExternalMcpRefresh(
      {processId,host,click,ready,evaluate,waitFor,assert},entity);
    const current = await snapshot();
    await fs.writeFile(stateFile, JSON.stringify({ manifest: current.manifest, entities: current.entities, records: current.records, uiNodes: current.uiNodes }, null, 2));
    await screenshot('pilot-created.png');
  } else if (phase === 'reopen') {
    const expected = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const current = await snapshot();
    assert(JSON.stringify({ manifest: current.manifest, entities: current.entities, records: current.records, uiNodes: current.uiNodes }) === JSON.stringify(expected), 'Fresh process state differs from committed state.');
    assert((await host('agent.getStatus')).mode === 'off', 'Reopen must not activate an agent.');
    await screenshot('pilot-reopened.png');
  } else throw new Error('Expected create or reopen phase.');
  assert(pageErrors.length === 0, 'Unhandled page errors.');
  await fs.writeFile(path.join(output, `pilot-${phase}.json`), JSON.stringify({ result: 'passed', phase, processId, claims: 'Published/installed target selected by runner; real Studio create/edit or exact reopen. Not clean-user, disconnected-machine or human qualification.' }, null, 2));
  console.log(`Pilot ${phase}: passed`);
} finally { socket?.close(); }

