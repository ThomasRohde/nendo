import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Custom views running inline in a real Nendo (ADR-0013, 2026-09-25), against an isolated
// profile built by DesktopExtensionViewJourneyTests. The page and each view frame are driven
// over the browser's debugging port; which process holds which frame comes from the host's
// own diagnostics. Every check measures: a latency, a process ID, a state attribute, an
// answer from inside the frame. Nothing here needs the pointer or the foreground.
const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, process and output are required.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { checks: [], measurements: {} };
function assert(value, message) { if (!value) throw new Error(message); }
function check(line) { report.checks.push(line); console.log('ok  ' + line); }
async function waitFor(read, label, timeout = 25000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = await read(); } catch (error) { last = 'error: ' + error.message; }
    if (last && !(typeof last === 'string' && last.startsWith('error: '))) return last;
    await sleep(150);
  }
  throw new Error('Timed out: ' + label + (last === undefined ? '' : ' (last: ' + JSON.stringify(last) + ')'));
}

// A loopback canary, for the network a view may reach: plain HTTP and a WebSocket echo.
const canaryHits = [];
const canary = http.createServer((request, response) => {
  canaryHits.push({ url: request.url, origin: request.headers.origin ?? null });
  response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  response.end('canary');
});
canary.on('upgrade', (request, socket) => {
  const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.once('data', frame => {
    const length = frame[1] & 0x7f;
    const mask = frame.subarray(2, 6);
    const text = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4])).toString('utf8');
    const reply = Buffer.from(text, 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
  });
  socket.on('error', () => {});
});
await new Promise(resolve => canary.listen(0, '127.0.0.1', resolve));
const canaryUrl = `http://127.0.0.1:${canary.address().port}`;

// One browser-level connection; every target is a flattened session on it.
const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), 'debugging port');
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let next = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data);
  const item = pending.get(value.id); if (!item) return;
  pending.delete(value.id); clearTimeout(item.timer);
  if (value.error) item.reject(new Error(value.error.message)); else item.resolve(value.result);
});
function command(method, params = {}, sessionId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluateIn(sessionId, expression, timeout) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeout);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
const targets = async () => (await command('Target.getTargets')).targetInfos;
async function attach(targetId) { return (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId; }

const workbench = await waitFor(async () => (await targets()).find(t => t.type === 'page' && t.url.startsWith('https://app.nendo.local/')), 'owned Workbench');
const page = await attach(workbench.targetId);
const evaluate = (expression, timeout) => evaluateIn(page, expression, timeout);
const idle = () => waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'Workbench idle');
async function click(selector) {
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

// The host bridge, as the Workbench itself calls it, for diagnostics and settings.
async function installGate() {
  await evaluate(`window.viewGate = (method, payload = {}) => new Promise((resolve, reject) => {
    const requestId = 'view-gate-' + crypto.randomUUID();
    const listener = event => { const r = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (r.requestId !== requestId) return; chrome.webview.removeEventListener('message', listener);
      if (r.ok) resolve(r.result); else reject(new Error(r.error.code + ': ' + r.error.message)); };
    chrome.webview.addEventListener('message', listener);
    chrome.webview.postMessage({ protocolVersion: 7, requestId, fileSessionId: window.viewGateSession, method, payload });
  })`);
  const snapshot = await evaluate(`viewGate('session.getSnapshot')`);
  await evaluate(`window.viewGateSession = ${JSON.stringify(snapshot.fileSessionId)}`);
  return snapshot;
}
const gate = (method, payload = {}) => evaluate(`viewGate(${JSON.stringify(method)}, ${JSON.stringify(payload)})`, 30000);
const processes = () => gate('diagnostics.frameProcesses');

// The frames the Workbench holds, by name, with the state its placeholder says.
const frames = () => evaluate(`[...document.querySelectorAll('iframe')].filter(f => /^nendo-view-/.test(f.name)).map(f => ({
  name: f.name, src: f.src, state: f.closest('[data-view-mount]')?.dataset.viewState ?? null,
  view: f.closest('[data-view-mount]')?.dataset.viewId ?? null }))`);
const stateOf = name => evaluate(`document.querySelector('iframe[name="${name}"]')?.closest('[data-view-mount]')?.dataset.viewState ?? null`);
async function openRecordPage() {
  if (!(await evaluate(`Boolean(document.querySelector('[data-select-surface="probe"]'))`))) return;
  await click('[data-select-surface="probe"]'); await idle();
  const screenAgain = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'probe screen running again', 30000);
  const session = await frameSession(screenAgain.name);
  await waitFor(() => inFrame(session, 'probe.state.ready'), 'probe handshake again');
  await inFrame(session, `nendo.ui.openRecord('tasks', 't1')`);
  await waitFor(() => evaluate(`document.querySelectorAll('.record-inspector [data-view-mount]').length === 6`), 'six panels again');
  await waitFor(async () => {
    await evaluate(`[...document.querySelectorAll('.record-inspector [data-view-mount]')].find(m => m.dataset.viewId === 'panel3')?.scrollIntoView({ block: 'center' })`);
    return (await frames()).some(f => f.view === 'panel3' && f.state === 'running');
  }, 'panel 3 running again', 30000);
}

