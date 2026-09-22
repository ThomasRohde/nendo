import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/surface-preview.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {surfacePreviewMarkup,overviewPreviewMarkup} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));
const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const app = {entity:{semanticId:'e',displayName:'Entry',fields:[{semanticId:'title',displayName:'Title',options:[],choices:[]},{semanticId:'status',displayName:'Status',options:['new'],choices:[{id:'new',displayName:'New label'}]}]},records:[{semanticId:'r',version:1,values:{title:'<script>alert("x")</script>',status:'new'}}],surfaces:[
 node('formRoot','recordForm',{definitionVersion:3,entityId:'e',title:'Entry form'},[node('formTitle','fieldBinding',{fieldId:'title'})]),
 node('boardRoot','boardSurface',{definitionVersion:3,entityId:'e',title:'Board',groupByFieldId:'status'},[node('boardTitle','fieldBinding',{fieldId:'title'})]),
 node('commandRoot','recordCommand',{definitionVersion:3,entityId:'e',label:'Finish'},[node('commandStatus','commandStep',{fieldId:'status',valueKind:'literal',value:'new'})]),
]};
test('preview escapes application text and keeps a form and a command read-only',()=>{
 const form = surfacePreviewMarkup(app,'formRoot',0,200);
 assert.ok(form.includes('&lt;script&gt;'));
 assert.ok(!form.includes('<script>'));
 assert.ok(form.includes('readonly aria-readonly="true"'));
 assert.ok(form.includes('1 of 200 records'));
 const command=surfacePreviewMarkup(app,'commandRoot',0,200);
 assert.ok(command.includes('Sets Status to New label.'));
 assert.ok(command.includes('class="command-button" disabled'));
 assert.ok(!command.includes('data-action'));
});
test('preview accounts for ungrouped records and uses derivative choice labels',()=>{
 const board=surfacePreviewMarkup({...app,records:[...app.records,{semanticId:'other',version:1,values:{title:'Missing status'}}]},'boardRoot',0,2);
 assert.ok(board.includes('Ungrouped'));
 assert.ok(board.includes('Missing status'));
 assert.ok(board.includes('New label'));
 assert.ok(!board.includes('data-group='));
 assert.ok(!board.includes('data-record-id='));
});

// A review that cannot preview a surface asks a person to approve screens it
// cannot show.
const composable = {
 entity:app.entity,
 records:app.records,
 surfaces:[
  node('entryPage','detailSurface',{definitionVersion:3,entityId:'e',title:'Entry'},[
   node('entryMain','section',{title:'Main'},[node('entryTitle','fieldBinding',{fieldId:'title'})]),
   node('entryRelated','relatedList',{targetEntityId:'note',viaFieldId:'noteEntry',title:'Notes'},[
    node('entryNoteTitle','fieldBinding',{fieldId:'title'}),
    node('entryNoteCount','summaryTile',{aggregate:'count',title:'Notes'}),
   ]),
  ]),
  node('entryOpen','recordList',{definitionVersion:3,entityId:'e',title:'Open entries'},[
   node('entryOpenTitle','fieldBinding',{fieldId:'title'}),
   node('entryOpenFilter','filterClause',{fieldId:'status',operator:'eq',value:'new'}),
  ]),
  node('entryBoard','boardSurface',{definitionVersion:3,entityId:'e',title:'Flow',groupByFieldId:'status'},[
   node('entryCardTitle','fieldBinding',{fieldId:'title'}),
  ]),
  node('entryFinish','recordCommand',{definitionVersion:3,entityId:'e',label:'Finish'},[
   node('entryFinishStatus','commandStep',{fieldId:'status',valueKind:'literal',value:'new'}),
  ]),
 ],
};
test('preview renders a composed node tree rather than an empty panel',()=>{
 const page=surfacePreviewMarkup(composable,'entryPage',0,1);
 assert.ok(page.includes('<summary>Main</summary>'));
 assert.ok(page.includes('readonly aria-readonly="true"'));
 assert.ok(page.includes('Notes'));
 assert.ok(page.includes('&lt;script&gt;'));
 assert.ok(!page.includes('<script>'));

 const list=surfacePreviewMarkup(composable,'entryOpen',0,1);
 assert.ok(list.includes('Showing records where Status eq new.'));

 const board=surfacePreviewMarkup(composable,'entryBoard',0,1);
 assert.ok(board.includes('New label'),'a version 3 board groups by the declared options');

 const command=surfacePreviewMarkup(composable,'entryFinish',0,1);
 assert.ok(command.includes('Sets Status to New label.'));
 assert.ok(command.includes('class="command-button" disabled'));

 // Every root is reachable from the switcher, including by its own title.
 for (const label of ['Entry','Open entries','Flow','Finish']) assert.ok(page.includes(label));
});

