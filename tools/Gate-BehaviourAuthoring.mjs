import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';

// ADR-0008 blackbox gate. An external client authors calculations, a reusable
// function, an action and a trigger from an empty file through the local MCP
// interface alone — taking the definition body shapes off the wire rather than
// from this repository — and then finds out what it still cannot do.
//
// The interesting half is the refusals. Authoring an action is not permission to
// run one: the file becomes uneditable until the person at this device approves
// it, there is no MCP route to that approval, and a surface cannot sort by a
// calculated field. Each of those is checked from outside, against the real host.

const [port, processId, output, phase = 'author'] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, PID and output directory are required.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
let socket;
const pending = new Map();
const pageErrors = [];
let nextId = 0;

async function waitFor(read, label) {
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function connect() {
  const target = await waitFor(async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
      const matches = targets.filter(t => t.type === 'page' && t.url === 'https://app.nendo.local/index.html');
      return matches.length === 1 ? matches[0] : null;
    } catch { return null; }
  }, 'the owned local Workbench');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.text);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector) {
  await waitFor(async () => {
    const value = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e ? {disabled:!!e.disabled} : null; })()`);
    return value && !value.disabled ? value : null;
  }, `enabled ${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function ready() { await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'idle Workbench'); }
async function screenshot(name) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
}
async function record(name, value) {
  await fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2));
}

let fileSessionId = null;
async function host(method, payload = {}) {
  const request = { protocolVersion: 6, requestId: crypto.randomUUID(), method, payload, fileSessionId };
  const reply = await evaluate(`new Promise((resolve,reject)=>{
    const b=chrome.webview,request=${JSON.stringify(request)};
    const timer=setTimeout(()=>{b.removeEventListener('message',receive);reject(new Error('Owned host timeout'));},12000);
    function receive(e){let r=e.data;if(typeof r==='string')r=JSON.parse(r);if(r.requestId!==request.requestId)return;
      clearTimeout(timer);b.removeEventListener('message',receive);resolve(r);}
    b.addEventListener('message',receive);b.postMessage(request);
  })`);
  assert(reply.ok, `${method}: ${reply.error?.code} ${reply.error?.message ?? ''}`);
  if (reply.result?.fileSessionId) fileSessionId = reply.result.fileSessionId;
  return reply.result;
}
async function snapshot() { return host('session.getSnapshot'); }

/** The raw reply, so a diagnostic can report a refusal instead of throwing on it. */
async function hostOutcome(method, payload = {}) {
  const request = { protocolVersion: 6, requestId: crypto.randomUUID(), method, payload, fileSessionId };
  return evaluate(`new Promise((resolve)=>{
    const b=chrome.webview,request=${JSON.stringify(request)};
    const timer=setTimeout(()=>{b.removeEventListener('message',receive);resolve({timedOut:true});},12000);
    function receive(e){let r=e.data;if(typeof r==='string')r=JSON.parse(r);if(r.requestId!==request.requestId)return;
      clearTimeout(timer);b.removeEventListener('message',receive);resolve({ok:r.ok,error:r.error});}
    b.addEventListener('message',receive);b.postMessage(request);
  })`);
}

async function attachAgent(name) {
  const status = await host('agent.setMode', { mode: 'shapeApp' });
  assert(status.mode === 'shapeApp', `Agent authoring was not enabled: ${JSON.stringify(status)}`);
  const isolated = path.join(output, 'device-state', 'discovery');
  const root = await fs.access(isolated).then(() => isolated, () => path.join(process.env.LOCALAPPDATA, 'Nendo', 'Mcp', 'active'));
  const discovery = await waitFor(async () => {
    const entries = [];
    for (const file of (await fs.readdir(root)).filter(value => value.endsWith('.json'))) {
      try {
        const entry = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
        if (entry.processId === Number(processId)) entries.push(entry);
      } catch { /* a partially written discovery file */ }
    }
    assert(entries.length <= 1, 'Ambiguous owned MCP endpoint');
    return entries[0] ?? null;
  }, `owned MCP discovery for PID ${processId}`);
  return createNendoMcpClient(discovery, name);
}

