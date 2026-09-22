import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/surface-model.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {accumulatesPages,activeTabSection,boardView,boardViewOf,hasListSurface,kindLabel,nodeFieldIds,resolveSurface,surfaceById,surfaceLabel,surfaceRoot,tabSections,treeCommands,useSurfaces} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const binding=(fieldId)=>node(`bind.${fieldId}`,'fieldBinding',{fieldId});
const entity={semanticId:'deal',displayName:'Deal',fields:[
 {semanticId:'name',displayName:'Name',options:[],choices:[]},
 {semanticId:'stage',displayName:'Stage',options:['open','won'],choices:[{id:'open',displayName:'Open'},{id:'won',displayName:'Won'}]},
 {semanticId:'closeDate',displayName:'Close date',options:[],choices:[]},
]};
const composable={contractVersion:3,entity,records:[],surfaces:[
 node('board.deal','boardSurface',{groupByFieldId:'stage',title:'Pipeline'},[binding('name'),binding('stage')]),
 node('list.deal','recordList',{title:'All deals'},[binding('name')]),
]};

test('an exact custom graph remains a selectable Use surface rather than falling through to a list',()=>{
 const graph=node('graph.deal','extensionGraphSurface',{title:'Dependencies'});
 const plan={...composable,surfaces:[graph,...composable.surfaces]};
 assert.equal(resolveSurface(plan,'graph.deal'),graph);
 assert.equal(useSurfaces(plan)[0],graph);
 assert.equal(kindLabel(graph.kind),'Custom graph');
});

test('a board resolves from the surface tree with its ordered columns',()=>{
 const board=boardView(composable);
 assert.notEqual(board,null);
 assert.equal(board.groupByFieldId,'stage');
 assert.deepEqual(board.cardFieldIds,['name','stage']);
 // options is the ordered authority for columns; choices only labels them.
 assert.deepEqual(board.groups,['open','won']);
 assert.equal(hasListSurface(composable),true);
});

test('an application with no board resolves to none',()=>{
 const formOnly={...composable,surfaces:[node('form.deal','recordForm',{title:'Deal'},[binding('name')])]};
 assert.equal(boardView(formOnly),null);
 assert.equal(hasListSurface(formOnly),false);
 assert.equal(surfaceRoot(formOnly,'recordForm').semanticId,'form.deal');
});

// A board whose group field is missing cannot be grouped. Rendering it with no
// columns would show an empty board rather than saying the definition is wrong.
test('a board with no group field or an unknown one does not invent columns',()=>{
 assert.equal(boardView({...composable,surfaces:[node('b','boardSurface',{title:'Pipeline'})]}),null);
 const unknown=boardView({...composable,surfaces:[node('b','boardSurface',{groupByFieldId:'gone'})]});
 assert.deepEqual(unknown.groups,[]);
});

test('card fields come from ordered field bindings and ignore other children',()=>{
 const root=node('b','boardSurface',{groupByFieldId:'stage'},[binding('stage'),node('f','filterClause',{fieldId:'name',operator:'isNotNull'}),binding('name')]);
 assert.deepEqual(nodeFieldIds(root),['stage','name']);
});

// A standalone command root had no button anywhere: the record page was the only
// place commands were looked for, so the one node kind that writes could not run.
test('a command is found whether it is a root or nested in the record page',()=>{
 const nested=node('page.cmd','recordCommand',{label:'Nested'});
 const plan={...composable,surfaces:[
  node('cmd.root','recordCommand',{definitionVersion:3,entityId:'deal',label:'Standalone'}),
  node('page','detailSurface',{definitionVersion:3,entityId:'deal'},[node('sec','section',{title:'Main'},[nested])]),
 ]};
 assert.deepEqual(treeCommands(plan).map(c=>c.properties.label),['Standalone','Nested']);
 assert.deepEqual(treeCommands({...composable,surfaces:[]}),[]);
});

// An entity may own eight lists and eight boards. Resolving by kind returned the
// first of a kind, so seven of eight lists had no way to be shown at all.
const manySurfaces={contractVersion:3,entity,records:[],surfaces:[
 node('list.open','recordList',{title:'Open deals'},[binding('name')]),
 node('board.stage','boardSurface',{groupByFieldId:'stage',title:'By stage'},[binding('name')]),
 node('list.closed','recordList',{title:'Closed deals'},[binding('stage')]),
 node('cal.close','calendarSurface',{dateFieldId:'closeDate',title:'Close dates'},[binding('name')]),
 node('tl.close','timelineSurface',{dateFieldId:'closeDate',title:'Over time'},[binding('name')]),
 node('cards.deal','gallerySurface',{titleFieldId:'name',accentFieldId:'stage',title:'Deal cards'},[binding('name')]),
 node('page.deal','detailSurface',{title:'Deal'},[binding('name')]),
 node('cmd.won','recordCommand',{label:'Mark won'}),
]};

test('every list, board, gallery, calendar and timeline root is a selectable surface, in compiled order',()=>{
 assert.deepEqual(useSurfaces(manySurfaces).map(s=>s.semanticId),
  ['list.open','board.stage','list.closed','cal.close','tl.close','cards.deal']);
 // A calendar and a timeline read their own pages; a list, a board and a gallery take
 // one bounded window and the pager that goes with it.
 assert.equal(accumulatesPages('calendarSurface'),true);
 assert.equal(accumulatesPages('timelineSurface'),true);
 assert.equal(accumulatesPages('recordList'),false);
 assert.equal(accumulatesPages('boardSurface'),false);
 assert.equal(accumulatesPages('gallerySurface'),false);
 // A record page and a command are not surfaces the selector chooses between.
 assert.equal(surfaceById(manySurfaces,'page.deal'),null);
 assert.equal(surfaceById(manySurfaces,'cmd.won'),null);
 assert.equal(surfaceById(manySurfaces,'list.closed').properties.title,'Closed deals');
 assert.equal(surfaceById(manySurfaces,null),null);
 assert.deepEqual(useSurfaces({...manySurfaces,surfaces:[]}),[]);
});

