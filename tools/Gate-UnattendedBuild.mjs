import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';

// The fifth access level, driven end to end against a real Nendo process.
//
// From an empty file, an external client builds a record type, a screen, a calculation
// and an automatic action, accepts its own proposal, imports records as CSV, exports
// them again and checks the action ran — with nobody touching the window after the level
// is set. The sibling gate beside this one covers the four levels below, where a person
// clicks Accept; this one covers the level where nobody does.
//
// It also measures the thing the person sees while that happens: the status-bar pill and
// the sentence the busy bar puts on a wait caused by an agent. A screenshot would show
// neither reliably, so both are read out of the DOM.

const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, PID and output directory are required.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
let socket;
const pending = new Map();
const pageErrors = [];
let nextId = 0;
const notes = [];
const note = (...parts) => { const line = parts.join(' '); notes.push(line); console.log(line); };

async function waitFor(read, label, budget = 25000) {
  const until = Date.now() + budget;
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

async function click(selector) {
  await waitFor(() => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    if (e === null || e === undefined || e.disabled) return false;
    e.click(); return true; })()`), `something to click for ${selector}`);
}

/**
 * Chooses the level the way a person does: on the ladder, and then in the question.
 *
 * Driven rather than set through the bridge on purpose. The first version of this level
 * asked with the browser's own confirmation, which the host disables and does not handle,
 * so the rung did nothing at all when it was clicked -- no dialog, no level change, no
 * error (F-120). Nothing in this lane noticed, because it set the mode through the bridge
 * and never touched the control the person has to use.
 */
async function chooseUnattended() {
  await host('session.getSnapshot');
  await click('#nav-agent');
  await waitFor(() => evaluate(`document.querySelector('[data-agent-mode="unattended"]') !== null`),
    'the fifth rung of the access ladder');

  // Clicking it must put a question on the screen, not change the level on the spot.
  await click('[data-agent-mode="unattended"]');
  const asked = await waitFor(() => evaluate(`(() => {
    const d = document.querySelector('dialog[open]');
    return d === null ? null : JSON.stringify({ heading: d.querySelector('h2')?.textContent ?? null,
      confirm: d.querySelector('[data-confirm]')?.textContent ?? null,
      cancel: d.querySelector('[data-cancel]')?.textContent ?? null,
      body: [...d.querySelectorAll('p')].map(p => p.textContent).join(' ') });})()`),
    'the question in front of Unattended');
  const question = JSON.parse(asked);
  note('the question asked:', question.heading, '/', question.confirm);
  assert(/Unattended/.test(question.heading ?? ''), `The question did not name the level: ${asked}`);
  assert(/without showing them to you first/.test(question.body ?? ''),
    `The question did not say what it gives up: ${asked}`);

  // And cancelling has to leave the level where it was, or the question is decoration.
  await click('dialog[open] [data-cancel]');
  await waitFor(() => evaluate(`document.querySelector('dialog[open]') === null`), 'the question to close');
  const afterCancel = await host('agent.getStatus');
  assert(afterCancel.mode !== 'unattended', `Cancel turned the level on anyway: ${afterCancel.mode}`);
  note('cancel left the level at:', afterCancel.mode);

  await click('[data-agent-mode="unattended"]');
  await waitFor(() => evaluate(`document.querySelector('dialog[open]') !== null`), 'the question again');
  await click('dialog[open] [data-confirm]');
}

async function attach(name) {
  await chooseUnattended();
  const status = await waitFor(async () => {
    const seen = await host('agent.getStatus');
    return seen.mode === 'unattended' ? seen : null;
  }, 'Unattended to be on after the question was answered');
  await fs.writeFile(path.join(output, 'agent-status.json'), JSON.stringify(status, null, 2));
  assert(status.mode === 'unattended', `Unattended was not enabled: ${JSON.stringify(status)}`);
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

/** The tool result with its message when it is refused, rather than only its name. */
async function call(client, name, args) {
  const result = await client.rpc('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

async function read(client, uri) {
  const result = await client.rpc('resources/read', { uri });
  return JSON.parse(result.contents[0].text);
}

/** What the status bar says about an agent, read rather than looked at. */
async function pill() {
  return evaluate(`(() => {
    const e = document.querySelector('#agent-working');
    return JSON.stringify({ hidden: e?.hidden ?? null, text: e?.querySelector('#agent-working-text')?.textContent ?? null,
      title: e?.title ?? null, state: e?.dataset.state ?? null });})()`);
}

/**
 * Records the signal and every time the pill appears or disappears, rather than sampling.
 *
 * Polling the DOM over CDP costs tens of milliseconds a round trip, and a validate on a
 * small file finishes in a few hundred -- so the first version of this lane timed out
 * waiting for something that had already been and gone. An observer sees every
 * transition whatever its length, and the event log underneath it is what the renderer
 * was actually told.
 */
async function watchTheIndicator() {
  await evaluate(`(() => {
    window.__agentEvents = [];
    window.__agentPill = [];
    chrome.webview.addEventListener('message', event => {
      let message = event.data;
      if (typeof message === 'string') { try { message = JSON.parse(message); } catch { return; } }
      if (message && message.event === 'agentActivity') window.__agentEvents.push(message.payload);
    });
    const pill = document.querySelector('#agent-working');
    if (pill === null) return 'no pill';
    const record = () => window.__agentPill.push({
      hidden: pill.hidden,
      text: pill.querySelector('#agent-working-text')?.textContent ?? null,
      title: pill.title,
      at: Date.now(),
    });
    record();
    new MutationObserver(record).observe(pill, { attributes: true, subtree: true, childList: true, characterData: true });
    return 'watching';
  })()`);
}

async function indicatorLog() {
  return JSON.parse(await evaluate('JSON.stringify({events: window.__agentEvents ?? [], pill: window.__agentPill ?? []})'));
}

try {
  await connect();
  await command('Runtime.enable');
  await command('Page.enable');
  await waitFor(() => evaluate(`document.querySelector('#studio-content') !== null`), 'the Workbench shell');

  const before = JSON.parse(await pill());
  assert(before.hidden !== false, `The agent indicator was showing before an agent existed: ${JSON.stringify(before)}`);
  note('indicator before any agent: hidden');

  const client = await attach('unattended-gate');
  await watchTheIndicator();
  const tools = (await client.rpc('tools/list', {})).tools.map(tool => tool.name).sort();
  note('tools at Unattended:', tools.length);
  assert(tools.includes('nendo.change_set.accept'), 'The accept tool is not served at Unattended.');
  assert(tools.includes('nendo.data.import_records'), 'The import tool is not served.');

  const lease = await call(client, 'nendo.lease.acquire', {});
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };

  const begun = await call(client, 'nendo.change_set.begin', { ...owned, title: 'Reading log', idempotencyKey: 'u-begin' });
  const scoped = { ...owned, changeSetId: begun.changeSetId };

  await call(client, 'nendo.change_set.add_operations', {
    ...scoped,
    idempotencyKey: 'u-schema',
    mutations: [{
      description: 'A reading log',
      operations: [
        { operationType: 'schema.createEntity', payload: { entityId: 'book', displayName: 'Books' } },
        { operationType: 'schema.addField', payload: { entityId: 'book', fieldId: 'bookTitle', displayName: 'Title', storageKind: 'Text', required: true } },
        { operationType: 'schema.addField', payload: { entityId: 'book', fieldId: 'bookPages', displayName: 'Pages', storageKind: 'Integer', required: true } },
        { operationType: 'schema.addField', payload: { entityId: 'book', fieldId: 'bookRead', displayName: 'Pages read', storageKind: 'Integer', required: true } },
        { operationType: 'schema.addField', payload: { entityId: 'book', fieldId: 'bookNote', displayName: 'Note', storageKind: 'Text', required: false } },
      ],
    }],
  });

  await call(client, 'nendo.change_set.add_operations', {
    ...scoped,
    idempotencyKey: 'u-behaviour',
    mutations: [{
      description: 'How far through, and a note that writes itself',
      operations: [
        {
          operationType: 'behaviour.setDefinition',
          payload: {
            definitionId: 'book.progress', definitionKind: 'Calculation',
            body: {
              entityId: 'book', fieldId: 'progress', displayName: 'Progress',
              resultType: 'Decimal', resultNullable: true,
              expression: 'RoundEven(read * 100 / pages, 1)',
              bindings: [
                { bindingId: 'read', kind: 'SameRecordField', entityId: 'book', fieldId: 'bookRead', resultType: 'Integer', nullable: false },
                { bindingId: 'pages', kind: 'SameRecordField', entityId: 'book', fieldId: 'bookPages', resultType: 'Integer', nullable: false },
              ],
              callAliases: [],
            },
          },
        },
        {
          operationType: 'behaviour.setDefinition',
          payload: {
            definitionId: 'book.stamp', definitionKind: 'Action',
            body: {
              displayName: 'Note the title',
              steps: [{
                stepId: '10-note', kind: 'SetField', target: { kind: 'EventRecord' },
                assignments: [{
                  fieldId: 'bookNote', expression: "Concat('Logged: ', title)",
                  bindings: [{ bindingId: 'title', kind: 'SameRecordField', entityId: 'book', fieldId: 'bookTitle', resultType: 'Text', nullable: false }],
                  callAliases: [],
                }],
              }],
            },
          },
        },
        {
          operationType: 'behaviour.setDefinition',
          payload: {
            definitionId: 'book.stampTrigger', definitionKind: 'Trigger',
            body: {
              entityId: 'book', displayName: 'Note the title when one is logged',
              events: 'Created', actionId: 'book.stamp',
              relevantFieldIds: [], conditionBindings: [], callAliases: [],
            },
          },
        },
      ],
    }],
  });

  await call(client, 'nendo.change_set.add_operations', {
    ...scoped,
    idempotencyKey: 'u-screen',
    mutations: [{
      description: 'A list to read it in',
      operations: [
        {
          operationType: 'ui.addNode',
          payload: {
            surfaceId: 'reading', nodeId: 'bookList', parentNodeId: null, kind: 'recordList', position: 0,
            properties: { definitionVersion: 3, entityId: 'book', title: 'Reading log' },
          },
        },
        {
          operationType: 'ui.addNode',
          payload: {
            surfaceId: 'reading', nodeId: 'bookListTitle', parentNodeId: 'bookList', kind: 'fieldBinding', position: 0,
            properties: { fieldId: 'bookTitle' },
          },
        },
        {
          operationType: 'ui.addNode',
          payload: {
            surfaceId: 'reading', nodeId: 'bookListProgress', parentNodeId: 'bookList', kind: 'fieldBinding', position: 1,
            properties: { fieldId: 'progress' },
          },
        },
      ],
    }],
  });

  // Validate clones the file, which is the longest call in the product and the wait a
  // person would actually notice.
  const validated = await call(client, 'nendo.change_set.validate', { ...scoped, idempotencyKey: 'u-validate' });
  note('validated:', validated.state, validated.operationCount, 'operations');
  assert(String(validated.state).toLowerCase() === 'previewable',
    `The change set did not validate: ${JSON.stringify(validated.diagnostics)}`);

  const waiting = await read(client, 'nendo://application/proposals');
  assert(waiting.length === 1, `Expected one waiting proposal, saw ${waiting.length}.`);

  const accepted = await call(client, 'nendo.change_set.accept', { ...scoped, idempotencyKey: 'u-accept' });
  note('accepted:', JSON.stringify(accepted));
  assert(accepted.applied, `The acceptance did not apply: ${accepted.message}`);
  assert(accepted.behaviourApproved, 'The acceptance installed an action and recorded no consent.');
  assert((await read(client, 'nendo://application/proposals')).length === 0, 'A proposal is still waiting after acceptance.');

  const imported = await call(client, 'nendo.data.import_records', {
    ...owned,
    entityId: 'book',
    format: 'csv',
    csvProfile: 'external',
    csv: 'Title,Pages,Pages read\r\n'
      + 'The Left Hand of Darkness,304,304\r\n'
      + '"Gödel, Escher, Bach",777,120\r\n'
      + '"A title with ""quotes"" and a\r\nnewline",100,0\r\n'
      + '=SUM(A1:A2),50,25\r\n',
    columnMappings: [
      { column: 0, fieldId: 'bookTitle' },
      { column: 1, fieldId: 'bookPages' },
      { column: 2, fieldId: 'bookRead' },
    ],
    idempotencyKey: 'u-import',
  });
  note('imported:', imported.committed, 'records in', imported.revisionCount, 'revision(s)');
  assert(imported.committed === 4, `Expected four records, got ${imported.committed}.`);

  const page = await read(client, 'nendo://application/entity/book/records');
  const rows = page.items ?? [];
  assert(rows.length === 4, `Expected four records back, saw ${rows.length}.`);
  for (const row of rows) {
    const title = row.values.bookTitle;
    const stamped = row.values.bookNote;
    assert(typeof stamped === 'string' && stamped.startsWith('Logged: '),
      `The automatic action did not run for ${JSON.stringify(title)}: note is ${JSON.stringify(stamped)}`);
  }
  const titles = rows.map(row => String(row.values.bookTitle));
  assert(titles.some(value => value.includes('=SUM(')), 'Formula-like text was neutralised on the way in.');
  assert(titles.some(value => value.includes('\n')), 'A newline inside a cell was lost.');
  assert(titles.some(value => value.includes('"')), 'A quote inside a cell was lost.');
  assert(titles.some(value => value.includes('Gödel')), 'Unicode was lost.');
  note('values survived: formula-like text, newline, quote, Unicode');

  const exported = await read(client, 'nendo://application/entity/book/export');
  assert(exported.csv.split('\r\n')[0].includes('"Title"'), 'The export lost its header row.');
  assert(exported.recordCount === 4, `The export read ${exported.recordCount} records.`);
  note('exported', exported.recordCount, 'records,', exported.csv.length, 'characters');

  // A build of this size finishes inside the wait the indicator deliberately keeps, and
  // an indicator that flashed up for half a second of work would be the thing it is meant
  // to avoid. So the sustained case is made on purpose: five hundred rows is ten
  // revisions, which is the shape of work a person actually notices.
  const sustained = call(client, 'nendo.data.import_records', {
    ...owned,
    entityId: 'book',
    format: 'json',
    records: Array.from({ length: 500 }, (unused, index) => ({
      recordId: `bulk-${String(index).padStart(3, '0')}`,
      values: {
        bookTitle: `Bulk ${index}`,
        bookPages: { $nendoNumber: '100' },
        bookRead: { $nendoNumber: String(index % 100) },
      },
    })),
    idempotencyKey: 'u-sustained',
  });
  const showing = await waitFor(async () => {
    const seen = JSON.parse(await pill());
    return seen.hidden === false ? seen : null;
  }, 'the indicator while an agent is writing in bulk', 30000);
  note('indicator while writing:', JSON.stringify({ text: showing.text, title: showing.title }));
  await screenshot('unattended-working.png');
  const bulk = await sustained;
  note('sustained import:', bulk.committed, 'records in', bulk.revisionCount, 'revisions');
  assert(bulk.committed === 500, `The sustained import committed ${bulk.committed}.`);

  // It names who, not just that somebody is there. The client's own display name is the
  // only thing on any screen that answers "which of the things I have open is this", and
  // the title names the call, so a read and a write are tellable apart by somebody
  // deciding whether to wait.
  assert(/^unattended-gate .* is working$/.test(showing.text ?? ''),
    `The indicator did not name the agent: ${JSON.stringify(showing)}`);
  assert(/Revoke edit access/.test(showing.title ?? ''), 'The indicator does not say how to end it.');
  // A tool name or a resource URI: the pill names whichever call it caught, and both
  // start the same way. Requiring only the tool form failed on a read (nendo://...).
  assert(/nendo[.:]/.test(showing.title ?? ''),
    `The indicator did not say what was happening: ${JSON.stringify(showing)}`);

  await call(client, 'nendo.lease.release', owned);
  await host('agent.setMode', { mode: 'off' });

  // It comes down on its own bounded wait after the agent goes quiet, so this waits for
  // that rather than reading the instant the agent leaves -- which is before the wait it
  // is checking has had time to elapse.
  const settled = await waitFor(async () => {
    const seen = JSON.parse(await pill());
    return seen.hidden === true ? seen : null;
  }, 'the indicator to come down after the agent left', 8000);
  note('indicator after the agent left:', settled.hidden === true ? 'hidden' : 'still up');
  await screenshot('unattended-finished.png');

  // What the renderer was told, kept beside what it drew.
  const watched = await indicatorLog();
  await fs.writeFile(path.join(output, 'indicator.json'), JSON.stringify(watched, null, 2));
  note('agent events seen by the renderer:', watched.events.length);
  assert(watched.events.length > 0, 'The renderer was never told an agent was working.');
  assert(watched.events.some(event => event.busy === true), 'No event ever said an agent was busy.');
  assert(watched.events.some(event => event.busy === false), 'Nothing ever said the agent had stopped.');
  const named = watched.events.filter(event => event.busy && typeof event.activity === 'string' && event.activity.startsWith('nendo.'));
  assert(named.length > 0, `No busy event named what it was doing: ${JSON.stringify(watched.events.slice(0, 4))}`);
  note('longest call named:', named.map(event => event.activity).find(value => value.includes('validate')) ?? named[0].activity);
  assert(watched.pill.some(entry => entry.hidden === false),
    `The status bar never drew the indicator. Pill log: ${JSON.stringify(watched.pill)}`);

  assert(pageErrors.length === 0, `The renderer raised: ${pageErrors.join(' | ')}`);
  await fs.writeFile(path.join(output, 'unattended.json'), JSON.stringify({ result: 'passed', notes }, null, 2));
  console.log('Unattended build gate passed.');
  process.exit(0);
} catch (error) {
  console.error(`Unattended build gate failed: ${error.message}`);
  if (pageErrors.length > 0) console.error(`Renderer errors: ${pageErrors.join(' | ')}`);
  try { await screenshot('unattended-failure.png'); } catch { /* the page may be gone */ }
  try { await fs.writeFile(path.join(output, 'unattended.json'), JSON.stringify({ result: 'failed', error: error.message, notes }, null, 2)); } catch { /* nothing to write to */ }
  process.exit(1);
}