/** The shared harness reports only that a tool was rejected; a gate needs the reason. */
function explainingTool(rpc) {
  return async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError) {
      const detail = (result.content ?? []).map(item => item.text).filter(Boolean).join(' | ');
      throw new Error(`MCP tool ${name} rejected: ${detail || JSON.stringify(result.structuredContent ?? {})}`);
    }
    return result.structuredContent;
  };
}

/** A call that is expected to be refused, returning the reason the agent is given. */
function refusalOf(rpc) {
  return async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert(result.isError, `${name} was expected to be refused.`);
    return (result.content ?? []).map(item => item.text).filter(Boolean).join(' | ');
  };
}

const read = async (rpc, uri) => JSON.parse((await rpc('resources/read', { uri })).contents[0].text);

/**
 * What a client can learn about calculations without reading this repository.
 * Everything the gate authors below is built from what this returns.
 */
async function discoverBehaviour(rpc) {
  const vocabulary = await read(rpc, 'nendo://application/vocabulary');
  await record('vocabulary.json', vocabulary);

  const behaviour = vocabulary.behaviour;
  assert(behaviour, 'The wire vocabulary describes no behaviour at all; an agent would have to guess every formula rule.');
  assert(behaviour.contractVersion, 'The behaviour catalogue names no contract version.');
  for (const name of ['RoundEven', 'Concat', 'TextLength'])
    assert((behaviour.functions ?? []).some(fn => fn.name === name), `The catalogue does not publish ${name}.`);
  for (const fn of behaviour.functions) {
    assert(fn.parameterTypes?.length > 0 && fn.resultType && fn.summary,
      `${fn.name} is published without the types or the sentence an author needs: ${JSON.stringify(fn)}`);
  }
  for (const kind of ['SameRecordField', 'SameRecordCalculation', 'ReferenceTraversal', 'RelatedAggregate'])
    assert((behaviour.bindings ?? []).some(binding => binding.kind === kind), `The catalogue does not publish the ${kind} binding.`);
  for (const aggregate of behaviour.aggregates ?? [])
    assert(aggregate.emptyRule && aggregate.missingValueRule,
      `${aggregate.aggregate} is published without saying what it does at the edges.`);
  assert((behaviour.operators ?? []).includes('?:'), 'The catalogue does not publish the operators a formula may use.');
  assert(behaviour.limits?.relatedRows > 0 && behaviour.limits?.generatedChanges > 0,
    'The catalogue publishes no ceilings, so an agent cannot plan against them.');

  const operations = (vocabulary.operations ?? []).map(entry => entry.operationType);
  for (const type of ['behaviour.setDefinition', 'behaviour.removeDefinition'])
    assert(operations.includes(type), `${type} is not in the published authoring union.`);
  const setDefinition = vocabulary.operations.find(entry => entry.operationType === 'behaviour.setDefinition');
  for (const field of ['definitionId', 'definitionKind', 'body'])
    assert(setDefinition.requiredPayload.includes(field), `behaviour.setDefinition does not publish ${field} as required.`);

  // A published payload field list is not a body shape. The examples resource is
  // where an agent learns what goes inside `body`, so it has to carry one.
  const examples = await read(rpc, 'nendo://application/examples');
  await record('examples.json', examples);
  const worked = (examples.examples ?? []).find(example =>
    example.mutations.some(mutation => mutation.operations.some(item => item.operationType === 'behaviour.setDefinition')));
  assert(worked, 'No published example authors a behaviour definition; an agent would have to invent the body shape.');
  assert(worked.notes?.length > 0, `${worked.name} carries no rule to learn from.`);
  return { behaviour, worked };
}

