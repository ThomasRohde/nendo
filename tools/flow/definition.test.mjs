import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { definitionOperations, seedOperations, fixtureText, FIXTURE, PACKAGE_ID } from './definition.mjs';

test('the Engine fixture is the operations the build sends', async () => {
  // FlowAppTests installs this file; a stale copy would test an app nobody ships.
  assert.equal((await fs.readFile(FIXTURE, 'utf8')).replace(/\r\n/g, '\n'), fixtureText(),
    'tools/flow/flow-app.operations.json is stale: run node tools/flow/definition.mjs --write.');
});

test('the app fits one proposal with its package', async () => {
  const files = (await fs.readdir(new URL('../../extensions/flow/', import.meta.url), { recursive: true, withFileTypes: true })).filter(e => e.isFile());
  let chunks = 0;
  for (const entry of files) {
    if (entry.name === 'nendo-package.json' || entry.name === 'README.md') continue;
    chunks += Math.max(1, Math.ceil((await fs.stat(`${entry.parentPath}/${entry.name}`)).size / (70 * 1024)));
  }
  const total = definitionOperations().length + seedOperations().length + 1 + chunks;
  assert.ok(total <= 128, `${total} operations exceed one proposal's 128.`);
});

test('every reference a seed record sets is to a record created before it', () => {
  const created = new Set();
  for (const { payload } of seedOperations()) {
    for (const field of Object.keys(payload.expectedTargetVersions)) assert.ok(created.has(payload.values[field]), `${payload.recordId} points at ${payload.values[field]} before it exists.`);
    created.add(payload.recordId);
  }
});

test('the screen names the package the build puts in the file', () => {
  const screen = definitionOperations().find(o => o.operationType === 'ui.addNode' && o.payload.kind === 'extensionView');
  assert.equal(screen.payload.properties.packageId, PACKAGE_ID);
});
