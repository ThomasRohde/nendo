import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, sample, uniqueKey, slug, pathKeys, agentGuide } from '../../extensions/flow/model.mjs';

const messages = flow => validate(flow).map(p => p.message);
const without = (flow, edgeId) => ({ ...flow, edges: flow.edges.filter(e => e.id !== edgeId) });

test('the sample flow is walkable', () => {
  assert.deepEqual(validate(sample()), []);
});

test('two edges with one outcome from one step are flagged, because the outcome no longer decides', () => {
  const flow = sample();
  flow.edges.find(e => e.id === 'fl_edge_defect_falsify_guard').outcome = 'Caught';
  assert.match(messages(flow).join('\n'), /Two edges leave “Falsify the guard” with the outcome “Caught”/);
});

test('a step with no way out, an unreachable step and a trap are each named', () => {
  let flow = without(sample(), 'fl_edge_defect_record_done');
  assert.ok(messages(flow).some(m => m.includes('“Record a Finding” has no way out')));
  assert.ok(messages(flow).some(m => m.includes('can never finish')));
  flow = without(sample(), 'fl_edge_defect_reported_locate');
  assert.ok(messages(flow).some(m => m.includes('The Start has exactly one edge')));
  assert.ok(messages(flow).some(m => m.includes('“Locate it in the code” cannot be reached')));
});

test('a flow needs exactly one Start and at least one End', () => {
  const flow = sample();
  flow.steps = flow.steps.map(s => s.kind === 'End' ? { ...s, kind: 'Step', instructions: 'x' } : s);
  assert.ok(messages(flow).some(m => m.startsWith('Add an End')));
  flow.steps.push({ id: 'second', key: 'defect.second', kind: 'Start', name: 'Second' });
  assert.ok(messages(flow).some(m => m.includes('this one has 2')));
});

test('keys are readable, unique across the file and never reuse a taken one', () => {
  assert.equal(slug('  Ünïcode & Spaces!  '), 'unicode-spaces');
  assert.equal(uniqueKey('defect', 'Fix it', new Set()), 'defect.fix-it');
  assert.equal(uniqueKey('defect', 'Fix it', new Set(['defect.fix-it', 'DEFECT.FIX-IT-2'])), 'defect.fix-it-3');
});

test('a path reads back as the keys it passed, and the guide names the start edge', () => {
  assert.deepEqual(pathKeys({ path: 'a.b › a.c › a.d' }), ['a.b', 'a.c', 'a.d']);
  assert.deepEqual(pathKeys({ path: null }), []);
  assert.match(agentGuide(sample()), /fl\.run\.choice = fl_edge_defect_reported_locate/);
});
