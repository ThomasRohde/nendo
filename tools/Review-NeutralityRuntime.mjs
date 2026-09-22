import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, PID and output directory are required.');
const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const root = (app, kind) => app.surfaces.find(node => node.kind === kind);
const rootTitle = (app, kind) => { const node = root(app, kind); return node && (node.properties.title ?? node.properties.label); };
const bindings = (node) => node ? node.children.filter(child => child.kind === 'fieldBinding').map(child => child.properties.fieldId) : [];
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
function native(action, title, filename) {
  const args = ['-NoProfile', '-File', path.join(toolsRoot, 'Runtime-WorkbenchWindow.ps1'), '-TargetProcessId', processId, '-Action', action];
  if (title) args.push('-ExpectedTitle', title);
  if (filename) args.push('-FileName', filename);
  const result = spawnSync('pwsh', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert(result.status === 0, `Native ${action} failed: ${result.stderr || result.stdout}`);
}
function pickDirectory(selected) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsRoot, 'Runtime-SelectOwnedFile.ps1'),
    '-ProcessId', processId, '-FixtureRoot', output, '-SelectedPath', selected, '-Directory'], { encoding: 'utf8', windowsHide: true, timeout: 24000 });
  assert(result.status === 0, `Owned picker failed: ${result.stderr || result.stdout}`);
}
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
async function themes(label) {
  for (const theme of ['light','dark']) { await click(`[data-theme-option="${theme}"]`); await ready(); await screenshot(`${label}-${theme}.png`); }
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

async function enableMcp() {
  await click('#nav-agent'); await ready(); await click('[data-agent-mode="shapeApp"]'); await ready();
  const discoveryRoot = path.join(output,'device-state','discovery');
  const discovery = await waitFor(async()=>{
    let names;try{names=await fs.readdir(discoveryRoot);}catch{return null;}
    const found=[];
    for(const name of names.filter(n=>n.endsWith('.json'))){const d=JSON.parse(await fs.readFile(path.join(discoveryRoot,name),'utf8'));if(d.processId===Number(processId))found.push(d);}
    assert(found.length<=1,'Multiple discovery files for owned Desktop.');return found[0];
  },'owned local MCP discovery');
  const endpoint = new URL(discovery.endpoint);
  assert(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&endpoint.pathname==='/mcp','Unexpected discovery endpoint.');
  const { rpc, tool, headers } = createNendoMcpClient(discovery, 'nendo-review-holdout');
  await rpc('server/discover');
  const lease=await tool('nendo.lease.acquire');
  return {rpc,tool,lease,endpoint,headers};
}
const op=(operationType,payload)=>({operationType,payload});
const property=(surfaceId,nodeId,propertyName,value)=>op('ui.setProperty',{surfaceId,nodeId,propertyName,value});
function holdoutDefinition(entity,record) {
  const entityId=entity.entityId,titleId=entity.fields[0].fieldId,statusId='field.holdout.readiness';
  const ops=[op('schema.addField',{entityId,fieldId:statusId,displayName:'Readiness',storageKind:'Text',required:false,presentation:'singleChoice',options:['Collected','Catalogued']})];
  const bind=(role,fieldId,position)=>{const surfaceId=`surface.holdout.${role}`,nodeId=`node.holdout.${role}.field${position}`;ops.push(op('ui.addNode',{surfaceId,nodeId,parentNodeId:`node.holdout.${role}`,kind:'fieldBinding',position}),property(surfaceId,nodeId,'fieldId',fieldId));};
  for(const [role,kind,title] of [['form','recordForm','Specimen details'],['list','recordList','Collected specimens'],['board','boardSurface','Specimen register']]){
    const surfaceId=`surface.holdout.${role}`,nodeId=`node.holdout.${role}`;
    ops.push(op('ui.addNode',{surfaceId,nodeId,parentNodeId:null,kind,position:0}),property(surfaceId,nodeId,'definitionVersion',3),property(surfaceId,nodeId,'entityId',entityId),property(surfaceId,nodeId,'title',title));
    bind(role,titleId,0);if(role!=='board')bind(role,statusId,1);
    if(role==='board')ops.push(property(surfaceId,nodeId,'groupByFieldId',statusId));
  }
  const surfaceId='surface.holdout.command',nodeId='node.holdout.command';
  ops.push(op('ui.addNode',{surfaceId,nodeId,parentNodeId:null,kind:'recordCommand',position:0}));
  for(const [key,value] of Object.entries({definitionVersion:3,entityId,label:'Catalogue specimen'}))ops.push(property(surfaceId,nodeId,key,value));
  const stepId=`${nodeId}.step`;
  ops.push(op('ui.addNode',{surfaceId,nodeId:stepId,parentNodeId:nodeId,kind:'commandStep',position:0}));
  for(const [key,value] of Object.entries({fieldId:statusId,valueKind:'literal',value:'Catalogued'}))ops.push(property(surfaceId,stepId,key,value));
  return {definition:ops,data:[op('data.setField',{entityId,recordId:record.recordId,fieldId:statusId,expectedRecordVersion:record.recordVersion,value:'Collected'})]};
}
async function propose(client,key,title,definition,data=[]) {
  const common={applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId};
  const begun=await client.tool('nendo.change_set.begin',{...common,title,idempotencyKey:`${key}-begin`});
  for(let i=0;i<definition.length;i+=16)await client.tool('nendo.change_set.add_operations',{...common,changeSetId:begun.changeSetId,idempotencyKey:`${key}-add-${i}`,mutations:[{description:title,operations:definition.slice(i,i+16)}]});
  if(data.length)await client.tool('nendo.change_set.add_operations',{...common,changeSetId:begun.changeSetId,idempotencyKey:`${key}-data`,mutations:[{description:'Place the retained record in its initial group',operations:data}]});
  const preview=await client.tool('nendo.change_set.validate',{...common,changeSetId:begun.changeSetId,idempotencyKey:`${key}-validate`});
  assert(String(preview.state).toLowerCase()==='previewable'||preview.state===3,`${key}: invalid proposal ${JSON.stringify(preview.diagnostics)}`);
  return preview;
}
async function acceptAgent(preview) {
  await refresh(); await click('#nav-agent'); await ready();
  await click(`[data-review-agent-proposal="${preview.proposalId}"]`); await ready();
  await themes('holdout-proposal');
  await click('#accept-agent-proposal'); await ready();
  const receipt=await host('proposal.getReceipt',{proposalId:preview.proposalId});
  assert(receipt.changeSetDigest===preview.operationDigest,'Host accepted a different operation digest.');
}
async function shapeHoldout(first,second,firstRecord) {
  const client=await enableMcp();
  const urls=['manifest','entities',`entity/${first.entityId}/schema`,`entity/${first.entityId}/records?limit=50`,'surfaces','history?limit=50','health'].map(uri=>'nendo://application/'+uri);
  for(const uri of urls){const r=await client.rpc('resources/read',{uri});assert(r.contents?.length===1,'Missing resource response.');}
  const historyResource=await client.rpc('resources/read',{uri:'nendo://application/history?limit=50'});
  const revision=JSON.parse(historyResource.contents[0].text).items.find(row=>row.operationCount>0);
  assert(revision?.operationsUri,'History summary lacks its operation detail locator.');
  const operationResource=await client.rpc('resources/read',{uri:revision.operationsUri+'?limit=1'});
  assert(JSON.parse(operationResource.contents[0].text).items.length===1,'Eighth resource did not return a bounded operation page.');
  const tools=await client.rpc('tools/list');assert(!tools.tools.some(t=>/promot|accept/.test(t.name)),'MCP grants host acceptance.');
  const authored=holdoutDefinition(first,firstRecord);
  await fs.writeFile(path.join(output,'holdout-definition.json'),JSON.stringify(authored,null,2));
  const before=await snapshot();
  const preview=await propose(client,'author-holdout','Organise specimens by readiness',authored.definition,authored.data);
  assert((await snapshot()).manifest.changeSequence===before.manifest.changeSequence,'Agent validation mutated active file.');
  await acceptAgent(preview);
  const after=await snapshot();
  assert(after.manifest.applicationId===before.manifest.applicationId&&after.manifest.instanceId===before.manifest.instanceId,'Promotion replaced file identity.');
  assert(after.records.find(r=>r.recordId===firstRecord.recordId).values[first.fields[0].fieldId]==='Basalt fragment','Authoring lost original data/binding.');
  const extra=await client.tool('nendo.data.create_record',{applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId,entityId:first.entityId,recordId:'holdout-second',values:{[first.fields[0].fieldId]:'Feldspar chip','field.holdout.readiness':'Collected'},idempotencyKey:'holdout-create'});
  const replay=await client.tool('nendo.data.create_record',{applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId,entityId:first.entityId,recordId:'holdout-second',values:{[first.fields[0].fieldId]:'Feldspar chip','field.holdout.readiness':'Collected'},idempotencyKey:'holdout-create'});
  assert(extra.revisionId===replay.revisionId,'MCP exact create repeated its effect.');
  await client.tool('nendo.data.set_field',{applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId,entityId:first.entityId,recordId:'holdout-second',fieldId:first.fields[0].fieldId,expectedRecordVersion:1,value:'Feldspar specimen',idempotencyKey:'holdout-edit'});
  await client.tool('nendo.data.execute_command',{applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId,commandId:'node.holdout.command',recordId:'holdout-second',expectedRecordVersion:2,idempotencyKey:'holdout-command'});
  const beforeReshape=await snapshot();
  const definition=[op('schema.addField',{entityId:first.entityId,fieldId:'field.holdout.catalogueNote',displayName:'Catalogue note',storageKind:'Text',required:false,presentation:'longText',options:[]}),
    op('ui.addNode',{surfaceId:'surface.holdout.form',nodeId:'node.holdout.form.note',parentNodeId:'node.holdout.form',kind:'fieldBinding',position:2}),
    property('surface.holdout.form','node.holdout.form.note','fieldId','field.holdout.catalogueNote'),
    property('surface.holdout.board','node.holdout.board','title','Specimens by readiness')];
  const reshape=await propose(client,'reshape-holdout','Add catalogue notes and clarify the board',definition);
  await client.tool('nendo.lease.release',{applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId});
  // A legitimate edit to another entity after clone creation must survive replay.
  const visit=beforeReshape.records.find(r=>r.entityId===second.entityId);
  await editCell(second,visit,'Visited again after preview');
  await acceptAgent(reshape);
  // Use has no board mode any more: the first compiled root is the default, so a
  // journey that means the board selects it. #show-board is the first board's alias.
  await refresh(); await click('#nav-use'); await ready();
  if (!await evaluate(`document.querySelector('#show-board')?.getAttribute('aria-pressed') === 'true'`)) {
    await click('#show-board'); await ready();
  }
  await waitFor(() => evaluate(`!!document.querySelector('.board-column')`), 'the board as the selected surface');
  await themes('holdout-board');
  const plan=await host('semantic.compile');
  const holdout=plan.applications[0];
  assert(rootTitle(holdout,'boardSurface')==='Specimens by readiness'&&bindings(root(holdout,'recordForm')).includes('field.holdout.catalogueNote'),'Reshape not reflected in same renderer.');
  await click(`[data-record-id="${firstRecord.recordId}"]`); await ready();
  await fill('[name="field.holdout.catalogueNote"]','Dense fine-grained sample');
  await evaluate(`document.querySelector('#record-form').requestSubmit()`); await ready();
  await click('[data-run-command]'); await ready(); await themes('holdout-form');
  await addRecord(second,'Separate visit after custom surfaces');
  await host('agent.setMode',{mode:'off'});
  const current=await snapshot();
  assert(current.records.find(r=>r.recordId===visit.recordId).values[second.fields[0].fieldId]==='Visited again after preview','Promotion lost post-clone unrelated edit.');
  assert(current.records.find(r=>r.recordId===firstRecord.recordId).values[first.fields[0].fieldId]==='Basalt fragment','Reshape or form save changed retained label.');
  assert(current.records.filter(r=>r.entityId===first.entityId).length===2&&current.records.filter(r=>r.entityId===second.entityId).length===2,'Wrong entity record counts.');
  let denied=false;try{await client.rpc('tools/list');}catch{denied=true;}assert(denied,'Disabled endpoint still works.');
  const canonical={manifest:current.manifest,entities:current.entities,records:current.records,uiNodes:current.uiNodes};
  await fs.writeFile(path.join(output,'expected-reopen.json'),JSON.stringify({canonical,first,second,fileSessionId},null,2));
  const closing=host('file.close'); await sleep(200);native('Close file','Close this file?');await closing;
  assert(!(await envelope('history.get',{},fileSessionId)).ok,'Old renderer generation still admitted after close.');
  assert(!(await snapshot()).hasFile,'Native close did not close file.');
  return {sequence:current.manifest.changeSequence,checkedResources:urls,proposalDigest:preview.operationDigest,reshapeDigest:reshape.operationDigest};
}
async function reopenEvidence(){
  const saved=JSON.parse(await fs.readFile(path.join(output,'expected-reopen.json'),'utf8'));
  const current=await snapshot();const canonical={manifest:current.manifest,entities:current.entities,records:current.records,uiNodes:current.uiNodes};
  assert(JSON.stringify(canonical)===JSON.stringify(saved.canonical),'Fresh process did not reopen exact typed state.');
  assert(current.fileSessionId!==saved.fileSessionId,'Reopen reused old file generation.');
  assert((await host('agent.getStatus')).mode==='off','Reopen enabled agent access.');
  assert(!(await envelope('history.get',{},saved.fileSessionId)).ok,'Old generation admitted in fresh host.');
  await click('#nav-use');await ready();await themes('holdout-offline-reopen');
  await selectEntity(saved.second);await themes('holdout-second-reopen');
  const report=JSON.parse(await fs.readFile(path.join(output,'report.json'),'utf8'));report.checks.push('Fresh-process offline reopen preserves exact typed state, entities, bindings, data and revisions; old generation refused; agent stays off');
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({result:'reopen-passed',evidence:output,finalSequence:current.manifest.changeSequence}));
}


