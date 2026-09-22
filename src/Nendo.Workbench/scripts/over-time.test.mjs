import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// The two kinds that group by a civil date, ADR-0004 2026-09-16 amendment (S5). What is
// asserted here is the composition and the drawing: that a bucket with nothing in it keeps
// its place, that a drill spends two clauses because a period has two ends, and that a
// closed range word becomes words a person reads rather than the word itself.
const charts = await build({configFile:false,logLevel:'error',build:{ssr:'src/charts.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {activityLevel,bucketDrillFilters,bucketLabel,bucketRead,bucketSegments,bucketSpan,busiestBucket,chartContext,chartTitle,drillLabel,isChartKind,isOverTimeKind,rangeLabel,sampleBucketed} =
 await import('data:text/javascript;base64,'+Buffer.from(charts.output.find(item=>item.type==='chunk').code).toString('base64'));
const kit = await build({configFile:false,logLevel:'error',build:{ssr:'src/chart-kit.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {columns,activityGrid} =
 await import('data:text/javascript;base64,'+Buffer.from(kit.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const fieldName=(id)=>({due:'Due',amount:'Amount'})[id]??id;
const trend=node('trend','trendChart',{dateFieldId:'due',bucket:'month',range:'last12Months',aggregate:'sum',fieldId:'amount'});
const grid=node('grid','activityGrid',{dateFieldId:'due',range:'thisYear'});
const surfaceScope={kind:'surface',surface:node('list','recordList',{entityId:'e'},[])};

test('both kinds are charts, and are known as the ones over time',()=>{
 assert.ok(isChartKind('trendChart') && isChartKind('activityGrid'));
 assert.ok(isOverTimeKind('trendChart') && isOverTimeKind('activityGrid'));
 assert.ok(!isOverTimeKind('breakdownChart'));
});

test('a grid supplies its own day bucket and count, because an author declares neither',()=>{
 const read=bucketRead(grid,surfaceScope,'e');
 assert.equal(read.bucket,'day');
 assert.equal(read.aggregate,'count');
 assert.equal(read.fieldId,null,'a grid reads no field, so none is sent');
 const trendRead=bucketRead(trend,surfaceScope,'e');
 assert.equal(trendRead.bucket,'month');
 assert.equal(trendRead.aggregate,'sum');
 assert.equal(trendRead.fieldId,'amount');
});

test('a bucket knows its own two ends, which is what a drill needs',()=>{
 assert.deepEqual(bucketSpan('month','2026-02'),{start:'2026-02-01',end:'2026-02-28'});
 assert.deepEqual(bucketSpan('month','2028-02'),{start:'2028-02-01',end:'2028-02-29'},'a leap February ends on the 29th');
 assert.deepEqual(bucketSpan('week','2026-09-14'),{start:'2026-09-14',end:'2026-09-20'});
 assert.deepEqual(bucketSpan('day','2026-09-16'),{start:'2026-09-16',end:'2026-09-16'});

 // The one drill in the product that needs two clauses: a period has two ends.
 assert.deepEqual(bucketDrillFilters(trend,'month','2026-02'),[
  {fieldId:'due',operator:'gte',value:'2026-02-01'},
  {fieldId:'due',operator:'lte',value:'2026-02-28'},
 ]);
 assert.deepEqual(bucketDrillFilters(trend,'month',null),[],'no bucket, no drill');
});

test('a bucket is labelled for a person, and a range word is said in words',()=>{
 assert.equal(bucketLabel('month','2026-09'),'Sep 2026');
 assert.equal(bucketLabel('week','2026-09-14'),'14 Sep');
 assert.equal(bucketLabel('day','2026-09-16'),'16 Sep 2026');
 assert.equal(rangeLabel('last90Days'),'the last 90 days');
 assert.equal(rangeLabel('thisYear'),'this year');
 assert.equal(chartTitle(trend,fieldName),'By Due');
 assert.equal(chartTitle(grid,fieldName),'Activity by Due');
 assert.equal(chartContext(trend,surfaceScope,fieldName),'sum of Amount per month over the last 12 months, all matching records, not just this page');
 assert.equal(chartContext(grid,surfaceScope,fieldName),'records per day over this year, all matching records, not just this page');
 assert.equal(drillLabel(trend,undefined,'2026-09',fieldName),'Due: Sep 2026');
});

test('an empty bucket keeps its place, its label and its slot in the drawing',()=>{
 const result={groups:[
  {key:'2026-07',valueLexeme:'4',contributingRecords:4},
  {key:'2026-08',valueLexeme:null,contributingRecords:0},
  {key:'2026-09',valueLexeme:'2',contributingRecords:2},
 ],start:'2026-07-01',end:'2026-09-30',changeSequence:1};

 const segments=bucketSegments('month',result);
 assert.equal(segments.length,3,'the quiet month is a segment like any other');
 assert.equal(segments[1].label,'Aug 2026');
 assert.equal(segments[1].lexeme,null,'stated as empty, never as zero');
 assert.equal(segments[1].amount,0);

 const markup=columns({key:'k',title:'By Due',context:'c',status:{state:'ready'},segments,tableOpen:true,drillable:true});
 assert.equal((markup.match(/class="chart-column[" ]/g)??[]).length,3,'every bucket of the range is drawn');
 assert.ok(markup.includes('chart-column is-empty'),'the quiet month draws as a gap rather than being left out');
 assert.ok(markup.includes('aria-label="Aug 2026: none"'),'and says so to a screen reader');
 assert.ok(markup.includes('<th scope="row">Aug 2026</th><td>none</td>'),'and is in the table behind the toggle');
 assert.ok(markup.includes('data-chart-group="2026-08"'),'and can still be drilled into');
});

test('a grid tones against its busiest day, and zero is its own step',()=>{
 const result={groups:[
  {key:'2026-01-01',valueLexeme:'0',contributingRecords:0},
  {key:'2026-01-02',valueLexeme:'1',contributingRecords:1},
  {key:'2026-01-03',valueLexeme:'8',contributingRecords:8},
 ],start:'2026-01-01',end:'2026-01-03',changeSequence:1};
 assert.equal(busiestBucket(result),8);
 assert.equal(activityLevel('0',8),0,'a quiet day is visibly quiet, not the palest active one');
 assert.equal(activityLevel(null,8),0);
 assert.equal(activityLevel('1',8),1);
 assert.equal(activityLevel('8',8),4);
 assert.equal(activityLevel('4',8),2);

 const days=result.groups.map(group=>({key:group.key,label:bucketLabel('day',group.key),lexeme:group.valueLexeme,level:activityLevel(group.valueLexeme,8)}));
 const markup=activityGrid({key:'k',title:'Activity',context:'c',status:{state:'ready'},days,tableOpen:true,drillable:true});
 assert.equal((markup.match(/class="chart-day"/g)??[]).length,3,'every day of the range is a square');
 assert.ok(markup.includes('data-level="0"'));
 assert.ok(markup.includes('data-level="4"'));
 assert.ok(markup.includes('aria-label="1 Jan 2026: 0"'),'a quiet day still names its number');
 // The table lists the days that had records; 365 rows of zero is not a way to read one.
 assert.ok(!markup.includes('<th scope="row">1 Jan 2026</th>'));
 assert.ok(markup.includes('<th scope="row">3 Jan 2026</th><td>8</td>'));
});

test('a grid with nothing at all still draws its year and says so in the table',()=>{
 const days=['2026-01-01','2026-01-02'].map(key=>({key,label:bucketLabel('day',key),lexeme:'0',level:0}));
 const markup=activityGrid({key:'k',title:'Activity',context:'c',status:{state:'ready'},days,tableOpen:true,drillable:false});
 assert.equal((markup.match(/class="chart-day"/g)??[]).length,2);
 assert.ok(markup.includes('No records in this range.'));
});

test('a grid pads its first column to Monday, so a row is a weekday',()=>{
 // 2026-01-01 is a Thursday, so three blanks stand before it: Mon, Tue, Wed.
 const days=['2026-01-01','2026-01-02','2026-01-03'].map(key=>({key,label:bucketLabel('day',key),lexeme:'0',level:0}));
 const markup=activityGrid({key:'k',title:'Activity',context:'c',status:{state:'ready'},days,tableOpen:false,drillable:false});
 assert.equal((markup.match(/class="chart-day is-blank"/g)??[]).length,3,'a Thursday start is three blanks into its week');
 assert.equal((markup.match(/class="chart-day"/g)??[]).length,3,'and the blanks are not days');
 assert.ok(!markup.includes('is-blank" data-level'),'a blank is not toned');
 assert.ok(!markup.includes('is-blank" title'),'and is not named to anyone');

 // A Monday start needs none, which is what makes the three above a measurement.
 const monday=['2026-01-05','2026-01-06'].map(key=>({key,label:bucketLabel('day',key),lexeme:'0',level:0}));
 assert.equal((activityGrid({key:'k',title:'A',context:'c',status:{state:'ready'},days:monday,tableOpen:false,drillable:false})
  .match(/class="chart-day is-blank"/g)??[]).length,0,'2026-01-05 is a Monday and starts its own column');

 // A Sunday start is six in, the far end of the same rule.
 const sunday=[{key:'2026-01-04',label:bucketLabel('day','2026-01-04'),lexeme:'0',level:0}];
 assert.equal((activityGrid({key:'k',title:'A',context:'c',status:{state:'ready'},days:sunday,tableOpen:false,drillable:false})
  .match(/class="chart-day is-blank"/g)??[]).length,6,'2026-01-04 is a Sunday, the last row of its week');
});

test('the preview generates its buckets from the range, not from the sample',()=>{
 const today=new Date('2026-09-16T00:00:00Z');
 const records=[{values:{due:'2026-09-02'}},{values:{due:'2026-09-30'}},{values:{due:'2019-01-01'}},{values:{due:null}}];
 const sample=sampleBucketed(trend,records,today);
 assert.equal(sample.groups.length,12,'twelve months, whatever the sample touched');
 assert.equal(sample.start,'2025-10-01');
 assert.equal(sample.end,'2026-09-30');
 assert.equal(sample.groups.at(-1).key,'2026-09');
 assert.equal(sample.groups.at(-1).valueLexeme,'2','both September records counted');
 assert.equal(sample.groups[0].valueLexeme,'0','and a month the sample never touched is still there');
});
