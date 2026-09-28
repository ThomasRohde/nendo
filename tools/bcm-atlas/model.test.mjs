import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {hierarchy,projectHierarchy,bindAtlas,relatedRow,relatedName,dropTarget,stepTarget} from '../../extensions/bcm-atlas/model.js';
import {bcmFixture,otherFixture} from './fixtures.mjs';
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
test('unassessed is missing, and a target below current is a negative gap',()=>{const {context,schema}=bcmFixture(),bound=bindAtlas(context,schema);assert.equal(bound.gap(r('a')),null);assert.equal(bound.gap({values:{'cap.maturity':4,'cap.target':3}}),-1);});
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

// W-077: the Atlas binds to the view that shows it, so nothing in the package names a record type
// or a field. Both files of the lane (fixtures.mjs) are bound here the way view.js binds them.
test('BCM binds every part through its view, and keeps its own words for the related sections',()=>{
  const {context,schema,records}=bcmFixture();
  const bound=bindAtlas(context,schema);
  assert.deepEqual(bound.problems,[]);
  assert.equal(bound.entityId,'bcm.capability');
  assert.deepEqual([bound.parentFieldId,bound.orderFieldId],['cap.parent','cap.order']);
  assert.deepEqual(Object.values(bound.fields).filter(fieldId=>fieldId===null),[],'BCM binds every part');
  assert.deepEqual(bound.choices.importance.map(c=>[c.displayName,c.tone]),[['Supporting','grey'],['Core','blue'],['Differentiating','violet']]);
  assert.deepEqual(bound.banner,{title:'NORTHSTAR / DEMONSTRATION MODEL',note:'Fictional data · replace with your organisation'});
  assert.deepEqual(bound.related.map(e=>[e.entityId,e.viaFieldId,e.farFieldId,e.title]),
    [['bcm.support','support.capability','support.application','Application support'],['bcm.initiative','initiative.capability',null,'Change portfolio']]);
  const [support,portfolio]=bound.related;
  const link=records['bcm.support'].find(x=>x.recordId==='bcm-support-3');
  assert.equal(relatedRow(support,link),'Strong fit · Primary','BCM’s support row lost the wording its configuration gives it');
  assert.equal(relatedName(support,link),records['bcm.application'].find(x=>x.recordId==='bcm-app-3').values['app.name']);
  const initiative=records['bcm.initiative'].find(x=>x.recordId==='bcm-initiative-2');
  assert.equal(relatedRow(portfolio,initiative),'Delivery · 2026-08-28');
  assert.equal(relatedName(portfolio,initiative),initiative.values['initiative.name']);
});
test('another file binds only what its view gives, and says what it did not bind',()=>{
  const {context,schema,records}=otherFixture();
  const bound=bindAtlas(context,schema);
  assert.equal(bound.entityId,'org.area');
  assert.deepEqual([bound.parentFieldId,bound.orderFieldId],['area.up','area.rank']);
  assert.deepEqual(bound.fields,{code:'area.key',description:null,owner:null,maturity:'area.level',target:null,importance:'area.focus',
    investment:null,lifecycle:'area.state',reviewed:null,evidence:null},'the status field is the lifecycle when the configuration names none');
  assert.deepEqual(bound.problems,['Definition is set to Notes, which this view does not bind. Bind Notes to the view, or take description out of its configuration.']);
  assert.equal(bound.banner,null);
  assert.equal(bound.choiceName('importance','edge'),'Edge');
  assert.equal(bound.tone('importance','edge'),'violet');
  assert.equal(bound.title(records['org.area'][0]),'Customers');
  assert.equal(bound.gap(records['org.area'][0]),null,'no target is bound, so there is no gap');
  assert.deepEqual(bound.related.map(e=>e.entityId),['org.use','org.project'],'The record types that refer to the area were not found in the schema');
  const [use,project]=bound.related;
  assert.deepEqual([use.entityId,use.farFieldId,use.title,project.entityId,project.labelFieldId,project.title,project.empty],
    ['org.use','use.system','System use','org.project','project.name','Project','None yet.']);
  const first=records['org.use'].find(x=>x.recordId==='use-1');
  assert.deepEqual([relatedName(use,first),relatedRow(use,first)],['Relay CRM','Good']);
  const relaunch=records['org.project'].find(x=>x.recordId==='project-1');
  assert.deepEqual([relatedName(project,relaunch),relatedRow(project,relaunch)],['Loyalty relaunch','Build']);
});
test('a part given the wrong field says what to bind, and binds nothing',()=>{
  const {context,schema}=otherFixture();
  const configured=fields=>bindAtlas({...context,configuration:{fields,related:{'org.system':{title:'Systems'}}}},schema);
  const bound=configured({maturity:'area.levl',importance:'area.lead',maturty:'area.level'});
  assert.equal(bound.fields.maturity,null);
  assert.equal(bound.fields.importance,null);
  assert.deepEqual(bound.problems,[
    'The configuration gives a field to "maturty", which is not a part of the Atlas. Its parts are code, description, owner, maturity, target, importance, investment, lifecycle, reviewed, evidence.',
    'Maturity is set to area.levl, which is not a field of Business area.',
    'Strategic importance needs a choice field, and Lead is not one.',
    'The configuration describes org.system, which does not refer to Business area.',
  ]);
});
test('a host that does not name the hierarchy yet leaves the parent to the one self-reference',()=>{
  const {context,schema}=otherFixture();
  const older={entities:schema.entities.map(({hierarchy,...entity})=>entity)};
  const bound=bindAtlas(context,older);
  assert.deepEqual([bound.parentFieldId,bound.orderFieldId],['area.up',null]);
  const undeclared=bindAtlas(context,{entities:schema.entities.map(entity=>({...entity,hierarchy:null}))});
  assert.equal(undeclared.parentFieldId,null,'a host that says there is no tree is believed');
  assert.deepEqual(undeclared.selfReferences,['Part of']);
});
test('related sections read in the configuration’s order, then links before lists, whatever order the host lists types in',()=>{
  // The host lists record types by entity ID, so BCM's initiatives come before its support links.
  // Found on the live file on 2026-09-28: the inspector read Change portfolio before Application support.
  for(const [fixture,expected] of [[bcmFixture(),['bcm.support','bcm.initiative']],[otherFixture(),['org.use','org.project']]]){
    const {context,schema}=fixture;
    for(const entities of [schema.entities,[...schema.entities].reverse()]){
      const order=bindAtlas(context,{entities}).related.map(e=>e.entityId);
      assert.deepEqual(order,expected,`The inspector's sections follow the host's listing (${entities.map(e=>e.entityId).join(', ')}), not the configuration and link-first order`);
    }
  }
});
// W-079: where a drop or a key puts a capability, as records.move takes it. The tree: a (b, c), d.
test('a drop goes in, before or after, refuses its own subtree, and skips where it already stands',()=>{
  const h=hierarchy(engineTree([r('a'),r('b','a'),r('c','a'),r('d')]));
  assert.deepEqual(dropTarget(h,'d',{kind:'into',targetId:'a'}),{parentId:'a',beforeId:null});
  assert.deepEqual(dropTarget(h,'d',{kind:'before',targetId:'c'}),{parentId:'a',beforeId:'c'});
  assert.deepEqual(dropTarget(h,'d',{kind:'after',targetId:'b'}),{parentId:'a',beforeId:'c'});
  assert.deepEqual(dropTarget(h,'b',{kind:'after',targetId:'c'}),{parentId:'a',beforeId:null});
  assert.deepEqual(dropTarget(h,'a',{kind:'into',targetId:'b'}),{refused:true},'A move under its own child was offered.');
  assert.deepEqual(dropTarget(h,'a',{kind:'before',targetId:'c'}),{refused:true},'A move beside its own child was offered.');
  assert.deepEqual(dropTarget(h,'a',{kind:'into',targetId:'a'}),{refused:true});
  assert.deepEqual(dropTarget(h,'b',{kind:'before',targetId:'c'}),{unchanged:true});
  assert.deepEqual(dropTarget(h,'c',{kind:'into',targetId:'a'}),{unchanged:true});
  assert.deepEqual(dropTarget(h,'b',{kind:'after',targetId:'b'}),{unchanged:true});
  assert.deepEqual(dropTarget(h,'b',{kind:'after',targetId:'d'},false),{parentId:null,beforeId:null},'Without an order field a drop only chooses the parent.');
});
test('the keyboard moves up, down, in and out as the outline does',()=>{
  const h=hierarchy(engineTree([r('a'),r('b','a'),r('c','a'),r('d')]));
  assert.deepEqual(stepTarget(h,'c','up'),{parentId:'a',beforeId:'b'});
  assert.deepEqual(stepTarget(h,'b','down'),{parentId:'a',beforeId:null});
  assert.equal(stepTarget(h,'c','down'),null);
  assert.equal(stepTarget(h,'b','up'),null);
  assert.deepEqual(stepTarget(h,'c','in'),{parentId:'b',beforeId:null});
  assert.equal(stepTarget(h,'a','in'),null);
  assert.deepEqual(stepTarget(h,'b','out'),{parentId:null,beforeId:'d'});
  assert.equal(stepTarget(h,'d','out'),null);
  assert.equal(stepTarget(h,'c','up',false),null,'Without an order field there is no up or down.');
});
