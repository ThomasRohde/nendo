import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeMutations } from './upgrade.mjs';
import { migrated, demonstration, BASELINE_REVIEW } from './assessments.mjs';
import { northstarModel } from './northstar.mjs';
import { mapView } from './definition.mjs';
import { bindAtlas } from '../../extensions/bcm-atlas/model.js';
import { bcmFixture, otherFixture } from './fixtures.mjs';

// W-080: the upgrade of an existing BCM.nendo, and the move of today's values into assessments.

test('the upgrade is one proposal the host takes: at most 16 operations a mutation, required fields with their record type', () => {
  const mutations = upgradeMutations();
  assert.ok(mutations.every(mutation => mutation.operations.length <= 16), JSON.stringify(mutations.map(m => m.operations.length)));
  const [define] = mutations;
  assert.equal(define.operations[0].operationType, 'schema.createEntity');
  assert.ok(define.operations.filter(o => o.payload.required).every(o => o.payload.entityId === 'bcm.assessment'),
    'a required field outside the mutation that creates its record type is refused by the host');
  const all = mutations.flatMap(mutation => mutation.operations);
  const find = (type, test) => all.find(o => o.operationType === type && test(o.payload));
  assert.ok(find('schema.setFieldUnique', p => p.fieldId === 'cap.code' && p.unique === true), 'the capability code is not made unique (W-075)');
  for (const end of ['support.capability', 'support.application'])
    assert.ok(find('schema.setFieldRequired', p => p.fieldId === end && p.required === true), `${end} is not made required (W-076)`);
  assert.ok(find('schema.configureReference', p => p.fieldId === 'assess.capability' && p.targetEntityId === 'bcm.capability'));
  assert.ok(find('ui.addNode', p => p.kind === 'relatedList' && p.parentNodeId === 'bcm.capability.detail' && p.properties.viaFieldId === 'assess.capability'),
    'a capability page does not list its assessment history');
  assert.equal(find('ui.setProperty', p => p.nodeId === 'bcm.map').payload.value, JSON.stringify(mapView.configuration));
});

test('today’s values move without loss: each current maturity is one assessment, and nothing else is invented as real', () => {
  const capabilities = northstarModel()['bcm.capability'];
  const moved = migrated(capabilities);
  const assessed = capabilities.filter(c => c.values['cap.maturity'] != null);
  assert.equal(moved.length, assessed.length);
  for (const capability of assessed) {
    const [one] = moved.filter(a => a.values['assess.capability'] === capability.recordId);
    assert.deepEqual([one.values['assess.dimension'], one.values['assess.score'], one.values['assess.date'], one.values['assess.evidence'], one.values['assess.assessor']],
      ['Maturity', capability.values['cap.maturity'], capability.values['cap.reviewed'] ?? BASELINE_REVIEW, capability.values['cap.evidence'] ?? null, capability.values['cap.owner'] ?? null]);
  }
  // The migration writes assessments only: target and maturity stay on the capability.
  assert.ok(moved.every(a => Object.keys(a.values).every(key => key.startsWith('assess.'))));
  // Fictional history says so, every time.
  assert.ok(demonstration(capabilities).every(a => a.values['assess.assessor'] === 'Northstar demo' && /Fictional/.test(a.values['assess.evidence'])));
  // Record IDs are stable, so an import retried under the same key asks for the same records.
  assert.deepEqual(migrated(capabilities).map(a => a.recordId), moved.map(a => a.recordId));
});

test('the map binds its assessments, and the latest maturity stands for the stored one', () => {
  const { context, schema, records } = bcmFixture();
  const bound = bindAtlas(context, schema);
  assert.deepEqual(bound.problems, []);
  assert.ok(bound.has('assessments') && bound.has('health') && !bound.has('maturity-stored'));
  bound.useAssessments(records['bcm.assessment']);
  const capability = records['bcm.capability'].find(c => c.recordId === 'bcm-cap-3-3');
  const history = records['bcm.assessment'].filter(a => a.values['assess.capability'] === capability.recordId && a.values['assess.dimension'] === 'Maturity')
    .sort((a, b) => a.values['assess.date'].localeCompare(b.values['assess.date']));
  assert.equal(bound.value(capability, 'maturity'), history.at(-1).values['assess.score']);
  assert.equal(bound.change(capability, history[0].values['assess.date']), history.at(-1).values['assess.score'] - history[0].values['assess.score']);
  assert.equal(bound.change(capability, '2000-01-01'), null, 'a change is only stated between two judgements actually made');
  // A file with no assessments keeps its stored maturity, and offers neither mode.
  const other = bindAtlas(otherFixture().context, otherFixture().schema);
  assert.ok(!other.has('assessments') && !other.has('health') && other.has('maturity-stored'));
});

test('an assessment type that does not fit says what it needs', () => {
  const { context, schema } = bcmFixture();
  const configuration = { ...context.configuration, assessments: { ...context.configuration.assessments, score: 'assess.assessor' } };
  const bound = bindAtlas({ ...context, configuration }, schema);
  assert.equal(bound.assessments, null);
  assert.ok(bound.problems.some(problem => problem === 'Assessments in Assessment need score, a whole-number field.'), JSON.stringify(bound.problems));
});

test('the committed upgrade-operations.json is the upgrade, so the LocalMcp lane proposes what this file builds', async () => {
  const { readFileSync } = await import('node:fs');
  const committed = JSON.parse(readFileSync(new URL('./upgrade-operations.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, upgradeMutations(), 'upgrade-operations.json is stale: run node tools/bcm-atlas/upgrade.mjs');
});