/** Sends one published example verbatim, keeping its mutation boundaries. */
async function sendExample(tool, owned, example) {
  const draft = await tool('nendo.change_set.begin', { ...owned, title: example.name, idempotencyKey: crypto.randomUUID() });
  const scoped = { ...owned, changeSetId: draft.changeSetId };
  for (const mutation of example.mutations) {
    await tool('nendo.change_set.add_operations', {
      ...scoped,
      mutations: [{ description: mutation.description, operations: mutation.operations }],
      idempotencyKey: crypto.randomUUID(),
    });
  }
  const validated = await tool('nendo.change_set.validate', { ...scoped, idempotencyKey: crypto.randomUUID() });
  assert(String(validated.state).toLowerCase() === 'previewable',
    `The published example did not validate against the host that published it: ${JSON.stringify(validated.diagnostics ?? validated)}`);
  // Reviewing is what the owner does next, so the preview is asked for the way a
  // client would ask for it.
  await tool('nendo.change_set.preview', scoped);
  return scoped;
}

async function changeSet(tool, owned, title, mutations) {
  const draft = await tool('nendo.change_set.begin', { ...owned, title, idempotencyKey: crypto.randomUUID() });
  const scoped = { ...owned, changeSetId: draft.changeSetId };
  for (const mutation of mutations) {
    await tool('nendo.change_set.add_operations', {
      ...scoped,
      mutations: [mutation],
      idempotencyKey: crypto.randomUUID(),
    });
  }
  const validated = await tool('nendo.change_set.validate', { ...scoped, idempotencyKey: crypto.randomUUID() });
  if (String(validated.state).toLowerCase() === 'previewable') await tool('nendo.change_set.preview', scoped);
  return { scoped, validated };
}

const accepted = new Set();

/**
 * Reviews and accepts the one proposal that is actually waiting.
 *
 * The card is matched by an ID this run has not accepted yet. The list is rendered
 * from a status read, so a card left over from the previous acceptance is briefly
 * indistinguishable from the new one — and clicking that stale card asks the host
 * for a proposal it has already promoted, which it declines without saying much.
 */
async function acceptInWorkbench(title) {
  await command('Page.reload'); await sleep(400); await ready(); await snapshot();
  await click('#nav-agent'); await ready();

  const proposalId = await waitFor(async () => {
    const cards = await evaluate(
      `[...document.querySelectorAll('[data-review-agent-proposal]')].map(e => e.dataset.reviewAgentProposal)`);
    return (cards ?? []).find(id => !accepted.has(id)) ?? null;
  }, `the ${title} proposal to appear for review`);

  await waitFor(async () => {
    await evaluate(`document.querySelector('[data-review-agent-proposal="${proposalId}"]')?.click()`);
    await ready();
    return evaluate(`!!document.querySelector('[data-testid="agent-proposal-review"]')`);
  }, `the ${title} review`).catch(async error => {
    await record(`review-missing-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`, {
      proposalId,
      page: await evaluate(`document.querySelector('#studio-content')?.textContent?.slice(0, 2000)`),
      message: await evaluate(`document.querySelector('.message-slot')?.textContent`),
      agentProposal: await hostOutcome('agent.getProposal', { proposalId }),
      renderer: pageErrors,
    });
    throw error;
  });

  const review = await evaluate(`document.querySelector('#studio-content').textContent`);
  assert(!review.includes('Unavailable'), `The review panel cannot describe ${title}: ${review.slice(0, 400)}`);
  await screenshot(`review-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
  await click('#accept-agent-proposal');
  await ready();
  accepted.add(proposalId);
}

/** Approves whatever the file is currently asking for, if it is asking. */
async function approveIfAsked() {
  await command('Page.reload'); await sleep(400); await ready(); await snapshot();
  await click('#nav-health'); await ready();
  const asking = await evaluate(
    `document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'false'`);
  if (!asking) return false;
  await click('#approve-behaviour'); await ready();
  assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'true'`),
    'Approving did not take effect.');
  return true;
}

const operation = (operationType, payload) => ({ operationType, payload });

/** The exact digits a number crossed the wire as, never a parsed JavaScript number. */
function lexeme(record, fieldId) {
  const result = (record.calculations ?? []).find(item => item.fieldId === fieldId);
  assert(result, `The record carries no result for ${fieldId}.`);
  assert(String(result.state).toLowerCase() === 'value',
    `${fieldId} is ${result.state}${result.errorCode ? ` (${result.errorCode})` : ''}, not a value.`);
  assert(result.numericLexeme !== null && result.numericLexeme !== undefined,
    `${fieldId} crossed the wire without exact digits: ${JSON.stringify(result)}`);
  return result.numericLexeme;
}

