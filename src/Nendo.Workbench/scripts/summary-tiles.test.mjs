import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/summary-tiles.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {declaredScope,groupScopedTiles,groupTileScope,isSettledSummaryFailure,pageScopedTiles,surfaceScopedTiles,tileEntityId,tileFilters,tileKey,tileRead,tileScopeLabel,tileTitle,tileIsReadable} =
 await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));
const windowBundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/record-window.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {mapBounded} = await import('data:text/javascript;base64,'+Buffer.from(windowBundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const clause=(fieldId,operator,value)=>node(`f.${fieldId}.${operator}`,'filterClause',
 value===undefined?{fieldId,operator}:{fieldId,operator,value});
const tile=(semanticId,properties,children=[])=>node(semanticId,'summaryTile',properties,children);

const board=node('board.deal','boardSurface',{groupByFieldId:'stage',title:'Pipeline'},[
 node('b.name','fieldBinding',{fieldId:'name'}),
 clause('archived','eq',false),
 tile('tile.total',{aggregate:'count',title:'Deals'}),
 tile('tile.column',{aggregate:'sum',fieldId:'value',title:'Column value',scope:'group'}),
]);

test('a list or board tile is split by its declared scope, and the default is surface',()=>{
 assert.deepEqual(surfaceScopedTiles(board).map(t=>t.semanticId),['tile.total']);
 assert.deepEqual(groupScopedTiles(board).map(t=>t.semanticId),['tile.column']);
 assert.equal(declaredScope(tile('t',{aggregate:'count'})),'surface');
 assert.equal(declaredScope(tile('t',{aggregate:'count',scope:'group'})),'group');
 // Only a board has columns, so a list never yields column tiles even if one
 // were stored there; the compiler refuses it and the renderer agrees.
 const list=node('list','recordList',{},[tile('t',{aggregate:'count',scope:'group'})]);
 assert.deepEqual(groupScopedTiles(list),[]);
 assert.deepEqual(surfaceScopedTiles(null),[]);
});

// The number covers the whole filtered set, so it is the surface's clauses plus
// the tile's own — never the loaded page.
test('a surface tile counts the root-filtered set intersected with its own clauses',()=>{
 const scope={kind:'surface',surface:board};
 const withOwn=tile('tile.total',{aggregate:'count'},[clause('owner','isNotNull')]);
 assert.deepEqual(tileFilters(withOwn,scope),[
  {fieldId:'archived',operator:'eq',value:false},
  {fieldId:'owner',operator:'isNotNull'},
 ]);
 assert.equal(tileEntityId(scope,'deal'),'deal');
 assert.equal(tileScopeLabel(scope),'all matching records, not just this page');
});

test('a column tile adds the stored choice id, and Ungrouped asks for a missing value',()=>{
 const won=groupTileScope(board,'stage','won');
 assert.deepEqual(tileFilters(board.children[3],won),[
  {fieldId:'archived',operator:'eq',value:false},
  {fieldId:'stage',operator:'eq',value:'won'},
 ]);
 const ungrouped=groupTileScope(board,'stage',null);
 // isNull, never eq null: the host refuses a null value on a comparing operator,
 // and a display name names nothing it stores.
 assert.deepEqual(tileFilters(board.children[3],ungrouped).at(-1),{fieldId:'stage',operator:'isNull'});
 assert.equal(tileScopeLabel(ungrouped),'all matching records with no value set');
 assert.equal(tileScopeLabel(won),'all matching records in this column');
});

test('a relation tile keeps the reference predicate, the relation clauses and its own',()=>{
 const relation=node('rel','relatedList',{targetEntityId:'note',viaFieldId:'note.deal'},[clause('pinned','eq',true)]);
 const own=tile('tile.notes',{aggregate:'count'},[clause('archived','eq',false)]);
 const scope={kind:'relation',recordId:'deal-1',relation};
 assert.deepEqual(tileFilters(own,scope),[
  {fieldId:'note.deal',operator:'eq',value:'deal-1'},
  {fieldId:'pinned',operator:'eq',value:true},
  {fieldId:'archived',operator:'eq',value:false},
 ]);
 assert.equal(tileEntityId(scope,'deal'),'note');
 assert.equal(tileScopeLabel(scope),'all related records');
});

// The page loader used to pass the selected record's ID as the only scope, so a
// tile on a list had to be handed a record it had nothing to do with.
test('a page tile spends only its own clauses over the whole record type',()=>{
 const page=node('page','detailSurface',{},[
  node('sec','section',{title:'Numbers'},[tile('tile.page',{aggregate:'count'},[clause('archived','eq',false)])]),
  node('rel','relatedList',{targetEntityId:'note',viaFieldId:'note.deal'},[tile('tile.rel',{aggregate:'count'})]),
 ]);
 const scoped=pageScopedTiles(page,'deal-1');
 assert.deepEqual(scoped.map(item=>[item.tile.semanticId,item.scope.kind]),
  [['tile.page','page'],['tile.rel','relation']]);
 assert.deepEqual(tileFilters(scoped[0].tile,scoped[0].scope),[{fieldId:'archived',operator:'eq',value:false}]);
 assert.equal(tileScopeLabel(scoped[0].scope),'all records of this type');
 assert.deepEqual(pageScopedTiles(null,'deal-1'),[]);
});

test('a read names the record type, the aggregate and the field, and count reads none',()=>{
 const countRead=tileRead(board.children[2],{kind:'surface',surface:board},'deal');
 assert.equal(countRead.aggregate,'count');
 assert.equal(countRead.fieldId,null);
 const sumRead=tileRead(board.children[3],groupTileScope(board,'stage','won'),'deal');
 assert.equal(sumRead.aggregate,'sum');
 assert.equal(sumRead.fieldId,'value');
 assert.equal(sumRead.entityId,'deal');
 // A relation missing its binding cannot be composed, and is stated rather than skipped.
 const broken={kind:'relation',recordId:'deal-1',relation:node('rel','relatedList',{targetEntityId:'note'})};
 assert.equal(tileRead(tile('t',{aggregate:'count'}),broken,'deal'),null);
 assert.equal(tileIsReadable(tile('t',{aggregate:'count'}),broken,'deal'),false);
});

test('a tile key separates every scope it can be read under',()=>{
 const one=board.children[3];
 const keys=new Set([
  tileKey(one,{kind:'surface',surface:board}),
  tileKey(one,groupTileScope(board,'stage','won')),
  tileKey(one,groupTileScope(board,'stage',null)),
  tileKey(one,{kind:'page'}),
  tileKey(one,{kind:'relation',recordId:'deal-1',relation:node('rel','relatedList',{targetEntityId:'note',viaFieldId:'v'})}),
 ]);
 assert.equal(keys.size,5);
 // A column literally named "null" is not the missing-value column.
 assert.notEqual(tileKey(one,groupTileScope(board,'stage',null)),tileKey(one,groupTileScope(board,'stage','null')));
 assert.equal(tileKey(one,groupTileScope(board,'stage','won')),tileKey(one,groupTileScope(board,'stage','won')));
});

test('a tile falls back to its aggregate for a title',()=>{
 assert.equal(tileTitle(tile('t',{aggregate:'count'})),'Count');
 assert.equal(tileTitle(tile('t',{aggregate:'sum',fieldId:'value'})),'sum');
 assert.equal(tileTitle(tile('t',{aggregate:'count',title:'Open deals'})),'Open deals');
});

// A board with a tile in every column would otherwise open one exact read per
// column at once against a single file.
test('bounded reads keep at most the configured number in flight and survive a failure',async()=>{
 let inFlight=0;
 let peak=0;
 const done=[];
 await mapBounded([1,2,3,4,5,6,7,8,9,10],4,async item=>{
  inFlight+=1; peak=Math.max(peak,inFlight);
  await new Promise(resolve=>setTimeout(resolve,1));
  inFlight-=1;
  try { if (item===3) throw new Error('refused'); done.push(item); } catch { done.push(-item); }
 });
 assert.equal(peak<=4,true,`at most four in flight, saw ${peak}`);
 assert.equal(done.length,10);
 assert.equal(done.includes(-3),true,'a refusing read records its own failure');
 assert.equal(done.includes(10),true,'and does not abandon the rest');
 await mapBounded([],4,async()=>{ throw new Error('never'); });
});

test('a total the host cannot hold exactly is a settled refusal, not a read to retry',()=>{
 assert.equal(isSettledSummaryFailure('aggregate-not-representable'),true);
 assert.equal(isSettledSummaryFailure('aggregate-not-exact'),true);
 assert.equal(isSettledSummaryFailure('cancelled'),false);
 assert.equal(isSettledSummaryFailure('file-io'),false);
 assert.equal(isSettledSummaryFailure('host-error'),false);
});
