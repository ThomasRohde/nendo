// Author a complete Swarm app into an empty, host-created file. Never accepts a proposal.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import { definitionOperations, seedOperations } from './swarm/definition.mjs';
export const TITLE = 'Swarm: living habitat, editable behaviours and replayable experiments';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const root = path.resolve(import.meta.dirname, '../extensions/swarm');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'nendo-package.json'), 'utf8'));
const op = (operationType, payload) => ({ operationType, payload });
const operations = [...definitionOperations(), ...seedOperations(), op('extension.setPackage', manifest)];
const files = (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => path.relative(root, path.join(e.parentPath, e.name)).replaceAll('\\', '/')).filter(f => f !== 'nendo-package.json' && f !== 'README.md').sort();
for (const file of files) {
  const bytes = await fs.readFile(path.join(root, file));
  for (let offset = 0; offset < bytes.length; offset += 70 * 1024) operations.push(op('extension.putFile', { packageId: manifest.packageId, path: file,
    base64: bytes.subarray(offset, offset + 70 * 1024).toString('base64'), ...(offset === 0 ? { expectedSha256: 'absent' } : { append: true }) }));
}
if (operations.length > 128) throw Error(`${operations.length} operations exceed one proposal's bound of 128.`);
console.log(`${operations.length} typed operations, ${files.length} package files. Proposal: ${TITLE}`);
if (args.includes('--dry-run')) process.exit(0);
if (!args.includes('--endpoint') || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(option('--endpoint'))) throw Error('Name the new file host explicitly with --endpoint http://127.0.0.1:PORT/mcp.');
const client = createNendoMcpClient({ endpoint: option('--endpoint') }, 'nendo-swarm-builder');
const read = async uri => JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
const file = await read('nendo://application/manifest');
if (['application-5c52097771f342d5a648fcb514318e7c', 'application-7efd926c073f4be9974be19bbc39ff41'].includes(file.applicationId)) throw Error('Refused: this endpoint is a development planner.');
if ((await read('nendo://application/entities')).length) throw Error('Refused: build only into an empty, newly created Swarm file.');
if ((await read('nendo://application/proposals')).length) throw Error('Refused: this file already has pending proposals.');
const lease = await client.tool('nendo.lease.acquire'), owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
try {
  const draft = await client.tool('nendo.change_set.begin', { ...owned, title: TITLE, idempotencyKey: crypto.randomUUID() });
  const stateRoot = path.resolve(import.meta.dirname, '../artifacts/swarm');
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, 'proposal-state.json'), JSON.stringify({ endpoint: client.endpoint.href, changeSetId: draft.changeSetId, title: TITLE }));
  let batch = [], chars = 0, mutation = 0, lane;
  const send = async () => { if (!batch.length) return; await client.tool('nendo.change_set.add_operations', { ...owned, changeSetId: draft.changeSetId, mutations: [{ description: `Swarm app (${++mutation})`, operations: batch }], idempotencyKey: crypto.randomUUID() }); batch = []; chars = 0; };
  for (const operation of operations) { const size = JSON.stringify(operation).length, nextLane = operation.operationType.startsWith('data.') ? 'data' : 'definition'; if (batch.length === 16 || chars + size > 195000 || (lane && lane !== nextLane) || (batch.length && operation.operationType === 'schema.createEntity')) await send(); lane = nextLane; batch.push(operation); chars += size; }
  await send();
  const result = await client.tool('nendo.change_set.validate', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
  if (result.state !== 'previewable' || (result.diagnostics ?? []).some(d => d.severity !== 'warning')) throw Error(`Validation declined: ${JSON.stringify(result.diagnostics)}`);
  console.log(`Validated on the host's clone: ${result.preview.entities.length} record types, ${result.preview.fieldCount} fields, ${result.preview.recordCount} records; ${result.operationCount} canonical operations, ${result.diagnostics.length} diagnostics. Nothing is applied. Review and accept in Nendo: ${TITLE}`);
} finally { await client.tool('nendo.lease.release', owned); }
