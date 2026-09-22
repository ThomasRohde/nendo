import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';

// P6-F: the Axiom Register gate. An external client builds the whole application
// from an empty file through the local MCP interface alone, discovering the
// surface vocabulary from the wire rather than from this repository. The owner
// reviews and accepts in the Workbench; this journey drives that click, which is
// reproducible evidence that the review surface works, not owner review itself.

const [port, processId, output, phase = 'build'] = process.argv.slice(2);
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
    if (message.method === 'Runtime.exceptionThrown') {
      // The text alone is "Uncaught" for a thrown Error, which names nothing. The
      // description carries the message and the stack, which is what a failure has
      // to hand back to be worth reading.
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description ?? details.text);
    }
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
/**
 * Click whatever an expression finds, once it is there and enabled to click.
 *
 * The finding and the clicking happen in one evaluated expression, which is the point.
 * Every step in this file used to write `document.querySelector('x').click()` and assume
 * the element was already there -- and where a step did wait first, it waited in one
 * round trip and clicked in the next, so the element could still go between them. Either
 * way the failure was `TypeError: Cannot read properties of null (reading 'click')`,
 * which names no selector, no step and no screen: F-056 cost a run to work out that it
 * was not a defect in the app at all.
 *
 * So this retries until something is there, and when nothing ever is, it says which
 * expression found nothing and what the page was showing instead.
 */
async function clickFound(finder, label = finder) {
  try {
    await waitFor(() => evaluate(`(() => { const e = (${finder});
      if (e === null || e === undefined || e.disabled) return false;
      e.click(); return true; })()`), `something to click for ${label}`);
  } catch (error) {
    // Read the page here rather than in the label: at the label it would cost a round
    // trip on every click that works, and describe the screen before the wait instead
    // of the screen the click never found anything on.
    throw new Error(`${error.message} Nothing enabled matched ${label}. On screen: ${await onScreen()}`);
  }
}

/** What the page is showing, for a click that never found its element. */
async function onScreen() {
  return evaluate(`(() => {
    const view = document.querySelector('.use-page, .overview-page, [data-testid="agent-proposal-review"], #studio-content');
    const surface = document.querySelector('[data-select-surface][aria-pressed="true"]')?.textContent ?? null;
    return JSON.stringify({view: view?.className ?? null, surface,
      busy: document.querySelector('#studio-content')?.getAttribute('aria-busy') ?? null});})()`)
    .catch(() => '(the page could not be read)');
}

async function click(selector) {
  await clickFound(`document.querySelector(${JSON.stringify(selector)})`, selector);
}
/**
 * A click the way a person makes one: a real pointer, which the page sees as a
 * pointerdown before the click.
 *
 * element.click() dispatches neither, so nothing in this file has ever exercised the
 * behaviour that depends on somebody having just touched the screen -- the hold that
 * stops a redraw landing under an open menu, and the quiet window after every click.
 * Every step here has been driving the app down a path a person cannot take.
 */
