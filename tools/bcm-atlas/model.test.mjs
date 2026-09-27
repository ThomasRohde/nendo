import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {hierarchy,projectHierarchy,gap} from '../../extensions/bcm-atlas/model.js';
import {engineTree} from './engine-tree.mjs';
import {labOptions} from '../../extensions/bcm-atlas/layout-profile.js';
import {starterSeed,northstarModel} from './northstar.mjs';
const r=(id,parent=null)=>({recordId:id,values:{'cap.name':id,'cap.parent':parent}});
test('the map takes the tree as the Engine gives it, repairing and sorting nothing',()=>{
  // Deliberately not in Display order: the Engine's order is the answer, and the model keeps it.
  const nodes=[{record:r('b'),parentRecordId:null},{record:r('b2','b'),parentRecordId:'b'},{record:r('b1','b'),parentRecordId:'b'},{record:r('a'),parentRecordId:null}];
  const h=hierarchy(nodes);
  assert.deepEqual(h.roots.map(x=>x.recordId),['b','a']);
  assert.deepEqual(h.children.get('b').map(x=>x.recordId),['b2','b1']);
  assert.equal(h.parents.get('b1'),'b');
  assert.deepEqual(h.records.map(x=>x.recordId),['b','b2','b1','a']);
  assert.deepEqual(h.descendants('b').map(x=>x.recordId),['b2','b1']);
  assert.equal('issues' in h,false,'nothing is repaired, so nothing is reported');
});
test('the stand-in for the Engine refuses what declaring the hierarchy refuses',()=>{
  assert.throws(()=>engineTree([r('a','b'),r('b','a')]),/loop/);
  assert.throws(()=>engineTree([r('c','missing')]),/not there/);
  const o=(id,parent,order)=>({recordId:id,values:{'cap.name':id,'cap.parent':parent,'cap.order':order}});
  assert.deepEqual(engineTree([o('z',null,null),o('y',null,2),o('x',null,1),o('w',null,1)]).map(n=>n.record.recordId),['w','x','y','z']);
});
test('unassessed is missing, and a target below current is a negative gap',()=>{assert.equal(gap(r('a')),null);assert.equal(gap({values:{'cap.maturity':4,'cap.target':3}}),-1);});
test('level limits preserve ancestors, uneven branches and focused-group navigation',()=>{
  const records=[r('a'),r('b','a'),r('c','b'),r('d','c'),r('e','a'),r('f')];
  const original=JSON.stringify(records),h=hierarchy(engineTree(records));
  const one=projectHierarchy(h,null,1),two=projectHierarchy(h,null,2);
  assert.deepEqual(one.rows.map(x=>x.record.recordId),['a','f']);
  assert.deepEqual(two.rows.map(x=>x.record.recordId),['a','b','e','f']);
  assert.equal(two.hiddenCounts.get('b'),2);
  assert.deepEqual(two.tree[0].children[0].children,[]);
  assert.deepEqual(projectHierarchy(h,'b',1).rows.map(x=>x.record.recordId),['b','c']);
  assert.equal(projectHierarchy(h,'b',1).maxDepth,2);
  assert.deepEqual(projectHierarchy(h,null).tree,h.roots.map(h.tree));
  assert.equal(JSON.stringify(records),original,'Filtering must never rewrite stored parent links');
  assert.deepEqual(projectHierarchy(hierarchy([]),null,2).tree,[]);
});
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../../extensions/bcm-atlas/layout.js',import.meta.url),'utf8'),ctx);const api=ctx.window.BcmLayout;
test('original reference self-tests',()=>{const result=api.runBcmLayoutSelfTests();assert.equal(result.passed,10,JSON.stringify(result));});
test('starter model: every capability visible, fixed leaves, no overlaps in both modes and portrait/landscape',()=>{const seed=starterSeed().filter(r=>r.entityId==='bcm.capability');const h=hierarchy(engineTree(seed));for(const mode of ['compact','ordered'])for(const aspectRatio of [.65,1.4,2.4]){const result=api.layoutBcm(h.roots.map(h.tree),{...labOptions,mode,aspectRatio});assert.equal(result.nodes.filter(n=>!n.synthetic).length,60);assert.equal(api.validateBcmLayout(result).length,0);for(const n of result.nodes.filter(n=>n.isLeaf)){assert.equal(n.width,160);assert.equal(n.height,56);}}});
test('shipped Northstar model: 635 capabilities in five levels, no cycles or orphans',()=>{const model=northstarModel();const caps=model['bcm.capability'];assert.equal(caps.length,635);assert.equal(new Set(caps.map(r=>r.recordId)).size,635);const h=hierarchy(engineTree(caps));assert.equal(projectHierarchy(h,null).maxDepth,5);assert.deepEqual([1,2,3,4,5,Infinity].map(n=>projectHierarchy(h,null,n).rows.length),[6,48,267,599,635,635]);assert.deepEqual(['bcm.application','bcm.support','bcm.initiative'].map(e=>model[e].length),[8,8,6]);});
