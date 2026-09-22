// Marketing captures of the real running Workbench, driven over CDP exactly as the
// review lanes are. It captures the WebView2 surface, so a custom view running in
// the contained helper process is not in these shots; Capture-NendoWindow.ps1 is
// the lane for those.
import fs from 'node:fs/promises';
import path from 'node:path';

const [port, processId, output, widthArgument, heightArgument, scaleArgument] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, PID and output directory are required.');
// The capture is the WebView2 surface, so at native scale it is only as large as the
// window. Overriding the device metrics renders the same layout at a higher device
// pixel ratio, which is what makes a screenshot worth looking at on a 2x display.
const layoutWidth = Number(widthArgument ?? 1600);
const layoutHeight = Number(heightArgument ?? 1000);
const deviceScale = Number(scaleArgument ?? 2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
let socket;
const pending = new Map();
const pageErrors = [];
let nextId = 0;

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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function clickFound(selector) {
  await waitFor(async () => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.disabled; })()`), `enabled ${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
// aria-busy on the content host covers an action in flight. It does not cover a
// surface still reading its records, which renders its own busy state — so both.
async function ready() {
  await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'idle Workbench');
  await waitFor(() => evaluate(`!document.querySelector('.first-record-state[aria-busy="true"]')`), 'a surface that finished reading');
}
async function settle() { await ready(); await sleep(450); }
async function screenshot(name) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
}

const captured = [];
const skipped = [];
async function shot(name, theme, prepare) {
  const file = `${name}-${theme}.png`;
  try {
    await prepare();
    await settle();
    await screenshot(file);
    captured.push(file);
  } catch (error) {
    skipped.push({ file, reason: error.message });
  }
}

// The surface picker is a disclosure. It is open while a surface is being chosen and
// would sit over the shot, so close it before the capture.
async function closePicker() {
  await evaluate(`(() => { const d = document.querySelector('details.surface-picker'); if (d) d.open = false; })()`);
}
// The front page and a record type's page are two renders of the same toolbar, and the
// change handler re-renders asynchronously. Waiting on aria-busy alone read the page
// that was still on screen, which is why the first runs saw a file with no screens.
async function selectEntity(value) {
  // Switching record types replaces .use-page. Mark the one on screen first, so the
  // wait below is for the new render rather than for a value the old page already has.
  await evaluate(`(() => {
    const page = document.querySelector('.use-page');
    if (page) page.dataset.captureStale = '1';
    const s = document.querySelector('#use-entity');
    if (!s) throw new Error('No record-type picker');
    if (s.value !== ${JSON.stringify(value)}) { s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); }
    else if (page) delete page.dataset.captureStale;
  })()`);
  await ready();
  const wanted = value === '' ? 'the front page' : `the ${value} page`;
  await waitFor(() => evaluate(`(() => {
    const page = document.querySelector('.use-page');
    if (!page || page.dataset.captureStale === '1') return false;
    const s = document.querySelector('#use-entity');
    if (!s || s.value !== ${JSON.stringify(value)}) return false;
    const onOverview = !!document.querySelector('.overview-surface');
    return ${JSON.stringify(value)} === '' ? onOverview : !onOverview;
  })()`), wanted, 15000);
}
async function surfacesHere() {
  return evaluate(`[...document.querySelectorAll('[data-select-surface]')].map(b => ({ id: b.dataset.selectSurface, label: b.firstChild?.textContent ?? '', kind: b.querySelector('small')?.textContent ?? '' }))`);
}
async function showSurface(id) {
  await clickFound(`[data-select-surface="${id}"]`);
  await ready();
  await closePicker();
}