async function pointerClick(selector) {
  const at = await waitFor(() => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});
    if (e === null || e.disabled) return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)} : null; })()`),
    `a clickable ${selector}`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1, buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1, buttons: 0 });
}
async function ready() { await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'idle Workbench'); }
async function screenshot(name) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
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

async function attachAgent(name) {
  const status = await host('agent.setMode', { mode: 'shapeApp' });
  await fs.writeFile(path.join(output, 'agent-status.json'), JSON.stringify(status, null, 2));
  assert(status.mode === 'shapeApp', `Agent authoring was not enabled: ${JSON.stringify(status)}`);
  // An isolated run publishes discovery under its own device-state root rather
  // than the owner's real location, so the journey never reads the owner's.
  const isolated = path.join(output, 'device-state', 'discovery');
  const root = await fs.access(isolated).then(() => isolated, () => path.join(process.env.LOCALAPPDATA, 'Nendo', 'Mcp', 'active'));
  let seen = '';
  const discovery = await waitFor(async () => {
    const entries = [];
    for (const file of (await fs.readdir(root)).filter(value => value.endsWith('.json'))) {
      try {
        const entry = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
        if (entry.processId === Number(processId)) entries.push(entry);
      } catch { /* a partially written discovery file */ }
    }
    assert(entries.length <= 1, 'Ambiguous owned MCP endpoint');
    if (entries.length === 0) seen = (await fs.readdir(root)).join(', ');
    return entries[0] ?? null;
  }, `owned MCP discovery for PID ${processId}`).catch(error => {
    throw new Error(`${error.message} Discovery directory held: ${seen || '(nothing)'}.`);
  });
  return createNendoMcpClient(discovery, name);
}

// Nendo supplies operation IDs; a caller states only type and payload.
const operation = (operationType, payload) => ({ operationType, payload });

// Build the register through change sets. The host owns acceptance, so each of
// these ends at a preview the owner reviews. It also owns physical mapping: an
// agent names entities and fields semantically and never a table or a column.
// The shared harness reports only that a tool was rejected. A gate needs the
// reason, so call through the protocol and surface the content.
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

async function authorAsAgent(client, kinds) {
  const { rpc } = client;
  const tool = explainingTool(rpc);
  await rpc('server/discover');

  // Discoverability is the point: the vocabulary comes off the wire.
  const vocabulary = await rpc('resources/read', { uri: 'nendo://application/vocabulary' });
  const described = JSON.parse(vocabulary.contents[0].text);
  for (const kind of kinds)
    assert(described.kinds.some(entry => entry.kind === kind),
      `The wire vocabulary does not describe ${kind}; an agent would have to guess it.`);
  assert(described.aggregates.includes('count'), 'The wire vocabulary does not name an aggregate.');
  // The contextual rules an author cannot read off the flat kind table.
  assert(described.summaryScopes?.values?.includes('group') && described.summaryScopes.default === 'surface',
    'The wire vocabulary does not publish the summary scopes and their default.');
  assert(described.sectionOpens?.values?.includes('closed') && described.sectionOpens.default === 'open' &&
    described.kinds.find(kind => kind.kind === 'section')?.properties.includes('opens'),
    'The wire vocabulary does not publish how a section starts.');
  assert(described.effectiveFilters?.maximumClauses === 8 && (described.effectiveFilters.contexts ?? []).length > 0,
    'The wire vocabulary does not publish how a query composes against the filter ceiling.');
  const listRule = described.kinds.find(kind => kind.kind === 'recordList');
  assert(listRule.maxRootsPerEntity === 8 && listRule.children.includes('summaryTile'),
    `The wire vocabulary still describes one list root without totals: ${JSON.stringify(listRule)}`);
  assert(described.choiceTones?.values?.includes('teal') &&
    described.kinds.find(kind => kind.kind === 'detailSurface')?.properties.includes('accentFieldId') &&
    described.operations.find(op => op.operationType === 'schema.setChoiceMetadata')?.optionalPayload.includes('tone'),
    'The wire vocabulary does not publish the choice tones and the record-page header.');
  assert(described.operations.find(op => op.operationType === 'schema.addField')?.optionalPayload.includes('min') &&
    described.operations.find(op => op.operationType === 'schema.addField')?.optionalPayload.includes('max') &&
    described.propertyNotes?.min !== undefined,
    'The wire vocabulary does not publish a rating scale, so an author would have to guess its bounds.');
  assert(described.charts?.groupings?.includes('singleChoice') && described.charts.maximumGroups === 366 &&
    described.kinds.find(kind => kind.kind === 'recordList')?.children.includes('breakdownChart') &&
    described.kinds.find(kind => kind.kind === 'progressTile')?.children.includes('filterClause'),
    'The wire vocabulary does not publish the charts and their rules.');
  const overviewRule = described.kinds.find(kind => kind.kind === 'overviewSurface');
  assert(overviewRule?.maxRootsPerFile === 1 && overviewRule?.maxRootsPerEntity === null &&
    !overviewRule.properties.includes('entityId') && overviewRule.children.includes('recentList'),
    `The wire vocabulary does not describe the front page as belonging to the file: ${JSON.stringify(overviewRule)}`);
  assert(described.overview?.maximumRecentListRows === 10 && described.overview?.maximumRootsPerFile === 1 &&
    described.kinds.find(kind => kind.kind === 'summaryTile')?.properties.includes('entityId') &&
    described.propertyNotes?.limit !== undefined && described.propertyNotes?.description !== undefined,
    'The wire vocabulary does not publish the front page rules an author would otherwise have to guess.');
  await fs.writeFile(path.join(output, 'vocabulary.json'), JSON.stringify(described, null, 2));

  const lease = await tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    const structurePreview = await changeSet(tool, owned, 'Axiom register structure', [
      operation('schema.createEntity', { entityId: 'remit', displayName: 'Remit' }),
      operation('schema.addField', { entityId: 'remit', fieldId: 'remit-name', displayName: 'Name', storageKind: 'Text', required: true }),
      operation('schema.createEntity', { entityId: 'axiom', displayName: 'Axiom' }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-handle', displayName: 'Handle', storageKind: 'Text', required: true }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-statement', displayName: 'Statement', storageKind: 'Text', required: true, presentation: 'longText' }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-status', displayName: 'Status', storageKind: 'Text', required: false, presentation: 'singleChoice', options: ['Draft', 'Accepted', 'Superseded'] }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-domain', displayName: 'Domain', storageKind: 'Text', required: false, presentation: 'singleChoice', options: ['Storage', 'Interface', 'Process', 'Safety', 'Evidence'] }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-accepted', displayName: 'Accepted', storageKind: 'Date', required: false, presentation: 'date' }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-retired', displayName: 'Retired', storageKind: 'Date', required: false, presentation: 'date' }),
      // A rating carries both bounds with the field, because a scale cannot be added later.
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-confidence', displayName: 'Confidence', storageKind: 'Integer', required: false, presentation: 'rating', min: 1, max: 5 }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-remit', displayName: 'Remit', storageKind: 'Reference', required: false }),
      operation('schema.addField', { entityId: 'axiom', fieldId: 'axiom-supersedes', displayName: 'Supersedes', storageKind: 'Reference', required: false }),
      // The statuses carry tones, in the same mutation as the field they colour.
      operation('schema.setChoiceMetadata', { entityId: 'axiom', fieldId: 'axiom-status', choiceId: 'Draft', displayName: 'Draft', retired: false, tone: 'grey' }),
      operation('schema.setChoiceMetadata', { entityId: 'axiom', fieldId: 'axiom-status', choiceId: 'Accepted', displayName: 'Accepted', retired: false, tone: 'green' }),
      operation('schema.setChoiceMetadata', { entityId: 'axiom', fieldId: 'axiom-status', choiceId: 'Superseded', displayName: 'Superseded', retired: false, tone: 'orange' }),
    ]);
    // The rating scale is the newest shape this file carries, so the structure proposal
    // is where the minimum host rises, and the review has to say so as its own line
    // rather than fold a compatibility change into a list of fields.
    assert(structurePreview.semanticDiff.some(entry => entry.kind === 'raiseMinimumHostVersion'),
      `The structure proposal does not name its minimum-host raise: ${JSON.stringify(structurePreview.semanticDiff.map(entry => entry.kind))}`);
    await acceptInWorkbench('Axiom register structure');

    const definitionRevision = (await snapshot()).manifest.definitionRevision;
    await changeSet(tool, owned, 'Bind the register references', [
      operation('schema.configureReference', { entityId: 'axiom', fieldId: 'axiom-remit', targetEntityId: 'remit', labelFieldId: 'remit-name', expectedDefinitionRevision: definitionRevision }),
      // Both bindings sit in one definition-lane mutation, so both expect the
      // same revision. It advances per mutation, not per operation.
      operation('schema.configureReference', { entityId: 'axiom', fieldId: 'axiom-supersedes', targetEntityId: 'axiom', labelFieldId: 'axiom-handle', expectedDefinitionRevision: definitionRevision }),
    ]);
    await acceptInWorkbench('Bind the register references');

    await assertMaterializationDiagnosticNamesTheField(tool, owned);

    await changeSet(tool, owned, 'Register surfaces', surfaceOperations());
    await acceptInWorkbench('Register surfaces');

    // The timeline is its own proposal because the register's screens already fill a
    // change set to its 128-operation ceiling. It no longer raises the minimum host:
    // the rating in the structure proposal took the file past it.
    const timelinePreview = await changeSet(tool, owned, 'Register timeline', timelineOperations());
    assert(timelinePreview.semanticDiff.some(entry => /timeline/i.test(entry.summary ?? '')),
      `The timeline proposal does not describe itself: ${JSON.stringify(timelinePreview.semanticDiff.map(entry => entry.summary))}`);
    await acceptInWorkbench('Register timeline');

    const galleryPreview = await changeSet(tool, owned, 'Register gallery', galleryOperations());
    assert(galleryPreview.semanticDiff.some(entry => /gallery/i.test(entry.summary ?? '')),
      `The gallery proposal does not describe itself: ${JSON.stringify(galleryPreview.semanticDiff.map(entry => entry.summary))}`);
    await acceptInWorkbench('Register gallery');

    // Before the front page exists, because what the file is for does not depend on
    // having one. Everything here reads the value itself; nothing walks the node tree,
    // which has no node to find and would pass without ever looking.
    await assertTheFileSaysWhatItIsFor(rpc, tool, owned);

    // The front page is its own proposal for the reason the timeline and the
    // gallery are: the register's screens already fill a change set to its
    // 128-operation ceiling. It no longer raises the minimum host either — the
    // purpose above took the file past it — so the raise is asserted there, on
    // whichever rung this file reaches last.
    const overviewPreview = await changeSet(tool, owned, 'Register front page', overviewOperations());
    assert(overviewPreview.semanticDiff.some(entry => /front page/i.test(entry.summary ?? '')),
      `The front page proposal does not describe itself: ${JSON.stringify(overviewPreview.semanticDiff.map(entry => entry.summary))}`);
    // The proposal's own summary has to name the screen its diff is adding. It lists
    // surfaces per record type, and the front page belongs to none, so it was
    // reviewed as adding no screen at all while the diff said otherwise.
    assert((overviewPreview.preview?.surfaces ?? []).some(surface => surface.kind === 'overviewSurface'),
      `The proposal summary does not list the front page it adds: ${JSON.stringify((overviewPreview.preview?.surfaces ?? []).map(surface => surface.kind))}`);
    await acceptInWorkbench('Register front page');

    // The grids (S6), their own proposal for the reason the timeline, the gallery and the
    // front page are. This one does raise the minimum host, because it is the newest shape
    // the file carries, and the review has to say so as its own line.
    const gridPreview = await changeSet(tool, owned, 'Register grids', gridOperations());
    assert(gridPreview.semanticDiff.some(entry => /matrix/i.test(entry.summary ?? '')),
      `The grid proposal does not describe the matrix it adds: ${JSON.stringify(gridPreview.semanticDiff.map(entry => entry.summary))}`);
    assert(gridPreview.semanticDiff.some(entry => /rank/i.test(entry.summary ?? '')),
      `The grid proposal does not describe the ranking it adds: ${JSON.stringify(gridPreview.semanticDiff.map(entry => entry.summary))}`);
    assert(gridPreview.semanticDiff.some(entry => entry.kind === 'raiseMinimumHostVersion'),
      `The grid proposal does not name its minimum-host raise: ${JSON.stringify(gridPreview.semanticDiff.map(entry => entry.kind))}`);
    await acceptInWorkbench('Register grids');

    // The reference board (S7). Its own proposal for the reason every one above is, and
    // the last rung this file reaches, so this is where the minimum-host raise lands now.
    const boardPreview = await changeSet(tool, owned, 'Register board by remit', referenceBoardOperations());
    assert(boardPreview.semanticDiff.some(entry => /one column per/i.test(entry.summary ?? '')),
      `The board proposal does not say its columns are records: ${JSON.stringify(boardPreview.semanticDiff.map(entry => entry.summary))}`);
    assert(boardPreview.semanticDiff.some(entry => entry.kind === 'raiseMinimumHostVersion'),
      `The board proposal does not name its minimum-host raise: ${JSON.stringify(boardPreview.semanticDiff.map(entry => entry.kind))}`);
    await acceptInWorkbench('Register board by remit');

    // The folded sections (W-040). Their own proposal for the reason every one above
    // is, and now the last rung this file reaches: the raise lands here, and the line
    // that adds each section says how it starts.
    const foldPreview = await changeSet(tool, owned, 'Register folds', foldOperations());
    assert(foldPreview.semanticDiff.filter(entry => /starting closed\.$/.test(entry.summary ?? '')).length === 2,
      `The fold proposal does not say its sections start closed: ${JSON.stringify(foldPreview.semanticDiff.map(entry => entry.summary))}`);
    assert(foldPreview.semanticDiff.some(entry => entry.kind === 'raiseMinimumHostVersion'),
      `The fold proposal does not name its minimum-host raise: ${JSON.stringify(foldPreview.semanticDiff.map(entry => entry.kind))}`);
    await acceptInWorkbench('Register folds');

    // An agent must be able to read back what it just built. The surfaces
    // resource used to model four fixed contract version 2 slots, so this
    // application reported null for every screen while claiming to be valid.
    await assertSurfacesDescribeTheRegister(rpc);
  } finally {
    await tool('nendo.lease.release', owned).catch(() => { /* the lease may already be released */ });
  }
}

// A mutation is the materialization boundary for the definition lane. The refusal
// used to name neither the field nor a remedy, so the only way to find it in a
// seventy-operation proposal was to bisect.
async function assertMaterializationDiagnosticNamesTheField(tool, owned) {
  const draft = await tool('nendo.change_set.begin', { ...owned, title: 'Split entity and field', idempotencyKey: crypto.randomUUID() });
  const scoped = { ...owned, changeSetId: draft.changeSetId };
  await tool('nendo.change_set.add_operations', {
    ...scoped,
    mutations: [{ description: 'Create the record type', operations: [operation('schema.createEntity', { entityId: 'probe', displayName: 'Probe' })] }],
    idempotencyKey: crypto.randomUUID(),
  });
  await tool('nendo.change_set.add_operations', {
    ...scoped,
    mutations: [{ description: 'Add its required field', operations: [operation('schema.addField', { entityId: 'probe', fieldId: 'probe-name', displayName: 'Name', storageKind: 'Text', required: true })] }],
    idempotencyKey: crypto.randomUUID(),
  });
  const failed = await tool('nendo.change_set.validate', { ...scoped, idempotencyKey: crypto.randomUUID() });
  assert(String(failed.state).toLowerCase() === 'invalid', `The split draft validated; it should not: ${JSON.stringify(failed)}`);
  const diagnostic = failed.diagnostics[0];
  assert(diagnostic.code === 'NPROP004', `The materialization refusal is ${diagnostic.code}, not its own code.`);
  for (const expected of ['probe-name', 'probe', 'schema.createEntity', 'schema.setFieldRequired'])
    assert(diagnostic.message.includes(expected), `The refusal does not name ${expected}: ${diagnostic.message}`);

  // The draft survived the failure, so the remedy costs one amend.
  const amended = await tool('nendo.change_set.amend', {
    ...scoped,
    dropFromMutationOrdinal: 0,
    mutations: [{
      description: 'Create the record type with its field',
      operations: [
        operation('schema.createEntity', { entityId: 'probe', displayName: 'Probe' }),
        operation('schema.addField', { entityId: 'probe', fieldId: 'probe-name', displayName: 'Name', storageKind: 'Text', required: true }),
      ],
    }],
    idempotencyKey: crypto.randomUUID(),
  });
  assert(amended.mutationCount === 1, `The amend left ${amended.mutationCount} mutations, not one.`);
  const repaired = await tool('nendo.change_set.validate', { ...scoped, idempotencyKey: crypto.randomUUID() });
  assert(String(repaired.state).toLowerCase() === 'previewable', `The repaired draft did not validate: ${JSON.stringify(repaired)}`);
  await tool('nendo.change_set.reject', { ...scoped, idempotencyKey: crypto.randomUUID() });
}

async function assertSurfacesDescribeTheRegister(rpc) {
  const read = await rpc('resources/read', { uri: 'nendo://application/surfaces' });
  const surfaces = JSON.parse(read.contents[0].text);
  await fs.writeFile(path.join(output, 'surfaces.json'), JSON.stringify(surfaces, null, 2));
  assert(surfaces.state === 'valid', `The surfaces resource is ${surfaces.state}, not valid.`);
  assert(surfaces.contractVersion === 3, `The surfaces resource reports contract version ${surfaces.contractVersion}.`);
  const nodes = [];
  const walk = node => { nodes.push(node); (node.children ?? []).forEach(walk); };
  for (const app of surfaces.applications ?? []) (app.surfaces ?? []).forEach(walk);
  for (const kind of ['detailSurface', 'section', 'tabGroup', 'relatedList', 'summaryTile', 'breakdownChart', 'progressTile', 'recordList', 'boardSurface', 'calendarSurface', 'timelineSurface', 'gallerySurface', 'filterClause', 'recordCommand', 'commandStep'])
    assert(nodes.some(node => node.kind === kind), `The surfaces resource does not describe any ${kind}; an agent would read this file as having no screens.`);
  const command = nodes.find(node => node.kind === 'recordCommand');
  assert(command.commandId === 'axiom-accept',
    `The command ID an agent needs is ${command.commandId}, not the node it was authored as.`);
  // Two lists on one record type are the widened ceiling in use; a resource that
  // reported one would leave the second unaddressable. The two commands are one
  // root and one nested, which is the combination the widening has to keep
  // working: nesting was the old remedy and is still accepted.
  const roots = (surfaces.applications ?? []).flatMap(app => app.surfaces ?? []);
  assert(roots.filter(node => node.kind === 'recordList').length === 2,
    `The surfaces resource reports ${roots.filter(node => node.kind === 'recordList').length} recordList roots, not 2.`);
  const commands = nodes.filter(node => node.kind === 'recordCommand');
  assert(commands.length === 2, `The surfaces resource reports ${commands.length} commands, not 2.`);
  assert(roots.filter(node => node.kind === 'recordCommand').length === 1,
    'One command is a root and one is nested in the record page; both must be described.');
  for (const node of commands)
    assert(typeof node.commandId === 'string' && node.commandId.length > 0,
      `A command is described without the commandId execute_command takes: ${JSON.stringify(node)}`);
  assert(roots.some(node => node.kind === 'calendarSurface' && node.properties?.dateFieldId === 'axiom-accepted'),
    'The surfaces resource does not carry the calendar date binding.');
  assert(roots.some(node => node.kind === 'timelineSurface' && node.properties?.dateFieldId === 'axiom-accepted' && node.properties?.endDateFieldId === 'axiom-retired'),
    'The surfaces resource does not carry the timeline date bindings.');
  assert(roots.some(node => node.kind === 'gallerySurface' && node.properties?.titleFieldId === 'axiom-handle' && node.properties?.accentFieldId === 'axiom-status'),
    'The surfaces resource does not carry the gallery card bindings.');

  // The front page is not one of the record types' surfaces, so an agent that
  // authored one and looked for it among them would not find it. It is read back
  // from where it lives, with each tile still naming the type it reads.
  assert(!roots.some(node => node.kind === 'overviewSurface'),
    'The front page must not be reported as a record type surface; it belongs to the file.');
  const overview = surfaces.overview;
  assert(overview?.kind === 'overviewSurface' && !overview.entityId,
    `The surfaces resource does not carry the front page: ${JSON.stringify(overview)}`);
  const frontNodes = [];
  const walkFront = node => { frontNodes.push(node); (node.children ?? []).forEach(walkFront); };
  walkFront(overview);
  for (const kind of ['summaryTile', 'progressTile', 'breakdownChart', 'rangeTile', 'recentList'])
    assert(frontNodes.some(node => node.kind === kind && typeof node.entityId === 'string' && node.entityId.length > 0),
      `The front page does not describe a ${kind} naming the record type it reads.`);
  assert(frontNodes.some(node => node.kind === 'recentList' && node.entityId === 'remit'),
    'The front page reads only one record type, which is the one thing a front page is for.');
  assert(frontNodes.some(node => node.kind === 'rangeTile' && node.properties?.fieldId === 'axiom-accepted'),
    'The front page does not carry the range over a Date field.');
  // The ranking is a front-page tile, and the matrix is a root of its own: an agent
  // reading this file back has to find each where it lives.
  assert(frontNodes.some(node => node.kind === 'rankedList' && node.properties?.rankByFieldId === 'axiom-confidence'),
    'The front page does not carry the ranking by confidence.');
  const grid = nodes.find(node => node.kind === 'matrixSurface');
  assert(grid?.properties?.rowByFieldId === 'axiom-status' && grid?.properties?.columnByFieldId === 'axiom-domain',
    `The surfaces resource does not carry the matrix and its two axes: ${JSON.stringify(grid?.properties)}`);

  // A rating's scale is part of the field, so an agent reads it where it reads the
  // field: nothing has to be inferred from a value that happens to be stored.
  const schema = JSON.parse((await rpc('resources/read', { uri: 'nendo://application/entity/axiom/schema' })).contents[0].text);
  const confidence = (schema.fields ?? []).find(field => field.fieldId === 'axiom-confidence');
  assert(confidence?.presentation === 'rating' && confidence?.scale?.min === 1 && confidence?.scale?.max === 5,
    `The schema resource does not publish the rating scale: ${JSON.stringify(confidence)}`);
  const columnTile = nodes.find(node => node.kind === 'summaryTile' && node.properties?.scope === 'group');
  assert(columnTile, 'The surfaces resource does not carry the per-column scope.');

  // One read that answers the whole reconnaissance phase.
  const described = JSON.parse((await rpc('resources/read', { uri: 'nendo://application/describe' })).contents[0].text);
  assert(described.entities.some(entity => entity.entityId === 'axiom'),
    'The describe resource does not list the record types this agent created.');
  assert(described.limits.operationsPerChangeSet > 0,
    'The describe resource does not publish the limits an agent plans batches against.');
}

/**
 * What the file is for: authored over the wire, reviewed by a person, read back.
 *
 * Every assertion reads the value itself — the first key of describe, the summary's own
 * field, the rendered file menu. A purpose has no node and no record type, so the
 * surface-walking assertions the front page uses would run here and pass without ever
 * touching it, which is the same blindness that once reviewed a new front page as
 * adding no screen at all.
 */
async function assertTheFileSaysWhatItIsFor(rpc, tool, owned) {
  const purpose = 'Every axiom this project has accepted, and what still has to be proved.';
  const read = async () => JSON.parse((await rpc('resources/read', { uri: 'nendo://application/describe' })).contents[0].text);

  const before = await read();
  assert(Object.keys(before)[0] === 'purpose',
    `The describe resource does not lead with what the file is for: ${Object.keys(before).slice(0, 3).join(', ')}`);
  assert(before.purpose === null,
    `A file nobody has told already carries a purpose: ${JSON.stringify(before.purpose)}`);
  assert(!before.surfaces?.overview,
    'The front page exists already, so this proves nothing about a file without one.');

  // A file whose author has said nothing says so, rather than showing a blank panel or
  // something worked out from the file name.
  await click('#nav-use'); await ready();
  await clickFound(`(() => { const menu = document.querySelector('#file-menu'); if (menu) menu.open = true;
    return document.querySelector('#about-file'); })()`, 'About this file, in the File menu');
  const empty = await evaluate(`document.querySelector('.about-file-dialog')?.innerText ?? ''`);
  assert(/nobody has said/i.test(empty) && !empty.includes(purpose),
    `About does not say that nobody has said what this file is for: ${empty}`);
  await clickFound(`document.querySelector('.about-file-dialog [data-close]')`);

  const preview = await changeSet(tool, owned, 'Say what this file is for', [
    operation('application.setPurpose', { purpose }),
  ]);
  assert(preview.semanticDiff.some(entry => entry.kind === 'setApplicationPurpose' && (entry.summary ?? '').includes(purpose)),
    `The proposal does not say what it would make the file say: ${JSON.stringify(preview.semanticDiff.map(entry => entry.summary))}`);
  assert(preview.preview?.purposeAfter === purpose,
    `The proposal summary does not carry the purpose it sets: ${JSON.stringify(preview.preview?.purposeAfter)}`);
  // This is the newest rung the file reaches, so it is the one that has to say the file
  // stops opening in an older Nendo.
  assert(preview.semanticDiff.some(entry => entry.kind === 'raiseMinimumHostVersion'),
    `The purpose proposal does not name its minimum-host raise: ${JSON.stringify(preview.semanticDiff.map(entry => entry.kind))}`);
  assert((preview.preview?.surfaces ?? []).every(surface => surface.kind !== 'overviewSurface'),
    'This proposal must add no screen, or it is not proving what it claims to.');
  await acceptInWorkbench('Say what this file is for');

  const after = await read();
  assert(Object.keys(after)[0] === 'purpose' && after.purpose === purpose,
    `The file does not read back what it was told it is for: ${JSON.stringify(after.purpose)}`);
  assert(after.manifest?.purpose === purpose,
    `The manifest read does not carry the purpose: ${JSON.stringify(after.manifest?.purpose)}`);

  // And a person reads it where the file names itself, with no front page in the file.
  // From the menu rather than in it: prose belongs on a page, not above the actions
  // somebody opened the menu to reach.
  await click('#nav-use'); await ready();
  await clickFound(`(() => { const menu = document.querySelector('#file-menu'); if (menu) menu.open = true;
    return document.querySelector('#about-file'); })()`, 'About this file, in the File menu');
  const about = await evaluate(`document.querySelector('.about-file-dialog')?.innerText ?? ''`);
  assert(about.includes(purpose), `About does not say what the file is for: ${about}`);
  await screenshot('about-this-file.png');
  await clickFound(`document.querySelector('.about-file-dialog [data-close]')`);
  // The menu itself stays a list of actions.
  assert(await evaluate(`document.querySelector('.file-menu-purpose') === null`),
    'The purpose is back in the menu, where it pushed the actions off the bottom.');
}

async function changeSet(tool, owned, title, operations) {
  const draft = await tool('nendo.change_set.begin', { ...owned, title, idempotencyKey: crypto.randomUUID() });
  const scoped = { ...owned, changeSetId: draft.changeSetId };
  // At most sixteen operations per call, by the tool contract.
  for (let index = 0; index < operations.length; index += 16)
    await tool('nendo.change_set.add_operations', {
      ...scoped,
      mutations: [{ description: title, operations: operations.slice(index, index + 16) }],
      idempotencyKey: crypto.randomUUID(),
    });
  const validated = await tool('nendo.change_set.validate', { ...scoped, idempotencyKey: crypto.randomUUID() });
  assert(String(validated.state).toLowerCase() === 'previewable', `${title} did not validate: ${JSON.stringify(validated)}`);
  const preview = await tool('nendo.change_set.preview', scoped);
  assert(preview.semanticDiff?.length > 0, `${title} produced no reviewable diff.`);
  return preview;
}

// A relation, a page, a filtered list and a two-step command: the shapes the
// version 1 and 2 vocabulary could not express.
function surfaceOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    node('remit-page', null, 'detailSurface', 0),
    property('remit-page', 'definitionVersion', 3),
    property('remit-page', 'entityId', 'remit'),
    property('remit-page', 'title', 'Remit'),
    node('remit-scope', 'remit-page', 'section', 0),
    property('remit-scope', 'title', 'Scope'),
    node('remit-name-binding', 'remit-scope', 'fieldBinding', 0),
    property('remit-name-binding', 'fieldId', 'remit-name'),
    node('remit-axioms', 'remit-page', 'relatedList', 1),
    property('remit-axioms', 'targetEntityId', 'axiom'),
    property('remit-axioms', 'viaFieldId', 'axiom-remit'),
    property('remit-axioms', 'title', 'Axioms'),
    property('remit-axioms', 'orderByFieldId', 'axiom-handle'),
    property('remit-axioms', 'orderDirection', 'ascending'),
    node('remit-axiom-handle', 'remit-axioms', 'fieldBinding', 0),
    property('remit-axiom-handle', 'fieldId', 'axiom-handle'),
    node('remit-axiom-statement', 'remit-axioms', 'fieldBinding', 1),
    property('remit-axiom-statement', 'fieldId', 'axiom-statement'),
    node('remit-axiom-count', 'remit-axioms', 'summaryTile', 2),
    property('remit-axiom-count', 'aggregate', 'count'),
    property('remit-axiom-count', 'title', 'Axioms'),

    node('axiom-page', null, 'detailSurface', 1),
    property('axiom-page', 'definitionVersion', 3),
    property('axiom-page', 'entityId', 'axiom'),
    property('axiom-page', 'title', 'Axiom'),
    // The page header: the handle heads the page, the statement sits under it and
    // the status colours it.
    property('axiom-page', 'titleFieldId', 'axiom-handle'),
    property('axiom-page', 'subtitleFieldId', 'axiom-statement'),
    property('axiom-page', 'accentFieldId', 'axiom-status'),
    node('axiom-statement-section', 'axiom-page', 'section', 0),
    property('axiom-statement-section', 'title', 'Statement'),
    node('axiom-handle-binding', 'axiom-statement-section', 'fieldBinding', 0),
    property('axiom-handle-binding', 'fieldId', 'axiom-handle'),
    node('axiom-statement-binding', 'axiom-statement-section', 'fieldBinding', 1),
    property('axiom-statement-binding', 'fieldId', 'axiom-statement'),
    node('axiom-lineage', 'axiom-page', 'section', 1),
    property('axiom-lineage', 'title', 'Lineage'),
    node('axiom-superseded-by', 'axiom-lineage', 'relatedList', 0),
    property('axiom-superseded-by', 'targetEntityId', 'axiom'),
    property('axiom-superseded-by', 'viaFieldId', 'axiom-supersedes'),
    property('axiom-superseded-by', 'title', 'Superseded by'),
    node('axiom-superseded-handle', 'axiom-superseded-by', 'fieldBinding', 0),
    property('axiom-superseded-handle', 'fieldId', 'axiom-handle'),
    node('axiom-accept', 'axiom-page', 'recordCommand', 2),
    property('axiom-accept', 'definitionVersion', 3),
    property('axiom-accept', 'entityId', 'axiom'),
    property('axiom-accept', 'label', 'Accept'),
    node('axiom-accept-status', 'axiom-accept', 'commandStep', 0),
    property('axiom-accept-status', 'fieldId', 'axiom-status'),
    property('axiom-accept-status', 'valueKind', 'literal'),
    property('axiom-accept-status', 'value', 'Accepted'),
    node('axiom-accept-date', 'axiom-accept', 'commandStep', 1),
    property('axiom-accept-date', 'fieldId', 'axiom-accepted'),
    property('axiom-accept-date', 'valueKind', 'today'),

    node('axiom-open', null, 'recordList', 2),
    property('axiom-open', 'definitionVersion', 3),
    property('axiom-open', 'entityId', 'axiom'),
    property('axiom-open', 'title', 'Open axioms'),
    property('axiom-open', 'orderByFieldId', 'axiom-handle'),
    property('axiom-open', 'orderDirection', 'ascending'),
    node('axiom-open-handle', 'axiom-open', 'fieldBinding', 0),
    property('axiom-open-handle', 'fieldId', 'axiom-handle'),
    node('axiom-open-filter', 'axiom-open', 'filterClause', 1),
    property('axiom-open-filter', 'fieldId', 'axiom-status'),
    property('axiom-open-filter', 'operator', 'ne'),
    property('axiom-open-filter', 'value', 'Superseded'),
    // The total covers every open axiom, not the fifty a page loads.
    node('axiom-open-count', 'axiom-open', 'summaryTile', 2),
    property('axiom-open-count', 'aggregate', 'count'),
    property('axiom-open-count', 'title', 'Open axioms'),
    // A ring of the accepted axioms over the open ones: two exact counts.
    node('axiom-open-progress', 'axiom-open', 'progressTile', 3),
    property('axiom-open-progress', 'title', 'Accepted'),
    node('axiom-open-progress-clause', 'axiom-open-progress', 'filterClause', 0),
    property('axiom-open-progress-clause', 'fieldId', 'axiom-status'),
    property('axiom-open-progress-clause', 'operator', 'eq'),
    property('axiom-open-progress-clause', 'value', 'Accepted'),

    // A second list root on the same record type, which used to refuse.
    node('axiom-accepted-list', null, 'recordList', 3),
    property('axiom-accepted-list', 'definitionVersion', 3),
    property('axiom-accepted-list', 'entityId', 'axiom'),
    property('axiom-accepted-list', 'title', 'Accepted axioms'),
    node('axiom-accepted-handle', 'axiom-accepted-list', 'fieldBinding', 0),
    property('axiom-accepted-handle', 'fieldId', 'axiom-handle'),
    node('axiom-accepted-filter', 'axiom-accepted-list', 'filterClause', 1),
    property('axiom-accepted-filter', 'fieldId', 'axiom-status'),
    property('axiom-accepted-filter', 'operator', 'eq'),
    property('axiom-accepted-filter', 'value', 'Accepted'),

    // A board with a surface total and a per-column total.
    node('axiom-board', null, 'boardSurface', 4),
    property('axiom-board', 'definitionVersion', 3),
    property('axiom-board', 'entityId', 'axiom'),
    property('axiom-board', 'title', 'Axioms by status'),
    property('axiom-board', 'groupByFieldId', 'axiom-status'),
    node('axiom-board-handle', 'axiom-board', 'fieldBinding', 0),
    property('axiom-board-handle', 'fieldId', 'axiom-handle'),
    node('axiom-board-total', 'axiom-board', 'summaryTile', 1),
    property('axiom-board-total', 'aggregate', 'count'),
    property('axiom-board-total', 'title', 'All axioms'),
    node('axiom-board-column', 'axiom-board', 'summaryTile', 2),
    property('axiom-board-column', 'aggregate', 'count'),
    property('axiom-board-column', 'title', 'In this column'),
    property('axiom-board-column', 'scope', 'group'),
    // A breakdown of the whole board by status: one exact count per option, drawn
    // with the tones the statuses carry.
    node('axiom-board-breakdown', 'axiom-board', 'breakdownChart', 3),
    property('axiom-board-breakdown', 'groupByFieldId', 'axiom-status'),
    property('axiom-board-breakdown', 'aggregate', 'count'),
    property('axiom-board-breakdown', 'title', 'By status'),

    // A second command root, which used to need nesting to be accepted at all.
    node('axiom-supersede', null, 'recordCommand', 5),
    property('axiom-supersede', 'definitionVersion', 3),
    property('axiom-supersede', 'entityId', 'axiom'),
    property('axiom-supersede', 'label', 'Supersede'),
    node('axiom-supersede-status', 'axiom-supersede', 'commandStep', 0),
    property('axiom-supersede-status', 'fieldId', 'axiom-status'),
    property('axiom-supersede-status', 'valueKind', 'literal'),
    property('axiom-supersede-status', 'value', 'Superseded'),

    // Named tabs on the axiom page: each section of the group is one tab.
    node('axiom-tabs', 'axiom-page', 'tabGroup', 3),
    property('axiom-tabs', 'title', 'Axiom details'),
    node('axiom-tab-status', 'axiom-tabs', 'section', 0),
    property('axiom-tab-status', 'title', 'Status'),
    node('axiom-tab-status-binding', 'axiom-tab-status', 'fieldBinding', 0),
    property('axiom-tab-status-binding', 'fieldId', 'axiom-status'),
    node('axiom-tab-dates', 'axiom-tabs', 'section', 1),
    property('axiom-tab-dates', 'title', 'Dates'),
    node('axiom-tab-accepted-binding', 'axiom-tab-dates', 'fieldBinding', 0),
    property('axiom-tab-accepted-binding', 'fieldId', 'axiom-accepted'),

    // A Date calendar of the accepted date, with its own undated view.
    node('axiom-calendar', null, 'calendarSurface', 6),
    property('axiom-calendar', 'definitionVersion', 3),
    property('axiom-calendar', 'entityId', 'axiom'),
    property('axiom-calendar', 'title', 'Accepted dates'),
    property('axiom-calendar', 'dateFieldId', 'axiom-accepted'),
    node('axiom-calendar-handle', 'axiom-calendar', 'fieldBinding', 0),
    property('axiom-calendar-handle', 'fieldId', 'axiom-handle'),
  ];
}

// The timeline, as its own proposal: a change set holds at most 128 operations
// and the register's screens already fill one, and a raise of the minimum host
// then stands alone in its review rather than among sixty other lines.
function timelineOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    // A timeline of the accepted date, each axiom a span to its retired date,
    // titled by its handle and toned by its status.
    node('axiom-timeline', null, 'timelineSurface', 7),
    property('axiom-timeline', 'definitionVersion', 3),
    property('axiom-timeline', 'entityId', 'axiom'),
    property('axiom-timeline', 'title', 'Accepted over time'),
    property('axiom-timeline', 'dateFieldId', 'axiom-accepted'),
    property('axiom-timeline', 'endDateFieldId', 'axiom-retired'),
    property('axiom-timeline', 'titleFieldId', 'axiom-handle'),
    property('axiom-timeline', 'accentFieldId', 'axiom-status'),
    node('axiom-timeline-statement', 'axiom-timeline', 'fieldBinding', 0),
    property('axiom-timeline-statement', 'fieldId', 'axiom-statement'),
    // The axiom page's own reference control, under Lineage beside the relation that
    // reads the same field from the other end. It rides in this proposal because the
    // register's screens fill theirs to the ceiling, and a later proposal may add a node
    // to a page an earlier one made. W-050 is measured on it: a picker that is searched
    // and cancelled must leave nothing unsaved.
    node('axiom-supersedes-binding', 'axiom-lineage', 'fieldBinding', 1),
    property('axiom-supersedes-binding', 'fieldId', 'axiom-supersedes'),
  ];
}

// The gallery, as its own proposal for the same reason the timeline is one.
function galleryOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    // Cards over the same window the open list reads: titled by the handle, toned by
    // the status, and showing the confidence rating as dots.
    node('axiom-gallery', null, 'gallerySurface', 8),
    property('axiom-gallery', 'definitionVersion', 3),
    property('axiom-gallery', 'entityId', 'axiom'),
    property('axiom-gallery', 'title', 'Axiom cards'),
    property('axiom-gallery', 'titleFieldId', 'axiom-handle'),
    property('axiom-gallery', 'accentFieldId', 'axiom-status'),
    node('axiom-gallery-statement', 'axiom-gallery', 'fieldBinding', 0),
    property('axiom-gallery-statement', 'fieldId', 'axiom-statement'),
    node('axiom-gallery-confidence', 'axiom-gallery', 'fieldBinding', 1),
    property('axiom-gallery-confidence', 'fieldId', 'axiom-confidence'),
    // A gallery takes a list's totals, over every matching record rather than the
    // cards on screen.
    node('axiom-gallery-count', 'axiom-gallery', 'summaryTile', 2),
    property('axiom-gallery-count', 'aggregate', 'count'),
    property('axiom-gallery-count', 'title', 'Axioms'),

    // The rating on the record page too, beside the status it qualifies: a card shows
    // the dots, and this is where a person changes them. A later change set can bind a
    // field on a node an earlier one created, because nodes are addressed by stable ID.
    node('axiom-tab-confidence', 'axiom-tab-status', 'fieldBinding', 1),
    property('axiom-tab-confidence', 'fieldId', 'axiom-confidence'),
  ];
}

/**
 * The file's front page, as its own proposal. It reads both record types the
 * register has, because a front page over one would be a list with its totals on
 * top — and it is the two-type reading that no other surface in this file can do.
 */
function overviewOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    node('register-front', null, 'overviewSurface', 9),
    property('register-front', 'definitionVersion', 3),
    property('register-front', 'title', 'The register'),
    property('register-front', 'description', 'Every axiom this project has accepted, and the remits they belong to.'),
    // Each tile names the record type it reads: there is no surface entity here to
    // inherit one from, which is what makes this root different from every other.
    node('front-axiom-count', 'register-front', 'summaryTile', 0),
    property('front-axiom-count', 'entityId', 'axiom'),
    property('front-axiom-count', 'aggregate', 'count'),
    property('front-axiom-count', 'title', 'Axioms'),
    node('front-axiom-accepted', 'register-front', 'progressTile', 1),
    property('front-axiom-accepted', 'entityId', 'axiom'),
    property('front-axiom-accepted', 'title', 'Accepted'),
    node('front-axiom-accepted-clause', 'front-axiom-accepted', 'filterClause', 0),
    property('front-axiom-accepted-clause', 'fieldId', 'axiom-status'),
    property('front-axiom-accepted-clause', 'operator', 'eq'),
    property('front-axiom-accepted-clause', 'value', 'Accepted'),
    node('front-axiom-status', 'register-front', 'breakdownChart', 2),
    property('front-axiom-status', 'entityId', 'axiom'),
    property('front-axiom-status', 'aggregate', 'count'),
    property('front-axiom-status', 'groupByFieldId', 'axiom-status'),
    property('front-axiom-status', 'title', 'By status'),
    // A range over a Date: the one place min and max read one.
    node('front-axiom-dates', 'register-front', 'rangeTile', 3),
    property('front-axiom-dates', 'entityId', 'axiom'),
    property('front-axiom-dates', 'fieldId', 'axiom-accepted'),
    property('front-axiom-dates', 'title', 'Accepted between'),
    // Over time (S5). Both group by a civil date, and the register is the fixture
    // that makes the rule visible: one axiom is accepted, so exactly one month and
    // exactly one day carry anything. Every other bucket must still be drawn.
    node('front-axiom-trend', 'register-front', 'trendChart', 4),
    property('front-axiom-trend', 'entityId', 'axiom'),
    property('front-axiom-trend', 'dateFieldId', 'axiom-accepted'),
    property('front-axiom-trend', 'bucket', 'month'),
    property('front-axiom-trend', 'range', 'last12Months'),
    property('front-axiom-trend', 'aggregate', 'count'),
    property('front-axiom-trend', 'title', 'Accepted by month'),
    node('front-axiom-days', 'register-front', 'activityGrid', 5),
    property('front-axiom-days', 'entityId', 'axiom'),
    property('front-axiom-days', 'dateFieldId', 'axiom-accepted'),
    property('front-axiom-days', 'range', 'thisYear'),
    property('front-axiom-days', 'title', 'Accepted this year'),
    // The second record type, which no other surface in this file shows beside
    // the first.
    node('front-remits', 'register-front', 'recentList', 6),
    property('front-remits', 'entityId', 'remit'),
    property('front-remits', 'title', 'Remits'),
    property('front-remits', 'limit', 5),
    property('front-remits', 'orderByFieldId', 'remit-name'),
    node('front-remits-name', 'front-remits', 'fieldBinding', 0),
    property('front-remits-name', 'fieldId', 'remit-name'),
  ];
}

/**
 * The two grid kinds (S6). A matrix crossing the register's two choice fields, and a
 * ranking of the axioms that carry a confidence.
 *
 * The register is the fixture that makes both rules visible. Three axioms hold three
 * different status-and-domain pairs, so six of the nine cells are empty and must still be
 * drawn; one axiom has no domain, which is what puts something in the unset column while
 * the unset row stays empty and undrawn. One axiom carries a confidence, so a ranking of
 * three records has exactly one row.
 */
function gridOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    node('axiom-grid', null, 'matrixSurface', 10),
    property('axiom-grid', 'definitionVersion', 3),
    property('axiom-grid', 'entityId', 'axiom'),
    property('axiom-grid', 'title', 'Status against domain'),
    property('axiom-grid', 'rowByFieldId', 'axiom-status'),
    property('axiom-grid', 'columnByFieldId', 'axiom-domain'),
    node('axiom-grid-handle', 'axiom-grid', 'fieldBinding', 0),
    property('axiom-grid-handle', 'fieldId', 'axiom-handle'),
    node('axiom-grid-statement', 'axiom-grid', 'fieldBinding', 1),
    property('axiom-grid-statement', 'fieldId', 'axiom-statement'),
    // On the front page, where a ranking lives: a recentList's neighbour rather than a
    // root of its own.
    node('front-axiom-confident', 'register-front', 'rankedList', 7),
    property('front-axiom-confident', 'entityId', 'axiom'),
    property('front-axiom-confident', 'rankByFieldId', 'axiom-confidence'),
    property('front-axiom-confident', 'orderDirection', 'descending'),
    property('front-axiom-confident', 'limit', 5),
    property('front-axiom-confident', 'title', 'Most confident'),
    node('front-axiom-confident-handle', 'front-axiom-confident', 'fieldBinding', 0),
    property('front-axiom-confident-handle', 'fieldId', 'axiom-handle'),
  ];
}

/**
 * A board whose columns are records (S7), over the reference the register already has.
 *
 * Nothing about the board is new except where its columns come from, which is the whole
 * slice: the same kind, the same bindings, the same group-scoped total. What it proves is
 * that the lanes are read from the Remit record type rather than taken from a field.
 */
// The two sections that start closed (ADR-0004, 2026-09-20 amendment; W-040), their own
// proposal because they are the last rung this file reaches and the review has to say
// so. Each holds the one tile on its page that counts remits, which is what lets the
// fold step tell a read the fold saved from every other read on the page.
function foldOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    node('front-lately', 'register-front', 'section', 7),
    property('front-lately', 'title', 'Lately'),
    property('front-lately', 'opens', 'closed'),
    node('front-remit-count', 'front-lately', 'summaryTile', 0),
    property('front-remit-count', 'entityId', 'remit'),
    property('front-remit-count', 'aggregate', 'count'),
    property('front-remit-count', 'title', 'Remits'),
    node('remit-more', 'remit-page', 'section', 2),
    property('remit-more', 'title', 'More'),
    property('remit-more', 'opens', 'closed'),
    node('remit-more-count', 'remit-more', 'summaryTile', 0),
    property('remit-more-count', 'aggregate', 'count'),
    property('remit-more-count', 'title', 'Remits on file'),
  ];
}

function referenceBoardOperations() {
  const surface = 'register';
  const node = (nodeId, parentNodeId, kind, position) => operation('ui.addNode', { surfaceId: surface, nodeId, parentNodeId, kind, position });
  const property = (nodeId, propertyName, value) => operation('ui.setProperty', { surfaceId: surface, nodeId, propertyName, value });
  return [
    node('axiom-remit-board', null, 'boardSurface', 11),
    property('axiom-remit-board', 'definitionVersion', 3),
    property('axiom-remit-board', 'entityId', 'axiom'),
    property('axiom-remit-board', 'title', 'Axioms by remit'),
    property('axiom-remit-board', 'groupByFieldId', 'axiom-remit'),
    property('axiom-remit-board', 'orderByFieldId', 'axiom-handle'),
    property('axiom-remit-board', 'orderDirection', 'ascending'),
    node('axiom-remit-board-handle', 'axiom-remit-board', 'fieldBinding', 0),
    property('axiom-remit-board-handle', 'fieldId', 'axiom-handle'),
    node('axiom-remit-board-status', 'axiom-remit-board', 'fieldBinding', 1),
    property('axiom-remit-board-status', 'fieldId', 'axiom-status'),
    // One exact number per lane, over everything the board covers rather than over the
    // page in view. The column predicate is an eq on a reference field, which is the one
    // way a reference lane differs from an option lane here.
    node('axiom-remit-board-count', 'axiom-remit-board', 'summaryTile', 2),
    property('axiom-remit-board-count', 'title', 'Axioms'),
    property('axiom-remit-board-count', 'aggregate', 'count'),
    property('axiom-remit-board-count', 'scope', 'group'),
  ];
}

// The owner gate. A scripted click proves the review surface works; it is not
// owner review, which stays a human act.
async function acceptInWorkbench(title) {
  await click('#nav-agent'); await ready();

  // The proposal waits in Agent until a person opens it. Nothing an agent does
  // reaches the file until that happens.
  await waitFor(() => evaluate(`!!document.querySelector('[data-review-agent-proposal]')`), `the ${title} proposal to appear for review`);
  const pending = await evaluate(`document.querySelector('.pending-changes')?.textContent`);
  assert(pending.includes(title), `Agent does not list ${title} as pending: ${pending}`);
  await clickFound(`document.querySelector('[data-review-agent-proposal]')`);
  await ready();

  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="agent-proposal-review"]')`), `the ${title} review`);
  const review = await evaluate(`document.querySelector('#studio-content').textContent`);
  assert(review.includes(title), `The review does not name ${title}.`);
  // The panel used to project four contract version 2 slots, so a version 3
  // proposal asked a person to approve changes it could only label "Unavailable".
  assert(!review.includes('Unavailable'),
    `The review panel cannot describe ${title}: ${review.slice(0, 400)}`);

  // The answer to "will you accept this?" is on screen with the question. The summary
  // column lists every record type and every screen, so on a real file the button used to
  // sit a screen and a half below the fold and had to be scrolled for.
  const acceptPlacement = await evaluate(`(()=>{const button=document.querySelector('#accept-agent-proposal');
    if (button === null) return null;
    const box=button.getBoundingClientRect();
    return {bottom:Math.round(box.bottom), top:Math.round(box.top), viewport:window.innerHeight,
      scrolled:Math.round(document.querySelector('#studio-content')?.scrollTop ?? 0)};})()`);
  assert(acceptPlacement !== null, `The ${title} review has no accept button.`);
  assert(acceptPlacement.scrolled === 0,
    `The review opened already scrolled, so this proves nothing about the button (${title}): ${JSON.stringify(acceptPlacement)}`);
  assert(acceptPlacement.bottom <= acceptPlacement.viewport && acceptPlacement.top >= 0,
    `Accepting ${title} means scrolling to find the button: ${JSON.stringify(acceptPlacement)}`);
  // The surfaces panel lists each screen by its own title, so the person is not
  // approving a count of unnamed changes.
  if (title === 'Register surfaces')
    for (const surface of ['Open axioms', 'Accepted axioms', 'Axioms by status', 'Accepted dates', 'Record page', 'Action'])
      assert(review.includes(surface), `The review panel does not list ${surface}: ${review.slice(0, 600)}`);
  if (title === 'Register timeline')
    assert(review.includes('Accepted over time'), `The review panel does not list the timeline: ${review.slice(0, 600)}`);
  if (title === 'Register gallery')
    assert(review.includes('Axiom cards'), `The review panel does not list the gallery: ${review.slice(0, 600)}`);
  if (title === 'Register front page')
    assert(review.includes('The register'), `The review panel does not list the front page: ${review.slice(0, 600)}`);
  // A proposal that only says what the file is for adds no screen, so the panel has to
  // name it: otherwise a person reads "changes structure and data only" about a change
  // that is neither.
  if (title === 'Say what this file is for') {
    assert(review.includes('What this file is for'),
      `The review panel does not name the purpose it is approving: ${review.slice(0, 600)}`);
    assert(!review.includes('structure and data only'),
      `The review panel describes a purpose change as structure and data: ${review.slice(0, 600)}`);
  }
  await screenshot(`review-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
  await click('#accept-agent-proposal');
  await ready();

  // What happened, where a person can read it. The outcome went to a visually hidden
  // announcement region and nowhere else, so accepting made the panel disappear and told
  // a sighted person nothing at all: the owner sat waiting for a screen that was already
  // there, behind a picker nothing had mentioned.
  // A timeout here says only that the outcome never appeared, which is true of an
  // acceptance that failed, one that never started, and one whose message was drawn and
  // taken away again. F-056: the failure states what the screen held instead, so the next
  // occurrence is diagnosable from its own output rather than from another run.
  const outcome = await waitFor(() => evaluate(`(()=>{const slot=document.querySelector('.message-slot');
    return slot === null || slot.hidden ? null : {text:slot.textContent, done:slot.classList.contains('is-done'), role:slot.getAttribute('role')};})()`),
    `the outcome of accepting ${title}`).catch(async error => {
      const state = await evaluate(`(()=>({
        slots:[...document.querySelectorAll('.message-slot')].map(s=>({hidden:s.hidden, cls:s.className, text:s.textContent.slice(0,120)})),
        pending:document.querySelector('.pending-changes')?.textContent?.slice(0,200) ?? null,
        review:!!document.querySelector('[data-testid="agent-proposal-review"]'),
        accept:(()=>{const b=document.querySelector('#accept-agent-proposal'); return b===null?null:{disabled:b.disabled};})(),
        view:document.querySelector('.use-page')?'use':document.querySelector('.overview-page')?'overview':'other',
        busy:document.querySelector('#studio-content')?.getAttribute('aria-busy')}))()`);
      throw new Error(`${error.message} STATE ${JSON.stringify(state)}`);
    });
  assert(outcome.text.includes(title),
    `Accepting ${title} says nothing a person can see about which proposal it was: ${JSON.stringify(outcome)}`);
  assert(outcome.done && outcome.role === 'status',
    `A finished acceptance is drawn as a failure: ${JSON.stringify(outcome)}`);
  // And it is still there a moment later. The Agent page refreshes itself every three
  // seconds, and that refresh used to rebuild the page through the raw renderer, which
  // hands back an empty message slot -- so this message lasted until the next tick and
  // then the screen said nothing, with nobody having touched it. Waiting past one tick is
  // what makes that deterministic; before, it surfaced as the outcome never arriving at
  // all, about two runs in five, and read as a flake (F-056, F-057).
  await sleep(4000);
  const survived = await evaluate(`(()=>{const slot=document.querySelector('.message-slot');
    return slot === null || slot.hidden ? null : slot.textContent;})()`);
  assert(survived !== null && survived.includes(title),
    `The outcome of accepting ${title} was gone within four seconds, without anything being touched: ${JSON.stringify(survived)}`);
  // And where it went, for the one proposal here that adds a screen a person opens.
  if (title === 'Register grids')
    assert(/Status against domain, under View in Axiom, is new\./.test(outcome.text),
      `Accepting a proposal that adds a screen does not say where the screen is: ${JSON.stringify(outcome)}`);
}

/**
 * The reference board before a single record of its target type exists (W-042, F-060).
 *
 * It has to run here, in the one window between the surfaces being accepted and
 * seedRecords making the first Remit: every other step of this gate draws a board whose
 * target type has two records in it, which is exactly why the zero-column path had never
 * been rendered by anything and the defect reached a person instead.
 *
 * What was wrong: the board drew the Ungrouped lane and nothing else, explaining nothing,
 * while that lane read "Move a card to a named column to assign it." on a board with no
 * named column to move one to.
 */
async function assertAnEmptyTargetTypeExplainsItself() {
  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='axiom'){s.value='axiom';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`document.querySelector('[data-select-surface="axiom-remit-board"]')`); await ready();

  const drawn = await waitFor(async () => {
    const seen = await evaluate(`(()=>{
      const note = document.querySelector('.record-board') === null ? null : (document.querySelector('.surface-empty')?.textContent ?? '');
      if (note === null) return null;
      return { note, lane: document.querySelector('[data-group-ungrouped] .empty-column')?.textContent ?? null,
        named: document.querySelectorAll('.board-column[data-group]').length };
    })()`);
    return seen;
  }, 'the board by remit before any remit exists');

  // It names the record type and says the columns are absent rather than leaving a
  // nameless lane to stand for a screen that might equally be broken or misconfigured.
  assert(drawn.note.includes('Remit') && drawn.note.includes('no columns'),
    `A board over an empty record type explains nothing: ${JSON.stringify(drawn)}`);
  assert(drawn.named === 0, `The board drew ${drawn.named} named columns over an empty Remit type.`);
  // And the lane withdraws the instruction it cannot honour. This is the half a person
  // actually read, and the half that would pass every assertion this gate had.
  assert(drawn.lane !== null && !drawn.lane.includes('Move a card to a named column'),
    `The Ungrouped lane still advises moving a card to a column that does not exist: ${JSON.stringify(drawn.lane)}`);
  assert(drawn.lane.includes('no named column to move a card to'),
    `The Ungrouped lane does not say why there is nowhere to move a card: ${JSON.stringify(drawn.lane)}`);
  await screenshot('reference-board-empty-target.png');
}

async function seedRecords(client) {
  const { rpc } = client;
  const tool = explainingTool(rpc);
  const lease = await tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    const remitId = crypto.randomUUID();
    const created = await tool('nendo.data.create_record', { ...owned, entityId: 'remit', recordId: remitId, values: { 'remit-name': 'Data' }, idempotencyKey: crypto.randomUUID() });
    // A second remit that no axiom points at. It is the one record in this file that
    // exists to be empty: a reference board draws every record of the target type, so an
    // unused remit is a lane with nothing in it, and a board that showed only the remits
    // in use would look entirely reasonable and be drawing a different rule.
    await tool('nendo.data.create_record', { ...owned, entityId: 'remit', recordId: crypto.randomUUID(), values: { 'remit-name': 'Interfaces' }, idempotencyKey: crypto.randomUUID() });
    // Read the target back over MCP rather than out of the renderer snapshot.
    // This gate used to take the version it needed from the host, which is the
    // shortcut the review had to take for real: it built a whole application
    // through this interface and then opened the SQLite file to check its own
    // writes, because resources/list returns no templated URI and nothing else
    // named one.
    const remit = await readRecord(rpc, 'remit', remitId);
    assert(remit.recordVersion === created.recordVersion,
      `The records resource reports version ${remit.recordVersion}; create_record reported ${created.recordVersion}.`);
    const axioms = [];
    for (const [handle, status, domain] of [
      ['DATA-01', 'Draft', 'Storage'], ['DATA-02', 'Superseded', 'Interface'], ['DATA-03', 'Draft', null]]) {
      const recordId = crypto.randomUUID();
      axioms.push(recordId);
      await tool('nendo.data.create_record', {
        ...owned, entityId: 'axiom', recordId,
        values: { 'axiom-handle': handle, 'axiom-statement': `Statement for ${handle}, written at the length a real one runs to so that a card has something to wrap and a column has a reason to want width.`, 'axiom-status': status, 'axiom-remit': remitId,
          ...(domain === null ? {} : { 'axiom-domain': domain }),
          ...(handle === 'DATA-01' ? { 'axiom-confidence': 4 } : {}) },
        expectedTargetVersions: { 'axiom-remit': remit.recordVersion },
        idempotencyKey: crypto.randomUUID(),
      });
    }
    await assertTheButtonDidWhatItSaid(rpc, tool, owned, axioms[0]);
  } finally {
    await tool('nendo.lease.release', owned).catch(() => { /* already released */ });
  }
}

// The path for reading records back is a URI template, so resources/list does not
// return it. describe names every resource this host serves, templates included.
async function recordsUri(rpc, entityId) {
  const described = JSON.parse((await rpc('resources/read', { uri: 'nendo://application/describe' })).contents[0].text);
  const read = (described.reads ?? []).find(entry => entry.uri.includes('/records'));
  assert(read, 'The describe resource does not name the path for reading records back.');
  return read.uri.replace('{entityId}', encodeURIComponent(entityId)).replace(/\{\?[^}]*\}$/, '');
}

async function readRecord(rpc, entityId, recordId) {
  const uri = `${await recordsUri(rpc, entityId)}?limit=100`;
  const page = JSON.parse((await rpc('resources/read', { uri })).contents[0].text);
  const record = (page.items ?? []).find(item => item.recordId === recordId);
  assert(record, `The records resource does not carry ${recordId}, which this agent just wrote.`);
  return record;
}

// Accept sets a status and a date, so it advances the record by two versions.
// execute_command used to report null, which left the next optimistic write with
// nothing to pin to and no read path to recover from.
async function assertTheButtonDidWhatItSaid(rpc, tool, owned, recordId) {
  const before = await readRecord(rpc, 'axiom', recordId);
  const commanded = await tool('nendo.data.execute_command', {
    ...owned,
    commandId: 'axiom-accept',
    recordId,
    expectedRecordVersion: before.recordVersion,
    idempotencyKey: crypto.randomUUID(),
  });
  assert(commanded.recordVersion === before.recordVersion + 2,
    `The two-step Accept reported version ${commanded.recordVersion}, not ${before.recordVersion + 2}.`);

  const after = await readRecord(rpc, 'axiom', recordId);
  assert(after.recordVersion === commanded.recordVersion,
    `The command reported version ${commanded.recordVersion}; the record holds ${after.recordVersion}.`);
  assert(after.values['axiom-status'] === 'Accepted',
    `The Accept button left status ${after.values['axiom-status']}.`);
  assert(typeof after.values['axiom-accepted'] === 'string' && after.values['axiom-accepted'].length > 0,
    'The Accept button did not stamp the accepted date.');

  // The retired date makes the accepted axiom a span on the timeline. It is set
  // in the year after the accepted date, so the span is cut at the year end
  // whatever day this runs, and the two draft axioms stay undated.
  const acceptedYear = Number(after.values['axiom-accepted'].slice(0, 4));
  await tool('nendo.data.set_field', {
    ...owned, entityId: 'axiom', recordId, fieldId: 'axiom-retired',
    expectedRecordVersion: after.recordVersion, value: `${acceptedYear + 1}-01-31`, idempotencyKey: crypto.randomUUID(),
  });
  const spanned = await readRecord(rpc, 'axiom', recordId);
  assert(spanned.values['axiom-retired'] === `${acceptedYear + 1}-01-31`,
    `The retired date did not land: ${spanned.values['axiom-retired']}.`);

  // Health reports what was last measured; this asks for a measurement.
  const integrity = await tool('nendo.health.verify_integrity');
  assert(integrity.health.integrityResult === 'ok', `The integrity scan reported ${integrity.health.integrityResult}.`);
  assert(integrity.health.integrityStale === false, 'A scan measured now must not report itself as stale.');
}

/**
 * A write through MCP reaches a surface already on screen, without the person doing
 * anything (W-034).
 *
 * Deliberately a board rather than a tile. A tile chases its own reads and would catch up
 * on its own eventually; a board's records only move when the view is refreshed, which is
 * exactly the case the owner reported -- they were on the Roadmap, an agent moved an item,
 * and the board did not follow until they left the view and came back.
 *
 * The handle is put back before returning, so every later assertion sees the register it
 * expects and this one costs the rest of the run nothing.
 */
async function assertTheScreenFollowsAnAgentsWrite(client) {
  const { rpc } = client;
  const tool = explainingTool(rpc);

  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='axiom'){s.value='axiom';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`document.querySelector('[data-select-surface="axiom-board"]')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('.board-column [data-record-id]')`), 'the axiom board before an agent writes');

  const onScreen = () => evaluate(`document.querySelector('#studio-content').textContent`);
  const before = await onScreen();
  assert(before.includes('DATA-03'), `The board does not show DATA-03 before the write: ${before.slice(0, 300)}`);

  const renamed = 'DATA-03-followed';
  const lease = await tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    const records = JSON.parse((await rpc('resources/read', { uri: await recordsUri(rpc, 'axiom') })).contents[0].text);
    const target = records.items.find(item => item.values['axiom-handle'] === 'DATA-03');
    assert(target !== undefined, 'DATA-03 is not in the file.');
    const written = await tool('nendo.data.set_field', {
      ...owned, entityId: 'axiom', recordId: target.recordId, fieldId: 'axiom-handle',
      expectedRecordVersion: target.recordVersion, value: renamed, idempotencyKey: crypto.randomUUID(),
    });

    // Nothing touches the app between the write above and the read below. The host nudges
    // the renderer, which looks again on its own bounded terms, so this waits for an
    // interval and a read rather than asserting immediately.
    await waitFor(async () => (await onScreen()).includes(renamed) ? true : null,
      'the board to follow an agent write without the person touching anything');

    // And the reader keeps their place while it happens. Every renderer replaces the
    // content pane's markup, which sets scroll back to the top: invisible while a redraw
    // only followed something the person had just done, and not invisible at all once
    // screens redraw on their own account. The owner was reading the bottom of the front
    // page and it hauled them back up.
    //
    // The front page, because it is the screen long enough to scroll. An agent write as
    // the trigger, because a button that redraws also restores focus and the focus scrolls
    // its own target back into view — which hides exactly the defect this is about, and
    // did hide it from the first version of this assertion.
    await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!==''){s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await ready();
    await waitFor(() => evaluate(`!!document.querySelector('[data-testid="overview-page"]')`), 'the front page for the scroll check');
    const ringNow = () => evaluate(`document.querySelector('.overview-page .chart-progress .chart-ring-text')?.textContent ?? ''`);
    await waitFor(async () => (await ringNow()).includes('1') ? true : null, 'the accepted ring before the write');

    // The surface inside the pane is what scrolls on a Use screen, not the pane. Measuring
    // the pane passed while the defect was in place, because the pane never scrolls here.
    const room = await evaluate(`(()=>{const surface=document.querySelector('.use-surface');
      if (surface === null) return {missing:true};
      surface.scrollTop = Math.max(40, Math.floor((surface.scrollHeight - surface.clientHeight) / 2));
      return {to: surface.scrollTop, place: document.querySelector('#studio-content').dataset.place ?? null,
        scrollHeight: surface.scrollHeight, clientHeight: surface.clientHeight};})()`);
    assert(room.missing !== true, 'The front page has no surface to scroll.');
    assert(room.place !== null,
      'The content pane does not say which screen it shows, so a redraw cannot tell a repaint from a move.');
    assert(room.place.includes('overview'),
      `The scroll check is not on the front page: ${JSON.stringify(room)}`);
    assert(room.to > 0,
      `The front page does not scroll in this window, so it cannot show whether a redraw moves the reader: ${JSON.stringify(room)}`);

    // A status the front page counts, so the redraw is observable rather than assumed.
    const accepted = await tool('nendo.data.set_field', {
      ...owned, entityId: 'axiom', recordId: target.recordId, fieldId: 'axiom-status',
      expectedRecordVersion: written.recordVersion, value: 'Accepted', idempotencyKey: crypto.randomUUID(),
    });
    await waitFor(async () => (await ringNow()).includes('2') ? true : null,
      'the front page to count the second accepted axiom');
    const stayedAt = await evaluate(`document.querySelector('.use-surface')?.scrollTop ?? -1`);
    assert(stayedAt === room.to,
      `A redraw moved the reader: scrolled to ${room.to} and came back at ${stayedAt}.`);

    const backToDraft = await tool('nendo.data.set_field', {
      ...owned, entityId: 'axiom', recordId: target.recordId, fieldId: 'axiom-status',
      expectedRecordVersion: accepted.recordVersion, value: 'Draft', idempotencyKey: crypto.randomUUID(),
    });
    await waitFor(async () => (await ringNow()).includes('1') ? true : null, 'the accepted ring to go back');
    await evaluate(`(()=>{const surface=document.querySelector('.use-surface'); if (surface !== null) surface.scrollTop = 0;})()`);
    await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='axiom'){s.value='axiom';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await ready();
    await waitFor(() => evaluate(`!!document.querySelector('[data-select-surface="axiom-board"]')`), 'the board selector after the scroll check');
    await clickFound(`document.querySelector('[data-select-surface="axiom-board"]')`); await ready();

    // And back, so the rest of the run sees the register it expects. The renamed handle
    // contains the original, so this waits for it to leave rather than for the original
    // to appear -- which would be true before the write had landed at all.
    await tool('nendo.data.set_field', {
      ...owned, entityId: 'axiom', recordId: target.recordId, fieldId: 'axiom-handle',
      expectedRecordVersion: backToDraft.recordVersion, value: 'DATA-03', idempotencyKey: crypto.randomUUID(),
    });
    await waitFor(async () => (await onScreen()).includes(renamed) ? null : true,
      'the board to follow the handle being put back');
  } finally {
    await tool('nendo.lease.release', owned).catch(() => { /* already released */ });
  }
}

async function assertRegisterRuns(label) {
  // Which build is this? A version only in an About box cannot answer that while
  // someone is looking at their data.
  const version = await evaluate(`document.querySelector('#session-version')?.textContent`);
  assert(/^Nendo \d+\.\d+\.\d+/.test(version ?? ''), `The status bar does not report the build (${label}): ${version}`);

  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='remit'){s.value='remit';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  // Named rather than "the first row": this file holds a second remit that nothing
  // points at, so which one sorts first is not something to depend on here.
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('Data'))`,
    "the Data remit's row");
  await waitFor(() => evaluate(`!!document.querySelector('.record-inspector .related-list')`),
    `the Data remit's record page (${label})`);

  await waitFor(() => evaluate(`document.querySelectorAll('.related-list .related-rows li').length === 3`), `three axioms in the relation (${label})`);
  // A tile states one exact number over its whole scope. While the read is in
  // flight it shows a placeholder, so the wait is for the number itself.
  const tile = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('.summary-tile .summary-value')?.textContent`);
    return value && value !== '\u2026' ? value : null;
  }, `the axiom count (${label})`);
  assert(tile === '3', `The tile should count three axioms, showed ${tile} (${label}).`);
  // The number covers every related record, not the page in view, so it says so.
  assert(await evaluate(`document.querySelector('.summary-tile .summary-context')?.textContent?.includes('related')`),
    `The tile does not state what it covers (${label}).`);
  const legend = await evaluate(`document.querySelector('.record-form .form-section > summary')?.textContent`);
  assert(legend === 'Scope', `The remit page section is missing (${label}).`);
  await assertTheWidenedSurfacesRun(label);
}

/**
 * Adding and opening a record from a related list (ADR-0004, 2026-09-18 amendment).
 *
 * A related list showed the inverse of a reference and did nothing else, so recording a
 * linked record meant leaving the page that already knew which record you meant, finding
 * it again in a picker, and navigating back (F-031; C-044 accepted the workaround).
 *
 * The Remit page already carries the shape this needs: an Axioms relation over
 * `axiom-remit`, with a count tile beside it. Nothing was authored to get the buttons \u2014
 * that is the entry's decision, and this step is what shows it, because the register was
 * built by an agent that had never heard of them.
 *
 * It runs last in the reopen phase, and adds an axiom that is not removed again. Every
 * assertion that counts axioms has run by then, and this is the last thing the gate does.
 * The clicks are real pointer clicks, for the reason S7 records: `element.click()`
 * dispatches no `pointerdown`, and the quiet window after a click is what decides whether
 * the relation is read again in time to show what was just added.
 */
async function assertARelatedRecordIsAddedAndOpenedWithoutLeavingThePage(label) {
  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='remit'){s.value='remit';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('Data'))`,
    "the Data remit's row");
  await waitFor(() => evaluate(`document.querySelectorAll('.related-list .related-rows li').length === 3`),
    `three axioms before adding one (${label})`);

  // The button names the record type it makes, because a page can carry several
  // relations and "Add" alone would not say which.
  const add = await evaluate(`document.querySelector('.related-list [data-related-add]')?.textContent`);
  assert((add ?? '').includes('Add Axiom'), `The relation does not offer Add Axiom (${label}): ${add}`);

  await pointerClick('.related-list [data-related-add]');
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="related-create"]')`), `the create form (${label})`);
  await screenshot(`related-create-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await screenshot(`related-create-dark-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);

  // The reference back is filled in by the remit's name, not by the stable ID nobody
  // recognises \u2014 and the Axiom page does not bind that field at all, so a form wired to
  // only what the page binds would have saved a record pointing at nothing.
  const chosen = await evaluate(`document.querySelector('#record-form [data-reference-field="axiom-remit"] .reference-selected')?.textContent`);
  assert((chosen ?? '').startsWith('Data \u00b7 '), `The new axiom does not name the remit it is for (${label}): ${chosen}`);
  // And it carries the remit's current version, which a reference write is refused
  // without, although nobody opened a picker to record one.
  const version = await evaluate(`document.querySelector('#record-form [data-reference-field="axiom-remit"]')?.dataset.targetVersion`);
  assert(/^[1-9]\d*$/.test(version ?? ''), `The filled-in reference carries no target version (${label}): ${version}`);

  await evaluate(`(()=>{const set=(name,value)=>{const e=document.querySelector('#record-form [name="'+name+'"]');
    e.value=value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));};
    set('axiom-handle','DATA-04'); set('axiom-statement','Evidence is recorded where it is produced.');})()`);
  await pointerClick('#record-form button[type="submit"]');
  await ready();

  // Back on the remit page \u2014 nobody navigated \u2014 with the new axiom in the relation and
  // the count moved. The tile counts the whole relation rather than the loaded page, so
  // it is the number that proves the write landed where the header said it would.
  await waitFor(() => evaluate(`document.querySelectorAll('.related-list .related-rows li').length === 4`),
    `four axioms after adding one (${label})`);
  const tile = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('.summary-tile .summary-value')?.textContent`);
    return value && value !== '\u2026' ? value : null;
  }, `the axiom count after adding one (${label})`);
  assert(tile === '4', `The tile should now count four axioms, showed ${tile} (${label}).`);

  // Open the row. The relation is ordered by handle ascending, so the new axiom is last,
  // but it is found by its handle rather than by its position.
  // Brought into view first: a real pointer click is dispatched at viewport coordinates,
  // and the relation sits below the fold of the inspector's own scroller. The marker is
  // set in the same pass, so a redraw between marking and clicking is waited out.
  await waitFor(() => evaluate(`(()=>{const row=[...document.querySelectorAll('.related-rows .related-row')].find(b=>b.textContent.includes('DATA-04'));
    if(!row) return false;
    row.dataset.gateTarget='1';
    row.scrollIntoView({block:'center'});
    const r=row.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;})()`), `the new axiom's row in view (${label})`);
  await pointerClick('.related-rows [data-gate-target]');
  await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="record-hero"] h2')?.textContent === 'DATA-04'`),
    `the new axiom's own page (${label})`);
  assert(await evaluate(`document.querySelector('#use-entity')?.value === 'axiom'`),
    `Opening a related row did not move Use to the record type it belongs to (${label}).`);
  // It was read on its own, so it is on screen although the axiom surface behind it is
  // filtered and ordered by something else entirely.
  await screenshot(`related-open-${label}.png`);

  const back = await evaluate(`document.querySelector('#related-back')?.textContent`);
  assert((back ?? '').includes('Back to Data'), `The way back does not name the record it came from (${label}): ${back}`);
  await pointerClick('#related-back');
  await ready();
  await waitFor(() => evaluate(`document.querySelector('#use-entity')?.value === 'remit'
    && document.querySelectorAll('.related-list .related-rows li').length === 4`),
    `the Data remit again, with its four axioms (${label})`);
  assert(await evaluate(`document.querySelector('#related-back') === null`),
    `The way back is still offered after it was taken (${label}).`);
}

