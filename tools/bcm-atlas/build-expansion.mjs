// Prepare additive typed-record batches; this script never writes to Nendo.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {hierarchy} from '../../extensions/bcm-atlas/model.js';
import {engineTree} from './engine-tree.mjs';
import {labOptions} from '../../extensions/bcm-atlas/layout-profile.js';
import {expandCatalogue} from './northstar.mjs';
const before=JSON.parse(fs.readFileSync('artifacts/bcm-atlas/before-expansion.json','utf8'));
const existing=before['bcm.capability'];
const all=[...existing], additions=[];
additions.push(...expandCatalogue(existing));all.push(...additions);
const h=hierarchy(engineTree(all));
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../../extensions/bcm-atlas/layout.js',import.meta.url),'utf8'),ctx);
const start=performance.now();const layout=ctx.window.BcmLayout.layoutBcm(h.roots.map(h.tree),labOptions);const ms=performance.now()-start;
assert.equal(ctx.window.BcmLayout.validateBcmLayout(layout).length,0);
assert.equal(layout.nodes.filter(n=>!n.synthetic).length,all.length);
const levels={};for(const r of additions){const depth=r.values['cap.code'].split('.').length;(levels[depth]??=[]).push(r);}
const batches=[];for(const level of Object.values(levels))for(let i=0;i<level.length;i+=50)batches.push(level.slice(i,i+50));
const summary={before:existing.length,added:additions.length,total:all.length,roots:h.roots.length,leaves:all.filter(r=>!h.children.get(r.recordId).length).length,maxDepth:Math.max(...all.map(r=>r.values['cap.code'].split('.').length)),batches:batches.length,layoutMs:Math.round(ms),layoutErrors:0};
fs.writeFileSync('artifacts/bcm-atlas/expansion-batches.json',JSON.stringify(batches)+'\n');
fs.writeFileSync('artifacts/bcm-atlas/expansion-summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