/**
 * One task pointing at the project. Its reference is version-checked, and the
 * project's version moves every time the trigger renames it — so the current
 * version is read rather than assumed.
 */
async function addTask(tool, owned, rpc, recordId, taskTitle, taskDone) {
  const current = await project(rpc);
  await tool('nendo.data.create_record', {
    ...owned,
    entityId: 'task',
    recordId,
    values: { taskTitle, taskDone, taskHours: 1, taskProject: 'project-1' },
    expectedTargetVersions: { taskProject: current.recordVersion },
    idempotencyKey: crypto.randomUUID(),
  });
}

async function project(rpc) {
  const page = await read(rpc, 'nendo://application/entity/project/records');
  return page.items[0];
}

async function authorAsAgent(client) {
  const { rpc } = client;
  const tool = explainingTool(rpc);
  const refused = refusalOf(rpc);
  await rpc('server/discover');

  const { worked } = await discoverBehaviour(rpc);

  // 1. Author the whole thing from the wire: the published example, verbatim.
  const lease = await tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    await sendExample(tool, owned, worked);
    await acceptInWorkbench(worked.name);

    // The record type publishes its calculated fields apart from its stored ones,
    // so a client knows they exist and knows nothing writes to them.
    const schema = await read(rpc, 'nendo://application/entity/project/schema');
    await record('schema.json', schema);
    const derived = (schema.derivedFields ?? []).map(field => field.fieldId).sort();
    assert(derived.join(',') === 'completion,doneCount,taskCount,totalHours',
      `The schema publishes ${derived.length} calculated fields, not the example's four: ${derived.join(', ')}`);
    for (const field of derived)
      assert(!(schema.fields ?? []).some(stored => stored.fieldId === field),
        `${field} is published as a stored field as well as a calculated one.`);
    assert((schema.derivedFields ?? []).every(field => field.expression?.length > 0),
      'A calculated field is published without the formula that produces it.');

    // 2. Authoring an action is not permission to run one.
    const blocked = await refused('nendo.data.create_record', {
      ...owned,
      entityId: 'project',
      recordId: 'project-blocked',
      values: { projectName: 'Written before anybody approved' },
      idempotencyKey: crypto.randomUUID(),
    });
    await record('refused-before-approval.json', { refusal: blocked });
    assert(blocked.includes('NENDO_BEHAVIOUR_NOT_APPROVED'),
      `The refusal does not name what is missing: ${blocked}`);

    // 3. And there is no MCP route to that approval: not a tool, not a resource.
    const tools = await rpc('tools/list');
    const resources = await rpc('resources/list');
    const surface = JSON.stringify(tools) + JSON.stringify(resources);
    for (const forbidden of ['behaviour.approve', 'behaviour.revoke', 'behaviourGrant', 'approveBehaviour', 'revocationGeneration'])
      assert(!surface.includes(forbidden), `The MCP surface names ${forbidden}, which must stay host-owned.`);
    await record('surface-counts.json', { tools: tools.tools.length, resources: resources.resources.length });

    // 4. A person approves, in the shell, on this device.
    await approveInWorkbench();
    await record('consent-is-per-behaviour.json', {
      note: 'Accepting a proposal that changes what a file\u2019s rules do withdraws the consent given for the old ones. ' +
        'Until it is given again the file is not editable, and a pending agent proposal cannot be opened for review.',
    });

    // 5. Now the same write lands, the trigger runs, and the results read back exactly.
    //    The example authors structure and rules but seeds no data, so the records
    //    below are the first thing in this file that any of it applies to.
    await tool('nendo.data.create_record', {
      ...owned, entityId: 'project', recordId: 'project-1',
      values: { projectName: 'Untitled' }, idempotencyKey: crypto.randomUUID(),
    });
    await addTask(tool, owned, rpc, 'task-1', 'Draw the thing', false);

    const created = await project(rpc);
    assert(created.values.projectStatus === 'Active',
      `The trigger did not run: the project's status is ${JSON.stringify(created.values.projectStatus)}.`);
    assert(lexeme(created, 'taskCount') === '1', `taskCount read ${lexeme(created, 'taskCount')}.`);
    assert(lexeme(created, 'doneCount') === '0', `doneCount read ${lexeme(created, 'doneCount')}.`);
    await record('after-create.json', created);

    // A third of a hundred is where a binary double stops being exact, so it is the
    // number worth carrying all the way back to a client.
    await addTask(tool, owned, rpc, 'task-2', 'Second', false);
    await addTask(tool, owned, rpc, 'task-3', 'Third', true);
    const thirds = await project(rpc);
    assert(lexeme(thirds, 'taskCount') === '3', `taskCount read ${lexeme(thirds, 'taskCount')}.`);
    assert(lexeme(thirds, 'doneCount') === '1', `doneCount read ${lexeme(thirds, 'doneCount')}.`);
    assert(lexeme(thirds, 'completion') === '33.33',
      `completion read ${lexeme(thirds, 'completion')}; a third of a hundred rounded to two places is 33.33.`);
    // The example's sum, over three tasks of one hour each: the key the review could
    // not find, working from the published change set as it stands.
    assert(lexeme(thirds, 'totalHours') === '3', `totalHours read ${lexeme(thirds, 'totalHours')}.`);
    await record('after-thirds.json', thirds);

    // 6. A surface may show a calculation and may not query by one.
    await assertASurfaceCannotSortByACalculation(tool, owned);
    await assertRefusalsNameWhatTheySaw(tool, refused, owned, rpc);
    await addVisibilityCalculation(tool, owned);
    await acceptInWorkbench('Whether there is work');
    // That proposal changed what the file's rules do, so the consent given for the
    // old ones no longer covers it. Until it is given again the file is not editable
    // — and a pending agent proposal cannot even be opened for review.
    assert(await approveIfAsked(),
      'Adding a calculation to an approved file did not ask the device about the new rules.');
    await authorConditionalSurface(tool, owned);
    await acceptInWorkbench('Project page');
    // A grant is bound to the whole definition revision, conservatively, so even a
    // change that alters no rule asks again. That is a real cost of the current
    // binding and it is recorded rather than hidden by the harness.
    const askedForASurface = await approveIfAsked();
    await record('consent-is-per-definition-revision.json', {
      askedAfterASurfaceOnlyChange: askedForASurface,
      note: askedForASurface
        ? 'A surface-only change re-asked for approval: the grant binds the whole definition revision, not only what the rules do.'
        : 'A surface-only change did not re-ask.',
    });

    const manifest = await read(rpc, 'nendo://application/manifest');
    await record('manifest.json', manifest);
    assert(manifest.minimumHostVersion === '1.18.0',
      `A surface whose visibility reads a calculation left the file at ${manifest.minimumHostVersion}.`);
  } finally {
    await tool('nendo.lease.release', owned).catch(() => { /* the lease may already be released */ });
  }
}