/**
 * Back and forward, everywhere, not only out of a relation (W-046).
 *
 * W-033 gave a related row one step back to the record it was opened from, and everything
 * else a person navigates had no way back at all. The pair in the header's control group
 * is the general answer. The labelled back stays where it is, half a screen away in the
 * Use toolbar, and the two agree about where they go, because the trail records the parent
 * record as a place of its own.
 *
 * The trail's own rules are asserted in the node lane (C-091), which can reach them
 * because they are a ring and nothing else. What can only be asserted here is that the
 * places it was built from are the places the application actually drew, and that one of
 * them can be put back. Every step is measured -- the record type in the picker, the
 * heading on the record page, which surface carries aria-pressed, the words in the drill
 * pill -- because a screenshot of a back button proves that it exists and nothing more.
 *
 * The clicks on the two arrows are real pointer clicks, for the reason S7 records:
 * `element.click()` dispatches no `pointerdown`, so it never meets the quiet window that
 * decides whether the next read lands.
 *
 * It runs last. It needs the axiom the step before it added, and it deletes that axiom
 * part way through -- which is what the refusal in the middle of it is for.
 */
async function assertBackAndForwardWalkTheTrail(label) {
  const named = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-label') ?? null`);
  const usable = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); return e === null ? null : !e.disabled;})()`);
  const entity = () => evaluate(`document.querySelector('#use-entity')?.value ?? null`);

  // Where the step before left off: the Data remit's page, arrived at by taking the
  // labelled back, so there is a trail behind and nothing at all ahead.
  assert(await usable('#nav-back') === true, `The way back leads nowhere from the remit page (${label}).`);
  assert(await usable('#nav-forward') === false,
    `The way forward is offered although nothing has been gone back from (${label}).`);
  assert(await named('#nav-forward') === 'Forward',
    `A way forward that leads nowhere named a place anyway (${label}): ${JSON.stringify(await named('#nav-forward'))}`);
  const backName = await named('#nav-back');
  assert(/^Back to \S/.test(backName ?? ''),
    `The way back does not say where it goes (${label}): ${JSON.stringify(backName)}`);

  // One step back is the axiom's own page, which the labelled back was taken from.
  await pointerClick('#nav-back'); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="record-hero"] h2')?.textContent === 'DATA-04'`),
    `the axiom page one step back (${label})`);
  assert(await entity() === 'axiom',
    `Going back did not move Use to the record type the place belongs to (${label}).`);
  // The place carried W-033's own way back with it, so the labelled button is there again
  // rather than swallowed by the general trail.
  const labelled = await evaluate(`document.querySelector('#related-back')?.textContent ?? null`);
  assert((labelled ?? '').includes('Back to Data'),
    `The place did not carry the related row's own way back (${label}): ${JSON.stringify(labelled)}`);
  assert(await usable('#nav-forward') === true, `Nothing leads forward after going back (${label}).`);
  const forwardName = await named('#nav-forward');
  assert(/^Forward to \S/.test(forwardName ?? ''),
    `The way forward does not say where it goes (${label}): ${JSON.stringify(forwardName)}`);
  await screenshot(`back-forward-${label}.png`);

  // Two steps back is the remit page the row was opened from, with its four axioms.
  await pointerClick('#nav-back'); await ready();
  await waitFor(() => evaluate(`document.querySelector('#use-entity')?.value === 'remit'
    && document.querySelectorAll('.related-list .related-rows li').length === 4`),
    `the remit page two steps back (${label})`);

  // Forward walks back up the same trail.
  await pointerClick('#nav-forward'); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="record-hero"] h2')?.textContent === 'DATA-04'`),
    `the axiom page again, going forward (${label})`);

  // A place whose record has gone is declined with a sentence, and the person is left
  // exactly where they are. The axiom is deleted from its own page, which puts that page
  // behind us as a place that no longer exists.
  await clickFound(`document.querySelector('#delete-record')`);
  await waitFor(() => evaluate(`!!document.querySelector('.record-delete-dialog[open]')`), `the delete confirmation (${label})`);
  await clickFound(`document.querySelector('.record-delete-dialog [data-confirm]')`);
  await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="record-hero"] h2') === null`),
    `the axiom surface after the record was deleted (${label})`);
  // Deleting a record leaves the record context, so W-033's own way back goes with it.
  // It used to stay up on the surface behind, offering a way back to a page nobody was
  // on, because the delete cleared the selection rather than the context.
  assert(await evaluate(`document.querySelector('#related-back') === null`),
    `A deleted record left its labelled way back standing on the surface behind it (${label}).`);
  await pointerClick('#nav-back'); await ready();
  const refusal = await waitFor(() => evaluate(`document.querySelector('.message-slot:not([hidden])')?.textContent ?? null`),
    `the sentence about the place that has gone (${label})`);
  assert(refusal.includes('That record is no longer there'),
    `A place that has gone was not named in a sentence (${label}): ${JSON.stringify(refusal)}`);
  assert(await evaluate(`document.querySelector('[data-testid="record-hero"] h2') === null`),
    `A place that has gone was guessed at rather than declined (${label}).`);
  // The sentence has to outlive the reads the screen makes on its own account. Said the
  // way an error was, into the pane and nothing more, it lasted until the next chased read
  // landed, and on the published payload that read once landed before this step looked:
  // the gate read nothing, and so would a person pressing Back at that moment (F-086). So
  // the read is made to land after the sentence rather than left to chance -- a write from
  // elsewhere, which the screen follows as it does for a closed draft -- and the sentence
  // is still there afterwards (W-054). Nothing is pressed in between: a press is the
  // person doing the next thing, and would release the sentence on purpose.
  const shown = await evaluate(`document.querySelector('#studio-content').textContent`);
  const axioms = await host('data.queryRecords', { entityId: 'axiom', limit: 10, filters: [] });
  const elsewhere = (axioms.items ?? []).find(item => shown.includes(item.values['axiom-handle']));
  assert(elsewhere !== undefined,
    `No axiom on screen to write from elsewhere, so a redraw could not be observed (${label}): ${JSON.stringify(shown.slice(0, 200))}`);
  const handle = elsewhere.values['axiom-handle'];
  await host('data.setField', { entityId: 'axiom', recordId: elsewhere.recordId, fieldId: 'axiom-handle',
    expectedRecordVersion: elsewhere.recordVersion, value: `${handle} (written elsewhere)`, idempotencyKey: crypto.randomUUID() });
  await waitFor(() => evaluate(`document.querySelector('#studio-content').textContent.includes('(written elsewhere)')`),
    `the screen to follow a write made after the refusal (${label})`);
  const kept = await evaluate(`document.querySelector('.message-slot:not([hidden])')?.textContent ?? null`);
  assert(kept !== null && kept.includes('That record is no longer there'),
    `The refusal did not survive the read the screen made on its own account after it (${label}): ${JSON.stringify(kept)}`);
  await screenshot(`refusal-outlives-a-read-${label}.png`);
  // The name is put back, and the screen seen to follow that too, so every later step
  // that reads it finds what it expects.
  const renamed = (await host('data.queryRecords', { entityId: 'axiom', limit: 10, filters: [] })).items.find(item => item.recordId === elsewhere.recordId);
  await host('data.setField', { entityId: 'axiom', recordId: elsewhere.recordId, fieldId: 'axiom-handle',
    expectedRecordVersion: renamed.recordVersion, value: handle, idempotencyKey: crypto.randomUUID() });
  await waitFor(() => evaluate(`!document.querySelector('#studio-content').textContent.includes('(written elsewhere)')`),
    `the name put back after the refusal (${label})`);
  // And it was dropped rather than left to refuse for ever, so the next press moves. The
  // button's own name cannot answer this: the header names the surface, so a record page
  // and the surface behind it are called the same thing.
  await pointerClick('#nav-back'); await ready();
  await waitFor(() => evaluate(`document.querySelector('#use-entity')?.value === 'remit'`),
    `the remit page, one press past the place that had gone (${label})`);

  // The surface and the drill are part of where somebody is, not only the record type.
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='axiom'){s.value='axiom';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`document.querySelector('[data-select-surface="axiom-board"]')`); await ready();

  // The arrows keep up with a move that takes one draw. Selecting a surface renders once,
  // and the same render draws the buttons — so a trail told after the chrome leaves them
  // one move behind: from a fresh file the first move left Back disabled while Alt+Left
  // worked, and further along a trail the label named the place before the one it led to.
  // Measured by the name, because "enabled" is already true by this point in the journey.
  const leftBehind = await evaluate(`document.querySelector('#workspace-title')?.textContent`);
  await clickFound(`document.querySelector('[data-select-surface="axiom-accepted-list"]')`); await ready();
  const keptUp = await named('#nav-back');
  assert(keptUp === `Back to Use · Axiom — ${leftBehind}`,
    `The way back did not keep up with a single move (${label}): ${JSON.stringify(keptUp)} after leaving ${JSON.stringify(leftBehind)}`);
  await pointerClick('#nav-back'); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-select-surface="axiom-board"]')?.getAttribute('aria-pressed') === 'true'`),
    `the board again after a single move (${label})`);

  await waitFor(() => evaluate(`!!document.querySelector('.use-surface > .summary-tiles .chart-segment[data-chart-group="Accepted"]')`),
    `the board's status breakdown (${label})`);
  await clickFound(`document.querySelector('.use-surface > .summary-tiles .chart-segment[data-chart-group="Accepted"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="drill-pill"]')?.textContent?.includes('Status: Accepted')
    && document.querySelectorAll('.record-list [data-record-id]').length === 1`),
    `the drilled list, narrowed to one axiom (${label})`);
  // Back out of the drill. A place that named the drill rather than carrying it would
  // come back to a board still narrowed, because the drill it named is whatever the
  // renderer holds now.
  await pointerClick('#nav-back'); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-select-surface="axiom-board"]')?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('[data-testid="drill-pill"]')`),
    `the board again, with the drill taken off (${label})`);
  await pointerClick('#nav-forward'); await ready();
  // The rows, not only the pill and the pressed button. refreshDerived reloads the
  // selected surface under its DECLARED query, so a place restored into a drill sat on a
  // window at the current revision holding the whole list, and the read that applies the
  // drill was skipped as unnecessary: every row drawn under a pill that said one.
  await waitFor(() => evaluate(`document.querySelector('[data-testid="drill-pill"]')?.textContent?.includes('Status: Accepted')
    && document.querySelector('[data-select-surface="axiom-open"]')?.getAttribute('aria-pressed') === 'true'
    && document.querySelectorAll('.record-list [data-record-id]').length === 1`),
    `the drilled list again, still narrowed to one axiom, going forward (${label})`);

  // Alt+Left and Alt+Right do what the arrows do, so the pair is reachable without a
  // pointer. Dispatched as real key events rather than by calling the handler.
  await altArrow('ArrowLeft', 37); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-select-surface="axiom-board"]')?.getAttribute('aria-pressed') === 'true'
    && !document.querySelector('[data-testid="drill-pill"]')`),
    `the board again, reached with Alt+Left (${label})`);
  await altArrow('ArrowRight', 39); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="drill-pill"]')?.textContent?.includes('Status: Accepted')`),
    `the drilled list again, reached with Alt+Right (${label})`);

  // The two segments are one control dressed alike, in both themes. Measured rather than
  // looked at: a screenshot shows two rounded boxes whether or not they agree, and the
  // point of sharing the rule is that they cannot drift.
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    const measured = await evaluate(`(() => {
      const box = element => { const s = getComputedStyle(element); return [s.borderTopColor, s.borderTopWidth, s.borderRadius, s.backgroundColor, s.padding].join('|'); };
      const button = element => { const s = getComputedStyle(element); return [s.width, s.height, s.borderRadius].join('|'); };
      return {
        group: [box(document.querySelector('.history-control')), box(document.querySelector('.theme-control'))],
        button: [button(document.querySelector('#nav-back')), button(document.querySelector('[data-theme-option="light"]'))],
        idle: getComputedStyle(document.querySelector('#nav-forward')).opacity,
        live: getComputedStyle(document.querySelector('#nav-back')).opacity,
      };
    })()`);
    assert(measured.group[0] === measured.group[1],
      `The two header segments disagree about their own box in ${theme} (${label}): ${measured.group.join(' vs ')}`);
    assert(measured.button[0] === measured.button[1],
      `The arrows and the theme buttons are different sizes in ${theme} (${label}): ${measured.button.join(' vs ')}`);
    assert(Number(measured.live) === 1 && Number(measured.idle) < 0.6,
      `A direction that leads nowhere is not told apart from one that does in ${theme} (${label}): ${measured.live} / ${measured.idle}`);
    await screenshot(`back-forward-${theme}-${label}.png`);
  }
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);

  // Each button says where it goes, and one that leads nowhere names only itself.
  const reachable = await evaluate(`[...document.querySelectorAll('.history-control button')].map(b => ({
    name: b.getAttribute('aria-label'), title: b.title, disabled: b.disabled, tabbable: b.tabIndex >= 0 }))`);
  assert(reachable.length === 2, `The header should carry two arrows, carries ${reachable.length} (${label}).`);
  for (const arrow of reachable) {
    assert(arrow.name === arrow.title, `An arrow's name and its tooltip disagree (${label}): ${JSON.stringify(arrow)}`);
    assert(arrow.disabled || /^(Back|Forward) to \S/.test(arrow.name ?? ''),
      `An arrow that leads somewhere does not say where (${label}): ${JSON.stringify(arrow)}`);
    assert(arrow.disabled || arrow.tabbable, `An arrow that leads somewhere is out of the keyboard's reach (${label}).`);
  }
  assert(reachable.some(arrow => !arrow.disabled), `Neither arrow leads anywhere at the end of a walked trail (${label}).`);
}