// Every widened kind needs its own preview branch. An unknown visible node used
// to fall through to form markup, so a board with a total previewed as a form.
const widened = {
 entity:{semanticId:'e',displayName:'Entry',fields:[
  {semanticId:'title',displayName:'Title',options:[],choices:[]},
  {semanticId:'status',displayName:'Status',options:['new'],choices:[{id:'new',displayName:'New label'}]},
  {semanticId:'amount',displayName:'Amount',options:[],choices:[]},
  {semanticId:'due',displayName:'Due',options:[],choices:[]},
  {semanticId:'until',displayName:'Until',options:[],choices:[]},
 ]},
 records:[
  {semanticId:'r1',version:1,values:{title:'First',status:'new',amount:'10',due:'2026-09-01',until:'2026-09-30'}},
  {semanticId:'r2',version:1,values:{title:'Second',status:'new',amount:'20',due:'2026-09-30'}},
  {semanticId:'r3',version:1,values:{title:'No date',status:'new',amount:'30'}},
 ],
 surfaces:[
  node('openList','recordList',{definitionVersion:3,entityId:'e',title:'Open'},[
   node('openTitle','fieldBinding',{fieldId:'title'}),
   node('openTotal','summaryTile',{aggregate:'count',title:'Open entries'}),
  ]),
  node('flowBoard','boardSurface',{definitionVersion:3,entityId:'e',title:'Flow',groupByFieldId:'status'},[
   node('flowTitle','fieldBinding',{fieldId:'title'}),
   node('flowTotal','summaryTile',{aggregate:'sum',fieldId:'amount',title:'Column value',scope:'group'}),
  ]),
  node('duePage','detailSurface',{definitionVersion:3,entityId:'e',title:'Entry'},[
   node('dueTabs','tabGroup',{title:'Details'},[
    node('dueIdentity','section',{title:'Identity'},[node('dueTitleBinding','fieldBinding',{fieldId:'title'})]),
    node('dueNumbers','section',{title:'Numbers'},[node('dueAmountBinding','fieldBinding',{fieldId:'amount'})]),
   ]),
  ]),
  node('dueCalendar','calendarSurface',{definitionVersion:3,entityId:'e',title:'Due dates',dateFieldId:'due'},[
   node('dueCalTitle','fieldBinding',{fieldId:'title'}),
  ]),
  node('dueTimeline','timelineSurface',{definitionVersion:3,entityId:'e',title:'Over time',dateFieldId:'due',endDateFieldId:'until',titleFieldId:'title',accentFieldId:'status'},[
   node('dueTlStatus','fieldBinding',{fieldId:'status'}),
  ]),
  node('entryCards','gallerySurface',{definitionVersion:3,entityId:'e',title:'Cards',titleFieldId:'title',accentFieldId:'status'},[
   node('cardTitle','fieldBinding',{fieldId:'title'}),
   node('cardAmount','fieldBinding',{fieldId:'amount'}),
   node('cardTotal','summaryTile',{aggregate:'count',title:'Cards shown'}),
  ]),
 ],
};

