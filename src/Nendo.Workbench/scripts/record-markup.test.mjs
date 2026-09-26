import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/record-markup.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {accentDot,commandButtons,fieldControlMarkup,fieldMarkup,fieldValueMarkup,recordCardMarkup,recordFieldDisplay,recordFormMarkup,recordSheetMarkup,relatedKey,relatedListEmpty,relatedListMarkup,stepSatisfied,summaryTileGroupMarkup,summaryTileMarkup,treeCommandMarkup} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

// These are the hooks the runtime journeys click: data-record-id, data-run-command,
// data-summary, data-related and #record-form. A refactor that drops one of them
// breaks a gate that takes minutes to run, so they are asserted here in seconds.

const node=(semanticId,kind,properties={},children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const field=(semanticId,presentation='singleLine',extra={})=>({semanticId,displayName:semanticId,presentation,retired:false,required:false,storageKind:0,options:[],choices:[],...extra});
const stage=field('stage','singleChoice',{options:['open','won'],choices:[{id:'open',displayName:'Open',retired:false},{id:'won',displayName:'Won',retired:false}]});
const plan={entity:{semanticId:'deal',displayName:'Deal',fields:[field('name'),stage,field('note')],derivedFields:[]},records:[],surfaces:[]};
const record={semanticId:'r1',automationTarget:'record-r1',version:3,values:{name:'Acme',stage:'won',note:'hi'},referenceLabels:null,calculations:null};

test('a card is addressable by record id and names the record in its accessible label',()=>{
 const markup=recordCardMarkup(plan,record,['name','stage','note']);
 assert.match(markup,/data-record-id="r1"/);
 assert.match(markup,/aria-label="Open Acme"/);
 // A choice reads as status and takes the chip treatment its board column has.
 // The display name is resolved from the open session, which a bundled test has
 // none of, so the stored id is what shows here.
 assert.match(markup,/class="card-chip"[^>]*>won</);
 assert.match(markup,/<small>note<\/small>hi/);
 assert.match(markup,/<small>v3<\/small>/);
});

test('a rating reads as dots wherever a value is shown, and as its number when it is out of scale',()=>{
 const rated=field('confidence','rating',{storageKind:1,scale:{min:1,max:5}});
 const ratingPlan={...plan,entity:{...plan.entity,fields:[field('name'),rated]}};
 const inScale={...record,values:{name:'Acme',confidence:{$nendoNumber:'4'}}};
 const card=recordCardMarkup(ratingPlan,inScale,['name','confidence']);
 assert.match(card,/aria-label="4 of 5"/);
 assert.equal((card.match(/rating-dot/g)??[]).length,5);
 assert.equal((card.match(/is-filled/g)??[]).length,4);

 const outside={...record,values:{name:'Acme',confidence:{$nendoNumber:'9'}}};
 const issue=fieldValueMarkup(ratingPlan,outside,'confidence','Not set');
 assert.match(issue,/is-outside/);
 assert.match(issue,/>9</);
 assert.match(issue,/outside 1–5/);

 // An unset rating takes the caller's own fallback, as every other value does.
 assert.equal(fieldValueMarkup(ratingPlan,{...record,values:{name:'Acme'}},'confidence','Not set'),'Not set');
 assert.equal(fieldValueMarkup(ratingPlan,{...record,values:{name:'Acme'}},'confidence','—'),'—');
});

test('a rating is edited as radios carrying the field name, with Not set only when optional',()=>{
 const optional=fieldControlMarkup(field('confidence','rating',{storageKind:1,scale:{min:1,max:5}}),{$nendoNumber:'4'});
 assert.equal((optional.match(/type="radio"/g)??[]).length,6);
 assert.match(optional,/name="confidence"/);
 assert.match(optional,/value="4" checked/);
 assert.match(optional,/Not set/);

 const required=fieldControlMarkup(field('confidence','rating',{storageKind:1,required:true,scale:{min:1,max:5}}),null);
 assert.equal((required.match(/type="radio"/g)??[]).length,5);
 assert.ok(!required.includes('Not set'));
});

test('a card carries its surface’s tone only where one is given',()=>{
 const toned=recordCardMarkup(plan,record,['name','note'],'--status-color: var(--tone-green)');
 assert.match(toned,/class="record-card is-toned"/);
 assert.match(toned,/style="--status-color: var\(--tone-green\)"/);
 // A board card names no accent, so it is the neutral card it has always been.
 assert.match(recordCardMarkup(plan,record,['name','note']),/class="record-card"/);
 assert.ok(!recordCardMarkup(plan,record,['name','note']).includes('is-toned'));
});

test('a card with nothing in its heading field still says which record type it is',()=>{
 const blank={...record,values:{stage:'won'}};
 assert.match(recordCardMarkup(plan,blank,['name','note']),/<strong>Untitled Deal<\/strong>/);
 // A detail field with no value reads as Not set rather than as an empty cell.
 assert.match(recordCardMarkup(plan,blank,['name','note']),/<small>note<\/small>Not set/);
});

test('a value is escaped everywhere it reaches the page',()=>{
 const hostile={...record,values:{name:'<img src=x onerror=alert(1)>',stage:'won'}};
 const markup=recordCardMarkup(plan,hostile,['name']);
 assert.ok(!markup.includes('<img'),'the tag must not survive into the card');
 assert.match(markup,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.match(markup,/aria-label="Open &lt;img/);
});

test('an accent dot is drawn only where the record actually holds a choice',()=>{
 assert.match(accentDot(plan,'stage',record),/class="status-dot"/);
 assert.equal(accentDot(plan,null,record),'');
 assert.equal(accentDot(plan,'stage',{...record,values:{stage:''}}),'');
 assert.equal(accentDot(plan,'stage',{...record,values:{}}),'');
});

test('a calculated field is read from its result, never from the blank it has in values',()=>{
 const derived=[{semanticId:'total',displayName:'Total',resultType:'integer',resultNullable:true,calculationId:'c',expression:'1'}];
 const calculated={...record,calculations:{total:{state:'value',value:{$nendoNumber:'12.50'}}}};
 assert.equal(recordFieldDisplay(calculated,'total',derived),'12.50');
 // A stored value is shown as stored; a reference shows its label.
 assert.equal(recordFieldDisplay(record,'note',derived),'hi');
 assert.equal(recordFieldDisplay({...record,values:{ref:'id-1'},referenceLabels:{ref:'Target'}},'ref',derived),'Target');
 // A target whose label cannot be read says so rather than showing a raw id.
 assert.equal(recordFieldDisplay({...record,values:{ref:'id-1'},referenceLabels:{ref:''}},'ref',derived),'(No target label)');
});

test('a tile that has not answered yet is busy, not zero',()=>{
 const tile=node('tile.count','summaryTile',{title:'Open deals'});
 const markup=summaryTileMarkup(tile,{kind:'surface',surface:node('list.deal','recordList')});
 assert.match(markup,/data-summary="tile.count"/);
 assert.match(markup,/aria-busy="true"/);
 // A count of zero is a real zero, so nothing may render one before an answer.
 assert.ok(!markup.includes('>0<'),'an unread tile must not show a number');
});

test('a group of no tiles and no charts draws nothing at all',()=>{
 assert.equal(summaryTileGroupMarkup([]),'');
 assert.match(summaryTileGroupMarkup([{tile:node('t','summaryTile'),scope:{kind:'surface',surface:node('list.deal','recordList')}}]),/class="summary-tiles"/);
});

test('a related list that has not loaded says so, and one with nothing in it says that instead',()=>{
 const relation=node('rel.tasks','relatedList',{title:'Tasks',targetEntityId:'task'},[node('b','fieldBinding',{fieldId:'title'})]);
 const markup=relatedListMarkup(relation,record);
 assert.match(markup,/data-related="rel.tasks"/);
 assert.match(markup,/<h3>Tasks<\/h3>/);
 assert.match(markup,/Loading…/);
 assert.equal(relatedKey(relation,'r1'),'rel.tasks:r1');
});

test('a relation with nothing in it names the type and the field (W-042)',()=>{
 // "No related records yet." was the same sentence on every relation of a page that has
 // four of them, and it named neither half of the inverse the node already carries.
 const relation=node('rel.tasks','relatedList',{title:'Tasks',targetEntityId:'task',viaFieldId:'task.deal'});
 const entities=[{entityId:'task',displayName:'Task',fields:[{fieldId:'task.deal',displayName:'Deal',storageKind:0,required:false,presentation:null,options:[]}]}];
 assert.equal(relatedListEmpty(relation,entities),'No Task records point at this one through Deal yet.');

 // It states what it can and stops. The relation's Add sits beside this sentence rather
 // than inside it (ADR-0004, 2026-09-18 amendment), so the sentence names what is missing
 // and the button is the thing that is done about it.
 assert.ok(!/Add/.test(relatedListEmpty(relation,entities)));

 // A record type the session has not got is not guessed at from its ID.
 assert.equal(relatedListEmpty(relation,[]),'No related records yet.');
 assert.equal(relatedListEmpty(node('rel','relatedList',{targetEntityId:'task'}),entities),'No related records yet.');
});

test('the form is one element the wiring can find, and offers Delete only on a saved record',()=>{
 const create=recordFormMarkup(null,[field('name')],'Add Deal');
 assert.match(create,/<form id="record-form"/);
 assert.match(create,/id="cancel-create"/);
 assert.ok(!create.includes('id="delete-record"'),'a record that does not exist cannot be deleted');
 assert.match(create,/type="submit">Add Deal</);
 // Where the page owns tabs it owns validation, or the browser blocks the submit
 // on a required field inside a panel nobody can see.
 assert.match(recordFormMarkup(null,[],'Add',' ',' ',true),/novalidate/);
 assert.ok(!recordFormMarkup(null,[],'Add',' ',' ',false).includes('novalidate'));
});

test('the record page sorts fields by the room they need (W-071)',()=>{
 // Direction A of the record details canvas: long text in the wide main column, every
 // one-line field in the side panel, the first line of text heading the page. Asserted
 // here because the gate only ever reads one record type's page.
 const text={backId:'close-inspector',backLabel:'Back to Data',headingId:'record-details-heading',heading:'Deal details',submitLabel:'Save changes'};
 const fields=[field('name'),stage,field('note','longText'),field('brief','longText')];
 const sheet=recordSheetMarkup('Deal',record,fields,[],text);
 const [main,side]=sheet.split('<aside');
 assert.match(sheet,/^<form id="record-form" class="record-form record-sheet">/);
 assert.match(sheet,/id="close-inspector"[^>]*data-dismiss/);
 assert.match(sheet,/<h2 id="record-details-heading">Deal details<\/h2>/);
 assert.match(main,/class="record-sheet-title">(<div class="scalar-field">)?<label>name<input name="name"/);
 assert.match(main,/<textarea name="note"/);
 assert.match(main,/<textarea name="brief"/);
 assert.ok(!main.includes('name="stage"'),'a choice fits on a line and belongs in the side panel');
 assert.match(side,/<h3>Properties<\/h3>[\s\S]*<select name="stage"/);
 assert.ok(!side.includes('<textarea'),'long text never lands in the side panel');
 assert.match(side,/<dt>Version<\/dt><dd class="record-sheet-mono">3<\/dd>/);
 assert.match(side,/<dt>Record id<\/dt><dd[^>]*>r1<\/dd>/);
 // Everything a save reads is still inside the one form.
 assert.ok(sheet.trimEnd().endsWith('</form>'));

 // With no long text there is nothing wide to show, so the fields fill the main column
 // and the side panel keeps only the record's own facts.
 const compact=recordSheetMarkup('Deal',record,[field('name'),stage],[],text);
 const [compactMain,compactSide]=compact.split('<aside');
 assert.match(compact,/class="record-form record-sheet is-compact"/);
 assert.match(compactMain,/class="record-sheet-grid">[\s\S]*name="stage"/);
 assert.ok(!compactSide.includes('Properties<'),'an empty Properties heading is not drawn');

 // A new record has no version, no id and nothing to delete.
 const create=recordSheetMarkup('Deal',null,fields,[],{...text,backId:'cancel-create',submitLabel:'Add Deal'});
 assert.match(create,/id="cancel-create"/);
 assert.ok(!create.includes('delete-record'));
 assert.ok(!create.includes('Record id'));
 assert.match(create,/type="submit">Add Deal</);
});

test('a retired field is shown with its values but cannot be edited',()=>{
 const markup=fieldMarkup(record,{...field('note'),retired:true});
 assert.match(markup,/<fieldset disabled>/);
 assert.match(markup,/note \(retired\)/);
});

test('a command whose values the record already holds is spent and cannot be run again',()=>{
 const step=(fieldId,value)=>node('s','commandStep',{fieldId,valueKind:'literal',value});
 const won=node('cmd.win','recordCommand',{label:'Mark won'},[step('stage','won')]);
 const lose=node('cmd.lose','recordCommand',{label:'Mark lost'},[step('stage','lost')]);
 assert.match(treeCommandMarkup(won,record,false),/data-run-command="cmd.win"[^>]*disabled/);
 assert.ok(!/disabled/.test(treeCommandMarkup(lose,record,false)));
 // today and now resolve at execution, so a step using one is never spent.
 const dated=node('cmd.now','recordCommand',{label:'Stamp'},[node('s','commandStep',{fieldId:'note',valueKind:'today'})]);
 assert.ok(!/disabled/.test(treeCommandMarkup(dated,record,false)));
 assert.equal(stepSatisfied(step('stage','won'),record),true);
 assert.equal(stepSatisfied(node('s','commandStep',{fieldId:'missing',valueKind:'null'}),record),true);
});

test('two commands with the same label are told apart by an accessible name',()=>{
 const same=(id)=>node(id,'recordCommand',{label:'Run'},[]);
 const twin={...plan,surfaces:[node('page','detailSurface',{},[same('cmd.a'),same('cmd.b')])]};
 const markup=commandButtons(twin,record);
 assert.match(markup,/data-run-command="cmd.a" aria-label="Run \(cmd.a\)"/);
 assert.match(markup,/data-run-command="cmd.b" aria-label="Run \(cmd.b\)"/);
 // A command with a label of its own needs no override.
 const distinct={...plan,surfaces:[node('page','detailSurface',{},[node('cmd.a','recordCommand',{label:'Win'}),node('cmd.b','recordCommand',{label:'Lose'})])]};
 assert.ok(!commandButtons(distinct,record).includes('aria-label'));
});