try {
  await connect();
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', {
    width: layoutWidth,
    height: layoutHeight,
    deviceScaleFactor: deviceScale,
    mobile: false,
  });
  await waitFor(() => evaluate(`document.querySelector('#nav-use') && !document.querySelector('#nav-use').disabled`), 'an open file');
  await ready();
  const measured = await evaluate('`${innerWidth}x${innerHeight}@${devicePixelRatio}`');
  console.log(`Capturing at ${measured} (${layoutWidth * deviceScale}x${layoutHeight * deviceScale} pixels).`);

  const originalTheme = await evaluate(`document.querySelector('[data-theme-option][aria-pressed="true"]')?.dataset.themeOption ?? 'system'`);

  // A file that carries a trigger asks this device to approve it, and editing — and
  // with it the compiled application — stays off until somebody does. A copy inherits
  // no approval, so this run is always the first time. Answer it the way a person
  // opening the file would, before deciding what the file contains.
  await clickFound('#nav-health');
  await ready();
  if (await evaluate(`!!document.querySelector('#approve-behaviour')`)) {
    await clickFound('#approve-behaviour');
    await ready();
    await waitFor(() => evaluate(`document.querySelector('[data-testid="behaviour-approval"]')?.dataset.approved === 'true'`), 'the approved behaviour', 15000);
  }

  // Find one surface of each kind worth showing, once, across every record type.
  await clickFound('#nav-use');
  await ready();
  // The compilation lands after the first Use render, so the record-type picker can
  // still be showing the front page alone when this reads it. Wait for the file's
  // own record types before deciding what the file contains.
  await waitFor(() => evaluate(`document.querySelectorAll('#use-entity option').length > 1`), 'the record-type picker to fill', 20000);
  const entityValues = await evaluate(`[...document.querySelectorAll('#use-entity option')].map(o => o.value)`);
  const hasOverview = entityValues.includes('');
  const byKind = new Map();
  let listEntity = null;
  let listSurface = null;
  for (const value of entityValues.filter(v => v !== '')) {
    await selectEntity(value);
    for (const surface of await surfacesHere()) {
      const kind = surface.kind.trim().toLowerCase();
      if (!byKind.has(kind)) byKind.set(kind, { ...surface, entity: value });
      if (listSurface === null && (kind.includes('list') || kind.includes('table'))) { listSurface = surface; listEntity = value; }
    }
  }
  await fs.writeFile(path.join(output, 'surfaces.json'), JSON.stringify({ hasOverview, kinds: [...byKind.entries()] }, null, 2));

  const kindShots = [
    ['board', k => k.includes('board')],
    ['calendar', k => k.includes('calendar')],
    ['timeline', k => k.includes('timeline')],
    ['gallery', k => k.includes('gallery')],
    ['matrix', k => k.includes('matrix')],
    ['list', k => k.includes('list') && !k.includes('rank')],
  ];

  for (const theme of ['light', 'dark']) {
    await clickFound(`[data-theme-option="${theme}"]`);
    await ready();

    if (hasOverview) {
      await shot('overview', theme, async () => {
        await clickFound('#nav-use');
        await ready();
        await selectEntity('');
        await closePicker();
        await waitFor(() => evaluate(`!!document.querySelector('[data-testid="overview-page"]')`), 'the front page', 12000);
      });
    }

    for (const [name, matches] of kindShots) {
      const found = [...byKind.entries()].find(([kind]) => matches(kind));
      if (!found) { skipped.push({ file: `${name}-${theme}.png`, reason: 'no surface of this kind in the file' }); continue; }
      const surface = found[1];
      await shot(name, theme, async () => {
        await clickFound('#nav-use');
        await ready();
        await selectEntity(surface.entity);
        await showSurface(surface.id);
        await waitFor(() => evaluate(`!!document.querySelector('.use-surface [data-record-id], .use-surface .summary-tile, .use-surface .calendar-cell')`), `records on ${name}`, 12000);
      });
    }

    // The record page: the inspector a record opens into, with its toned header and tabs.
    if (listSurface !== null) {
      await shot('record-page', theme, async () => {
        await clickFound('#nav-use');
        await ready();
        await selectEntity(listEntity);
        await showSurface(listSurface.id);
        await waitFor(() => evaluate(`!!document.querySelector('.use-surface [data-record-id]')`), 'a record to open', 12000);
        await evaluate(`document.querySelector('.use-surface [data-record-id]').click()`);
        await ready();
        await waitFor(() => evaluate(`!!document.querySelector('.record-inspector, .record-page')`), 'the record page', 12000);
      });
    }

    // Each Studio area has its own root element. Waiting on one of those rather than
    // on aria-busy alone is what proves the shot is of the screen it is named after.
    const areas = [
      ['studio-data', '#nav-data', '[data-testid="application-data-state"], [data-testid="valid-empty-state"]'],
      ['studio-structure', '#nav-structure', '.structure-page'],
      ['studio-surfaces', '#nav-surfaces', '.studio-page:not(.structure-page):not(.history-page)'],
      ['studio-history', '#nav-history', '.history-page'],
    ];
    for (const [name, nav, marker] of areas) {
      await shot(name, theme, async () => {
        await clickFound(nav);
        await ready();
        await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(marker)})`), `${name} to render`, 12000);
      });
    }
  }

  await clickFound(`[data-theme-option="${originalTheme}"]`);
  await ready();
  await command('Emulation.clearDeviceMetricsOverride');

  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ captured, skipped, pageErrors }, null, 2));
  assert(pageErrors.length === 0, `Unhandled page errors: ${pageErrors.join(' | ')}`);
  assert(captured.length >= 8, `Only ${captured.length} shot(s) captured. Skipped: ${JSON.stringify(skipped)}`);
  console.log(`Captured ${captured.length} screenshot(s); skipped ${skipped.length}.`);
  for (const entry of skipped) console.log(`  skipped ${entry.file}: ${entry.reason}`);
} catch (error) {
  try {
    await screenshot('failure.png');
    await fs.writeFile(path.join(output, 'failure-page.json'), JSON.stringify({
      message: error.message,
      captured,
      skipped,
      pageErrors,
      body: await evaluate(`document.body.innerText.slice(0, 2000)`).catch(() => null),
    }, null, 2));
  } catch { /* the page may already be gone */ }
  throw error;
} finally { socket?.close(); }
