// Authors the Manuscript app into an empty, host-created file: schema, screens, the
// starting manuscript and the view package, as one proposal. At Unattended the proposal is
// accepted, as Build-Garden does; at any lower level it waits for the person.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import { definitionOperations, screenOperations, seedOperations } from './manus/definition.mjs';

export const TITLE = 'Manuscript: a quiet continuous sheet, kept paragraph by paragraph';
const PLANNERS = ['application-d0b7c0e877744c1c81cf0fdd013cae2e', 'application-5c52097771f342d5a648fcb514318e7c', 'application-7efd926c073f4be9974be19bbc39ff41'];
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const root = path.resolve(import.meta.dirname, '../extensions/manuscript');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'nendo-package.json'), 'utf8'));
const op = (operationType, payload) => ({ operationType, payload });
const operations = [...definitionOperations(), ...screenOperations(), ...seedOperations(), op('extension.setPackage', manifest)];
const files = (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile())
  .map(e => path.relative(root, path.join(e.parentPath, e.name)).replaceAll('\\', '/'))
  .filter(f => f !== 'nendo-package.json').sort();
for (const file of files) {
  const bytes = await fs.readFile(path.join(root, file));
  for (let offset = 0; offset < bytes.length; offset += 70 * 1024) operations.push(op('extension.putFile', { packageId: manifest.packageId, path: file,
    base64: bytes.subarray(offset, offset + 70 * 1024).toString('base64'), ...(offset === 0 ? { expectedSha256: 'absent' } : { append: true }) }));
}
if (operations.length > 128) throw Error(`${operations.length} operations exceed one proposal's bound of 128.`);
console.log(`${operations.length} typed operations, ${files.length} package files. Proposal: ${TITLE}`);
if (args.includes('--dry-run')) process.exit(0);
if (!args.includes('--endpoint') || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(option('--endpoint'))) throw Error('Name the new file host explicitly with --endpoint http://127.0.0.1:PORT/mcp.');
const client = createNendoMcpClient({ endpoint: option('--endpoint') }, 'nendo-manuscript-builder');
const read = async uri => JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
const file = await read('nendo://application/manifest');
if (PLANNERS.includes(file.applicationId)) throw Error('Refused: this endpoint is a development planner.');
if ((await read('nendo://application/entities')).length) throw Error('Refused: build only into an empty, newly created file.');
if ((await read('nendo://application/proposals')).length) throw Error('Refused: this file already has pending proposals.');
const lease = await client.tool('nendo.lease.acquire', { idempotencyKey: crypto.randomUUID() });
const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
try {
  const draft = await client.tool('nendo.change_set.begin', { ...owned, title: TITLE, idempotencyKey: crypto.randomUUID() });
  let batch = [], chars = 0, mutation = 0, lane;
  const send = async () => {
    if (!batch.length) return;
    await client.tool('nendo.change_set.add_operations', { ...owned, changeSetId: draft.changeSetId, mutations: [{ description: `Manuscript app (${++mutation})`, operations: batch }], idempotencyKey: crypto.randomUUID() });
    batch = []; chars = 0;
  };
  for (const operation of operations) {
    const size = JSON.stringify(operation).length;
    const nextLane = operation.operationType.startsWith('data.') ? 'data' : 'definition';
    if (batch.length === 16 || chars + size > 195000 || (lane && lane !== nextLane) || (batch.length && operation.operationType === 'schema.createEntity')
      || (batch.length && operation.operationType === 'schema.declareHierarchy') || (batch.length && operation.operationType === 'ui.addNode' && batch.at(-1).operationType !== 'ui.addNode')) await send();
    lane = nextLane; batch.push(operation); chars += size;
  }
  await send();
  const result = await client.tool('nendo.change_set.validate', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
  const blocking = (result.diagnostics ?? []).filter(d => d.severity !== 'warning');
  if (result.state !== 'previewable' || blocking.length) throw Error(`Validation declined: ${JSON.stringify(result.diagnostics)}`);
  console.log(`Validated on the host's clone: ${result.preview.entities.length} record types, ${result.preview.fieldCount} fields, ${result.preview.recordCount} records; ${result.operationCount} canonical operations, ${result.diagnostics.length} diagnostics.`);
  if (lease.mode !== 'unattended' || !args.includes('--accept')) {
    console.log(`Nothing is applied. Review and accept in Nendo: ${TITLE}`);
  } else {
    const accepted = await client.tool('nendo.change_set.accept', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    if (accepted.applied !== true) throw Error(`Not applied: ${accepted.state}. ${accepted.message ?? ''}`);
    console.log(`Accepted at Unattended: definition revision ${accepted.definitionRevision}, ${accepted.revisions?.length ?? '?'} revisions.`);
  }
} finally { await client.tool('nendo.lease.release', owned); }