/** Consent is a shell route with no MCP equivalent, so the gate has to click it. */
async function approveInWorkbench() {
  // Whether an already-open window notices that the file it is showing now carries
  // automatic actions. Recorded rather than asserted: a person reaches the panel
  // either way, and what it costs them is one refresh.
  await click('#nav-health'); await ready();
  const noticedLive = await evaluate(`!!document.querySelector('[data-testid="behaviour-approval"]')`);
  await record('approval-panel-without-refresh.json', {
    appearedWithoutRefresh: noticedLive,
    note: noticedLive
      ? 'The open window offered approval as soon as the proposal was accepted.'
      : 'The open window offered approval only after a refresh; a person sees it on their next read of the file.',
  });
  if (!noticedLive) { await command('Page.reload'); await sleep(400); await ready(); await snapshot(); await click('#nav-health'); await ready(); }

  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="behaviour-approval"]')`), 'the approval panel');
  assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]').dataset.approved === 'false'`),
    'The file claims to be approved before anybody approved it.');
  const offer = await evaluate(`document.querySelector('[data-testid="behaviour-approval"]').textContent`);
  assert(/change records|add records/.test(offer),
    `The panel does not say what will happen to the owner's data: ${offer}`);
  await screenshot('approval-asked.png');
  await click('#approve-behaviour'); await ready();
  assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]').dataset.approved === 'true'`),
    'Approving did not take effect.');
  await screenshot('approval-given.png');
}

