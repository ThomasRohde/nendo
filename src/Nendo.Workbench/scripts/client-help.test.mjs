import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

const bundle = await build({ configFile: false, logLevel: 'error',
  build: { ssr: 'src/client-help.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const { serverNameFor, connectionCommand, standardEndpoint } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

// W-089. Each file keeps a port of its own, so two files registered side by side need two
// names. The copy buttons used to say "nendo" for every file, and registering a second file
// with them replaced the first.
test('each file is registered under a name made from the file', () => {
  assert.equal(serverNameFor('Nendo.nendo'), 'nendo', 'the planner keeps the name every guide uses');
  assert.equal(serverNameFor('BCM.nendo'), 'nendo-bcm');
  assert.equal(serverNameFor('Nendo Station.nendo'), 'nendo-station');
  assert.equal(serverNameFor('Work dependencies demo.nendo'), 'nendo-work-dependencies-demo');
  assert.equal(serverNameFor('Café Menü.nendo'), 'nendo-cafe-menu');
  assert.equal(serverNameFor('***.nendo'), 'nendo');
  assert.equal(serverNameFor(null), 'nendo');
  const long = serverNameFor(`${'a'.repeat(80)}.nendo`);
  assert.ok(long.length <= 46 && /^nendo-a+$/.test(long), long);
  for (const name of ['Nendo.nendo', 'BCM.nendo', 'Nendo Station.nendo', 'Café Menü.nendo', `${'x-'.repeat(40)}.nendo`]) {
    assert.match(serverNameFor(name), /^[a-z0-9]+(-[a-z0-9]+)*$/, `${name} gives a name a client accepts`);
  }
});

test('the copied command registers this file at its own address under its own name', () => {
  const endpoint = 'http://127.0.0.1:41764/mcp';
  assert.equal(connectionCommand('claude', endpoint, 'nendo-bcm'), 'claude mcp add --transport http nendo-bcm http://127.0.0.1:41764/mcp');
  assert.equal(connectionCommand('codex', endpoint, 'nendo-bcm'), 'codex mcp add nendo-bcm --url http://127.0.0.1:41764/mcp');
  assert.equal(connectionCommand('claude', standardEndpoint), 'claude mcp add --transport http nendo http://127.0.0.1:41763/mcp',
    'without a name the command is the one the guides print');
});
