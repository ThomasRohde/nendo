import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
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
  if (value.error) item.reject(item.refusal(value.error.message)); else item.resolve(value.result);
});
// A refusal names the method, the session and the step that sent it: the handler above runs on
// the socket's stack, which says nothing about which step of the journey was refused.
function command(method, params = {}, sessionId, timeout = 15000) {
  const caller = new Error();
  const refusal = message => {
    const error = new Error(`${message} (${method}${sessionId ? ' in session ' + sessionId : ''})`);
    error.cdpMessage = message;
    error.stack = [error.message, ...caller.stack.split('\n').slice(1)].join('\n');
    return error;
  };
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(refusal('CDP timed out')); }, timeout);
    pending.set(id, { resolve, reject, timer, refusal });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluateIn(sessionId, expression, timeout, userGesture = false) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId, timeout);
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
// As a click in the frame would: the expression runs with the person's activation.
const byPerson = (frame, expression, timeout) => evaluateIn(frame.session, expression, timeout, true);

// W-104: the Open dialog Nendo's window owns, found by its owner, its title read, and closed as
// Cancel closes it. Windows draws it in the browser's process, so it is matched by the window
// that owns it rather than by the process that drew it.
const dialogSource = `using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class NendoJourneyDialogs {
  delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static string[] Close(uint host) {
    var found = new List<string>();
    EnumWindows((window, parameter) => {
      if (!IsWindowVisible(window)) return true;
      var name = new StringBuilder(64); GetClassName(window, name, 64);
      if (name.ToString() != "#32770") return true;
      uint drawer; GetWindowThreadProcessId(window, out drawer);
      uint owner = 0; var ownerWindow = GetWindow(window, 4);
      if (ownerWindow != IntPtr.Zero) GetWindowThreadProcessId(ownerWindow, out owner);
      if (drawer != host && owner != host) return true;
      var title = new StringBuilder(256); GetWindowText(window, title, 256);
      found.Add(title.ToString());
      PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}`;
function closeHostDialog(seconds = 10) {
  const script = `Add-Type -TypeDefinition @'\n${dialogSource}\n'@\n$deadline = (Get-Date).AddSeconds(${seconds}); $found = @()\n` +
    `while ($found.Count -eq 0 -and (Get-Date) -lt $deadline) { $found = @([NendoJourneyDialogs]::Close(${Number(processId)})); if ($found.Count -eq 0) { Start-Sleep -Milliseconds 100 } }\n` +
    `ConvertTo-Json -Compress -InputObject @($found)`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: (seconds + 60) * 1000 },
    (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(JSON.parse(String(stdout).trim() || '[]'))));
}

