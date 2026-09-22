import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/calculated-fields.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {calculatedDisplay,calculationsOf,derivedField,isDerived,resultFor,visibleByCalculation} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const result = (over = {}) => ({ calculationId: 'p.total', fieldId: 'total', state: 'value', resultType: 'Integer', value: 3, ...over });

test('a value reads as itself', () => {
  assert.deepEqual(calculatedDisplay(result()), { state: 'value', text: '3' });
  assert.equal(calculatedDisplay(result({ value: true })).text, 'Yes');
  assert.equal(calculatedDisplay(result({ value: false })).text, 'No');
  assert.equal(calculatedDisplay(result({ value: 'Done' })).text, 'Done');
});

test('an exact number survives the trip rather than passing through a JavaScript number', () => {
  // The envelope stored values use. A calculated decimal is the one most likely to
  // be a total somebody relies on, so it must not be the one that loses digits.
  const exact = { $nendoNumber: '9007199254740993' };
  assert.equal(calculatedDisplay(result({ value: exact })).text, '9007199254740993');
  assert.equal(calculatedDisplay(result({ value: { $nendoNumber: '0.1' } })).text, '0.1');
});

test('empty, pending and error each say so rather than showing a blank', () => {
  // A blank beside stored blanks is how a number nobody computed gets read as one.
  assert.deepEqual(calculatedDisplay(result({ state: 'empty' })), { state: 'empty', text: 'Not set' });
  assert.deepEqual(calculatedDisplay(result({ state: 'pending' })), { state: 'pending', text: 'Calculating…' });
  assert.equal(calculatedDisplay(undefined).state, 'pending');

  const failed = calculatedDisplay(result({ state: 'error', errorCode: 'calculation-divide-by-zero', errorMessage: 'This calculation divides by zero.' }));
  assert.equal(failed.state, 'error');
  assert.equal(failed.text, 'Cannot calculate');
  assert.equal(failed.detail, 'This calculation divides by zero.');
});

test('a dependency failure points at the input rather than at this field', () => {
  const dependent = calculatedDisplay(result({ state: 'error', errorCode: 'calculation-dependency-failed', errorMessage: 'This depends on p.rate, which could not be calculated.' }));
  assert.equal(dependent.text, 'Unavailable');
  assert.equal(dependent.detail, 'This depends on p.rate, which could not be calculated.');
});

test('an enum arriving as an ordinal is read the same way as its name', () => {
  // The bridge may serialise either shape; both must mean the same thing.
  for (const [ordinal, name] of [[0, 'value'], [1, 'empty'], [2, 'error'], [3, 'pending']]) {
    assert.equal(calculatedDisplay(result({ state: ordinal, errorMessage: 'x' })).state, name, String(ordinal));
  }
});

test('an unrecognised state is treated as not yet known, never as a value', () => {
  assert.equal(calculatedDisplay(result({ state: 'something-new' })).state, 'pending');
  assert.equal(calculatedDisplay(result({ state: 99 })).state, 'pending');
});

test('a derived field is recognised so no editor is offered for it', () => {
  const derived = [{ semanticId: 'total', automationTarget: 'nendo-total', displayName: 'Total', resultType: 'Integer', resultNullable: false, calculationId: 'p.total', expression: 'a + b' }];
  assert.equal(isDerived(derived, 'total'), true);
  assert.equal(isDerived(derived, 'name'), false);
  assert.equal(isDerived(undefined, 'total'), false);
  assert.equal(derivedField(derived, 'total')?.expression, 'a + b');
  assert.equal(derivedField(derived, 'name'), undefined);
});

test('a result is found by its field id in either wire shape', () => {
  assert.equal(resultFor({ total: result() }, 'total')?.calculationId, 'p.total');
  assert.equal(resultFor(undefined, 'total'), undefined);
  assert.equal(resultFor({}, 'total'), undefined);
  // A record read back from a bounded query carries a list in dependency order;
  // a related row is read from exactly that shape.
  assert.equal(resultFor([result({ fieldId: 'other' }), result()], 'total')?.calculationId, 'p.total');
  assert.equal(resultFor([], 'total'), undefined);
});

test('a read record keeps its results when the window replaces the compiled plan', () => {
  // The window is what is on screen. Projecting a record without its results is how
  // every calculated field on every surface ends up reading "Calculating…" while the
  // host has had the answer all along.
  const record = { entityId: 'p', recordId: 'p1', recordVersion: 2, values: {}, calculations: [result(), result({ fieldId: 'rate', value: 7 })] };
  const projected = calculationsOf(record);
  assert.equal(projected.total.value, 3);
  assert.equal(projected.rate.value, 7);
  assert.equal(calculationsOf({ entityId: 'p', recordId: 'p1', recordVersion: 1, values: {} }), undefined);
  assert.equal(calculationsOf({ entityId: 'p', recordId: 'p1', recordVersion: 1, values: {}, calculations: [] }), undefined);
});

test('only a definite no hides a node', () => {
  // ADR-0008 P8. Hiding on uncertainty is how a person stops being told something is
  // there: an unfinished or failed calculation must leave the node on screen.
  const yes = { isNamed: result({ fieldId: 'isNamed', value: true }) };
  const no = { isNamed: result({ fieldId: 'isNamed', value: false }) };
  assert.equal(visibleByCalculation(yes, 'isNamed'), true);
  assert.equal(visibleByCalculation(no, 'isNamed'), false);

  assert.equal(visibleByCalculation({ isNamed: result({ fieldId: 'isNamed', state: 'pending' }) }, 'isNamed'), true);
  assert.equal(visibleByCalculation({ isNamed: result({ fieldId: 'isNamed', state: 'empty', value: null }) }, 'isNamed'), true);
  assert.equal(visibleByCalculation({ isNamed: result({ fieldId: 'isNamed', state: 'error', value: null, errorCode: 'calculation-divide-by-zero' }) }, 'isNamed'), true);
  assert.equal(visibleByCalculation({}, 'isNamed'), true, 'a result that has not arrived is not a no');
  assert.equal(visibleByCalculation(undefined, 'isNamed'), true);
});

test('a node that declares no condition is always shown', () => {
  assert.equal(visibleByCalculation(undefined, null), true);
  assert.equal(visibleByCalculation({ isNamed: result({ fieldId: 'isNamed', value: false }) }, null), true);
});
