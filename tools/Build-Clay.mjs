// Author Clay into an empty, host-created file: its purpose, its home view and its package,
// and no record types, since a Clay file grows those itself. Accepts only with --accept,
// which the host serves at Unattended alone.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';
export const TITLE = 'Clay: shelves that grow their own shape';
const PURPOSE = 'Collect anything. Make shelves and fill them, writing details as Label: value. When a shelf has no place for a detail yet, Clay proposes one, guessed from the value, and you accept it in the review.';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const root = path.resolve(import.meta.dirname, '../extensions/clay');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'nendo-package.json'), 'utf8'));
const op = (operationType, payload) => ({ operationType, payload });
const operations = [
  op('application.setPurpose', { purpose: PURPOSE }),
  op('extension.setPackage', manifest),
];
const files = (await fs.readdir(root)).filter(f => !['nendo-package.json', 'README.md'].includes(f)).sort();
for (const file of files) {
  const bytes = await fs.readFile(path.join(root, file));
  for (let offset = 0; offset < bytes.length; offset += 70 * 1024) operations.push(op('extension.putFile', { packageId: manifest.packageId, path: file,
    base64: bytes.subarray(offset, offset + 70 * 1024).toString('base64'), ...(offset === 0 ? { expectedSha256: 'absent' } : { append: true }) }));
}
operations.push(op('ui.addNode', { surfaceId: 'clay', nodeId: 'clay.home', parentNodeId: null, kind: 'extensionView', position: 0,
  properties: { definitionVersion: 3, title: 'Clay', packageId: manifest.packageId, opensFile: true } }));
console.log(`${operations.length} typed operations, ${files.length} package files (${files.join(', ')}). Proposal: ${TITLE}`);
if (args.includes('--dry-run')) process.exit(0);
if (!args.includes('--endpoint') || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(option('--endpoint'))) throw Error('Name the new file host explicitly with --endpoint http://127.0.0.1:PORT/mcp.');
const client = createNendoMcpClient({ endpoint: option('--endpoint') }, 'nendo-clay-builder');
const read = async uri => JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
const file = await read('nendo://application/manifest');
if (['application-d0b7c0e877744c1c81cf0fdd013cae2e', 'application-5c52097771f342d5a648fcb514318e7c', 'application-7efd926c073f4be9974be19bbc39ff41'].includes(file.applicationId)) throw Error('Refused: this endpoint is a development planner.');
if ((await read('nendo://application/entities')).length) throw Error('Refused: build only into an empty, newly created Clay file.');
if ((await read('nendo://application/proposals')).length) throw Error('Refused: this file already has pending proposals.');
const lease = await client.tool('nendo.lease.acquire', { idempotencyKey: crypto.randomUUID() }), owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
try {
  const draft = await client.tool('nendo.change_set.begin', { ...owned, title: TITLE, idempotencyKey: crypto.randomUUID() });
  for (let at = 0, n = 0; at < operations.length; at += 12)
    await client.tool('nendo.change_set.add_operations', { ...owned, changeSetId: draft.changeSetId,
      mutations: [{ description: `Clay app (${++n})`, operations: operations.slice(at, at + 12) }], idempotencyKey: crypto.randomUUID() });
  const result = await client.tool('nendo.change_set.validate', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
  if (result.state !== 'previewable' || (result.diagnostics ?? []).some(d => d.severity !== 'warning')) throw Error(`Validation declined: ${JSON.stringify(result.diagnostics)}`);
  console.log(`Validated on the host's clone: ${result.operationCount} canonical operations, ${result.diagnostics.length} diagnostics.`);
  if (args.includes('--accept')) {
    const accepted = await client.tool('nendo.change_set.accept', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    console.log(accepted.applied ? `Accepted: ${TITLE}` : `Not applied (${accepted.state}). The proposal waits in Nendo: ${TITLE}`);
  } else console.log(`Nothing is applied. Review and accept in Nendo: ${TITLE}`);
} finally { await client.tool('nendo.lease.release', owned); }
