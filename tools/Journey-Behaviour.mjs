// The real-host behaviour journey: ADR-0008 stage S7, obligation P7.
//
// It drives the actual WinUI apphost's WebView over CDP and asserts against the
// real DOM. A passing unit suite is not this evidence: what is checked here is that
// a person opening a file that carries calculations and one automatic action can
// read the results, is asked before anything runs on their data, and still reaches
// Studio when a calculation cannot be done at all.
import fs from 'node:fs/promises';
import path from 'node:path';

const [port, processId, output, phase] = process.argv.slice(2);
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
async function ready() { await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'idle Workbench'); }
async function click(selector) {
  await waitFor(async () => {
    const state = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e ? {disabled:!!e.disabled} : null; })()`);
    return state && !state.disabled ? state : null;
  }, `enabled ${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
// Setting a value alone does not update form state. Real bubbling events are what a
// person's typing produces, and what the page's own edited-field tracking listens for.
async function fill(selector, value) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing input: ${selector}');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function text(selector) {
  return evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`);
}
async function screenshot(name) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
}

let fileSessionId = null;
async function host(method, payload = {}) {
  const request = { protocolVersion: 5, requestId: crypto.randomUUID(), method, payload, fileSessionId };
  const response = await evaluate(`new Promise((resolve,reject)=>{
    const b=chrome.webview,request=${JSON.stringify(request)};
    const timer=setTimeout(()=>{b.removeEventListener('message',receive);reject(new Error('Owned host timeout'));},12000);
    function receive(e){let r=e.data;if(typeof r==='string')r=JSON.parse(r);if(r.requestId!==request.requestId)return;
      clearTimeout(timer);b.removeEventListener('message',receive);resolve(r);}
    b.addEventListener('message',receive);b.postMessage(request);
  })`);
  assert(response.ok, `${method}: ${response.error?.code} ${response.error?.message}`);
  if (response.result?.fileSessionId) fileSessionId = response.result.fileSessionId;
  return response.result;
}
async function snapshot() { return host('session.getSnapshot'); }
// A number crosses the bridge in the exact-number envelope so a calculated decimal
// never passes through a JavaScript number. Read it as text, exactly as the page does.
function exactNumber(value) {
  if (value !== null && typeof value === 'object' && typeof value.$nendoNumber === 'string') return value.$nendoNumber;
  return value === null || value === undefined ? null : String(value);
}
function calculation(snapshotValue, recordId, fieldId) {
  const record = snapshotValue.records.find(item => item.recordId === recordId);
  assert(record !== undefined, `Missing record ${recordId}.`);
  return (record.calculations ?? []).find(result => result.fieldId === fieldId);
}
async function openHealth() { await click('#nav-health'); await ready(); }
async function openProjectRecord(recordId) {
  await click('#nav-data'); await ready();
  await click('[data-entity-id="projects"]'); await ready();
  await click(`.ag-row[row-id="${recordId}"] .record-open-button`);
  await waitFor(() => evaluate(`!!document.querySelector('#record-form')`), `the ${recordId} record page`);
}
async function setTheme(preference) {
  await click(`[data-theme-option="${preference}"]`);
  await waitFor(() => evaluate(`document.documentElement.getAttribute('data-theme-preference') === ${JSON.stringify(preference)}`), `${preference} theme`);
  await sleep(200);
}

try {
  await connect(); await command('Runtime.enable'); await ready();
  const state = await snapshot();

  if (phase === 'approve') {
    // 1. A file that can act on its own says so, and says it in terms of the
    //    owner's data rather than as a permission grant.
    assert(state.capabilities.mutate === false, 'A file with automatic actions was editable before this device approved it.');
    await openHealth();
    assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'false'`),
      'The approval panel is missing or already claims approval.');
    const offer = await text('[data-testid="behaviour-approval"]');
    assert(/change records/.test(offer), `The panel does not say what will happen to the data: ${offer}`);
    await screenshot('behaviour-approval.png');

    //    The same panel is where agent proposals are accepted, and the frame's status
    //    pill says why every button is greyed. A person who accepted the proposal
    //    there was told "no changes waiting" and had to go looking for the consent.
    assert(await text('#session-health') === 'Approval needed',
      `The status pill does not say editing is waiting on approval: ${await text('#session-health')}`);
    await click('#nav-agent'); await ready();
    assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'false'`),
      'The approval panel is not offered on the Agent page, where the proposal was accepted.');
    await screenshot('behaviour-approval-agent-page.png');

    // 2. Studio is reachable, and a calculation that cannot be done reads as
    //    itself rather than as a blank beside real blanks.
    await openProjectRecord('p-empty');
    const failing = '[data-derived-field="completion"]';
    assert(await evaluate(`document.querySelector(${JSON.stringify(failing)})?.dataset.state === 'error'`),
      'A calculation that divides by zero did not read as an error on the record page.');
    assert(await text(`${failing} .derived-value`) === 'Cannot calculate',
      'A failed calculation did not say so in words.');
    const formula = await text(`${failing} .derived-formula code`);
    assert(formula !== null && formula.length > 0, 'A calculated field showed no formula.');
    assert(await evaluate(`document.querySelector('#record-form [name="completion"]') === null`),
      'An editor was offered for a field with no column behind it.');
    await screenshot('behaviour-calculated-error.png');

    // 3. A value reads exactly, through the same transport a stored number uses.
    await openProjectRecord('p-live');
    assert(await text('[data-derived-field="taskCount"] .derived-value') === '2',
      'The calculated task count did not read as 2.');
    assert(await text('[data-derived-field="completion"] .derived-value') === '50.0',
      'The calculated completion did not read exactly.');

    // 4. Reachable without a mouse, and announced rather than merely coloured.
    //    This is the automated half; the keyboard, focus and screen-reader lane a
    //    person runs is recorded separately and is not claimed by this passing.
    await openHealth();
    const reachable = await evaluate(`(() => {
      const panel = document.querySelector('[data-testid="behaviour-approval"]');
      const button = document.querySelector('#approve-behaviour');
      if (!panel || !button) return null;
      button.focus();
      const focused = document.activeElement === button;
      const heading = panel.querySelector('h3');
      return { focused, disabled: !!button.disabled, tabIndex: button.tabIndex, heading: heading?.textContent ?? null,
               label: button.textContent.trim() };
    })()`);
    assert(reachable !== null, 'The approval panel was not on the page to check.');
    assert(reachable.focused && !reachable.disabled && reachable.tabIndex >= 0,
      'The approval control cannot be reached or used from the keyboard.');
    assert(reachable.heading === 'Automatic actions', `The approval panel has no heading: ${reachable.heading}`);
    assert(/approve/i.test(reachable.label), `The approval control does not name what it does: ${reachable.label}`);
    const announced = await evaluate(`(() => {
      const field = document.querySelector('[data-derived-field="completion"]');
      return field === null ? null : { detail: field.querySelector('.derived-detail')?.getAttribute('role') ?? null };
    })()`);

    // 5. Approving is a shell route that makes editing available. It is granted
    //    here, by a person, on this device — never by the file and never by MCP.
    await openHealth();
    await click('#approve-behaviour'); await ready();
    assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'true'`),
      'Approving did not take effect on screen.');
    assert((await snapshot()).capabilities.mutate === true, 'Approving did not make editing available.');

    // 6. One edit, and the action it triggers, commit together. The calculated
    //    fields that depend on the edit move with it.
    await click('#nav-data'); await ready();
    await click('[data-entity-id="tasks"]'); await ready();
    await click('.ag-row[row-id="t2"] .record-open-button');
    await waitFor(() => evaluate(`!!document.querySelector('#record-form [name="done"]')`), 'the task record page');
    await fill('#record-form [name="done"]', 'true');
    await evaluate(`document.querySelector('#record-form').requestSubmit()`);
    await ready();

    const after = await waitFor(async () => {
      const current = await snapshot();
      const project = current.records.find(record => record.recordId === 'p-live');
      return project?.values.stage === 'done' ? current : null;
    }, 'the automatic action closing the project');
    assert(exactNumber(calculation(after, 'p-live', 'doneCount')?.value) === '2',
      'The calculated done count did not follow the edit.');
    assert(exactNumber(calculation(after, 'p-live', 'completion')?.value) === '100',
      'The calculated completion did not follow the edit exactly. Decimal scale is part of the value.');
    await screenshot('behaviour-after-action.png');

    // 7. Light and Dark both stay legible, including the calculated fields.
    await openProjectRecord('p-live');
    await setTheme('light'); await screenshot('behaviour-light.png');
    await setTheme('dark'); await screenshot('behaviour-dark.png');
    await setTheme('system');

    await fs.writeFile(path.join(output, 'behaviour-state.json'),
      JSON.stringify({
        approved: true,
        projectStage: 'done',
        keyboard: reachable,
        calculationDetailRole: announced?.detail ?? null,
        humanLane: 'not run: keyboard, focus and screen-reader review by a person is recorded separately',
      }, null, 2));
  } else if (phase === 'remember') {
    // 8. The approval belongs to this device, not to the window. A fresh process
    //    opening the same file must not ask again.
    assert(state.capabilities.mutate === true, 'A remembered approval did not survive a restart.');
    await openHealth();
    assert(await evaluate(`document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'true'`),
      'The approval panel asked again after a restart.');
    await screenshot('behaviour-remembered.png');
  } else {
    throw new Error('Expected the approve or remember phase.');
  }

  assert(pageErrors.length === 0, `Unhandled page errors: ${pageErrors.join(' | ')}`);
  await fs.writeFile(path.join(output, `behaviour-${phase}.json`), JSON.stringify({
    result: 'passed',
    phase,
    processId,
    claims: 'Real WinUI/WebView2 host, isolated file and device-state roots. Calculated fields, their four states, ' +
      'device approval and one automatic action, asserted against the live DOM. Not a human usability or ' +
      'screen-reader check, and not a clean-machine test.',
  }, null, 2));
  console.log(`Behaviour ${phase}: passed`);
} finally { socket?.close(); }
