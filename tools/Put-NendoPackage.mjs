// Puts a custom-view package folder into the file a running Nendo has open, as a proposal
// a person accepts (ADR-0013, 2026-09-25). The folder holds a nendo-package.json and the
// package's files; the manifest itself is not stored, because the package row holds it.
//
//   node tools/Put-NendoPackage.mjs <folder> [--application <applicationId>] [--title <title>] [--dry-run] [--accept]
//
// Only what differs from the package the file already carries is proposed, and every put
// and removal names the content it replaces, so a proposal prepared against an older
// package is refused rather than replayed over a newer one. Acceptance is the person's act:
// --accept only works while the person has set that file's Agent access to Unattended, the
// one level at which they have said an agent may accept its own proposal. Below it the
// proposal waits for them in Nendo.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';

// The 96 KiB bound on one extension.putFile is on its JSON payload, where base64 makes the
// bytes a third larger: 70 KiB of file is about 94 KiB of payload.
const PUT_FILE_BYTES = 70 * 1024;
// The local MCP takes a request body of at most 256 KiB, so a call, and therefore a mutation,
// carries at most about 200,000 characters of operations: two parts of a large file.
const CALL_CHARACTERS = 200_000;
const OPERATIONS_PER_MUTATION = 16, MUTATIONS_PER_CALL = 8;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const folder = args.find((value, index) => !value.startsWith('--') && !['--application', '--title'].includes(args[index - 1]));
const dryRun = args.includes('--dry-run');
const accept = args.includes('--accept');
if (!folder) fail('Name the package folder: node tools/Put-NendoPackage.mjs extensions/gantt');

