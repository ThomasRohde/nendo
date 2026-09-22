import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [port,pid,output,iterationText,launchedText,revisionsText,expectedExecutable]=process.argv.slice(2);
if(![port,pid,iterationText,launchedText,revisionsText].every(value=>/^\d+$/.test(value))||!output)throw new Error('Owned performance arguments are required.');
const iteration=Number(iterationText), startingRevisions=Number(revisionsText);
const toolsRoot=path.dirname(fileURLToPath(import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(value,message)=>{if(!value)throw new Error(message);};
let socket,id=0;
const pending=new Map(),errors=[],memory=[],samples=[];
async function until(read,label){const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await read();if(value)return value;await pause(25);}throw new Error(`30-second watchdog: ${label}`);}
function command(method,params={}){return new Promise((resolve,reject)=>{const serial=++id;const timer=setTimeout(()=>{pending.delete(serial);reject(new Error(`CDP watchdog: ${method}`));},30000);pending.set(serial,{resolve,reject,timer});socket.send(JSON.stringify({id:serial,method,params}));});}
async function evaluate(expression){const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
async function ready(){await until(()=>evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy')==='false'`),'settled Workbench');}
async function click(selector){await until(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled;})()`),`enabled ${selector}`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await ready();}
async function capture(name){await pause(250);assert(await evaluate(`document.querySelector('.header-controls').getBoundingClientRect().right<=innerWidth+1`),'Settled header must remain visible.');const value=await command('Page.captureScreenshot',{format:'png',fromSurface:true});await fs.writeFile(path.join(output,name),Buffer.from(value.data,'base64'));}
function sampleMemory(){const args=['-NoProfile','-File',path.join(toolsRoot,'Review-PerformanceMemory.ps1'),'-TargetProcessId',pid];if(expectedExecutable)args.push('-ExpectedExecutable',expectedExecutable);const result=spawnSync('pwsh',args,{encoding:'utf8',windowsHide:true,timeout:15000});assert(result.status===0,`Owned memory sample failed: ${result.stderr}`);const value=JSON.parse(result.stdout);memory.push(value);return value;}
const hook=`(()=>{
  const bridge=chrome.webview, send=bridge.postMessage.bind(bridge), requests=new Map();
  const meter=window.nendoPerformance={phase:'initial',responses:[],requests:[],pending:0};
  bridge.postMessage=message=>{const request={id:message.requestId,method:message.method,phase:meter.phase,sent:performance.now(),boundedRead:message.boundedRead===true};requests.set(request.id,request);meter.requests.push(request);meter.pending++;send(message);};
  bridge.addEventListener('message',event=>{let value=event.data;const bytes=new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)).length;if(typeof value==='string')value=JSON.parse(value);const request=requests.get(value.requestId);if(!request)return;requests.delete(value.requestId);meter.pending--;meter.responses.push({...request,received:performance.now(),elapsed:performance.now()-request.sent,bytes,ok:value.ok,code:value.error?.code??null,sequence:value.result?.mutation?.changeSequence??value.result?.changeSequence??value.result?.manifest?.changeSequence??null,items:Array.isArray(value.result?.items)?value.result.items.length:null,records:Array.isArray(value.result?.records)?value.result.records.length:null});});
})()`;
const rpc=async(method,payload={})=>evaluate(`new Promise((resolve,reject)=>{const bridge=chrome.webview;const request={protocolVersion:5,requestId:crypto.randomUUID(),method:${JSON.stringify(method)},payload:${JSON.stringify(payload)},fileSessionId:window.performanceFileSession,boundedRead:true};const listener=event=>{const response=typeof event.data==='string'?JSON.parse(event.data):event.data;if(response.requestId!==request.requestId)return;bridge.removeEventListener('message',listener);response.ok?resolve(response.result):reject(new Error(response.error.code));};bridge.addEventListener('message',listener);bridge.postMessage(request);})`);
function summarize(values){const sorted=[...values].sort((a,b)=>a-b);return{samples:values,min:sorted[0]??null,max:sorted.at(-1)??null,p50:sorted[Math.ceil(sorted.length*.5)-1]??null,p95:sorted[Math.ceil(sorted.length*.95)-1]??null};}
let startupMilliseconds,runtime,initialBridgeBytes;
const startupTimeline = { driverStartedMilliseconds: Date.now()-Number(launchedText) };
try{
  const target=await until(async()=>{try{const rows=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());const found=rows.filter(row=>row.type==='page'&&row.url==='https://app.nendo.local/index.html');return found.length===1?found[0]:null;}catch{return null;}},'owned WebView');
  startupTimeline.webViewDiscoveredMilliseconds=Date.now()-Number(launchedText);
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);});
  await command('Runtime.enable');await command('Page.enable');runtime=await command('Browser.getVersion');
  startupTimeline.protocolReadyMilliseconds=Date.now()-Number(launchedText);
  await until(()=>evaluate(`!!document.querySelector('[data-testid="semantic-application"]')&&document.querySelector('#studio-content')?.getAttribute('aria-busy')==='false'`),'initial usable custom view');
  startupMilliseconds=Date.now()-Number(launchedText);sampleMemory();
  await command('Page.addScriptToEvaluateOnNewDocument',{source:hook});
  await command('Page.reload',{ignoreCache:false});
  await until(()=>evaluate(`!!window.nendoPerformance&&!!document.querySelector('[data-testid="semantic-application"]')&&document.querySelector('#studio-content')?.getAttribute('aria-busy')==='false'&&window.nendoPerformance.pending===0`),'instrumented initial view');
  const initial=await evaluate(`window.nendoPerformance.responses.filter(row=>row.phase==='initial')`);
  initialBridgeBytes=initial.reduce((sum,row)=>sum+row.bytes,0);
  assert(initial.some(row=>row.method==='data.queryRecords'&&row.items===50),'Initial view did not load a 50-record window.');
  assert(initial.every(row=>row.ok&&row.boundedRead),'Initial view used an unbounded or failed request.');
  assert(!initial.some(row=>row.method==='session.getRecentFiles'),'Open-file startup scanned an unused recent-file list.');
  await evaluate(`window.nendoPerformance.phase='verification'`);
  const metadata=await rpc('session.getSnapshot');
  await evaluate(`window.performanceFileSession=${JSON.stringify(metadata.fileSessionId)}`);
  assert(metadata.records.length===0&&metadata.manifest.changeSequence===startingRevisions-1,'Fixture or metadata projection differs from declared starting state.');
  sampleMemory();
  if(iteration===2){
    await click('#nav-data');
    await until(()=>evaluate(`!!document.querySelector('.ag-row[row-id="record-00000"]')`),'first data row');
    for(let index=-3;index<20;index++){
      const phase='edit-'+index,value='Native measured title '+index;
      await evaluate(`window.nendoPerformance.phase=${JSON.stringify(phase)}`);
      const point=await evaluate(`(()=>{const cell=document.querySelector('.ag-row[row-id="record-00000"] .ag-cell[col-id="field.decision.title"]');cell.scrollIntoView({block:'nearest',inline:'nearest'});const r=cell.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'F2',code:'F2',windowsVirtualKeyCode:113});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'F2',code:'F2',windowsVirtualKeyCode:113});
      await until(()=>evaluate(`!!document.querySelector('.ag-cell-inline-editing input')`),'cell editor');
      await evaluate(`(()=>{const input=document.querySelector('.ag-cell-inline-editing input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      const measured=await until(()=>evaluate(`(()=>{const meter=window.nendoPerformance, rows=meter.responses.filter(row=>row.phase===${JSON.stringify(phase)}),receipt=rows.find(row=>row.method==='data.setField');const cell=document.querySelector('.ag-row[row-id="record-00000"] .ag-cell[col-id="field.decision.title"]');if(!receipt||meter.pending||document.querySelector('#studio-content')?.getAttribute('aria-busy')!=='false'||cell?.textContent!==${JSON.stringify(value)})return null;return{receiptMilliseconds:receipt.elapsed,settledMilliseconds:performance.now()-receipt.sent,bridgeBytes:rows.reduce((sum,row)=>sum+row.bytes,0),responses:rows};})()`),'saved and refreshed cell');
      assert(measured.responses.every(row=>row.ok),'Measured edit/refresh failed.');
      assert(measured.responses.some(row=>row.method==='data.queryRecords'&&row.items===50),'Edit did not refresh its 50-record window.');
      const usage=sampleMemory();
      if(index>=0)samples.push({index,...measured,memory:usage});
    }
    await evaluate(`window.nendoPerformance.phase='verification'`);
    await click('[data-record-page="1"]');
    assert(await evaluate(`document.querySelector('.page-controls')?.textContent.includes('Page 2')`),'Record Next did not advance.');
    assert(!await evaluate(`!!document.querySelector('.ag-row[row-id="record-00000"]')`),'Record continuation duplicated the first row.');
    await click('[data-record-page="-1"]');
    for(const theme of ['light','dark']){await click('[data-theme-option="'+theme+'"]');await capture('data-'+theme+'.png');}
    await click('#nav-history');await click('[data-history-page="1"]');await click('[data-history-page="-1"]');
    await click('[data-history-detail]');assert(await evaluate(`document.querySelectorAll('.operation-details li').length>0`),'History operation details missing.');
    await capture('history-dark.png');
    const current=await rpc('session.getSnapshot');
    assert(current.manifest.changeSequence===startingRevisions-1+23,'Measured edits did not create exactly 23 revisions.');
    const records=await rpc('data.queryRecords',{entityId:'entity.decision',limit:50});
    assert(records.items[0].values['field.decision.title']==='Native measured title 19','Final typed record differs from UI.');
  }
  assert(errors.length===0,'The renderer reported an unhandled exception.');
  const receiptMilliseconds=summarize(samples.map(row=>row.receiptMilliseconds)),settledMilliseconds=summarize(samples.map(row=>row.settledMilliseconds));
  const peakPrivateBytes=Math.max(...memory.map(row=>row.privateBytes));
  const report={status:'measured',iteration,startupMilliseconds,startupTimeline,runtime,initialBridgeBytes,initialResponses:initial,
    initialVolumeScope:'Actual JSON envelopes measured on a renderer reload after process startup; no IPC framing included',
    startupScope:'Fresh Desktop process launch to first usable custom view, including connection polling; warm/uncontrolled OS cache',
    recordField:'field.decision.title',warmupEdits:iteration===2?3:0,measuredEdits:samples.length,samples,receiptMilliseconds,settledMilliseconds,
    memory,peakPrivateBytes,memoryScope:'Owned Desktop and descendant process samples after startup/reload/each edit; not continuous allocation tracking',
    thresholds:{startup:startupMilliseconds<=5000,initialBridge:initialBridgeBytes<=1024*1024,memory:peakPrivateBytes<=1024*1024*1024,
      receipt:samples.length?receiptMilliseconds.p95<=500:null,settled:samples.length?settledMilliseconds.p95<=750:null,
      editBridge:samples.length?samples.every(row=>row.bridgeBytes<=256*1024):null}};
  await fs.writeFile(path.join(output,'desktop-'+iteration+'.json'),JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify({result:'measured',iteration,startupMilliseconds,initialBridgeBytes,peakPrivateBytes,thresholds:report.thresholds})+'\n');
}catch(error){await fs.writeFile(path.join(output,'desktop-'+iteration+'-failed.json'),JSON.stringify({status:'failed',error:String(error.stack??error),startupMilliseconds,startupTimeline,runtime,initialBridgeBytes,samples,memory,errors},null,2));throw error;}
finally{socket?.close();}