// A frame's own session, found by asking each view target its window name.
async function frameSession(name) {
  return waitFor(async () => {
    for (const target of (await targets()).filter(t => t.type === 'iframe' && t.url.includes('.example'))) {
      const session = await attach(target.targetId);
      try { if (await evaluateIn(session, 'window.name', 3000) === name) return { session, target }; }
      catch { /* a frame that is spinning or gone */ }
      await command('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    }
    return null;
  }, 'frame target ' + name);
}
const inFrame = (frame, expression, timeout) => evaluateIn(frame.session, expression, timeout);
const processOf = (list, name) => list.find(p => p.frames.some(f => f.name === name));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  await command('Target.setDiscoverTargets', { discover: true });
  await idle();
  const snapshot = await installGate();
  assert(snapshot.extensions?.run === true, 'Views are not running in a healthy file: ' + JSON.stringify(snapshot.extensions));
  const origins = new Map(snapshot.extensions.packages.map(p => [p.packageId, p.origin]));
  assert(origins.size === 3 && new Set(origins.values()).size === 3, 'Each package needs an origin of its own: ' + JSON.stringify([...origins]));

  // The probe screen: one view, drawn by package A.
  await click('#nav-use'); await idle();
  await click('[data-select-surface="probe"]'); await idle();
  const screenFrame = await waitFor(async () => (await frames()).find(f => f.state === 'running'), 'probe screen running', 30000);
  const screen = await frameSession(screenFrame.name);
  await waitFor(() => inFrame(screen, 'probe.state.ready'), 'probe handshake');

  // G18: reads carry calculated values, exact decimals and the view's own context.
  const reads = await inFrame(screen, 'probe.reads()');
  const survey = reads.items.find(item => item.recordId === 't1');
  assert(reads.view.placement === 'screen' && reads.view.packageId === 'org.nendo.test.probe-a', 'Wrong context: ' + JSON.stringify(reads.view));
  assert(survey && survey.calculated?.titleLength?.value === 15, 'A calculated field did not arrive: ' + JSON.stringify(survey));
  assert(Number(survey.exact?.estimate ?? survey.values.estimate) === 12.5, 'The decimal did not arrive exactly: ' + JSON.stringify(survey));
  check('G18 a view reads records with calculated values and exact decimals, and knows it is a screen');

  // G10: a view cannot reach the Workbench, move it, frame it, or connect a window it made.
  assert((await inFrame(screen, 'probe.parentDocument()')).startsWith('blocked'), 'A view reached the Workbench document.');
  assert((await inFrame(screen, 'probe.navigateTop()')).startsWith('blocked'), 'A view navigated the Workbench away.');
  assert((await evaluate('location.href')).startsWith('https://app.nendo.local/'), 'The Workbench moved.');
  const nested = await inFrame(screen, 'probe.nestWorkbench()', 10000);
  assert(nested === 'about:blank', 'A view loaded the Workbench in a frame of its own: ' + nested);
  assert(await inFrame(screen, 'probe.forgeHello()', 10000) === 'ignored', 'The broker connected a window it did not mount.');
  check('G10 parent.document throws, top navigation is refused, a nested Workbench stays about:blank, a forged hello is ignored');

  // G11 and G12: the view has the network; the Workbench document does not.
  assert(await inFrame(screen, `probe.fetchText(${JSON.stringify(canaryUrl + '/canary')})`) === '200:canary', 'A view could not fetch loopback.');
  assert(await inFrame(screen, `probe.socket(${JSON.stringify(canaryUrl.replace('http', 'ws') + '/ws')})`, 10000) === 'echo:ping', 'A view could not open a WebSocket.');
  assert(canaryHits.some(hit => hit.origin === origins.get('org.nendo.test.probe-a')), 'The canary did not see the view origin: ' + JSON.stringify(canaryHits));
  assert(await inFrame(screen, `probe.storage('kept')`) === 'kept', 'A view could not use localStorage.');
  const workbenchFetch = await evaluate(`fetch(${JSON.stringify(canaryUrl + '/workbench')}).then(() => 'reached', () => 'blocked')`);
  assert(workbenchFetch === 'blocked' && !canaryHits.some(hit => hit.url === '/workbench'), 'The Workbench document reached the network.');
  check('G11 a view fetches loopback, opens a WebSocket and keeps localStorage; G12 the Workbench document stays local');

  // G13: a write and the redraw it causes leave the running view's document in place.
  const before = await inFrame(screen, 'performance.timeOrigin');
  const changesBefore = await inFrame(screen, 'probe.state.changes');
  await evaluate(`document.querySelector('.use-page').dataset.journeyMark = 'before'`);
  await gate('data.createRecord', { entityId: 'tasks', recordId: 't3', values: { title: 'Cure the slab' }, idempotencyKey: crypto.randomUUID() });
  await waitFor(async () => await inFrame(screen, 'probe.state.changes') > changesBefore, 'changes reached the view');
  await waitFor(() => evaluate(`document.querySelector('.use-page')?.dataset.journeyMark !== 'before'`), 'the page redrew');
  assert(await inFrame(screen, 'performance.timeOrigin') === before, 'The redraw reloaded the view.');
  check('G13 a write reaches the view as a change and the redraw keeps its document');

  // G15: six panels from three packages beside the screen, one renderer per package, within budget.
  await inFrame(screen, `nendo.ui.openRecord('tasks', 't1')`);
  await waitFor(() => evaluate(`document.querySelectorAll('.record-inspector [data-view-mount]').length === 6`), 'six panels on the record page');
  for (let index = 0; index < 6; index += 1) {
    await evaluate(`document.querySelectorAll('.record-inspector [data-view-mount]')[${index}].scrollIntoView({ block: 'center' })`);
    await sleep(400);
  }
  await waitFor(async () => (await frames()).filter(f => f.state === 'running').length === 7, 'seven views running', 45000);
  assert(await inFrame(screen, 'performance.timeOrigin') === before, 'Opening a record reloaded the screen view.');
  await sleep(5000);
  const samples = [];
  for (let index = 0; index < 5; index += 1) { samples.push(await processes()); await sleep(1000); }
  const last = samples.at(-1);
  const viewRenderers = last.filter(p => p.frames.some(f => /^nendo-view-/.test(f.name)));
  const main = last.find(p => p.frames.some(f => f.source.startsWith('https://app.nendo.local/')));
  assert(viewRenderers.length === 3, 'Expected one renderer per package, found ' + viewRenderers.length + ': ' + JSON.stringify(viewRenderers));
  assert(main && !viewRenderers.some(p => p.processId === main.processId), 'A view shares the Workbench renderer.');
  const viewMiB = median(samples.map(list => list.filter(p => p.frames.some(f => /^nendo-view-/.test(f.name))).reduce((sum, p) => sum + (p.privateWorkingSetBytes ?? 0), 0))) / 1048576;
  const allMiB = median(samples.map(list => list.reduce((sum, p) => sum + (p.privateWorkingSetBytes ?? 0), 0))) / 1048576;
  report.measurements.viewRendererMiB = Math.round(viewMiB * 10) / 10;
  report.measurements.allWebView2MiB = Math.round(allMiB * 10) / 10;
  assert(viewMiB <= 160, `View renderers hold ${viewMiB.toFixed(1)} MiB, over the 160 MiB budget.`);
  assert(allMiB <= 420, `WebView2 holds ${allMiB.toFixed(1)} MiB, over the 420 MiB budget.`);
  check(`G15 seven views from three packages run in three renderers apart from the Workbench: ${viewMiB.toFixed(1)} MiB of view renderers, ${allMiB.toFixed(1)} MiB in all`);

  // G8: a view spinning forever leaves the Workbench answering, in another process.
  const spinning = await frameSession((await frames()).find(f => f.view === 'panel5').name);
  const spinningName = await inFrame(spinning, 'window.name');
  const spinningPid = processOf(await processes(), spinningName).processId;
  await inFrame(spinning, 'probe.spin()');
  await sleep(500);
  const latencies = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await evaluate('1 + 1', 2000);
    latencies.push(performance.now() - started);
  }
  report.measurements.workbenchEvaluateMaxMs = Math.round(Math.max(...latencies));
  assert(Math.max(...latencies) < 250, 'The Workbench stalled behind a spinning view: ' + latencies.map(Math.round).join(', '));
  assert(spinningPid !== main.processId, 'The spinning view shares the Workbench process.');
  check(`G8 while a view spins, the Workbench answers in at most ${Math.round(Math.max(...latencies))} ms, from another process`);

  // G14: the spinning view is called out within 15 s, and Stop ends its renderer within 5 s.
  const spunAt = Date.now();
  const troubled = await waitFor(async () => {
    const list = await frames();
    return list.find(f => f.name === spinningName && f.state === 'unresponsive') ?? null;
  }, 'the spinning view marked not responding', 15000);
  report.measurements.notRespondingAfterMs = Date.now() - spunAt;
  await evaluate(`document.querySelector('iframe[name="${troubled.name}"]').closest('[data-view-mount]').querySelector('[data-view-stop]').click()`);
  const stopped = Date.now();
  await waitFor(() => !alive(spinningPid), 'the spinning renderer ended', 5000);
  report.measurements.stopEndedRendererMs = Date.now() - stopped;
  check(`G14 a spinning view shows not responding after ${report.measurements.notRespondingAfterMs} ms and Stop ends its renderer in ${report.measurements.stopEndedRendererMs} ms`);

  // Studio is reachable throughout. Back in Use, the screen view starts again and opens the
  // record page, whose views start as they come into view.
  await click('#nav-studio'); await idle();
  await click('#nav-use'); await idle();
  await openRecordPage();

  // G9: a crashed view says so in its own place, the app stays out of recovery, and Reload works.
  const victimFrame = (await frames()).find(f => f.view === 'panel3' && f.state === 'running');
  const victim = await frameSession(victimFrame.name);
  await command('Page.crash', {}, victim.session, 3000).catch(() => { /* the session goes with the renderer */ });
  await waitFor(async () => (await evaluate(`[...document.querySelectorAll('[data-view-mount]')].filter(m => m.dataset.viewState === 'crashed').map(m => m.dataset.viewId)`)).includes('panel3'), 'the crashed view says so');
  assert(await evaluate(`Boolean(document.querySelector('#studio-content'))`), 'The crash took the Workbench down.');
  await evaluate(`[...document.querySelectorAll('[data-view-mount]')].find(m => m.dataset.viewId === 'panel3').querySelector('[data-view-reload]').click()`);
  await waitFor(async () => (await evaluate(`[...document.querySelectorAll('[data-view-mount]')].find(m => m.dataset.viewId === 'panel3')?.dataset.viewState`)) === 'running', 'the reloaded view runs', 20000);
  check('G9 a crashed renderer marks its views, leaves the Workbench running, and Reload starts them again');

  // G16: views off on this device, then for this file: no frame, and every view origin answers 403.
  for (const [scope, reason] of [['device', 'device'], ['file', 'file']]) {
    await gate('extension.settings.set', { scope, enabled: false });
    await command('Page.reload', {}, page);
    await waitFor(async () => { try { return await evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`); } catch { return false; } }, 'Workbench after reload', 30000);
    const reloaded = await installGate();
    assert(reloaded.extensions.run === false && reloaded.extensions.offReason === reason, `Views are not off for ${reason}: ` + JSON.stringify(reloaded.extensions));
    await click('#nav-use'); await idle();
    await click('[data-select-surface="probe"]'); await idle();
    await sleep(1000);
    assert((await frames()).length === 0, `A view ran while views were off for this ${reason}.`);
    const inserted = 'journey-inserted-' + reason;
    await evaluate(`(() => { const f = document.createElement('iframe'); f.name = ${JSON.stringify(inserted)}; f.src = ${JSON.stringify(origins.get('org.nendo.test.probe-a') + '/')}; document.body.append(f); })()`);
    const refused = await waitFor(async () => {
      for (const target of (await targets()).filter(t => t.type === 'iframe' && t.url.includes('.example'))) {
        const session = await attach(target.targetId);
        const body = await evaluateIn(session, `window.name === ${JSON.stringify(inserted)} ? document.body.innerText : null`, 3000).catch(() => null);
        if (body !== null) return body;
      }
      return null;
    }, 'the inserted frame loads');
    assert(refused.includes('Custom views are off'), `A view origin answered while views were off for this ${reason}: ` + refused);
    await gate('extension.settings.set', { scope, enabled: true });
  }
  check('G16 with views off for the device or the file, no frame is drawn and a frame inserted by hand gets the 403');

  // G17 (W-062): a person adds a view from Studio, without an agent. The Custom views panel
  // names where each package is already shown; the Add view form offers only what compiles,
  // refuses a graph the file has no link record type for, and its proposal is accepted
  // through the ordinary review. The new screen is selected in Use and its view runs.
  await click('#nav-surfaces'); await idle();
  const uses = await waitFor(() => evaluate(`(() => { const card = document.querySelector('[data-package="org.nendo.test.probe-a"]');
    return card ? [...card.querySelectorAll('.package-uses li')].map(li => li.textContent.replace(/\\s+/g, ' ').trim()) : null; })()`), 'where probe A is shown');
  assert(uses.some(line => line.startsWith('Probe screen') && line.includes('under View in Tasks')), 'The panel does not say where probe A is a screen: ' + JSON.stringify(uses));
  assert(uses.filter(line => line.includes('a panel on')).length === 2, 'The panel does not name probe A’s two record-page panels: ' + JSON.stringify(uses));
  await click('[data-view-add="org.nendo.test.probe-b"]');
  await waitFor(() => evaluate(`Boolean(document.querySelector('#add-view-form'))`), 'the Add view form');
  const offered = await evaluate(`[...document.querySelectorAll('#add-view-label option')].map(o => o.value)`);
  assert(offered.includes('title') && offered.includes('titleLength'), 'The label offers neither a stored nor a calculated field: ' + JSON.stringify(offered));
  await evaluate(`(() => { const r = document.querySelector('#add-view-kind-graph'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const refusedGraph = await waitFor(() => evaluate(`(() => { const f = document.querySelector('#add-view-form'); const kind = f?.querySelector('input[name="add-view-kind"]:checked')?.value;
    return kind === 'graph' ? { disabled: f.querySelector('button[type="submit"]').disabled, note: f.querySelector('#add-view-refusal').textContent } : null; })()`), 'the graph choice');
  assert(refusedGraph.disabled === true && /links Tasks records/.test(refusedGraph.note), 'The form offered a graph with no link record type: ' + JSON.stringify(refusedGraph));
  await evaluate(`(() => { const r = document.querySelector('#add-view-kind-records'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(() => evaluate(`document.querySelector('#add-view-kind-records')?.checked === true`), 'back to a screen of records');
  await evaluate(`(() => { const i = document.querySelector('#add-view-title'); i.value = 'Probe B from Studio'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('#add-view-form button[type="submit"]');
  await waitFor(() => evaluate(`document.querySelector('#accept-proposal')?.disabled === false`), 'the Add view proposal, ready to accept', 30000);
  await click('#accept-proposal'); await idle();
  const landed = await waitFor(() => evaluate(`(() => { const title = document.querySelector('#workspace-title')?.textContent;
    const said = document.querySelector('.message-slot')?.textContent ?? '';
    return title === 'Probe B from Studio' ? { said } : null; })()`), 'Use, on the new view', 30000);
  assert(/Probe B from Studio is under View in Tasks/.test(landed.said), 'The outcome does not say where the view is: ' + JSON.stringify(landed));
  const added = await waitFor(async () => (await frames()).find(f => f.view?.startsWith('node.view.') && f.state === 'running'), 'the added view running', 30000);
  const definition = (await installGate()).uiNodes.find(node => node.nodeId === added.view);
  assert(definition?.kind === 'extensionRecordsSurface' && definition.properties.packageId === 'org.nendo.test.probe-b' &&
    definition.properties.entityId === 'tasks' && definition.properties.labelFieldId === 'title',
    'The accepted view is not the one the form described: ' + JSON.stringify(definition));
  check('G17 Studio names where each package is shown, refuses a graph the file cannot draw, and a view added from the form is accepted, selected in Use and running');

  // G19 (W-065, ADR-0013 Phase 3): a view writes as its package. It creates, updates, runs a
  // record command on, and deletes a record through window.nendo; History names the package on
  // each; a write over a stale version is refused without a change; and a view that floods the
  // host cannot starve a person's save, because it has at most eight requests in flight.
  await click('#nav-use'); await idle();
  await click('[data-select-surface="probe"]'); await idle();
  const writer = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'the probe screen running for writes', 30000);
  const writerFrame = await frameSession(writer.name);
  await waitFor(() => inFrame(writerFrame, 'probe.state.ready'), 'the probe handshake for writes');
  const wrote = await inFrame(writerFrame, `(async () => {
    const created = await nendo.records.create('tasks', { title: 'Written by the view', estimate: { $nendoNumber: '1.25' } });
    const updated = await nendo.records.update(created, { title: 'Changed by the view' });
    const commanded = await nendo.commands.run('cmd', updated);
    let stale = null;
    try { await nendo.records.update(created, { title: 'Over a version that is gone' }); } catch (error) { stale = error.code; }
    await nendo.records.delete(commanded);
    const gone = await nendo.records.get('tasks', created.recordId);
    return { has: ['records.create', 'records.update', 'records.delete', 'commands.run'].map(name => nendo.has(name)),
      versions: [created.version, updated.version, commanded.version], exact: created.exact.estimate,
      title: updated.values.title, notes: commanded.values.notes, stale, gone };
  })()`, 30000);
  assert(wrote.has.every(Boolean), 'The view is not offered the write methods: ' + JSON.stringify(wrote));
  assert(wrote.versions[0] === 1 && wrote.versions[1] === 2 && wrote.versions[2] > 2, 'The versions a view got back are not the record’s: ' + JSON.stringify(wrote));
  assert(wrote.exact === '1.25' && wrote.title === 'Changed by the view' && wrote.notes === 'Reviewed by a view', 'What the view wrote is not what it read back: ' + JSON.stringify(wrote));
  assert(wrote.stale === 'record-version-conflict' && wrote.gone === null, 'A stale write or the delete did not behave: ' + JSON.stringify(wrote));
  const history = await gate('history.query', { limit: 20 });
  const byView = history.items.filter(item => item.origin === 'extension:org.nendo.test.probe-a');
  assert(byView.length === 4, 'History does not name the view’s package on its four writes: ' + JSON.stringify(history.items.map(item => [item.origin, item.description])));
  report.measurements.viewWriteOrigins = byView.map(item => item.description);

  // The flood: eighty writes at once from the view, and one save by the person in the middle.
  const flood = inFrame(writerFrame, `(async () => {
    const results = await Promise.allSettled(Array.from({ length: 80 }, (_, i) =>
      nendo.records.create('tasks', { title: 'Flood ' + i })));
    return { ok: results.filter(r => r.status === 'fulfilled').length,
      busy: results.filter(r => r.status === 'rejected' && r.reason?.code === 'busy').length,
      other: results.filter(r => r.status === 'rejected' && r.reason?.code !== 'busy').map(r => r.reason?.code) };
  })()`, 120000);
  await sleep(200);
  const t1 = (await gate('data.queryRecords', { entityId: 'tasks', recordId: 't1', limit: 1 })).items[0];
  const personStarted = Date.now();
  await gate('data.setFields', { entityId: 'tasks', recordId: 't1', expectedRecordVersion: t1.recordVersion,
    values: { notes: 'Saved by the person during a flood' }, idempotencyKey: 'person-during-flood-' + Date.now() });
  report.measurements.personSaveDuringFloodMs = Date.now() - personStarted;
  const flooded = await flood;
  report.measurements.flood = flooded;
  // api.js itself keeps eight in flight and holds the rest, so a view that uses it is never
  // answered busy; the broker's own sixty-four is for a page that talks to the port directly,
  // and scripts/extension-broker.test.mjs measures that.
  assert(flooded.ok === 80 && flooded.busy === 0 && flooded.other.length === 0,
    'A view’s flood of writes did not all land: ' + JSON.stringify(flooded));
  assert(report.measurements.personSaveDuringFloodMs < 10000,
    `The person's save waited ${report.measurements.personSaveDuringFloodMs} ms behind a view's flood.`);
  check(`G19 a view creates, updates, runs a command on and deletes a record as its package, a stale write is refused, and during an eighty-write flood, eight at a time, the person's save took ${report.measurements.personSaveDuringFloodMs} ms`);

  console.log('extension views ok');
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'journey.json'), JSON.stringify(report, null, 2)).catch(() => {});
  socket.close();
  canary.close();
}
