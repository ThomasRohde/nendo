import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
const version=await(await fetch('http://127.0.0.1:49321/json/version')).json();
const socket=new WebSocket(version.webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
export const events=[];
let id=0;const pending=new Map();socket.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.method)events.push(r);const p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.no(new Error(r.error.message)):p.ok(r.result);});
export function command(method,params={},sessionId){return new Promise((ok,no)=>{const next=++id,timer=setTimeout(()=>{pending.delete(next);no(new Error('Timed out '+method));},20000);pending.set(next,{ok,no,timer});socket.send(JSON.stringify({id:next,method,params,...(sessionId?{sessionId}:{})}));});}
export const targets=async()=> (await command('Target.getTargets')).targetInfos;
export const attach=async targetId=>(await command('Target.attachToTarget',{targetId,flatten:true})).sessionId;
export async function evaluate(session,expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
export async function waitFor(read,label,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await read();if(last)return last;}catch(e){last=e.message;}await new Promise(r=>setTimeout(r,150));}throw new Error('Timed out '+label+': '+JSON.stringify(last));}
export const main=await attach((await targets()).find(t=>t.type==='page'&&t.url.startsWith('https://app.nendo.local')).targetId);
// Every lane starts in Use, whatever screen the person left Nendo on, and writes under artifacts/bcm-atlas.
fs.mkdirSync('artifacts/bcm-atlas',{recursive:true});
await evaluate(main,`document.getElementById('nav-use')?.click()`);
await waitFor(()=>evaluate(main,`!!document.querySelector('[data-select-surface]')`),'Use screens');
export async function frame(){const t=await waitFor(async()=> (await targets()).find(t=>t.type==='iframe'&&t.url.includes('index.html')),'BCM frame');return attach(t.targetId);}
export async function bridge(method,payload={}){return evaluate(main,`(async()=>{if(!window.bcmBridge){window.bcmBridge=(method,payload={})=>new Promise((resolve,reject)=>{const requestId='bcm-review-'+crypto.randomUUID();const listener=event=>{const r=typeof event.data==='string'?JSON.parse(event.data):event.data;if(r.requestId!==requestId)return;chrome.webview.removeEventListener('message',listener);r.ok?resolve(r.result):reject(new Error(r.error.code+': '+r.error.message));};chrome.webview.addEventListener('message',listener);chrome.webview.postMessage({protocolVersion:7,requestId,fileSessionId:window.bcmSession,method,payload});});const snap=await bcmBridge('session.getSnapshot');window.bcmSession=snap.fileSessionId;}return bcmBridge(${JSON.stringify(method)},${JSON.stringify(payload)});})()`);}
export async function screenshot(name){const r=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},main);fs.writeFileSync(`artifacts/bcm-atlas/${name}.png`,Buffer.from(r.data,'base64'));}
export const close=()=>socket.close();
if(process.argv[2]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const code=fs.readFileSync(process.argv[2],'utf8');console.log(JSON.stringify(await evaluate(main,code),null,2));}finally{close();}}
