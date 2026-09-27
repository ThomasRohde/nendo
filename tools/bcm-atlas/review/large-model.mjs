import fs from 'node:fs';
import assert from 'node:assert/strict';
import {frame,evaluate,waitFor,screenshot,close} from './cdp.mjs';
import {hierarchy} from '../../../extensions/bcm-atlas/model.js';
const before=JSON.parse(fs.readFileSync('artifacts/bcm-atlas/before-expansion.json','utf8'));
const added=JSON.parse(fs.readFileSync('artifacts/bcm-atlas/expansion-batches.json','utf8')).flat();
const results=[];
const check=(condition,message)=>{assert.ok(condition,message);results.push(message);console.log('PASS '+message);};
try {
  const f=await frame(), live={};
  for(const entity of Object.keys(before))live[entity]=await evaluate(f,`nendo.records.queryAll({entityId:${JSON.stringify(entity)}},{max:10000})`);
  for(const [entity,records]of Object.entries(before)) {
    for(const r of records){const current=live[entity].find(c=>c.recordId===r.recordId);assert.ok(current);assert.deepEqual(current.values,r.values);assert.equal(current.version,r.version);}
    check(true,`${records.length} existing ${entity} records retain every value and version`);
  }
  const records=live['bcm.capability'];check(records.length===before['bcm.capability'].length+added.length,`${records.length} capabilities read back through typed services`);
  for(const r of added){const current=records.find(c=>c.recordId===r.recordId);assert.ok(current);for(const [key,value]of Object.entries(r.values))assert.equal(current.values[key]??null,value);}
  check(true,`All ${added.length} additions retain their specified values`);
  const h=hierarchy(records);check(h.issues.length===0,'No missing parents or cycles');
  await evaluate(f,`document.querySelector('#breadcrumbs button').click();document.querySelector('[data-level="Infinity"]')?.click()`);
  await waitFor(()=>evaluate(f,`document.querySelectorAll('.cap').length===${records.length}`),'complete map');
  check(true,`All ${records.length} capability cards render in the enterprise overview`);
  await screenshot('bcm-expanded-overview');
  const search=await evaluate(f,`(()=>{const start=performance.now(),s=document.querySelector('#search');s.value='Payroll calculation';s.dispatchEvent(new Event('input'));return {ms:performance.now()-start,matches:[...document.querySelectorAll('.cap.matched')].map(n=>n.dataset.id),visible:[...document.querySelectorAll('.cap:not(.dim)')].map(n=>n.dataset.id)};})()`);
  const payroll=records.find(r=>r.values['cap.name']==='Payroll calculation');
  check(search.matches.length===1&&search.matches[0]===payroll.recordId,'Search locates the new Payroll calculation capability');
  let p=payroll.recordId;while(p){assert.ok(search.visible.includes(p));p=h.parents.get(p);}
  check(true,`Search retains the full ancestor path (${Math.round(search.ms)} ms synchronous update)`);
  await evaluate(f,`{const s=document.querySelector('#search');s.value='';s.dispatchEvent(new Event('input'));document.querySelector('[data-id="bcm-cap-6"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));}`);
  const domainCount=1+h.descendants('bcm-cap-6').length;
  await waitFor(()=>evaluate(f,`document.querySelectorAll('.cap').length===${domainCount}`),'enterprise enablement scope');
  check(true,`Double-click focuses Enterprise enablement with all ${domainCount} descendants and root`);
  await screenshot('bcm-expanded-domain');
  await evaluate(f,`document.querySelector('[data-id="bcm-cap-6-6"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  const groupCount=1+h.descendants('bcm-cap-6-6').length;
  check(await evaluate(f,`document.querySelectorAll('.cap').length`)===groupCount,`Second drill-down shows all ${groupCount} Employee services capabilities`);
  await screenshot('bcm-expanded-detail');
  await evaluate(f,`document.querySelector('#breadcrumbs button').click();document.querySelector('[data-level="Infinity"]')?.click()`);
  check(await evaluate(f,`document.querySelectorAll('.cap').length`)===records.length,'Enterprise breadcrumb restores the full model');
  fs.writeFileSync('artifacts/bcm-atlas/large-model-results.json',JSON.stringify({results,records:records.length,searchMs:search.ms},null,2)+'\n');
} finally { close(); }
