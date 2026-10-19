import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { bundleOf } from './bundle-of.mjs';

// The broad review of 2026-10-10 on Studio's authoring flows (W-230): proposals that came out
// other than the person meant, reviews that misdescribed them, and History's Undo. Each test runs
// the function the page draws or acts with; where the defect is in a page's wiring, the module is
// bundled with only the host, the page boundary and the dialog standing in.
const markup = await bundleOf('src/record-markup.ts');
const structure = await bundleOf('src/structure-markup.ts');
const studio = await bundleOf('src/studio.ts');
const history = await bundleOf('src/history-markup.ts');
const format = await bundleOf('src/format.ts');
const proposalMarkup = await bundleOf('src/proposal-markup.ts');
const look = await bundleOf('src/file-look.ts');
const columns = await bundleOf('src/studio-columns.ts');
const recipes = await bundleOf('src/idea-garden-recipe.ts');
const help = await bundleOf('src/help.ts');
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const field = (fieldId, displayName, extra = {}) => ({ fieldId, displayName, storageKind: 'text', required: false, retired: false, presentation: 'singleLine', options: [], choices: [], ...extra });
const status = field('task.status', 'Status', { presentation: 'singleChoice', options: ['idea', 'doing', 'done'],
  choices: [{ id: 'idea', displayName: 'Idea', retired: false }, { id: 'doing', displayName: 'Doing', retired: false }, { id: 'done', displayName: 'Done', retired: false }] });
const score = field('task.score', 'Score', { storageKind: 'integer', presentation: 'rating', scale: { min: 1, max: 5 } });
const title = field('task.title', 'Title');
const task = { entityId: 'task', displayName: 'Task', fields: [title, status, score], derivedFields: [] };

// ---------------------------------------------------------------------------------------------
// The page's own wiring, bundled with stand-ins for the host, the page boundary and the dialog.

