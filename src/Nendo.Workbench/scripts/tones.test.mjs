import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/tones.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {CHOICE_TONES,choiceStyle,derivedHue,isChoiceTone,toneLabel,toneOf} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const field={choices:[
 {id:'open',displayName:'Open',retired:false,tone:'teal'},
 {id:'won',displayName:'Won',retired:false},
 {id:'odd',displayName:'Odd',retired:false,tone:'#ff0000'},
]};

test('the eight tones are the closed set the host publishes, and nothing else is one',()=>{
 assert.deepEqual([...CHOICE_TONES],['red','orange','amber','green','teal','blue','violet','grey']);
 assert.equal(isChoiceTone('teal'),true);
 assert.equal(isChoiceTone('Teal'),false);
 assert.equal(isChoiceTone('#2458e6'),false);
 assert.equal(isChoiceTone(null),false);
});

test('a toned option paints with its theme token and an untoned one keeps its derived hue',()=>{
 assert.equal(toneOf(field,'open'),'teal');
 assert.equal(toneOf(field,'won'),null);
 // A stored value outside the set is not a colour; the option falls back like an untoned one.
 assert.equal(toneOf(field,'odd'),null);
 assert.equal(choiceStyle(field,'open'),'--status-color: var(--tone-teal)');
 assert.equal(choiceStyle(field,'won'),`--status-color: hsl(${derivedHue('won')} 58% 49%)`);
 // The derived hue depends only on the value, so a list and a board agree without a field.
 assert.equal(choiceStyle(field,'won'),choiceStyle(undefined,'won'));
 assert.equal(derivedHue('won'),derivedHue('won'));
});

test('an unset value paints nothing, so the muted default shows',()=>{
 assert.equal(choiceStyle(field,null),'');
 assert.equal(choiceStyle(field,undefined),'');
 assert.equal(choiceStyle(field,''),'');
 assert.equal(toneLabel(null),'No colour');
 assert.equal(toneLabel('amber'),'Amber');
});