test('preview renders a list and board total as meaning rather than a fabricated number',()=>{
 const list=surfacePreviewMarkup(widened,'openList',0,500);
 assert.ok(list.includes('summary-tile'));
 assert.ok(list.includes('Open entries'));
 assert.ok(list.includes('over every matching record'));
 // The preview carries a bounded sample, not a query result, so it says so
 // rather than showing the sample size as the total.
 assert.ok(list.includes('Showing a sample of 3 records'));
 assert.ok(!/summary-value/.test(list),'a preview must not state a total it cannot compute');

 const board=surfacePreviewMarkup(widened,'flowBoard',0,500);
 assert.ok(board.includes('sum of Amount'));
 assert.ok(board.includes('over each board column'),'scope group means one column, and the preview says which');
});

test('preview renders tabs with its own selection and no writes',()=>{
 const page=surfacePreviewMarkup(widened,'duePage',0,3);
 assert.ok(page.includes('role="tablist"'));
 assert.ok(page.includes('aria-label="Details"'));
 assert.ok(page.includes('data-preview-tab="dueIdentity"'));
 assert.ok(page.includes('aria-selected="true"'));
 // A tab is named by its button, so the panel carries the fields directly and
 // is labelled by the tab rather than nesting a second heading inside it.
 assert.ok(page.includes('aria-label="Identity"'));
 assert.ok(page.includes('aria-label="Numbers"'));
 // The first tab is open and the second is rendered but hidden, so preview and
 // Use agree about which tab holds which field.
 assert.equal(page.match(/role="tabpanel"/g).length,2);
 assert.equal(page.match(/role="tabpanel"[^>]*hidden/g).length,1);
 assert.ok(page.includes('Title'));
 assert.ok(page.includes('Amount'));
 assert.ok(page.includes('readonly aria-readonly="true"'));
 assert.ok(!page.includes('data-action'));
});

test('preview places calendar entries by the same civil date grouping',()=>{
 const calendar=surfacePreviewMarkup(widened,'dueCalendar',0,3);
 assert.ok(calendar.includes('record-calendar'));
 // Monday first, and the dated sample placed in the month it falls in.
 assert.ok(calendar.includes('>Mon<'));
 assert.ok(calendar.includes('September 2026'));
 assert.ok(calendar.includes('calendar-entry'));
 assert.ok(calendar.includes('First'));
 assert.ok(calendar.includes('Second'));
 // The undated record is not placed on a day, and is not silently lost either.
 assert.ok(calendar.includes('Placing the 2 dated records'));
 assert.ok(/1 record has no Due/.test(calendar));
 assert.ok(calendar.includes('Undated view'));
 // A calendar is not previewed as a form.
 assert.ok(!calendar.includes('class="record-form"'));
});

test('preview places timeline entries by month, draws a span to scale and keeps the undated count',()=>{
 const timeline=surfacePreviewMarkup(widened,'dueTimeline',0,3);
 assert.ok(timeline.includes('record-timeline'));
 assert.ok(timeline.includes('September 2026'));
 assert.ok(timeline.includes('timeline-entry'));
 assert.ok(timeline.includes('First'));
 assert.ok(timeline.includes('Second'));
 // The span carries both dates and its inclusive day count beside the bar, and
 // the year note states the scale the bar is drawn to.
 assert.ok(timeline.includes('1 Sep – 30 Sep · 30 days'));
 assert.ok(timeline.includes('--span: 8.2%'));
 assert.ok(timeline.includes('365 days of 2026'));
 // The accent field tones the dot, through the same style every surface uses.
 assert.ok(timeline.includes('--status-color'));
 assert.ok(timeline.includes('Placing the 2 dated records'));
 assert.ok(/1 record has no Due/.test(timeline));
 assert.ok(timeline.includes('Undated view'));
 // A timeline is not previewed as a form, and its entries open nothing.
 assert.ok(!timeline.includes('class="record-form"'));
 assert.ok(!timeline.includes('data-record-id'));
});

