import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The record-panel journey (ADR-0013, 2026-09-24; W-061), against a real Nendo with an
// isolated profile. The page is driven over its own debugging port; where the contained
// view actually is comes from Windows (Runtime-ExtensionPanel.ps1), in physical pixels,
// because the page's own idea of where it put the view is the thing being checked.
const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, process and output are required.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, next = 0;
const pending = new Map();
function assert(value, message) { if (!value) throw new Error(message); }
async function waitFor(read, label, timeout = 25000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) { last = await read(); if (last) return last; await sleep(150); }
  throw new Error('Timed out: ' + label + (last === undefined ? '' : ' (last: ' + JSON.stringify(last) + ')'));
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
function probe(action = 'Inspect') {
  const script = fileURLToPath(new URL('./Runtime-ExtensionPanel.ps1', import.meta.url));
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-TargetProcessId', processId, '-Action', action],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert(result.status === 0, 'Native panel probe failed: ' + (result.stderr || result.stdout));
  return action === 'Inspect' ? JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')) : null;
}
function dialog(action) {
  const script = fileURLToPath(new URL('./Runtime-WorkbenchWindow.ps1', import.meta.url));
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-TargetProcessId', processId, '-Action', action,
    '-DialogId', 'extensions.manage', '-Base64Inspection'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert(result.status === 0, 'Native dialog action failed: ' + (result.stderr || result.stdout));
}
const near = (actual, expected, slack = 2) => Math.abs(actual - expected) <= slack;
// The placeholder's viewport, its scroller, and the sticky bars that cut it, in CSS pixels.
const geometry = (viewId) => evaluate(`(() => {
  const panel = document.querySelector('[data-extension-panel="${viewId}"]');
  const viewport = panel.querySelector('[data-panel-viewport]');
  const scroller = document.querySelector('.record-inspector');
  const r = viewport.getBoundingClientRect(), s = scroller.getBoundingClientRect();
  const header = scroller.querySelector(':scope > header').getBoundingClientRect();
  const actions = scroller.querySelector('.form-actions').getBoundingClientRect();
  return { dpr: devicePixelRatio, rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    shown: { top: Math.max(r.top, s.top, header.bottom), bottom: Math.min(r.bottom, s.bottom, actions.top) }, scrollTop: scroller.scrollTop };
})()`);
const statusOf = (viewId) => evaluate(`document.querySelector('[data-extension-panel="${viewId}"] .extension-panel-status')?.textContent ?? null`);
const nextOf = (viewId) => evaluate(`(() => { const b = document.querySelector('[data-extension-panel="${viewId}"] [data-panel-next]'); return b && !b.hidden && !b.disabled ? b.textContent : null; })()`);
const one = (report) => report.Windows.length === 1 ? report.Windows[0] : null;

