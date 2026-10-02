// W-106: a file that opens on its own view, in a real Nendo against an isolated profile built by
// DesktopExtensionViewJourneyTests. The file holds a record list of Tasks and an extensionView
// that says opensFile. Measured over the browser's debugging port: the screen the file opens on,
// the view running in it with the context a view of the file gets, the Showing picker's choices,
// and Studio reached and left again, with the view listed among the screens. No pointer, no
// foreground.
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
socket.addEventListener('message', event => {
  const value = JSON.parse(event.data);
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
const targets = async () => (await command('Target.getTargets')).targetInfos;
const attach = async targetId => (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId;

const workbench = await waitFor(async () => (await targets()).find(t => t.type === 'page' && t.url.startsWith('https://app.nendo.local/')), 'owned Workbench');
const page = await attach(workbench.targetId);
const evaluate = (expression, timeout) => evaluateIn(page, expression, timeout);
const idle = () => waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'Workbench idle');
async function click(selector) {
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
// The screen in view: the view's mount and its state, the record list, and the Showing picker.
const screen = () => evaluate(`(() => {
  const mount = document.querySelector('[data-testid="file-view"] [data-view-mount]');
  const picker = document.querySelector('#use-entity');
  return { fileView: Boolean(document.querySelector('[data-testid="file-view"]')), view: mount?.dataset.viewId ?? null, kind: mount?.dataset.viewKind ?? null,
    state: mount?.dataset.viewState ?? null, entity: mount?.dataset.viewEntity ?? null, list: Boolean(document.querySelector('[data-surface="list"]')),
    options: picker ? [...picker.options].map(option => (option.selected ? '*' : '') + option.value) : [] };
})()`);
async function choose(value) {
  await evaluate(`(() => { const picker = document.querySelector('#use-entity'); picker.value = ${JSON.stringify(value)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

try {
  // G37: the file opens on its view, running, before anything else is chosen.
  const opened = await waitFor(async () => { const now = await screen(); return now.fileView && now.state === 'running' ? now : null; }, 'the file opening on its view, running', 45000);
  assert(opened.view === 'workbench' && opened.kind === 'extensionView' && opened.entity === 'tasks',
    `The file opened on ${JSON.stringify(opened)}, not on its workbench view about Tasks.`);
  assert(JSON.stringify(opened.options) === JSON.stringify(['*view:workbench', 'tasks']),
    `Showing offers ${JSON.stringify(opened.options)}, not the view and then the record type.`);
  check('G37 the file opens on its own view, running; Showing offers it before Tasks ' + JSON.stringify(opened.options));

  // The view's own context, from inside its frame: a screen of the file, about Tasks.
  const frameName = await evaluate(`document.querySelector('[data-testid="file-view"] iframe')?.name ?? null`);
  const frame = await waitFor(async () => {
    for (const target of (await targets()).filter(t => t.type === 'iframe' && t.url.includes('.example'))) {
      const session = await attach(target.targetId);
      try { if (await evaluateIn(session, 'window.name', 3000) === frameName) return session; } catch { /* gone */ }
      await command('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    }
    return null;
  }, 'the view frame');
  const context = await evaluateIn(frame, `nendo.ready.then(view => ({ viewId: view.viewId, kind: view.kind, placement: view.placement, entityId: view.entityId, recordId: view.recordId }))`, 15000);
  assert(context.viewId === 'workbench' && context.kind === 'extensionView' && context.placement === 'screen' && context.entityId === 'tasks' && context.recordId === null,
    `The view was handed ${JSON.stringify(context)}.`);
  const reads = await evaluateIn(frame, `probe.reads()`, 15000);
  assert(reads.items.length > 0, 'The view of the file read no records through the API.');
  check('G38 the view is handed a screen of the file about Tasks, and reads records: ' + JSON.stringify(context));

  // G40: the breadcrumb names the view, and only it, after the view declares its place, which
  // refreshes Nendo's header between two draws (W-127). The owner saw "Use · Concepts / Use ·
  // Archi": the eyebrow came back beside the pickers, naming the first record type.
  const header = () => evaluate(`(() => {
    const shown = element => element !== null && !element.hidden && getComputedStyle(element).display !== 'none' && !element.classList.contains('visually-hidden');
    const eyebrow = document.querySelector('#session-context'), title = document.querySelector('#workspace-title');
    return { eyebrow: shown(eyebrow) ? eyebrow.textContent : null, title: shown(title) ? title.textContent : null, heading: title?.textContent ?? null,
      picker: document.querySelector('#place-pickers #use-entity')?.selectedOptions[0]?.textContent ?? null };
  })()`);
  const before = await header();
  await evaluateIn(frame, `nendo.ui.setPlace({ step: 1 }, { label: 'First step', replace: true }).then(() => nendo.ui.setPlace({ step: 2 }, { label: 'Second step' }))`, 15000);
  await sleep(500);
  const after = await header();
  assert([before, after].every(seen => seen.eyebrow === null && seen.title === null && seen.picker === 'Probe workbench' && seen.heading === 'Probe workbench'),
    `The breadcrumb does not name only the view: before the view declared its place ${JSON.stringify(before)}, after ${JSON.stringify(after)}.`);
  check('G40 after the view declares its place, the breadcrumb is the picker alone, naming the view: ' + JSON.stringify(after));

  // G41: a view saving an XML file with no click inside it, as Save as Exchange XML from Nendo's
  // row does, saves it whole, without WebView2's downloads panel. That panel asked whether the file
  // "can harm your device", and after Keep the browser process spun and Nendo's window went white
  // (F-237). Measured: the file, its bytes, every target the browser has, and the page answering.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const downloads = path.join(output, 'downloads');
  const saved = await evaluateIn(frame, `probe.downloadXml('Probe model.xml')`, 15000);
  const file = await waitFor(async () => {
    const names = await fs.readdir(downloads).catch(() => []);
    const done = names.find(name => name === saved);
    return done ? { name: done, bytes: (await fs.stat(path.join(downloads, done))).size, pending: names.filter(name => name.endsWith('.crdownload')) } : null;
  }, 'the saved XML file in the journey\'s downloads folder', 20000).catch(async () => ({ name: null, names: await fs.readdir(downloads).catch(() => []) }));
  await sleep(1500);
  const panels = (await targets()).filter(target => target.url.startsWith('edge://')).map(target => target.url);
  const answers = await evaluate(`document.querySelector('#studio-content') ? 'yes' : 'no'`, 5000).catch(error => 'no answer: ' + error.message);
  assert(file.name === saved && file.bytes > 200000 && file.pending.length === 0 && panels.length === 0 && answers === 'yes',
    `A view's XML download did not save quietly: ${JSON.stringify({ file, panels, answers })}.`);
  check('G41 a view saves an XML file with no click in it: ' + JSON.stringify({ file: file.name, bytes: file.bytes, panels: panels.length, answers }));

  // G39: Studio is there, lists the view among the screens of the file, and Use comes back to the view.
  await click('#nav-surfaces'); await idle();
  const listed = await waitFor(() => evaluate(`document.querySelector('[data-testid="file-view-list"]')?.textContent ?? null`), 'the view in Studio’s screens');
  assert(/Probe workbench/.test(listed) && /the file opens on it/.test(listed), `Studio lists ${JSON.stringify(listed)}.`);
  await click('#nav-use'); await idle();
  const back = await waitFor(async () => { const now = await screen(); return now.fileView && now.state === 'running' ? now : null; }, 'Use back on the view', 30000);
  // The picker reaches the record type, and the view again.
  await choose('tasks'); await idle();
  const tasks = await waitFor(async () => { const now = await screen(); return now.list && !now.fileView ? now : null; }, 'the Tasks list from the picker');
  await choose('view:workbench'); await idle();
  const again = await waitFor(async () => { const now = await screen(); return now.fileView && now.state === 'running' ? now : null; }, 'the view again from the picker', 30000);
  assert(back.view === 'workbench' && JSON.stringify(tasks.options) === JSON.stringify(['view:workbench', '*tasks']) && again.view === 'workbench',
    `Leaving and coming back: ${JSON.stringify({ back, tasks, again })}.`);
  // Back, from Tasks, names the view it returns to, not the first record type.
  await choose('tasks'); await idle();
  await waitFor(async () => (await screen()).list, 'Tasks again');
  const backLabel = await evaluate(`document.querySelector('#nav-back')?.getAttribute('aria-label') ?? null`);
  assert(/^Back to Probe workbench/.test(backLabel ?? ''), `Back from Tasks says ${JSON.stringify(backLabel)}.`);
  check('G39 Studio lists the view as a screen of the file, Use returns to it, Showing reaches Tasks and the view again, and Back says ' + JSON.stringify(backLabel));
  console.log('file view ok');
} finally {
  socket.close();
}