/**
 * Sorting is decided by the database over every matching record. A calculated
 * field has no column, so honouring it would mean ordering the loaded page and
 * calling it the collection's order.
 */
async function assertASurfaceCannotSortByACalculation(tool, owned) {
  const { scoped, validated } = await changeSet(tool, owned, 'Sort by a calculation', [{
    description: 'A list ordered by a calculated field',
    operations: [
      operation('ui.addNode', { surfaceId: 'probe', nodeId: 'probe-list', parentNodeId: null, kind: 'recordList', position: 0,
        properties: { definitionVersion: 3, entityId: 'project', title: 'Projects', orderByFieldId: 'taskCount' } }),
      operation('ui.addNode', { surfaceId: 'probe', nodeId: 'probe-name', parentNodeId: 'probe-list', kind: 'fieldBinding', position: 0,
        properties: { fieldId: 'projectName' } }),
    ],
  }]);
  assert(String(validated.state).toLowerCase() === 'invalid',
    `A list ordered by a calculated field validated: ${JSON.stringify(validated)}`);
  const diagnostic = (validated.diagnostics ?? []).find(item => item.code === 'NUI214');
  assert(diagnostic, `The refusal is ${JSON.stringify(validated.diagnostics)}, not its own code.`);
  assert(diagnostic.message.includes('taskCount') && /sort/i.test(diagnostic.message),
    `The refusal does not name the field or what it refuses: ${diagnostic.message}`);
  assert(/stored field/i.test(diagnostic.hint), `The refusal offers no remedy: ${diagnostic.hint}`);
  await record('refused-sort-by-calculation.json', diagnostic);
  await tool('nendo.change_set.reject', { ...scoped, idempotencyKey: crypto.randomUUID() });
}

/** A field shown only when a calculation says so: ADR-0008's growth consumer. */
/**
 * The 2026-09-13 review's four blind refusals, replayed against the real host. Each
 * read "The request arguments are invalid." and one of them froze the draft; the
 * reviewer guessed a sum's key three times and dropped the calculation. Each now
 * names the thing, and a wrong key costs one call rather than the draft.
 */
