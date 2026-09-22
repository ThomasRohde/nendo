import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/page-markup.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {inspectorMarkup,pageFormBody,pageHasTabs,recordActionsMarkup,recordHeroMarkup} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties={},children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const binding=(fieldId)=>node(`bind.${fieldId}`,'fieldBinding',{fieldId});
const field=(semanticId,presentation='singleLine',extra={})=>({semanticId,displayName:semanticId,presentation,retired:false,required:false,storageKind:0,options:[],choices:[],...extra});
const stage=field('stage','singleChoice',{options:['open','won'],choices:[{id:'open',displayName:'Open',retired:false},{id:'won',displayName:'Won',retired:false}]});
const planWith=(...surfaces)=>({entity:{semanticId:'deal',displayName:'Deal',fields:[field('name'),stage,field('note')],derivedFields:[]},records:[],surfaces});
const record={semanticId:'r1',automationTarget:'record-r1',version:2,values:{name:'Acme',stage:'won',note:'hi'},referenceLabels:null,calculations:null};

test('the page keeps every node where it was authored, not grouped by kind',()=>{
 const page=node('page.deal','detailSurface',{},[
  binding('name'),
  node('rel.tasks','relatedList',{title:'Tasks'}),
  node('sec.more','section',{title:'More'},[binding('note')]),
 ]);
 const body=pageFormBody(planWith(page),record,true);
 // A related list authored between two fields stays between them. The old
 // flattening collected fields first and had nowhere to put this.
 assert.ok(body.indexOf('name')<body.indexOf('data-related="rel.tasks"'));
 assert.ok(body.indexOf('data-related="rel.tasks"')<body.indexOf('<summary>More</summary>'));
});

test('a section is a disclosure that starts as the author said, with its fields in the form either way',()=>{
 const page=node('page.deal','detailSurface',{},[
  node('sec.more','section',{title:'More'},[binding('note')]),
  node('sec.later','section',{title:'Later',opens:'closed'},[binding('stage')]),
 ]);
 const body=pageFormBody(planWith(page),record,true);
 // The heading is the control (ADR-0004, 2026-09-20 amendment).
 assert.match(body,/<details class="form-section" data-section="sec\.more" open ><summary>More<\/summary>/);
 assert.match(body,/<details class="form-section" data-section="sec\.later"  ><summary>Later<\/summary>/);
 // Closed is not removed: a save still carries what the section holds.
 assert.ok(body.includes('name="stage"'));
});

test('a field bound twice has one editor and a note saying where the other one is',()=>{
 const page=node('page.deal','detailSurface',{},[
  binding('name'),
  node('sec.more','section',{title:'More'},[binding('name')]),
 ]);
 const body=pageFormBody(planWith(page),record,true);
 assert.match(body,/class="field-repeat">name is edited under this page\./);
 // One editor means one draft value and one validation state.
 assert.equal(body.split('name="name"').length-1,1);
});

test('a new record is not scoped to relations or totals it does not have yet',()=>{
 const page=node('page.deal','detailSurface',{},[binding('name'),node('rel.tasks','relatedList',{title:'Tasks'})]);
 const creating=pageFormBody(planWith(page),null,false);
 assert.ok(!creating.includes('data-related'),'a record that does not exist has no related rows');
 assert.match(creating,/name="name"/);
});

test('a page that renders nothing falls back to the record type’s own fields',()=>{
 // An application with no record page at all.
 const body=pageFormBody(planWith(node('list.deal','recordList',{},[binding('name')])),record,true);
 assert.match(body,/name="name"/);
 assert.match(body,/name="stage"/);
 assert.match(body,/name="note"/);
});

test('tabs get the roles and ids a keyboard owner needs, and only the open panel is shown',()=>{
 const page=node('page.deal','detailSurface',{},[node('tabs','tabGroup',{title:'Deal'},[
  node('sec.one','section',{title:'One'},[binding('name')]),
  node('sec.two','section',{title:'Two'},[binding('note')]),
 ])]);
 const plan=planWith(page);
 assert.equal(pageHasTabs(plan),true);
 assert.equal(pageHasTabs(planWith(node('page.deal','detailSurface',{},[binding('name')]))),false);
 const body=pageFormBody(plan,record,true);
 assert.match(body,/role="tablist" aria-label="Deal"/);
 assert.match(body,/id="tab-page-deal-tabs-sec-one"[^>]*aria-controls="panel-page-deal-tabs-sec-one"/);
 // Roving focus: the open tab is the one tab stop for the whole strip.
 assert.match(body,/data-tab="sec.one"[^>]*>One</);
 assert.match(body,/aria-selected="true" tabindex="0"[^>]*data-tab="sec.one"/);
 assert.match(body,/aria-selected="false" tabindex="-1"[^>]*data-tab="sec.two"/);
 // Every panel is in the form, so a tab change never discards typing.
 assert.match(body,/data-tab-panel="sec.two"[^>]*hidden/);
 assert.match(body,/name="note"/);
});

test('the record header draws nothing unless the page names a field for it',()=>{
 const bare=node('page.deal','detailSurface',{},[binding('name')]);
 assert.equal(recordHeroMarkup(planWith(bare),record),'');
 const titled=node('page.deal','detailSurface',{titleFieldId:'name',subtitleFieldId:'note',accentFieldId:'stage'},[binding('name')]);
 const hero=recordHeroMarkup(planWith(titled),record);
 assert.match(hero,/data-testid="record-hero"/);
 assert.match(hero,/<h2>Acme<\/h2>/);
 assert.match(hero,/<p>hi<\/p>/);
 assert.match(hero,/class="card-chip"/);
 // A form-only application has no record page, so it has no header either.
 assert.equal(recordHeroMarkup(planWith(node('form.deal','recordForm',{titleFieldId:'name'})),record),'');
});

test('the commands sit in their own row, and there is no empty row when there are none',()=>{
 assert.equal(recordActionsMarkup(planWith(node('page.deal','detailSurface',{},[binding('name')])),record),'');
 const withCommand=planWith(node('page.deal','detailSurface',{},[node('cmd.win','recordCommand',{label:'Mark won'})]));
 const actions=recordActionsMarkup(withCommand,record);
 assert.match(actions,/data-testid="record-actions"/);
 assert.match(actions,/data-run-command="cmd.win"/);
});

test('the inspector carries the close control and the record version',()=>{
 const markup=inspectorMarkup(planWith(node('page.deal','detailSurface',{},[binding('name')])),record);
 assert.match(markup,/class="record-inspector"/);
 assert.match(markup,/id="close-inspector"[^>]*data-dismiss/);
 assert.match(markup,/<form id="record-form"/);
 assert.match(markup,/Record version 2/);
});
