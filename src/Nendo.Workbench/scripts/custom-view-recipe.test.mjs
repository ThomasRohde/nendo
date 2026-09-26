import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// Studio's Add view form (W-062): what it may offer and the proposal it makes. The host
// validates every change set, so these are not the last line; they hold the form to the
// Engine's NUI450 rules (NendoSemanticCompiler.Extensions.cs), so a person is offered only
// choices that compile. The journey through a real host is G17 in tools/Review-ExtensionViews.mjs.
const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/custom-view-recipe.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { addViewProposal, edgeChoices, pageChoices, refusalFor, showableFields, viewEntities, viewsOfPackage } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

const field = (fieldId, storageKind, extra = {}) => ({ fieldId, displayName: fieldId, storageKind, required: false, presentation: null, options: [], ...extra });
const entities = [
  { entityId: 'task', displayName: 'Task', fields: [
    field('title', 'text'), field('status', 'text', { presentation: 'singleChoice' }), field('starts', 'date'),
    field('old', 'text', { retired: true }), field('blob', 'unsupported', { unsupportedStorageKind: 'blob' }),
    field('owner', 'reference', { reference: { targetEntityId: 'person', labelFieldId: 'name' } }),
  ], derivedFields: [{ fieldId: 'age', displayName: 'Age', calculationId: 'c', resultType: 'integer', resultNullable: true, expression: '1' }] },
  { entityId: 'link', displayName: 'Link', fields: [
    field('from', 'reference', { reference: { targetEntityId: 'task', labelFieldId: 'title' } }),
    field('to', 'reference', { reference: { targetEntityId: 'task', labelFieldId: 'title' } }),
    field('gone', 'reference', { retired: true, reference: { targetEntityId: 'task', labelFieldId: 'title' } }),
  ] },
  { entityId: 'half', displayName: 'Half link', fields: [
    field('one', 'reference', { reference: { targetEntityId: 'task', labelFieldId: 'title' } }),
    field('elsewhere', 'reference', { reference: { targetEntityId: 'person', labelFieldId: 'name' } }),
  ] },
  { entityId: 'person', displayName: 'Person', fields: [field('name', 'text')] },
  { entityId: 'archived', displayName: 'Archived', retired: true, fields: [field('name', 'text')] },
];
const node = (surfaceId, nodeId, parentNodeId, kind, properties = {}, position = 0) => ({ surfaceId, nodeId, parentNodeId, kind, position, properties });
const nodes = [
  node('form', 'form', null, 'recordForm', { entityId: 'task', title: 'Task form' }),
  node('form', 'form-title', 'form', 'fieldBinding', { fieldId: 'title' }, 0),
  node('form', 'form-status', 'form', 'fieldBinding', { fieldId: 'status' }, 1),
  node('page', 'page', null, 'detailSurface', { entityId: 'task' }),
  node('gone', 'gone', null, 'recordForm', { entityId: 'archived', title: 'Old form' }),
  node('graph', 'graph', null, 'extensionGraphSurface', { entityId: 'task', title: 'Plan', packageId: 'org.example.graph' }),
  node('form', 'panel', 'form', 'extensionRecordPanel', { title: 'Glance', packageId: 'org.example.glance' }, 2),
];
const context = { entities, nodes, id: 'abc' };
const ids = choices => choices.map(choice => choice.fieldId);

test('a view is offered live record types and only fields it can show', () => {
  assert.deepEqual(viewEntities(entities).map(entity => entity.entityId), ['task', 'link', 'half', 'person']);
  // Retired and unsupported stored fields are out; a calculated field is in.
  assert.deepEqual(ids(showableFields(entities[0])), ['title', 'status', 'starts', 'owner', 'age']);
});

test('a graph is offered only a link record type with two live references to the node type', () => {
  const choices = edgeChoices(entities, 'task');
  assert.deepEqual(choices.map(choice => choice.entity.entityId), ['link']);
  assert.deepEqual(ids(choices[0].references), ['from', 'to'], 'a retired reference is not an end');
  assert.deepEqual(edgeChoices(entities, 'person'), [], 'one reference is not a link');
});

test('a panel is offered the record pages of live record types', () => {
  assert.deepEqual(pageChoices(nodes, entities).map(page => [page.nodeId, page.title, page.entityId]),
    [['form', 'Task form', 'task'], ['page', 'Record page', 'task']]);
});