/**
 * The rail folds down to its icons, and stays folded.
 *
 * Measured rather than looked at: a screenshot shows a narrow strip whether the labels
 * are hidden, deleted, or merely spilling under the column beside them. What decides it
 * is the grid track, the label still being there for a screen reader, and the fold
 * outliving a reload -- it is kept for the device, so a person who folds it once should
 * not find it open again tomorrow.
 */
async function assertTheRailFoldsToItsIcons(label) {
  const read = () => evaluate(`(() => {
    const rail = document.querySelector('#app-rail');
    const item = document.querySelector('#nav-studio');
    const caption = item.querySelector('span:not(.nav-symbol)');
    const symbol = item.querySelector('.nav-symbol svg');
    const toggle = document.querySelector('#rail-toggle');
    return {
      track: getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns,
      overflow: rail.scrollWidth - rail.clientWidth,
      caption: Math.round(caption.getBoundingClientRect().width),
      text: caption.textContent,
      symbol: Math.round(symbol.getBoundingClientRect().width),
      title: item.title,
      expanded: toggle.getAttribute('aria-expanded'),
      toggle: Math.round(toggle.getBoundingClientRect().width),
    };
  })()`);

  const open = await read();
  assert(open.track.startsWith('196px'), `The rail does not start at its full width (${label}): ${open.track}`);
  assert(open.toggle > 0, `There is no control to fold the rail with (${label}).`);
  assert(open.overflow <= 0,
    `The mark and the fold control do not fit the open rail (${label}): ${open.overflow}px over.`);

  await pointerClick('#rail-toggle');
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    const folded = await read();
    assert(folded.track.startsWith('56px'),
      `The folded rail is not down to its icons in ${theme} (${label}): ${folded.track}`);
    assert(folded.caption <= 1 && folded.text === 'Studio',
      `A folded route either still draws its label or has lost it in ${theme} (${label}): ${folded.caption}px, ${JSON.stringify(folded.text)}`);
    assert(folded.symbol > 0 && folded.title === 'Studio',
      `A folded route cannot be told apart or named in ${theme} (${label}): ${folded.symbol}px, ${JSON.stringify(folded.title)}`);
    assert(folded.expanded === 'false',
      `The fold control still reports the rail open in ${theme} (${label}).`);
    assert(folded.overflow <= 0,
      `The folded rail overflows in ${theme} (${label}): ${folded.overflow}px over.`);
    await screenshot(`rail-folded-${theme}-${label}.png`);
  }
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);

  // Kept for the device, so it has to outlive the window it was set in.
  await command('Page.reload'); await sleep(400); await ready(); await snapshot();
  const reopened = await read();
  assert(reopened.track.startsWith('56px'), `The rail forgot that it was folded (${label}): ${reopened.track}`);

  // Left open, which is what every other step in this run expects to find.
  await pointerClick('#rail-toggle');
  const restored = await read();
  assert(restored.track.startsWith('196px'), `The rail did not open again (${label}): ${restored.track}`);
}

