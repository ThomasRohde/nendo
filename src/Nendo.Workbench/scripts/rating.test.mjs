import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/rating.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {ratingControlMarkup,ratingLabel,ratingMarkup,ratingScaleOf,ratingSteps,ratingValue} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const scale=(min,max)=>({min,max});
const field=(presentation,value)=>({displayName:'Confidence',presentation,scale:value});

test('a scale is read only from a rating field that declares a drawable one',()=>{
 assert.deepEqual(ratingScaleOf(field('rating',scale(1,5))),scale(1,5));
 assert.equal(ratingScaleOf(field('singleLine',scale(1,5))),null,'a scale off a rating is not drawn');
 assert.equal(ratingScaleOf(field('rating',null)),null);
 assert.equal(ratingScaleOf(field('rating',scale(5,5))),null,'a scale with no span cannot be drawn');
 assert.equal(ratingScaleOf(field('rating',scale(5,1))),null);
 assert.equal(ratingScaleOf(undefined),null);
});

test('a value arrives as the exact-number envelope, a plain number or not at all',()=>{
 assert.equal(ratingValue({$nendoNumber:'4'}),4);
 assert.equal(ratingValue(4),4);
 assert.equal(ratingValue('4'),4);
 assert.equal(ratingValue(null),null);
 assert.equal(ratingValue(undefined),null);
 assert.equal(ratingValue(''),null);
 // A decimal is not a rating: it is absent rather than rounded to a dot count.
 assert.equal(ratingValue({$nendoNumber:'4.5'}),null);
 assert.equal(ratingValue(4.5),null);
 assert.equal(ratingValue('four'),null);
});

test('dots count the scale and fill to the value, and the name always carries the number',()=>{
 const drawn=ratingMarkup({$nendoNumber:'3'},scale(1,5));
 assert.equal((drawn.match(/rating-dot/g)??[]).length,5);
 assert.equal((drawn.match(/is-filled/g)??[]).length,3);
 assert.ok(drawn.includes('role="img"'));
 assert.ok(drawn.includes('aria-label="3 of 5"'));
 // A scale that does not start at one says both ends, because "3 of 5" would be a
 // different fact on a scale of two to six.
 assert.equal(ratingLabel(3,scale(1,5)),'3 of 5');
 assert.equal(ratingLabel(3,scale(2,6)),'3 on a scale of 2 to 6');
 assert.ok(ratingMarkup({$nendoNumber:'3'},scale(2,6)).includes('aria-label="3 on a scale of 2 to 6"'));
 assert.deepEqual(ratingSteps(scale(2,6)),[2,3,4,5,6]);
 // The lowest value of the scale still fills one dot, so a scale from zero reads
 // as a value rather than as nothing.
 assert.equal((ratingMarkup({$nendoNumber:'0'},scale(0,3)).match(/is-filled/g)??[]).length,1);
});

test('a value outside the scale is shown as its number with the issue stated',()=>{
 const outside=ratingMarkup({$nendoNumber:'9'},scale(1,5));
 assert.ok(outside.includes('is-outside'));
 assert.ok(outside.includes('>9<'),'the stored number is shown as itself');
 assert.ok(outside.includes('outside 1–5'));
 assert.ok(!outside.includes('is-filled'),'nothing is drawn as a count nobody chose');
 assert.ok(!outside.includes('role="img"'));
});

test('an unset value reads as the caller’s fallback, escaped',()=>{
 assert.equal(ratingMarkup(null,scale(1,5),'Not set'),'Not set');
 assert.equal(ratingMarkup(null,scale(1,5),''),'');
 assert.equal(ratingMarkup(null,scale(1,5),'<b>x</b>'),'&lt;b&gt;x&lt;/b&gt;');
});

test('the control is one radio per value, named for the field, with Not set only when optional',()=>{
 const optional=ratingControlMarkup('field.confidence','Confidence',scale(1,5),{$nendoNumber:'4'},false);
 assert.equal((optional.match(/type="radio"/g)??[]).length,6,'five values and Not set');
 assert.equal((optional.match(/name="field\.confidence"/g)??[]).length,6);
 assert.ok(optional.includes('value="4" checked'));
 assert.ok(optional.includes('Not set'));
 assert.ok(optional.includes('<legend>Confidence</legend>'));

 // The radio is the dot. Drawing one beside it gave every value two marks of the same
 // shape in the same pill, and the chosen value looked chosen twice.
 assert.ok(!optional.includes('rating-dot'),'the radio is the only mark a pill carries');

 const required=ratingControlMarkup('field.confidence','Confidence',scale(1,5),{$nendoNumber:'4'},true);
 assert.equal((required.match(/type="radio"/g)??[]).length,5,'a required field offers no Not set');
 assert.ok(!required.includes('Not set'));

 // An unset optional value checks Not set, so the form reads back null rather than
 // leaving the group ambiguous.
 assert.ok(ratingControlMarkup('f','C',scale(1,5),null,false).includes('value="" checked'));
});

test('a value outside the scale leaves every dot unchosen and says what is stored',()=>{
 const outside=ratingControlMarkup('f','Confidence',scale(1,5),{$nendoNumber:'9'},false);
 assert.ok(!outside.includes('checked'),'nothing is pre-selected, so leaving it alone never rewrites the value');
 assert.ok(outside.includes('Stored as 9, outside 1–5'));
 assert.ok(outside.includes('role="status"'));
});
