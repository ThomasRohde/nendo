import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [port, processId, output] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^\d+$/.test(processId) || !output) throw new Error('Owned port, PID and output directory are required.');
const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
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
async function click(selector) {
  const state = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); return e ? {disabled:!!e.disabled, text:e.textContent} : null; })()`);
  assert(state && !state.disabled, `Missing or disabled control ${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
// Typing, as the page counts it: a record form sends only the fields whose input or
// change events it saw, so a value assigned in silence is a field nobody edited.
async function fill(selector, value) {
  await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Missing input ${selector}'); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
async function ready() { await waitFor(() => evaluate(`document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'`), 'idle Workbench'); }
function native(action, title, filename) {
  const args = ['-NoProfile', '-File', path.join(toolsRoot, 'Runtime-WorkbenchWindow.ps1'), '-TargetProcessId', processId, '-Action', action];
  if (title) args.push('-ExpectedTitle', title);
  if (filename) args.push('-FileName', filename);
  const result = spawnSync('pwsh', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert(result.status === 0, `Native ${action} failed: ${result.stderr || result.stdout}`);
}
function pickDirectory(selected) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsRoot, 'Runtime-SelectOwnedFile.ps1'),
    '-ProcessId', processId, '-FixtureRoot', output, '-SelectedPath', selected, '-Directory'], { encoding: 'utf8', windowsHide: true, timeout: 24000 });
  assert(result.status === 0, `Owned picker failed: ${result.stderr || result.stdout}`);
}
async function screenshot(name) {
  const capture = await command('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fs.writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
}
async function installReview() {
  // All fault delivery is confined to this owned WebView. Native storage and
  // promotion use the production service; only a later refresh is interrupted.
  await evaluate(`
    (() => {
      const bridge = window.chrome.webview;
      const send = bridge.postMessage.bind(bridge);
      const add = bridge.addEventListener.bind(bridge);
      window.review = { failHistory: false, fileSessionId: null, prepared: null, dropData: 'none', discardedInput: null, discardedReceipt: null, lastDataPayload: null, backups: 0 };
      bridge.postMessage = message => {
        if (message.fileSessionId) window.review.fileSessionId = message.fileSessionId;
        if (message.method === 'file.backup') window.review.backups++;
        if (message.method === 'proposal.prepareChangeSet') window.review.prepared = structuredClone(message.payload);
        if (message.method === 'data.createRecord' || message.method === 'data.setFields' || message.method === 'proposal.promote') {
          window.review.lastDataPayload = structuredClone(message.payload);
          if (window.review.dropData !== 'none') {
            window.review.discardedInput = structuredClone(message.payload);
            const drop = window.review.dropData;
            window.review.dropData = 'none';
            if (drop === 'before') return;
            const ignoredId = 'discarded-' + crypto.randomUUID();
            const observe = event => {
              const response = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
              if (response.requestId !== ignoredId) return;
              bridge.removeEventListener('message', observe);
              window.review.discardedReceipt = response;
            };
            add('message', observe);
            send({ ...message, requestId: ignoredId });
            return;
          }
        }
        if (message.method === 'history.query' && window.review.failHistory) {
          window.review.failHistory = false;
          send({ ...message, method: 'review.fixture.missingMethod' });
        } else send(message);
      };
      window.review.rpc = (method, payload = {}) => new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const listener = event => {
          const response = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (response.requestId !== requestId) return;
          bridge.removeEventListener('message', listener);
          if (response.result?.fileSessionId) window.review.fileSessionId = response.result.fileSessionId;
          if (!response.ok) reject(new Error(response.error?.message)); else resolve(response.result);
        };
        add('message', listener);
        send({ protocolVersion: 5, requestId, method, fileSessionId: window.review.fileSessionId, payload });
      });
    })();
  `);
  await evaluate(`window.review.rpc('session.getSnapshot')`);
}
async function reload() {
  await command('Page.reload');
  await waitFor(() => evaluate(`typeof window.review === 'undefined' && document.readyState === 'complete'`), 'reloaded document');
  await ready();
  await installReview();
}
try {
  await connect();
  await command('Runtime.enable');
  await ready();
  await installReview();
  const report = { scope: 'Owned real Desktop with a targeted refresh-response fault; local unpackaged evidence', checks: [] };
  await click('#nav-data');
  // Navigation is an explicit refresh boundary, and it disables every action
  // control while it runs. Clicking through without waiting found the recipe
  // button disabled rather than missing, which read as a product fault.
  await ready();
  await click('#start-application');
  await ready();
  await waitFor(() => evaluate(`!!document.querySelector('#accept-proposal')`), 'initial real proposal');
  const baseSequence = await evaluate(`(async () => (await window.review.rpc('session.getSnapshot')).manifest.changeSequence)()`);
  // A second real proposal is promoted while the first remains displayed.
  // The first must become stale when its actual Accept button is clicked.
  const intervening = await evaluate(`(async () => {
    const payload = structuredClone(window.review.prepared);
    payload.proposalId = 'proposal-' + crypto.randomUUID().replaceAll('-', '');
    payload.mutations.forEach((mutation, index) => { mutation.idempotencyKey = payload.proposalId + '-' + index; });
    const preview = await window.review.rpc('proposal.prepareChangeSet', payload);
    return await window.review.rpc('proposal.promote', { proposalId: preview.proposalId });
  })()`);
  assert(intervening.promotion.applied, 'The intervening real promotion did not commit');
  await click('#accept-proposal');
  await ready();
  assert(await evaluate(`!!document.querySelector('[data-testid="proposal-review"]') && document.querySelector('#accept-proposal').disabled`), 'Stale review vanished or still enables acceptance');
  assert(await evaluate(`document.querySelector('.proposal-state').textContent === 'Needs a new preview' && document.querySelector('.proposal-diagnostic').textContent.includes('changed')`), 'Stale state or retained diagnostic missing');
  assert(await evaluate(`!document.querySelector('#announcement').textContent.includes('accepted.')`), 'A stale proposal was announced accepted');
  const afterStale = await evaluate(`window.review.rpc('session.getSnapshot')`);
  assert(afterStale.manifest.changeSequence === baseSequence + 1, 'Unapplied proposal added another effect');
  for (const theme of ['light', 'dark']) {
    await click('[data-theme-option="' + theme + '"]');
    await screenshot('stale-proposal-' + theme + '.png');
  }
  report.checks.push('Real intervening promotion makes displayed proposal stale; Accept retains review, diagnostics and disabled button; exactly one definition effect; Light/Dark screenshots');
  await click('#reject-proposal');
  await ready();
  await reload();
  await click('#nav-surfaces');
  await ready();
  await evaluate(`document.querySelector('#board-title').value = 'Receipt recovered'; document.querySelector('#rename-board-form').requestSubmit()`);
  await ready();
  await waitFor(() => evaluate(`!!document.querySelector('#accept-proposal')`), 'rename proposal');
  await evaluate(`window.review.failHistory = true`);
  await click('#accept-proposal');
  await ready();
  assert(await evaluate(`!document.querySelector('[data-testid="proposal-review"]') && document.querySelector('#announcement').textContent.includes('accepted.') && document.querySelector('#announcement').textContent.includes('Refresh')`), 'Confirmed acceptance was hidden by failed refresh');
  // The announcement is a live region nobody sees. The notice a person reads sits in
  // the page, and a Use screen chases its tile reads and redraws when they land, within
  // a second of arriving. Wait past that and measure what is on the page, not what was
  // said as it arrived: the sentence, and the one button that answers it.
  await sleep(2500);
  const retained = await evaluate(`(() => { const slot = document.querySelector('.message-slot:not([hidden])'); return { text: slot?.textContent ?? null, refresh: !!document.querySelector('#refresh-outcome-view') }; })()`);
  assert(retained.text !== null && retained.text.includes('accepted.') && retained.text.includes('Refresh') && retained.refresh,
    `The accepted-but-unrefreshed notice did not survive the reads the Use screen chases: ${JSON.stringify(retained)}`);
  const afterRefresh = await evaluate(`window.review.rpc('session.getSnapshot')`);
  assert(afterRefresh.manifest.changeSequence === baseSequence + 2, 'Rename did not create exactly one effect');
  await screenshot('accepted-refresh-unavailable-dark.png');
  await click('[data-theme-option="light"]');
  await screenshot('accepted-refresh-unavailable-light.png');
  await click('#refresh-outcome-view');
  // The window follows the file, so the saved title can be on screen before Refresh
  // view is pressed. The button going away is what says the refresh finished.
  await waitFor(() => evaluate(`!document.querySelector('#refresh-outcome-view')`), 'Refresh view to finish and take its notice with it');
  assert(await evaluate(`document.querySelector('#workspace-title').textContent === 'Receipt recovered' && !document.querySelector('.message-slot:not([hidden])')`),
    'Refresh view did not leave the saved title on screen with the notice cleared');
  await reload();
  assert(await evaluate(`(async () => (await window.review.rpc('semantic.compile')).applications[0].surfaces.find(n => n.kind === 'boardSurface').properties.title === 'Receipt recovered')()`), 'Reload did not recover saved definition');
  report.checks.push('Real rename commit followed by failed history refresh stays accepted with Refresh view action; Refresh view and reload read the saved definition; Light/Dark screenshots');
  for (const mode of ['after', 'before']) {
    await click('#new-record');
    await fill('[name="field.idea.title"]', `Response loss ${mode}`);
    await fill('[name="field.idea.createdDate"]', '2026-09-05');
    await evaluate(`window.review.dropData = '${mode}'; document.querySelector('#record-form').requestSubmit()`);
    await waitFor(() => evaluate(`window.review.discardedInput !== null`), 'retained data request');
    const original = await evaluate(`window.review.discardedInput`);
    assert(await evaluate(`Object.keys(localStorage).some(key => key.startsWith('nendo.pending-mutation.v1.'))`), 'The request was not retained before dispatch');
    if (mode === 'after') {
      await waitFor(() => evaluate(`window.review.discardedReceipt !== null`), 'committed response deliberately hidden from Workbench');
      assert(await evaluate(`window.review.discardedReceipt.ok`), 'The real record did not commit');
    }
    await reload();
    if (mode === 'before') {
      assert(await evaluate(`!!document.querySelector('#pending-save-notice') && document.querySelector('#new-record').disabled`), 'Unresolved save did not survive reload or prevent a new key');
      assert(await evaluate(`document.querySelector('#session-health').textContent.includes('Save unconfirmed')`), 'Header falsely announces an unconfirmed save as saved');
      for (const theme of ['light', 'dark']) {
        await click('[data-theme-option="' + theme + '"]');
        await screenshot('unconfirmed-save-' + theme + '.png');
      }
      await click('#retry-pending-save');
      await waitFor(() => evaluate(`!document.querySelector('#pending-save-notice')`), 'explicit retry acknowledgement');
      assert(await evaluate(`window.review.lastDataPayload.idempotencyKey === ${JSON.stringify(original.idempotencyKey)} && window.review.lastDataPayload.recordId === ${JSON.stringify(original.recordId)}`), 'Retry changed the key or record identity');
    }
    const snapshot = await evaluate(`window.review.rpc('session.getSnapshot')`);
    assert(snapshot.records.filter(record => record.recordId === original.recordId).length === 1, 'Lost request produced a missing or duplicate record');
    assert(snapshot.manifest.changeSequence === baseSequence + (mode === 'after' ? 3 : 4), 'Request recovery introduced another effect');
    assert(await evaluate(`!Object.keys(localStorage).some(key => key.startsWith('nendo.pending-mutation.v1.'))`), 'Acknowledged retry scratch was not removed');
    report.checks.push(mode === 'after'
      ? 'Real record commit with its response hidden; renderer reload looks up the retained receipt without repeating the write'
      : 'Request dropped before dispatch; renderer reload keeps the exact key/payload, disables new writes and explicit retry creates one record; Light/Dark evidence');
  }
  const beforeForm = await evaluate(`window.review.rpc('session.getSnapshot')`);
  const originalRecord = beforeForm.records[0];
  await click('#nav-use');
  await ready();
  await click('#show-list');
  await ready();
  await click('[data-record-id="' + originalRecord.recordId + '"]');
  await fill('[name="field.idea.title"]', 'Whole form saved');
  await fill('[name="field.idea.notes"]', 'Both fields in one revision');
  await evaluate(`window.review.dropData = 'after'; document.querySelector('#record-form').requestSubmit()`);
  await waitFor(() => evaluate(`window.review.discardedReceipt !== null`), 'hidden whole-form receipt');
  assert(await evaluate(`window.review.discardedReceipt.ok`), 'The real form save failed');
  const formInput = await evaluate(`window.review.discardedInput`);
  assert(Object.keys(formInput.values).length === 2, 'Form did not send both changed fields together');
  await reload();
  const afterForm = await evaluate(`window.review.rpc('session.getSnapshot')`);
  const savedRecord = afterForm.records.find(record => record.recordId === originalRecord.recordId);
  assert(afterForm.manifest.changeSequence === baseSequence + 5 && savedRecord.recordVersion === originalRecord.recordVersion + 2,
    'Form acknowledgement recovery changed its one-revision outcome');
  assert(savedRecord.values['field.idea.title'] === 'Whole form saved' && savedRecord.values['field.idea.notes'] === 'Both fields in one revision',
    'The form was partially saved');
  const formReceipt = await evaluate(`window.review.rpc('data.getReceipt', { idempotencyKey: ${JSON.stringify(formInput.idempotencyKey)} })`);
  const formHistory = await evaluate(`window.review.rpc('history.get')`);
  assert(formHistory.find(revision => revision.revisionId === formReceipt.revisionId).operations.length === 2,
    'Whole-form revision did not retain both canonical operations');
  await click('#nav-history');
  await ready();
  await click('[data-compensate="' + formReceipt.revisionId + '"]');
  await ready();
  const compensatedForm = await evaluate(`window.review.rpc('session.getSnapshot')`);
  assert(await evaluate(`!document.querySelector('[data-compensate="${formReceipt.revisionId}"]')`), 'Already compensated revision still offers a new compensation');
  const restoredRecord = compensatedForm.records.find(record => record.recordId === originalRecord.recordId);
  assert(compensatedForm.manifest.changeSequence === baseSequence + 6 && restoredRecord.recordVersion === originalRecord.recordVersion + 4,
    'Whole-form compensation was not one inverse revision');
  assert(JSON.stringify(restoredRecord.values) === JSON.stringify(originalRecord.values), 'Compensation did not restore both retained values');
  for (const theme of ['light', 'dark']) {
    await click('[data-theme-option="' + theme + '"]');
    await screenshot('whole-form-compensation-' + theme + '.png');
  }
  await reload();
  const reopenedForm = await evaluate(`window.review.rpc('session.getSnapshot')`);
  assert(reopenedForm.manifest.changeSequence === baseSequence + 6 &&
    JSON.stringify(reopenedForm.records.find(record => record.recordId === originalRecord.recordId).values) === JSON.stringify(originalRecord.values),
    'Reload did not retain the compensated form');
  report.checks.push('Real two-field form save uses one key and revision; hidden response resolves after renderer reload; native-backed History compensation restores both values in one revision; reload and Light/Dark evidence');
  for (const mode of ['after', 'before']) {
    await click('#nav-surfaces');
    await ready();
    await evaluate(`document.querySelector('#board-title').value = 'Acceptance recovered ${mode}'; document.querySelector('#rename-board-form').requestSubmit()`);
    await ready();
    await waitFor(() => evaluate(`!!document.querySelector('#accept-proposal')`), 'proposal acceptance review');
    await evaluate(`window.review.dropData = '${mode}'; window.review.discardedInput = null; window.review.discardedReceipt = null`);
    await click('#accept-proposal');
    await waitFor(() => evaluate(`window.review.discardedInput !== null`), 'retained acceptance request');
    const acceptance = await evaluate(`window.review.discardedInput`);
    assert(/^[a-f0-9]{64}$/i.test(acceptance.expectedOperationDigest), 'Acceptance omitted its reviewed digest');
    if (mode === 'after') {
      await waitFor(() => evaluate(`window.review.discardedReceipt !== null`), 'hidden acceptance receipt');
      assert(await evaluate(`window.review.discardedReceipt.ok && window.review.discardedReceipt.result.promotion.applied`), 'The real acceptance did not commit');
    }
    await reload();
    if (mode === 'before') {
      assert(await evaluate(`!!document.querySelector('#pending-save-notice') && document.querySelector('#session-health').textContent.includes('Acceptance unconfirmed')`), 'Acceptance was lost on renderer reload');
      for (const theme of ['light', 'dark']) {
        await click('[data-theme-option="' + theme + '"]');
        await screenshot('unconfirmed-acceptance-' + theme + '.png');
      }
      await click('#retry-pending-save');
      await waitFor(() => evaluate(`!document.querySelector('#pending-save-notice')`), 'explicit acceptance retry');
      assert(await evaluate(`window.review.lastDataPayload.proposalId === ${JSON.stringify(acceptance.proposalId)} && window.review.lastDataPayload.expectedOperationDigest === ${JSON.stringify(acceptance.expectedOperationDigest)}`), 'Acceptance retry changed its reviewed identity');
    }
    const accepted = await evaluate(`window.review.rpc('session.getSnapshot')`);
    assert(accepted.manifest.changeSequence === baseSequence + (mode === 'after' ? 7 : 8), 'Acceptance recovery created another effect');
    assert(await evaluate(`(async () => (await window.review.rpc('semantic.compile')).applications[0].surfaces.find(n => n.kind === 'boardSurface').properties.title === 'Acceptance recovered ${mode}')()`), 'Accepted definition did not survive reload');
    assert(await evaluate(`!Object.keys(localStorage).some(key => key.startsWith('nendo.pending-mutation.v1.'))`), 'Resolved acceptance scratch remains');
    report.checks.push(mode === 'after' ? 'Real proposal acceptance reply hidden after commit; renderer reload resolves its original digest-bound receipt without replay'
      : 'Proposal acceptance dropped before dispatch; reload retains the reviewed ID/digest; explicit retry applies once; Light/Dark evidence');
  }
  const sourcePath = path.join(output, 'outcome-workspace.nendo');
  const sourceHash = createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');
  await evaluate(`window.review.failHistory = true`);
  await click('#file-menu summary');
  await click('#file-actions [data-file-action="file.backup"]');
  const backupDirectory = path.join(output, 'backup');
  await fs.mkdir(backupDirectory);
  pickDirectory(backupDirectory);
  native('Save', 'Create backup', 'review-backup.nendo');
  await ready();
  assert(await evaluate(`document.querySelector('#file-notice').textContent.includes('Backup created: review-backup.nendo') && !!document.querySelector('#refresh-outcome-view')`),
    'A failed derived refresh hid the completed native backup');
  const backupBytes = await fs.readFile(path.join(backupDirectory, 'review-backup.nendo'));
  assert(backupBytes.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000', 'The native backup did not produce a SQLite file');
  assert(createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex') === sourceHash, 'Backup changed the source bytes');
  for (const theme of ['light', 'dark']) {
    await click('[data-theme-option="' + theme + '"]');
    await screenshot('backup-refresh-unavailable-' + theme + '.png');
  }
  await click('#refresh-outcome-view');
  await waitFor(() => evaluate(`!document.querySelector('#refresh-outcome-view')`), 'backup view refresh');
  assert(await evaluate(`window.review.backups === 1`), 'View refresh repeated the native backup action');
  report.checks.push('Owned native Backup picker and save creates a result without changing source bytes; failed derived refresh retains the completed notice and Refresh view never repeats Backup; Light/Dark evidence');
  assert(pageErrors.length === 0, 'Unhandled Workbench exceptions were observed');
  report.checks.push('No unhandled page exception');
  report.finalSequence = (await evaluate(`window.review.rpc('session.getSnapshot')`)).manifest.changeSequence;
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'passed', evidenceRoot: output, ...report }));
} catch (error) {
  // A timeout says what the script was waiting for, not what the page was showing.
  // This lane waited sixteen days on a rename form the host had refused in one red
  // sentence nobody read (F-084). Whatever failed, capture the page and its message
  // slot before the process goes, so the next failure names itself.
  try {
    await screenshot('failure.png');
    const seen = await evaluate(`JSON.stringify({
      busy: document.querySelector('#studio-content')?.getAttribute('aria-busy') ?? null,
      title: document.querySelector('#workspace-title')?.textContent ?? null,
      messages: [...document.querySelectorAll('.message-slot')].filter(e => !e.hidden).map(e => e.textContent),
      announcement: document.querySelector('#announcement')?.textContent ?? null,
      text: document.body.innerText.slice(0, 2000) })`);
    await fs.writeFile(path.join(output, 'failure-page.json'), seen);
    console.error(`Page at failure: ${seen}`);
    if (pageErrors.length > 0) console.error(`Page exceptions: ${JSON.stringify(pageErrors)}`);
  } catch (capture) {
    console.error(`The page could not be captured after the failure: ${capture.message}`);
  }
  throw error;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  socket?.close();
}