// W-093: the title bar as the page draws it and as Windows holds it, on the screen showing. The
// controls are every one in the bar a person can see; the host's diagnostics answer where the page
// starts in the window, the regions Windows holds and what Windows answers at a point: an empty
// part of the bar, Minimise, Maximise, Close and the content. In a narrow, tall window the rail is
// the bar across the top and the top bar sits under it, so only there may more than the bar stand
// above the content.
async function measureTitleBar(where, narrow = false) {
  let last = null;
  const settled = await waitFor(async () => {
    const drawn = await evaluate(`(() => {
      if (document.documentElement.dataset.titleBar !== 'window') return null;
      const visible = (element, band) => { let r = element.getBoundingClientRect(), left = r.left, top = r.top, right = r.right, bottom = r.bottom;
        for (let a = element.parentElement; a && band.contains(a); a = a.parentElement) { const s = getComputedStyle(a);
          if (s.overflowX === 'visible' && s.overflowY === 'visible') continue; const c = a.getBoundingClientRect();
          left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom); }
        return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null; };
      const controls = [...document.querySelectorAll('.workspace-header, .rail')].flatMap(band =>
        [...band.querySelectorAll('button, a[href], input, select, textarea, summary, label, [tabindex]:not([tabindex="-1"])')]
          .filter(e => e.getBoundingClientRect().top < 48).map(e => ({ name: e.id || e.getAttribute('aria-label') || e.className || e.tagName, box: visible(e, band) })))
        .filter(c => c.box !== null).map(c => ({ name: c.name, ...c.box }));
      return { controls, width: document.documentElement.clientWidth, content: document.querySelector('.workbench').getBoundingClientRect().top };
    })()`);
    if (drawn === null) return null;
    const probe = await gate('diagnostics.titleBar', { points: [] });
    const { bar, clientWidth } = probe;
    // An empty part of the bar: the first point along its middle that no control covers.
    let empty = null;
    for (let x = 24; x < clientWidth - bar.right - 8 && empty === null; x += 4)
      if (!drawn.controls.some(c => x >= c.x - 4 && x <= c.x + c.width + 4)) empty = { x, y: bar.height / 2 };
    const points = [empty ?? { x: 0, y: 0 }, ...[5, 3, 1].map(sixths => ({ x: clientWidth - bar.right * sixths / 6, y: bar.height / 2 })),
      { x: clientWidth / 2, y: Math.min(probe.clientHeight - 8, drawn.content + 120) }];
    const d = await gate('diagnostics.titleBar', { points });
    const within = (c, r) => r.x <= c.x + 1 && r.y <= c.y + 1 && r.x + r.width >= c.x + c.width - 1 && r.y + r.height >= Math.min(c.y + c.height, d.bar.height) - 1;
    last = {
      where, pageTop: d.pageTop, pageLeft: d.pageLeft, bar: d.bar, content: drawn.content, empty,
      codes: d.hits.map(h => h.code),
      caption: d.caption.some(r => r.x <= 0.5 && r.y <= 0.5 && r.height >= d.bar.height - 0.5 && r.width >= d.clientWidth - d.bar.right - 1),
      uncovered: drawn.controls.filter(c => !d.passthrough.some(r => within(c, r))).map(c => c.name),
      underButtons: drawn.controls.filter(c => c.x + c.width > d.clientWidth - d.bar.right + 0.5).map(c => c.name),
      controls: drawn.controls.length,
    };
    return last.uncovered.length === 0 ? last : null;
  }, 'every control in the title bar passed through on ' + where).catch(error => { throw new Error(error.message + ' ' + JSON.stringify(last)); });
  assert(settled.pageTop === 0 && settled.pageLeft === 0, `The page does not start at the window's top edge on ${where}: ` + JSON.stringify(settled));
  assert(Math.abs(settled.bar.height - 48) < 0.5, `Windows' title bar is not the tall one on ${where}: ` + JSON.stringify(settled));
  assert(narrow || settled.content <= settled.bar.height + 0.5, `More than the title bar stands above the content on ${where}: ` + JSON.stringify(settled));
  assert(settled.caption && settled.empty !== null, `Windows does not hold the bar as the caption on ${where}: ` + JSON.stringify(settled));
  assert(settled.underButtons.length === 0, `A control sits under Windows' own buttons on ${where}: ` + JSON.stringify(settled));
  assert(settled.codes.join() === '2,8,9,20,1', `Windows does not answer caption, Minimise, Maximise, Close and content on ${where}: ` + JSON.stringify(settled));
  return { above: Math.round(settled.pageTop + settled.content), controls: settled.controls };
}
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

  // G20 (W-063, ADR-0013 Phase 4): develop probe A from a folder. The host's picker answers
  // with the folder the journey test made (NENDO_DIAGNOSTICS_DEVELOPMENT_FOLDER); the card says
  // so, the screen runs the folder's code under a Development strip the view cannot cover, a
  // save in the folder reloads it within a measured bound, and Stop developing puts the file's
  // code back. Nothing of this reaches the file.
  const developFolder = path.join(output, 'develop-probe');
  const titleIn = async () => { const running = (await frames()).find(f => f.view === 'probe' && f.state === 'running');
    return running ? inFrame(await frameSession(running.name), `document.documentElement.dataset.source ?? 'file'`) : null; };
  // The title the screen shows, or an error naming the one it does show, so a timeout says which code ran.
  const showing = title => async () => { const now = await titleIn(); return now === title ? now : 'error: showing ' + JSON.stringify(now); };
  const sequenceBefore = (await installGate()).manifest.changeSequence;
  await click('#nav-surfaces'); await idle();
  await click('[data-develop-link="org.nendo.test.probe-a"]'); await idle();
  const card = await waitFor(() => evaluate(`document.querySelector('[data-package="org.nendo.test.probe-a"] .package-developing')?.textContent ?? null`), 'the card saying where probe A runs from');
  assert(card === 'Developing from develop-probe', 'The card does not name the folder: ' + JSON.stringify(card));
  await click('#nav-use'); await idle();
  await click('[data-select-surface="probe"]'); await idle();
  await waitFor(showing('folder-1'), 'the screen running the folder’s code', 30000);
  const strip = await evaluate(`(() => { const mount = [...document.querySelectorAll('[data-view-mount]')].find(m => m.dataset.viewId === 'probe');
    const banner = mount?.querySelector(':scope > [data-view-development]'); if (!banner) return null;
    const box = banner.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
    return { text: banner.textContent, height: box.height, own: banner.contains(hit), frameInside: Boolean(banner.querySelector('iframe')) }; })()`);
  assert(strip && /^Development This computer runs org\.nendo\.test\.probe-a from the folder develop-probe, not the code in the file\./.test(strip.text),
    'The Development strip does not say what runs: ' + JSON.stringify(strip));
  assert(strip.height >= 20 && strip.own && !strip.frameInside, 'The Development strip is hidden, covered or inside the view: ' + JSON.stringify(strip));
  const saved = Date.now();
  await fs.writeFile(path.join(developFolder, 'index.html'), (await fs.readFile(path.join(developFolder, 'index.html'), 'utf8')).replace('folder-1', 'folder-2'));
  await waitFor(showing('folder-2'), 'the screen reloaded after a save in the folder', 15000);
  report.measurements.developmentReloadMs = Date.now() - saved;
  assert(report.measurements.developmentReloadMs < 5000, `A save in the folder took ${report.measurements.developmentReloadMs} ms to reach the view.`);
  await click('[data-view-development] [data-develop-stop]'); await idle();
  await waitFor(showing('file'), 'the file’s code again after Stop developing', 30000);
  assert(!(await evaluate(`Boolean(document.querySelector('[data-view-development]'))`)), 'The Development strip outlived Stop developing.');
  assert((await installGate()).manifest.changeSequence === sequenceBefore, 'Developing from a folder wrote to the file.');
  check(`G20 probe A developed from a folder runs its code under a Development strip the view cannot cover, a save there reached the view in ${report.measurements.developmentReloadMs} ms, and Stop developing restores the file's code`);

  // G21 (W-069, ADR-0013 Phase 3): a view prepares a proposal in its package's name. It opens in
  // the ordinary review, which names the package; the view has no way to accept it; the person
  // accepts, and History attributes the change to the package.
  await click('#nav-use'); await idle();
  await click('[data-select-surface="probe"]'); await idle();
  const proposer = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'the probe screen running to propose', 30000);
  const proposerFrame = await frameSession(proposer.name);
  await waitFor(() => inFrame(proposerFrame, 'probe.state.ready'), 'the probe handshake to propose');
  const asked = await inFrame(proposerFrame, `(async () => {
    window.keptThroughReview = 'kept';
    const answer = await nendo.proposals.prepare('Add a due date from the view', [{ operationType: 'schema.addField',
      payload: { entityId: 'tasks', fieldId: 'viewDue', displayName: 'Due from the view', storageKind: 'date', required: false, presentation: 'date', options: [] } }]);
    return { answer, cannot: ['proposals.promote', 'proposals.reject', 'proposal.promote'].filter(name => nendo.has(name)) };
  })()`, 30000);
  assert(asked.answer.state === 'previewable' && asked.answer.opened === true && asked.cannot.length === 0,
    'The view could not prepare and open a proposal, or was offered a way to decide it: ' + JSON.stringify(asked));
  const heading = await waitFor(() => evaluate(`document.querySelector('.proposal-heading p')?.textContent ?? null`), 'the review of the view’s proposal');
  assert(heading === 'Prepared by the custom view Probe A (org.nendo.test.probe-a). Nothing changes until you accept.',
    'The review does not name the view that asked: ' + JSON.stringify(heading));
  await waitFor(() => evaluate(`document.querySelector('#accept-proposal')?.disabled === false`), 'the view’s proposal, ready to accept', 30000);
  await click('#accept-proposal'); await idle();
  // The view that asked was held through its review: the person is back on its screen, and it
  // is the same document, which reads its proposal as accepted.
  const back = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'the proposing view, back after acceptance', 30000);
  const backFrame = await frameSession(back.name);
  const after = await inFrame(backFrame, `(async () => ({ kept: window.keptThroughReview ?? null,
    state: (await nendo.proposals.get(${JSON.stringify(asked.answer.proposalId)})).state }))()`, 30000);
  assert(back.name === proposer.name && after.kept === 'kept' && after.state === 'active',
    'The view that asked did not run on through its review, or does not read it as accepted: ' + JSON.stringify({ before: proposer.name, after: back.name, ...after }));
  const proposedBy = (await gate('history.query', { limit: 5 })).items.find(item => item.description === 'Add a due date from the view');
  assert(proposedBy?.origin === 'extension:org.nendo.test.probe-a',
    'History does not name the view’s package on the change it proposed: ' + JSON.stringify(proposedBy));
  check('G21 a view prepares a proposal in its package’s name, the review names the package, the view cannot accept it, it runs on through the review and reads it as accepted, and History attributes the change to the package');

  // G22 (W-069, ADR-0013 Phase 3): a view keeps state with the file. A value comes back after the
  // view reloads; three writes to one key sent together reach the file as one, the last winning;
  // and History names the package on each.
  const keeper = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'the probe screen running to keep state', 30000);
  const keeperFrame = await frameSession(keeper.name);
  await waitFor(() => inFrame(keeperFrame, 'probe.state.ready'), 'the probe handshake to keep state');
  const keptAt = Date.now();
  const kept = await inFrame(keeperFrame, `(async () => {
    const layout = await nendo.state.set('layout', { zoom: 2, pinned: ['t1'] });
    const writes = await Promise.all([nendo.state.set('count', 1), nendo.state.set('count', 2), nendo.state.set('count', 3)]);
    return { layout, writes, has: ['state.get', 'state.set', 'state.delete', 'state.keys'].map(name => nendo.has(name)) };
  })()`, 30000);
  report.measurements.stateWritesMs = Date.now() - keptAt;
  assert(kept.has.every(Boolean) && kept.layout?.version === 1 && kept.layout.value?.zoom === 2 && kept.layout.value?.pinned?.join() === 't1',
    'The view could not keep a value: ' + JSON.stringify(kept));
  assert(kept.writes.every(write => write?.value === 3), 'Coalesced writes did not all hear the last value: ' + JSON.stringify(kept.writes));
  const stateRows = (await gate('history.query', { limit: 20 })).items.filter(item => item.origin === 'extension:org.nendo.test.probe-a' && /^Keep (count|layout) for the view /.test(item.description));
  const countRows = stateRows.filter(item => item.description.startsWith('Keep count')).length;
  assert(countRows === 1 && stateRows.length === 2 && kept.writes.every(write => write.version === 1),
    'Three writes to one key sent together did not reach the file as one, or History does not name the package: ' + JSON.stringify(stateRows.map(item => item.description)));
  // The document about to go is marked, and only a ready document without the mark counts as
  // reloaded. reload() returns before the page unloads, so the old document can still answer
  // "ready"; the next evaluate then landed mid-navigation and failed with "Cannot find default
  // execution context" (about one run in six under load, 2026-09-27).
  await inFrame(keeperFrame, 'window.journeyBeforeReload = true; location.reload()').catch(() => {});
  const reloaded = await waitFor(async () => {
    const running = (await frames()).find(f => f.view === 'probe' && f.state === 'running');
    if (!running) return null;
    const session = await frameSession(running.name);
    return (await inFrame(session, '!window.journeyBeforeReload && probe.state.ready').catch(() => false)) ? session : null;
  }, 'the probe view after reloading', 30000);
  const restored = await inFrame(reloaded, `(async () => ({ layout: await nendo.state.get('layout'), keys: await nendo.state.keys() }))()`, 30000);
  assert(restored.layout?.value?.zoom === 2 && restored.layout.value.pinned?.join() === 't1' && restored.keys.map(entry => entry.key).join() === 'count,layout',
    'A kept value did not come back after the view reloaded: ' + JSON.stringify(restored));
  check(`G22 a view keeps state with the file: it comes back after a reload, three writes to one key sent together reach the file as one, and History names the package on each (${report.measurements.stateWritesMs} ms)`);

  // G27 to G30 (W-090, ADR-0013 2026-09-28): a view's controls in Nendo's own chrome. The probe
  // declares a toolbar; Nendo draws it above the frame in its own controls, sends each press, its
  // Add, a Ctrl K entry and a key back as a command, draws the menu the view asks for, and keeps
  // its own keys working while the view has focus. Since W-092 the controls share the Use
  // toolbar's one row with Add, and the breadcrumb holds the record type and the view (G31).
  await click('#nav-use'); await idle();
  await click('[data-select-surface="probe"]'); await idle();
  const chromeView = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'the probe screen running for its toolbar', 30000);
  const chromeFrame = await frameSession(chromeView.name);
  await waitFor(() => inFrame(chromeFrame, 'probe.state.ready'), 'the probe handshake for its toolbar');
  assert((await inFrame(chromeFrame, `['ui.setToolbar', 'ui.showMenu'].map(name => nendo.has(name))`)).every(Boolean), 'The view is not offered the toolbar and the menu.');
  const declared = await inFrame(chromeFrame, 'probe.declare()', 10000);
  assert(declared === 'declared', 'The probe\u2019s toolbar was refused: ' + declared);
  const probeMount = `[...document.querySelectorAll('[data-view-mount]')].find(m => m.dataset.viewId === 'probe')`;
  // The probe's controls wherever Nendo drew them; G31 says where that has to be.
  const probeStrip = `(document.querySelector('.use-page > .use-toolbar > [data-view-toolbar-slot] > [data-view-toolbar]') ?? ${probeMount}?.querySelector('[data-view-toolbar]') ?? null)`;
  const chromeStrip = await waitFor(() => evaluate(`(() => { const chromeMount = ${probeMount};
    const bar = ${probeStrip};
    if (!bar) return 'error: no strip; the placeholder is ' + (chromeMount ? chromeMount.className + ' ' + chromeMount.dataset.viewState + ' holding ' + [...chromeMount.children].map(c => c.tagName + '.' + c.className).join(' ') : 'gone');
    const chromeBox = bar.getBoundingClientRect(), frame = chromeMount.querySelector('iframe').getBoundingClientRect();
    return { above: chromeBox.bottom <= frame.top + 1, height: Math.round(chromeBox.height), images: bar.querySelectorAll('img').length, markup: window.journeyMarkup ?? null,
      pin: bar.querySelector('[data-view-command="pin"]')?.textContent ?? null,
      choice: Boolean(bar.querySelector('.view-switcher [data-view-value="two"]')), search: Boolean(bar.querySelector('input[type="search"][data-view-command="find"]')),
      menu: Boolean(bar.querySelector('button[data-view-menu="export"][aria-haspopup="menu"]')), keys: bar.querySelector('[data-view-command="fit"]')?.getAttribute('aria-keyshortcuts') ?? null,
      idle: (() => { const commit = bar.querySelector('[data-view-command="commit"]'); return commit ? { disabled: commit.disabled, cursor: getComputedStyle(commit).cursor } : null; })() }; })()`),
  'the probe\u2019s toolbar, drawn by Nendo');
  assert(chromeStrip.above && chromeStrip.height >= 28 && chromeStrip.choice && chromeStrip.search && chromeStrip.menu && chromeStrip.keys === 'Control+0',
    'Nendo did not draw the declared toolbar above the frame in its own controls: ' + JSON.stringify(chromeStrip));
  assert(chromeStrip.images === 0 && chromeStrip.markup === null && chromeStrip.pin.includes('<img src=x'), 'A label a view declared became markup in the Workbench: ' + JSON.stringify(chromeStrip));
  report.measurements.viewToolbarHeight = chromeStrip.height;
  // A view's control disabled because there is nothing to do is not busy (Archi's Commit with no
  // edits waiting showed the wait cursor, 2026-10-01): the wait cursor is for what a save holds.
  assert(chromeStrip.idle?.disabled === true && chromeStrip.idle.cursor !== 'wait',
    'A view’s disabled control shows the busy cursor while nothing runs: ' + JSON.stringify(chromeStrip.idle));
  // With the key hints on, every control keeps its key inside itself: an icon button grows to
  // hold it rather than spilling it over the control beside it.
  await click('#shortcuts-toggle');
  const hinted = await waitFor(() => evaluate(`(() => { const bar = ${probeStrip};
    const shown = [...bar.querySelectorAll('.kbd-hint')].filter(hint => getComputedStyle(hint).display !== 'none').length; if (shown < 3) return null;
    const spill = [...bar.querySelectorAll('.view-toolbar-button')].filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.dataset.viewCommand);
    const boxes = [...bar.querySelectorAll('.view-toolbar-button, .view-toolbar-search, .view-switcher, .select-field')].map(e => e.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps += 1;
    }
    return { shown, spill, overlaps }; })()`), 'the key hints shown in the strip');
  await click('#shortcuts-toggle');
  assert(hinted.spill.length === 0 && hinted.overlaps === 0, 'With the key hints on, a control spills its key over the control beside it: ' + JSON.stringify(hinted));
  check(`G27 a view's declared toolbar is drawn by Nendo above its frame (${chromeStrip.height} px) in Nendo's own controls, a label that looks like markup stays text, and with the key hints on each of ${hinted.shown} keys stays inside its control`);

  // G31 (W-092, ADR-0013 2026-09-28, one row above a view): the breadcrumb holds the record type
  // and the view, the Use toolbar holds nothing but what acts on the screen, and the view's
  // controls share its row with Add. Measured, not looked at: the height between the top bar and
  // the view's frame is that one row, where it was the Use toolbar and a strip of its own.
  const oneRow = await evaluate(`(() => { const header = document.querySelector('.workspace-header'), row = document.querySelector('.use-page > .use-toolbar');
    const frame = ${probeMount}.querySelector('iframe'), bar = ${probeStrip}, add = document.querySelector('#new-record');
    const between = frame.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    return { between: Math.round(between), row: Math.round(row.getBoundingClientRect().height), headerHeight: Math.round(header.getBoundingClientRect().height),
      frameTop: Math.round(frame.getBoundingClientRect().top),
      pickers: Boolean(header.querySelector('#use-entity')) && Boolean(header.querySelector('.surface-picker [data-select-surface="probe"][aria-pressed="true"]')),
      rowPickers: Boolean(row.querySelector('#use-entity, .surface-picker')), sameRow: bar !== null && add !== null && bar.closest('.use-toolbar') === add.closest('.use-toolbar'),
      stripInMount: Boolean(${probeMount}.querySelector('[data-view-toolbar]')) }; })()`);
  assert(oneRow.pickers && !oneRow.rowPickers && oneRow.sameRow && !oneRow.stripInMount && oneRow.between <= oneRow.row + 2,
    'More than one row stands between the top bar and the view, or the pickers are not in the breadcrumb: ' + JSON.stringify(oneRow));
  report.measurements.betweenTopBarAndView = oneRow.between;
  check(`G31 one row above a view: the breadcrumb holds the record type and the view, and the view's controls share the Use toolbar's row with Add, so ${oneRow.between} px stand between the top bar and the view's frame, the height of that one row`);

  // G32 (W-093): Nendo's top bar is the window's title bar. Measured in the window by the host's
  // own diagnostics: the page starts at the window's top edge, so the height above a screen's
  // content is the bar's alone, where Windows' title bar stood over it; Windows holds the bar as
  // the caption, which drags, and passes each of its controls through to the page; no control
  // sits under Windows' Minimise, Maximise and Close, which answer as those (the snap layouts
  // hang on Maximise). An open menu takes the whole bar up to them, so a press there closes it.
  const titleBar = await measureTitleBar('the probe screen');
  report.measurements.aboveContent = titleBar.above;
  await click('#file-menu summary');
  const menuBar = await waitFor(async () => {
    const d = await gate('diagnostics.titleBar', { points: [] });
    return d.passthrough.some(r => r.x <= 0.5 && r.y <= 0.5 && r.width >= d.clientWidth - d.bar.right - 1 && r.height >= d.bar.height - 0.5) ? d : null;
  }, 'the open File menu taking the whole bar');
  await click('#file-menu summary');
  await waitFor(async () => {
    const d = await gate('diagnostics.titleBar', { points: [] });
    return d.passthrough.length > 1 && !d.passthrough.some(r => r.width >= d.clientWidth - d.bar.right - 1) ? true : null;
  }, 'the closed File menu giving the bar back to the window');
  check(`G32 the top bar is the window's title bar: the page starts at the window's top edge and ${titleBar.above} px stand above the content, the bar's own ${menuBar.bar.height}; Windows holds it as the caption and passes each of its ${titleBar.controls} controls through, none under Windows' own ${Math.round(menuBar.bar.right)} px of buttons, which answer as Minimise, Maximise and Close; an open menu takes the whole bar and gives it back`);

  // G28: a press in the strip, Nendo's own Add and a Ctrl K entry each reach the view as a command.
  const heard = () => inFrame(chromeFrame, 'probe.state.commands.map(c => [c.id, c.value, c.source].join(":"))');
  await evaluate(`${probeStrip}.querySelector('[data-view-command="mode"][data-view-value="two"]').click()`);
  await evaluate(`${probeStrip}.querySelector('[data-view-command="pin"]').click()`);
  await waitFor(async () => (await heard()).join() === 'mode:two:toolbar,pin:true:toolbar' ? true : null, 'two presses reaching the view');
  const shown = await evaluate(`(() => { const bar = ${probeStrip};
    return [bar.querySelector('[data-view-value="two"]').getAttribute('aria-pressed'), bar.querySelector('[data-view-command="pin"]').getAttribute('aria-pressed')]; })()`);
  assert(shown.join() === 'true,true', 'Nendo did not show the presses at once: ' + JSON.stringify(shown));
  await click('#new-record');
  await waitFor(async () => (await heard()).includes('probe-add::add') ? true : null, 'Nendo\u2019s Add reaching the view');
  await sleep(300);
  assert(!(await evaluate(`Boolean(document.querySelector('.record-inspector #record-form'))`)), 'Nendo\u2019s Add opened its own form although the view took it.');
  await click('#palette-open');
  const listed = await waitFor(() => evaluate(`(() => { const items = [...document.querySelectorAll('#command-palette-list li')].map(li => li.textContent);
    return items.some(text => text === 'FitProbe screenCtrl 0') ? items.filter(text => text.includes('Probe screen')) : null; })()`), 'the probe\u2019s commands in Ctrl K');
  for (const expected of ['Mode: OneProbe screen', 'Turn off Pin <img src=x onerror=parent.journeyMarkup=1>Probe screen', 'Find a taskProbe screenCtrl Shift F', 'Export: SVGProbe screen', 'Export: Turn on LightProbe screen'])
    assert(listed.includes(expected), `Ctrl K does not list "${expected}": ` + JSON.stringify(listed));
  await evaluate(`[...document.querySelectorAll('#command-palette-list li')].find(li => li.textContent === 'FitProbe screenCtrl 0').click()`);
  await waitFor(async () => (await heard()).includes('fit::palette') ? true : null, 'the Ctrl K entry reaching the view');
  assert(!(await evaluate(`document.querySelector('#command-palette').open`)), 'The palette stayed open after running a view\u2019s command.');
  check('G28 a press in the strip, Nendo\u2019s own Add (its form left closed) and a Ctrl K entry each reach the view as a command, and the strip shows the press at once');

  // G29: the menu a view asks for is Nendo's, at the point in the frame, and answers the pick; Escape answers nothing.
  await inFrame(chromeFrame, 'probe.menu(40, 30)');
  const menu = await waitFor(() => evaluate(`(() => { const m = document.querySelector('[data-view-menu-open]'); if (!m) return null;
    const chromeBox = m.getBoundingClientRect(), frame = ${probeMount}.querySelector('iframe').getBoundingClientRect();
    return { items: [...m.querySelectorAll('.view-menu-item')].map(i => i.textContent), dx: Math.round(chromeBox.left - frame.left), dy: Math.round(chromeBox.top - frame.top),
      onBody: m.parentElement === document.body, focused: m.contains(document.activeElement) }; })()`), 'Nendo\u2019s menu for the probe');
  assert(menu.onBody && Math.abs(menu.dx - 40) <= 2 && Math.abs(menu.dy - 30) <= 2 && menu.items.join('|') === 'Open|RenameF2|Delete' && menu.focused,
    'The view\u2019s menu is not Nendo\u2019s, at its point, with its items: ' + JSON.stringify(menu));
  await evaluate(`[...document.querySelectorAll('[data-view-menu-open] .view-menu-item')][1].click()`);
  const picked = await waitFor(() => inFrame(chromeFrame, `probe.state.pick && probe.state.pick !== 'waiting' ? probe.state.pick : null`), 'the pick reaching the view');
  assert(picked.id === 'rename' && picked.value === null, 'The view did not hear its pick: ' + JSON.stringify(picked));
  await inFrame(chromeFrame, 'probe.menu(10, 10)');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-view-menu-open]'))`), 'the second menu');
  await evaluate(`document.querySelector('[data-view-menu-open] .view-menu-item').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await waitFor(() => inFrame(chromeFrame, `probe.state.pick === null ? 'dismissed' : null`), 'a dismissed menu answering nothing');
  assert(!(await evaluate(`Boolean(document.querySelector('[data-view-menu-open]'))`)), 'Escape left the menu open.');
  check(`G29 the menu a view asks for is Nendo's, drawn on the Workbench at the view's point (${menu.dx}, ${menu.dy}), and answers the pick; Escape answers nothing`);

  // G30: keys. A key pressed inside a view never reaches the Workbench's document on its own:
  // Nendo's own come back through api.js, before the view sees them, and a declared key runs its
  // command wherever focus is. The keys are real key events, sent to the focused frame.
  const press = async (key, code, keyCode, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers }, page);
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers }, page);
  };
  // The window runs hidden, so focus is emulated as a focused window's would be.
  await command('Emulation.setFocusEmulationEnabled', { enabled: true }, page);
  await evaluate(`${probeMount}.querySelector('iframe').focus()`);
  await inFrame(chromeFrame, `document.body.tabIndex = -1; document.body.focus(); probe.state.keys.length = 0; true`);
  await press('q', 'KeyQ', 81);
  await waitFor(async () => (await inFrame(chromeFrame, 'probe.state.keys.join()')) === 'q' ? true : null, 'a key the view keeps reaching the view');
  await press('k', 'KeyK', 75, 2);
  await waitFor(() => evaluate(`document.querySelector('#command-palette')?.open === true`), 'Ctrl K pressed inside the view opening the palette', 5000);
  assert(!(await inFrame(chromeFrame, 'probe.state.keys.includes("Ctrl+k")')), 'The view heard Ctrl K, which is Nendo\u2019s.');
  await evaluate(`document.querySelector('#command-palette').close()`);
  await evaluate(`${probeMount}.querySelector('iframe').focus()`);
  const beforeKey = (await heard()).length;
  await press('0', 'Digit0', 48, 2);
  await waitFor(async () => (await heard()).slice(beforeKey).includes('fit::key') ? true : null, 'a declared key pressed inside the view running its command');
  await evaluate(`document.activeElement?.blur(); document.body.focus(); true`);
  await press('0', 'Digit0', 48, 2);
  await waitFor(async () => (await heard()).slice(beforeKey).filter(line => line === 'fit::key').length === 2 ? true : null, 'the declared key pressed in the Workbench running its command');
  check('G30 Ctrl K pressed inside a view opens the palette before the view hears it, a key the view keeps reaches it, and a declared key runs its command from inside the view and from the Workbench');

  // G33 (W-127, the owner's F-215): a view takes part in Back and Forward. A place it declares
  // is a step the Back button names; declaring it again is none; Back and Forward hand the view
  // its place as the event place; and Back from a record the view opened comes back to the view
  // at the place it left, whether its frame kept running or started again.
  assert(await inFrame(chromeFrame, `nendo.has('ui.setPlace')`), 'The view is not offered ui.setPlace.');
  const backTitle = () => evaluate(`document.querySelector('#nav-back').title`);
  await inFrame(chromeFrame, `(async () => { window.heardPlaces = []; nendo.on('place', place => heardPlaces.push(place));
    await nendo.ui.setPlace({ page: 'one' }, { label: 'Page one', replace: true }); await nendo.ui.setPlace({ page: 'two' }, { label: 'Page two' }); return true; })()`);
  await waitFor(async () => /Page one/.test(await backTitle()) ? true : null, 'Back naming the view\u2019s first page');
  await inFrame(chromeFrame, `nendo.ui.setPlace({ page: 'two' }, { label: 'Page two' })`);
  await sleep(200);
  assert(/Page one/.test(await backTitle()), 'Declaring the place the view already had made a step: Back says ' + JSON.stringify(await backTitle()));
  await click('#nav-back'); await idle();
  await waitFor(async () => JSON.stringify(await inFrame(chromeFrame, 'heardPlaces')) === '[{"page":"one"}]' ? true : null, 'Back handing the view its first page');
  const contextAfterBack = await inFrame(chromeFrame, 'nendo.context.place');
  assert(contextAfterBack?.page === 'one', 'Back left the view\u2019s context at another place: ' + JSON.stringify(contextAfterBack));
  const forwardTitle = await evaluate(`document.querySelector('#nav-forward').title`);
  assert(/Page two/.test(forwardTitle), 'Forward does not name the view\u2019s second page: ' + JSON.stringify(forwardTitle));
  await click('#nav-forward'); await idle();
  await waitFor(async () => (await inFrame(chromeFrame, 'heardPlaces.at(-1)?.page')) === 'two' ? true : null, 'Forward handing the view its second page');
  await inFrame(chromeFrame, `nendo.ui.openRecord('tasks', 't1')`);
  await waitFor(async () => /Page two/.test(await backTitle()) ? true : null, 'Back from the record naming the view\u2019s page');
  await click('#nav-back'); await idle();
  const cameBack = await waitFor(async () => {
    const running = (await frames()).find(f => f.view === 'probe' && f.state === 'running');
    if (!running) return null;
    const session = await frameSession(running.name);
    const place = await inFrame(session, 'probe.state.ready ? nendo.context?.place ?? "none" : null').catch(() => null);
    return place?.page === 'two' ? { restarted: running.name !== chromeView.name } : null;
  }, 'the view back at its second page after Back from the record it opened', 30000);
  check(`G33 a view takes part in Back and Forward: its places are steps the buttons name, declaring one again is none, Back and Forward hand it the place as the event place, and Back from a record it opened returns it to its page (${cameBack.restarted ? 'started again from its context' : 'its frame kept'})`);

  // G32, on every kind of screen and in a narrow window: a Studio page holds the same bar, and in a
  // window at most 840px wide the rail is the bar across the top, which keeps Windows' buttons free
  // and passes its own controls through as the top bar does.
  await click('#nav-data'); await idle();
  const studioBar = await measureTitleBar('Studio › Data');
  await gate('diagnostics.resizeWindow', { width: 760, height: 700 });
  await waitFor(() => evaluate(`document.documentElement.clientWidth <= 840 && getComputedStyle(document.querySelector('.app-shell')).gridTemplateRows.split(' ').length === 2`), 'the rail across the top of a narrow window');
  const narrowBar = await measureTitleBar('a 760 × 700 window', true);
  check(`G32 on Studio › Data ${studioBar.above} px stand above the content, and in a 760 × 700 window the rail is the title bar, its ${narrowBar.controls} controls passed through and none under Windows' buttons`);

  // G34 (W-104): a view reads a file the person chooses with the browser's own file input. The
  // click opens Windows' Open dialog, owned by Nendo's window; closing it is Cancel, and the view
  // hears cancel with nothing chosen. A chosen file arrives whole: its name, its size and its text.
  // The system file picker is measured too, and what it answers is recorded.
  // Last of all: the Nendo file dropped at the end is caught on its way to the host, and the
  // Workbench waits for an answer that does not come.
  await click('#nav-use'); await idle();
  await click('[data-select-surface="probe"]'); await idle();
  const fileView = await waitFor(async () => (await frames()).find(f => f.view === 'probe' && f.state === 'running'), 'the probe screen for files', 30000);
  const fileFrame = await frameSession(fileView.name);
  await waitFor(() => inFrame(fileFrame, 'probe.state.ready'), 'the probe handshake for files');
  const modelText = '<?xml version="1.0" encoding="UTF-8"?>\n<archimate:model name="Café ✓" id="journey"/>\n';
  const modelPath = path.join(output, 'journey model.archimate');
  await fs.writeFile(modelPath, modelText, 'utf8');
  const picking = await byPerson(fileFrame, `probe.pickFile('.archimate')`);
  assert(picking === 'asked', 'The view asked for a file without the person\u2019s activation: ' + picking);
  const dialogs = await closeHostDialog();
  assert(dialogs.length === 1, 'No Open dialog owned by Nendo\u2019s window came up for the view\u2019s file input: ' + JSON.stringify(dialogs));
  report.measurements.viewFileDialog = dialogs[0];
  await waitFor(() => inFrame(fileFrame, `probe.state.file === 'cancelled' ? true : null`), 'cancel reaching the view with nothing chosen');
  const { root: fileRoot } = await command('DOM.getDocument', { depth: 0 }, fileFrame.session);
  const { nodeId: inputNode } = await command('DOM.querySelector', { nodeId: fileRoot.nodeId, selector: '#probe-file' }, fileFrame.session);
  await inFrame(fileFrame, `probe.state.file = 'waiting'`);
  await command('DOM.setFileInputFiles', { files: [modelPath], nodeId: inputNode }, fileFrame.session);
  const chosen = await waitFor(() => inFrame(fileFrame, `typeof probe.state.file === 'object' && probe.state.file !== null ? probe.state.file : null`), 'the chosen file reaching the view');
  assert(chosen.name === 'journey model.archimate' && chosen.text === modelText && chosen.size === Buffer.byteLength(modelText),
    'The chosen file did not arrive whole: ' + JSON.stringify(chosen));
  // The system pickers would hand a view a file it could write back to. The browser refuses them in
  // a frame of another origin; a dialog one opened anyway is closed and named.
  const systemPickers = {};
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    let answer = await byPerson(fileFrame, `Promise.race([probe.systemPicker(${JSON.stringify(name)}), new Promise(resolve => setTimeout(() => resolve('pending'), 2000))])`, 10000);
    if (answer === 'pending') answer = 'opened a dialog: ' + JSON.stringify(await closeHostDialog());
    systemPickers[name] = answer;
  }
  report.measurements.viewSystemPickers = systemPickers;
  assert(Object.values(systemPickers).every(answer => /^refused: SecurityError: .*Cross origin sub frames aren't allowed to show a file picker/.test(answer)),
    'A system file picker was not refused to the view: ' + JSON.stringify(systemPickers));
  check(`G34 a view's file input opens Windows' "${dialogs[0]}" dialog owned by Nendo's window, closing it reaches the view as cancel, and a chosen file arrives whole (${chosen.size} bytes); the open, save and directory pickers are each refused with SecurityError: "Cross origin sub frames aren't allowed to show a file picker."`);

  // G35 (W-104): a file dragged onto a view lands in the view when the view takes it, both when the
  // drag comes straight onto the view and when it crosses Nendo first, and Nendo's own drop hint
  // steps aside over the view. A view that does not take drops lets a drop fall: nothing opens,
  // nothing moves. Dropped elsewhere, the file is still Nendo's: a file that is not a Nendo file is
  // refused by name, and a Nendo file is handed to the host to open. Real drags carrying a file on
  // disk, through the browser's input.
  const centre = selector => evaluate(`(() => { const box = ${selector}.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
  const onView = await centre(`${probeMount}.querySelector('iframe')`);
  const onRail = await centre(`document.querySelector('#nav-use')`);
  const drag = (type, at) => command('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: { items: [], files: [modelPath], dragOperationsMask: 1 } }, page);
  const hint = () => evaluate(`document.querySelector('#file-drop-target')?.hidden === false`);
  const alertText = () => evaluate(`document.querySelector('.message-slot[role="alert"]:not([hidden])')?.textContent ?? ''`);
  // A drag that crosses from the Workbench into a view's frame moves between two renderers. The
  // window's own drag tells the one it left and the one it entered; CDP sends each event to the
  // renderer under its point and tells neither, so the journey does what the window does, and only
  // when the browser's hit test has put the point in the view: the Workbench no longer hears it.
  // CDP has no leave for a renderer (its dragCancel ends the whole drag), so the leave is the
  // dragleave the Workbench's document would get, raised on the element the drag was over.
  await evaluate(`window.journeyDragovers = 0; window.journeyDragleaves = 0; document.addEventListener('dragover', () => { journeyDragovers += 1; }, true);
    document.addEventListener('dragleave', () => { journeyDragleaves += 1; }, true); true`);
  const dropOnView = async (from, label) => {
    await inFrame(fileFrame, `probe.state.dropped = undefined; probe.state.drags = 0; true`);
    await drag('dragEnter', from);
    await drag('dragOver', from);
    const hintBefore = await hint();
    const heard = await evaluate('journeyDragovers');
    await drag('dragOver', onView);
    const crossed = from !== onView && await evaluate('journeyDragovers') === heard;
    if (crossed) {
      await evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([''], 'journey model.archimate'));
        document.elementFromPoint(${from.x}, ${from.y}).dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: transfer })); return true; })()`);
      await drag('dragEnter', onView);
    }
    await drag('dragOver', onView);
    const hintOver = await waitFor(async () => (await hint()) ? null : 'stepped aside', 'the hint stepping aside', 3000)
      .then(() => false, async () => ({ shown: true, leaves: await evaluate('journeyDragleaves'), overs: await evaluate('journeyDragovers') }));
    await drag('drop', onView);
    const dropped = await waitFor(async () => {
      const value = await inFrame(fileFrame, 'probe.state.dropped ?? null');
      if (value !== null) return value;
      return /journey model/.test(await alertText()) ? { refusedByNendo: await alertText() } : null;
    }, 'the file dropped on the view (' + label + ')', 10000);
    assert(dropped.text === modelText && dropped.name === 'journey model.archimate',
      `A file dropped on the view (${label}) did not reach it: ` + JSON.stringify({ dropped, hintBefore, hintOver }));
    assert(!hintOver && !(await hint()), `Nendo's drop hint stayed over the view (${label}): ` + JSON.stringify(hintOver));
    return { hintBefore, crossed };
  };
  const viewOrigin = await inFrame(fileFrame, 'performance.timeOrigin');
  const workbenchAt = await evaluate('location.href');
  await drag('dragEnter', onView);
  await drag('dragOver', onView);
  await drag('drop', onView);
  await sleep(1000);
  const fell = { alert: await alertText(), hint: await hint(), dropped: await inFrame(fileFrame, 'probe.state.dropped ?? null'),
    reloaded: await inFrame(fileFrame, 'performance.timeOrigin') !== viewOrigin, moved: await evaluate('location.href') !== workbenchAt };
  assert(fell.alert === '' && !fell.hint && fell.dropped === null && !fell.reloaded && !fell.moved,
    'A drop on a view that does not take drops did something: ' + JSON.stringify(fell));
  await inFrame(fileFrame, `probe.acceptDrops()`);
  const straight = await dropOnView(onView, 'straight onto the view');
  assert(!straight.hintBefore, 'Nendo drew its drop hint for a drag that came straight onto the view.');
  await inFrame(fileFrame, `probe.state.dropped = undefined; true`);
  await drag('dragEnter', onRail);
  await drag('dragOver', onRail);
  await drag('drop', onRail);
  const refusedDrop = await waitFor(async () => /journey model\.archimate/.test(await alertText()) ? await alertText() : null, 'Nendo refusing a foreign file dropped on its rail');
  assert(await inFrame(fileFrame, `probe.state.dropped === undefined`), 'The view heard a drop that was not on it.');
  // A Nendo file dropped on the rail goes to the host as before. The hand-over is caught on its way
  // out rather than sent: the host's open path is unchanged, and it would ask about this file first.
  const nendoPath = path.join(output, 'dropped.nendo');
  await fs.writeFile(nendoPath, '');
  const caught = await evaluate(`(() => { window.journeyHandoffs = [];
    chrome.webview.postMessageWithAdditionalObjects = (message, objects) => { journeyHandoffs.push({ method: message.method, files: [...objects].map(file => file.name) }); };
    return chrome.webview.postMessageWithAdditionalObjects.toString().includes('journeyHandoffs'); })()`);
  assert(caught, 'The journey could not catch the Workbench\u2019s hand-over to the host.');
  const nendoDrag = (type, at) => command('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: { items: [], files: [nendoPath], dragOperationsMask: 1 } }, page);
  await nendoDrag('dragEnter', onRail);
  await nendoDrag('dragOver', onRail);
  await nendoDrag('drop', onRail);
  const handoff = await waitFor(() => evaluate(`journeyHandoffs.find(item => item.method === 'file.openDropped') ?? null`), 'a Nendo file dropped on the rail handed to the host');
  assert(handoff.files.length === 1 && handoff.files[0] === 'dropped.nendo', 'The host was handed something else: ' + JSON.stringify(handoff));
  // Last, because the leave the journey raises is the document's event and not the renderer's: the
  // Workbench's renderer still holds this drag afterwards, as it would not after a real one.
  const crossing = await dropOnView(onRail, 'across Nendo first');
  assert(crossing.hintBefore, 'Nendo did not offer its drop hint while the drag was over its own rail.');
  assert(crossing.crossed, 'The drag over the view was still the Workbench’s.');
  check(`G35 a drop on a view that does not take drops falls without effect; a file dropped on a view that takes it reaches it straight on and after crossing Nendo, whose hint steps aside over the view; on the rail a foreign file is refused by name ("${refusedDrop}") and a Nendo file is handed to the host to open`);

  console.log('extension views ok');
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'journey.json'), JSON.stringify(report, null, 2)).catch(() => {});
  socket.close();
  canary.close();
}
