import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// Studio as the person sees it. Each test renders
// through the function the page draws with; where the page's wiring is the defect, the view's
// own source is read for the call. tools/Gate-WorkbenchShell.mjs measures the rest on screen.
const proposal = await bundleOf('src/proposal-markup.ts');
const { treeSurfaceCard, boardRenameMarkup } = await bundleOf('src/surface-cards.ts');
const { addedViewLanding } = await bundleOf('src/custom-view-recipe.ts');
const { originLabel } = await bundleOf('src/format.ts');
const { historyReversibilityLabel, historyUndoOffer, operationDetailsMarkup } = await bundleOf('src/history-markup.ts');
const structure = await bundleOf('src/structure-markup.ts');
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const node = (semanticId, kind, properties = {}, children = []) => ({ semanticId, automationTarget: semanticId, kind, properties, children });
const field = (semanticId, displayName) => ({ semanticId, displayName, storageKind: 0, presentation: 'singleLine', required: false, options: [], choices: [] });
const entry = (kind, summary, semanticIds = [], reversibility = 'reversibleWithRetainedState') => ({ kind, summary, semanticIds, reversibility });

const taskPlan = {
  entity: { semanticId: 'task', displayName: 'Task', fields: [field('task.title', 'Title'), field('task.status', 'Status'), field('task.started', 'Started')], derivedFields: [] },
  surfaces: [
    node('task.form', 'recordForm', { title: 'Task form' }, [node('task.form.title', 'fieldBinding', { fieldId: 'task.title' })]),
    node('task.board', 'boardSurface', { title: 'Task board', groupByFieldId: 'task.status' }),
  ],
  records: [],
};
const notePlan = {
  entity: { semanticId: 'note', displayName: 'Note', fields: [field('note.body', 'Body')], derivedFields: [] },
  surfaces: [node('note.form', 'recordForm', { title: 'Note form' })],
  records: [],
};
const entities = [{ entityId: 'task', displayName: 'Task', fields: [] }, { entityId: 'note', displayName: 'Note', fields: [] }];

test('a line that takes something away is not marked as an addition', () => {
  const removal = entry('removeExtensionPackage', 'Remove the package Board glance from this file.', ['org.example.board-glance']);
  const retire = entry('setRetired', 'Retire Energy on Task; retain stored data.', ['task', 'task.energy']);
  assert.equal(proposal.changeMark(removal), 'remove');
  assert.equal(proposal.changeMark(retire), 'remove');
  assert.equal(proposal.changeMark(entry('setRetired', 'Reactivate Energy on Task; retain stored data.')), 'add');
  assert.equal(proposal.changeMark(entry('addField', 'Add Effort points to Task.')), 'add');
  assert.equal(proposal.changeMark(entry('setUiProperty', 'Rename board to Lanes.')), 'change');
  const markup = proposal.proposalChangesMarkup({ operationCount: 1, semanticDiff: [removal] });
  assert.doesNotMatch(markup, /＋/, `a package removal is drawn with a plus: ${markup}`);
  assert.match(markup, /data-change="remove"/);
  assert.doesNotMatch(source('view-proposal.ts'), /＋/, 'the review still draws a fixed plus beside every change');
  assert.match(source('view-proposal.ts'), /\$\{proposalChangesMarkup\(preview\)\}/, 'the review does not draw its lines through proposalChangesMarkup');
});

