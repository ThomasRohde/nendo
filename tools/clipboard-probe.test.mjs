import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the journey's own reader with a controlled process boundary. This lane
// never opens the real clipboard; the native journey still measures its pixels.
const source = await fs.readFile(new URL('./Review-ExtensionViews.mjs', import.meta.url), 'utf8');
const reader = source.slice(source.indexOf('function readWindowsClipboard()'), source.indexOf('\nfunction closeHostDialog'));
function read(error, stdout, stderr = '') {
  const context = vm.createContext({ execFile: (_file, _args, _options, done) => done(error, stdout, stderr) });
  vm.runInContext(reader, context);
  return context.readWindowsClipboard();
}

test('the clipboard probe rejects empty output even when PowerShell exits zero', async () => {
  await assert.rejects(read(null, '', 'Requested Clipboard operation did not succeed.'),
    /Windows clipboard probe returned no JSON: Requested Clipboard operation did not succeed/);
});
test('the clipboard probe preserves the child access failure', async () => {
  await assert.rejects(read(Error('exit 1'), '', 'GetDataObject: Access is denied.'),
    /Windows clipboard probe failed: GetDataObject: Access is denied/);
});
test('the clipboard probe rejects missing or malformed measurements', async () => {
  for (const stdout of ['null', '{}', 'not JSON'])
    await assert.rejects(read(null, stdout), /Windows clipboard probe returned invalid JSON/);
});
test('the clipboard probe returns successful format and pixel measurements unchanged', async () => {
  const measurement = { formats: ['PNG', 'Bitmap'], png: '730x1240 corner=255,255,255,255 centre=255,255,0,0' };
  assert.equal(JSON.stringify(await read(null, JSON.stringify(measurement))), JSON.stringify(measurement));
});

// TST-01: a locked workstation is an interlock, not a failure, and an unlocked one never is.
function lockContext(error, stdout, stderr = '') {
  const calls = [];
  const context = vm.createContext({ execFile: (file, args, _options, done) => {
    const sent = [];
    calls.push({ file, args, sent });
    queueMicrotask(() => done(error, stdout, stderr));
    return { stdin: { end: text => sent.push(text) } };
  } });
  vm.runInContext(reader, context);
  return { context, calls };
}
test('a session on the secure desktop or under LogonUI is named as locked', async () => {
  for (const probe of [{ desktop: 'Winlogon', logonUi: true }, { desktop: 'none (error 5)', logonUi: false }, { desktop: 'Default', logonUi: true }]) {
    const { context } = lockContext(null, JSON.stringify(probe));
    assert.match(await context.workstationLocked(), /^the workstation is locked \(input desktop .+\), and a locked session refuses every clipboard read/);
  }
});
test('an unlocked session is not locked, so a clipboard failure there still fails the journey', async () => {
  const { context } = lockContext(null, JSON.stringify({ desktop: 'Default', logonUi: false }));
  assert.equal(await context.workstationLocked(), null);
});
test('a lock probe that cannot answer is a failure rather than a guess', async () => {
  await assert.rejects(lockContext(Error('exit 1'), '', 'Add-Type failed').context.workstationLocked(), /The workstation lock probe failed: Add-Type failed/);
  await assert.rejects(lockContext(null, '{}').context.workstationLocked(), /The workstation lock probe returned no answer/);
});
test('the clipboard reader waits out a clipboard another program holds open', async () => {
  const { context, calls } = lockContext(null, JSON.stringify({ formats: ['PNG'] }));
  await context.readWindowsClipboard();
  assert.match(calls[0].args.at(-1), /for \(\$try = 1; -not \$data; \$try\+\+\) \{ try \{ \$data = \[Windows\.Forms\.Clipboard\]::GetDataObject\(\) \} catch \{ if \(\$try -ge 20\) \{ throw \}; Start-Sleep -Milliseconds 100 \} \}/);
});
test('the text put back travels on standard input, never on the command line', async () => {
  const { context, calls } = lockContext(null, '');
  await context.restoreClipboardText('the person’s text ✓');
  assert.deepEqual(calls[0].sent, ['the person’s text ✓']);
  assert.ok(!calls[0].args.join(' ').includes('the person'));
});
