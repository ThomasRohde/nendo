import fs from 'node:fs';
import {frame,evaluate,close} from './cdp.mjs';
try {
  const f=await frame();
  const snapshot={};
  for(const entity of ['bcm.capability','bcm.application','bcm.support','bcm.initiative']) {
    snapshot[entity]=await evaluate(f,`nendo.records.queryAll({entityId:${JSON.stringify(entity)}},{max:10000})`);
  }
  fs.writeFileSync('artifacts/bcm-atlas/before-expansion.json',JSON.stringify(snapshot,null,2)+'\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(snapshot).map(([k,v])=>[k,v.length]))));
} finally { close(); }
