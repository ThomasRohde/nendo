import assert from 'node:assert/strict';
import fs from 'node:fs';
import {frame,evaluate,main,command,waitFor,close} from './cdp.mjs';
const checks=[];
const check=(ok,message)=>{assert.ok(ok,message);checks.push(message);console.log('PASS '+message);};
let f,originalTheme;
try {
  f=await frame();const run=expression=>evaluate(f,expression);
  await waitFor(()=>run(`document.querySelectorAll('.cap').length>0`),'map');
  await run(`document.querySelector('#breadcrumbs button').click();document.querySelector('[data-level="2"]').click();document.querySelector('#fit').click()`);
  originalTheme=await evaluate(main,`document.querySelector('[data-theme-option][aria-pressed="true"]')?.dataset.themeOption`);
  const offset=await evaluate(main,`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.left,y:r.top};})()`);
  const point=selector=>run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(10,r.height/2)};})()`);
  const mouse=(type,p,modifiers=0,down=false)=>command('Input.dispatchMouseEvent',{type,x:p.x+offset.x,y:p.y+offset.y,button:type==='mouseMoved'?'none':'left',buttons:down?1:0,clickCount:type==='mouseMoved'?0:1,modifiers},main);
  const drag=async(p,dx,dy,modifiers)=>{await mouse('mouseMoved',p,modifiers);await mouse('mousePressed',p,modifiers,true);await mouse('mouseMoved',{x:p.x+dx,y:p.y+dy},modifiers,true);await mouse('mouseReleased',{x:p.x+dx,y:p.y+dy},modifiers);};
  const translation=()=>run(`(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('#drawing')).transform);return {x:m.e,y:m.f,z:m.a,selection:document.querySelector('.cap.selected')?.dataset.id};})()`);
  for(const theme of ['light','dark']) {
    await evaluate(main,`document.querySelector('[data-theme-option="${theme}"]').click()`);
    await waitFor(()=>run(`document.documentElement.dataset.nendoTheme==='${theme}'`),theme);
    await run(`document.querySelector('#fit').click();document.querySelector('[data-id="bcm-cap-1"]').click()`);
    let before=await translation();
    await drag(await point('[data-id="bcm-cap-6-4"]'),80,35,2);
    let after=await translation();
    check(Math.abs(after.x-before.x-80)<.1&&Math.abs(after.y-before.y-35)<.1,`${theme}: Ctrl-drag starting on a capability pans exactly 80px / 35px (actual ${(after.x-before.x).toFixed(1)} / ${(after.y-before.y).toFixed(1)})`);
    check(after.selection===before.selection&&after.z===before.z,`${theme}: panning preserves selection and zoom`);
    before=await translation();
    const late=await point('[data-id="bcm-cap-6-4"]');
    await mouse('mousePressed',late,0,true);
    await mouse('mouseMoved',{x:late.x+45,y:late.y+20},2,true);
    await mouse('mouseReleased',{x:late.x+45,y:late.y+20},2);
    after=await translation();
    check(Math.abs(after.x-before.x-45)<.1&&Math.abs(after.y-before.y-20)<.1,`${theme}: pressing Ctrl after mouse-down pans 45px / 20px (actual ${(after.x-before.x).toFixed(1)} / ${(after.y-before.y).toFixed(1)})`);
    const p=await point('[data-id="bcm-cap-6-4"]');await mouse('mousePressed',p,0,true);await mouse('mouseReleased',p);
    check((await translation()).selection==='bcm-cap-6-4',`${theme}: ordinary click still selects after dragging`);
    before=await translation();await drag(await point('[data-id="bcm-cap-6-4"]'),25,15,0);after=await translation();
    check(after.x===before.x&&after.y===before.y,`${theme}: an unmodified card drag does not pan`);
    await run(`document.querySelector('#fit').click()`);
    const background=await run(`(()=>{const r=document.querySelector('#map').getBoundingClientRect();return {x:r.left+3,y:r.top+3};})()`);
    before=await translation();await drag(background,35,25,0);after=await translation();
    check(Math.abs(after.x-before.x-35)<.1&&Math.abs(after.y-before.y-25)<.1,`${theme}: background drag still pans without Ctrl`);
    check(await run(`!document.querySelector('#map').classList.contains('panning')`),`${theme}: releasing the mouse ends the drag state`);
  }
  fs.writeFileSync('artifacts/bcm-atlas/pan-results.json',JSON.stringify({checks},null,2)+'\n');
} finally {
  if(originalTheme)await evaluate(main,`document.querySelector('[data-theme-option="${originalTheme}"]').click()`);
  if(f)await evaluate(f,`document.querySelector('#fit')?.click()`);close();
}
