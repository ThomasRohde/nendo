import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/chart-kit.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {proportionBar,proportionOf,ring} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const segments=[
 {key:'open',label:'Open',lexeme:'3',amount:3,style:'--status-color: var(--tone-teal)'},
 {key:'done',label:'Done <b>',lexeme:'1',amount:1,style:'--status-color: var(--tone-green)'},
 {key:null,label:'Not set',lexeme:'0',amount:0,style:''},
];
const bar=(overrides={})=>proportionBar({key:'k',title:'By stage',context:'records per group, all matching records',status:{state:'ready'},segments,unrecognised:0,tableOpen:false,drillable:true,...overrides});

test('a proportion bar shows every number beside the shape and names each segment',()=>{
 const markup=bar();
 assert.ok(markup.includes('<strong>3</strong>') && markup.includes('<strong>1</strong>') && markup.includes('<strong>0</strong>'));
 assert.ok(markup.includes('aria-label="Open: 3"'));
 assert.ok(markup.includes('flex-basis: 75.000%') && markup.includes('flex-basis: 25.000%'));
 // A zero group is in the legend but not drawn as a segment.
 assert.equal((markup.match(/class="chart-segment"/g)??[]).length,2);
 // Labels are escaped, and the tone token travels with the segment.
 assert.ok(markup.includes('Done &lt;b&gt;') && !markup.includes('Done <b>'));
 assert.ok(markup.includes('var(--tone-teal)'));
 assert.ok(markup.includes('data-chart-drill="k"') && markup.includes('data-chart-group="open"'));
 assert.ok(markup.includes('data-chart-table="k"') && markup.includes('aria-pressed="false"'));
});

test('a bar that cannot drill has disabled segments, and the table shows the same numbers',()=>{
 const still=bar({drillable:false});
 assert.ok(still.includes('class="chart-segment"') && still.includes(' disabled'));
 assert.ok(!still.includes('data-chart-drill'));
 const open=bar({tableOpen:true});
 assert.ok(open.includes('<table class="chart-table">') && open.includes('<td>3</td>') && open.includes('aria-pressed="true"'));
});

test('a zero total is an empty track, an unrecognised value is stated, and an absent number says why',()=>{
 const empty=bar({segments:segments.map(s=>({...s,lexeme:'0',amount:0}))});
 assert.ok(empty.includes('No records') && !empty.includes('class="chart-segment"'));
 const issue=bar({unrecognised:2});
 assert.ok(issue.includes('2 records have a value outside'));
 const loading=bar({status:{state:'loading'}});
 assert.ok(loading.includes('aria-busy="true"') && !loading.includes('chart-legend'));
 const failed=bar({status:{state:'failed',message:'The total is past what this host holds exactly.',retry:false}});
 assert.ok(failed.includes('Unavailable') && failed.includes('past what this host') && !failed.includes('data-chart-retry'));
 const retryable=bar({status:{state:'failed',message:'The read timed out.',retry:true}});
 assert.ok(retryable.includes('data-chart-retry="k"'));
});

test('a ring is drawn only from two answered numbers',()=>{
 const drawn=ring({key:'r',title:'Done',context:'matching its condition, over all matching records',status:{state:'ready'},numerator:'12',denominator:'40',tableOpen:false,drillable:true});
 assert.ok(drawn.includes('<strong>12</strong>') && drawn.includes('of 40'));
 assert.ok(drawn.includes('aria-label="Done: 12 of 40"'));
 const circumference=2*Math.PI*26;
 assert.ok(drawn.includes(`stroke-dashoffset="${(circumference*0.7).toFixed(3)}"`));
 assert.ok(drawn.includes('data-chart-ring="true"'));
 const half=ring({key:'r',title:'Done',context:'',status:{state:'ready'},numerator:'12',denominator:null,tableOpen:false,drillable:false});
 assert.ok(half.includes('aria-busy="true"') && !half.includes('<strong>12</strong>'));
 const over=ring({key:'r',title:'Done',context:'',status:{state:'ready'},numerator:'50',denominator:'40',tableOpen:true,drillable:false});
 assert.ok(over.includes('stroke-dashoffset="0.000"'),'a ratio past one fills the ring and shows both numbers as they are');
 assert.ok(over.includes('<td>50</td>') && over.includes('<td>40</td>'));
});

test('a proportion is a non-negative finite magnitude and nothing else',()=>{
 assert.equal(proportionOf('3'),3);
 assert.equal(proportionOf('10.75'),10.75);
 assert.equal(proportionOf('-4'),0);
 assert.equal(proportionOf(null),0);
 assert.equal(proportionOf('not a number'),0);
});
