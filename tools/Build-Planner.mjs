// Builds the shape of workspace/Planner.nendo into an empty file over MCP alone.
// It writes no records: the live planner's work is owner data, not something a
// rebuild could reproduce.
//
//   node tools/Build-Planner.mjs                 the first stage not yet applied
//   node tools/Build-Planner.mjs <stage>         one named stage
//   node tools/Build-Planner.mjs --list          what the stages are
//   node tools/Build-Planner.mjs --dry-run       say what would be sent, take no lease
//
// The shape is in tools/planner-definition.mjs and the reasons in
// docs/design/planner.md. One stage is one change set, validated into a proposal.
// When the person has set Planner.nendo's Agent access to Unattended the script
// accepts its own proposal, as tools/Put-NendoPackage.mjs --accept does; below it,
// it prints the proposal's title and stops, because acceptance is theirs.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient, isRunning } from './Nendo-McpClient.mjs';
import { STAGES, STAGE_ORDER, CALL_CHARACTERS } from './planner-definition.mjs';

const TARGET_FILE_NAME = process.env.NENDO_PLANNER_TARGET || 'Planner.nendo';

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function running() {
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'Nendo', 'Mcp', 'active');
  let names = [];
  try { names = (await fs.readdir(root)).filter(name => name.endsWith('.json')); } catch { /* none */ }
  const entries = [];
  for (const name of names) {
    try { entries.push(JSON.parse(await fs.readFile(path.join(root, name), 'utf8'))); } catch { /* half-written */ }
  }
  return entries.filter(entry => /^http:\/\/127\.0\.0\.1:\d+\/mcp\/?$/.test(entry.endpoint ?? '') && isRunning(entry));
}

// Identity is read from the file itself, never trusted to the discovery entry.
async function open(entry) {
  const client = createNendoMcpClient(entry, 'nendo-planner-build');
  const manifest = JSON.parse((await client.rpc('resources/read', { uri: 'nendo://application/manifest' })).contents[0].text);
  return { entry, client, manifest, read: reader(client) };
}

async function target() {
  const entries = (await running()).filter(entry => entry.displayName === TARGET_FILE_NAME);
  if (entries.length === 0) fail(`No Nendo has ${TARGET_FILE_NAME} open. Open it, turn Agent access on, and run this again.`);
  if (entries.length > 1) fail(`More than one Nendo has a file named ${TARGET_FILE_NAME} open. Close all but one.`);
  return open(entries[0]);
}

function reader(client) {
  const json = async uri => JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
  return {
    json,
    entities: async () => (await json('nendo://application/entities')).map(entity => entity.entityId),
    schema: entityId => json(`nendo://application/entity/${entityId}/schema`),
    hasNode: async nodeId => (await client.rpc('resources/read', { uri: 'nendo://application/surfaces' }))
      .contents[0].text.includes(`"${nodeId}"`),
  };
}

async function withLease(client, work) {
  const lease = await client.tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    return await work(owned, lease);
  } finally {
    await client.tool('nendo.lease.release', owned).catch(() => { /* the person may have revoked it */ });
  }
}

async function applied(file, name) {
  const stage = STAGES[name];
  const present = await file.read.entities();
  if (stage.appliedWhen) {
    if ((stage.needs ?? []).some(id => !present.includes(id))) return false;
    return stage.appliedWhen(file.read);
  }
  return stage.makes.every(id => present.includes(id));
}

async function runStage(file, name, dryRun) {
  const stage = STAGES[name];
  const present = await file.read.entities();
  const missing = (stage.needs ?? []).filter(id => !present.includes(id));
  if (missing.length > 0 && !dryRun) fail(`Stage ${name} needs ${missing.join(', ')}, which an earlier stage makes.`);

  const mutations = await stage.mutations();
  const operations = mutations.reduce((total, mutation) => total + mutation.operations.length, 0);
  for (const mutation of mutations) {
    if (mutation.operations.length > 16) fail(`"${mutation.description}" holds ${mutation.operations.length} operations; a call carries 16.`);
  }
  console.log(`Stage           ${name}: ${stage.title}`);
  console.log(`                ${mutations.length} mutations, ${operations} operations`);
  if (dryRun) {
    console.log('Dry run: nothing sent, no lease taken.');
    return true;
  }

  return withLease(file.client, async (owned, lease) => {
    const draft = await file.client.tool('nendo.change_set.begin', {
      ...owned, title: stage.title, idempotencyKey: crypto.randomUUID(),
    });
    let batch = [];
    let batched = 0;
    let characters = 0;
    const send = async () => {
      if (batch.length === 0) return;
      await file.client.tool('nendo.change_set.add_operations', {
        ...owned, changeSetId: draft.changeSetId, mutations: batch, idempotencyKey: crypto.randomUUID(),
      });
      batch = [];
      batched = 0;
      characters = 0;
    };
    for (const mutation of mutations) {
      const size = JSON.stringify(mutation).length;
      if (batch.length === 8 || batched + mutation.operations.length > 16 || characters + size > CALL_CHARACTERS) await send();
      batch.push(mutation);
      batched += mutation.operations.length;
      characters += size;
    }
    await send();

    const validated = await file.client.tool('nendo.change_set.validate', {
      ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID(),
    });
    const diagnostics = validated.diagnostics ?? [];
    if (diagnostics.length > 0 || validated.isValid === false) {
      console.error('\nThe draft did not validate. It stays open.\n');
      for (const diagnostic of diagnostics) console.error(`  ${diagnostic.code ?? ''} ${diagnostic.message ?? JSON.stringify(diagnostic)}`);
      process.exitCode = 1;
      return false;
    }
    if (lease.mode !== 'unattended') {
      console.log(`Validated. ${TARGET_FILE_NAME} is not at Unattended, so accept the proposal in Nendo:\n  ${stage.title}`);
      return false;
    }
    const accepted = await file.client.tool('nendo.change_set.accept', {
      ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID(),
    });
    if (accepted.applied !== true) {
      console.error(`Not applied: ${accepted.state}. ${accepted.message ?? ''}`);
      process.exitCode = 1;
      return false;
    }
    console.log(`Accepted at Unattended: definition revision ${accepted.definitionRevision}.`);
    return true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args.find(value => !value.startsWith('--'));
  if (args.includes('--list')) {
    for (const stage of STAGE_ORDER) console.log(`${stage.padEnd(14)}${STAGES[stage].title}`);
    return;
  }

  const to = await target();
  console.log(`Target          ${to.entry.displayName}  ${to.manifest.applicationId}  ${to.entry.endpoint}`);
  console.log(`Revision        definition ${to.manifest.definitionRevision}, data ${to.manifest.dataRevision}\n`);

  if (name) {
    if (!STAGES[name]) fail(`Unknown stage ${name}. Run with --list.`);
    if (await applied(to, name)) fail(`Stage ${name} is already applied.`);
    await runStage(to, name, dryRun);
    return;
  }
  // No stage named: run every stage not yet applied, in order, stopping at the
  // first that is not accepted here.
  for (const stage of STAGE_ORDER) {
    if (!dryRun && await applied(to, stage)) continue;
    if (!await runStage(to, stage, dryRun)) return;
    console.log('');
  }
  if (!dryRun) console.log('Every stage is applied.');
}

main().catch(error => fail(error.stack ?? String(error)));
