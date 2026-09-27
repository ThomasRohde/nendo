import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {frame,evaluate,main,waitFor,close} from './cdp.mjs';
const processId=process.argv[2];assert.match(processId||'',/^\d+$/,'Pass the PID of the visible BCM host');
let originalTheme,f;const checks=[];
try {
  f=await frame();const run=code=>evaluate(f,code);
  originalTheme=await evaluate(main,`document.querySelector('[data-theme-option][aria-pressed="true"]')?.dataset.themeOption`);
  await run(`document.querySelector('#breadcrumbs button').click();document.querySelector('[data-level="2"]').click()`);
  const camera=()=>run(`(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('#drawing')).transform);return {x:m.e,y:m.f,z:m.a,selection:document.querySelector('.cap.selected')?.dataset.id};})()`);
  for(const theme of ['light','dark']) {
    await evaluate(main,`document.querySelector('[data-theme-option="${theme}"]').click()`);
    await waitFor(()=>run(`document.documentElement.dataset.nendoTheme==='${theme}'`),theme);
    for(const gesture of ['Before','After','None','CursorOnly']) {
      await run(`document.querySelector('#fit').click();if(document.querySelector('#pan-tool').getAttribute('aria-pressed')==='true')document.querySelector('#pan-tool').click();document.querySelector('[data-id="bcm-cap-1"]').click()`);
      if(gesture==='None')await run(`document.querySelector('#pan-tool').click()`);
      const before=await camera();
      const viewport=await evaluate(main,`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.left,y:r.top,dpr:devicePixelRatio};})()`);
      const p=await run(`(()=>{const r=document.querySelector('[data-id="bcm-cap-6-4"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+10};})()`);
      execFileSync('pwsh',['-NoProfile','-File','extensions/bcm-atlas/review/native-drag.ps1','-ProcessId',processId,'-ClientCoordinates','-ClientX',String(viewport.x+p.x),'-ClientY',String(viewport.y+p.y),'-Dpr',String(viewport.dpr),'-ModifierTiming',gesture==='CursorOnly'?'Before':gesture,...(gesture==='CursorOnly'?['-CursorOnly']:[])],{stdio:'pipe',timeout:15000});
      const after=await camera(),dx=after.x-before.x,dy=after.y-before.y;
      assert.ok(Math.abs(dx-120/viewport.dpr)<1&&Math.abs(dy-60/viewport.dpr)<1,`${theme}/${gesture}: native pan delta ${dx.toFixed(1)} / ${dy.toFixed(1)}; expected ${(120/viewport.dpr).toFixed(1)} / ${(60/viewport.dpr).toFixed(1)}`);
      assert.equal(after.selection,before.selection);assert.equal(after.z,before.z);
      assert.equal(await run(`document.querySelector('#map').classList.contains('panning')`),false);
      const message=`${theme}/${gesture}: Windows drag moved ${dx.toFixed(1)} / ${dy.toFixed(1)} CSS px; selection and zoom retained; gesture ended`;
      checks.push(message);console.log('PASS '+message);
    }
  }
  fs.writeFileSync('artifacts/bcm-atlas/native-pan-results.json',JSON.stringify({checks},null,2)+'\n');
} finally {
  if(f)await evaluate(f,`if(document.querySelector('#pan-tool').getAttribute('aria-pressed')==='true')document.querySelector('#pan-tool').click();document.querySelector('#fit').click()`);
  if(originalTheme)await evaluate(main,`document.querySelector('[data-theme-option="${originalTheme}"]').click()`);
  close();
}