async function readPackage() {
  const manifest = JSON.parse(await fs.readFile(path.join(folder, 'nendo-package.json'), 'utf8').catch(() =>
    fail(`${folder} has no nendo-package.json.`)));
  if (typeof manifest.packageId !== 'string') fail('nendo-package.json needs a packageId.');
  const names = (await fs.readdir(folder, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.relative(folder, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/'))
    .filter(name => name !== 'nendo-package.json' && !name.split('/').some(part => part.startsWith('.') || part === 'node_modules'))
    .sort();
  const files = [];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(folder, name));
    files.push({ path: name, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return { manifest, files };
}

async function connect() {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'Nendo', 'Mcp', 'active');
  const names = await fs.readdir(root).then(all => all.filter(name => name.endsWith('.json')), () => []);
  const candidates = [];
  for (const name of names) {
    let entry;
    try { entry = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); } catch { continue; }
    if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp\/?$/.test(entry.endpoint ?? '')) continue;
    const client = createNendoMcpClient(entry, 'nendo-put-package');
    try {
      const read = await client.rpc('resources/read', { uri: 'nendo://application/manifest' });
      candidates.push({ client, manifest: JSON.parse(read.contents[0].text) });
    } catch { /* not answering */ }
  }
  if (candidates.length === 0) fail('No Nendo is running with a file open. Open the file in Nendo and try again.');
  const wanted = option('--application');
  const chosen = wanted ? candidates.filter(candidate => candidate.manifest.applicationId === wanted) : candidates;
  if (chosen.length !== 1) {
    fail([
      wanted ? `No running Nendo has application ${wanted} open.` : 'More than one Nendo is running. Name the file with --application:',
      ...candidates.map(candidate => `  ${candidate.manifest.applicationId}  ${candidate.manifest.purpose ?? ''}`.trimEnd()),
    ].join('\n'));
  }
  return chosen[0];
}

const op = (operationType, payload) => ({ operationType, payload });

async function main() {
  const { manifest, files } = await readPackage();
  const { client, manifest: file } = await connect();
  const read = await client.rpc('resources/read', { uri: 'nendo://application/extensions' });
  const parsed = JSON.parse(read.contents[0].text);
  const current = (Array.isArray(parsed) ? parsed : parsed.packages ?? []).find(candidate => candidate.packageId === manifest.packageId) ?? null;

  const operations = [op('extension.setPackage', {
    packageId: manifest.packageId, title: manifest.title ?? manifest.packageId,
    entryPoint: manifest.entryPoint ?? 'index.html', version: manifest.version, description: manifest.description,
  })];
  for (const held of current?.files ?? []) {
    if (!files.some(candidate => candidate.path === held.path))
      operations.push(op('extension.removeFile', { packageId: manifest.packageId, path: held.path, expectedSha256: held.sha256 }));
  }
  for (const entry of files) {
    const held = current?.files.find(candidate => candidate.path === entry.path);
    if (held?.sha256 === entry.sha256) continue;
    for (let offset = 0; offset === 0 || offset < entry.bytes.length; offset += PUT_FILE_BYTES) {
      operations.push(op('extension.putFile', {
        packageId: manifest.packageId, path: entry.path,
        base64: entry.bytes.subarray(offset, offset + PUT_FILE_BYTES).toString('base64'),
        ...(offset === 0 ? { expectedSha256: held?.sha256 ?? 'absent' } : { append: true }),
      }));
    }
  }
  const unchanged = current && operations.length === 1 && current.title === (manifest.title ?? manifest.packageId) &&
    (current.version ?? null) === (manifest.version ?? null) && current.entryPoint === (manifest.entryPoint ?? 'index.html') &&
    (current.description ?? null) === (manifest.description ?? null);
  if (unchanged) fail(`The file already carries ${manifest.packageId} exactly as ${folder} has it.`);

  const title = option('--title') ?? `${current ? 'Update' : 'Add'} the custom view package ${manifest.title ?? manifest.packageId}`;
  console.log(`File            ${file.applicationId}`);
  console.log(`Package         ${manifest.packageId}${current ? ' (update)' : ' (new)'}`);
  console.log(`Operations      ${operations.length}`);
  if (dryRun) { console.log('Dry run: nothing was sent.'); return; }

  const lease = await client.tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    const draft = await client.tool('nendo.change_set.begin', { ...owned, title, idempotencyKey: crypto.randomUUID() });
    // Operations are packed into mutations by size, and mutations into calls, so a package of
    // many small files and one of a single large file both fit the change set's 32 mutations.
    const mutations = [];
    for (const operation of operations) {
      const size = JSON.stringify(operation).length, last = mutations.at(-1);
      if (last === undefined || last.operations.length === OPERATIONS_PER_MUTATION || last.size + size > CALL_CHARACTERS) {
        mutations.push({ description: mutations.length === 0 ? `Describe the package ${manifest.packageId} and put its files` : `Put more of ${manifest.packageId}`,
          operations: [operation], size });
      } else { last.operations.push(operation); last.size += size; }
    }
    let batch = [], characters = 0;
    const send = async () => {
      if (batch.length === 0) return;
      await client.tool('nendo.change_set.add_operations', {
        ...owned, changeSetId: draft.changeSetId, mutations: batch.map(({ description, operations }) => ({ description, operations })), idempotencyKey: crypto.randomUUID(),
      });
      batch = []; characters = 0;
    };
    for (const mutation of mutations) {
      if (batch.length === MUTATIONS_PER_CALL || characters + mutation.size > CALL_CHARACTERS) await send();
      batch.push(mutation);
      characters += mutation.size;
    }
    await send();
    console.log(`Sent            ${mutations.length} mutations`);
    const validated = await client.tool('nendo.change_set.validate', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    const diagnostics = (validated.diagnostics ?? []).filter(diagnostic => diagnostic.severity !== 'warning');
    if (validated.isValid === false || diagnostics.length > 0) {
      console.error('\nThe draft did not validate. It stays open; correct it and validate again.\n');
      for (const diagnostic of validated.diagnostics ?? []) console.error(`  ${diagnostic.code ?? ''} ${diagnostic.message ?? JSON.stringify(diagnostic)}`);
      process.exitCode = 1;
      return;
    }
    if (!accept) {
      console.log('\nValidated on a clone. Nothing has changed in the file yet. In Nendo, review and accept the proposal');
      console.log(`  ${title}`);
      return;
    }
    let accepted;
    try {
      accepted = await client.tool('nendo.change_set.accept', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    } catch {
      console.log('\nValidated, but this file is not at Unattended, so it is not accepted here. In Nendo, review and accept the proposal');
      console.log(`  ${title}`);
      return;
    }
    if (accepted.applied !== true) {
      console.error(`\nNot applied: ${accepted.state}. ${accepted.message ?? ''}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nAccepted at Unattended and applied: definition revision ${accepted.definitionRevision}. It is an ordinary History revision, so it can be reversed.`);
  } finally {
    await client.tool('nendo.lease.release', owned).catch(() => { /* the person may have revoked it */ });
  }
}

main().catch(error => fail(error.stack ?? String(error)));
