import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/overview-model.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const model = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));
const {
 overviewOf,overviewTitle,overviewDescription,overviewTiles,overviewCharts,overviewRanges,overviewRecentLists,
 rangeReads,rangeEndKey,rangeEndText,recentLimit,recentListCeiling,recentRead,recentWindowKey,nodeEntityId,
} = model;

const node=(semanticId,kind,properties={},children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const overview=(children,properties={})=>({
 contractVersion:3,applicationId:'a',definitionRevision:1,entities:[],
 surface:node('front','overviewSurface',{title:'Everything',...properties},children),
});

test('the front page comes from a valid compilation, and only from one',()=>{
 const plan=overview([]);
 assert.equal(overviewOf({isValid:true,diagnostics:[],overview:plan}),plan);
 // An invalid definition suppresses every custom plan, and the front page is one.
 assert.equal(overviewOf({isValid:false,diagnostics:[],overview:plan}),null);
 assert.equal(overviewOf({isValid:true,diagnostics:[]}),null);
 assert.equal(overviewOf(null),null);
});

test('the title and the description are the author’s, and an absent one stays absent',()=>{
 assert.equal(overviewTitle(overview([])),'Everything');
 // An untitled front page is still a front page, and it is named rather than blank.
 assert.equal(overviewTitle(overview([],{title:undefined})),'Overview');
 assert.equal(overviewDescription(overview([])),null);
 assert.equal(overviewDescription(overview([],{description:'What this file is for.'})),'What this file is for.');
 // Empty prose is no prose: it must not draw an empty paragraph under the title.
 assert.equal(overviewDescription(overview([],{description:''})),null);
});

test('every kind is found through sections and tab groups, each scoped to the type it names',()=>{
 const plan=overview([
  node('count','summaryTile',{entityId:'work',aggregate:'count'}),
  node('group','tabGroup',{},[
   node('section','section',{title:'Lately'},[
    node('stage','breakdownChart',{entityId:'work',aggregate:'count',groupByFieldId:'status'}),
    node('span','rangeTile',{entityId:'work',fieldId:'due'}),
    node('recent','recentList',{entityId:'note'},[node('recent-title','fieldBinding',{fieldId:'title'})]),
   ]),
  ]),
 ]);
 assert.deepEqual(overviewTiles(plan).map(item=>[item.tile.semanticId,item.scope.entityId]),[['count','work']]);
 assert.deepEqual(overviewCharts(plan).map(item=>[item.node.semanticId,item.scope.entityId]),[['stage','work']]);
 assert.deepEqual(overviewRanges(plan).map(item=>[item.tile.semanticId,item.scope.entityId]),[['span','work']]);
 assert.deepEqual(overviewRecentLists(plan).map(item=>item.semanticId),['recent']);
 assert.equal(overviewTiles(null).length,0);
});

test('a section that starts closed is not walked, so nothing in it is read until it is opened',()=>{
 // ADR-0004, 2026-09-20 amendment: folding saves the person nothing if the file still
 // pays for the reads. The stored default is what this bundle can see; what the person
 // does with the fold afterwards is measured by the agent-authoring gate.
 const plan=overview([
  node('open','section',{title:'Now'},[node('count','summaryTile',{entityId:'work',aggregate:'count'})]),
  node('closed','section',{title:'Lately',opens:'closed'},[
   node('hidden-count','summaryTile',{entityId:'work',aggregate:'count'}),
   node('hidden-recent','recentList',{entityId:'note'},[node('t','fieldBinding',{fieldId:'title'})]),
  ]),
 ]);
 assert.deepEqual(overviewTiles(plan).map(item=>item.tile.semanticId),['count']);
 assert.deepEqual(overviewRecentLists(plan).map(item=>item.semanticId),[]);
});

test('a node that names no record type is skipped rather than given one',()=>{
 // The compiler refuses this definition; the renderer must not paper over it by
 // inventing a record type, which would answer a question nobody asked.
 const plan=overview([node('count','summaryTile',{aggregate:'count'})]);
 assert.equal(overviewTiles(plan).length,0);
 assert.equal(nodeEntityId(node('x','summaryTile',{})),null);
});

test('a range is two reads of one field, and neither end is a range on its own',()=>{
 const tile=node('span','rangeTile',{entityId:'work',fieldId:'due'},[
  node('open','filterClause',{fieldId:'status',operator:'ne',value:'done'}),
 ]);
 const scope={kind:'overview',entityId:'work'};
 const reads=rangeReads(tile,scope);
 assert.equal(reads.min.aggregate,'min');
 assert.equal(reads.max.aggregate,'max');
 assert.equal(reads.min.entityId,'work');
 assert.equal(reads.min.fieldId,'due');
 // Both ends read exactly the same records: a range between two different sets
 // would be two answers rather than one span.
 assert.deepEqual(reads.min.filters,reads.max.filters);
 assert.equal(reads.min.filters.length,1);
 assert.equal(rangeReads(node('x','rangeTile',{entityId:'work'}),scope),null);
});

test('the two ends of a range have distinct keys that extend the tile’s own',()=>{
 const tile=node('span','rangeTile',{entityId:'work',fieldId:'due'});
 const scope={kind:'overview',entityId:'work'};
 const low=rangeEndKey(tile,scope,'min');
 const high=rangeEndKey(tile,scope,'max');
 assert.notEqual(low,high);
 assert.ok(low.includes('span')&&low.includes('overview'));
});

test('a recent list reads a bounded window, defaulting to the published ceiling',()=>{
 const withLimit=node('recent','recentList',{entityId:'note',limit:3,orderByFieldId:'created',orderDirection:'descending'});
 assert.equal(recentLimit(withLimit),3);
 assert.equal(recentLimit(node('recent','recentList',{entityId:'note'})),recentListCeiling);
 assert.equal(recentListCeiling,10);
 const read=recentRead(withLimit);
 assert.equal(read.entityId,'note');
 assert.equal(read.limit,3);
 assert.equal(read.query.sortFieldId,'created');
 assert.equal(recentRead(node('recent','recentList',{})),null);
});

test('a recent list’s window key carries its limit, so a shorter list is not served a longer page',()=>{
 const three=node('recent','recentList',{entityId:'note',limit:3});
 const five=node('recent','recentList',{entityId:'note',limit:5});
 assert.notEqual(recentWindowKey(three),recentWindowKey(five));
 assert.equal(recentWindowKey(three),recentWindowKey(node('recent','recentList',{entityId:'note',limit:3})));
});

test('a range end reads as a date or as the exact number it was answered with',()=>{
 // A civil date is answered as a JSON string, quotes and all, because the lexeme is
 // the raw text that keeps every digit of a number. It is read as the date.
 assert.equal(rangeEndText('"2026-09-15"'),'2026-09-15');
 // A number is shown exactly as answered: parsing it would drop the trailing zero
 // that the host folded the value exactly to keep.
 assert.equal(rangeEndText('48000.00'),'48000.00');
 assert.equal(rangeEndText('0'),'0');
 assert.equal(rangeEndText(null),null);
 // Anything unparsable is shown as it came rather than guessed at.
 assert.equal(rangeEndText('"'),'"');
 assert.equal(rangeEndText('"oops'),'"oops');
});
