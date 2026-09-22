import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/timeline-model.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {dayMonthLabel,dayNumber,daysBetween,daysInYear,groupByMonth,monthEmptyLabel,nextYearStart,spanLabel,spanOf,spineDescending,timelineQuery,timelineStateLabel,timelineWindowKey,yearNote,yearQuery,yearStart} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(properties,children=[])=>({semanticId:'tl',automationTarget:'tl',kind:'timelineSurface',properties,children});
const clause=(fieldId,operator,value)=>({semanticId:`c.${fieldId}`,automationTarget:'c',kind:'filterClause',properties:{fieldId,operator,value},children:[]});

test('a year is two civil bounds on the date field, after the declared clauses',()=>{
 const query=yearQuery(node({dateFieldId:'due'},[clause('stage','ne','done')]),2026);
 assert.deepEqual(query.filters,[
  {fieldId:'stage',operator:'ne',value:'done'},
  {fieldId:'due',operator:'ge',value:'2026-01-01'},
  {fieldId:'due',operator:'lt',value:'2027-01-01'},
 ]);
 // Default order is the date itself; a declared order overrides it and then
 // orders within each month.
 assert.equal(query.sortFieldId,'due');
 assert.equal(query.descending,undefined);
 const declared=yearQuery(node({dateFieldId:'due',orderByFieldId:'name',orderDirection:'descending'}),2026);
 assert.equal(declared.sortFieldId,'name');
 assert.equal(declared.descending,true);
 assert.equal(yearStart(2026),'2026-01-01');
 assert.equal(nextYearStart(2026),'2027-01-01');
 // The undated view is the calendar's: the clauses plus the date being absent.
 assert.deepEqual(timelineQuery(node({dateFieldId:'due'}),'undated',2026).filters,[{fieldId:'due',operator:'isNull'}]);
 assert.deepEqual(timelineQuery(node({dateFieldId:'due'}),'dated',2026),yearQuery(node({dateFieldId:'due'}),2026));
});

test('the spine runs December first only when the date itself is sorted descending',()=>{
 assert.equal(spineDescending(node({dateFieldId:'due'})),false);
 assert.equal(spineDescending(node({dateFieldId:'due',orderDirection:'descending'})),true);
 assert.equal(spineDescending(node({dateFieldId:'due',orderByFieldId:'due',orderDirection:'descending'})),true);
 assert.equal(spineDescending(node({dateFieldId:'due',orderByFieldId:'name',orderDirection:'descending'})),false);
});

test('a timeline window is keyed by surface, mode and year, and the undated key is one window whatever the year',()=>{
 const keys=[timelineWindowKey('tl','dated',2025),timelineWindowKey('tl','dated',2026),timelineWindowKey('other','dated',2026),timelineWindowKey('tl','undated',2026)];
 assert.equal(new Set(keys).size,4);
 assert.equal(timelineWindowKey('tl','undated',2025),timelineWindowKey('tl','undated',2026));
 // Namespaced apart from the calendar's keys, so both can share one accumulator.
 assert.ok(keys.every(key=>key.startsWith('["timeline"')));
});

test('day arithmetic is civil: a leap day counts and a year boundary is one day',()=>{
 assert.equal(dayNumber('1970-01-01'),0);
 assert.equal(daysBetween('2026-02-28','2026-03-01'),1);
 assert.equal(daysBetween('2024-02-28','2024-03-01'),2);
 assert.equal(daysBetween('2026-12-31','2027-01-01'),1);
 assert.equal(daysBetween('2026-01-01','2027-01-01'),365);
 assert.equal(daysInYear(2026),365);
 assert.equal(daysInYear(2024),366);
 assert.equal(daysInYear(2100),365);
});

test('a span counts its days inclusively, is cut at the year end, and never runs backwards',()=>{
 const whole=spanOf('2026-09-14','2026-11-30',2026);
 assert.equal(whole.kind,'span');
 assert.equal(whole.span.days,78);
 assert.equal(whole.span.clipped,false);
 assert.ok(Math.abs(whole.span.proportion-78/365)<1e-9);
 assert.equal(spanLabel('2026-09-14',whole.span,2026),'14 Sep – 30 Nov · 78 days');

 const cut=spanOf('2026-12-01','2027-01-31',2026);
 assert.equal(cut.kind,'span');
 assert.equal(cut.span.days,31,'the days shown run to 31 December');
 assert.equal(cut.span.clipped,true);
 assert.equal(spanLabel('2026-12-01',cut.span,2026),'1 Dec – 31 Jan 2027 · 31 days shown; continues past 31 Dec 2026');

 assert.equal(spanOf('2026-09-14','2026-09-14',2026).span.days,1,'an end equal to the start is a one-day span');
 const backwards=spanOf('2026-09-14','2026-09-03',2026);
 assert.equal(backwards.kind,'issue');
 assert.equal(backwards.message,'Ends 3 Sep 2026, before it starts');
 assert.equal(spanOf('2026-09-14',null,2026).kind,'none');
 assert.equal(spanOf('2026-09-14','not a date',2026).kind,'none');
});

test('every month of the year is present, in spine order, and nothing outside the year is placed',()=>{
 const items=[{d:'2026-09-14'},{d:'2026-09-02'},{d:'2026-01-31'},{d:null},{d:'2025-12-31'}];
 const groups=groupByMonth(items,2026,item=>item.d,false);
 assert.equal(groups.length,12);
 assert.deepEqual(groups.map(group=>group.month.month),[1,2,3,4,5,6,7,8,9,10,11,12]);
 assert.equal(groups[0].items.length,1);
 assert.equal(groups[8].items.length,2);
 assert.equal(groups[11].items.length,0);
 assert.equal(groups.flatMap(group=>group.items).length,3);
 const reversed=groupByMonth(items,2026,item=>item.d,true);
 assert.equal(reversed[0].month.month,12);
 assert.equal(reversed[11].items.length,1);
});

test('the state, empty, date and year labels say what has actually been read',()=>{
 assert.equal(timelineStateLabel(12,true,'dated',2026),'All 12 records in 2026 are loaded.');
 assert.equal(timelineStateLabel(1,true,'dated',2026),'The only record in 2026 is loaded.');
 assert.match(timelineStateLabel(50,false,'dated',2026),/50 records loaded; more available/);
 assert.match(timelineStateLabel(2,true,'undated',2026),/with no date/);
 assert.equal(monthEmptyLabel(false),'None loaded yet');
 assert.equal(monthEmptyLabel(true),'Nothing this month');
 assert.equal(dayMonthLabel('2026-09-14'),'14 Sep');
 assert.equal(dayMonthLabel('2027-01-31',true),'31 Jan 2027');
 assert.match(yearNote(2026),/365 days of 2026/);
 assert.match(yearNote(2024),/366 days of 2024/);
 assert.match(yearNote(2026),/began before 1 Jan 2026 is on that year's spine/);
});
