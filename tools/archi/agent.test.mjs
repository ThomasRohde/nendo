import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { E, buildModel } from '../../extensions/archi/model.js';
import {
  A, FINISHED, askContext, askMessage, askRecord, asksWithProposals, countsSentence, finishedAsk, parseWrites, planProposal,
  progressOf, proposalEdits, quickAsks, removeAsks, selectionListing, viewListing,
} from '../../extensions/archi/agent.js';
import * as canvas from '../../extensions/archi/canvas.js';

// The workbench and the person's launched agent, over Archisurance as Archi.nendo holds it: what
// a request says and carries within Nendo's bounds, and an agent's proposal made into the writes
// the editor previews and Commit saves.
const { records } = JSON.parse(readFileSync(new URL('./archisurance.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
const { Worker: ElkWorker } = require('../../extensions/archi/vendor/elkjs/elk-worker.min.js');
canvas.useElkWorkerFactory(url => new ElkWorker(url));

const model = buildModel(records);
const named = (entityId, name) => [...model.records.values()].find(record => record.entityId === entityId
  && (record.values['ar.concept.name'] ?? record.values['ar.view.name']) === name);
const allowed = (source, target, relationship) => canvas.validRelationshipTypes(source, target).includes(relationship);
const views = model.of(E.view);
const busiest = views.map(view => [view, model.of(E.item).filter(item => item.values['ar.item.view'] === view.recordId).length]).sort((a, b) => b[1] - a[1])[0][0];
const elementOn = viewId => model.records.get(model.of(E.item).find(item => item.values['ar.item.view'] === viewId && item.values['ar.item.kind'] === 'Element').values['ar.item.concept']);

test('a view is listed for the agent box by box and line by line, with the IDs a proposal names', () => {
  const listing = viewListing(model, busiest.recordId);
  const items = model.of(E.item).filter(item => item.values['ar.item.view'] === busiest.recordId);
  assert.match(listing.split('\n')[0], new RegExp(`^view ${busiest.recordId} «`));
  const box = items.find(item => item.values['ar.item.kind'] === 'Element');
  assert.match(listing, new RegExp(`box ${box.recordId} \\w+ «[^»]*» concept ${box.values['ar.item.concept']} at ${box.values['ar.item.x']},${box.values['ar.item.y']}`));
  const line = items.find(item => item.values['ar.item.kind'] === 'Relationship connection');
  assert.match(listing, new RegExp(`line ${line.recordId} \\w+Relationship concept ${line.values['ar.item.concept']} from ${line.values['ar.item.source']} to ${line.values['ar.item.target']}`));
  assert.ok(listing.length <= 7800, `${listing.length} characters`);
});

test('a listing past Nendo\'s bound is cut, and says where the rest is read', () => {
  const many = [...records['ar.item']];
  const viewId = busiest.recordId;
  const concept = elementOn(viewId).recordId;
  for (let n = 0; n < 400; n++) many.push({ entityId: E.item, recordId: `ar-extra-${n}`, version: 1, values: { 'ar.item.view': viewId, 'ar.item.kind': 'Element', 'ar.item.concept': concept, 'ar.item.x': n, 'ar.item.y': n } });
  const listing = viewListing(buildModel({ ...records, 'ar.item': many }), viewId);
  assert.ok(listing.length <= 7800, `${listing.length} characters`);
  assert.match(listing, new RegExp(`… and \\d+ more lines\\. Read the rest at nendo://application/entity/ar\\.item/records with ar\\.item\\.view eq ${viewId}\\.$`));
});

test('the message names the Ask, the skill and the mode, and every context item is within Nendo\'s bounds', () => {
  const element = elementOn(busiest.recordId);
  const ask = { ...askRecord(model, { request: 'Explain   this\nview', mode: 'Answer', viewId: busiest.recordId, selected: [element.recordId] }), version: 1 };
  assert.equal(ask.values['ar.ask.state'], 'Waiting');
  assert.equal(ask.values['ar.ask.context'], askContext(model, { viewId: busiest.recordId, selected: [element.recordId] }));
  const issues = [{ severity: 'warning', message: 'Element is not used in any view', objectId: element.recordId, where: 'Business' }];
  const { text, context } = askMessage(model, ask, { viewId: busiest.recordId, selected: [element.recordId], issues });
  assert.match(text, new RegExp(`^Work Archi ask «Explain this view» \\(ar\\.ask record ${ask.recordId.replaceAll('.', '\\.')}\\) by this file's archimate skill \\(skill://org\\.nendo\\.archimate/archimate/SKILL\\.md\\)`));
  assert.match(text, /Answer only\./);
  assert.equal(context.length, 4);
  assert.deepEqual(context.map(item => item.title.split(':')[0]), ['Ask', 'View', 'Selected', 'The validator\'s findings (1)']);
  for (const item of context) {
    assert.match(item.uri, /^nendo:\/\/application\/\S+$/);
    assert.ok(item.uri.length <= 600 && item.title.length <= 120 && item.text.length <= 8000, JSON.stringify(item).slice(0, 200));
  }
  assert.ok(context.reduce((sum, item) => sum + item.text.length, 0) <= 32000);
  assert.match(context[2].text, new RegExp(`^element ${element.recordId} `));
  assert.throws(() => askRecord(model, { request: '   ' }), /Say what to ask/);
  assert.match(selectionListing(model, [element.recordId]), /relationships from it/);
});

test('an Ask the agent left unfinished is finished by its turn: answered, proposed, stopped or not sent', () => {
  const ask = { entityId: A.ask, recordId: 'ar.ask.r.1', version: 3, values: { 'ar.ask.state': 'Working', 'ar.ask.progress': 'Started.', 'ar.ask.reply': null } };
  assert.deepEqual(finishedAsk(ask, { reply: 'Done.' }).values['ar.ask.state'], 'Answered');
  assert.equal(finishedAsk(ask, { reply: 'Done.' }).values['ar.ask.reply'], 'Done.');
  assert.equal(finishedAsk(ask, { proposals: 2 }).values['ar.ask.state'], 'Proposed');
  assert.equal(finishedAsk(ask, { stopReason: 'cancelled' }).values['ar.ask.state'], 'Cancelled');
  const refused = finishedAsk(ask, { refusal: 'you said Not now.' });
  assert.equal(refused.values['ar.ask.state'], 'Failed');
  assert.equal(refused.values['ar.ask.progress'], 'Started.\nNot sent: you said Not now.');
  for (const state of FINISHED) assert.equal(finishedAsk({ ...ask, values: { ...ask.values, 'ar.ask.state': state } }, {}), null, state);
  assert.deepEqual(progressOf({ values: { 'ar.ask.progress': 'Started.\nElement 3 of 7: documented.' } }), { last: 'Element 3 of 7: documented.', step: { done: 3, of: 7 } });
});

test('a proposal\'s own IDs become record IDs, types named by key or name resolve, and folders, kinds, sizes and line ends are filled in', () => {
  const view = busiest.recordId;
  const actor = elementOn(view);
  const writes = [
    { op: 'create', entityId: E.concept, recordId: '$broker', values: { 'ar.concept.name': 'Broker portal', 'ar.concept.type': 'Application Component' } },
    { op: 'create', entityId: E.concept, recordId: '$serves', values: { 'ar.concept.type': 'ServingRelationship', 'ar.concept.source': '$broker', 'ar.concept.target': actor.recordId } },
    { op: 'create', entityId: E.item, recordId: '$box', values: { 'ar.item.concept': '$broker', 'ar.item.x': 40, 'ar.item.y': 40 } },
    { op: 'create', entityId: E.item, recordId: '$line', values: { 'ar.item.concept': '$serves', 'ar.item.kind': 'line' } },
  ];
  const plan = planProposal(model, writes, { allowed, viewId: view });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.blocking, false);
  const [broker, serves, box, line] = plan.writes;
  for (const write of plan.writes) assert.match(write.recordId, /^ar-id-[0-9a-f]{32}$/);
  assert.equal(broker.values['ar.concept.type'], 'ar.type.r.ApplicationComponent');
  assert.equal(broker.values['ar.concept.category'], 'Element');
  assert.equal(model.records.get(broker.values['ar.concept.folder']).values['ar.folder.kind'], 'Application');
  assert.equal(serves.values['ar.concept.source'], broker.recordId);
  assert.equal(model.records.get(serves.values['ar.concept.folder']).values['ar.folder.kind'], 'Relations');
  assert.deepEqual([box.values['ar.item.kind'], box.values['ar.item.view'], box.values['ar.item.width'], box.values['ar.item.height']], ['Element', view, 120, 55]);
  assert.equal(line.values['ar.item.kind'], 'Relationship connection');
  assert.equal(line.values['ar.item.source'], box.recordId);
  const actorBox = model.of(E.item).find(item => item.values['ar.item.view'] === view && item.values['ar.item.concept'] === actor.recordId);
  assert.equal(line.values['ar.item.target'], actorBox.recordId);
  assert.equal(plan.viewId, view);
  assert.deepEqual(plan.counts, { elements: 1, relationships: 1, views: 0, boxes: 1, lines: 1, changed: 0, removed: 0 });
  assert.equal(countsSentence(plan.counts), '1 new element · 1 new relationship · 1 box · 1 line');
  assert.ok(plan.changes.includes('New Application Component «Broker portal»'), plan.changes.join('; '));
});

test('a relationship ArchiMate does not allow is named, and holds the proposal back from being applied', () => {
  const [a, b] = model.of(E.concept).filter(record => record.values['ar.concept.category'] === 'Element');
  const keyOf = record => model.types.get(record.values['ar.concept.type']).values['ar.type.key'];
  const refused = ['CompositionRelationship', 'SpecializationRelationship', 'TriggeringRelationship'].find(type => !allowed(keyOf(a), keyOf(b), type));
  assert.ok(refused, 'a relationship type the two ends do not allow');
  const plan = planProposal(model, [{ op: 'create', entityId: E.concept, values: { 'ar.concept.type': refused, 'ar.concept.source': a.recordId, 'ar.concept.target': b.recordId } }], { allowed });
  assert.equal(plan.blocking, true);
  assert.match(plan.problems[0], /^ArchiMate does not allow /);
  assert.equal(planProposal(model, [{ op: 'create', entityId: E.concept, values: { 'ar.concept.type': 'Nonsense' } }], { allowed }).problems[0], 'The new concept «» : Nonsense is not an ArchiMate type.'.replace('«» :', '«»:'));
});

test('writes outside the model, to records that are not there, and boxes of nothing are left out, each said', () => {
  const plan = planProposal(model, [
    { op: 'update', entityId: A.ask, recordId: 'ar.ask.r.x', values: { 'ar.ask.state': 'Answered' } },
    { op: 'update', entityId: E.concept, recordId: 'ar-not-there', values: { 'ar.concept.name': 'x' } },
    { op: 'create', entityId: E.item, values: { 'ar.item.view': busiest.recordId, 'ar.item.kind': 'Element' } },
  ], { allowed });
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.problems.length, 3, plan.problems.join(' | '));
});

test('a delete takes what Archi\'s delete takes, and a delete of something the proposal makes unmakes it', () => {
  const element = elementOn(busiest.recordId);
  const plan = planProposal(model, [
    { op: 'create', entityId: E.concept, recordId: '$x', values: { 'ar.concept.type': 'BusinessActor', 'ar.concept.name': 'Gone again' } },
    { op: 'delete', recordId: '$x' },
    { op: 'delete', entityId: E.concept, recordId: element.recordId },
  ], { allowed });
  assert.ok(!plan.writes.some(write => write.op === 'create'));
  assert.ok(plan.writes.some(write => write.recordId === element.recordId && write.op === 'delete'));
  assert.ok(plan.writes.filter(write => write.entityId === E.item).length >= 1, 'its boxes go with it');
  assert.equal(plan.counts.removed >= 1, true);
});

test('boxes given no place go below a view\'s boxes; a new view of them is laid out by ELK', async () => {
  const view = busiest.recordId;
  const items = model.of(E.item).filter(item => item.values['ar.item.view'] === view && !item.values['ar.item.parent'] && item.values['ar.item.kind'] !== 'Relationship connection');
  const bottom = Math.max(...items.map(item => item.values['ar.item.y'] + item.values['ar.item.height']));
  const concept = elementOn(view).recordId;
  const below = planProposal(model, [{ op: 'create', entityId: E.item, values: { 'ar.item.view': view, 'ar.item.concept': concept } },
    { op: 'create', entityId: E.item, values: { 'ar.item.view': view, 'ar.item.concept': concept } }], { allowed });
  assert.deepEqual(below.layout, []);
  for (const write of below.writes) assert.ok(write.values['ar.item.y'] > bottom, `${write.values['ar.item.y']} is not below ${bottom}`);
  assert.notEqual(below.writes[0].values['ar.item.x'], below.writes[1].values['ar.item.x']);

  const elements = model.of(E.concept).filter(record => record.values['ar.concept.category'] === 'Element').slice(0, 4);
  const fresh = [{ op: 'create', entityId: E.view, recordId: '$v', values: { 'ar.view.name': 'Drafted by the agent' } },
    ...elements.map(element => ({ op: 'create', entityId: E.item, values: { 'ar.item.view': '$v', 'ar.item.concept': element.recordId } }))];
  const proposal = { values: { 'ar.proposal.writes': JSON.stringify(fresh), 'ar.proposal.view': '$v' } };
  const edits = await proposalEdits(canvas, records, model, proposal);
  assert.equal(edits.error, null);
  assert.deepEqual(edits.layout, [edits.viewId]);
  const viewWrite = edits.edits.find(write => write.entityId === E.view);
  assert.equal(viewWrite.values['ar.view.name'], 'Drafted by the agent');
  assert.equal(edits.viewId, viewWrite.recordId);
  const boxes = edits.edits.filter(write => write.entityId === E.item);
  assert.equal(boxes.length, 4);
  // ELK spreads them out: no two boxes share a place, and the edits read back are the boxes it placed.
  assert.equal(new Set(boxes.map(write => `${write.values['ar.item.x']},${write.values['ar.item.y']}`)).size, 4);
  const back = canvas.buildMirror(canvas.applyWrites(records, edits.edits));
  assert.equal(back.views[viewWrite.recordId].childIds.length, 4);
});

test('a view a proposal makes, named by the agent\'s own ID, is the view of boxes that name none', () => {
  const elements = model.of(E.concept).filter(record => record.values['ar.concept.category'] === 'Element').slice(0, 2);
  const plan = planProposal(model, [
    { op: 'create', entityId: E.view, recordId: '$first', values: { 'ar.view.name': 'First' } },
    { op: 'create', entityId: E.view, recordId: '$second', values: { 'ar.view.name': 'Second' } },
    ...elements.map(element => ({ op: 'create', entityId: E.item, values: { 'ar.item.concept': element.recordId } })),
  ], { allowed, viewId: '$second' });
  assert.deepEqual(plan.problems, []);
  const second = plan.writes.find(write => write.values['ar.view.name'] === 'Second').recordId;
  assert.equal(plan.viewId, second);
  assert.deepEqual(plan.writes.filter(write => write.entityId === E.item).map(write => write.values['ar.item.view']), [second, second]);
  assert.deepEqual(plan.layout, [second]);
});

test('a proposal\'s edits are what Commit sends: Archi IDs, and the versions of what they point at', async () => {
  const view = busiest.recordId;
  const actor = elementOn(view);
  const proposal = { values: { 'ar.proposal.view': view, 'ar.proposal.writes': JSON.stringify({ writes: [
    { op: 'update', entityId: E.concept, recordId: actor.recordId, values: { 'ar.concept.documentation': 'Who buys the insurance.' } },
    { op: 'create', entityId: E.concept, recordId: 'n1', values: { 'ar.concept.type': 'BusinessRole', 'ar.concept.name': 'Policy holder' } },
    { op: 'create', entityId: E.item, recordId: 'b1', values: { 'ar.item.concept': 'n1', 'ar.item.x': 600, 'ar.item.y': 20 } },
  ] }) } };
  const edits = await proposalEdits(canvas, records, model, proposal);
  const documented = edits.edits.find(write => write.recordId === actor.recordId);
  assert.deepEqual(documented.values, { 'ar.concept.documentation': 'Who buys the insurance.' });
  const role = edits.edits.find(write => write.op === 'create' && write.entityId === E.concept);
  assert.equal(role.values['ar.concept.archiId'], role.recordId.slice(3));
  assert.equal(role.targetVersions['ar.concept.type'], model.records.get('ar.type.r.BusinessRole').version);
  assert.deepEqual(parseWrites('nope').writes, []);
  assert.match(parseWrites('{"x":1}').error, /not a list/);
  assert.match(parseWrites('[{"op":"update"}]').error, /names no record/);
});

test('asks are shown newest first with their proposals in order, and removed with them', () => {
  const asks = [
    { entityId: A.ask, recordId: 'a1', version: 1, values: { 'ar.ask.asked': '2026-10-23T08:00:00Z' } },
    { entityId: A.ask, recordId: 'a2', version: 2, values: { 'ar.ask.asked': '2026-10-23T09:00:00Z' } },
  ];
  const proposals = [
    { entityId: A.proposal, recordId: 'p2', version: 1, values: { 'ar.proposal.ask': 'a2', 'ar.proposal.order': 2 } },
    { entityId: A.proposal, recordId: 'p1', version: 1, values: { 'ar.proposal.ask': 'a2', 'ar.proposal.order': 1 } },
  ];
  const listed = asksWithProposals(asks, proposals);
  assert.deepEqual(listed.map(entry => [entry.ask.recordId, entry.proposals.map(p => p.recordId)]), [['a2', ['p1', 'p2']], ['a1', []]]);
  assert.deepEqual(removeAsks(asks, proposals, ['a2']).map(write => write.recordId), ['p2', 'p1', 'a2']);
});

test('the quick asks follow what is open and selected', () => {
  const element = elementOn(busiest.recordId);
  const none = quickAsks(model, {}).map(ask => ask.id);
  assert.deepEqual(none, ['draft-view', 'gaps']);
  const all = quickAsks(model, { viewId: busiest.recordId, selected: [element.recordId], issues: 3, empty: false }).map(ask => ask.id);
  assert.deepEqual(all, ['explain-view', 'review-view', 'complete-view', 'document', 'relate', 'view-around', 'fix-issues', 'draft-view', 'gaps']);
  assert.ok(named(E.view, busiest.values['ar.view.name']));
});
