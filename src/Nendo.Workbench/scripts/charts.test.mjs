import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/charts.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {breakdownRead,breakdownSegments,chartContext,chartTitle,drillFilter,drillLabel,groupLabel,groupScopedCharts,groupStyle,isChartKind,pageScopedCharts,progressRead,sampleGrouped,surfaceScopedCharts} =
 await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const clause=(id,fieldId,operator,value)=>node(id,'filterClause',value===undefined?{fieldId,operator}:{fieldId,operator,value});
const stage={semanticId:'stage',displayName:'Stage',storageKind:'text',presentation:'singleChoice',options:['open','done'],choices:[{id:'open',displayName:'Open',retired:false,tone:'teal'},{id:'done',displayName:'Done',retired:true}]};
const flag={semanticId:'flag',displayName:'Flag',storageKind:3,presentation:null,options:[],choices:[]};
const fieldName=(id)=>({stage:'Stage',flag:'Flag',amount:'Amount'})[id]??id;

test('Boolean chart labels and drill filters accept both wire kinds without coercing text fields',()=>{
 const grouped=node('flags','breakdownChart',{groupByFieldId:'flag'});
 for (const storageKind of [3,'boolean','Boolean']) {
  const field={...flag,storageKind};
  assert.equal(groupLabel(field,'true'),'Yes');
  assert.equal(groupLabel(field,'false'),'No');
  for (const key of ['false','true'])
   assert.deepEqual(drillFilter(grouped,field,key),{fieldId:'flag',operator:'eq',value:key==='true'});
 }
 for (const field of [{...flag,storageKind:0},{...flag,storageKind:'text'},{...flag,storageKind:undefined},undefined]) {
  assert.equal(groupLabel(field,'false'),'false');
  assert.deepEqual(drillFilter(grouped,field,'false'),{fieldId:'flag',operator:'eq',value:'false'});
 }
});

const chart=node('chart','breakdownChart',{groupByFieldId:'stage',aggregate:'sum',fieldId:'amount'},[clause('chart-open','flag','eq',true)]);
const ringNode=node('ring','progressTile',{title:'Done'},[clause('ring-done','stage','eq','done')]);
const list=node('list','recordList',{title:'Items'},[clause('list-recent','amount','gt',0),chart,ringNode]);
const board=node('board','boardSurface',{groupByFieldId:'stage'},[node('col','breakdownChart',{groupByFieldId:'flag',aggregate:'count',scope:'group'})]);

test('charts are found where tiles are found, by declared scope',()=>{
 assert.ok(isChartKind('breakdownChart') && isChartKind('progressTile') && !isChartKind('summaryTile'));
 assert.deepEqual(surfaceScopedCharts(list).map(n=>n.semanticId),['chart','ring']);
 assert.deepEqual(groupScopedCharts(board).map(n=>n.semanticId),['col']);
 assert.deepEqual(groupScopedCharts(list),[]);
 const page=node('page','detailSurface',{},[node('section','section',{title:'S'},[ringNode]),node('rel','relatedList',{targetEntityId:'other',viaFieldId:'back'},[chart])]);
 const scoped=pageScopedCharts(page,'r1');
 assert.equal(scoped[0].scope.kind,'page');
 assert.equal(scoped[1].scope.kind,'relation');
 assert.equal(scoped[1].scope.relation.semanticId,'rel');
});

test('a breakdown read composes like a tile and carries the grouping apart from the filters',()=>{
 const read=breakdownRead(chart,{kind:'surface',surface:list},'item');
 assert.deepEqual(read,{entityId:'item',groupByFieldId:'stage',aggregate:'sum',fieldId:'amount',filters:[
  {fieldId:'amount',operator:'gt',value:0},{fieldId:'flag',operator:'eq',value:true}]});
 const column=breakdownRead(board.children[0],{kind:'group',surface:board,groupByFieldId:'stage',groupId:'open'},'item');
 assert.deepEqual(column.filters,[{fieldId:'stage',operator:'eq',value:'open'}]);
 assert.equal(column.fieldId,null,'a count reads no field');
 assert.equal(breakdownRead(chart,{kind:'relation',recordId:'r',relation:node('rel','relatedList',{targetEntityId:'other'})},'item'),null,'a relation with no reference cannot be read');
});

test('a ring reads two counts: its clauses over the scope, and the scope alone',()=>{
 const read=progressRead(ringNode,{kind:'surface',surface:list},'item');
 assert.deepEqual(read.numerator,[{fieldId:'amount',operator:'gt',value:0},{fieldId:'stage',operator:'eq',value:'done'}]);
 assert.deepEqual(read.denominator,[{fieldId:'amount',operator:'gt',value:0}]);
 assert.deepEqual(progressRead(ringNode,{kind:'page'},'item').denominator,[]);
});

