import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { uncoveredFiles } from './desktop-notices.mjs';

// The installed Nendo carries the .NET runtimes, the Windows App SDK and the NuGet packages the host
// runs on, and their licences require their notice in every copy. Publish-NendoPayload.ps1 writes
// THIRD-PARTY-NOTICES.txt from the publish's own list of files and refuses a file nothing covers;
// measured here on that refusal, and on the installer lanes that look for the file.
const ncalc = { id: 'NCalc', version: '7.1.0', path: 'ncalc/7.1.0' };
const parlot = { id: 'Parlot', version: '1.5.8', path: 'parlot/1.5.8' };
const list = {
  files: [
    { path: 'NCalc.dll', package: ncalc },
    { path: 'Parlot.dll', package: parlot },
    { path: 'Nendo.Engine.dll', package: null },
    { path: 'MainPage.xbf', package: null },
    { path: 'Assets/AppIcon.ico', package: null },
    { path: 'Workbench/index.html', package: null },
  ],
  packages: [ncalc, parlot],
};
const notices = '====\nNendo\n====\n\nMIT\n====\nNCalc 7.1.0 (MIT)\n====\n\nMIT\n====\nParlot 1.5.8 (BSD-3-Clause)\n====\n\nBSD\n';

test('every published file is covered by a package the notices name, or is Nendo\'s own', () => {
  assert.deepEqual(uncoveredFiles(list, notices), []);
});

test('a file from a package the notices leave out is refused by name', () => {
  assert.deepEqual(uncoveredFiles(list, notices.replace('Parlot 1.5.8 (BSD-3-Clause)', '')),
    ['Parlot.dll comes from Parlot 1.5.8, which the notices do not name']);
  // A package named only inside another's text is not named.
  assert.deepEqual(uncoveredFiles(list, notices.replace('\nParlot 1.5.8 (', '\nsee Parlot 1.5.8 (')),
    ['Parlot.dll comes from Parlot 1.5.8, which the notices do not name']);
});

test('a file from no package that is not Nendo\'s own is refused by name', () => {
  const vendored = { ...list, files: [...list.files, { path: 'onnxruntime.dll', package: null }] };
  assert.deepEqual(uncoveredFiles(vendored, notices), ['onnxruntime.dll comes from no package and is not Nendo\'s own']);
});

test('the payload publish writes the notices and both installer lanes refuse a payload without them', () => {
  const publish = readFileSync(new URL('../../../tools/Publish-NendoPayload.ps1', import.meta.url), 'utf8');
  assert.match(publish, /desktop-notices\.mjs/, 'Publish-NendoPayload.ps1 does not write the payload\'s notices');
  for (const name of ['Test-NendoInstaller.ps1', 'Test-NendoSetupIsolated.ps1']) {
    const lane = readFileSync(new URL(`../../../tools/${name}`, import.meta.url), 'utf8');
    assert.match(lane, /\$_\.path -eq 'THIRD-PARTY-NOTICES\.txt'/, `${name} does not look for THIRD-PARTY-NOTICES.txt beside the host`);
  }
});
