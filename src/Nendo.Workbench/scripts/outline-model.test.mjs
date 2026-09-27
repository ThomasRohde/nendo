import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/outline-model.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {TOP,emptyOutline,findNode,moveTarget,movePayload,visibleRows} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

// ADR-0019 stage 5: Studio's outline of a declared hierarchy, as data.
const node=(recordId,parentRecordId,childCount=0,recordVersion=1)=>({record:{recordId,recordVersion,values:{}},parentRecordId,depth:1,childCount});
const outline=()=>{
  const state=emptyOutline('areas',7);
  state.levels.set(TOP,{items:[node('a',null,2),node('b',null,1,4),node('c',null)],nextCursor:null});
  state.levels.set('a',{items:[node('a1','a'),node('a2','a',0,3)],nextCursor:'more-a'});
  state.levels.set('b',{items:[node('b1','b')],nextCursor:null});
  return state;
};
const ids=rows=>rows.map(row=>row.kind==='node'?`${row.node.record.recordId}@${row.depth}`:`more:${row.parentKey}@${row.depth}`);

test('rows follow the open records depth-first, with a row for children not yet read', () => {
  const state=outline();
  assert.deepEqual(ids(visibleRows(state)),['a@1','b@1','c@1']);
  state.expanded.add('a');
  assert.deepEqual(ids(visibleRows(state)),['a@1','a1@2','a2@2','more:a@2','b@1','c@1']);
  state.expanded.add('b');
  assert.deepEqual(ids(visibleRows(state)),['a@1','a1@2','a2@2','more:a@2','b@1','b1@2','c@1']);
  // A record with no children never shows as open, whatever the set says.
  state.expanded.add('c');
  assert.equal(visibleRows(state).find(row=>row.kind==='node'&&row.node.record.recordId==='c').expanded,false);
});

test('up and down swap with the neighbouring sibling, and stop at the ends', () => {
  const state=outline();
  assert.deepEqual(moveTarget(state,'b','up'),{parentRecordId:null,beforeRecordId:'a'});
  assert.equal(moveTarget(state,'a','up'),null);
  assert.deepEqual(moveTarget(state,'a','down'),{parentRecordId:null,beforeRecordId:'c'});
  assert.deepEqual(moveTarget(state,'b','down'),{parentRecordId:null,beforeRecordId:null});
  assert.equal(moveTarget(state,'c','down'),null);
  // Down past children not yet read would land out of sight, so it is refused.
  assert.equal(moveTarget(state,'a1','down'),null,'a1 has one loaded sibling after it and more unread');
});

test('indent makes the record the last child of the sibling above; outdent places it after its parent', () => {
  const state=outline();
  assert.deepEqual(moveTarget(state,'b','indent'),{parentRecordId:'a',beforeRecordId:null});
  assert.equal(moveTarget(state,'a','indent'),null);
  assert.deepEqual(moveTarget(state,'a1','outdent'),{parentRecordId:null,beforeRecordId:'b'});
  assert.deepEqual(moveTarget(state,'b1','outdent'),{parentRecordId:null,beforeRecordId:'c'});
  assert.equal(moveTarget(state,'a','outdent'),null);
});

test('a move carries the versions the outline read', () => {
  const state=outline();
  assert.deepEqual(movePayload(state,'b',{parentRecordId:'a',beforeRecordId:null},'k'),
    {entityId:'areas',recordId:'b',expectedRecordVersion:4,parentRecordId:'a',expectedParentVersion:1,beforeRecordId:null,idempotencyKey:'k'});
  assert.equal(movePayload(state,'a2',{parentRecordId:null,beforeRecordId:'b'},'k').expectedParentVersion,null);
  assert.equal(findNode(state,'a2').record.recordVersion,3);
});
