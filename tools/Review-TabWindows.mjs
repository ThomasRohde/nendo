// A tab moved to a window of its own (ADR-0002), in a real Nendo against an
// isolated profile built by DesktopExtensionViewJourneyTests. Measured over the browser's debugging
// port: the second window's page, its file session and place, the tab gone from the main window,
// the file actions a tab window refuses, a write in one window reaching the other, the theme in
// both, the tab window closing while the file and the process stay, and Exit ending the process
// while a tab window is open. That a tab window closes
// when its file changes needs a native confirmation pressed, which no lane can do: it was observed
// with a real keyboard on 2026-10-16. T1-T7 move the tab by the
// command palette's Move tab to new window. T8-T10 drag it with the page's own pointer events,
// the host told where the pointer is by diagnostics.tabDrag, since a real pointer drag needs the
// foreground, which a gate lane cannot hold: the picture under the pointer, the drop mark, joining
// another window, Escape, and a new window where the tab is let go.
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

  // T8-T10: a tab dragged with the page's own pointer events, which the browser delivers without
  // the foreground. The host is told where the pointer is (diagnostics.tabDrag), since the real one
  // is the person's; everything else is the drag as a person makes it.
  const mouse = (session, type, x, y, buttons = 1) => command('Input.dispatchMouseEvent',
    { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, session);
  const tabCentre = (session, index) => evaluateIn(session, `(() => { const box = document.querySelectorAll('#tab-strip .tab')[${index}].getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height, scale: devicePixelRatio }; })()`);
  const pullDown = async (session, index) => {
    // What the page heard, for a failure to name.
    await evaluateIn(session, `(() => { if (window.__dragEvents) return true; window.__dragEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture', 'blur'])
        window.addEventListener(type, e => window.__dragEvents.push(type + (e.clientY === undefined ? '' : ' ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' ' + (e.target?.className ?? ''))), true);
      const post = chrome.webview.postMessage.bind(chrome.webview);
      chrome.webview.postMessage = message => { if (!['session.getSnapshot', 'diagnostics.tabDrag'].includes(message?.method)) window.__dragEvents.push('request ' + (message?.method ?? '?')); return post(message); };
      return true; })()`);
    const at = await tabCentre(session, index);
    await mouse(session, 'mouseMoved', at.x, at.y, 0);
    await mouse(session, 'mousePressed', at.x, at.y);
    for (const dy of [10, 30, 80, 160, 240]) { await mouse(session, 'mouseMoved', at.x, at.y + dy); await sleep(30); }
    return { ...at, y: at.y + 240 };
  };
  const dragNow = session => bridge(session, 'diagnostics.tabDrag').then(answer => { assert(answer.ok, JSON.stringify(answer.error)); return answer.result; });
  /** Wait for the host's drag to meet `test`, and say what it last held and what the page drew when it does not. */
  const waitDrag = async (session, test, label) => {
    let seen = null;
    try { return await waitFor(async () => { seen = await dragNow(session); return test(seen) ? seen : null; }, label, 10000); }
    catch (error) {
      const strip = await evaluateIn(session, `(() => ({ classes: document.querySelector('#tab-strip').className, tabs: [...document.querySelectorAll('#tab-strip .tab')].map(t => t.className),
        events: (window.__dragEvents ?? []).slice(-30) }))()`);
      throw new Error(`${error.message}; the host held ${JSON.stringify(seen)} and the strip was ${JSON.stringify(strip)}`);
    }
  };

  await click(main, '#tab-new');
  await click(main, '#nav-history');
  await waitFor(() => evaluateIn(main, `document.querySelector('#workspace-title')?.textContent?.includes('History')`), 'History in a new tab');
  await idle(main);
  await click(main, '#palette-open');
  await click(main, '[data-command-id="tab:moveToWindow"]');
  const loneTargets = await waitFor(async () => { const all = await workbenches(); return all.length === 2 ? all : null; }, 'a tab window with one tab');
  const lone = await attach(loneTargets.find(t => t.targetId !== first.targetId).targetId);
  await waitFor(async () => (await describe(lone)).role === 'tab', 'the one-tab window');
  await idle(lone);
  await waitFor(async () => (await describe(main)).tabs.length === 1 ? true : null, 'the main window back to one tab');

  // T8: the tab window's only tab, pulled off its strip and held over the main window's tabs, past
  // its one tab: its picture is under the pointer, the main window marks where it would land, and
  // let go it joins the main window there and its own window closes.
  const mainTab = await evaluateIn(main, `(() => { const box = document.querySelector('#tab-strip .tab').getBoundingClientRect(); return { right: box.right, middle: box.top + box.height / 2 }; })()`);
  const over = { x: Math.round(mainTab.right + 16), y: Math.round(mainTab.middle) };
  assert((await bridge(main, 'diagnostics.tabDrag', { point: over })).ok, 'The journey cannot place the pointer.');
  const lonely = await pullDown(lone, 0);
  const held = await waitDrag(lone, now => now.following && now.pictureShown && now.target === 'main', 'the picture under the pointer over the main window\'s tabs');
  const expected = { width: Math.round(lonely.width * lonely.scale), height: Math.round(lonely.height * lonely.scale) };
  assert(Math.abs(held.pictureWidth - expected.width) <= 2 && Math.abs(held.pictureHeight - expected.height) <= 2 && held.centreAlpha === 255,
    `The picture is ${held.pictureWidth} × ${held.pictureHeight} with its middle at alpha ${held.centreAlpha}; the tab is ${expected.width} × ${expected.height}.`);
  // The leaving tab's dashed outline from the strip rides with it: dashes three times its width along the top.
  assert(held.outlineDashes >= 3, `The picture's top edge carries ${held.outlineDashes} dashes of the leaving tab's outline.`);
  assert(Math.abs(held.targetX - over.x) <= 1, `The host holds the tab at ${held.targetX} along the main window's tabs, not ${over.x}.`);
  const marked = await waitFor(() => evaluateIn(main, `(() => { const mark = document.querySelector('#tab-strip .tab-drop-marker')?.getBoundingClientRect();
    const tab = document.querySelector('#tab-strip .tab')?.getBoundingClientRect();
    return mark && tab && document.querySelector('#tab-strip').classList.contains('is-drop-target') ? { mark: mark.left, tabRight: tab.right } : null; })()`), 'the main window to mark where the tab would land');
  assert(marked.mark >= marked.tabRight - 2 && marked.mark <= marked.tabRight + 6, `The drop mark is at ${marked.mark}, not after the main window's tab ending at ${marked.tabRight}.`);
  await mouse(lone, 'mouseReleased', lonely.x, lonely.y, 0);
  await waitFor(async () => (await workbenches()).length === 1 ? true : null, 'the emptied tab window to close');
  const joined = await waitFor(async () => { const now = await describe(main); return now.tabs.length === 2 && now.title?.includes('History') ? now : null; }, 'the tab to join the main window and be shown');
  assert(joined.tabs[1].includes('History'), `The tab joined at ${JSON.stringify(joined.tabs)}; it was let go after the main window's tab.`);
  assert(await evaluateIn(main, `document.querySelector('#tab-strip .tab-drop-marker') === null`), 'The main window kept its drop mark.');
  const after = await dragNow(main);
  assert(!after.following && after.pictureWidth === null, `The drag outlived the drop: ${JSON.stringify(after)}.`);
  check(`T8 a tab window's only tab held over the main window showed a ${held.pictureWidth} × ${held.pictureHeight} picture with ${held.outlineDashes} dashes of outline along its top and a drop mark, and joined it after its tab; the tab window closed`);

  // T9: Escape while a tab is held off the strip ends the drag: the picture goes and nothing moves.
  assert((await bridge(main, 'diagnostics.tabDrag', { point: { x: 700, y: 500 } })).ok);
  const escaping = await pullDown(main, 1);
  await waitDrag(main, now => now.following && now.pictureShown, 'the picture of the held tab');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, main);
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, main);
  await waitDrag(main, now => !now.following && now.pictureWidth === null, 'Escape to take the picture away');
  await mouse(main, 'mouseReleased', escaping.x, escaping.y, 0);
  await sleep(500);
  assert((await workbenches()).length === 1 && (await describe(main)).tabs.length === 2, 'Escape and then letting go moved the tab.');
  check('T9 Escape while the tab was held off the strip took its picture away and left the tab where it stood');

  // T10: pulled down into the page and let go there, over no other window of the file, the tab opens in a window of its own.
  const into = await pullDown(main, 1);
  await waitDrag(main, now => now.following && now.target === null, 'the drag over the page');
  await mouse(main, 'mouseReleased', into.x, into.y, 0);
  const ownTargets = await waitFor(async () => { const all = await workbenches(); return all.length === 2 ? all : null; }, 'the tab to open in a window of its own');
  const own = await attach(ownTargets.find(t => t.targetId !== first.targetId).targetId);
  await waitFor(async () => (await describe(own)).title?.includes('History'), 'History in the new tab window');
  assert((await describe(main)).tabs.length === 1, 'The main window kept the tab it let go.');
  assert((await bridge(main, 'diagnostics.tabDrag', { point: null })).ok);
  check('T10 a tab pulled into the page and let go opened in a window of its own');
  await bridge(own, 'diagnostics.closeWindow');
  await waitFor(async () => (await workbenches()).length === 1 ? true : null, 'the T10 window to close');

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
