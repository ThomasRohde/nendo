import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInfoFile } from './info-file.mjs';

// A write that creates its file and then stalls before the bytes arrive, as a busy machine
// can, so the moment a lane might read the address file can be looked at directly.
function stallingFs() {
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  return {
    release,
    async writeFile(file, text, encoding) {
      await fs.writeFile(file, '', encoding);
      await stalled;
      await fs.writeFile(file, text, encoding);
    },
    rename: (from, to) => fs.rename(from, to),
  };
}

test('the address file never exists half-written', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nendo-info-file-'));
  try {
    const target = path.join(folder, 'server.json');
    const stalling = stallingFs();
    const writing = writeInfoFile(target, '{"pid":1}', stalling);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(target), false, 'A lane polling for the address file would find it empty.');
    stalling.release();
    await writing;
    assert.equal(await fs.readFile(target, 'utf8'), '{"pid":1}');
    assert.deepEqual(await fs.readdir(folder), ['server.json'], 'The partial file was left behind.');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('both fixture servers write their address through it', async () => {
  for (const server of ['Graph-FixtureServer.mjs', 'Workbench-PreviewServer.mjs']) {
    const source = await fs.readFile(new URL(server, import.meta.url), 'utf8');
    assert.match(source, /writeInfoFile\(/, `${server} does not write its address file through writeInfoFile.`);
    assert.doesNotMatch(source, /fs\.writeFile\(\s*(?:process\.argv\[2\]|infoPath)/, `${server} still writes its address file in place.`);
  }
});
