import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0026: Studio's Structure names a link rule on the link type and on its table, in the
// fields' own names, and says nothing on a record type the rule does not touch.
const { linkRuleNote } = await bundleOf('src/link-rule-markup.ts');

const field = (fieldId, displayName, targetEntityId = null) =>
  ({ fieldId, displayName, storageKind: targetEntityId ? 'Reference' : 'Text', required: false, presentation: null, options: [],
    reference: targetEntityId ? { targetEntityId, labelFieldId: 'x' } : null });
const types = { entityId: 'ar.type', displayName: 'Concept types', fields: [field('ar.type.name', 'Name')] };
const concepts = {
  entityId: 'ar.concept', displayName: 'Concepts',
  fields: [field('ar.concept.type', 'Type', 'ar.type'), field('ar.concept.source', 'Source', 'ar.concept'), field('ar.concept.target', 'Target', 'ar.concept')],
  linkRule: {
    sourceFieldId: 'ar.concept.source', targetFieldId: 'ar.concept.target', kindFieldId: 'ar.concept.type',
    sourceKindFieldId: 'ar.concept.type', targetKindFieldId: 'ar.concept.type', tableEntityId: 'ar.rule',
    tableSourceFieldId: 'ar.rule.source', tableTargetFieldId: 'ar.rule.target', tableKindFieldId: 'ar.rule.type',
  },
};
const rules = { entityId: 'ar.rule', displayName: 'Allowed relationships', fields: [field('ar.rule.source', 'Source type', 'ar.type')] };
const entities = [types, concepts, rules];

test('the link type says which links it keeps, in its fields’ names', () => {
  assert.equal(linkRuleNote(concepts, entities),
    '<p class="link-rule-note" data-link-rule="link"><strong>Allowed links</strong> A record from Source to Target is kept only when ' +
    'Allowed relationships holds the source’s Type, the target’s Type and its Type, whoever writes it.</p>');
});

test('the table says whose links it allows', () => {
  assert.match(linkRuleNote(rules, entities), /data-link-rule="table"><strong>Allowed links<\/strong> Each record allows one kind of Concepts link\./);
});

test('a record type the rule does not touch says nothing', () => {
  assert.equal(linkRuleNote(types, entities), '');
});