async function assertRefusalsNameWhatTheySaw(tool, refused, owned, rpc) {
  const findings = {};

  // A sum's field key, guessed as the review guessed it, then omitted, then right —
  // all on one draft, which holds exactly what was accepted.
  const begun = await tool('nendo.change_set.begin', { ...owned, title: 'Total the hours', idempotencyKey: crypto.randomUUID() });
  const scoped = { ...owned, changeSetId: begun.changeSetId };
  const sum = fieldKey => operation('behaviour.setDefinition', {
    definitionId: 'project.probeHours', definitionKind: 'Calculation',
    body: {
      entityId: 'project', fieldId: 'probeHours', displayName: 'Probe hours', resultType: 'Integer', resultNullable: false,
      expression: 'hours', callAliases: [],
      bindings: [{ bindingId: 'hours', kind: 'RelatedAggregate', aggregate: 'Sum', entityId: 'project', relatedEntityId: 'task',
        relatedReferenceFieldId: 'taskProject', resultType: 'Integer', nullable: false, ...fieldKey }],
    },
  });
  const add = operations => ({ ...scoped, mutations: [{ description: 'Total the hours', operations }], idempotencyKey: crypto.randomUUID() });
  findings.inventedKey = await refused('nendo.change_set.add_operations', add([sum({ aggregateFieldId: 'taskHours' })]));
  assert(/Mutation 0, operation 0/.test(findings.inventedKey) && /does not define: aggregateFieldId/.test(findings.inventedKey) &&
    /valueFieldId/.test(findings.inventedKey), `An invented binding key is not refused by name with the right ones: ${findings.inventedKey}`);
  findings.omittedKey = await refused('nendo.change_set.add_operations', add([sum({})]));
  assert(/needs valueFieldId/.test(findings.omittedKey) && /field it totals/.test(findings.omittedKey),
    `A missing binding key is not asked for by name: ${findings.omittedKey}`);
  const accepted = await tool('nendo.change_set.add_operations', add([sum({ valueFieldId: 'taskHours' })]));
  assert(accepted.mutationCount === 1, `Two refused adds cost the draft something: ${JSON.stringify(accepted)}`);
  const validated = await tool('nendo.change_set.validate', { ...scoped, idempotencyKey: crypto.randomUUID() });
  assert(String(validated.state).toLowerCase() === 'previewable',
    `The sum with the right key did not validate: ${JSON.stringify(validated.diagnostics)}`);
  await tool('nendo.change_set.reject', { ...scoped, idempotencyKey: crypto.randomUUID() });

  // A choice value that arrived with its quote characters inside it.
  const current = await project(rpc);
  findings.quotedChoice = await refused('nendo.data.set_field', { ...owned, entityId: 'project', recordId: current.recordId,
    fieldId: 'projectStatus', expectedRecordVersion: current.recordVersion, value: '"Active"', idempotencyKey: crypto.randomUUID() });
  assert(/projectStatus/.test(findings.quotedChoice) && /Idle, Active/.test(findings.quotedChoice) && /received "\\"Active\\""/.test(findings.quotedChoice),
    `A refused choice does not name the field, the choices and what arrived: ${findings.quotedChoice}`);

  // A create missing a required field names it.
  findings.missingRequired = await refused('nendo.data.create_record', { ...owned, entityId: 'task', recordId: 'task-probe-no-hours',
    values: { taskTitle: 'No hours', taskDone: false, taskProject: current.recordId },
    expectedTargetVersions: { taskProject: current.recordVersion }, idempotencyKey: crypto.randomUUID() });
  assert(/Required field taskHours/.test(findings.missingRequired), `A missing required field is not named: ${findings.missingRequired}`);

  // A delete blocked by references names the records that hold them.
  findings.referenced = await refused('nendo.data.delete_record', { ...owned, entityId: 'project', recordId: current.recordId,
    expectedRecordVersion: current.recordVersion, idempotencyKey: crypto.randomUUID() });
  assert(/NENDO_RECORD_REFERENCED/.test(findings.referenced) && /Task records? still points? at this one through Project \(/.test(findings.referenced),
    `A blocked delete does not name the referring records: ${findings.referenced}`);

  await record('refusals-name-what-they-saw.json', findings);
}

async function authorConditionalSurface(tool, owned) {
  const { validated } = await changeSet(tool, owned, 'Project page', [{
    description: 'Project page',
    operations: [
      operation('ui.addNode', { surfaceId: 'project-page', nodeId: 'project-form', parentNodeId: null, kind: 'recordForm', position: 0,
        properties: { definitionVersion: 3, entityId: 'project', title: 'Project' } }),
      operation('ui.addNode', { surfaceId: 'project-page', nodeId: 'project-name', parentNodeId: 'project-form', kind: 'fieldBinding', position: 0,
        properties: { fieldId: 'projectName' } }),
      operation('ui.addNode', { surfaceId: 'project-page', nodeId: 'project-completion', parentNodeId: 'project-form', kind: 'fieldBinding', position: 1,
        properties: { fieldId: 'completion' } }),
      operation('ui.addNode', { surfaceId: 'project-page', nodeId: 'project-busy', parentNodeId: 'project-form', kind: 'section', position: 2,
        properties: { title: 'While there is work', visibleWhen: 'hasWork' } }),
      operation('ui.addNode', { surfaceId: 'project-page', nodeId: 'project-tasks', parentNodeId: 'project-busy', kind: 'fieldBinding', position: 0,
        properties: { fieldId: 'taskCount' } }),
    ],
  }]);
  assert(String(validated.state).toLowerCase() === 'previewable',
    `The conditional surface did not validate: ${JSON.stringify(validated.diagnostics ?? validated)}`);
}

/** One more calculation, so the surface above has a yes-or-no answer to read. */
async function addVisibilityCalculation(tool, owned) {
  const { validated } = await changeSet(tool, owned, 'Whether there is work', [{
    description: 'Whether there is work',
    operations: [
      operation('behaviour.setDefinition', {
        definitionId: 'project.hasWork',
        definitionKind: 'Calculation',
        body: {
          entityId: 'project',
          fieldId: 'hasWork',
          displayName: 'Has work',
          resultType: 'Boolean',
          resultNullable: false,
          expression: 'total > 0',
          bindings: [{
            bindingId: 'total', kind: 'SameRecordCalculation', entityId: 'project',
            calculationId: 'project.taskCount', resultType: 'Integer', nullable: false,
          }],
          callAliases: [],
        },
      }),
    ],
  }]);
  assert(String(validated.state).toLowerCase() === 'previewable',
    `The visibility calculation did not validate: ${JSON.stringify(validated.diagnostics ?? validated)}`);
}

async function assertItStillRuns(label) {
  const current = await snapshot();
  const projects = current.entities.find(entity => entity.entityId === 'project');
  // The example's four, plus the visibility calculation the gate authored itself.
  assert((projects.derivedFields ?? []).length === 5,
    `${label}: the record type carries ${(projects.derivedFields ?? []).length} calculated fields, not five.`);
  const record = current.records.find(item => item.recordId?.startsWith('project'));
  const completion = (record.calculations ?? []).find(item => item.fieldId === 'completion');
  // The bridge may carry the state as its name or its ordinal, and zero is a value.
  assert(completion && (String(completion.state).toLowerCase() === 'value' || completion.state === 0),
    `${label}: completion is ${completion?.state}, not a value.`);
  assert(current.capabilities.mutate, `${label}: the remembered approval did not survive.`);
  const compiled = await host('semantic.compile');
  assert(compiled.isValid, `${label}: the surfaces no longer compile: ${JSON.stringify(compiled.diagnostics)}`);
}

try {
  await connect(); await command('Runtime.enable'); await ready();
  await snapshot();

  if (phase === 'author') {
    assert((await snapshot()).entities.length === 0, 'The gate must start from an empty file.');
    const client = await attachAgent('adr-0008-behaviour-gate');
    await authorAsAgent(client);
    await host('agent.setMode', { mode: 'off' });
    await command('Page.reload'); await sleep(400); await ready(); await snapshot();
    await assertItStillRuns('authored');
    await screenshot('authored.png');
  } else {
    const status = await host('agent.getStatus');
    assert(status.mode === 'off' || status.mode === 'disabled', `Agent access should be off after reopen, saw ${status.mode}.`);
    await assertItStillRuns('reopened');
    await screenshot('reopened.png');
  }

  assert(pageErrors.length === 0, `Renderer errors: ${pageErrors.join(' | ')}`);
  await record(`gate-${phase}.json`, {
    phase,
    result: 'passed',
    processId,
    claims: 'Calculations, a reusable function, an action and a trigger authored from an empty file through local MCP ' +
      'alone, with the definition body shapes taken off the wire. Approval and acceptance were clicked in the real ' +
      'Workbench because there is no MCP route to either. Not a clean-machine, human or accessibility test.',
  });
  console.log(`ADR-0008 behaviour gate ${phase} passed.`);
  process.exit(0);
} catch (error) {
  console.error(`ADR-0008 behaviour gate ${phase} failed: ${error.message}`);
  if (pageErrors.length > 0) console.error(`Renderer errors: ${pageErrors.join(' | ')}`);
  try { await screenshot(`failure-${phase}.png`); } catch { /* the page may be gone */ }
  process.exit(1);
}
