import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, process and output are required.');
const helper = fileURLToPath(new URL('./Runtime-WorkbenchWindow.ps1', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, next = 0;
const pending = new Map();
async function waitFor(read, label) {
  const until = Date.now() + 25000;
  while (Date.now() < until) { const value = await read(); if (value) return value; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
function assert(value, message) { if (!value) throw new Error(message); }
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
function native(action, dialog = 'extensions.manage', choice) {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', helper, '-TargetProcessId', processId,
    '-Action', action, '-DialogId', dialog, '-Base64Inspection', ...(choice ? ['-CustomViewAction', choice] : [])], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert(result.status === 0, 'Native action failed: ' + (result.stderr || result.stdout));
  return action === 'Inspect' ? JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')) : null;
}
function graph(action, steps) {
  const script = fileURLToPath(new URL('./Runtime-ExtensionWindow.ps1', import.meta.url));
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-TargetProcessId', processId, '-Action', action,
    ...(action === 'Inspect' ? ['-Capture', path.join(output, 'graph-window.png')] : []),
    ...(action === 'Resize pane' ? ['-ResizeSteps', String(steps)] : []),
    ...(action === 'Drag pane' ? ['-DragBy', String(steps)] : []),
    ...(action === 'Crash renderer' ? ['-OwnedRunRoot', path.join(output, 'device-state', 'extension-runs')] : [])],
    { windowsHide: true, encoding: 'utf8', timeout: 25000 });
  assert(result.status === 0, 'Native graph action failed: ' + (result.stderr || result.stdout));
  return action === 'Inspect' ? JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8')) : null;
}
function foreground() {
  // A native picker opened from a surface button appears only if its window is foreground.
  // AttachThreadInput lets a background test process do what a real click would do for the person.
  const ps = "$ErrorActionPreference='Stop';" +
    "$t=Get-Process -Id " + processId + ";" +
    "Add-Type -Namespace F -Name G -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport(\"user32.dll\")]public static extern bool AttachThreadInput(uint a,uint b,bool f);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);';" +
    "$h=$t.MainWindowHandle;[uint32]$p=0;$cur=[F.G]::GetForegroundWindow();$ct=[F.G]::GetWindowThreadProcessId($cur,[ref]$p);$tt=[F.G]::GetWindowThreadProcessId($h,[ref]$p);" +
    "[void][F.G]::ShowWindow($h,9);[void][F.G]::AttachThreadInput($ct,$tt,$true);[void][F.G]::SetForegroundWindow($h);[void][F.G]::AttachThreadInput($ct,$tt,$false);";
  spawnSync('pwsh', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
}
async function picker(selectedPath, saveNew = false) {
  const script = fileURLToPath(new URL('./Runtime-SelectOwnedFile.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', script, '-ProcessId', processId,
    '-FixtureRoot', output, '-SelectedPath', selectedPath, '-CommitButtonText', saveNew ? 'Export package' : 'Review package', ...(saveNew ? ['-SaveNew'] : [])],
    { windowsHide: true, encoding: 'utf8', timeout: 25000 });
  if (result.status !== 0) {
    const hostError = await evaluate('window.extensionGatePickerError ?? null');
    const shown = await evaluate('document.querySelector(".message-slot")?.textContent ?? null');
    throw new Error('Native package picker failed: ' + (result.stderr || result.stdout) + '\nHost error: ' + hostError + '\nWorkbench showed: ' + shown + '\nConsole: ' + (globalThis.__consoleLog || []).slice(-14).join(' | '));
  }
}
try {
  const target = await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page' && t.url === 'https://app.nendo.local/index.html'); }
    catch { return null; }
  }, 'owned Workbench');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const consoleLog = []; globalThis.__consoleLog = consoleLog;
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Runtime.consoleAPICalled') { consoleLog.push(value.params.type + ': ' + value.params.args.map(a => a.value ?? a.description ?? a.type).join(' ')); return; }
    if (value.method === 'Runtime.exceptionThrown') { consoleLog.push('exception: ' + (value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text)); return; }
    const item = pending.get(value.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    if (value.error) item.reject(new Error(value.error.message)); else item.resolve(value.result);
  });
  await command('Runtime.enable');
  await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'Workbench idle');
  native('MinimumSize');
  await evaluate(`window.extensionGateRequest = (method, payload = {}) => new Promise((resolve, reject) => {
    const requestId = 'extension-gate-' + crypto.randomUUID();
    const listener = event => { const r = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if(r.requestId !== requestId) return; chrome.webview.removeEventListener('message', listener);
      if(r.ok) resolve(r.result); else reject(new Error(r.error.message)); };
    chrome.webview.addEventListener('message', listener);
    chrome.webview.postMessage({ protocolVersion:7, requestId, fileSessionId:window.extensionGateSession, method, payload });
  });`);
  const snapshot = await evaluate(`extensionGateRequest('session.getSnapshot')`);
  await evaluate(`window.extensionGateSession = ${JSON.stringify(snapshot.fileSessionId)}`);
  const measurements = [];
  for (const theme of ['light', 'dark']) {
    await evaluate(`extensionGateRequest('appearance.set', {preference:${JSON.stringify(theme)},effective:${JSON.stringify(theme)}})`);
    const capture = path.join(output, 'device-state', 'native-dialog.png');
    const metadata = path.join(output, 'device-state', 'native-dialog-theme.json');
    await fs.rm(capture, { force: true }); await fs.rm(metadata, { force: true });
    await evaluate(`window.extensionGatePending = extensionGateRequest('file.customViews'); void 0`);
    const inspected = native('Inspect');
    assert(inspected.Buttons.includes('Install an offline package') && inspected.Buttons.includes('Close'), 'Package manager actions are missing.');
    assert(inspected.Text.join(' ').includes('installing a package does not allow it to run'), 'Installation/permission separation is absent.');
    // Each action is a row, not a centred default button: its label starts at the leading edge.
    // The owner called the centred stack ugly on 2026-09-21, which is the only report this can carry.
    assert(inspected.Rows.length >= 3, 'The package manager drew no action rows.');
    const misaligned = inspected.Rows.filter(row => row.LabelOffset < 0 || row.LabelOffset > 40);
    assert(misaligned.length === 0, 'A package-manager action is not drawn as a row: '
      + JSON.stringify(misaligned.map(row => ({ id: row.id ?? row.Id, width: row.Width, labelOffset: row.LabelOffset }))));
    const appearance = await waitFor(async () => { try { return JSON.parse(await fs.readFile(metadata, 'utf8')); } catch { return null; } }, 'native appearance capture');
    assert(appearance.Actual.toLowerCase() === theme, 'Native package manager ignored ' + theme + ' theme.');
    await fs.copyFile(capture, path.join(output, 'extensions-manage-' + theme + '.png'));
    native('Close'); await evaluate('window.extensionGatePending');
    measurements.push({ theme, buttonsWithinWindow: true, actions: inspected.Buttons, actualTheme: appearance.Actual });
  }
  await fs.writeFile(path.join(output, 'extension-dialogs.json'), JSON.stringify(measurements, null, 2));
  if (process.argv[5] === 'graph') {
    await evaluate('document.querySelector("#nav-use").click()');
    await waitFor(() => evaluate('document.querySelector("#extension-status")?.textContent.includes("not on this device")'), 'missing package fallback');
    assert(await evaluate('document.querySelector("#extension-next").textContent.includes("Install") && Boolean(document.querySelector("#extension-studio"))'), 'Missing package did not offer Install as the next step, or hid Studio.');
    const archive = path.join(output, 'import.nendoview');
    await fs.copyFile(fileURLToPath(new URL('../artifacts/extensions/org.nendo.dependency-graph-0.1.0.nendoview', import.meta.url)), archive);
    // The owner's path: the surface's own next step opens the picker directly.
    foreground();
    await evaluate('document.querySelector("#extension-next").click()');
    await picker(archive);
    const installation = native('Inspect', 'extensions.install');
    assert(installation.Text.some(t => t.includes('Unsigned package')) && installation.Text.some(t => t.includes('SHA-256:')), 'Package review omitted provenance or digest.');
    native('Install package', 'extensions.install');
    await waitFor(() => evaluate('document.querySelector("#extension-next")?.textContent.includes("Allow")'), 'installed package offers Allow as the next step');
    const installed = await evaluate('extensionGateRequest("extension.status", {viewId:"graph"})');
    assert(installed.packageState === 'available' && installed.isApproved === false, 'Installation granted execution permission.');
    await evaluate('window.extensionGatePending = extensionGateRequest("file.customViews"); void 0');
    native('Continue', 'extensions.manage', 'Export an installed package');
    native('Continue', 'file.confirmation');
    const exported = path.join(output, 'export.nendoview');
    await picker(exported, true);
    await evaluate('window.extensionGatePending');
    assert((await fs.readFile(archive)).equals(await fs.readFile(exported)), 'Native export changed the original archive bytes.');
    foreground();
    await evaluate('document.querySelector("#extension-next").click()');
    const consent = native('Inspect', 'extensions.consent');
    assert(consent.Text.join(' ').includes('Task title') && consent.Text.join(' ').includes('Upstream task'), 'Consent omitted the actual bound field labels.');
    native('Allow this view', 'extensions.consent');
    await waitFor(() => evaluate('document.querySelector("#extension-next")?.textContent.includes("Open")'), 'allowed view offers Open as the next step');
    // The owner opens the graph with the window already maximized and never resizes. Reproduce that
    // exact order: maximize, open, then measure before any resize triggers a fresh fit.
    native('Maximize');
    foreground();
    await evaluate('document.querySelector("#extension-next").click()');
    const openedMaximized = graph('Inspect');
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-open-maximized.png'));
    assert(openedMaximized.Colors && openedMaximized.Colors.Renderer && openedMaximized.Colors.Renderer !== openedMaximized.Colors.Native,
      'Opened maximized, the graph is not visible without resizing: ' + JSON.stringify({ colors: openedMaximized.Colors, window: openedMaximized.Window, pane: openedMaximized.Pane }));
    graph('MinimumSize');
    const opened = graph('Inspect');
    await fs.writeFile(path.join(output, 'graph-opened.json'), JSON.stringify(opened, null, 2));
    for (const action of ['Open record', 'Focus graph', 'Refresh', 'Studio', 'Disable view', 'Close']) assert(opened.Buttons.includes(action), 'Missing host control: ' + action);
    assert(opened.Text.includes('Unchanged'), 'The actual graph record was not visible.');
    assert(opened.Text.includes('Next step') && opened.Text.includes('2 records · 1 connection'), 'The bound dependency was not projected.');
    assert(opened.Window.Width === 1024 && opened.Window.Height === 720, 'The native graph did not reach its minimum test bounds: ' + JSON.stringify({ window: opened.Window, pane: opened.Pane }));
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-dark.png'));
    await evaluate('extensionGateRequest("appearance.set", {preference:"light",effective:"light"})');
    await sleep(200);
    const light = graph('Inspect');
    assert(opened.Colors.Native === '10,28,43' && light.Colors.Native === '247,248,251', 'The native graph frame did not change theme.');
    assert(opened.Colors.Renderer === '19,26,39' && light.Colors.Renderer === '245,244,241', 'The contained renderer did not change theme.');
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-light.png'));
    graph('Compact');
    const compact = graph('Inspect');
    assert(compact.Window.Width === 1024 && compact.Window.Height === 720, 'The graph did not enforce the application minimum size: ' + JSON.stringify({ window: compact.Window, pane: compact.Pane }));
    // Reproduce at a large window: the owner's window is not 1024x720. Capture the pane there.
    graph('Wide');
    const wide = graph('Inspect');
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-wide.png'));
    assert(wide.Colors && wide.Colors.Renderer && wide.Colors.Renderer !== wide.Colors.Native,
      'At a wide window the renderer is not visible in the pane: ' + JSON.stringify({ colors: wide.Colors, window: wide.Window, pane: wide.Pane }));

    // The boundary between the Workbench and the pane, measured rather than looked at: a
    // capture shows a divider whether or not it moves anything, whether the pane stops at
    // its compact width, and whether the Workbench keeps a column worth having. Here, at
    // the wide window, because at the 1024x720 minimum the pane is already pinned to its
    // 480 and there is nowhere for the boundary to go. Accessibility reports physical
    // pixels, so every width below is converted to the DIPs the pane is written in.
    const dip = (inspected, pixels) => Math.round(pixels * 96 / inspected.Dpi);

    // The pointer first, because it is the gesture the boundary exists for and the one the
    // owner reported doing nothing (2026-09-21). Dragging right narrows the pane.
    // A control with no box is in the automation tree and takes focus and arrow keys while
    // there is nothing on screen to take hold of, which is exactly how that shipped.
    assert(wide.Splitter && wide.Splitter.Width >= 4 && wide.Splitter.Height > 100 && !wide.Splitter.Offscreen &&
      wide.Splitter.Name === 'Resize the custom view',
      'The boundary has no hit area: ' + JSON.stringify(wide.Splitter));
    // Short drags on purpose. At this window the pane has about a hundred DIPs of travel
    // before it meets its own floor or the Workbench's, and a drag long enough to reach
    // either would measure the clamp rather than whether the boundary follows the pointer.
    // The clamps are measured from the keyboard below, where the distance can be exact.
    const beforeDrag = dip(wide, wide.Pane.Width);
    graph('Drag pane', Math.round(30 * wide.Dpi / 96));
    const narrowed = graph('Inspect');
    assert(Math.abs(dip(narrowed, narrowed.Pane.Width) - beforeDrag + 30) <= 6,
      `Dragging the boundary 30 DIPs right moved the pane from ${beforeDrag} to ${dip(narrowed, narrowed.Pane.Width)} DIPs. Boundary: ${JSON.stringify(narrowed.Splitter)}`);
    graph('Drag pane', -Math.round(60 * narrowed.Dpi / 96));
    const pulled = graph('Inspect');
    assert(Math.abs(dip(pulled, pulled.Pane.Width) - dip(narrowed, narrowed.Pane.Width) - 60) <= 6,
      `Dragging the boundary 60 DIPs left moved the pane from ${dip(narrowed, narrowed.Pane.Width)} to ${dip(pulled, pulled.Pane.Width)} DIPs. Boundary: ${JSON.stringify(pulled.Splitter)}`);

    // Dragging must not cost the view. Each move repositions the contained window, and the
    // owner met a boundary that worked and a graph that died under it on 2026-09-21, with
    // the pane saying only that the view had stopped.
    const stillRunning = (inspected, what) => assert(
      inspected.OpenRecordEnabled === true && !inspected.Text.some(t => /view (has stopped|has closed|asked for|started more)|could not keep watching/.test(t)),
      `${what} stopped the view: ${JSON.stringify(inspected.Text.filter(t => /view|Nendo/.test(t)))}`);
    stillRunning(pulled, 'Dragging the boundary');

    // The clamps, from the keyboard, where the distance is exact. Driven to the floor first
    // so the four presses below start from a width with room above it whatever the drags left.
    graph('Resize pane', -60);
    const floored = graph('Inspect');
    // The column's own minimum also holds this floor, so this line alone would pass against
    // a splitter that had lost its lower clamp. It is here to say what the floor is, not as
    // that clamp's guard; the Workbench's share below is the one this code owns.
    assert(Math.abs(dip(floored, floored.Pane.Width) - 480) <= 4,
      `Driven narrow, the pane stopped at ${dip(floored, floored.Pane.Width)} DIPs rather than its 480 compact width.`);
    const before = dip(floored, floored.Pane.Width);
    graph('Resize pane', 4);
    const stepped = graph('Inspect');
    assert(Math.abs(dip(stepped, stepped.Pane.Width) - before - 64) <= 4,
      `Four presses on the boundary moved the pane from ${before} to ${dip(stepped, stepped.Pane.Width)} DIPs, not by 64.`);
    graph('Resize pane', 60);
    const widest = graph('Inspect');
    const keeps = dip(widest, widest.Window.Width - widest.Pane.Width);
    assert(keeps >= 400,
      `Driven wide, the pane left the Workbench ${keeps} DIPs of a ${dip(widest, widest.Window.Width)} DIP window.`);
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-boundary-moved.png'));
    // No reset: the minimum-size window below re-clamps the pane to the same 480 the
    // half-share would have given it there.
    graph('Maximize');
    const maxed = graph('Inspect');
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-maximized.png'));
    assert(maxed.Colors && maxed.Colors.Renderer && maxed.Colors.Renderer !== maxed.Colors.Native,
      'When maximized the renderer is not visible in the pane: ' + JSON.stringify({ colors: maxed.Colors, window: maxed.Window, pane: maxed.Pane }));

    // Long sweeps at a maximized window, because that is where a move of the boundary
    // resizes the most contained surface and where the owner met the view dying under the
    // drag on 2026-09-21. Back and forth, at a hand's pace, not one short pull.
    for (const sweep of [-400, 400, -400, 400]) {
      graph('Drag pane', Math.round(sweep * maxed.Dpi / 96));
      const after = graph('Inspect');
      stillRunning(after, `Sweeping the boundary ${sweep} DIPs at a maximized window`);
      // The Job stops the view at 480 MiB, and a maximized graph already holds about half
      // of its 512. Measured rather than inferred from survival: a change that merely got
      // closer to the limit would still pass the line above, until the day it did not.
      assert(after.MemoryMib > 0 && after.MemoryMib < 400,
        `Sweeping the boundary ${sweep} DIPs left the contained view at ${after.MemoryMib} MiB of its 512 MiB allowance.`);
    }
    await fs.copyFile(path.join(output, 'graph-window.png'), path.join(output, 'graph-boundary-swept.png'));
    graph('MinimumSize');
    graph('Select node');
    graph('Open record');
    await waitFor(() => evaluate('Boolean(document.querySelector("#record-form"))'), 'host record inspector');
    await evaluate(`(() => {
      const field = document.querySelector('#record-form input[type="text"]');
      if (!field) throw new Error('The record title field is missing.');
      field.value = 'Changed through Studio'; field.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#record-form').requestSubmit();
    })()`);
    await waitFor(() => evaluate('extensionGateRequest("data.queryRecords", {entityId:"nodes",recordId:"one",limit:1}).then(p=>p.items[0]?.values.label === "Changed through Studio")'), 'saved Studio edit');
    graph('Focus graph');
    graph('Return focus');
    await sleep(250);
    const returned = graph('Inspect');
    assert(returned.Focused === 'Open record', 'F6 did not return focus to the host controls: ' + returned.Focused);
    graph('Crash renderer');
    const stopped = graph('Inspect');
    assert(stopped.OpenRecordEnabled === false && stopped.Text.some(t => /This view has (stopped|closed)/.test(t)), 'Renderer exit did not show the host recovery state.');
    graph('Studio');
    await waitFor(() => evaluate('Boolean(document.querySelector(".record-open-button"))'), 'Studio after renderer crash');
    await evaluate('document.querySelector("[row-id=one] .record-open-button").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector("#record-form"))'), 'record editor after renderer crash');
    await evaluate(`(() => {
      const field = document.querySelector('#record-form input[type="text"]');
      field.value = 'Saved after renderer crash'; field.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#record-form').requestSubmit();
    })()`);
    await waitFor(() => evaluate('extensionGateRequest("data.queryRecords", {entityId:"nodes",recordId:"one",limit:1}).then(p=>p.items[0]?.values.label === "Saved after renderer crash")'), 'saved edit after renderer crash');
    graph('Disable view');
    await waitFor(() => evaluate('extensionGateRequest("extension.status", {viewId:"graph"}).then(s => !s.isApproved)'), 'revoked graph permission');
    graph('Close');
    await evaluate('document.querySelector("#nav-use").click()');
    await waitFor(() => evaluate('document.querySelector("#extension-next")?.textContent.includes("Allow")'), 'disabled graph fallback');
    assert(await evaluate('!document.querySelector("#extension-next").textContent.includes("Open") && Boolean(document.querySelector("#extension-studio"))'), 'Disabled view hid Studio or still offered Open.');
    await fs.writeFile(path.join(output, 'graph-journey.json'), JSON.stringify({ consent: true, visibleGraph: true,
      hostControls: opened.Buttons, nativePackageImportExport: true, missingAndDisabledFallback: true,
      studioEdit: true, nativeF6: true, crashRecoveryEdit: true, bounds: opened.Window,
      themes: { dark: opened.Colors, light: light.Colors }, enforcedMinimum: compact.Window }, null, 2));
  }
  console.log(JSON.stringify(measurements));
} finally { socket?.close(); }