/**
 * A pointer click on something that may sit below the fold of a scroller, such as the
 * record page's own. A pointer lands at viewport coordinates, so the element is brought
 * into view first and the click waits until it is there.
 */
async function pointerClickInView(selector) {
  // In the viewport, and the thing under the pointer: the record inspector's Save row is
  // sticky over the bottom of its scroller, so an element whose box is on screen can
  // still be covered, and a click measured at its centre presses Save instead. Centred
  // first; failing that, at the top of the scroller, where nothing overlays it.
  const inView = () => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    if (e === null || e.disabled) return false;
    for (const block of ['center', 'start']) {
      e.scrollIntoView({ block });
      const r = e.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight)) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit !== null && (hit === e || e.contains(hit))) return true;
    }
    return false; })()`);
  await waitFor(inView, `${selector} in view and uncovered`);
  // Once more after a beat: a list loading above the element moves it between the
  // measurement and the click, and the pointer then lands where the element was.
  await sleep(150);
  await waitFor(inView, `${selector} still in view and uncovered`);
  await pointerClick(selector);
}

/** Something read until it is there, for a bounded moment, or null. Never throws. */
async function briefly(read, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

/** The refusal on screen that says these words, or null. */
function refusalSaying(words) {
  return evaluate(`(() => {
    const said = document.querySelector('.message-slot:not([hidden])')?.textContent ?? '';
    return said.startsWith('Save your changes') && said.includes(${JSON.stringify(words)}) ? said : null;
  })()`);
}

/** The heading of the record page on screen, or null when none is. */
function recordOnPage() {
  return evaluate(`document.querySelector('[data-testid="record-hero"] h2')?.textContent ?? null`);
}

/**
 * A reference picker's search leaves nothing unsaved, and neither does a save with
 * nothing to save (W-050).
 *
 * Typing in a picker's search box bubbled to the form's edit tracking, which recorded an
 * empty field name and called the page dirty. From then on Back, Forward, Add and open
 * declined, and pressing Save answered "No changes to save." without clearing the state
 * that made them decline; so did a field edited and put back. Measured by the one thing a
 * person can see: whether the way back is taken or refused. And the converse, that a
 * reference actually chosen still holds the page until it is saved or closed.
 */
async function assertAPickerSearchLeavesNothingUnsaved(label) {
  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='axiom'){s.value='axiom';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`document.querySelector('[data-select-surface="axiom-open"]')`); await ready();
  // The step before left the list drilled to the accepted axiom; the whole list is wanted.
  // Two rows: DATA-02 is superseded, and DATA-04 was deleted walking the trail.
  await evaluate(`document.querySelector('[data-drill-clear]')?.click()`); await ready();
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="drill-pill"]') && document.querySelectorAll('.record-list [data-record-id]').length === 2`),
    `the whole list of open axioms (${label})`);
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('DATA-01'))`, "DATA-01's row");
  await waitFor(async () => (await recordOnPage()) === 'DATA-01', `DATA-01's page (${label})`);
  const picker = '#record-form [data-reference-field="axiom-supersedes"]';
  // Open, and settled: the picker reads its first page when it opens, and the rows that
  // land push its Cancel down, so a click measured before they land misses it.
  const pickerOpen = () => evaluate(`document.querySelector('${picker} .reference-picker')?.hidden === false
    && !(document.querySelector('${picker} .reference-status')?.textContent ?? '').startsWith('Loading')`);
  // Whether the way back was taken, or what the page said instead. Whichever lands first
  // is the answer; a redraw makes a fresh, hidden slot, so a stale refusal cannot be read.
  const wayBack = async (what) => {
    await pointerClick('#nav-back');
    const seen = await waitFor(async () => (await recordOnPage()) === null ? { taken: true }
      : (await refusalSaying('before going back')) !== null ? { taken: false, said: await refusalSaying('before going back') } : null, what);
    return seen;
  };

  // Search, and cancel without choosing.
  await pointerClickInView(`${picker} .reference-choose`);
  await waitFor(pickerOpen, `the Supersedes picker (${label})`);
  // The picker focuses its own search box; typing goes there, as a person's would.
  await command('Input.insertText', { text: 'DATA' });
  assert(await evaluate(`document.querySelector('${picker} .reference-search')?.value`) === 'DATA',
    `The search box did not take the typing (${label}).`);
  await pointerClickInView(`${picker} .reference-cancel`);
  await waitFor(async () => !(await pickerOpen()), `the picker closed again (${label})`);
  const afterSearch = await wayBack(`the way back after a cancelled picker search (${label})`);
  assert(afterSearch.taken, `A cancelled picker search left the page refusing to be left (${label}): ${JSON.stringify(afterSearch.said)}`);

  // Edit a field and put it back, then save: nothing to save, and nothing left unsaved.
  await pointerClick('#nav-forward'); await ready();
  await waitFor(async () => (await recordOnPage()) === 'DATA-01', `DATA-01's page again, going forward (${label})`);
  await evaluate(`(()=>{const e=document.querySelector('#record-form [name="axiom-handle"]');
    const set=(v)=>{e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));}; set('DATA-01 edited'); set('DATA-01');})()`);
  await pointerClickInView('#record-form button[type="submit"]');
  const said = await waitFor(() => evaluate(`document.querySelector('.message-slot:not([hidden])')?.textContent ?? null`),
    `what Save says with nothing to save (${label})`);
  assert(said === 'No changes to save.', `Save with nothing to save said something else (${label}): ${JSON.stringify(said)}`);
  assert(await recordOnPage() === 'DATA-01', `A save with nothing to save moved off the page (${label}).`);
  const afterNoOpSave = await wayBack(`the way back after a save with nothing to save (${label})`);
  assert(afterNoOpSave.taken, `A save with nothing to save left the page refusing to be left (${label}): ${JSON.stringify(afterNoOpSave.said)}`);

  // A reference actually chosen is a change, and holds the page until it is saved or closed.
  await pointerClick('#nav-forward'); await ready();
  await waitFor(async () => (await recordOnPage()) === 'DATA-01', `DATA-01's page a third time (${label})`);
  await pointerClickInView(`${picker} .reference-choose`);
  await waitFor(pickerOpen, `the Supersedes picker again (${label})`);
  await clickFound(`[...document.querySelectorAll('${picker} .reference-result')].find(b=>b.textContent.startsWith('DATA-02'))`, 'DATA-02 in the picker');
  await waitFor(() => evaluate(`document.querySelector('${picker} .reference-selected')?.textContent?.startsWith('DATA-02')`), `DATA-02 chosen (${label})`);
  const afterChoice = await wayBack(`the way back after a reference was chosen (${label})`);
  assert(!afterChoice.taken, `A chosen reference did not hold the page: the way back was taken with it unsaved (${label}).`);
  assert(await recordOnPage() === 'DATA-01', `The page moved although it declined (${label}).`);
  // Closing the page is the person's own act, and discards it.
  await pointerClick('#close-inspector'); await ready();
  await waitFor(async () => (await recordOnPage()) === null, `the list after the draft was closed (${label})`);
  await screenshot(`picker-search-${label}.png`);
}

/**
 * A related row whose record has gone says so (W-051).
 *
 * The sentence was there, and a `return` inside the try stepped over the line that showed
 * it: the click cleared busy, redrew the same page and said nothing. F-070 had claimed the
 * related sites fixed by inspection, and its guard covered only the trail's path; this one
 * reaches the branch itself. The row is pointed at a record ID that does not exist rather
 * than deleted from another client between the draw and the click, because that race
 * cannot be timed from outside, and the branch reached is the same one.
 */
async function assertARelatedRowWhoseRecordHasGoneSaysSo(label) {
  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='remit'){s.value='remit';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('Data'))`,
    "the Data remit's row");
  await waitFor(() => evaluate(`document.querySelectorAll('.related-list .related-rows li').length === 3`),
    `the Data remit's three axioms (${label})`);
  const gone = crypto.randomUUID();
  await waitFor(() => evaluate(`(()=>{const row=document.querySelector('.related-rows .related-row');
    if(!row) return false;
    row.dataset.relatedOpen=${JSON.stringify(gone)};
    row.dataset.gateTarget='1';
    row.scrollIntoView({block:'center'});
    const r=row.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;})()`), `a related row to point at a record that has gone (${label})`);
  await pointerClick('.related-rows [data-gate-target]');
  await ready();
  const said = await briefly(() => evaluate(`document.querySelector('.message-slot:not([hidden])')?.textContent ?? null`));
  assert(said !== null && said.includes('That record is no longer there'),
    `A related row whose record has gone did nothing and said nothing (${label}): ${JSON.stringify(said)}`);
  assert(await evaluate(`document.querySelector('#use-entity')?.value`) === 'remit',
    `The click moved off the remit page (${label}).`);
  assert(await evaluate(`!!document.querySelector('.record-inspector .related-list')`),
    `The remit page is no longer on screen after the refusal (${label}).`);
  assert(await evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy')`) === 'false',
    `The page is still busy after the refusal (${label}).`);
  await screenshot(`related-row-gone-${label}.png`);
}

/**
 * Unsaved typing survives every move off the page, or the move is declined (W-049).
 *
 * Two paths lost it without a word: choosing another surface redrew the page, and paging
 * a relation on the same record redrew it too, rebuilding the parent's form from stored
 * values. The relation now patches in place, as a tab change does, and every other move
 * declines in the board drag's words -- including a write from elsewhere, which redrew
 * the page the moment the typed field lost focus. Measured with a marker on the form: a
 * patched form keeps it, a rebuilt one cannot.
 *
 * A relation pages at fifty rows, and so does a list, so the Data remit is given
 * forty-nine more draft axioms here, through the host, after every step that counts them
 * has run: fifty-two in the relation and fifty-one open, a second page of each.
 */
async function assertUnsavedTypingSurvivesEveryMoveOffThePage(label) {
  const remits = await host('data.queryRecords', { entityId: 'remit', limit: 10, filters: [] });
  const data = (remits.items ?? []).find(item => item.values['remit-name'] === 'Data');
  const interfaces = (remits.items ?? []).find(item => item.values['remit-name'] === 'Interfaces');
  assert(data && interfaces, `The two remits could not be read back (${label}).`);
  for (let n = 1; n <= 49; n++) {
    await host('data.createRecord', {
      entityId: 'axiom', recordId: crypto.randomUUID(),
      values: { 'axiom-handle': `PAGE-${String(n).padStart(2, '0')}`, 'axiom-statement': `Row ${n} of a relation that runs past its first page.`, 'axiom-status': 'Draft', 'axiom-remit': data.recordId },
      expectedTargetVersions: { 'axiom-remit': data.recordVersion },
      idempotencyKey: crypto.randomUUID(),
    });
  }

  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='remit'){s.value='remit';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('Data'))`,
    "the Data remit's row");
  await waitFor(() => evaluate(`document.querySelectorAll('.related-list .related-rows li').length === 50`),
    `the first page of the relation (${label})`);

  // The form is marked, and typed into with the caret at the end of the name.
  const typeInto = async (name, text) => {
    await evaluate(`(()=>{const f=document.querySelector('#record-form'); f.dataset.gateDraft='1';
      const e=f.querySelector('[name=${JSON.stringify(name)}]'); e.focus(); e.setSelectionRange(e.value.length, e.value.length);})()`);
    await command('Input.insertText', { text });
  };
  const draft = (name) => evaluate(`(()=>{const f=document.querySelector('#record-form'); if(f===null) return null;
    return {marked: f.dataset.gateDraft === '1', value: f.querySelector('[name=${JSON.stringify(name)}]')?.value ?? null};})()`);
  const kept = async (name, expected, what) => {
    const now = await draft(name);
    assert(now?.marked === true, `${what} rebuilt the record page, and the typing went with it (${label}): ${JSON.stringify(now)}`);
    assert(now.value === expected, `${what} lost the typing (${label}): ${JSON.stringify(now)}`);
  };
  const declined = async (what, words, name, expected, act) => {
    await act();
    const said = await briefly(() => refusalSaying(words));
    const now = await draft(name);
    assert(said !== null, `${what} was not declined while the page held unsaved typing (${label}); afterwards the form ${now === null ? 'was gone' : `held ${JSON.stringify(now)}`}.`);
    await kept(name, expected, what);
  };

  await typeInto('remit-name', ' (unsaved)');
  await kept('remit-name', 'Data (unsaved)', 'Typing');
  // Page the relation. Its pager sits below the fold of the inspector, so it is brought
  // into view for the pointer.
  await waitFor(() => evaluate(`(()=>{const b=document.querySelector('.related-list [data-related-page="1"]');
    if(!b || b.disabled) return false; b.scrollIntoView({block:'center'});
    const r=b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight;})()`),
    `the relation's Next, enabled and in view (${label})`);
  await pointerClick('.related-list [data-related-page="1"]'); await ready();
  await waitFor(() => evaluate(`document.querySelector('.related-list .page-controls span')?.textContent?.includes('Page 2')`),
    `the second page of the relation (${label})`);
  await kept('remit-name', 'Data (unsaved)', 'Paging the relation');
  assert(await evaluate(`document.querySelectorAll('.related-list .related-rows li').length === 2`),
    `The second page does not hold the two rows past fifty (${label}).`);

  // The moves the page declines, each measured after the act.
  await declined('Choosing another record type', 'before showing another record type', 'remit-name', 'Data (unsaved)', () =>
    evaluate(`(()=>{const s=document.querySelector('#use-entity'); s.value='axiom'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`));
  assert(await evaluate(`document.querySelector('#use-entity')?.value`) === 'remit',
    `The picker shows another record type although the move was declined (${label}).`);
  await declined('Adding a record', 'before adding a record', 'remit-name', 'Data (unsaved)', () => pointerClick('#new-record'));
  await declined('Opening another record', 'before opening another record', 'remit-name', 'Data (unsaved)', () =>
    clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('Interfaces'))`, "the Interfaces remit's row"));

  // A write from elsewhere, once the typed field has lost focus and the page has been
  // left alone longer than its quiet window. The window follows the file when the draft
  // is closed, not before.
  await evaluate(`document.activeElement?.blur()`);
  await sleep(1000);
  await host('data.setField', { entityId: 'remit', recordId: interfaces.recordId, fieldId: 'remit-name', expectedRecordVersion: interfaces.recordVersion,
    value: 'Interfaces (renamed elsewhere)', idempotencyKey: crypto.randomUUID() });
  await sleep(3000);
  await kept('remit-name', 'Data (unsaved)', 'A write from elsewhere');
  await pointerClick('#close-inspector'); await ready();
  await waitFor(() => evaluate(`[...document.querySelectorAll('.record-list [data-record-id]')].some(row=>row.textContent.includes('Interfaces (renamed elsewhere)'))`),
    `the write from elsewhere, drawn once the draft was closed (${label})`);

  // Another surface, and another page of records, on the record type that has both.
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); s.value='axiom'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await ready();
  await clickFound(`document.querySelector('[data-select-surface="axiom-open"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 50`),
    `the first page of fifty open axioms (${label})`);
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('DATA-01'))`, "DATA-01's row");
  await waitFor(async () => (await recordOnPage()) === 'DATA-01', `DATA-01's page (${label})`);
  await typeInto('axiom-handle', ' (unsaved)');
  await declined('Choosing another screen', 'before choosing another screen', 'axiom-handle', 'DATA-01 (unsaved)', () =>
    clickFound(`document.querySelector('[data-select-surface="axiom-board"]')`));
  assert(await evaluate(`document.querySelector('[data-select-surface="axiom-open"]')?.getAttribute('aria-pressed')`) === 'true',
    `The surface changed although the move was declined (${label}).`);
  await declined('Showing another page of records', 'before showing another page of records', 'axiom-handle', 'DATA-01 (unsaved)', () =>
    pointerClick('.use-toolbar [data-record-page="1"]'));

  // The refusal has to be readable on both grounds; measured, and then captured.
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    const shown = await evaluate(`(() => {
      const slot = document.querySelector('.message-slot:not([hidden])');
      if (slot === null) return null;
      const style = getComputedStyle(slot);
      return { height: slot.getBoundingClientRect().height, visibility: style.visibility, color: style.color, background: style.backgroundColor };
    })()`);
    assert(shown !== null && shown.height > 0 && shown.visibility === 'visible' && shown.color !== shown.background,
      `The refusal is not readable in ${theme} (${label}): ${JSON.stringify(shown)}`);
    await screenshot(`draft-declined-${theme}-${label}.png`);
  }
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  await pointerClick('#close-inspector'); await ready();
  await waitFor(async () => (await recordOnPage()) === null, `the list after the draft was closed (${label})`);
}

/**
 * What the window says while a file is dragged over it (W-048).
 *
 * Synthetic DragEvents, and the limit is stated rather than glossed: nothing
 * scriptable can make Windows hand a real file to a window, so what is measured here
 * is everything up to that point — the hint appearing, saying the right thing, and
 * going away again. The file actually arriving is owner-reported.
 *
 * Both themes, because the refusal is the one state where a colour carries the
 * meaning, and a colour that reads on one ground and not the other is a defect the
 * eye finds and a screenshot does not.
 */
