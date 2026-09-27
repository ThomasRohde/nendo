import fs from 'node:fs';
import assert from 'node:assert/strict';
import {frame,evaluate,main,command,waitFor,screenshot,close} from './cdp.mjs';
const results=[];
const check=(condition,message)=>{assert.ok(condition,message);results.push(message);console.log('PASS '+message);};
let originalTheme;
try {
  const f=await frame();
  await evaluate(f,'location.reload()');
  await waitFor(()=>evaluate(f,`document.querySelectorAll('.cap').length===48&&document.querySelector('[data-level="2"][aria-pressed="true"]')!==null`),'fresh two-level overview');
  originalTheme=await evaluate(main,`document.querySelector('[data-theme-option][aria-pressed="true"]')?.dataset.themeOption`);
  const run=code=>evaluate(f,code), choose=n=>run(`document.querySelector('[data-level="${n}"]').click()`);
  const records=await run('nendo.view.loadRecords()'),byId=new Map(records.map(r=>[r.recordId,r]));
  const depth=r=>r.values['cap.parent']?1+depth(byId.get(r.values['cap.parent'])):1;
  const ids=()=>run(`[...document.querySelectorAll('.cap')].map(n=>n.dataset.id).sort()`);
  check(await run(`document.querySelector('[data-level="2"]').getAttribute('aria-pressed')==='true'`),'The model opens at two levels');
  for(const theme of ['light','dark']) {
    await evaluate(main,`document.querySelector('[data-theme-option="${theme}"]').click()`);
    await waitFor(()=>run(`document.documentElement.dataset.nendoTheme==='${theme}'`),theme);
    for(const n of [1,2,3,4,5,Infinity]) {
      await choose(n);
      const expected=records.filter(r=>depth(r)<=n).map(r=>r.recordId).sort();
      assert.deepEqual(await ids(),expected);
      check(true,`${theme}: ${n===Infinity?'All':n} levels shows exactly ${expected.length} capabilities`);
    }
    await choose(2);await screenshot('bcm-levels-'+theme);
  }
  const collapsed=await run(`(()=>{const c=document.querySelector('[data-id="bcm-cap-6-4"]');c.click();const r=c.getBoundingClientRect();return {text:c.querySelector('.cap-count')?.textContent,selected:c.getAttribute('aria-pressed'),hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.cap')===c};})()`);
  check(collapsed.text==='15 inside'&&collapsed.selected==='true'&&collapsed.hit,'Collapsed Information security exposes its 15 descendants and remains selectable');
  await choose(1);
  await run(`document.querySelector('[data-id="bcm-cap-6"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  check((await ids()).length===8,'One level inside Enterprise enablement shows the context and seven immediate children');
  await run(`document.querySelector('[data-id="bcm-cap-6-4"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  check((await ids()).length===10,'A collapsed child can be focused again at one level');
  await run(`document.querySelector('#breadcrumbs button').click()`);await choose(2);
  await run(`{const s=document.querySelector('#search');s.value='Payroll calculation';s.dispatchEvent(new Event('input'));}`);
  check(await run(`document.querySelector('#status').textContent.includes('1 matches · 0 shown')`),'Search reports a matching capability below the visible depth');
  await choose(Infinity);
  check(await run(`document.querySelectorAll('.cap.matched').length===1`),'All levels reveals the deeper search result');
  await run(`{const s=document.querySelector('#search');s.value='';s.dispatchEvent(new Event('input'));}`);await choose(2);
  for(const mode of ['assessment','outline']) {
    await run(`document.querySelector('[data-mode="${mode}"]').click()`);
    check(await run(`document.querySelectorAll('#table tbody tr').length`)===48,`${mode} respects the two-level selection`);
  }
  await run(`document.querySelector('[data-mode="map"]').click()`);
  for(const width of [1600,900,600]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},main);
    await new Promise(r=>setTimeout(r,200));
    const geometry=await run(`(()=>{const r=document.querySelector('#levels').getBoundingClientRect(),p=document.querySelector('#pan-tool').getBoundingClientRect(),t=document.querySelector('.map-tools').getBoundingClientRect();return {right:r.right,width:innerWidth,panVisible:p.width>0&&p.left>=0&&t.right<=innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1};})()`);
    check(geometry.right<=geometry.width&&geometry.panVisible&&!geometry.overflow,`Level and Pan controls remain inside the viewport at width ${width}`);
  }
  fs.writeFileSync('artifacts/bcm-atlas/levels-results.json',JSON.stringify({results},null,2)+'\n');
} finally {
  if(originalTheme)await evaluate(main,`document.querySelector('[data-theme-option="${originalTheme}"]').click()`);
  await command('Emulation.clearDeviceMetricsOverride',{},main);close();
}
