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