async function assertADraggedFileIsAnsweredBeforeItLands(label) {
  const dispatch = async (type, names) => {
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      for (const name of ${JSON.stringify(names)}) transfer.items.add(new File([new Uint8Array(4)], name));
      document.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    })()`);
  };
  const overlay = () => evaluate(`(() => {
    const element = document.querySelector('#file-drop-target');
    if (element === null || element.hidden) return null;
    const style = getComputedStyle(element.querySelector('.file-drop-card'));
    return {
      message: document.querySelector('#file-drop-message')?.textContent ?? '',
      possible: element.dataset.possible,
      border: style.borderTopColor,
      covers: Math.round(element.getBoundingClientRect().height) >= window.innerHeight,
    };
  })()`);

  assert(await overlay() === null, `The drop hint is on screen before anything is dragged (${label}).`);

  await dispatch('dragenter', ['Work.nendo']);
  const offered = await waitFor(overlay, `the drop hint for one file (${label})`);
  assert(offered.possible === 'true', `One file is not offered as droppable (${label}).`);
  assert(/^Drop to open/.test(offered.message), `The drop hint reads "${offered.message}" (${label}).`);
  // The page cannot see a dragged file's name, so a hint that named the file type
  // would be the page inventing what it knows.
  assert(!/nendo/i.test(offered.message), `The drop hint claims to know the file is a Nendo file (${label}).`);
  assert(offered.covers, `The drop hint does not cover the window it is asking to be dropped on (${label}).`);
  const offerBorder = offered.border;

  await dispatch('dragleave', ['Work.nendo']);
  await waitFor(async () => await overlay() === null, `the drop hint to go when the drag leaves (${label})`);

  await dispatch('dragenter', ['One.nendo', 'Two.nendo']);
  const refused = await waitFor(overlay, `the drop hint for several files (${label})`);
  assert(refused.possible === 'false', `Several files are still offered as droppable (${label}).`);
  assert(/one file at a time/.test(refused.message), `Several files are refused with "${refused.message}" (${label}).`);
  assert(refused.border !== offerBorder,
    `An offer and a refusal are drawn the same colour, ${offerBorder} (${label}).`);
  await dispatch('dragleave', ['One.nendo', 'Two.nendo']);
  await waitFor(async () => await overlay() === null, `the drop hint to go after a refusal (${label})`);

  // A file Nendo cannot open is refused by name rather than silently ignored.
  await dispatch('dragenter', ['budget.xlsx']);
  await waitFor(overlay, `the drop hint for a foreign file (${label})`);
  await dispatch('drop', ['budget.xlsx']);
  await waitFor(async () => await overlay() === null, `the drop hint to go once something is dropped (${label})`);
  const complaint = await waitFor(() => evaluate(
    `document.querySelector('.message-slot[role="alert"]:not([hidden])')?.textContent || null`),
    `a sentence about the file that is not a Nendo file (${label})`);
  assert(/budget\.xlsx/.test(complaint), `The refusal does not name what was dropped: "${complaint}" (${label}).`);

  // The property the whole design rests on: a page cannot name a file.
  //
  // This sends the real bridge call with a File the page made up — the shape a
  // tampered page would use to ask Nendo to open a path of its choosing — and asserts
  // that it does not get across. It does not: WebView2 itself refuses to carry a File
  // that is not on disk, which is a better answer than the host refusing it, and one
  // step below anything Nendo could get wrong.
  //
  // The host's own refusal for a request that names no file is behind this and cannot
  // be reached from here, because this is exactly the request that would reach it.
  // WorkbenchDroppedFileTests covers that one; between them nothing is unguarded.
  const invented = await evaluate(`(async () => {
    try {
      const file = new File([new Uint8Array(4)], 'Work.nendo');
      const request = { protocolVersion: 7, requestId: crypto.randomUUID(), method: 'file.openDropped', fileSessionId: null, payload: {} };
      chrome.webview.postMessageWithAdditionalObjects(request, [file]);
      return { crossed: true, message: null };
    } catch (error) { return { crossed: false, message: String(error) }; }
  })()`);
  assert(!invented.crossed,
    `The bridge carried a file the page invented; only a file somebody dropped may cross (${label}).`);
  assert(/not a file on the disk/i.test(invented.message ?? ''),
    `A page-made file was refused for a reason that is not about it being made up: "${invented.message}" (${label}).`);

  const chosenTheme = await evaluate(
    `document.querySelector('[data-theme-option][aria-pressed="true"]')?.dataset.themeOption ?? 'system'`);
  const edges = {};
  for (const theme of ['light', 'dark']) {
    await click(`[data-theme-option="${theme}"]`); await ready();
    await dispatch('dragenter', ['Work.nendo']);
    const drawn = await waitFor(overlay, `the drop hint in ${theme} (${label})`);
    assert(drawn.border !== 'rgba(0, 0, 0, 0)' && drawn.border !== '',
      `The drop hint has no visible edge in ${theme} (${label}).`);
    edges[theme] = drawn.border;
    await screenshot(`file-drop-${theme}-${label}.png`);
    await dispatch('dragleave', ['Work.nendo']);
    await waitFor(async () => await overlay() === null, `the drop hint to go in ${theme} (${label})`);
  }
  // The hint is drawn from theme tokens, so the two themes must not resolve to the
  // same ink: one of them would then be an accent colour left behind.
  assert(edges.light !== edges.dark,
    `The drop hint is the same colour in both themes, ${edges.light} (${label}).`);
  await click(`[data-theme-option="${chosenTheme}"]`); await ready();
}

/** Alt and an arrow key, as the window receives them. */
async function altArrow(key, windowsVirtualKeyCode) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await command('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers: 1 });
}

/**
 * The widened vocabulary, in the running application. Several roots per record
 * type are now selected by name, so each one is chosen explicitly rather than by
 * a board/list mode; tiles, tabs and the calendar each get their own check.
 */
async function assertTheWidenedSurfacesRun(label) {
  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='axiom'){s.value='axiom';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();

  // Every list, board and calendar root is its own named selector button.
  const buttons = await waitFor(async () => {
    // A picker button reads as its title followed by its kind in a <small>; the title is the first text node.
    const labels = await evaluate(`[...document.querySelectorAll('[data-select-surface]')].map(b=>b.firstChild?.textContent ?? b.textContent)`);
    return labels.length >= 4 ? labels : null;
  }, `the axiom surface selector (${label})`);
  for (const expected of ['Open axioms', 'Accepted axioms', 'Axioms by status', 'Accepted dates', 'Accepted over time', 'Axiom cards', 'Status against domain', 'Axioms by remit'])
    assert(buttons.includes(expected), `The selector does not offer ${expected} (${label}): ${buttons.join(', ')}`);

  // The board: a surface total above the window, and one total in each column.
  await clickFound(`document.querySelector('[data-select-surface="axiom-board"]')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('.board-column')`), `the axiom board (${label})`);
  // The columns carry their options' tones, not a hue hashed from the ID.
  const columnTones = await evaluate(`[...document.querySelectorAll('.board-column > header .status-dot')].map(e=>e.getAttribute('style') ?? '')`);
  assert(columnTones.some(style => style.includes('var(--tone-green)')) && columnTones.some(style => style.includes('var(--tone-orange)')),
    `The board columns do not carry the authored tones (${label}): ${columnTones.join(' | ')}`);
  const surfaceTotal = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('.use-surface > .summary-tiles .summary-value')?.textContent`);
    return value && value !== '\u2026' ? value : null;
  }, `the board surface total (${label})`);
  assert(surfaceTotal === '3', `The board total should count three axioms, showed ${surfaceTotal} (${label}).`);
  const columnTotals = await waitFor(async () => {
    const values = await evaluate(`[...document.querySelectorAll('.board-column .summary-value')].map(e=>e.textContent)`);
    return values.length > 0 && values.every(value => value !== '\u2026') ? values : null;
  }, `the board column totals (${label})`);
  // Accepted holds one axiom and Superseded one, and the totals are per column
  // rather than a count of the cards that happen to be loaded.
  assert(columnTotals.filter(value => value === '1').length >= 2,
    `The column totals do not separate the columns (${label}): ${columnTotals.join(', ')}`);

  // Choosing another surface is a targeted read of that surface. It used to
  // reload the whole derived view, refetching history and agent status for a
  // change of view, and one window per record type meant two lists shared a page.
  await evaluate(`(()=>{const b=window.chrome.webview; if(!b.__gateCounts){b.__gateCounts={}; const send=b.postMessage.bind(b); b.postMessage=m=>{b.__gateCounts[m.method]=(b.__gateCounts[m.method]??0)+1; return send(m);};} for (const key of Object.keys(b.__gateCounts)) delete b.__gateCounts[key];})()`);
  await clickFound(`document.querySelector('[data-select-surface="axiom-accepted-list"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 1`),
    `the accepted-only list (${label})`);
  const counts = await evaluate(`window.chrome.webview.__gateCounts`);
  assert(counts['data.queryRecords'] === 1,
    `Selecting a surface issued ${counts['data.queryRecords']} record reads, not one (${label}).`);
  for (const background of ['history.query', 'agent.getStatus', 'semantic.compile'])
    assert(counts[background] === undefined,
      `Selecting a surface refetched ${background} (${label}).`);

  // Returning to a surface loaded earlier in this revision re-reads nothing.
  await evaluate(`(()=>{const b=window.chrome.webview; for (const key of Object.keys(b.__gateCounts)) delete b.__gateCounts[key];})()`);
  await clickFound(`document.querySelector('[data-select-surface="axiom-open"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 2`),
    `the open list again (${label})`);
  assert((await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)) === undefined,
    `Returning to a cached surface re-read its records (${label}).`);
  await clickFound(`document.querySelector('[data-select-surface="axiom-accepted-list"]')`); await ready();

  // The breakdown by status on the board: one exact number per option in the
  // legend, the segments in the authored tones, and the table of the same numbers.
  await clickFound(`document.querySelector('[data-select-surface="axiom-board"]')`); await ready();
  const legend = await waitFor(async () => {
    const entries = await evaluate(`[...document.querySelectorAll('.use-surface > .summary-tiles .chart-bar .chart-legend li')].map(li=>li.textContent)`);
    return entries.length > 0 ? entries : null;
  }, `the status breakdown (${label})`);
  assert(legend.some(entry => entry.startsWith('Accepted') && entry.endsWith('1')) && legend.some(entry => entry.startsWith('Superseded') && entry.endsWith('1')),
    `The breakdown legend does not carry the statuses and their counts (${label}): ${legend.join(' | ')}`);
  assert(await evaluate(`[...document.querySelectorAll('.use-surface > .summary-tiles .chart-segment')].some(b=>(b.getAttribute('style')??'').includes('var(--tone-green)'))`),
    `The breakdown segments do not carry the authored tones (${label}).`);
  await clickFound(`document.querySelector('.use-surface > .summary-tiles [data-chart-table]')`);
  await waitFor(() => evaluate(`!!document.querySelector('.use-surface > .summary-tiles .chart-table')`), `the chart table (${label})`);
  assert(await evaluate(`[...document.querySelectorAll('.use-surface > .summary-tiles .chart-table td')].map(td=>td.textContent).includes('1')`),
    `The chart table does not repeat the numbers (${label}).`);

  // A segment drills into the first list, narrowed to its group as renderer state:
  // one record read, a pill naming the group, and the surface's totals stood down.
  await evaluate(`(()=>{const b=window.chrome.webview; for (const key of Object.keys(b.__gateCounts)) delete b.__gateCounts[key];})()`);
  await clickFound(`document.querySelector('.use-surface > .summary-tiles .chart-segment[data-chart-group="Accepted"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-testid="drill-pill"]')?.textContent?.includes('Status: Accepted')`), `the drill pill (${label})`);
  assert(await evaluate(`document.querySelector('[data-select-surface="axiom-open"]')?.getAttribute('aria-pressed') === 'true'`),
    `The drill did not open the first list (${label}).`);
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 1`), `the drilled list (${label})`);
  assert((await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)) === 1,
    `The drill issued ${await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)} record reads, not one (${label}).`);
  assert(!(await evaluate(`!!document.querySelector('.use-surface > .summary-tiles')`)),
    `The surface totals stayed up while the list was narrowed (${label}).`);
  await clickFound(`document.querySelector('[data-drill-clear]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 2 && !document.querySelector('[data-testid="drill-pill"]')`),
    `the list restored after the drill (${label})`);

  // The ring on the open list: accepted over open, drawn only once both counts answered.
  const ringText = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('.use-surface > .summary-tiles .chart-progress .chart-ring-text')?.textContent ?? null`);
    return value && !value.includes('\u2026') ? value : null;
  }, `the accepted ring (${label})`);
  assert(ringText === '1of 2', `The ring should read 1 of 2 open axioms, read ${JSON.stringify(ringText)} (${label}).`);

  // The calendar: a Monday-first month, its own state line and an undated view.
  await clickFound(`document.querySelector('[data-select-surface="axiom-calendar"]')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('.record-calendar .calendar-cell')`), `the calendar month (${label})`);
  assert(await evaluate(`document.querySelector('.calendar-weekdays span')?.textContent === 'Mon'`),
    `The calendar week does not start on Monday (${label}).`);
  assert(await evaluate(`document.querySelector('.calendar-state')?.textContent?.includes('loaded')`),
    `The calendar does not state how much of the month is loaded (${label}).`);
  await clickFound(`document.querySelector('[data-calendar-mode="undated"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-calendar-mode="undated"]')?.getAttribute('aria-pressed') === 'true'`),
    `the undated calendar view (${label})`);
  // Two axioms were never accepted, so they carry no date and are not lost.
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 2`),
    `the undated axioms (${label})`);

  // The timeline: this year as twelve month headings on a spine, read in one
  // request; the accepted axiom as a span in its tone, cut at the year end and
  // saying so; the state line and the scale note; the same undated view; and an
  // entry that opens the record page.
  await evaluate(`(()=>{const b=window.chrome.webview; for (const key of Object.keys(b.__gateCounts)) delete b.__gateCounts[key];})()`);
  await clickFound(`document.querySelector('[data-select-surface="axiom-timeline"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('.record-timeline .timeline-month').length === 12`), `the timeline year (${label})`);
  assert((await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)) === 1,
    `Selecting the timeline issued ${await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)} record reads, not one (${label}).`);
  const thisYear = String(new Date().getFullYear());
  assert(await evaluate(`document.querySelector('.timeline-year strong')?.textContent === '${thisYear}'`),
    `The timeline does not open on this year (${label}).`);
  assert(await evaluate(`document.querySelector('.timeline-state')?.textContent?.includes('loaded')`),
    `The timeline does not state how much of the year is loaded (${label}).`);
  assert(await evaluate(`document.querySelector('.timeline-note')?.textContent?.includes('drawn to scale')`),
    `The timeline does not state the scale its spans are drawn to (${label}).`);
  const spanText = await waitFor(() => evaluate(`document.querySelector('.timeline-entry .timeline-span-text')?.textContent ?? null`),
    `the accepted axiom's span (${label})`);
  assert(/\d+ days? shown; continues past 31 Dec \d{4}$/.test(spanText),
    `The span does not carry its day count and its cut (${label}): ${spanText}`);
  assert(await evaluate(`(document.querySelector('.timeline-entry')?.getAttribute('style') ?? '').includes('var(--tone-green)')`),
    `The timeline entry does not carry the accepted tone (${label}).`);
  const entryTitle = await evaluate(`document.querySelector('.timeline-entry .timeline-title')?.textContent`);
  assert(entryTitle === 'DATA-01', `The entry is not titled by the handle (${label}): ${entryTitle}`);
  await clickFound(`document.querySelector('[data-timeline-mode="undated"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelector('[data-timeline-mode="undated"]')?.getAttribute('aria-pressed') === 'true'`),
    `the undated timeline view (${label})`);
  await waitFor(() => evaluate(`document.querySelectorAll('.record-list [data-record-id]').length === 2`),
    `the undated axioms on the timeline (${label})`);
  await clickFound(`document.querySelector('[data-timeline-mode="dated"]')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('.timeline-entry[data-record-id]')`), `the timeline year again (${label})`);
  // The entry, its rail and its span in both themes: every colour on the spine is
  // a token, so Dark is the same markup under the other palette.
  await evaluate(`document.querySelector('.timeline-entry[data-record-id]').scrollIntoView({ block: 'center' })`);
  await screenshot(`timeline-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await screenshot(`timeline-dark-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  await clickFound(`document.querySelector('.timeline-entry[data-record-id]')`); await ready();
  await waitFor(() => evaluate(`document.querySelector('.record-inspector .record-hero h2')?.textContent === 'DATA-01'`),
    `the record page opened from the timeline (${label})`);
  await click('#close-inspector'); await ready();

  // The gallery: a card per record of exactly one list page, read in one request, with
  // the accepted axiom's tone on its edge and its confidence drawn as dots.
  await evaluate(`(()=>{const b=window.chrome.webview; for (const key of Object.keys(b.__gateCounts)) delete b.__gateCounts[key];})()`);
  await clickFound(`document.querySelector('[data-select-surface="axiom-gallery"]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('.record-gallery .record-card').length === 3`), `the axiom cards (${label})`);
  assert((await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)) === 1,
    `Selecting the gallery issued ${await evaluate(`window.chrome.webview.__gateCounts['data.queryRecords']`)} record reads, not one (${label}).`);
  assert(await evaluate(`[...document.querySelectorAll('.record-gallery .record-card')].some(card=>card.classList.contains('is-toned') && (card.getAttribute('style')??'').includes('var(--tone-green)'))`),
    `No card carries the accepted axiom's tone (${label}).`);
  // The rating reads as its dots and says its number for a screen reader.
  const rating = await waitFor(() => evaluate(`document.querySelector('.record-gallery .rating')?.getAttribute('aria-label') ?? null`),
    `the confidence rating on a card (${label})`);
  assert(rating === '4 of 5', `The card's rating should read 4 of 5, read ${JSON.stringify(rating)} (${label}).`);
  assert(await evaluate(`document.querySelectorAll('.record-gallery .rating .rating-dot').length === 5 &&
    document.querySelectorAll('.record-gallery .rating .rating-dot.is-filled').length === 4`),
    `The rating is not drawn as four filled dots of five (${label}).`);
  // A gallery takes a list's totals and a list's pager, unchanged.
  const galleryTotal = await waitFor(async () => {
    const value = await evaluate(`document.querySelector('.use-surface > .summary-tiles .summary-value')?.textContent`);
    return value && value !== '…' ? value : null;
  }, `the gallery total (${label})`);
  assert(galleryTotal === '3', `The gallery total should count three axioms, showed ${galleryTotal} (${label}).`);
  assert(await evaluate(`!!document.querySelector('.page-controls [data-record-page]')`),
    `The gallery does not offer the pager a list has (${label}).`);
  // Geometry, because a screenshot proves nothing on its own: the totals above the grid
  // start where the cards start, and cards in one row are one height. Both were wrong on
  // the first build — the tile's own margin outlived the gallery's override, and cards
  // sized to their content left a short one beside a tall one.
  const grid = await evaluate(`(()=>{const tile=document.querySelector('.use-surface > .summary-tiles');
    const cards=[...document.querySelectorAll('.record-gallery .record-card')];
    const row=cards.filter(card=>Math.abs(card.getBoundingClientRect().top-cards[0].getBoundingClientRect().top)<1);
    return {tileLeft:Math.round(tile.getBoundingClientRect().left),
      cardLeft:Math.round(cards[0].getBoundingClientRect().left),
      heights:row.map(card=>Math.round(card.getBoundingClientRect().height)),
      footers:row.map(card=>Math.round(card.querySelector('footer').getBoundingClientRect().bottom))};})()`);
  assert(grid.tileLeft === grid.cardLeft,
    `The totals start at ${grid.tileLeft} and the cards at ${grid.cardLeft} (${label}).`);
  assert(new Set(grid.heights).size === 1,
    `Cards in one row have different heights: ${grid.heights.join(', ')} (${label}).`);
  assert(new Set(grid.footers).size === 1,
    `Card footers sit on different baselines: ${grid.footers.join(', ')} (${label}).`);
  await evaluate(`document.querySelector('.record-gallery .record-card').scrollIntoView({ block: 'center' })`);
  await screenshot(`gallery-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await screenshot(`gallery-dark-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  // A card opens the record, and the form edits the rating as dots rather than as a
  // number nobody would recognise as a scale. The grid must not reflow while it does:
  // the inspector takes its space from the surface's scroll, not from the card widths,
  // or every card slides left under the pointer that opened one.
  const beforeInspector = await evaluate(`(()=>{const card=[...document.querySelectorAll('.record-gallery .record-card')].find(c=>c.textContent.includes('DATA-01'));
    return {card:Math.round(card.getBoundingClientRect().width),grid:Math.round(document.querySelector('.record-gallery').getBoundingClientRect().width)};})()`);
  await clickFound(`[...document.querySelectorAll('.record-gallery .record-card')].find(card=>card.textContent.includes('DATA-01'))`); await ready();
  await waitFor(() => evaluate(`document.querySelector('.record-inspector .record-hero h2')?.textContent === 'DATA-01'`),
    `the record page opened from a card (${label})`);
  assert(await evaluate(`document.querySelector('#record-form .rating-field input[value="4"]')?.checked === true`),
    `The record form does not carry the rating with its stored value chosen (${label}).`);
  const afterInspector = await evaluate(`(()=>{const card=[...document.querySelectorAll('.record-gallery .record-card')].find(c=>c.textContent.includes('DATA-01'));
    return {card:Math.round(card.getBoundingClientRect().width),grid:Math.round(document.querySelector('.record-gallery').getBoundingClientRect().width)};})()`);
  assert(afterInspector.card === beforeInspector.card && afterInspector.grid === beforeInspector.grid,
    `Opening a card reflowed the gallery: card ${beforeInspector.card} to ${afterInspector.card}, ` +
    `grid ${beforeInspector.grid} to ${afterInspector.grid} (${label}).`);
  // One value, one mark. The first build drew a dot beside the browser's own radio, so
  // each pill carried two circles of the same shape and the chosen value looked chosen
  // twice; the radio is the dot now, and nothing else round may join it in the pill.
  const marks = await evaluate(`(()=>{const picker=document.querySelector('#record-form .rating-field .rating-picker');
    const radio=picker.querySelector('input[value="4"]'), box=radio.getBoundingClientRect();
    const pill=radio.closest('label').getBoundingClientRect();
    return {pills:picker.querySelectorAll('label').length, radios:picker.querySelectorAll('input[type="radio"]').length,
      dots:picker.querySelectorAll('.rating-dot').length, appearance:getComputedStyle(radio).appearance,
      dotWidth:Math.round(box.width), dotHeight:Math.round(box.height), pillHeight:Math.round(pill.height)};})()`);
  assert(marks.pills === 6 && marks.radios === 6 && marks.dots === 0,
    `The rating offers ${marks.pills} pills with ${marks.radios} radios and ${marks.dots} separate dots (${label}).`);
  assert(marks.appearance === 'none',
    `The rating radio is drawn by the browser as well as by the stylesheet (${label}).`);
  // A dot is not a control sized for typing. The base rule gives every input a 39 pixel
  // minimum height and 8 by 10 padding, which turns the dot into an oval and the pill
  // into a box twice the height of the fields around it.
  assert(marks.dotWidth <= 13 && marks.dotHeight <= 13 && Math.abs(marks.dotWidth - marks.dotHeight) <= 1,
    `The rating dot is drawn ${marks.dotWidth} by ${marks.dotHeight}, not as a dot (${label}).`);
  assert(marks.pillHeight <= 32, `The rating pill stands ${marks.pillHeight} pixels tall (${label}).`);
  // A press that lands on a field's name and slides a few pixels swept a selection across
  // the whole form, which is what a form full of controls looks like being dragged
  // through. Names, legends and the rating's pills are chrome and start no selection;
  // the values stay selectable, because an ancestor's `none` reaches into a control and
  // would have taken away copying a record out of the page. WebView2 does not drive the
  // selection from CDP's synthetic mouse events, so the drag itself was reproduced in a
  // browser: this reads the rule off the elements it has to reach.
  const selectable = await evaluate(`(()=>{const of=(sel)=>getComputedStyle(document.querySelector(sel)).userSelect;
    return {name:of('#record-form label'), legend:of('#record-form .rating-field legend'),
      pill:of('#record-form .rating-picker label'), value:of('#record-form input[type="text"]'),
      note:of('#record-form textarea')};})()`);
  assert(selectable.name === 'none' && selectable.legend === 'none' && selectable.pill === 'none',
    `A drag over the form's chrome can still sweep it: ${JSON.stringify(selectable)} (${label}).`);
  assert(selectable.value === 'text' && selectable.note === 'text',
    `A record's values cannot be selected to copy: ${JSON.stringify(selectable)} (${label}).`);
  await evaluate(`document.querySelector('#record-form .rating-field').scrollIntoView({block:'center'})`);
  await screenshot(`rating-control-${label}.png`);
  await click('#close-inspector'); await ready();

  // The matrix (S6). The rule worth measuring is the one an eye cannot check on a
  // screenshot: every cell of the cross product is drawn, including the ones with nothing
  // in them. Three axioms hold three different pairs, so six of the nine cells are empty —
  // a grid that drew only the three with records in them would look entirely reasonable.
  // Chosen the way a person chooses it: the picker is opened with a pointer and the view
  // is clicked inside it. That puts the page under a hold -- an open details, then the
  // quiet window after the click -- which is the state every one of the owner's reports
  // about a screen that would not appear has been made in.
  await pointerClick('.surface-picker summary');
  await pointerClick('[data-select-surface="axiom-grid"]');
  await ready();
  // And then nothing. No click, no key, no scroll: the screen either draws what it read
  // or it does not, and a person who has to touch it to see their own data is the defect.
  const cells = await waitFor(async () => {
    const drawn = await evaluate(`[...document.querySelectorAll('.record-matrix .matrix-cell')].map(cell=>({
      empty:cell.classList.contains('is-empty'),
      total:cell.querySelector('.matrix-total strong')?.textContent ?? null,
      cards:cell.querySelectorAll('.record-card').length,
      label:cell.querySelector('.matrix-total')?.getAttribute('aria-label') ?? null}))`);
    return drawn.length > 0 ? drawn : null;
  }, `the status-against-domain matrix (${label})`);
  assert(cells.length === 18,
    `The matrix drew ${cells.length} cells, not the eighteen its three statuses and six columns cross to (${label}): ` +
    JSON.stringify(cells.map(cell => cell.label)));
  assert(cells.filter(cell => !cell.empty).length === 3,
    `Three axioms hold three different pairs; ${cells.filter(c => !c.empty).length} cells were drawn as filled (${label}).`);
  assert(cells.filter(cell => cell.empty).length === 15,
    `Fifteen cells are empty and must still be drawn: ${JSON.stringify(cells.map(c => `${c.label}=${c.total}`))} (${label}).`);
  assert(cells.every(cell => /^\d+ with .+ and .+$/.test(cell.label ?? '')),
    `Every cell names its own number and both lanes to a screen reader: ${JSON.stringify(cells.map(c => c.label))} (${label}).`);
  // An empty cell states 0, which is a number the read answered. The grid takes its lanes
  // from the definition and its numbers from the read, so a read that stopped answering
  // its empty cells would leave nine lanes drawn and six of them with nothing to state.
  // Without this the gate passed against exactly that defect, which is the whole reason
  // it is measured here rather than looked at.
  assert(cells.filter(cell => cell.empty).every(cell => cell.total === '0'),
    `An empty cell must state the zero the read answered, not an absence: ` +
    `${JSON.stringify(cells.filter(c => c.empty).map(c => c.total))} (${label}).`);
  // The number and the cards are two different quantities. Here they agree, so each
  // filled cell holds exactly the record its number counts.
  for (const cell of cells.filter(cell => !cell.empty))
    assert(cell.total === '1' && cell.cards === 1,
      `A filled cell states ${cell.total} and holds ${cell.cards} cards (${label}): ${cell.label}`);
  // The lanes. Every axiom has a status, so the unset row must not be drawn; one axiom has
  // no domain, so the unset column must be. Drawing a lane nobody arranged and nothing is
  // in spends a row and a column of screen saying nothing.
  const lanes = await evaluate(`(()=>{const headings=[...document.querySelectorAll('.record-matrix .matrix-heading')];
    const rows=headings.filter(h=>h.classList.contains('matrix-row-heading')).map(h=>h.textContent.trim());
    const columns=headings.filter(h=>!h.classList.contains('matrix-row-heading')).map(h=>h.textContent.trim());
    return {rows, columns};})()`);
  assert(lanes.rows.length === 3 && !lanes.rows.includes('Not set'),
    `The matrix drew ${lanes.rows.length} rows and every axiom has a status: ${JSON.stringify(lanes.rows)} (${label}).`);
  assert(lanes.columns.length === 6 && lanes.columns.includes('Not set'),
    `One axiom has no domain, so the unset column belongs beside the five: ${JSON.stringify(lanes.columns)} (${label}).`);
  // Geometry, because a screenshot of three columns proves nothing about five. A track
  // whose floor is its own content sizes to the widest card in it, so the grid grew to the
  // sum of its cards rather than to the window: the owner's five-column matrix was three
  // times the width of the screen, and the one row with anything in it was off the right
  // edge. The cards also scroll inside a cell rather than setting the height of their row.
  // Measured in a wide viewport, because that is where the defect lives. A track given a
  // share of the window grows with the window: on the owner's screen five columns of cards
  // were 650 pixels each, holding cards that wanted 300. The gate's own window is narrow
  // enough that every column sits on its floor, so measuring it as it comes says nothing.
  // Widening the surface changes the viewport, not the behaviour under test.
  const shape = await evaluate(`(()=>{const grid=document.querySelector('.record-matrix');
    const surface=grid.closest('.use-surface');
    surface.style.width='3000px';
    const stack=document.querySelector('.matrix-cell > .card-stack');
    const style=getComputedStyle(stack);
    const measured={
      columns:[...document.querySelectorAll('.record-matrix > .matrix-heading:not(.matrix-row-heading)')]
        .map(h=>Math.round(h.getBoundingClientRect().width)),
      cap:style.maxHeight, scrolls:style.overflowY,
      tallest:Math.max(...[...document.querySelectorAll('.matrix-cell')].map(c=>Math.round(c.getBoundingClientRect().height)))};
    surface.style.width='';
    return measured;})()`);
  assert(new Set(shape.columns).size === 1,
    `The columns are drawn at different widths, so a track is sizing to its content (${label}): ${JSON.stringify(shape.columns)}`);
  assert(shape.columns.every(width => width <= 300),
    `A column is drawn ${Math.max(...shape.columns)} wide in a wide window; a cell holds a card, not a share of the screen ` +
    `(${label}): ${JSON.stringify(shape.columns)}`);
  // The cap is a rule rather than an outcome here: this register puts one card in a cell,
  // so no row is tall enough to prove it. What a cell with thirty cards in it does stays
  // owner-reported until a fixture has one.
  assert(shape.cap !== 'none' && shape.scrolls === 'auto',
    `A cell's cards are not bounded, so the fullest cell sets the height of its row (${label}): ${JSON.stringify(shape)}`);
  await screenshot(`matrix-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await screenshot(`matrix-dark-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  // A cell drills with one predicate per axis, which is the only two-clause drill here
  // besides a bucket's two bounds. It lands on the record type's first list.
  await clickFound(`[...document.querySelectorAll('.record-matrix .matrix-total')].find(b=>!b.disabled)`); await ready();
  const drilled = await waitFor(async () => {
    const pill = await evaluate(`document.querySelector('[data-testid="drill-pill"]')?.textContent ?? null`);
    return pill === null ? null : pill;
  }, `the drill out of a matrix cell (${label})`);
  const drilledRows = await evaluate(`document.querySelectorAll('.record-list [data-record-id]').length`);
  assert(drilledRows === 1,
    `A cell holding one axiom drilled into ${drilledRows} records (${label}): ${JSON.stringify(drilled)}`);
  await clickFound(`document.querySelector('[data-drill-clear]')`); await ready();

  // The reference board (S7). The rule worth measuring is the one a screenshot cannot
  // check: a lane for the remit nobody has used. Three axioms all point at Data, so a
  // board that drew only the remits in use would show one full column and look right.
  await clickFound(`document.querySelector('[data-select-surface="axiom-remit-board"]')`); await ready();
  const lanesByRemit = await waitFor(async () => {
    const columns = await evaluate(`[...document.querySelectorAll('.record-board .board-column')].map(column=>({
      heading:column.querySelector('h3')?.textContent ?? null,
      ungrouped:column.dataset.groupUngrouped === 'true',
      cards:column.querySelectorAll('[data-record-id]').length,
      total:column.querySelector('.summary-value')?.textContent ?? null}))`);
    return columns.length > 0 && columns.every(column => column.total !== '\u2026') ? columns : null;
  }, `the board by remit (${label})`);
  const named = lanesByRemit.filter(column => !column.ungrouped);
  assert(named.length === 2,
    `The board drew ${named.length} remit columns, not the two remits the file holds (${label}): ${JSON.stringify(lanesByRemit)}`);
  // Headed by the reference's label field, not by the record ID the cards actually store.
  assert(named.map(column => column.heading).join(',') === 'Data,Interfaces',
    `The remit columns are not headed by their names in label order (${label}): ${JSON.stringify(named.map(c=>c.heading))}`);
  assert(named.find(column => column.heading === 'Data')?.cards === 3,
    `The Data lane does not hold the three axioms that point at it (${label}): ${JSON.stringify(named)}`);
  const empty = named.find(column => column.heading === 'Interfaces');
  assert(empty?.cards === 0 && empty?.total === '0',
    `The unused remit is not drawn as an empty lane stating zero (${label}): ${JSON.stringify(empty)}`);
  // Every axiom has a remit, so there is nothing unset to draw -- but a group-scoped tile
  // keeps the Ungrouped column, and its number has to be the honest zero.
  const ungrouped = lanesByRemit.find(column => column.ungrouped);
  assert(ungrouped === undefined || ungrouped.total === '0',
    `The Ungrouped lane states ${JSON.stringify(ungrouped?.total)} while every axiom has a remit (${label}).`);
  // A reference column carries no tone, because a tone is something an author put on an
  // option and a record has nowhere to hold one. It takes the hue the renderer already
  // derives for an option nobody coloured -- so the dot is set, and it is not a tone
  // token. Two records can derive nearby hues by chance, which is why the rule asserted
  // here is where the colour comes from rather than how different two of them look.
  const remitDots = await evaluate(`[...document.querySelectorAll('.board-column[data-group] > header .status-dot')].map(e=>e.getAttribute('style') ?? '')`);
  assert(remitDots.length === 2 && remitDots.every(style => /--status-color:\s*hsl\(/.test(style)),
    `The remit columns do not carry a derived hue (${label}): ${JSON.stringify(remitDots)}`);
  assert(remitDots.every(style => !style.includes('var(--tone-')),
    `A reference column carries a choice tone, which nothing stores for it (${label}): ${JSON.stringify(remitDots)}`);

  await screenshot(`reference-board-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await screenshot(`reference-board-dark-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);

  // Moving a card writes the reference, and a reference write is refused without the
  // target record's current version. The board holds it because it read the target type
  // to draw the lanes at all -- so this is the step that proves it kept it.
  //
  // Driven with a real pointer. element.click() dispatches no pointerdown, so a drag
  // driven that way never begins, and four gate steps in three days passed against
  // restored defects for want of one.
  const from = await evaluate(`(()=>{const column=[...document.querySelectorAll('.board-column')].find(c=>c.querySelector('h3')?.textContent==='Data');
    const card=column?.querySelector('[data-record-id]');
    const to=[...document.querySelectorAll('.board-column')].find(c=>c.querySelector('h3')?.textContent==='Interfaces');
    if(!card||!to) return null;
    const a=card.getBoundingClientRect(); const b=to.getBoundingClientRect();
    return {recordId:card.dataset.recordId, from:{x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2)},
      to:{x:Math.round(b.left+b.width/2),y:Math.round(b.top+40)}};})()`);
  assert(from !== null, `The board does not offer a card to drag between remits (${label}).`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.from.x, y: from.from.y, button: 'left', clickCount: 1, buttons: 1 });
  // Two moves: the first passes the threshold that tells a drag from a click, the second
  // lands on the target lane.
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.from.x + 24, y: from.from.y + 12, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.to.x, y: from.to.y, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.to.x, y: from.to.y, button: 'left', clickCount: 1, buttons: 0 });
  await ready();
  const moved = await waitFor(async () => {
    const columns = await evaluate(`[...document.querySelectorAll('.record-board .board-column')].map(column=>({
      heading:column.querySelector('h3')?.textContent ?? null,
      cards:[...column.querySelectorAll('[data-record-id]')].map(card=>card.dataset.recordId)}))`);
    const target = columns.find(column => column.heading === 'Interfaces');
    return target && target.cards.includes(from.recordId) ? columns : null;
  }, `the card to move into the empty remit (${label})`).catch(() => null);
  assert(moved !== null,
    `Dragging a card between reference columns did not move it (${label}); the write needs the target's version, which the board read with the columns.`);
  assert(moved.find(column => column.heading === 'Data').cards.length === 2,
    `The card is in both lanes after the move (${label}): ${JSON.stringify(moved.map(c=>({heading:c.heading,cards:c.cards.length})))}`);

  // Put it back, which is not tidiness: this lane runs twice over one file, and a step
  // that leaves the fixture changed makes every assertion after it depend on whether it
  // ran. It also drags the other way, out of a lane holding one card into a lane holding
  // two, against a target version this board read after the first move rather than before.
  const back = await evaluate(`(()=>{const card=document.querySelector('[data-record-id=${JSON.stringify(from.recordId)}]');
    const to=[...document.querySelectorAll('.board-column')].find(c=>c.querySelector('h3')?.textContent==='Data');
    if(!card||!to) return null;
    const a=card.getBoundingClientRect(); const b=to.getBoundingClientRect();
    return {from:{x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2)},
      to:{x:Math.round(b.left+b.width/2),y:Math.round(b.top+40)}};})()`);
  assert(back !== null, `The moved card is not on the board to move back (${label}).`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: back.from.x, y: back.from.y, button: 'left', clickCount: 1, buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: back.from.x + 24, y: back.from.y + 12, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: back.to.x, y: back.to.y, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: back.to.x, y: back.to.y, button: 'left', clickCount: 1, buttons: 0 });
  await ready();
  const restored = await waitFor(async () => {
    const columns = await evaluate(`[...document.querySelectorAll('.record-board .board-column')].map(column=>({
      heading:column.querySelector('h3')?.textContent ?? null,
      cards:column.querySelectorAll('[data-record-id]').length}))`);
    const data = columns.find(column => column.heading === 'Data');
    return data && data.cards === 3 ? columns : null;
  }, `the card to move back into Data (${label})`).catch(() => null);
  assert(restored !== null, `The card did not move back, so this lane leaves the file changed (${label}).`);
  assert(restored.find(column => column.heading === 'Interfaces').cards === 0,
    `The empty remit is not empty again (${label}): ${JSON.stringify(restored)}`);

  // The front page, which is the one screen in this file that reads two record
  // types. It is chosen beside the record types rather than among one type's
  // surfaces, because it is not one of them.
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); s.value=''; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await ready();
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="overview-page"]')`), `the front page (${label})`);
  assert(await evaluate(`(document.querySelector('.overview-description')?.textContent ?? '').includes('Every axiom this project has accepted')`),
    `The front page does not say what the file is for (${label}).`);
  // Every number on it is read over a whole record type, so each is waited for and
  // then checked against a count made here rather than taken from the screen.
  const frontCount = await waitFor(async () => {
    const value = await evaluate(`[...document.querySelectorAll('.overview-page .summary-tile')].find(t=>t.textContent.includes('Axioms'))?.querySelector('.summary-value')?.textContent`);
    return value && value !== '\u2026' ? value : null;
  }, `the axiom count on the front page (${label})`);
  assert(frontCount === '3', `The front page counts ${frontCount} axioms, not 3 (${label}).`);
  const frontRing = await waitFor(() => evaluate(`document.querySelector('.overview-page .chart-progress .chart-ring-text')?.textContent ?? null`),
    `the accepted ring on the front page (${label})`);
  assert(frontRing === '1of 3',
    `The front page ring reads ${JSON.stringify(frontRing)}, not one accepted of three (${label}).`);
  // A range states both ends or neither. One axiom carries an accepted date, so
  // both ends are that date: a range of one value is still a range, and drawing
  // one end alone would state a bound as though it were a span.
  const range = await waitFor(async () => {
    const ends = await evaluate(`[...document.querySelectorAll('.overview-page .chart-range .range-end')].map(e=>e.textContent)`);
    return ends.length === 2 ? ends : null;
  }, `the accepted-date range on the front page (${label})`);
  // Read as the date, not as the raw lexeme: the host answers a civil date as a
  // JSON string, and the quotes are the lexeme's rather than the date's.
  assert(range.every(end => /^\d{4}-\d{2}-\d{2}$/.test(end)),
    `The front page range does not state two civil dates: ${JSON.stringify(range)} (${label}).`);
  // The second record type, which is the whole reason a front page exists.
  const remits = await waitFor(async () => {
    const rows = await evaluate(`[...document.querySelectorAll('.overview-page .recent-list .recent-row strong')].map(r=>r.textContent)`);
    return rows.length > 0 ? rows : null;
  }, `the remits on the front page (${label})`);
  assert(remits.includes('Data'), `The front page does not list the remits: ${JSON.stringify(remits)} (${label}).`);
  // Over time (S5). The rule worth measuring is the one an eye cannot check on a
  // screenshot: every bucket of the range is drawn, including the ones with nothing
  // in them. One axiom is accepted, so exactly one of the twelve months carries a
  // number and eleven are empty — a chart that drew only the month with records
  // would look completely reasonable and be wrong.
  const trend = await waitFor(async () => {
    const columns = await evaluate(`[...document.querySelectorAll('.overview-page .chart-trend .chart-column')].map(c=>({empty:c.classList.contains('is-empty'),label:c.getAttribute('aria-label')}))`);
    return columns.length > 0 ? columns : null;
  }, `the accepted-by-month trend on the front page (${label})`);
  assert(trend.length === 12,
    `The trend drew ${trend.length} months, not the twelve its range covers (${label}): ${JSON.stringify(trend.map(c=>c.label))}`);
  assert(trend.filter(column => !column.empty).length === 1,
    `Exactly one month holds the accepted axiom; ${trend.filter(c=>!c.empty).length} months were drawn as filled (${label}).`);
  assert(trend.filter(column => column.empty).length === 11,
    `Eleven months are empty and must still be drawn: ${JSON.stringify(trend.map(c=>c.label))} (${label}).`);
  assert(trend.every(column => /: (\d+|none)$/.test(column.label ?? '')),
    `Every column names its own number to a screen reader: ${JSON.stringify(trend.map(c=>c.label))} (${label}).`);
  // The newest bucket keeps its label. Half the labels are hidden so twelve months fit,
  // and hiding them from the start hid the twelfth -- the only column with a number in it
  // and the one a person is looking at. The owner caught that on the planner's front page.
  const newest = await evaluate(`(()=>{const columns=[...document.querySelectorAll('.overview-page .chart-trend .chart-column')];
    const last=columns[columns.length-1]?.querySelector('.chart-column-label');
    return last === null || last === undefined ? null : {text:last.textContent, hidden:getComputedStyle(last).visibility === 'hidden'};})()`);
  assert(newest !== null && !newest.hidden,
    `The newest month's label is hidden, which is the one a person reads (${label}): ${JSON.stringify(newest)}`);
  assert(/^[A-Z][a-z]{2} \d{4}$/.test(newest.text ?? ''),
    `The newest month's label does not name a month: ${JSON.stringify(newest)} (${label}).`);

  // The grid: a year of days, one square each, and a quiet day is its own tone step
  // rather than absent. A leap year is 366, which is exactly the published ceiling.
  const days = await waitFor(async () => {
    const squares = await evaluate(`[...document.querySelectorAll('.overview-page .chart-activity .chart-grid .chart-day:not(.is-blank)')].map(d=>d.getAttribute('data-level'))`);
    return squares.length > 0 ? squares : null;
  }, `the accepted-this-year grid on the front page (${label})`);
  const gridYear = new Date().getUTCFullYear();
  const expectedDays = (gridYear % 4 === 0 && gridYear % 100 !== 0) || gridYear % 400 === 0 ? 366 : 365;
  assert(days.length === expectedDays,
    `The activity grid drew ${days.length} squares, not the ${expectedDays} days of ${gridYear} (${label}).`);
  assert(days.filter(level => level !== '0').length === 1,
    `Exactly one day holds the accepted axiom; ${days.filter(l=>l!=='0').length} days were toned (${label}).`);
  // Geometry, because the eye reads a contribution graph by its shape: seven rows, one
  // per weekday, so a year is columns of weeks. Any other row count is a different chart
  // wearing the same squares, and a screenshot of it looks perfectly fine.
  const gridShape = await evaluate(`(()=>{const squares=[...document.querySelectorAll('.overview-page .chart-activity .chart-grid .chart-day')];
    return {rows:new Set(squares.map(s=>Math.round(s.getBoundingClientRect().top))).size,
      columns:new Set(squares.map(s=>Math.round(s.getBoundingClientRect().left))).size};})()`);
  assert(gridShape.rows === 7,
    `The activity grid drew ${gridShape.rows} rows, not the seven weekdays a year of weeks has (${label}): ${JSON.stringify(gridShape)}`);
  // A row is a weekday, which is the whole of what makes a column a week. Filling seven
  // rows from the first day of the range instead put a Tuesday in the sixth row, which
  // looks exactly as tidy and means nothing.
  const tonedRow = await evaluate(`(()=>{const squares=[...document.querySelectorAll('.overview-page .chart-activity .chart-grid > *')];
    const tops=[...new Set(squares.map(s=>Math.round(s.getBoundingClientRect().top)))].sort((a,b)=>a-b);
    const toned=squares.find(s=>s.getAttribute('data-level') && s.getAttribute('data-level') !== '0');
    return toned === undefined ? null : {row:tops.indexOf(Math.round(toned.getBoundingClientRect().top)) + 1,
      label:toned.getAttribute('aria-label')};})()`);
  assert(tonedRow !== null, `No day was toned, so the weekday row cannot be checked (${label}).`);
  const tonedDate = new Date(`${(tonedRow.label ?? '').split(':')[0]} UTC`);
  const expectedRow = ((tonedDate.getUTCDay() + 6) % 7) + 1;
  assert(tonedRow.row === expectedRow,
    `The toned day sits in row ${tonedRow.row}; its weekday puts it in row ${expectedRow} (${label}): ${JSON.stringify(tonedRow)}`);

  // The ranking (S6). Three axioms, one of which carries a confidence: a record with no
  // number is not ranked, so this is one row rather than three with two blanks at the
  // bottom. The predicate that does it is the host's, not the author's.
  const ranked = await waitFor(async () => {
    const rows = await evaluate(`[...document.querySelectorAll('.overview-ranked .ranked-row')].map(row=>({
      numeral:row.querySelector('.ranked-numeral')?.textContent ?? null,
      value:row.querySelector('.ranked-value')?.textContent ?? null,
      title:row.querySelector('strong')?.textContent ?? null,
      fill:Math.round(row.querySelector('.ranked-bar-fill')?.getBoundingClientRect().width ?? -1),
      track:Math.round(row.querySelector('.ranked-bar')?.getBoundingClientRect().width ?? -1),
      label:row.getAttribute('aria-label')}))`);
    return rows.length > 0 ? rows : null;
  }, `the most-confident ranking on the front page (${label})`);
  assert(ranked.length === 1,
    `The ranking drew ${ranked.length} rows; only one axiom carries a confidence, and a record with ` +
    `no number is not ranked (${label}): ${JSON.stringify(ranked.map(row => row.title))}`);
  assert(ranked[0].title === 'DATA-01',
    `The ranking's first row is ${JSON.stringify(ranked[0].title)}, not the axiom with the confidence (${label}).`);
  assert(ranked[0].numeral === '1', `The first row carries numeral ${JSON.stringify(ranked[0].numeral)} (${label}).`);
  // The top row fills its row: its value is the exact largest, so the bar is the whole
  // track. A bar drawn against the page rather than against the maximum would be shorter
  // or longer and look just as plausible.
  assert(ranked[0].fill === ranked[0].track,
    `The top row's bar is ${ranked[0].fill} of a ${ranked[0].track} track; it holds the largest value (${label}).`);
  assert(/^DATA-01, ranked 1, /.test(ranked[0].label ?? ''),
    `The ranked row does not name its rank and its number to a screen reader: ${JSON.stringify(ranked[0].label)} (${label}).`);
  await screenshot(`ranking-${label}.png`);

  // A redraw of the same screen keeps the reader's place. Every renderer replaces the
  // content pane's markup, which sets scroll back to the top -- invisible while a redraw
  // only ever followed something the person had just done, and not invisible at all once
  // screens began redrawing on their own account. The owner was reading the bottom of this
  // page and it hauled them back up.
  //
  // A real redraw rather than a hook into the app: the chart table toggle rebuilds the page
  // exactly as an automatic refresh does, and is reachable the way a person reaches it.
  const scrolled = await evaluate(`(()=>{const pane=document.querySelector('#studio-content');
    pane.scrollTop = Math.max(40, Math.floor((pane.scrollHeight - pane.clientHeight) / 2));
    return {to: pane.scrollTop, place: pane.dataset.place ?? null,
      toggles: document.querySelectorAll('.overview-page [data-chart-table]').length};})()`);
  assert(scrolled.place !== null,
    `The content pane does not say which screen it shows, so a redraw cannot tell a repaint from a move (${label}).`);
  if (scrolled.to > 0) {
    assert(scrolled.toggles > 0, `The front page has nothing to redraw it with (${label}).`);
    await clickFound(`document.querySelector('.overview-page [data-chart-table]')`);
    await ready();
    const keptPlace = await evaluate(`(()=>{const pane=document.querySelector('#studio-content');
      return {after: pane.scrollTop, place: pane.dataset.place ?? null};})()`);
    assert(keptPlace.place === scrolled.place, `The redraw changed screens, so this proves nothing (${label}).`);
    assert(keptPlace.after === scrolled.to,
      `A redraw moved the reader: scrolled to ${scrolled.to} and came back at ${keptPlace.after} (${label}).`);
    await clickFound(`document.querySelector('.overview-page [data-chart-table]')`);
    await ready();
    await evaluate(`document.querySelector('#studio-content').scrollTop = 0`);
    await ready();
  }

  // Geometry, because a screenshot proves nothing on its own: the front page starts
   // where the toolbar's controls start, as every other surface does. The first build
   // set no horizontal inset at all, so the title, the description and every tile sat
   // outside the line the rest of the app is drawn to — which the owner saw in the
   // screenshot the gate had already passed.
  const inset = await evaluate(`(()=>{const left=el=>Math.round(el.getBoundingClientRect().left);
    return {toolbar:left(document.querySelector('.use-toolbar .select-field')),
      heading:left(document.querySelector('.overview-header h2')),
      description:left(document.querySelector('.overview-description')),
      tile:left(document.querySelector('.overview-page .summary-tile, .overview-page .chart-tile'))};})()`);
  assert(inset.heading === inset.toolbar && inset.description === inset.toolbar && inset.tile === inset.toolbar,
    `The front page is not drawn to the same left edge as the toolbar above it: ${JSON.stringify(inset)} (${label}).`);
  await screenshot(`overview-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await screenshot(`overview-dark-${label}.png`);
  // The two charts over time sit below the fold of the page above, so they get their
  // own pair: a capture that cannot show a thing is not evidence about it.
  await evaluate(`document.querySelector('.overview-page .chart-trend')?.scrollIntoView({block:'center'})`);
  await screenshot(`overview-over-time-dark-${label}.png`);
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  await screenshot(`overview-over-time-${label}.png`);
  await evaluate(`document.querySelector('[data-testid="overview-page"]')?.scrollIntoView({block:'start'})`);
  // A chart on the front page drills into the record type it reads, which means
  // leaving the front page: the narrowed list belongs to that type.
  // A trend column drills by the two ends of its own month, which is the only drill
  // in the product that spends two clauses rather than one.
  await clickFound(`document.querySelector('.overview-page .chart-trend .chart-column:not(.is-empty)')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="drill-pill"]')`), `the drill pill from the trend (${label})`);
  const monthPill = await evaluate(`document.querySelector('[data-testid="drill-pill"]')?.textContent ?? ''`);
  assert(/Accepted: [A-Z][a-z]{2} \d{4}/.test(monthPill),
    `The trend drill does not name the month it narrowed to: ${JSON.stringify(monthPill)} (${label}).`);
  // Not a record count: the list a drill opens carries its own authored filters, so
  // what is asserted is that the month narrowed it at all and said which month.
  assert(await evaluate(`!document.querySelector('[data-testid="overview-page"]')`),
    `Drilling from the trend left the front page on screen beside the list it opened (${label}).`);
  await clickFound(`document.querySelector('[data-drill-clear]')`); await ready();
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="drill-pill"]')`), `the trend drill cleared (${label})`);
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if(s && s.value!=='__overview'){s.value='__overview';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await ready();
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="overview-page"]')`), `the front page again (${label})`);

  await clickFound(`document.querySelector('.overview-page .chart-bar .chart-segment')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="drill-pill"]')`), `the drill pill from the front page (${label})`);
  assert(await evaluate(`!document.querySelector('[data-testid="overview-page"]')`),
    `Drilling from the front page left it on screen beside the list it opened (${label}).`);
  await clickFound(`document.querySelector('[data-drill-clear]')`); await ready();
  await waitFor(() => evaluate(`!document.querySelector('[data-testid="drill-pill"]')`), `the drill cleared (${label})`);

  // Named tabs on the axiom record page, with the fields at their authored tabs.
  await clickFound(`document.querySelector('[data-select-surface="axiom-open"]')`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('.record-list [data-record-id]')`), `the open-axiom list (${label})`);
  await clickFound(`document.querySelector('.record-list [data-record-id]')`); await ready();
  await waitFor(() => evaluate(`document.querySelectorAll('#record-form [role="tab"]').length === 2`), `the axiom tabs (${label})`);
  // The record-page header: the handle heads the page, the statement sits under it,
  // and when the record has a status the band carries its tone.
  assert(await evaluate(`(document.querySelector('.record-inspector .record-hero h2')?.textContent ?? '').length > 0`),
    `The record page has no header title (${label}).`);
  assert(await evaluate(`!!document.querySelector('.record-inspector .record-hero p')`),
    `The record page header has no subtitle (${label}).`);
  const hero = await evaluate(`(()=>{const status=document.querySelector('#record-form [name="axiom-status"]')?.value ?? ''; const style=document.querySelector('.record-inspector .record-hero')?.getAttribute('style') ?? ''; return { status, style };})()`);
  assert(hero.status === '' || hero.style.includes('var(--tone-'),
    `The record page header is not coloured by the status tone (${label}): ${JSON.stringify(hero)}`);
  const tabs = await evaluate(`[...document.querySelectorAll('#record-form [role="tab"]')].map(b=>b.textContent)`);
  assert(tabs.join(',') === 'Status,Dates', `The tabs are ${tabs.join(',')}, not the authored sections (${label}).`);
  assert(await evaluate(`document.querySelectorAll('#record-form [role="tabpanel"]:not([hidden])').length === 1`),
    `More than one tab panel is open at once (${label}).`);
  // An unsaved value in the tab being left is still in the form afterwards:
  // a tab change is a visibility change, not a re-render.
  await evaluate(`(()=>{const c=document.querySelector('#record-form [name="axiom-status"]'); c.value='Accepted'; c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await clickFound(`document.querySelectorAll('#record-form [role="tab"]')[1]`); await ready();
  assert(await evaluate(`document.querySelector('#record-form [role="tabpanel"]:not([hidden])')?.getAttribute('aria-labelledby')?.includes('dates')`),
    `The second tab did not open (${label}).`);
  assert(await evaluate(`document.querySelector('#record-form [name="axiom-status"]')?.value === 'Accepted'`),
    `A tab change discarded the unsaved value (${label}).`);
  assert(await evaluate(`!!document.querySelector('#record-form [name="axiom-accepted"]')`),
    `The Dates tab does not carry the accepted date (${label}).`);
  await click('#close-inspector'); await ready();
}

/**
 * A section can be folded away (ADR-0004, 2026-09-20 amendment; W-040). Measured, not
 * looked at. Two sections in this file start closed: Lately on the front page and More
 * on the Remit page, each holding the one tile on its page that counts remits. So a
 * `data.countRecords` for remits crossing the bridge while the section is closed is a
 * read the fold should have saved, and its absence is the fold doing its job. The
 * bridge is watched the way the outcome lane watches it, then the page is redrawn from
 * scratch so the reads that would happen do happen. The heading is pressed with a real
 * pointer and once from the keyboard; both themes are captured with the section open.
 * On the built file the section is left open; the reopened file finds it closed again,
 * which is the stored default winning over what the person did before the file closed.
 */
async function watchBridge() {
  // Installed once the page has loaded and before any surface is drawn, so the log
  // covers every read a draw made. The gate's own requests speak protocol 6 and the
  // Workbench speaks 7, which is how the two are told apart in the log.
  await evaluate(`(()=>{ if (window.__gateBridge) return;
    const b=chrome.webview, send=b.postMessage.bind(b); window.__gateBridge=[];
    b.postMessage=(m)=>{ try { window.__gateBridge.push({method:m.method, entityId:m.payload?.entityId ?? null, protocolVersion:m.protocolVersion ?? null}); } catch {} send(m); }; })()`);
}

async function assertAFoldedSectionReadsNothingUntilOpened(label) {
  await watchBridge();
  const remitCounts = () => evaluate(`window.__gateBridge.filter(m=>m.protocolVersion===7&&m.method==='data.countRecords'&&m.entityId==='remit').length`);
  const clearBridge = () => evaluate(`void (window.__gateBridge.length = 0)`);
  // Everything drawn since the page loaded is the measurement: the front page and the
  // Remit page have both been drawn by now, each with a closed section holding the one
  // tile on it that counts remits, and nothing else on either page counts them.
  await click('#nav-use'); await ready();
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); if (s.value !== '') { s.value=''; s.dispatchEvent(new Event('change',{bubbles:true})); }})()`); await ready();
  await waitFor(() => evaluate(`!!document.querySelector('[data-testid="overview-page"]')`), `the front page for the fold (${label})`);
  const lately = 'details[data-section="front-lately"]';
  const state = () => evaluate(`(()=>{const d=document.querySelector('${lately}'); if(!d) return null;
    const heading=d.querySelector('summary'), tile=d.querySelector('.summary-tile');
    return {open:d.open, heading:heading?.getBoundingClientRect().height ?? -1, tile:tile ? tile.checkVisibility() : null, value:tile?.querySelector('.summary-value')?.textContent ?? null};})()`);
  const closed = await state();
  assert(closed !== null, `The front page has no Lately section (${label}).`);
  assert(!closed.open && closed.heading > 0 && closed.tile === false,
    `Lately does not start closed with its heading showing and its tile not drawn (${label}): ${JSON.stringify(closed)}`);
  await sleep(3000);
  assert(await remitCounts() === 0,
    `A closed section was read anyway: the remit count crossed the bridge while Lately was closed (${label}).`);
  const expectedRemits = String((await host('data.countRecords', { entityId: 'remit', filters: [] })).count);

  // Opened with a real pointer: the read happens now, and the number is the host's.
  await pointerClickInView(`${lately} > summary`);
  const opened = await waitFor(async () => { const s = await state(); return s?.open && s.value && s.value !== '…' ? s : null; },
    `the remit count in the opened section (${label})`);
  assert(opened.value === expectedRemits && opened.tile === true,
    `The opened section shows ${JSON.stringify(opened)}, not ${expectedRemits} remits drawn (${label}).`);
  assert(await remitCounts() >= 1, `Opening the section read nothing for its tile (${label}).`);

  // Folded again: the value it has stays, and nothing more is read on the next chase.
  await pointerClickInView(`${lately} > summary`);
  await waitFor(async () => { const s = await state(); return s && !s.open ? s : null; }, `Lately folded again (${label})`);
  await clearBridge();
  await sleep(2500);
  assert(await remitCounts() === 0, `A folded section went on being read after the chase interval (${label}).`);

  // From the keyboard: the heading is a control, so Enter opens it.
  await evaluate(`document.querySelector('${lately} > summary').focus()`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const byKey = await waitFor(async () => { const s = await state(); return s?.open ? s : null; }, `Lately opened from the keyboard (${label})`);
  assert(byKey.value === expectedRemits, `The reopened section lost its number (${label}): ${JSON.stringify(byKey)}`);
  await evaluate(`document.querySelector('${lately}').scrollIntoView({ block: 'center' })`);
  for (const theme of ['light', 'dark']) {
    await click(`[data-theme-option="${theme}"]`);
    const drawn = await evaluate(`(()=>{const h=document.querySelector('${lately} > summary'); const cs=getComputedStyle(h);
      return {height:h.getBoundingClientRect().height, visibility:cs.visibility, color:cs.color, background:getComputedStyle(document.body).backgroundColor};})()`);
    assert(drawn.height > 0 && drawn.visibility === 'visible' && drawn.color !== drawn.background,
      `The fold heading is not readable in ${theme} (${label}): ${JSON.stringify(drawn)}`);
    await screenshot(`folded-section-${theme}-${label}.png`);
  }

  // The same on a record page, where the fold must not redraw the form: the More
  // section on the Data remit's page holds a page tile counting remits.
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); s.value='remit'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await ready();
  await clearBridge();
  await clickFound(`[...document.querySelectorAll('.record-list [data-record-id]')].find(row=>row.textContent.includes('Data'))`, "the Data remit's row");
  await waitFor(() => evaluate(`!!document.querySelector('.record-inspector details[data-section="remit-more"]')`), `the Data remit's page with its folded section (${label})`);
  await sleep(3000);
  const more = 'details[data-section="remit-more"]';
  assert(await evaluate(`!document.querySelector('${more}').open`), `More does not start closed on the remit page (${label}).`);
  assert(await remitCounts() === 0, `The remit page read its folded section's tile (${label}).`);
  // Typing survives the fold, because the fold patches rather than redraws.
  await evaluate(`(()=>{const c=document.querySelector('#record-form [name="remit-name"]'); c.value='Data (typed)'; c.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pointerClickInView(`${more} > summary`);
  const pageTile = await waitFor(() => evaluate(`(()=>{const v=document.querySelector('${more} .summary-tile .summary-value')?.textContent; return v && v !== '…' ? v : null;})()`),
    `the remit count in the remit page's opened section (${label})`);
  assert(pageTile === expectedRemits, `The remit page's folded tile shows ${pageTile}, not ${expectedRemits} (${label}).`);
  assert(await evaluate(`document.querySelector('#record-form [name="remit-name"]')?.value === 'Data (typed)'`),
    `Opening a section on the record page discarded the typing (${label}).`);
  await evaluate(`(()=>{const c=document.querySelector('#record-form [name="remit-name"]'); c.value='Data'; c.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('#close-inspector'); await ready();
  // Back to the front page, with Lately open for the reopened phase to find closed.
  await evaluate(`(()=>{const s=document.querySelector('#use-entity'); s.value=''; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await ready();
  assert(await evaluate(`document.querySelector('${lately}')?.open === true`), `The fold was forgotten within the session (${label}).`);
}

try {
  await connect();
  await command('Runtime.enable');
  await ready();
  await snapshot();

  if (phase === 'build') {
    const client = await attachAgent('p6-axiom-register-gate');
    await authorAsAgent(client, ['detailSurface', 'section', 'relatedList', 'filterClause', 'recordCommand', 'commandStep', 'summaryTile', 'timelineSurface', 'gallerySurface', 'overviewSurface', 'recentList', 'rangeTile', 'trendChart', 'activityGrid']);
    // Before the first Remit exists, because after seedRecords there is no way back to a
    // record type with nothing in it.
    await assertAnEmptyTargetTypeExplainsItself();
    await seedRecords(client);
    // W-034, and it has to be here: agent access is turned off on the next line, so this
    // is the only moment in the run when a surface is on screen and MCP can write.
    await assertTheScreenFollowsAnAgentsWrite(client);
    await host('agent.setMode', { mode: 'off' });
    await command('Page.reload'); await sleep(400); await ready(); await snapshot();
    // Before the bridge watcher: this folds the rail and reloads the page to see whether
    // the fold survived, which would take a listener installed first away with it.
    await assertTheRailFoldsToItsIcons('built');
    await watchBridge();

    await assertRegisterRuns('built');
    await assertAFoldedSectionReadsNothingUntilOpened('built');
    await screenshot('register-built.png');
  } else {
    await watchBridge();
    // Offline after the agent is gone: the application is the file, not the agent.
    const status = await host('agent.getStatus');
    assert(status.mode === 'off' || status.mode === 'disabled', `Agent access should be off after reopen, saw ${status.mode}.`);
    // Opening a file that has a front page opens on the front page, without being
    // asked for it. This is the one assertion that has to run before anything else
    // touches Use: the decision belongs to opening the file, and it was once made
    // at a single call site that only the cold-start path went through, so every
    // other way of opening a file landed on a record type instead.
    await click('#nav-use'); await ready();
    await waitFor(() => evaluate(`!!document.querySelector('[data-testid="overview-page"]')`),
      'the front page to open by itself on a reopened file');
    assert(await evaluate(`document.querySelector('#use-entity')?.value === ''`),
      'The front page is drawn but the picker does not say so.');
    await assertRegisterRuns('reopened');
    // The fold left open on the built file is closed again here: the stored default
    // outlives the session, and what the person did does not (F-027).
    await assertAFoldedSectionReadsNothingUntilOpened('reopened');
    await screenshot('register-reopened.png');
    // Last, because it adds an axiom and every assertion that counts them has run.
    await assertARelatedRecordIsAddedAndOpenedWithoutLeavingThePage('reopened');
    // After it, because the trail it walks is the one those steps built, and because it
    // deletes the axiom they added.
    await assertBackAndForwardWalkTheTrail('reopened');
    // The three defects the 2026-09-19 bug hunt confirmed on record pages (W-049, W-050,
    // W-051), in this order: the picker's search on an axiom page, then a related row
    // that has gone on the remit page while its relation still has three rows, and last
    // the moves off a page holding typing -- which gives the relation forty-eight more
    // rows, so nothing that counts them can run after it.
    await assertAPickerSearchLeavesNothingUnsaved('reopened');
    await assertARelatedRowWhoseRecordHasGoneSaysSo('reopened');
    await assertUnsavedTypingSurvivesEveryMoveOffThePage('reopened');
    // Last of all: it leaves a refusal on screen and changes the theme twice, so
    // nothing that reads the page should run after it.
    await assertADraggedFileIsAnsweredBeforeItLands('reopened');
  }

  assert(pageErrors.length === 0, `Renderer errors: ${pageErrors.join(' | ')}`);
  await fs.writeFile(path.join(output, `gate-${phase}.json`), JSON.stringify({ phase, result: 'passed' }, null, 2));
  console.log(`P6-F axiom register ${phase} passed.`);
  process.exit(0);
} catch (error) {
  console.error(`P6-F axiom register ${phase} failed: ${error.message}`);
  if (pageErrors.length > 0) console.error(`Renderer errors: ${pageErrors.join(' | ')}`);
  try { await screenshot(`failure-${phase}.png`); } catch { /* the page may be gone */ }
  // What the page was doing when it failed, because a timeout names what the script
  // waited for and not what held it: the focused control, the open disclosures, the
  // message slots, and the last bridge traffic when the bridge was being watched.
  try {
    const seen = await evaluate(`JSON.stringify({
      busy: document.querySelector('#studio-content')?.getAttribute('aria-busy') ?? null,
      active: document.activeElement ? document.activeElement.tagName + (document.activeElement.getAttribute('name') ? '[' + document.activeElement.getAttribute('name') + ']' : '') : null,
      openDetails: [...document.querySelectorAll('details[open]')].map(d => d.className + (d.dataset.section ? '#' + d.dataset.section : '')),
      messages: [...document.querySelectorAll('.message-slot')].filter(e => !e.hidden).map(e => e.textContent),
      bridge: (window.__gateBridge ?? []).slice(-12) })`);
    await fs.writeFile(path.join(output, `failure-${phase}.json`), seen);
    console.error(`Page at failure: ${seen}`);
  } catch { /* the page may be gone */ }
  process.exit(1);
}
