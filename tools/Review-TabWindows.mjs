// A tab moved to a window of its own (ADR-0002), in a real Nendo against an
// isolated profile built by DesktopExtensionViewJourneyTests. Measured over the browser's debugging
// port: the second window's page, its file session and place, the tab gone from the main window,
// the file actions a tab window refuses, a write in one window reaching the other, the theme in
// both, the tab window closing while the file and the process stay, and Exit ending the process
// while a tab window is open. That a tab window closes
// when its file changes needs a native confirmation pressed, which no lane can do: it was observed
// with a real keyboard on 2026-10-16. The move is made by the
// command palette's Move tab to new window; a drag out of the strip ends in the same call, and a
// real pointer drag needs the foreground, which a gate lane cannot hold.
const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, process and output are required.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, message) { if (!value) throw new Error(message); }
function check(line) { console.log('ok  ' + line); }
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

const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), 'debugging port');
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let next = 0;
const pending = new Map();
const pageErrors = [];
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data);
  if (value.method === 'Runtime.exceptionThrown') pageErrors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
  const item = pending.get(value.id); if (!item) return;
  pending.delete(value.id); clearTimeout(item.timer);
  if (value.error) item.reject(new Error(`${value.error.message} (${item.method})`)); else item.resolve(value.result);
});
function command(method, params = {}, sessionId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out (' + method + ')')); }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluateIn(sessionId, expression, timeout) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeout);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
const workbenches = async () => (await command('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && t.url === 'https://app.nendo.local/index.html');
const attach = async targetId => {
  const session = (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await command('Runtime.enable', {}, session);
  return session;
};
const idle = session => waitFor(() => evaluateIn(session, `document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'Workbench idle');
async function click(session, selector) {
  await waitFor(() => evaluateIn(session, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return Boolean(e) && !e.disabled; })()`), selector);
  await evaluateIn(session, `document.querySelector(${JSON.stringify(selector)}).click()`);
}
/** A bridge request from a page, under the file session that page last drew. */
async function bridge(session, method, payload = {}) {
  return evaluateIn(session, `(async () => {
    const snapshot = await new Promise((resolve, reject) => ask('session.getSnapshot', {}, null, resolve, reject));
    return await new Promise((resolve, reject) => ask(${JSON.stringify(method)}, ${JSON.stringify(payload)}, snapshot.result?.fileSessionId ?? null, resolve, reject));
    function ask(method, payload, fileSessionId, resolve, reject) {
      const b = chrome.webview, request = { protocolVersion: 7, requestId: crypto.randomUUID(), method, payload, fileSessionId };
      const timer = setTimeout(() => { b.removeEventListener('message', receive); reject(new Error('host timeout: ' + method)); }, 12000);
      function receive(e) { let r = e.data; if (typeof r === 'string') r = JSON.parse(r); if (r.requestId !== request.requestId) return;
        clearTimeout(timer); b.removeEventListener('message', receive); resolve(r); }
      b.addEventListener('message', receive); b.postMessage(request);
    }
  })()`, 20000);
}
const describe = session => evaluateIn(session, `(() => ({
  role: document.documentElement.dataset.window ?? 'main',
  tabs: [...document.querySelectorAll('#tab-strip .tab-main')].map(b => b.querySelector('.tab-label')?.textContent ?? ''),
  title: document.querySelector('#workspace-title')?.textContent?.trim() ?? null,
  theme: document.documentElement.dataset.theme,
  openFile: document.querySelector('#file-actions [data-file-action="session.openFile"]')?.disabled ?? null,
  backup: document.querySelector('#file-actions [data-file-action="file.backup"]')?.disabled ?? null,
}))()`);

try {
  const [first] = await waitFor(async () => { const all = await workbenches(); return all.length === 1 ? all : null; }, 'the one Workbench', 45000);
  const main = await attach(first.targetId);
  await idle(main);
  const opened = await bridge(main, 'session.getSnapshot');
  assert(opened.ok && opened.result.hasFile, 'The journey file is not open.');
  const fileSession = opened.result.fileSessionId;

  // A second tab on History, so the main window keeps the first.
  await click(main, '#tab-new');
  await click(main, '#nav-history');
  await waitFor(() => evaluateIn(main, `document.querySelector('#workspace-title')?.textContent?.includes('History')`), 'History in the new tab');
  await idle(main);
  const before = await describe(main);
  assert(before.tabs.length === 2 && before.role === 'main', `The main window has ${JSON.stringify(before)} before the move.`);
  assert(before.openFile === false, 'The main window does not offer Open file.');

  // T1: the command moves the tab on screen to a window of its own, on the same file session.
  await click(main, '#palette-open');
  await click(main, '[data-command-id="tab:moveToWindow"]');
  const pair = await waitFor(async () => { const all = await workbenches(); return all.length === 2 ? all : null; }, 'a second Workbench window');
  const second = await attach(pair.find(t => t.targetId !== first.targetId).targetId);
  await waitFor(async () => (await describe(second)).role === 'tab', 'the second window to say it is a tab window');
  await idle(second);
  await waitFor(async () => (await describe(second)).title?.includes('History'), 'History in the tab window');
  const moved = await describe(second);
  const tabSession = await bridge(second, 'session.getSnapshot');
  assert(tabSession.ok && tabSession.result.fileSessionId === fileSession,
    `The tab window shows file session ${tabSession.result?.fileSessionId}, not the main window's ${fileSession}.`);
  assert(moved.tabs.length === 1 && moved.tabs[0].includes('History'), `The tab window's tabs are ${JSON.stringify(moved.tabs)}.`);
  const left = await waitFor(async () => { const now = await describe(main); return now.tabs.length === 1 ? now : null; }, 'the tab to leave the main window');
  assert(!left.tabs[0].includes('History'), `The main window kept the moved tab: ${JSON.stringify(left.tabs)}.`);
  check(`T1 the tab moved to a window of its own on file session ${fileSession}: tab window ${JSON.stringify(moved.tabs)}, main window ${JSON.stringify(left.tabs)}`);

  // T2: the tab window is a native window of its own, with its own title bar handed its controls.
  const bar = await waitFor(async () => { const answer = await bridge(second, 'diagnostics.titleBar', { points: [] }); return answer.ok && answer.result.passthrough.length > 0 ? answer.result : null; }, 'the tab window\'s title bar');
  check(`T2 the tab window has its own title bar: ${bar.bar.height} px tall, ${bar.passthrough.length} controls passed through`);

  // T3: only the main window opens, closes or replaces the file.
  assert(moved.openFile === true && moved.backup === false, `The tab window's File menu offers Open file ${!moved.openFile} and Create backup ${!moved.backup}.`);
  const refused = await bridge(second, 'session.openFile');
  assert(!refused.ok && refused.error.code === 'main-window-only', `The tab window's Open file answered ${JSON.stringify(refused.error ?? refused.result)}.`);
  check('T3 the tab window refuses Open file (main-window-only) and still offers Create backup');

  // T4: a write in the tab window reaches the main window as the file moving.
  await evaluateIn(main, `(() => { window.__moved = []; chrome.webview.addEventListener('message', e => { let m = e.data; if (typeof m === 'string') m = JSON.parse(m); if (m.event === 'fileChanged') window.__moved.push(m.payload); }); return true; })()`);
  const record = tabSession.result.records.find(r => r.entityId === 'tasks' && r.recordId === 't1');
  assert(record, 'The journey file has no task t1.');
  const wrote = await bridge(second, 'data.setField', { entityId: 'tasks', recordId: 't1', fieldId: 'title', expectedRecordVersion: record.recordVersion, value: 'Survey the site again', idempotencyKey: crypto.randomUUID() });
  assert(wrote.ok, `The tab window's write was refused: ${JSON.stringify(wrote.error)}.`);
  const nudges = await waitFor(() => evaluateIn(main, `window.__moved.length > 0 ? window.__moved : null`), 'the main window to hear the write');
  // And the other way: the tab window hears the session's events as the main window does.
  await evaluateIn(second, `(() => { window.__moved = []; chrome.webview.addEventListener('message', e => { let m = e.data; if (typeof m === 'string') m = JSON.parse(m); if (m.event === 'fileChanged') window.__moved.push(m.payload); }); return true; })()`);
  const again = (await bridge(main, 'session.getSnapshot')).result.records.find(r => r.entityId === 'tasks' && r.recordId === 't1');
  const back = await bridge(main, 'data.setField', { entityId: 'tasks', recordId: 't1', fieldId: 'title', expectedRecordVersion: again.recordVersion, value: 'Survey the site', idempotencyKey: crypto.randomUUID() });
  assert(back.ok, `The main window's write was refused: ${JSON.stringify(back.error)}.`);
  const heard = await waitFor(() => evaluateIn(second, `window.__moved.length > 0 ? window.__moved : null`), 'the tab window to hear the write made in the main window');
  check(`T4 a write in either window reached the other as fileChanged: main heard ${JSON.stringify(nudges)}, the tab window ${JSON.stringify(heard)}`);

  // T5: the theme set in one window is drawn in both.
  await click(second, '[data-theme-option="dark"]');
  await waitFor(async () => (await describe(main)).theme === 'dark', 'the main window to turn dark');
  await click(main, '[data-theme-option="light"]');
  await waitFor(async () => (await describe(second)).theme === 'light', 'the tab window to turn light');
  check('T5 the theme set in either window is drawn in the other');

  // T6: closing the tab window, as its close button does, ends neither the file nor the process.
  const closing = await bridge(second, 'diagnostics.closeWindow');
  assert(closing.ok, `The tab window would not close: ${JSON.stringify(closing.error)}.`);
  await waitFor(async () => (await workbenches()).length === 1 ? true : null, 'the tab window to close');
  try { process.kill(Number(processId), 0); } catch { throw new Error('The process ended with the tab window.'); }
  const still = await bridge(main, 'session.getSnapshot');
  assert(still.ok && still.result.hasFile && still.result.fileSessionId === fileSession, 'The file closed with the tab window.');
  const mainRefused = await bridge(main, 'diagnostics.closeWindow');
  assert(!mainRefused.ok && mainRefused.error.code === 'main-window', 'A page closed the main window.');
  check('T6 closing the tab window left the file open in the main window and the process running; the main window does not close from its page');

  assert(pageErrors.length === 0, 'Unhandled renderer exception: ' + pageErrors.join(' | '));

  // T7: Exit, as the tray menu's Exit asks for it, ends the process while a tab window is open.
  // Reported 2026-10-17: it closed the main window alone, and the tab window kept the process.
  await click(main, '#tab-new');
  await click(main, '#nav-history');
  await waitFor(() => evaluateIn(main, `document.querySelector('#workspace-title')?.textContent?.includes('History')`), 'History in a new tab');
  await idle(main);
  await click(main, '#palette-open');
  await click(main, '[data-command-id="tab:moveToWindow"]');
  const pairAgain = await waitFor(async () => { const all = await workbenches(); return all.length === 2 ? all : null; }, 'a second tab window');
  const third = await attach(pairAgain.find(t => t.targetId !== first.targetId).targetId);
  await waitFor(async () => (await describe(third)).role === 'tab', 'the tab window');
  const exiting = await bridge(third, 'diagnostics.exit');
  assert(exiting.ok, `Exit was refused: ${JSON.stringify(exiting.error)}.`);
  const alive = () => { try { process.kill(Number(processId), 0); return true; } catch { return false; } };
  try { await waitFor(() => !alive(), 'the process to end on Exit', 20000); }
  catch { throw new Error(`T7 Exit left the process running with ${(await workbenches()).length} Workbench window(s) open.`); }
  check('T7 Exit ended the process with a tab window open');
  console.log('tab windows ok');
} finally {
  socket.close();
}
