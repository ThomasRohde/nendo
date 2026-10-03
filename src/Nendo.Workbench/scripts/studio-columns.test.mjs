import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/studio-columns.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {clampWidth,columnWidthsKey,forgetWidths,nextSort,queryStatusText,rememberWidths,rememberedWidths,sortOf,withFilter,withSort} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

// Studio data's columns: widths kept for the device, and a header sort that is a host query.

const memory=(initial={})=>{
 const items=new Map(Object.entries(initial));
 return {items,getItem:(key)=>items.has(key)?items.get(key):null,setItem:(key,value)=>{items.set(key,String(value));}};
};
const filter={fieldId:'category',operator:'eq',value:'Element'};
const filtered={sortFieldId:null,descending:false,fieldId:'category',operator:'eq',text:'Element',filters:[filter]};

test('widths are kept per file and per record type, and only for the columns resized',()=>{
 assert.equal(columnWidthsKey('application-1'),'nendo.studioColumns.application-1');
 const storage=memory();
 rememberWidths(storage,'application-1','concepts',{name:310});
 rememberWidths(storage,'application-1','concepts',{key:180.6});
 rememberWidths(storage,'application-1','folders',{name:120});
 rememberWidths(storage,'application-2','concepts',{name:90});
 assert.deepEqual(rememberedWidths(storage,'application-1','concepts'),{name:310,key:181});
 assert.deepEqual(rememberedWidths(storage,'application-1','folders'),{name:120});
 assert.deepEqual(rememberedWidths(storage,'application-2','concepts'),{name:90});
 forgetWidths(storage,'application-1','concepts');
 assert.deepEqual(rememberedWidths(storage,'application-1','concepts'),{});
 assert.deepEqual(rememberedWidths(storage,'application-1','folders'),{name:120});
});

test('a width is held to a usable range, and unreadable storage leaves the defaults',()=>{
 assert.equal(clampWidth(3),48);
 assert.equal(clampWidth(99999),2000);
 assert.deepEqual(rememberedWidths(memory({'nendo.studioColumns.a':'not json'}),'a','t'),{});
 assert.deepEqual(rememberedWidths(memory({'nendo.studioColumns.a':'{"t":{"x":"wide","y":200,"z":null}}'}),'a','t'),{y:200});
 const refusing={getItem(){throw new Error('SecurityError');},setItem(){throw new Error('QuotaExceededError');}};
 assert.deepEqual(rememberedWidths(refusing,'a','t'),{});
 // A write that fails still answers with the width, so the session keeps it.
 assert.deepEqual(rememberWidths(refusing,'a','t',{name:200}),{name:200});
});

test('a header click sorts ascending, then descending, then back to record order',()=>{
 let query;
 assert.equal(sortOf(query,'name'),null);
 query=withSort(query,nextSort(query,'name'));
 assert.equal(sortOf(query,'name'),'asc');
 assert.equal(sortOf(query,'key'),null);
 query=withSort(query,nextSort(query,'name'));
 assert.equal(sortOf(query,'name'),'desc');
 // With no filter, record order is no query at all: plain browsing again.
 assert.equal(withSort(query,nextSort(query,'name')),null);
 // Another column starts again at ascending.
 assert.deepEqual(nextSort({...filtered,sortFieldId:'name',descending:true},'key'),{sortFieldId:'key',descending:false});
});

test('sorting keeps the filter, and filtering keeps the sort',()=>{
 const sorted=withSort(filtered,{sortFieldId:'name',descending:true});
 assert.deepEqual(sorted.filters,[filter]);
 assert.equal(sorted.text,'Element');
 const unsorted=withSort(sorted,{sortFieldId:null,descending:true});
 assert.deepEqual(unsorted,{...filtered,descending:false});
 const refiltered=withFilter(sorted,{fieldId:'',operator:'contains',text:'',filters:[]});
 assert.equal(refiltered.sortFieldId,'name');
 assert.equal(refiltered.descending,true);
 assert.deepEqual(refiltered.filters,[]);
 assert.equal(withFilter(undefined,{fieldId:'',operator:'contains',text:'',filters:[]}),null);
});

test('the status says what the table shows, in the field names',()=>{
 const names={name:'Name',category:'Category'};
 const nameOf=(id)=>names[id]??id;
 assert.equal(queryStatusText(undefined,nameOf),'');
 assert.equal(queryStatusText(withSort(undefined,{sortFieldId:'name',descending:false}),nameOf),'Sorted by Name, ascending · across every record of this type');
 assert.equal(queryStatusText(withSort(filtered,{sortFieldId:'name',descending:true}),nameOf),
  'Sorted by Name, descending · Only where Category is Element · across every record of this type');
 assert.equal(queryStatusText({...filtered,filters:[{fieldId:'category',operator:'isNull'}]},nameOf),'Only where Category is not set · across every record of this type');
});