async function referenceJourney(name,reopen){
  const recordPath=path.join(output,`reference-${name}.json`);
  if(reopen){
    const saved=JSON.parse(await fs.readFile(recordPath,'utf8'));const current=await snapshot();
    assert(JSON.stringify({manifest:current.manifest,entities:current.entities,records:current.records,uiNodes:current.uiNodes})===JSON.stringify(saved.expected),'Reference fresh-process state differs.');
    assert(current.fileSessionId!==saved.fileSessionId&&(await host('agent.getStatus')).mode==='off','Reference authority was reused.');
    assert(!(await envelope('history.get',{},saved.fileSessionId)).ok,'Reference old renderer generation admitted.');
    await click('#nav-use');await ready();await themes(`reference-${name}-reopen`);
    saved.reopen='passed';await fs.writeFile(recordPath,JSON.stringify(saved,null,2));
    console.log(JSON.stringify({result:`${name}-reopen-passed`,evidence:output,finalSequence:current.manifest.changeSequence}));return;
  }
  assert((await snapshot()).entities.length===0,'Reference must start empty.');
  if(name==='idea'){
    await click('#start-application');await ready();await click('#reject-proposal');await ready();
    assert((await snapshot()).entities.length===0,'Reference rejection changed state.');
    await click('#start-application');await ready();await click('#accept-proposal');await ready();
  }else{
    const f=JSON.parse(await fs.readFile(path.join(toolsRoot,'..','fixtures','decision-log','expected-shape.json'),'utf8'));
    const entityId=f.entity.entityId,operations=[op('schema.createEntity',{entityId,displayName:f.entity.displayName})];
    for(const field of f.entity.fields){const {physicalColumnName,...semantic}=field;operations.push(op('schema.addField',{entityId,...semantic}));}
    for(const [role,kind] of [['form','recordForm'],['list','recordList'],['board','boardSurface'],['timeline','timelineSurface'],['gallery','gallerySurface']]){
      const root=f[role];operations.push(op('ui.addNode',{surfaceId:root.surfaceId,nodeId:root.rootNodeId,parentNodeId:null,kind,position:0}));
      const bound=role==='board'?{groupByFieldId:root.groupByFieldId}:role==='timeline'?{dateFieldId:root.dateFieldId,endDateFieldId:root.endDateFieldId,titleFieldId:root.titleFieldId,accentFieldId:root.accentFieldId}:role==='gallery'?{titleFieldId:root.titleFieldId,accentFieldId:root.accentFieldId}:{};
      for(const [key,value] of Object.entries({definitionVersion:3,entityId,title:root.title,...bound}))operations.push(property(root.surfaceId,root.rootNodeId,key,value));
      for(const [position,fieldId]of(root.fieldIds??root.cardFieldIds).entries()){const nodeId=`node.reference.${role}.${position}`;operations.push(op('ui.addNode',{surfaceId:root.surfaceId,nodeId,parentNodeId:root.rootNodeId,kind:'fieldBinding',position}),property(root.surfaceId,nodeId,'fieldId',fieldId));}
    }
    // The front page is authored apart from the loop above, because it is the one
    // root that carries no entityId: the loop sets one on every root it builds, and
    // the host refuses that here. Each tile under it names the record type instead.
    const ov=f.overview;
    if(ov){
      operations.push(op('ui.addNode',{surfaceId:ov.surfaceId,nodeId:ov.rootNodeId,parentNodeId:null,kind:'overviewSurface',position:0}));
      for(const [key,value]of Object.entries({definitionVersion:3,title:ov.title,description:ov.description}))operations.push(property(ov.surfaceId,ov.rootNodeId,key,value));
      const countId=`${ov.rootNodeId}.count`;
      operations.push(op('ui.addNode',{surfaceId:ov.surfaceId,nodeId:countId,parentNodeId:ov.rootNodeId,kind:'summaryTile',position:0}));
      for(const [key,value]of Object.entries({entityId,aggregate:'count',title:ov.countTitle}))operations.push(property(ov.surfaceId,countId,key,value));
      const rangeId=`${ov.rootNodeId}.range`;
      operations.push(op('ui.addNode',{surfaceId:ov.surfaceId,nodeId:rangeId,parentNodeId:ov.rootNodeId,kind:'rangeTile',position:1}));
      for(const [key,value]of Object.entries({entityId,fieldId:ov.rangeFieldId,title:ov.rangeTitle}))operations.push(property(ov.surfaceId,rangeId,key,value));
      const recentId=`${ov.rootNodeId}.recent`;
      operations.push(op('ui.addNode',{surfaceId:ov.surfaceId,nodeId:recentId,parentNodeId:ov.rootNodeId,kind:'recentList',position:2}));
      for(const [key,value]of Object.entries({entityId,title:ov.recentTitle,limit:ov.recentLimit,orderByFieldId:ov.recentOrderByFieldId,orderDirection:'descending'}))operations.push(property(ov.surfaceId,recentId,key,value));
      for(const [position,fieldId]of ov.recentFieldIds.entries()){const nodeId=`node.reference.overview-recent.${position}`;operations.push(op('ui.addNode',{surfaceId:ov.surfaceId,nodeId,parentNodeId:recentId,kind:'fieldBinding',position}),property(ov.surfaceId,nodeId,'fieldId',fieldId));}
    }
    const c=f.command;operations.push(op('ui.addNode',{surfaceId:c.surfaceId,nodeId:c.nodeId,parentNodeId:null,kind:'recordCommand',position:0}));
    for(const [key,value]of Object.entries({definitionVersion:3,entityId,label:c.label}))operations.push(property(c.surfaceId,c.nodeId,key,value));
    const cStep=`${c.nodeId}.step`;operations.push(op('ui.addNode',{surfaceId:c.surfaceId,nodeId:cStep,parentNodeId:c.nodeId,kind:'commandStep',position:0}));
    for(const [key,value]of Object.entries({fieldId:c.fieldId,valueKind:'literal',value:c.value}))operations.push(property(c.surfaceId,cStep,key,value));
    const client=await enableMcp();const rejected=await propose(client,'decision-rejected','Review Decision Log',operations);
    await refresh();await click('#nav-agent');await ready();await click(`[data-review-agent-proposal="${rejected.proposalId}"]`);await ready();await click('#reject-agent-proposal');await ready();
    assert((await snapshot()).entities.length===0,'Decision rejection changed state.');
    const preview=await propose(client,'decision-accepted','Create Decision Log',operations);await acceptAgent(preview);
    await client.tool('nendo.lease.release',{applicationHandle: client.lease.applicationHandle, leaseId: client.lease.leaseId});await host('agent.setMode',{mode:'off'});await refresh();
  }
  const compile=await host('semantic.compile');const plan=compile.applications?.[0];
  assert(compile.isValid&&plan,'Reference custom definition did not compile.');
  await click('#nav-use');await ready();
  // A file with a front page opens on it, and the front page belongs to the file
  // rather than to a record type: there is nothing there to add a record to. The
  // record type is one step away in the same picker, which is where this journey
  // goes before it adds one.
  if(await evaluate(`!!document.querySelector('[data-testid="overview-page"]')`)){
    await evaluate(`(()=>{const s=document.querySelector('#use-entity');s.value=s.options[1].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await ready();
    await waitFor(()=>evaluate(`!document.querySelector('[data-testid="overview-page"]')`),'the record type behind the front page');
  }
  await click('#new-record');await ready();
  const fields=new Map(plan.entity.fields.map(field=>[field.semanticId,field]));const titleId=bindings(root(plan,'boardSurface'))[0];
  for(const fieldId of bindings(root(plan,'recordForm'))){const field=fields.get(fieldId);let value='';
    if(fieldId===titleId)value=`Current ${plan.entity.displayName} proof`;
    else if(field.presentation==='singleChoice')value=field.options[0];
    else if(field.presentation==='date')value='2026-09-05';
    else value=`Recorded ${field.displayName}`;
    await fill(`[name="${fieldId}"]`,value);
  }
  await evaluate(`document.querySelector('#record-form').requestSubmit()`);await ready();
  const created=(await snapshot()).records[0];assert(created.recordVersion===1,'Reference create version mismatch.');
  await click(`[data-record-id="${created.recordId}"]`);await ready();
  await fill(`[name="${titleId}"]`,`Current ${plan.entity.displayName} edited`);await evaluate(`document.querySelector('#record-form').requestSubmit()`);await ready();
  await click('[data-run-command]');await ready();
  const step=root(plan,'recordCommand').children.find(node=>node.kind==='commandStep');
  let current=await snapshot();assert(current.records[0].values[step.properties.fieldId]===step.properties.value,'Reference command did not use stored effect.');
  const history=await host('history.get');const last=history.at(-1);
  await click('#nav-history');await ready();await click(`[data-compensate="${last.revisionId}"]`);await ready();
  current=await snapshot();assert(current.records[0].values[step.properties.fieldId]===created.values[step.properties.fieldId]&&current.records[0].recordVersion===4,'Reference compensation failed.');
  assert(current.records[0].values[titleId]===`Current ${plan.entity.displayName} edited`,'Reference compensation lost a preceding edit.');
  await click('#nav-use');await ready();await themes(`reference-${name}`);
  const expected={manifest:current.manifest,entities:current.entities,records:current.records,uiNodes:current.uiNodes};
  await fs.writeFile(recordPath,JSON.stringify({scope:'Unpackaged real Desktop reference application',checks:['Generic preview/reject/host acceptance','Stored form create and edit','Stored command, shared history and compensation','Light/Dark','Native close and old generation refusal'],expected,fileSessionId,reopen:'pending'},null,2));
  const closing=host('file.close');await sleep(200);native('Close file','Close this file?');await closing;
  assert(!(await envelope('history.get',{},fileSessionId)).ok,'Reference old generation still works after close.');
  console.log(JSON.stringify({result:`${name}-passed`,evidence:output,finalSequence:current.manifest.changeSequence}));
}

try {
  await connect(); await command('Runtime.enable'); await ready();
  const phase=process.argv[5];
  if(phase.startsWith('idea')||phase.startsWith('decision')){await referenceJourney(phase.split('-')[0],phase.endsWith('-reopen'));}
  else if(phase==='reopen'){await reopenEvidence();} else {
  const initial = await snapshot();
  assert(initial.hasFile && initial.entities.length===0 && initial.records.length===0 && initial.uiNodes.length===0, 'Expected valid empty file.');
  await themes('empty-studio');
  await addType('Rejected sample',true);
  assert((await snapshot()).entities.length===0, 'Reject changed the empty file.');
  const first = await addType('Specimen');
  const firstRecord = await addRecord(first, 'Basalt fragment');
  const second = await addType('Visit');
  const secondRecord = await addRecord(second, 'Harbour transect');
  await editCell(second, secondRecord, 'Harbour transect revised');
  await selectEntity(first); await themes('schema-only-first');
  await selectEntity(second); await themes('schema-only-second');
  await click('#nav-structure'); await ready();
  await fill('#structure-entity', first.entityId); await ready();
  assert(await evaluate(`document.querySelector('.definition-title')?.textContent.includes(${JSON.stringify(first.entityId)})`), 'Structure did not follow entity selection.');
  await themes('every-entity-structure');
  const current = await snapshot();
  assert(current.entities.length===2 && current.records.length===2 && current.uiNodes.length===0, 'Schema-only journey installed unexpected application content.');
  assert(current.records.find(r=>r.entityId===first.entityId).values[first.fields[0].fieldId]==='Basalt fragment','Other-entity edit changed the first entity.');
  const holdout=await shapeHoldout(first,second,firstRecord);
  assert(pageErrors.length===0, 'Unhandled page exception.');
  await fs.writeFile(path.join(output,'state.json'),JSON.stringify({first,second,firstRecord,secondRecord,current},null,2));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({scope:'Real unpackaged Desktop Studio; no human or installed qualification',checks:['Empty file has no implicit schema, data or custom UI','Schema-only change review, reject and acceptance','Two entities use the same generic create/edit paths','Data and Structure select each entity','Light/Dark Studio evidence','No unhandled page exception','Eight MCP resource types read through actual stateful HTTP','MCP authors custom definitions and data; active state unchanged until host acceptance','MCP create/exact replay/edit/command uses shared generic services','Second MCP proposal reshapes existing app and preserves a post-clone unrelated edit','Workbench form and command use stored bindings; second entity stays editable with custom UI present','Old endpoint and renderer generation are invalidated on native close'],holdout,finalSequence:holdout.sequence},null,2));
  console.log(JSON.stringify({result:'passed',evidence:output,finalSequence:holdout.sequence}));
  }
} catch(error) { await screenshot('failure.png').catch(()=>{}); throw error; } finally { if(socket) socket.close(); }