test('the Preview panel names the record type and screen the proposal touches', () => {
  // Renaming the board: its line carries the surface and the board node.
  const rename = proposal.proposalPlace([entry('setUiProperty', 'Rename board to Lanes.', ['surface.task.board', 'task.board'])], [taskPlan, notePlan], entities);
  assert.deepEqual(rename.types, ['Task']);
  assert.deepEqual(rename.screens, ['Task board'], 'a board rename names a screen other than the board');
  assert.deepEqual(rename.start, { entityId: 'task', surfaceId: 'task.board' });
  // A field added to the second record type names that type and no screen.
  const added = proposal.proposalPlace([entry('addField', 'Add Mood to Note.', ['note', 'note.mood'], 'irreversibleDeclared')], [taskPlan, notePlan], entities);
  assert.deepEqual(added.types, ['Note'], 'a field added to the second type reads as a change to the first');
  assert.deepEqual(added.screens, []);
  const markup = proposal.proposalPlaceMarkup(added, 1);
  assert.doesNotMatch(markup, /<dt>Screen/, `a schema-only change still names a screen: ${markup}`);
  assert.match(markup, /<dt>Record type<\/dt><dd>Note<\/dd>/);
  const view = source('view-proposal.ts');
  assert.doesNotMatch(view, /surfaceTitle\(plan\)/, 'the panel still names the first titled screen of the whole file');
  assert.match(view, /proposalPlaceMarkup\(place, preview\.operationCount\)/, 'the panel is not drawn from what the proposal touches');
});

