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
let originalTheme;
// An entity may own eight boards and eight lists, so Use no longer has a board
// mode to fall into: the first compiled root is the default and this journey
// selects the board it drags on. #show-board is the alias on the first board.
async function useBoard() {
  await click('#nav-use'); await ready();
  if (!await evaluate(`document.querySelector('#show-board')?.getAttribute('aria-pressed') === 'true'`)) {
    await click('#show-board'); await ready();
  }
  // The board being selected is what this waits for. An empty board shows the
  // first-record state rather than columns, so columns are not the signal.
  await waitFor(() => evaluate(`document.querySelector('#show-board')?.getAttribute('aria-pressed') === 'true'`),
    'the board to be the selected surface');
}
async function pointerDrag(recordId, group, previewName, cancel = false) {
  const points = await evaluate(`(()=>{const a=document.querySelector('[data-record-id="${recordId}"]').getBoundingClientRect(); const b=[...document.querySelectorAll('.board-column')].find(e=>e.dataset.group===${JSON.stringify(group)}).getBoundingClientRect();return {a:{x:a.x+a.width/2,y:a.y+25},b:{x:b.x+b.width/2,y:b.y+85}};})()`);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...points.a});
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...points.a,button:'left',buttons:1,clickCount:1});
  for(let step=1;step<=12;step++) await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:points.a.x+(points.b.x-points.a.x)*step/12,y:points.a.y+(points.b.y-points.a.y)*step/12,button:'left',buttons:1});
  if(previewName) await screenshot(previewName);
  if(cancel) await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...points.b,button:'left',buttons:0,clickCount:1});
  await ready();
}
try {
  await connect();await command('Runtime.enable');await ready();await snapshot();
  originalTheme=(await host('appearance.get')).preference;
  if(phase==='create'){
    await click('#start-application');await ready();await click('#accept-proposal');await ready();
    const plan=(await host('semantic.compile')).applications[0];
    const root=(kind)=>plan.surfaces.find(node=>node.kind===kind);
    const bindings=(node)=>node.children.filter(child=>child.kind==='fieldBinding').map(child=>child.properties.fieldId);
    const board=root('boardSurface');const cardFields=bindings(board);
    const groupBy=board.properties.groupByFieldId;
    // The board's columns are the group field's options, in stored order.
    const groups=plan.entity.fields.find(f=>f.semanticId===groupBy).options;
    await useBoard();await click('#new-record');await ready();
    for(const fieldId of bindings(root('recordForm'))){const field=plan.entity.fields.find(f=>f.semanticId===fieldId);
      const value=fieldId===cardFields[0]?'Drag proof title':field.presentation==='singleChoice'?field.options[0]:field.presentation==='date'?'2026-09-06':'Preserved detail';
      await fill(`[name="${fieldId}"]`,value);
    }
    await evaluate("document.querySelector('#record-form').requestSubmit()");await ready();
    let initial=(await snapshot()).records[0];const recordId=initial.recordId;
    const groupField=groupBy,titleField=cardFields[0],first=groups[0],second=groups[1];
    const current=async()=> (await snapshot()).records.find(r=>r.recordId===recordId);
    await pointerDrag(recordId,second);
    await waitFor(async()=>(await current()).values[groupField]===second,'durable pointer drop');
    assert((await current()).recordVersion===2,'Drop must save once.');
    assert((await current()).values[titleField]===initial.values[titleField],'Drop changed title.');
    await pointerDrag(recordId,second);
    assert((await current()).recordVersion===2,'Same-column drop created a revision.');
    await pointerDrag(recordId,first,undefined,true);
    assert((await current()).recordVersion===2,'Escape did not cancel the move.');
    await click('#nav-history');await ready();const history=await host('history.get');
    await click(`[data-compensate="${history.at(-1).revisionId}"]`);await ready();
    assert((await current()).values[groupField]===first,'Drop could not be compensated.');
    await useBoard();
    // A fabricated external drop has no renderer-owned drag session.
    await evaluate(`(()=>{const target=document.querySelector('.board-column');const data=new DataTransfer();data.setData('application/x-nendo-record',${JSON.stringify(recordId)});target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
    assert((await current()).recordVersion===3,'External drop mutated data.');
    // A real stale snapshot must be rejected by the same per-record version gate.
    await host('data.setField',{entityId:initial.entityId,recordId,fieldId:titleField,expectedRecordVersion:3,value:'Concurrent edit preserved',idempotencyKey:crypto.randomUUID()});
    await pointerDrag(recordId,second);
    assert((await current()).values[groupField]===first&&(await current()).values[titleField]==='Concurrent edit preserved','Stale drag overwrote concurrent data.');
    await refresh();await useBoard();
    for(const theme of ['light','dark']){
      await click(`[data-theme-option="${theme}"]`);await ready();
      await pointerDrag(recordId,theme==='light'?second:first,`drag-target-${theme}.png`);
      await screenshot(`drag-${theme}.png`);
    }
    await click(`[data-record-id="${recordId}"]`);await ready();await fill(`[name="${titleField}"]`,'Unsaved text');
    const beforeDirty=await current();
    await pointerDrag(recordId,second);
    assert(JSON.stringify(await current())===JSON.stringify(beforeDirty),'Unsaved inspector allowed drag.');
    assert(await evaluate(`document.querySelector('[name="${titleField}"]').value==='Unsaved text'`),'Unsaved text was lost.');
    await click('#close-inspector');await ready();
    // Optional grouping must not hide records; Unicode and outer whitespace are data.
    const spacedTitle='  Keep æøå 🌱 spaces  ';
    await click('#new-record');await ready();
    await fill(`[name="${titleField}"]`,spacedTitle);
    await evaluate("document.querySelector('#record-form').requestSubmit()");await ready();
    const ungrouped=(await snapshot()).records.find(r=>r.values[titleField]===spacedTitle);
    assert(ungrouped,'Form trimmed the title.');
    assert(await evaluate("[...document.querySelectorAll('.board-column h3')].some(e=>e.textContent==='Ungrouped')"),'Unset status is hidden.');
    assert(await evaluate("document.querySelectorAll('.record-card').length===2"),'Board did not account for all records.');
    await click(`[data-record-id="${ungrouped.recordId}"]`);await ready();
    await evaluate("document.querySelector('#record-form').requestSubmit()");await ready();
    const noOp=(await snapshot()).records.find(r=>r.recordId===ungrouped.recordId);
    assert(noOp.recordVersion===ungrouped.recordVersion,'Untouched form changed data.');
    await click('#close-inspector');await ready();
    await pointerDrag(ungrouped.recordId,second);
    const assigned=(await snapshot()).records.find(r=>r.recordId===ungrouped.recordId);
    assert(assigned.values[groupField]===second&&assigned.values[titleField]===spacedTitle,'Ungrouped drag lost data.');
    const final=await snapshot();await fs.writeFile(path.join(output,'drag-state.json'),JSON.stringify({manifest:final.manifest,entities:final.entities,records:final.records,uiNodes:final.uiNodes}));
    await fs.writeFile(path.join(output,'drag-checks.json'),JSON.stringify({pointerDrop:true,sameColumnNoOp:true,compensation:true,externalDropIgnored:true,staleDropRejected:true,dirtyInspectorProtected:true,themes:['light','dark']},null,2));
  }else{
    const expected=JSON.parse(await fs.readFile(path.join(output,'drag-state.json'),'utf8')),actual=await snapshot();
    assert(JSON.stringify({manifest:actual.manifest,entities:actual.entities,records:actual.records,uiNodes:actual.uiNodes})===JSON.stringify(expected),'Drag state differed on fresh-process reopen.');
    await useBoard();await screenshot('drag-reopened.png');
  }
  assert(pageErrors.length===0,'Unhandled renderer exception.');
  console.log(`Drag ${phase}: passed`);
}finally{
  if(originalTheme){await click(`[data-theme-option="${originalTheme}"]`);await ready();}
  socket?.close();
}

