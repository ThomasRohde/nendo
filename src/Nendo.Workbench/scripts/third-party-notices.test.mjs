import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfigFromFile } from 'vite';
import { missingNotices, productionPackages } from './third-party-notices.mjs';

// WST-02. Every Nendo installation carried AG Grid Community's MIT code inside index-*.js and
// Lucide's ISC icon paths, and no copy carried either notice: the minified bundle keeps none and
// nothing wrote one beside it. Measured here through the real Vite config: its plugin is run as a
// build runs it, and the file it emits must name every production package in the lockfile with
// that package's own licence text, Lucide's licence and Nendo's.
const root = fileURLToPath(new URL('..', import.meta.url));

async function emittedNotices() {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, fileURLToPath(new URL('../vite.config.ts', import.meta.url)), root, 'error');
  const emitted = [];
  for (const plugin of (loaded?.config.plugins ?? []).flat()) {
    const hook = plugin?.generateBundle;
    const run = typeof hook === 'function' ? hook : hook?.handler;
    if (typeof run === 'function') await run.call({ emitFile: (file) => { emitted.push(file); return 'ref'; } }, {}, {}, false);
  }
  return emitted.filter((file) => file.type === 'asset' && file.fileName === 'THIRD-PARTY-NOTICES.txt');
}

test('WST-02: the build writes the licence of everything the bundle carries beside it', async () => {
  const packages = productionPackages(root);
  assert.ok(packages.some((pkg) => pkg.name === 'ag-grid-community'), 'the lockfile read found no AG Grid Community; this guard reads nothing');
  const files = await emittedNotices();
  assert.equal(files.length, 1, 'the Workbench build emits no dist/THIRD-PARTY-NOTICES.txt');
  const text = String(files[0].source);
  assert.deepEqual(missingNotices(root, text), [], 'the notices the build writes leave a licence out');
  for (const pkg of packages) assert.match(text, new RegExp(`${pkg.name} ${pkg.version.replace(/\./g, '\\.')} \\(${pkg.license}\\)`));
  assert.match(text, /ISC License[\s\S]*Lucide/);
});

test('WST-02: both installer lanes refuse a payload without the notices', () => {
  // Test-NendoSetupIsolated.ps1 is the one that runs where Nendo is installed.
  for (const name of ['Test-NendoInstaller.ps1', 'Test-NendoSetupIsolated.ps1']) {
    const lane = readFileSync(new URL(`../../../tools/${name}`, import.meta.url), 'utf8');
    assert.match(lane, /Workbench[\\/\\\\]+THIRD-PARTY-NOTICES\.txt/, `${name} does not look for the Workbench notices in the payload`);
  }
});