try {
  const target = await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page' && t.url === 'https://app.nendo.local/index.html'); }
    catch { return null; }
  }, 'owned Workbench');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    const item = pending.get(value.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    if (value.error) item.reject(new Error(value.error.message)); else item.resolve(value.result);
  });
  await command('Runtime.enable');
  await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'Workbench idle');
  await evaluate(`window.panelGateRequest = (method, payload = {}) => new Promise((resolve, reject) => {
    const requestId = 'panel-gate-' + crypto.randomUUID();
    const listener = event => { const r = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (r.requestId !== requestId) return; chrome.webview.removeEventListener('message', listener);
      if (r.ok) resolve(r.result); else reject(new Error(r.error.message)); };
    chrome.webview.addEventListener('message', listener);
    chrome.webview.postMessage({ protocolVersion: 7, requestId, fileSessionId: window.panelGateSession, method, payload });
  });`);
  const snapshot = await evaluate(`panelGateRequest('session.getSnapshot')`);
  await evaluate(`window.panelGateSession = ${JSON.stringify(snapshot.fileSessionId)}`);
  await evaluate(`panelGateRequest('appearance.set', {preference:'light',effective:'light'})`);

  // Open the record page. Both views are allowed; neither may start until asked.
  await evaluate('document.querySelector("#nav-use").click()');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[data-record-id="t1"]\'))'), 'record list');
  await evaluate('document.querySelector(\'[data-record-id="t1"]\').click()');
  await waitFor(async () => (await nextOf('plan')) === 'Show view' && (await nextOf('later')) === 'Show view', 'both placeholders offer Show view');
  await sleep(1500);
  const idle = probe();
  assert(idle.Helpers.length === 0 && idle.Windows.length === 0, 'A view started before anyone asked for it: ' + JSON.stringify(idle));

  // Show the first. Its window is the placeholder's size exactly, in physical pixels.
  await evaluate(`document.querySelector('[data-extension-panel="plan"]').scrollIntoView({block:'center'})`);
  await sleep(400);
  await evaluate(`document.querySelector('[data-extension-panel="plan"] [data-panel-next]').click()`);
  const first = await waitFor(() => { const w = one(probe()); return w?.Visible ? w : null; }, 'the first view shown');
  const at = await geometry('plan');
  assert(near(first.Width, at.rect.width * at.dpr) && near(first.Height, at.rect.height * at.dpr),
    'The view is not the placeholder\'s size: ' + JSON.stringify({ window: first, placeholder: at }));

  // Scrolled, it moves by exactly the scroll and keeps its size; a resize would reflow the page inside.
  await evaluate(`document.querySelector('.record-inspector').scrollTop += 60`);
  const moved = await waitFor(async () => {
    await sleep(400);
    const w = one(probe()); const g = await geometry('plan');
    return w?.Visible && near(w.Top, first.Top - (at.rect.top - g.rect.top) * at.dpr, 3) ? { w, g } : null;
  }, 'the view followed the scroll');
  assert(moved.w.Width === first.Width && moved.w.Height === first.Height, 'Scrolling resized the view: ' + JSON.stringify({ first, moved: moved.w }));

  // While the page is scrolling the view is hidden, and it comes back when scrolling stops.
  await evaluate(`window.panelGateScroll = setInterval(() => { const s = document.querySelector('.record-inspector'); s.scrollTop += (s.scrollTop % 2 ? -1 : 1); }, 16)`);
  await sleep(300);
  const during = one(probe());
  await evaluate('clearInterval(window.panelGateScroll)');
  assert(during && !during.Visible, 'The view stayed on screen while the page scrolled under it: ' + JSON.stringify(during));
  await waitFor(() => one(probe())?.Visible, 'the view back after scrolling');

  // Half under the sticky header: the window is cut to what the page shows, not squeezed.
  await evaluate(`(() => { const s = document.querySelector('.record-inspector'); const v = document.querySelector('[data-extension-panel="plan"] [data-panel-viewport]');
    const header = s.querySelector(':scope > header').getBoundingClientRect(); s.scrollTop += v.getBoundingClientRect().top - header.bottom + 150; })()`);
  let lastClip = null;
  const clipped = await waitFor(async () => {
    await sleep(400);
    const w = one(probe()); const g = await geometry('plan');
    const expectedTop = (g.shown.top - g.rect.top) * g.dpr, expectedHeight = (g.shown.bottom - g.shown.top) * g.dpr;
    lastClip = { region: w?.Region, visible: w?.Visible, expectedTop: Math.round(expectedTop), expectedHeight: Math.round(expectedHeight) };
    return w?.Visible && w.RegionKind === 2 && near(w.Region.Top, expectedTop, 3) && near(w.Region.Height, expectedHeight, 3) && w.Height === first.Height
      ? { w, g, expectedTop, expectedHeight } : null;
  }, 'the view cut to the part the page shows').catch(error => { throw new Error(error.message + ': ' + JSON.stringify(lastClip)); });

  // A native dialog is XAML, under every child window: the view steps aside while it is open.
  await evaluate(`window.panelGateDialog = panelGateRequest('file.customViews'); void 0`);
  await waitFor(() => one(probe())?.Visible === false, 'the view hidden under a native dialog');
  dialog('Close');
  await evaluate('window.panelGateDialog');
  await waitFor(() => one(probe())?.Visible, 'the view back after the dialog');

  // Showing the second stops the first: one view per window.
  await evaluate(`document.querySelector('[data-extension-panel="later"]').scrollIntoView({block:'center'})`);
  await sleep(400);
  await evaluate(`document.querySelector('[data-extension-panel="later"] [data-panel-next]').click()`);
  let lastRun = null;
  const second = await waitFor(() => { const r = probe(); lastRun = r; const w = one(r); return r.Helpers.length === 1 && w?.Visible && w.ProcessId !== first.ProcessId ? w : null; },
    'only the second view running').catch(error => { throw new Error(error.message + ': ' + JSON.stringify({ first: first.ProcessId, running: lastRun?.Helpers })); });
  assert(await waitFor(async () => (await nextOf('plan')) === 'Show view', 'the first placeholder offers Show view again'), 'The stopped view still reads as running.');

  // Both themes: the placeholder is drawn in each, and its text stands off its background.
  const themes = {};
  for (const theme of ['dark', 'light']) {
    // The page's own theme buttons: they restyle the page and tell the host, which restyles the view.
    await evaluate(`document.querySelector('[data-theme-option="${theme}"]').click()`);
    await sleep(500);
    themes[theme] = await evaluate(`(() => { const p = document.querySelector('[data-extension-panel="plan"]'); const s = p.querySelector('.extension-panel-status');
      const back = getComputedStyle(document.querySelector('.record-inspector')).backgroundColor; return { text: getComputedStyle(s).color, back, theme: document.documentElement.dataset.theme ?? null }; })()`);
    assert(themes[theme].text !== themes[theme].back, 'The placeholder text vanishes in ' + theme + ': ' + JSON.stringify(themes[theme]));
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(output, `record-panel-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert(themes.dark.back !== themes.light.back, 'The record page did not change theme: ' + JSON.stringify(themes));

  // A view that dies leaves the page: its placeholder says so, and the record still saves.
  probe('Crash');
  const reason = await waitFor(async () => { const s = await statusOf('later'); return s && /stopped|closed/.test(s) ? s : null; }, 'the stopped view explained in its placeholder');
  assert(/^This view has (stopped|closed)\. The page is still yours to edit\.$/.test(reason), 'A view that died is explained as something else: ' + reason);
  assert(await waitFor(async () => (await nextOf('later')) === 'Show view', 'Show view offered again'), 'The failed view offered no way back.');
  await evaluate(`(() => { const field = document.querySelector('#record-form [name="title"]'); field.value = 'Saved after the view stopped';
    field.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#record-form').requestSubmit(); })()`);
  await waitFor(() => evaluate(`panelGateRequest('data.queryRecords', {entityId:'tasks',recordId:'t1',limit:1}).then(p => p.items[0]?.values.title === 'Saved after the view stopped')`), 'the record saved after the view stopped');

  // Leaving the page lets go of the view.
  await waitFor(async () => (await nextOf('plan')) === 'Show view', 'the page redrawn after saving');
  await evaluate(`document.querySelector('[data-extension-panel="plan"] [data-panel-next]').click()`);
  await waitFor(() => one(probe())?.Visible, 'the view shown again');
  await evaluate('document.querySelector("#close-inspector").click()');
  await waitFor(() => probe().Helpers.length === 0, 'the view stopped when its page closed');

  const evidence = { idle, first, followedScroll: moved.w, hiddenWhileScrolling: during, clipped, second: second.ProcessId, stoppedReason: reason, themes };
  await fs.writeFile(path.join(output, 'record-panel-journey.json'), JSON.stringify(evidence, null, 2));
  console.log('record panel ok ' + JSON.stringify({ size: [first.Width, first.Height], clip: clipped.w.Region, dpr: at.dpr }));
} finally { socket?.close(); }