test('every refusal the Engine would make is made first, in words', () => {
  const base = { kind: 'records', packageId: 'org.example.glance', title: 'Board', entityId: 'task', labelFieldId: 'title' };
  assert.equal(refusalFor(base, context), null);
  assert.match(refusalFor({ ...base, title: '  ' }, context), /title/);
  assert.match(refusalFor({ ...base, packageId: 'Not A Package' }, context), /package/);
  assert.match(refusalFor({ ...base, entityId: 'archived', labelFieldId: 'name' }, context), /record type/);
  assert.match(refusalFor({ ...base, labelFieldId: 'old' }, context), /label/);
  assert.match(refusalFor({ ...base, labelFieldId: 'blob' }, context), /label/);
  assert.match(refusalFor({ ...base, statusFieldId: 'old' }, context), /status/);
  const graph = { ...base, kind: 'graph', edgeEntityId: 'link', sourceFieldId: 'from', targetFieldId: 'to' };
  assert.equal(refusalFor(graph, context), null);
  assert.match(refusalFor({ ...graph, edgeEntityId: 'half', sourceFieldId: 'one', targetFieldId: 'elsewhere' }, context), /links Task/);
  assert.match(refusalFor({ ...graph, targetFieldId: 'gone' }, context), /two fields/);
  assert.match(refusalFor({ ...graph, targetFieldId: 'from' }, context), /different/);
  const panel = { ...base, kind: 'panel', pageNodeId: 'form' };
  assert.equal(refusalFor(panel, context), null);
  assert.match(refusalFor({ ...panel, pageNodeId: 'gone' }, context), /record page/);
  assert.match(refusalFor({ ...panel, entityId: 'person', labelFieldId: 'name' }, context), /page’s own/);
  assert.throws(() => addViewProposal({ ...base, labelFieldId: 'old' }, context), /label/);
});

const operations = proposal => proposal.mutations[0].operations.map(operation => [operation.operationType, operation.payload]);

test('a screen is a root node and its properties, in the order an agent’s inline node expands to', () => {
  const proposal = addViewProposal({ kind: 'records', packageId: 'org.example.glance', title: ' Board ', entityId: 'task', labelFieldId: 'title', statusFieldId: 'status' }, context);
  assert.equal(proposal.proposalId, 'proposal-abc');
  assert.equal(proposal.title, 'Add view Board');
  assert.deepEqual(operations(proposal), [
    ['ui.addNode', { surfaceId: 'surface.view.abc', nodeId: 'node.view.abc', parentNodeId: null, kind: 'extensionRecordsSurface', position: 0 }],
    ...[['configuration', '{}'], ['definitionVersion', 3], ['entityId', 'task'], ['labelFieldId', 'title'], ['packageId', 'org.example.glance'],
      ['statusFieldId', 'status'], ['title', 'Board']]
      .map(([propertyName, value]) => ['ui.setProperty', { surfaceId: 'surface.view.abc', nodeId: 'node.view.abc', propertyName, value }]),
  ]);
  const unique = new Set(proposal.mutations[0].operations.map(operation => operation.operationId));
  assert.equal(unique.size, proposal.mutations[0].operations.length);
});

test('a graph carries its link, and a panel goes after what its page has and names no record type', () => {
  const graph = addViewProposal({ kind: 'graph', packageId: 'org.example.graph', title: 'Plan', entityId: 'task', labelFieldId: 'title',
    edgeEntityId: 'link', sourceFieldId: 'from', targetFieldId: 'to' }, context);
  const set = Object.fromEntries(operations(graph).slice(1).map(([, payload]) => [payload.propertyName, payload.value]));
  assert.equal(operations(graph)[0][1].kind, 'extensionGraphSurface');
  assert.deepEqual([set.edgeEntityId, set.sourceFieldId, set.targetFieldId], ['link', 'from', 'to']);
  const panel = addViewProposal({ kind: 'panel', packageId: 'org.example.glance', title: 'Glance 2', entityId: 'task', labelFieldId: 'title', pageNodeId: 'form' }, context);
  const [add, ...properties] = operations(panel);
  assert.deepEqual(add, ['ui.addNode', { surfaceId: 'form', nodeId: 'node.view.abc', parentNodeId: 'form', kind: 'extensionRecordPanel', position: 3 }]);
  const names = properties.map(([, payload]) => payload.propertyName);
  assert.ok(!names.includes('entityId') && !names.includes('definitionVersion'), 'a panel takes the page’s record type: ' + names);
});

test('a package names every view that shows it, and where a person finds each one', () => {
  assert.deepEqual(viewsOfPackage('org.example.graph', nodes).map(use => [use.kind, use.title, use.entityId, use.pageTitle]), [['graph', 'Plan', 'task', null]]);
  assert.deepEqual(viewsOfPackage('org.example.glance', nodes).map(use => [use.kind, use.title, use.entityId, use.pageTitle]), [['panel', 'Glance', 'task', 'Task form']]);
  assert.deepEqual(viewsOfPackage('org.example.none', nodes), []);
});
