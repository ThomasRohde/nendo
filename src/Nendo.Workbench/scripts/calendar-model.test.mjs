import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/calendar-model.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {calendarQuery,calendarWindowKey,civilDate,daysInMonth,groupByDate,isLeapYear,loadedStateLabel,mondayFirstWeekday,monthGrid,monthLabel,monthOf,monthQuery,monthStart,nextMonthStart,sameMonth,shiftMonth,undatedItems,undatedQuery,weekdayNames} =
 await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const node=(semanticId,kind,properties,children=[])=>({semanticId,automationTarget:semanticId,kind,properties,children});
const clause=(fieldId,operator,value)=>node(`f.${fieldId}.${operator}`,'filterClause',
 value===undefined?{fieldId,operator}:{fieldId,operator,value});
const calendar=node('cal.due','calendarSurface',{dateFieldId:'due',title:'Due dates'},[
 node('b.name','fieldBinding',{fieldId:'name'}),
 clause('archived','eq',false),
]);

test('a month rolls over December and arithmetic stays in civil terms',()=>{
 assert.equal(monthStart({year:2026,month:9}),'2026-09-01');
 assert.equal(nextMonthStart({year:2026,month:12}),'2027-01-01');
 assert.deepEqual(shiftMonth({year:2026,month:12},1),{year:2027,month:1});
 assert.deepEqual(shiftMonth({year:2026,month:1},-1),{year:2025,month:12});
 assert.deepEqual(shiftMonth({year:2026,month:9},-13),{year:2025,month:8});
 assert.equal(monthLabel({year:2026,month:2}),'February 2026');
 assert.equal(sameMonth({year:2026,month:2},{year:2026,month:2}),true);
 assert.equal(sameMonth({year:2026,month:2},{year:2027,month:2}),false);
});

test('leap years follow the century rule',()=>{
 assert.equal(isLeapYear(2024),true);
 assert.equal(isLeapYear(1900),false);
 assert.equal(isLeapYear(2000),true);
 assert.equal(daysInMonth({year:2024,month:2}),29);
 assert.equal(daysInMonth({year:2026,month:2}),28);
 assert.equal(daysInMonth({year:2026,month:4}),30);
 assert.equal(daysInMonth({year:2026,month:12}),31);
 // The leap day is a real cell, and only in a leap year.
 assert.equal(monthGrid({year:2024,month:2}).some(cell=>cell.date==='2024-02-29'),true);
 assert.equal(monthGrid({year:2026,month:2}).some(cell=>cell.date==='2026-02-29'),false);
});

test('the grid is Monday first, whole weeks, and pads with dateless cells',()=>{
 assert.deepEqual(weekdayNames,['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);
 // 1 September 2026 is a Tuesday, so one leading pad cell.
 assert.equal(mondayFirstWeekday(2026,9,1),1);
 const grid=monthGrid({year:2026,month:9});
 assert.equal(grid.length%7,0);
 assert.equal(grid[0].date,null);
 assert.equal(grid[1].date,'2026-09-01');
 assert.equal(grid.filter(cell=>cell.date!==null).length,30);
 // A padding cell belongs to no date, so nothing can be placed in one.
 assert.equal(grid.filter(cell=>cell.date===null).every(cell=>cell.day===null),true);
 // 1 February 2026 is a Sunday: six leading pads, and the month still fits whole weeks.
 assert.equal(mondayFirstWeekday(2026,2,1),6);
 assert.equal(monthGrid({year:2026,month:2}).length%7,0);
});

// `new Date('2026-03-01')` is UTC midnight, read back local: west of Greenwich
// that is 28 February. A stored Date is civil text and is grouped as text.
test('a civil date is read as text and never through a time zone',()=>{
 assert.equal(civilDate('2026-03-01'),'2026-03-01');
 assert.equal(civilDate('2026-03-01T23:30:00+13:00'),'2026-03-01');
 assert.equal(civilDate(null),null);
 assert.equal(civilDate(''),null);
 assert.equal(civilDate(20260301),null);
 assert.deepEqual(monthOf('2026-03-01'),{year:2026,month:3});
 assert.equal(monthOf('not a date'),null);
});

test('a month query adds two date bounds to the declared clauses and defaults to date order',()=>{
 const query=monthQuery(calendar,{year:2026,month:9});
 assert.deepEqual(query.filters,[
  {fieldId:'archived',operator:'eq',value:false},
  {fieldId:'due',operator:'ge',value:'2026-09-01'},
  {fieldId:'due',operator:'lt',value:'2026-10-01'},
 ]);
 assert.equal(query.sortFieldId,'due');
 // A declared order wins, and then orders entries within each day.
 const ordered=monthQuery({...calendar,properties:{...calendar.properties,orderByFieldId:'name',orderDirection:'descending'}},{year:2026,month:9});
 assert.equal(ordered.sortFieldId,'name');
 assert.equal(ordered.descending,true);
});

test('the undated view asks for a missing date, with the same root filters',()=>{
 const query=undatedQuery(calendar);
 assert.deepEqual(query.filters,[
  {fieldId:'archived',operator:'eq',value:false},
  {fieldId:'due',operator:'isNull'},
 ]);
 assert.deepEqual(calendarQuery(calendar,'undated',{year:2026,month:9}),query);
 assert.deepEqual(calendarQuery(calendar,'dated',{year:2026,month:9}),monthQuery(calendar,{year:2026,month:9}));
});

// A generic pager keyed by surface alone would mix March into April, or show the
// undated records inside the grid.
test('a calendar window is identified by its month and its mode',()=>{
 const keys=new Set([
  calendarWindowKey('cal.due','dated',{year:2026,month:3}),
  calendarWindowKey('cal.due','dated',{year:2026,month:4}),
  calendarWindowKey('cal.due','undated',{year:2026,month:3}),
  calendarWindowKey('cal.other','dated',{year:2026,month:3}),
 ]);
 assert.equal(keys.size,4);
 // The undated view is one window whatever month is showing behind it.
 assert.equal(calendarWindowKey('cal.due','undated',{year:2026,month:3}),
  calendarWindowKey('cal.due','undated',{year:2027,month:11}));
});

test('entries group by their own date, and a dateless record is never placed',()=>{
 const records=[
  {recordId:'a',values:{due:'2026-09-01'}},
  {recordId:'b',values:{due:'2026-09-01'}},
  {recordId:'c',values:{due:'2026-09-30'}},
  {recordId:'d',values:{due:null}},
  {recordId:'e',values:{}},
 ];
 const byDate=groupByDate(records,record=>record.values.due);
 assert.deepEqual(byDate.get('2026-09-01').map(r=>r.recordId),['a','b']);
 assert.deepEqual(byDate.get('2026-09-30').map(r=>r.recordId),['c']);
 assert.equal(byDate.has('2026-09-15'),false);
 // The records with no date are not lost; they are the undated view.
 assert.deepEqual(undatedItems(records,record=>record.values.due).map(r=>r.recordId),['d','e']);
});

// The first page is not the month. A day with no loaded entry is not an empty
// day while the cursor is still open.
test('the state line distinguishes a partial month from a complete one',()=>{
 assert.match(loadedStateLabel(50,false,'dated'),/50 records loaded; more available/);
 assert.match(loadedStateLabel(50,false,'dated'),/not loaded yet/);
 assert.match(loadedStateLabel(63,true,'dated'),/All 63 records in this month are loaded/);
 assert.match(loadedStateLabel(1,true,'dated'),/The only record in this month is loaded/);
 assert.match(loadedStateLabel(4,true,'undated'),/All 4 records with no date are loaded/);
});