test('removing a package names each screen and panel that loses its code', () => {
  const nodes = [
    { surfaceId: 's.view', nodeId: 'n.glance', parentNodeId: null, kind: 'extensionRecordsSurface', position: 0, properties: { packageId: 'org.example.board-glance', title: 'Glance', entityId: 'task' } },
    { surfaceId: 's.page', nodeId: 'n.page', parentNodeId: null, kind: 'detailSurface', position: 0, properties: { title: 'Task page', entityId: 'task' } },
    { surfaceId: 's.page', nodeId: 'n.panel', parentNodeId: 'n.page', kind: 'extensionRecordPanel', position: 0, properties: { packageId: 'org.example.board-glance', title: 'At a glance' } },
  ];
  const packages = [{ packageId: 'org.example.board-glance', title: 'Board glance' }];
  const removal = entry('removeExtensionPackage', 'Remove the package Board glance from this file.', ['org.example.board-glance']);
  const markup = proposal.packageRemovalMarkup([removal], nodes, entities, packages);
  for (const expected of ['Glance', 'a screen under View in Task', 'At a glance', 'a panel on Task page, for each Task record', 'Board glance is missing'])
    assert.ok(markup.includes(expected), `the removal review does not say "${expected}": ${markup}`);
  // A view the same proposal removes is not one that will show the notice.
  const both = proposal.packageRemovalMarkup([removal, entry('removeUiNode', 'Remove Glance.', ['s.view', 'n.glance'])], nodes, entities, packages);
  assert.doesNotMatch(both, />Glance</);
  assert.match(both, /At a glance/);
  assert.match(source('view-proposal.ts'), /packageRemovalMarkup\(preview\.semanticDiff, state\.session\.uiNodes/, 'the review does not list the uses');
});

test('a change History will not undo says so beside its class, in the review and in History', () => {
  // Add view: one node and its settings, which History never offers to undo.
  const addView = { operationCount: 6, semanticDiff: [entry('addUiNode', 'Add the custom view Glance.', ['s', 'n'], 'reversible'), entry('setUiProperty', 'Set its configuration.', ['s', 'n'])] };
  assert.equal(proposal.historyOffersUndo(addView), false);
  const lines = [...proposal.proposalChangesMarkup(addView).matchAll(/<p>(.*?)<\/p>/g)].map((match) => match[1]);
  assert.deepEqual(lines, ['Can be undone, but not from History', 'Can be undone if nothing has changed it since, but not from History']);
  assert.match(proposal.historyUndoNote(addView), /History will not offer Undo for this as a whole/);
  // One change, or a batch of record changes, is offered.
  assert.equal(proposal.historyOffersUndo({ operationCount: 1, semanticDiff: [entry('setRetired', 'Retire Energy on Task.')] }), true);
  assert.equal(proposal.historyOffersUndo({ operationCount: 3, semanticDiff: [entry('setField', 'a'), entry('deleteRecord', 'b'), entry('createRecord', 'c')] }), true);
  assert.equal(proposal.historyUndoNote({ operationCount: 1, semanticDiff: [entry('addField', 'Add Mood.', [], 'irreversibleDeclared')] }), '');
  assert.equal(historyReversibilityLabel({ operationType: 'ui.setProperty', reversibility: 'reversibleWithRetainedState' }, false),
    'Can be undone if nothing has changed it since, but not from History', 'History draws "Can be undone" beside an entry it will not undo');
  assert.equal(historyReversibilityLabel({ operationType: 'ui.setProperty', reversibility: 'reversibleWithRetainedState' }, true), 'Can be undone if nothing has changed it since');
});

test('accepting a Studio proposal goes back to the page it came from, and says so on screen', () => {
  const after = (overrides) => proposal.viewAfterAccepting({ returnView: 'structure', buildsScreens: true, hadScreens: true, fromView: false, codeOnly: false, ...overrides });
  assert.equal(after({}), 'structure', 'a field added on Structure in a file with screens lands elsewhere');
  assert.equal(after({ returnView: 'surfaces' }), 'surfaces');
  assert.equal(after({ returnView: 'data', buildsScreens: true, hadScreens: false }), 'use', 'starting the first screens should show them');
  assert.equal(after({ returnView: 'data', buildsScreens: false, hadScreens: false }), 'data');
  const view = source('view-proposal.ts');
  assert.match(view, /state\.view = viewAfterAccepting\(/, 'promoteProposal does not choose its landing through viewAfterAccepting');
  assert.doesNotMatch(view, /previewApplications\?\.length \? 'use'/, 'promoteProposal still lands every proposal of a file with screens on Use');
  assert.match(view, /else showOutcome\(outcome\)/, 'the outcome is only announced, not shown');
});

test('the review’s Back rejects a Studio proposal rather than leaving it in the host', () => {
  const view = source('view-proposal.ts');
  assert.match(view, /#close-proposal'\)\.addEventListener\('click', \(\) => void discardProposal\(\)\)/, 'Back does not discard the proposal');
  const discard = view.slice(view.indexOf('export async function discardProposal'), view.indexOf('export async function rejectProposal'));
  assert.match(discard, /client\.request<DesktopPromotionView>\('proposal\.reject'/, 'Back forgets the proposal without rejecting it');
  assert.match(discard, /discarded\. Nothing in the file changed\./);
});

test('the person’s own delete, keep mark, index build and undo read "by you"', () => {
  // The host records these as "studio" when the page names no writer (DesktopSessionController,
  // SqliteNendoStore.Compensation); read from the sources, so the guard follows them.
  const recorded = ['../../Nendo.Desktop/DesktopSessionController.cs', '../../Nendo.Engine/Storage/SqliteNendoStore.Compensation.cs']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8').match(/"studio"/g)?.length ?? 0)
    .reduce((sum, count) => sum + count, 0);
  assert.ok(recorded >= 3, `only ${recorded} "studio" origins were found; the guard measures nothing`);
  assert.equal(originLabel('studio', []), originLabel('workbench', []), 'History names the person’s own change "by studio"');
});

test('a card says what stands in its way instead of Healthy', () => {
  const plan = { ...taskPlan };
  const view = node('task.links', 'extensionGraphSurface', { title: 'Links', packageId: 'org.example.link-graph' });
  const warning = { code: 'NUI452', severity: 'warning', message: 'The package org.example.link-graph is not in this file, so the view has no code to run yet.', semanticId: 'task.links', propertyPath: 'packageId', hint: '' };
  const missing = treeSurfaceCard(plan, view, { warnings: [warning], extensions: { run: true, packages: [] } });
  assert.doesNotMatch(missing, />Healthy</, `a view whose package is missing reads Healthy: ${missing}`);
  assert.match(missing, /Missing package/);
  assert.match(missing, /is not in this file, so the view has no code to run yet/);
  const warned = treeSurfaceCard(plan, view, { warnings: [{ ...warning, severity: 1 }], extensions: null });
  assert.match(warned, /health-chip warning[^>]*>.*Warning</s, 'a compile warning is dropped from the card');
  const off = treeSurfaceCard(plan, view, { warnings: [], extensions: { run: false, packages: [{ packageId: 'org.example.link-graph', title: 'Link graph' }] } });
  assert.match(off, />Off</, 'a custom view reads Healthy while custom views are off');
  assert.match(treeSurfaceCard(plan, taskPlan.surfaces[0], { warnings: [], extensions: null }), />Healthy</);
  assert.match(source('view-surfaces.ts'), /treeSurfaceCard\(plan, root, cardContext\(\)\)/, 'Surfaces draws its cards without the warnings');
});

test('an action is named by its label and says every field its steps set', () => {
  const command = node('command.task.start', 'recordCommand', { definitionVersion: 3, entityId: 'task', label: 'Start work' }, [
    node('command.task.start.status', 'commandStep', { fieldId: 'task.status', valueKind: 'literal', value: 'Doing' }),
    node('command.task.start.started', 'commandStep', { fieldId: 'task.started', valueKind: 'today' }),
  ]);
  const card = treeSurfaceCard(taskPlan, command);
  assert.match(card, /<h3[^>]*>Start work<\/h3>/, `the action is titled by its record type: ${card}`);
  assert.match(card, /Action · sets Status, Started/, `the card does not say what the action sets: ${card}`);
});

test('each board renames itself, addressed by its own node', () => {
  const plan = { ...taskPlan, surfaces: [node('task.byStatus', 'boardSurface', { title: 'By status' }), node('task.byEnergy', 'boardSurface', { title: 'By energy' })] };
  const markup = plan.surfaces.map((root) => treeSurfaceCard(plan, root)).join('');
  const bound = [...markup.matchAll(/data-board-rename="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(bound, ['task.byStatus', 'task.byEnergy'], `two boards should have two rename controls bound to their nodes: ${bound}`);
  assert.match(boardRenameMarkup(plan.surfaces[1]), /value="By energy"/);
  assert.equal(boardRenameMarkup(node('b', 'boardSurface', {})), '', 'an untitled board offers a rename of nothing');
  assert.doesNotMatch(source('view-surfaces.ts'), /surfaceRoot\(plan, 'boardSurface'\)/, 'Surfaces still renames only the first board');
});

test('Structure lists calculated fields apart, with formula and result type, and says what they keep from retiring', () => {
  const plants = {
    entityId: 'plant', displayName: 'Plant',
    fields: [{ fieldId: 'seeds', displayName: 'Seeds' }, { fieldId: 'grams', displayName: 'Grams' }, { fieldId: 'name', displayName: 'Name' }],
    derivedFields: [{ fieldId: 'perGram', displayName: 'Seeds per gram', calculationId: 'plant.perGram', resultType: 'Decimal', resultNullable: true, expression: 'seeds / grams', readsFieldIds: ['grams', 'seeds'] }],
  };
  const all = [plants];
  assert.equal(structure.fieldCountLabel(plants), '3 stored fields · 1 calculated', 'the count still takes the stored fields for all of them');
  assert.equal(structure.fieldCountLabel({ fields: plants.fields, derivedFields: [] }), '3 fields');
  const markup = structure.calculatedFieldsMarkup(plants, all);
  for (const expected of ['Calculated', 'Seeds per gram', 'seeds / grams', 'Decimal', 'May be empty', 'Reads Grams, Seeds'])
    assert.ok(markup.includes(expected), `the Calculated group does not say "${expected}": ${markup}`);
  assert.equal(structure.calculatedFieldsMarkup({ ...plants, derivedFields: [] }, all), '');
  assert.match(structure.readByMarkup('seeds', all), /Seeds per gram reads this field, so it cannot be retired while that calculation stays\./);
  assert.equal(structure.readByMarkup('name', all), '');
  const view = source('view-structure.ts');
  assert.match(view, /\$\{calculatedFieldsMarkup\(entity, state\.session\.entities\)\}/, 'Structure does not draw the Calculated group');
  assert.match(view, /fieldCountLabel\(entity\)/, 'Structure still counts only the stored fields');
  assert.match(view, /readByMarkup\(field\.fieldId, state\.session\.entities\)/, 'Structure does not say which calculation reads a field');
});

test('a view the Add view form made opens in Use, whatever page the form was on', () => {
  const screen = addedViewLanding({ kind: 'records', title: 'Glance', entityId: 'task', pageTitle: null }, entities);
  assert.deepEqual(screen, { view: 'use', sentence: 'Glance is under View in Task, and open now.' });
  const panel = addedViewLanding({ kind: 'panel', title: 'At a glance', entityId: 'task', pageTitle: 'Task page' }, entities);
  assert.equal(panel.view, null, 'a panel has no page without a record, so it does not move the person');
  assert.equal(proposal.viewAfterAccepting({ returnView: 'surfaces', buildsScreens: true, hadScreens: true, fromView: false, codeOnly: false, landsOn: 'use' }), 'use',
    'an added screen is accepted onto Screens while the outcome says it is open now');
  const view = source('view-proposal.ts');
  assert.match(view, /landsOn: landing\?\.view \?\? null/, 'promoteProposal does not land on the view the form added');
  assert.match(source('view-packages.ts'), /const landing = addedViewLanding\(added, state\.session\.entities\);/, 'landAddedView does not say where it lands');
});

test('Escape leaves the review without rejecting, and Discard says what it does', () => {
  const view = source('view-proposal.ts');
  assert.match(view, /id="leave-proposal" type="button" data-escape/, 'Escape has no way out of the review but Discard');
  assert.match(view, /#leave-proposal'\)\.addEventListener\('click', \(\) => leaveProposal\(\)\)/);
  const leave = view.slice(view.indexOf('export function leaveProposal'), view.indexOf('export async function discardProposal'));
  assert.ok(leave.length > 0, 'leaveProposal is missing');
  assert.doesNotMatch(leave, /proposal\.reject|state\.proposal = null/, 'Escape rejects or forgets the proposal');
  assert.match(view, />Discard<\/button>/, 'the button that rejects is still labelled Back');
  assert.match(source('main.ts'), /content\.querySelector<HTMLButtonElement>\('\[data-escape\]'\) \?\? content\.querySelector<HTMLButtonElement>\('\[data-dismiss\]:not\(:disabled\)'\)/,
    'the Escape handler presses the first data-dismiss, which rejects the proposal');
});

test('only a proposal Studio prepared is rejected by Discard', () => {
  assert.equal(proposal.isStudioPrepared({ origin: 'workbench' }), true);
  for (const origin of ['agent-342b6a7d16b4', 'extension:org.example.glance', undefined, ''])
    assert.equal(proposal.isStudioPrepared({ origin }), false, `a proposal from ${origin} is treated as Studio's own`);
  const view = source('view-proposal.ts');
  const discard = view.slice(view.indexOf('export async function discardProposal'), view.indexOf('export async function rejectProposal'));
  assert.match(discard, /if \(!isStudioPrepared\(state\.proposal\)\) \{ state\.proposal = null;/, 'Discard rejects a proposal Studio did not prepare');
});

test('a calculation that reads other calculations names them, and a type its calculations hold is not offered for retirement', () => {
  const plants = {
    entityId: 'plant', displayName: 'Plant', fields: [{ fieldId: 'seeds', displayName: 'Seeds' }],
    derivedFields: [
      { fieldId: 'perGram', displayName: 'Seeds per gram', calculationId: 'plant.perGram', resultType: 'Decimal', resultNullable: false, expression: 'seeds', readsFieldIds: ['seeds'], readsCalculationIds: [], readsEntityIds: ['plant'] },
      { fieldId: 'doubled', displayName: 'Doubled', calculationId: 'plant.doubled', resultType: 1, resultNullable: false, expression: 'per * 2', readsFieldIds: [], readsCalculationIds: ['plant.perGram'], readsEntityIds: ['plant'] },
    ],
  };
  const beds = { entityId: 'bed', displayName: 'Bed', fields: [], derivedFields: [
    { fieldId: 'plantCount', displayName: 'Plants', calculationId: 'bed.plantCount', resultType: 0, resultNullable: false, expression: 'n', readsFieldIds: ['bed'], readsCalculationIds: [], readsEntityIds: ['bed', 'plant'] }] };
  const soil = { entityId: 'soil', displayName: 'Soil', fields: [], derivedFields: [] };
  const all = [plants, beds, soil];
  const markup = structure.calculatedFieldsMarkup(plants, all);
  assert.doesNotMatch(markup, /Reads no field/, `a calculation that reads a calculation reads "no field": ${markup}`);
  assert.match(markup, /Reads Seeds per gram/);
  assert.deepEqual(structure.calculationsHoldingType('plant', all), ['Seeds per gram', 'Doubled', 'Plants']);
  assert.deepEqual(structure.calculationsHoldingType('soil', all), []);
  assert.match(structure.typeHeldByMarkup('plant', all), /cannot be retired while they stay/);
  assert.match(source('view-structure.ts'), /\$\{typeHeld \? ' disabled aria-describedby="type-held-by"' : ''\}/, 'Retire record type is offered under a calculation the host would refuse it for');
});

test('a panel on a page the same proposal removes is not listed', () => {
  const nodes = [
    { surfaceId: 's.page', nodeId: 'n.page', parentNodeId: null, kind: 'detailSurface', position: 0, properties: { title: 'Task page', entityId: 'task' } },
    { surfaceId: 's.page', nodeId: 'n.section', parentNodeId: 'n.page', kind: 'section', position: 0, properties: {} },
    { surfaceId: 's.page', nodeId: 'n.panel', parentNodeId: 'n.section', kind: 'extensionRecordPanel', position: 0, properties: { packageId: 'org.example.board-glance', title: 'At a glance' } },
  ];
  const removal = entry('removeExtensionPackage', 'Remove the package Board glance from this file.', ['org.example.board-glance']);
  const markup = proposal.packageRemovalMarkup([removal, entry('removeUiNode', 'Remove Task page.', ['s.page', 'n.page'])], nodes, entities, []);
  assert.doesNotMatch(markup, /At a glance/, `a panel whose page goes with the package is listed as one that will show the notice: ${markup}`);
});

test('History says nothing of its Undo beside an entry it already undid, or where the host cannot say', () => {
  const revision = { revisionId: 'r1', canRequestCompensation: false };
  assert.equal(historyUndoOffer(revision, [{ compensationOfRevisionId: 'r1' }], true), null, 'an undone entry is still said to be beyond History');
  assert.equal(historyUndoOffer(revision, [], false), null, 'the preview host, which offers nothing, says every entry is beyond History');
  assert.equal(historyUndoOffer(revision, [], true), false);
  assert.equal(historyUndoOffer({ ...revision, canRequestCompensation: true }, [], true), true);
  const operation = { operationId: 'o', operationType: 'ui.setProperty', reversibility: 'reversibleWithRetainedState', canonicalJson: '{}' };
  assert.equal(historyReversibilityLabel(operation, null), 'Can be undone if nothing has changed it since');
  assert.match(operationDetailsMarkup([operation], [], null), /Can be undone if nothing has changed it since<\/li>/);
  assert.match(source('view-history.ts'), /historyUndoOffer\(revision, state\.history, client\.mode === 'desktop'\)/, 'History does not ask whether the host computed the offer');
});

test('the Agent page’s review uses the same marks as Studio’s', () => {
  const agent = source('view-agent.ts');
  assert.doesNotMatch(agent, /＋/, 'the Agent page still draws a fixed plus beside every change');
  assert.match(agent, /\$\{proposalChangesMarkup\(preview\)\}/, 'the Agent page does not draw its lines through proposalChangesMarkup');
});
