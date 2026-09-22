import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/record-window.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {cacheKey,clauseFilters,declaredQuery,emptyWindowQuery,hasWindowQuery,pageTarget,queryOperatorFor,windowRequest} =
 await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const clause=(fieldId,operator,value)=>node(`f.${fieldId}.${operator}`,'filterClause',
 value===undefined?{fieldId,operator}:{fieldId,operator,value});

const openDeals=node('list.open','recordList',{orderByFieldId:'name',orderDirection:'descending'},[
 node('b.name','fieldBinding',{fieldId:'name'}),
 clause('stage','ne','Closed won'),
 clause('value','gte',1000),
 clause('owner','isNotNull'),
]);

test('a declared query reads the ordered clauses and the declared ordering',()=>{
 const query=declaredQuery(openDeals);
 assert.deepEqual(query.filters,[
  {fieldId:'stage',operator:'ne',value:'Closed won'},
  // The durable contract spells this gte; the record query spells it ge.
  {fieldId:'value',operator:'ge',value:1000},
  {fieldId:'owner',operator:'isNotNull'},
 ]);
 assert.equal(query.sortFieldId,'name');
 assert.equal(query.descending,true);
 assert.equal(hasWindowQuery(query),true);
 assert.equal(queryOperatorFor('lte'),'le');
 assert.equal(queryOperatorFor('eq'),'eq');
});

// A presence check takes no value, and the absence must be an absent key rather
// than an explicit null: the host refuses a null value on isNull.
test('a presence clause carries no value key at all',()=>{
 const only=declaredQuery(node('l','recordList',{},[clause('owner','isNull')]));
 assert.deepEqual(only.filters,[{fieldId:'owner',operator:'isNull'}]);
 assert.equal('value' in only.filters[0],false);
});

// An unfiltered window still owns a query. Returning null here is what let the
// caller decide, per call site, what absence meant.
test('a root that declares nothing owns the explicit empty query',()=>{
 const plain=declaredQuery(node('l','recordList',{},[node('b','fieldBinding',{fieldId:'name'})]));
 assert.deepEqual(plain,{filters:[],sortFieldId:undefined,descending:undefined});
 assert.equal(hasWindowQuery(plain),false);
 assert.deepEqual(emptyWindowQuery(),{filters:[]});
 // Ordering alone is a query: the cursor scope includes the sort.
 assert.equal(hasWindowQuery(declaredQuery(node('l','recordList',{orderByFieldId:'name'}))),true);
});

test('a malformed clause is dropped rather than sent as a partial predicate',()=>{
 const broken=declaredQuery(node('l','recordList',{},[
  node('f.bad','filterClause',{operator:'eq',value:1}),
  node('f.worse','filterClause',{fieldId:'name'}),
  clause('name','eq','Keep'),
 ]));
 assert.deepEqual(broken.filters,[{fieldId:'name',operator:'eq',value:'Keep'}]);
});

// This is the pagination repair: page two must carry the arguments page one used.
test('every page of a window request carries the same filters and ordering',()=>{
 const query=declaredQuery(openDeals);
 const first=windowRequest('deal',query);
 assert.deepEqual(first,{entityId:'deal',limit:50,cursor:null,filters:query.filters,sortFieldId:'name',descending:true});
 const second=windowRequest('deal',query,'cursor-one');
 assert.equal(second.cursor,'cursor-one');
 assert.deepEqual(second.filters,first.filters);
 assert.equal(second.sortFieldId,first.sortFieldId);
 assert.equal(second.descending,first.descending);
 assert.equal(windowRequest('deal',query,null,25).limit,25);
});

test('a page step picks the forward continuation and replays the backward cursor',()=>{
 const window={page:{nextCursor:'cursor-two'},cursors:[null,'cursor-one'],index:1,query:emptyWindowQuery()};
 assert.deepEqual(pageTarget(window,1),{index:2,cursor:'cursor-two'});
 assert.deepEqual(pageTarget(window,-1),{index:0,cursor:null});
 // Page one has no Previous, and a page with no continuation has no Next.
 assert.equal(pageTarget({...window,index:0},-1),null);
 assert.equal(pageTarget({...window,page:{nextCursor:null}},1),null);
});

// Concatenation cannot tell a missing group from the literal text of one, and an
// identifier holding the delimiter collides with a different tuple.
test('a cache key over a tuple keeps null, text and delimiters distinct',()=>{
 assert.notEqual(cacheKey(['tile',null]),cacheKey(['tile','null']));
 assert.notEqual(cacheKey(['tile:a','b']),cacheKey(['tile','a:b']));
 assert.equal(cacheKey(['tile','a',1,true]),cacheKey(['tile','a',1,true]));
});

// A filter clause carries a word for the values that must not be stored: today and now
// resolve when the query is built, so a definition written in January does not still
// mean January in December. This read `value` and nothing else, so a clause saying
// `today` sent no value at all, the host refused the whole read with "Use isNull or
// isNotNull to query missing values", and the tile behind it said Unavailable for ever.
test('a clause resolves today and now, and today is the reader’s own date',()=>{
 const at=new Date('2026-09-22T03:00:00Z');
 const due=node('list.due','recordList',{},[
  node('f.due.today','filterClause',{fieldId:'due',operator:'lte',valueKind:'today'}),
  node('f.seen.now','filterClause',{fieldId:'seen',operator:'lte',valueKind:'now'}),
  node('f.stage.literal','filterClause',{fieldId:'stage',operator:'eq',valueKind:'literal',value:'Open'}),
 ]);
 const [today,now,literal]=clauseFilters(due,at);
 // Independently computed: en-CA formats a local date as yyyy-MM-dd. Today has to be
 // the date on the reader's wall, not UTC's, or an overdue tile disagrees with them.
 assert.equal(today.value,at.toLocaleDateString('en-CA'));
 assert.equal(today.operator,'le');
 assert.equal(now.value,'2026-09-22T03:00:00Z');
 assert.equal(literal.value,'Open');
 // Every clause must carry a value the host can compare. A missing one is the refusal.
 for(const clause of [today,now,literal]) assert.notEqual(clause.value,undefined);
});