// A surface removed by one proposal and restored by the next must come back
// selected, so the fallback resolves without rewriting the remembered choice.
test('a missing selection falls back to the first root without losing the choice',()=>{
 assert.equal(resolveSurface(manySurfaces,'list.closed').semanticId,'list.closed');
 assert.equal(resolveSurface(manySurfaces,'list.gone').semanticId,'list.open');
 assert.equal(resolveSurface(manySurfaces,null).semanticId,'list.open');
 // A form-only application has no surface to fall back to.
 assert.equal(resolveSurface({...manySurfaces,surfaces:[node('form','recordForm',{},[binding('name')])]},null),null);
});

test('a board does not draw a column its own filter excludes',()=>{
 const clause=(fieldId,operator,value)=>node(`f.${fieldId}.${operator}.${value}`,'filterClause',{fieldId,operator,value});
 const board=(...children)=>node('board.filtered','boardSurface',{groupByFieldId:'stage'},[binding('name'),...children]);
 // Unfiltered, every option of the grouping field is a column.
 assert.deepEqual(boardViewOf(board(),entity.fields).groups,['open','won']);
 // "not won" cannot contain a won record, so a Won column would read 0 for a reason
 // that has nothing to do with how many deals were won.
 assert.deepEqual(boardViewOf(board(clause('stage','ne','won')),entity.fields).groups,['open']);
 // The same rule narrowing to one column.
 assert.deepEqual(boardViewOf(board(clause('stage','eq','won')),entity.fields).groups,['won']);
 // Two exclusions leave what is left, and an exclusion of everything leaves nothing.
 assert.deepEqual(boardViewOf(board(clause('stage','ne','won'),clause('stage','ne','open')),entity.fields).groups,[]);
 // A clause on another field decides which records land in a column, not which
 // columns exist, so every column stays.
 assert.deepEqual(boardViewOf(board(clause('name','ne','Ada')),entity.fields).groups,['open','won']);
 // An operator that says nothing definite about which options remain leaves them all.
 assert.deepEqual(boardViewOf(board(clause('stage','gt','open')),entity.fields).groups,['open','won']);
 assert.deepEqual(boardViewOf(board(node('f.null','filterClause',{fieldId:'stage',operator:'isNotNull'})),entity.fields).groups,['open','won']);
});

test('a board reads the selected node and the entity fields, not the first board',()=>{
 const selected=surfaceById(manySurfaces,'board.stage');
 const view=boardViewOf(selected,entity.fields);
 assert.equal(view.groupByFieldId,'stage');
 assert.deepEqual(view.groups,['open','won']);
 // A list is not a board, whichever board the plan also holds.
 assert.equal(boardViewOf(surfaceById(manySurfaces,'list.open'),entity.fields),null);
 assert.equal(boardViewOf(null,entity.fields),null);
 // A second board grouped by another field gets its own columns.
 const second=node('board.two','boardSurface',{groupByFieldId:'name'},[binding('stage')]);
 assert.deepEqual(boardViewOf(second,entity.fields).groups,[]);
});

test('a selector label falls back to the kind and disambiguates a shared title',()=>{
 const surfaces=useSurfaces(manySurfaces);
 assert.equal(surfaceLabel(surfaces[0],surfaces),'Open deals');
 const untitled=node('list.plain','recordList',{},[binding('name')]);
 assert.equal(surfaceLabel(untitled,[untitled]),'List');
 assert.equal(kindLabel('calendarSurface'),'Calendar');
 assert.equal(kindLabel('timelineSurface'),'Timeline');
 assert.equal(kindLabel('gallerySurface'),'Gallery');
 // Two lists may legitimately share a title; two buttons reading "Deals" name
 // nothing, so the stable ID comes back into the label.
 const a=node('list.a','recordList',{title:'Deals'});
 const b=node('list.b','recordList',{title:'Deals'});
 assert.equal(surfaceLabel(a,[a,b]),'Deals (list.a)');
 assert.equal(surfaceLabel(b,[a,b]),'Deals (list.b)');
});

// A tab removed or reordered by a proposal must not leave the page with no open
// panel, and the remembered choice is not rewritten by the fallback.
test('the open tab falls back to the first section when the remembered one is gone',()=>{
 const group=node('page.tabs','tabGroup',{title:'Details'},[
  node('tab.identity','section',{title:'Identity'},[binding('name')]),
  node('tab.numbers','section',{title:'Numbers'},[binding('stage')]),
 ]);
 assert.deepEqual(tabSections(group).map(s=>s.semanticId),['tab.identity','tab.numbers']);
 assert.equal(activeTabSection(group,'tab.numbers').semanticId,'tab.numbers');
 assert.equal(activeTabSection(group,'tab.gone').semanticId,'tab.identity');
 assert.equal(activeTabSection(group,undefined).semanticId,'tab.identity');
 // Reordering keeps a remembered tab open; it is addressed by ID, not position.
 const reordered={...group,children:[group.children[1],group.children[0]]};
 assert.equal(activeTabSection(reordered,'tab.identity').semanticId,'tab.identity');
 assert.equal(activeTabSection(reordered,undefined).semanticId,'tab.numbers');
 // A group the compiler would refuse still must not crash the renderer.
 assert.equal(activeTabSection(node('page.tabs','tabGroup',{}),undefined),null);
 assert.deepEqual(tabSections(node('page.tabs','tabGroup',{},[binding('name')])),[]);
});
