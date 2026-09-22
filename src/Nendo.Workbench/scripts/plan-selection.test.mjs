import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/plan-selection.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {derivedFor,formFields,listFieldIds,readIsPending,snapshotFieldPlans,surfaceAccentFieldId,timelineKeyFor,timelineModeFor,timelineYearFor,todayCivil,treeFieldIds,visibleNodes} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

// These are the selectors that answer from their arguments. `sessionEntity`,
// `activePlan` and the calendar accessors read the shared `state` object, which
// this bundle owns a private copy of, so their branches are driven by the
// runtime journeys instead. What is asserted below is a fresh module's state:
// nothing remembered, and retired data hidden.

const node=(semanticId,kind,properties={},children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const binding=(fieldId)=>node(`bind.${fieldId}`,'fieldBinding',{fieldId});
const field=(semanticId,presentation='singleLine')=>({semanticId,displayName:semanticId,presentation,retired:false,options:[],choices:[]});
const planWith=(...surfaces)=>({entity:{semanticId:'deal',displayName:'Deal',fields:[field('name'),field('stage','singleChoice'),field('note')],derivedFields:[]},records:[],surfaces});

test('the fields a form wires are the record page read depth first, each one only once',()=>{
 const page=node('page.deal','detailSurface',{},[
  binding('name'),
  node('sec.a','section',{},[binding('stage'),binding('name')]),
 ]);
 assert.deepEqual(treeFieldIds(planWith(page)),['name','stage','name']);
 // A field bound twice on one page is one logical field with one draft value,
 // so the form wires it once, at its first authored position.
 assert.deepEqual(formFields(planWith(page)).map(f=>f.semanticId),['name','stage']);
});

test('a related list binds another record type, so its bindings are not this page’s fields',()=>{
 const page=node('page.deal','detailSurface',{},[
  binding('name'),
  node('rel.tasks','relatedList',{},[binding('title'),binding('due')]),
 ]);
 assert.deepEqual(treeFieldIds(planWith(page)),['name']);
});

test('an application with no record page falls back to every field the entity has',()=>{
 const plan=planWith(node('list.deal','recordList',{},[binding('name')]));
 assert.equal(treeFieldIds(plan),null);
 assert.deepEqual(formFields(plan).map(f=>f.semanticId),['name','stage','note']);
});

test('a list shows its own columns, then the record page’s, then every field',()=>{
 const page=node('page.deal','detailSurface',{},[binding('stage')]);
 const list=node('list.deal','recordList',{},[binding('name'),binding('note')]);
 assert.deepEqual(listFieldIds(planWith(page,list),list),['name','note']);
 // A list that declares no columns of its own borrows the record page's.
 assert.deepEqual(listFieldIds(planWith(page,list),node('list.bare','recordList')),['stage']);
 // With neither, every field is a column rather than none at all.
 assert.deepEqual(listFieldIds(planWith(),null),['name','stage','note']);
});

test('a relation in a tab nobody has opened is the first section, not every section',()=>{
 const first=node('sec.first','section',{},[node('rel.a','relatedList')]);
 const second=node('sec.second','section',{},[node('rel.b','relatedList')]);
 const page=node('page.deal','detailSurface',{},[node('tabs','tabGroup',{},[first,second])]);
 // Only the open tab is read, so opening a record page does not query every
 // relation the page could ever show.
 assert.deepEqual(visibleNodes(planWith(page),'relatedList').map(n=>n.semanticId),['rel.a']);
 assert.deepEqual(visibleNodes(planWith(),'relatedList'),[]);
});

test('the tone on a surface comes from the first single-choice field it binds',()=>{
 const plan=planWith();
 assert.equal(surfaceAccentFieldId(plan,node('list','recordList',{},[binding('name'),binding('stage')])),'stage');
 // A surface binding no single-choice field has no accent rather than a wrong one.
 assert.equal(surfaceAccentFieldId(plan,node('list','recordList',{},[binding('name')])),null);
 assert.equal(surfaceAccentFieldId(plan,null),null);
});

test('Studio hides a retired field, and names each one so a test can address it',()=>{
 const entity={fields:[
  {fieldId:'name',displayName:'Name',storageKind:0,required:true,presentation:'singleLine',options:[],choices:[],retired:false},
  {fieldId:'old code',displayName:'Old',storageKind:0,required:false,presentation:'singleLine',options:[],choices:[],retired:true},
 ],derivedFields:[]};
 const plans=snapshotFieldPlans(entity);
 assert.deepEqual(plans.map(f=>f.semanticId),['name']);
 // The automation target is a CSS-safe token, so a field id with a space is addressable.
 assert.equal(plans[0].automationTarget,'field-name');
 assert.equal(plans[0].required,true);
});

test('a calculated field is projected from the session, so Studio shows it with no compiled surface',()=>{
 const entity={fields:[],derivedFields:[
  {fieldId:'Days open',displayName:'Days open',resultType:'integer',resultNullable:true,calculationId:'c1',expression:'now - opened'},
 ]};
 const [derived]=derivedFor(entity);
 assert.equal(derived.semanticId,'Days open');
 assert.equal(derived.automationTarget,'nendo-days-open');
 assert.equal(derived.expression,'now - opened');
 // An entity that declares none is empty, never undefined.
 assert.deepEqual(derivedFor({fields:[]}),[]);
});

test('a timeline opens on this year, dated, and its window key names the surface, the mode and the year',()=>{
 const year=new Date().getFullYear();
 assert.equal(timelineYearFor('tl'),year);
 assert.equal(timelineModeFor('tl'),'dated');
 assert.equal(timelineKeyFor(node('tl','timelineSurface',{dateFieldId:'due'})),JSON.stringify(['timeline','tl','dated',year]));
});

test('today is read in the device calendar, because Today has to mean the owner’s today',()=>{
 const now=new Date();
 const today=todayCivil();
 assert.equal(today.month.year,now.getFullYear());
 assert.equal(today.month.month,now.getMonth()+1);
 assert.equal(today.day,now.getDate());
});

// One rule for every exact read on a surface. It was written three times and one of the
// three disagreed: a refused tile counted as still pending, so the chase asked again a
// second later, redrew the page, found it pending and asked again. The owner saw a
// screen flicker once a second behind one Unavailable tile, and a record page that
// scrolled back to the top each time. The button beside the message is the retry.
test('a refused read waits for Retry rather than asking again a second later',()=>{
 assert.equal(readIsPending(undefined,7),true,'nothing known must be read');
 assert.equal(readIsPending({state:'loading'},7),false,'a read in flight must not be reissued');
 assert.equal(readIsPending({state:'ready',changeSequence:7},7),false,'an answer for this revision is done');
 assert.equal(readIsPending({state:'ready',changeSequence:6},7),true,'an answer for an older revision is stale');
 assert.equal(readIsPending({state:'failed',changeSequence:7},7),false,'a refusal must not loop');
 assert.equal(readIsPending({state:'failed'},7),false,'a refusal with no revision must not loop either');
});