const root = fileURLToPath(new URL('..', import.meta.url));
const host = { calls: [], reply: null, questions: [], answer: false, errors: [], outcomes: [], draws: 0 };
globalThis.studioFlowsHost = host;
const stubs = {
  './client': `export const client = { mode: 'desktop', request: async (method, payload) => { const h = globalThis.studioFlowsHost; h.calls.push({ method, payload }); return h.reply(method, payload); } };`,
  './shell': `const h = () => globalThis.studioFlowsHost;
    export const content = { dataset: {}, innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
    export const interactionInProgress = () => false; export const rerender = () => { h().draws += 1; };
    export const setBusy = () => {}; export const showError = (text) => { h().errors.push(text); };
    export const announce = () => {}; export const clearError = () => {}; export const refreshChrome = () => {};
    export const showRetainedNotice = () => {}; export const showKeptAlert = () => {}; export const showOutcome = (text) => { h().outcomes.push(text); };
    export const requiredElement = () => ({ hidden: true, textContent: '', addEventListener: () => {}, focus: () => {} });
    export const focusWithoutInteraction = () => {}; export const markPlace = () => {};`,
  './confirm-dialog': 'export const confirmDialog = async (question) => { const h = globalThis.studioFlowsHost; h.questions.push(question); h.onAsk?.(); return h.answer; };',
  './panels': `export const drillInto = async () => {}; export const drillIntoCell = async () => {}; export const refreshOverview = async () => {};
    export const refreshVisibleTiles = async () => {}; export const wireCharts = () => {}; export const wireSummaryRetry = () => {};
    export const matrixPending = () => false; export const patchCharts = () => {};
    export const wireChartTables = () => {}; export const drillGroupOf = () => null;`,
  './view-packages': 'export const openCustomViews = async () => {}; export const landAddedView = () => null;',
  './view-data': 'export const renderData = () => {};',
};
const entry = [
  `export { compensateRevision, prepareApplication } from ${JSON.stringify(resolve(root, 'src/actions.ts'))};`,
  `export { renderFieldRequirement } from ${JSON.stringify(resolve(root, 'src/view-structure.ts'))};`,
  `export { state, emptySession } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
  `export { content } from './shell';`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'studio-flows-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('studio-flows-entry')) return '\0studio-flows-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0studio-flows-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'studio-flows-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const page = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

function openFile() {
  Object.assign(host, { calls: [], reply: () => { throw new Error('no reply'); }, questions: [], answer: false, errors: [], outcomes: [], draws: 0, onAsk: null });
  const empty = page.emptySession();
  page.state.session = { ...empty, fileSessionId: 'file-A', fileName: 'Fixture.nendo', hasFile: true,
    capabilities: { ...empty.capabilities, readData: true, readHistory: true, mutate: true },
    manifest: { changeSequence: 4, definitionRevision: 2 }, entities: [task] };
  page.state.actionInFlight = false;
  page.state.view = 'structure';
  page.state.selectedEntityId = 'task';
  page.state.proposal = null;
  page.content.dataset.place = 'structure|file-A';
  page.content.innerHTML = 'Structure';
}
const operation = (operationType, recordId) => ({ operationId: `${operationType}-${recordId}`, operationType, reversibility: 'reversible',
  canonicalJson: JSON.stringify({ operationType, payload: { entityId: 'task', recordId, fieldId: 'task.title' } }) });
const revision = (revisionId, description, lane, operationCount) => ({ revisionId, description, lane, operationCount, createdAt: '2026-10-14T09:00:00Z',
  origin: 'workbench', changeSequence: 3, compensationOfRevisionId: null, canRequestCompensation: true });
const compensated = { mutation: { blockedConditions: [] }, session: null };

// ---------------------------------------------------------------------------------------------

test('WSP-02: a Make required form starts every empty choice on a placeholder the required check refuses', () => {
  const control = markup.backfillControlMarkup(status);
  assert.match(control, /<select name="task\.status" required><option value="" selected disabled>Choose…<\/option>/,
    `a required choice with no value starts on its first option, which the preview then writes for every record: ${control}`);
  // A record form keeps its own behaviour: the placeholder is the backfill's.
  assert.doesNotMatch(markup.fieldControlMarkup({ ...markup.backfillPlan(status) }, null), /Choose…/);
  const view = source('view-structure.ts');
  assert.match(view, /\$\{backfillControlMarkup\(field\)\}/, 'the Make required form does not draw its controls through backfillControlMarkup');
  assert.doesNotMatch(view, /fieldControlMarkup\(plan, null\)/, 'the Make required form still draws a choice that picks its first option');
});

test('WSP-08: a rating made required is chosen on its scale, not typed as free text', () => {
  assert.deepEqual(markup.backfillPlan(score).scale, { min: 1, max: 5 }, 'the backfill plan drops the rating’s scale');
  const control = markup.backfillControlMarkup(score);
  assert.match(control, /<fieldset class="rating-field">/, `a rating’s backfill control is a free text box: ${control}`);
  assert.doesNotMatch(control, /type="text"/);
});

test('WSP-10: an emptied Lowest or Highest box is refused, not read as 0', () => {
  for (const bounds of [{ min: '', max: '5' }, { min: '1', max: '' }, { min: '  ', max: '5' }])
    assert.throws(() => studio.fieldProposal('task', 'Mood', 'rating', '', undefined, bounds), /Enter whole numbers for the lowest and highest values/,
      `a rating with bounds ${JSON.stringify(bounds)} is proposed`);
  const payload = studio.fieldProposal('task', 'Mood', 'rating', '', undefined, { min: '0', max: '4' });
  assert.equal(payload.mutations[0].operations[0].payload.min, 0, 'a typed 0 is still a lowest value');
  assert.match(source('view-structure.ts'), /bound\.required = rating;/, 'the scale’s boxes are not required while a rating is chosen');
});

test('WSP-20: a rename names the field, its record type and the old name, and a fill batch says it only fills', () => {
  const rename = studio.renameSchemaProposal('task', 'task.owner', ' Lead ', 2, { current: 'Owner', typeName: 'Task' });
  assert.equal(rename.title, 'Rename Owner on Task to Lead');
  assert.equal(rename.mutations[0].description, 'Rename Owner on Task to Lead');
  assert.equal(studio.renameSchemaProposal('task', null, 'Job', 2, { current: 'Task', typeName: 'Task' }).title, 'Rename record type Task to Job');
  assert.equal(structure.requirementTitle('Status', { reactivate: false, required: true, batch: 50 }), 'Fill missing Status values (first 50)',
    'a batch that only fills values is titled as making the field required');
  assert.equal(structure.requirementTitle('Status', { reactivate: false, required: true, batch: null }), 'Make Status required');
  assert.equal(structure.requirementTitle('Status', { reactivate: true, required: true, batch: null }), 'Reactivate Status');
  assert.match(source('view-structure.ts'), /requirementTitle\(field\.displayName, \{ reactivate, required, batch: page\.nextCursor \? page\.items\.length : null \}\)/,
    'the Make required form does not title a batch by what it does');
  assert.match(source('view-data.ts'), /renameSchemaProposal\(entity\.entityId, fieldId, name, revision, \{ current, typeName: entity\.displayName \}\)/);
});

test('WSP-21: each record of a reference conversion is headed by its label, its ID beside it', () => {
  const record = { recordId: '6f1c0d4e-1b2a-4c3d-9e8f-001122334455', values: { 'task.title': 'Ship the release', 'task.owner': 'acme' } };
  const legacy = field('task.owner', 'Owner', { storageKind: 'reference', presentation: null, reference: { targetEntityId: 'person', labelFieldId: 'person.name' } });
  const form = structure.conversionRecordMarkup(task, legacy, record);
  assert.match(form, /<h3>Ship the release<\/h3><code>6f1c0d4e-1b2a-4c3d-9e8f-001122334455<\/code>/, `the record is known only by its ID: ${form}`);
  assert.match(form, /Original value: <code>acme<\/code>/);
  assert.equal(structure.recordHeading(task, { recordId: 'r1', values: {} }, 'task.owner'), 'r1', 'a record with no label falls back to its ID');
  assert.match(source('view-structure.ts'), /conversionRecordMarkup\(entity, boundField, record\)/, 'the conversion form does not draw its records through conversionRecordMarkup');
});

test('WSP-05: Undo asks before a multi-record batch, a definition or a package, naming the change; one record’s edit is one press', () => {
  const batch = revision('r-import', 'Import CSV', 'Data', 3);
  const creates = [operation('data.createRecord', 'a'), operation('data.createRecord', 'b'), operation('data.createRecord', 'c')];
  const asked = history.undoQuestion(batch, creates, false);
  assert.ok(asked !== null, 'undoing a batch that created three records does not ask');
  assert.match(asked.title, /Undo “Import CSV”\?/);
  assert.match(asked.bodyHtml, /deletes 3 records this change added or brought back/);
  // One record's edit, even of several fields, does not ask.
  const edit = revision('r-edit', 'Edit Task', 'Data', 2);
  assert.equal(history.undoQuestion(edit, [operation('data.setField', 'a'), operation('data.setField', 'a')], false), null);
  assert.equal(history.undoMayAsk(revision('r-one', 'Edit Task', 'Data', 1)), false, 'a one-operation record edit reads the host before it acts');
  // More operations than the page held is a batch.
  assert.ok(history.undoQuestion(edit, [operation('data.setField', 'a')], true) !== null);
  const definition = history.undoQuestion(revision('r-field', 'Add <Mood> field', 'Definition', 1), [{ operationType: 'schema.addField', canonicalJson: '{}' }], false);
  assert.match(definition.title, /Undo “Add &lt;Mood&gt; field”\?/, 'the change is named unescaped');
  assert.match(definition.bodyHtml, /definition back as it was/);
  const code = history.undoQuestion(revision('r-pkg', 'Remove package Glance', 1, 3),
    [{ operationType: 'extension.removePackage', canonicalJson: '{}' }, { operationType: 'extension.removeFile', canonicalJson: '{}' }], false);
  assert.match(code.bodyHtml, /runs wherever its view is shown/);
});

test('WSP-05: History’s Undo on a batch opens the question, and Cancel sends nothing', async () => {
  openFile();
  page.state.view = 'history';
  page.state.history = [revision('r-import', 'Import CSV', 'Data', 3), revision('r-edit', 'Edit Task', 'Data', 1)];
  host.reply = (method) => method === 'history.operations'
    ? { items: [operation('data.createRecord', 'a'), operation('data.createRecord', 'b'), operation('data.createRecord', 'c')], nextCursor: null, changeSequence: 4 }
    : method === 'history.compensate' ? compensated : method === 'session.getSnapshot' ? page.state.session : { isValid: true, applications: [] };
  host.answer = false;
  await page.compensateRevision('r-import');
  assert.equal(host.questions.length, 1, 'undoing a batch of three created records asked nothing');
  assert.equal(host.calls.filter((call) => call.method === 'history.compensate').length, 0, 'Cancel still undid the batch');
  // One record's edit is undone at once, without a question.
  host.questions = [];
  await page.compensateRevision('r-edit');
  assert.equal(host.questions.length, 0, 'undoing one record’s edit asks');
  assert.equal(host.calls.filter((call) => call.method === 'history.compensate').length, 1);
});

// The independent review of the WSP-05 fix (2026-10-14).
test('WSP-05 review: the question counts only what it read, and says a package undo where it could read nothing', () => {
  const long = history.undoQuestion(revision('r-long', 'Edit Task', 'Data', 60), Array.from({ length: 50 }, () => operation('data.setField', 'a')), true);
  assert.doesNotMatch(long.bodyHtml, /more than/, `a single-record revision past the first page reads as more than it is: ${long.bodyHtml}`);
  assert.match(long.bodyHtml, /across at least 1 record\./);
  const unread = history.undoQuestion(revision('r-batch', 'Import CSV', 'Data', 3), [], true);
  assert.doesNotMatch(unread.bodyHtml, /0 records/, `a revision whose operations could not be read reads as touching 0 records: ${unread.bodyHtml}`);
  assert.match(unread.bodyHtml, /could not list which records/);
  const pkg = history.undoQuestion(revision('r-pkg', 'Remove package Glance', 'Definition', 3), [], true);
  assert.match(pkg.bodyHtml, /custom view code/, `an undo whose operations could not be read is not said to bring code back: ${pkg.bodyHtml}`);
  assert.match(history.undoQuestion(revision('r-look', 'Give the file a look', 'Definition', 1), [{ operationType: 'application.setLook', canonicalJson: '{}' }], false).bodyHtml, /look or purpose/);
});

test('WSP-05 review: a second press while the question is open is refused and said, and an undo turned away as busy says so', async () => {
  openFile();
  page.state.view = 'history';
  page.state.history = [revision('r-import', 'Import CSV', 'Data', 3)];
  const waiting = [];
  const release = () => waiting.splice(0).forEach((resolve) => resolve({ items: [operation('data.createRecord', 'a'), operation('data.createRecord', 'b')], nextCursor: null, changeSequence: 4 }));
  host.reply = (method) => method === 'history.operations' ? new Promise((resolve) => waiting.push(resolve)) : compensated;
  const first = page.compensateRevision('r-import');
  // The second press, given a moment: unguarded, it reads and waits on its own question.
  const second = page.compensateRevision('r-import');
  await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 50))]);
  assert.equal(host.calls.filter((call) => call.method === 'history.operations').length, 1, 'a second press read and asked again');
  assert.deepEqual(host.errors, ['Wait for the current action to finish, then try again.'], 'a second press was dropped without a word');
  // Another action starts while the question is open, and the person confirms.
  host.answer = true;
  host.onAsk = () => { page.state.actionInFlight = true; };
  release();
  await first;
  page.state.actionInFlight = false;
  await second;
  assert.equal(host.calls.filter((call) => call.method === 'history.compensate').length, 0);
  assert.deepEqual(host.errors.slice(1), ['Wait for the current action to finish, then try again. Nothing was undone.'], 'a confirmed undo turned away as busy said nothing');
});

test('WSP-25 review: the Look dialog stays open until the review opens, and says a refusal itself', () => {
  const view = source('file-actions.ts');
  assert.match(view, /\.then\(opened => \{\s*if \(opened\) \{ dialog\.close\(\); return; \}/, 'the Look dialog closes before it knows whether the review opened');
  assert.doesNotMatch(view, /dialog\.close\(\);\s*void prepareApplication/, 'the Look dialog still closes before the change is prepared');
  assert.match(view, /said\.textContent = state\.lastOutcome\?\.message/, 'a refusal is said behind the dialog, not in it');
});

test('WSP-18: a Studio change pressed while another action runs says so, and the header rename settles only once the review opens', async () => {
  openFile();
  page.state.actionInFlight = true;
  const opened = await page.prepareApplication({ actionLabel: 'Rename', applicationName: 'Task', proposalPayload: { proposalId: 'proposal-x' } }, 'data');
  page.state.actionInFlight = false;
  assert.equal(opened, false);
  assert.deepEqual(host.errors, ['Wait for the current action to finish, then try again.'], 'the press was dropped without a word');
  assert.equal(host.calls.length, 0);
  const header = source('studio-header.ts');
  assert.match(header, /void onRename\(name\)\.then\(opened => opened, \(\) => false\)\.then\(opened => \{/, 'the header settles before the rename is answered');
  assert.doesNotMatch(header, /settled = true;\s*onRename\(name\);/, 'the header still settles before onRename runs');
});

test('WSP-19: a change the host refuses on its copy is rejected there and said in the form, which stays', async () => {
  openFile();
  const invalid = { proposalId: 'proposal-bad', state: 'invalid', title: 'Add Status field', diagnostics: [{ code: 'label-conflict', severity: 'error', message: 'A field named Status already exists.', hint: 'Choose another name.' }],
    semanticDiff: [], previewApplications: [], operationCount: 1 };
  host.reply = (method) => method === 'proposal.prepareChangeSet' ? invalid : method === 'proposal.reject' ? { promotion: { applied: false }, session: null } : null;
  const opened = await page.prepareApplication({ actionLabel: 'Add field', applicationName: 'Task', proposalPayload: { proposalId: 'proposal-bad' } }, 'structure');
  assert.equal(opened, false, `a change the host refused opened a review nothing can accept (view ${page.state.view})`);
  assert.equal(page.state.view, 'structure', 'a refused change replaced the form with a review nothing can accept');
  assert.equal(page.state.proposal, null);
  assert.ok(host.calls.some((call) => call.method === 'proposal.reject' && call.payload.proposalId === 'proposal-bad'), 'the refused proposal is left in the host');
  assert.deepEqual(host.errors, ['A field named Status already exists. Choose another name. Nothing in the file changed.']);
  // A previewable one opens its review.
  openFile();
  host.reply = () => ({ ...invalid, state: 'previewable', diagnostics: [] });
  assert.equal(await page.prepareApplication({ actionLabel: 'Add field', applicationName: 'Task', proposalPayload: {} }, 'structure'), true);
  assert.equal(page.state.view, 'proposal');
});

test('WSP-22: Make required does not draw its form over a page the person moved to while it read', async () => {
  openFile();
  let release;
  host.reply = () => new Promise((resolve) => { release = resolve; });
  const drawing = page.renderFieldRequirement(task, 'task.status');
  // The person presses Use while the read runs.
  page.state.view = 'use';
  page.content.dataset.place = 'use|file-A';
  page.content.innerHTML = 'Use page';
  release({ items: [{ entityId: 'task', recordId: 'r1', recordVersion: 1, values: { 'task.title': 'One' } }], nextCursor: null, changeSequence: 4 });
  await drawing;
  assert.equal(page.content.innerHTML, 'Use page', 'the Make required form replaced the page the person moved to');
  // Where the person stayed, the form is drawn.
  openFile();
  host.reply = async () => ({ items: [{ entityId: 'task', recordId: 'r1', recordVersion: 1, values: { 'task.title': 'One' } }], nextCursor: null, changeSequence: 4 });
  await page.renderFieldRequirement(task, 'task.status');
  assert.match(page.content.innerHTML, /Make Status required/);
  assert.match(page.content.innerHTML, /<h3>One<\/h3>/);
});

test('WSP-11: completing the recipe reads the records without a Status from the file, not from the session', async () => {
  const session = { hasFile: true, uiNodes: [], records: [], entities: [{ entityId: 'entity.idea', displayName: 'Idea', fields: [] }] };
  const recipe = recipes.ideaGardenRecipe(session);
  assert.equal(recipe.actionLabel, 'Complete Idea Garden');
  assert.equal(typeof recipe.prepare, 'function', 'the recipe builds its backfill from session.records, which the desktop session never fills');
  const asked = [];
  const pages = { null: { items: [{ recordId: 'i1', recordVersion: 3, values: {} }], nextCursor: 'more' }, more: { items: [{ recordId: 'i2', recordVersion: 1, values: {} }], nextCursor: null } };
  // As the host: a filter on a field the record type does not have is refused.
  const host = (fieldIds) => async (query) => {
    asked.push(query);
    for (const filter of query.filters ?? [])
      if (!fieldIds.includes(filter.fieldId)) throw new Error('The filter field does not belong to this record type.');
    return { ...pages[String(query.cursor)], changeSequence: 1 };
  };
  // The finding's own case: the type exists without Status, which the recipe adds.
  const withoutStatus = await recipe.prepare(host([]));
  assert.ok(withoutStatus.mutations.some((mutation) => mutation.description === 'Place existing Ideas in the Idea group'),
    'existing records of a type the recipe adds Status to are left Ungrouped');
  assert.deepEqual(asked.map((query) => query.filters), [[], []]);
  asked.length = 0;
  const statusField = { fieldId: 'field.idea.status', displayName: 'Status', storageKind: 'text', required: false, presentation: 'singleChoice', options: ['Idea'] };
  const withStatus = recipes.ideaGardenRecipe({ ...session, entities: [{ ...session.entities[0], fields: [statusField] }] });
  const payload = await withStatus.prepare(host(['field.idea.status']));
  assert.deepEqual(asked.map((query) => query.filters), [[{ fieldId: 'field.idea.status', operator: 'isNull' }], [{ fieldId: 'field.idea.status', operator: 'isNull' }]]);
  const backfill = payload.mutations.find((mutation) => mutation.description === 'Place existing Ideas in the Idea group');
  assert.ok(backfill !== undefined, 'existing records without a Status are left Ungrouped');
  assert.deepEqual(backfill.operations.map((op) => [op.payload.recordId, op.payload.expectedRecordVersion, op.payload.value]), [['i1', 3, 'Idea'], ['i2', 1, 'Idea']]);
  assert.equal(recipes.ideaGardenRecipe({ ...session, entities: [] }).prepare, undefined, 'a new garden has nothing to read');
  assert.match(source('actions.ts'), /recipe\.prepare === undefined \? recipe\.proposalPayload/, 'prepareApplication does not let a recipe read the file');
});

test('WSP-14: Health says Approval needed while editing waits on approval, in the status pill’s words', () => {
  const trust = { requiresApproval: true, isApproved: false };
  const waiting = format.healthStatus({ health: 'normal', capabilities: { mutate: false }, behaviourTrust: trust, fileName: 'F.nendo' });
  assert.equal(waiting.label, 'Approval needed', `Health reads "${waiting.label}" while the pill says Approval needed`);
  assert.equal(waiting.healthy, false);
  assert.doesNotMatch(waiting.sentence, /saved as you work/);
  assert.equal(format.healthStatus({ health: 'normal', capabilities: { mutate: true }, behaviourTrust: { ...trust, isApproved: true }, fileName: 'F.nendo' }).label, 'Ready for editing');
  assert.match(source('view-health.ts'), /const status = healthStatus\(state\.session\);/, 'Health does not draw its chip from healthStatus');
  assert.match(source('main.ts'), /const awaitingApproval = approvalNeeded\(state\.session\);/, 'the status pill does not use the same condition');
});

test('WSP-23: help names Use’s picker as the screen does, and does not send the person to a type it leaves out', () => {
  const join = { entityId: 'link', displayName: 'Link', fields: [], retired: false };
  const entity = { entityId: 'task', displayName: 'Task', fields: [], retired: false };
  const plan = (id) => ({ entity: { semanticId: id }, surfaces: [] });
  const topics = help.helpTopics({ entities: [entity, join], applications: [plan('task'), plan('link')], fileName: 'F.nendo', pickerLabel: 'Showing', placeIds: ['task'] });
  const text = (id) => JSON.stringify(topics.find((topic) => topic.id === id));
  assert.match(text('entity:task'), /select Task in Showing/, 'help names a Record type picker the screen calls Showing');
  assert.doesNotMatch(text('entity:link'), /select Link in/, 'help sends the person to pick a type Use does not offer');
  assert.match(text('entity:link'), /Use does not list Link on its own/);
  const lanes = text('lanes');
  assert.match(lanes, /“Preview” in Studio’s review/, 'the lanes topic names a panel Studio heads Preview');
  assert.doesNotMatch(lanes, /stays unavailable until they are gone/, 'help says every diagnostic holds Accept back');
  assert.match(source('view-help.ts'), /pickerLabel: showingLabel\(\), placeIds: placePlans\(\)\.map\(plan => plan\.entity\.semanticId\)/);
});

test('WSP-25: Review change stays off while the letter box holds a refused letter, whatever colour is picked', () => {
  const current = { tone: 'amber', letter: 'N', toneChosen: false, letterChosen: false, defaultTone: 'amber', defaultLetter: 'N' };
  const teal = look.chosenLook(current, 'teal', 'N');
  assert.equal(look.lookReviewable(current, teal, 'N'), true);
  assert.equal(look.lookReviewable(current, teal, 'AB'), false, 'a colour picked after a refused letter enables Review with the old letter');
  assert.equal(look.lookReviewable(current, teal, ''), false);
  assert.match(source('file-actions.ts'), /review\.disabled = !lookReviewable\(look, proposed\(\), letterInput\.value\);/, 'the dialog’s redraw ignores the letter box');
});

test('WSP-09: a filter status reads a number by its digits, typed or stored', () => {
  const nameOf = (id) => ({ count: 'Count' })[id] ?? id;
  const query = { sortFieldId: null, descending: false, fieldId: 'count', operator: 'gt', text: '5', filters: [{ fieldId: 'count', operator: 'gt', value: { $nendoNumber: '5' } }] };
  assert.equal(columns.queryStatusText(query, nameOf), 'Only where Count is greater than 5 · across every record of this type');
  assert.equal(columns.queryStatusText({ ...query, text: '' }, nameOf), 'Only where Count is greater than 5 · across every record of this type',
    'a stored number with no typed text reads [object Object]');
});

test('WSP-19: the refusal says the host’s own words', () => {
  assert.equal(proposalMarkup.proposalRefusal({ diagnostics: [] }), 'The file refused this change. Nothing in the file changed.');
  assert.equal(proposalMarkup.proposalRefusal({ diagnostics: [{ message: 'No.', hint: '' }] }), 'No. Nothing in the file changed.');
});