test('preview draws gallery cards over the sample, toned and titled as authored',()=>{
 const gallery=surfacePreviewMarkup(widened,'entryCards',0,3);
 assert.ok(gallery.includes('record-gallery'));
 assert.ok(gallery.includes('record-card'));
 assert.ok(gallery.includes('First'));
 assert.ok(gallery.includes('Second'));
 // The accent field tones the card edge through the same custom property every
 // toned surface uses.
 assert.ok(gallery.includes('is-toned'));
 assert.ok(gallery.includes('--status-color'));
 // A gallery takes a list's tiles, and the preview states what they will count
 // rather than fabricating a number.
 assert.ok(gallery.includes('Cards shown'));
 assert.ok(gallery.includes('over every matching record'));
 assert.ok(!/summary-value/.test(gallery));
 assert.ok(gallery.includes('Showing a sample of 3 records'));
 // A gallery is not previewed as a form, and its cards open nothing.
 assert.ok(!gallery.includes('class="record-form"'));
 assert.ok(!gallery.includes('data-record-id'));
});

test('every widened root is reachable from the preview switcher',()=>{
 const markup=surfacePreviewMarkup(widened,'openList',0,3);
 for (const label of ['Open','Flow','Entry','Due dates','Over time','Cards']) assert.ok(markup.includes(label),label);
});

// Owner-reported from a real proposal review, 2026-09-17: the front page preview said
// "Recently delivered — up to 10 of Work items" over a node carrying limit 5, and the
// section holding the trend and the activity grid listed no children at all. Both
// numbers and both lines are read straight off the node here.
const overviewOf = (...children) => ({
  contractVersion: 3,
  applicationId: 'a',
  definitionRevision: 1,
  entities: [{ semanticId: 'w', displayName: 'Work items', fields: [{ semanticId: 'done', displayName: 'Completed on', options: [], choices: [] }] }],
  surface: { semanticId: 'overview', automationTarget: 'overview', kind: 'overviewSurface', properties: { title: 'Nendo Development' }, children },
});
const overviewNode = (semanticId, kind, properties, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });

test('a recent list states the limit its node carries, not the renderer default', () => {
  // Every number crossing the desktop bridge arrives in this envelope, so this is the
  // shape the real preview sees -- a plain 5 never reaches it.
  const markup = overviewPreviewMarkup(overviewOf(
    overviewNode('recent', 'recentList', { entityId: 'w', title: 'Recently delivered', limit: { $nendoNumber: '5' } }),
  ));

  assert.ok(markup.includes('up to 5 of Work items'), markup);
  assert.ok(!markup.includes('up to 10'), 'the renderer default was printed over the node value');
});

test('a ranked list does the same with its own default', () => {
  const markup = overviewPreviewMarkup(overviewOf(
    overviewNode('ranked', 'rankedList', { entityId: 'w', title: 'Longest', limit: { $nendoNumber: '12' }, rankByFieldId: 'done' }),
  ));

  assert.ok(markup.includes('the top 12 of Work items'), markup);
});

test('a section holding a trend and a grid lists them rather than standing empty', () => {
  const markup = overviewPreviewMarkup(overviewOf(
    overviewNode('section', 'section', { title: 'Delivery over time' }, [
      overviewNode('trend', 'trendChart', { entityId: 'w', title: 'Delivered by month', dateFieldId: 'done', bucket: 'month' }),
      overviewNode('grid', 'activityGrid', { entityId: 'w', title: 'Days anything was delivered', dateFieldId: 'done' }),
    ]),
  ));

  assert.ok(markup.includes('Delivered by month'), 'the trend chart produced no line at all');
  assert.ok(markup.includes('Days anything was delivered'), 'the activity grid produced no line at all');
  assert.ok(markup.includes('Completed on'), 'neither line named the date field it reads');
});
