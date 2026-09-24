import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/fold-state.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {foldSection,foldStorageKey,rememberFold,rememberedFolds,sectionIsOpen} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

// A fold the person makes is kept for the device (W-053). The storage helpers take the
// storage and the application ID as arguments, so they are driven here with a fake; what
// sectionIsOpen does with the open file's ID reads the shared state, which this bundle
// owns a private copy of, so that branch is the gate's reopen phase.

const memory=(initial={})=>{
 const items=new Map(Object.entries(initial));
 return {items,getItem:(key)=>items.has(key)?items.get(key):null,setItem:(key,value)=>{items.set(key,String(value));}};
};
const section=(semanticId,opens)=>({semanticId,automationTarget:semanticId,kind:'section',properties:opens?{opens}:{},children:[]});

test('folds are kept per file, by application ID, under one key',()=>{
 assert.equal(foldStorageKey('application-1'),'nendo.sectionFolds.application-1');
 const storage=memory();
 rememberFold(storage,'application-1','front-lately','open');
 rememberFold(storage,'application-1','remit-more','closed');
 rememberFold(storage,'application-2','front-lately','closed');
 assert.deepEqual(rememberedFolds(storage,'application-1'),{'front-lately':'open','remit-more':'closed'});
 assert.deepEqual(rememberedFolds(storage,'application-2'),{'front-lately':'closed'});
 // The last choice for a section wins; nothing else in the set moves.
 rememberFold(storage,'application-1','front-lately','closed');
 assert.deepEqual(rememberedFolds(storage,'application-1'),{'front-lately':'closed','remit-more':'closed'});
});

test('storage that refuses, or holds something else, leaves the author in charge',()=>{
 assert.deepEqual(rememberedFolds(memory(),'a'),{});
 assert.deepEqual(rememberedFolds(memory({'nendo.sectionFolds.a':'not json'}),'a'),{});
 assert.deepEqual(rememberedFolds(memory({'nendo.sectionFolds.a':'["open"]'}),'a'),{});
 assert.deepEqual(rememberedFolds(memory({'nendo.sectionFolds.a':'{"s":"sideways","t":"open"}'}),'a'),{t:'open'});
 const refusing={getItem(){throw new Error('SecurityError');},setItem(){throw new Error('QuotaExceededError');}};
 assert.deepEqual(rememberedFolds(refusing,'a'),{});
 // A write that fails still answers with the fold, so the session keeps it.
 assert.deepEqual(rememberFold(refusing,'a','s','open'),{s:'open'});
});

test('with nothing remembered the author decides, and a fold this session overrides it',()=>{
 // No window and no open file here: exactly the case where storage is unavailable.
 assert.equal(sectionIsOpen(section('never-touched')),true);
 assert.equal(sectionIsOpen(section('starts-closed','closed')),false);
 foldSection('starts-closed',true);
 assert.equal(sectionIsOpen(section('starts-closed','closed')),true);
 foldSection('never-touched',false,false);
 assert.equal(sectionIsOpen(section('never-touched')),false);
});