test('groups are labelled and coloured from the field, in the host order, with unset last',()=>{
 const result={groups:[{key:'open',valueLexeme:'10.75',contributingRecords:2},{key:'done',valueLexeme:null,contributingRecords:0},{key:null,valueLexeme:'1.00',contributingRecords:1}],unrecognised:1,changeSequence:9};
 const segments=breakdownSegments(stage,result);
 assert.deepEqual(segments.map(s=>s.label),['Open','Done (retired)','Not set']);
 assert.deepEqual(segments.map(s=>s.amount),[10.75,0,1]);
 assert.equal(segments[0].style,'--status-color: var(--tone-teal)');
 assert.equal(segments[2].style,'');
 assert.equal(groupLabel(flag,'true'),'Yes');
 assert.equal(groupLabel(flag,'false'),'No');
 assert.ok(groupStyle(flag,'true').includes('--healthy'));
 assert.equal(groupLabel(undefined,'weird'),'weird','an unknown field falls back to the key rather than inventing a name');
});

test('titles and contexts read as a person would say them',()=>{
 assert.equal(chartTitle(chart,fieldName),'By Stage');
 assert.equal(chartTitle(ringNode,fieldName),'Done');
 assert.equal(chartTitle(node('x','progressTile',{}),fieldName),'Progress');
 assert.equal(chartContext(chart,{kind:'surface',surface:list},fieldName),'sum of Amount per group, all matching records, not just this page');
 assert.equal(chartContext(ringNode,{kind:'page'},fieldName),'matching its condition, over all records of this type');
});

test('a sample breakdown counts records per group and counts strays apart',()=>{
 const records=[{values:{stage:'open'}},{values:{stage:'open'}},{values:{stage:'weird'}},{values:{}}];
 const sample=sampleGrouped(chart,stage,records);
 assert.deepEqual(sample.groups.map(g=>[g.key,g.valueLexeme]),[['open','2'],['done','0'],[null,'1']]);
 assert.equal(sample.unrecognised,1);
 const flags=sampleGrouped(node('c','breakdownChart',{groupByFieldId:'flag',aggregate:'count'}),flag,[{values:{flag:true}},{values:{flag:false}},{values:{flag:true}}]);
 assert.deepEqual(flags.groups.map(g=>[g.key,g.valueLexeme]),[['false','1'],['true','2'],[null,'0']]);
});

test('a drill is one predicate, and the pill names the group',()=>{
 assert.deepEqual(drillFilter(chart,stage,'open'),{fieldId:'stage',operator:'eq',value:'open'});
 assert.deepEqual(drillFilter(chart,stage,null),{fieldId:'stage',operator:'isNull'});
 assert.deepEqual(drillFilter(node('c','breakdownChart',{groupByFieldId:'flag',aggregate:'count'}),flag,'true'),{fieldId:'flag',operator:'eq',value:true});
 assert.equal(drillLabel(chart,stage,'open',fieldName),'Stage: Open');
 assert.equal(drillLabel(chart,stage,null,fieldName),'Stage: Not set');
 assert.equal(drillLabel(ringNode,undefined,null,fieldName),'Done');
});

// A breakdown by a reference has a group per record it points at, named by its label.
test('a reference breakdown names each group by the record it points at',()=>{
 const client={semanticId:'client',displayName:'Client',storageKind:7,presentation:null,options:[],choices:[]};
 const result={groups:[{key:'c2',valueLexeme:'250',contributingRecords:1,label:'Arbor'},{key:'c1',valueLexeme:'100.30',contributingRecords:2,label:'Harbor'},
  {key:'c3',valueLexeme:'1',contributingRecords:1,label:null},{key:null,valueLexeme:'33.333',contributingRecords:2,label:null}],unrecognised:0,changeSequence:3};
 assert.deepEqual(breakdownSegments(client,result).map(s=>s.label),['Arbor','Harbor','(No label)','Not set']);
 assert.equal(groupLabel({...client,storageKind:'reference'},'c1','Harbor'),'Harbor','the text spelling of the kind was not read as a reference');
 assert.equal(drillLabel(node('c','breakdownChart',{groupByFieldId:'client',aggregate:'count'}),client,'c1',fieldName,null,'Harbor'),'client: Harbor');
 const byClient=node('c','breakdownChart',{groupByFieldId:'client',aggregate:'count'});
 const sample=sampleGrouped(byClient,client,[{values:{client:'c1'},referenceLabels:{client:'Harbor'}},{values:{client:'c2'},referenceLabels:{client:'Arbor'}},
  {values:{client:'c1'},referenceLabels:{client:'Harbor'}},{values:{}}]);
 assert.deepEqual(sample.groups.map(g=>[g.key,g.label,g.valueLexeme]),[['c2','Arbor','1'],['c1','Harbor','2'],[null,undefined,'1']]);
 assert.equal(sample.unrecognised,0,'A reference sample counted the records it points at as strays.');
});
