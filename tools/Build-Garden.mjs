// Builds workspace/Garden.nendo into an empty file over MCP alone, one stage per change set,
// as tools/Build-Planner.mjs builds the planner.
//
//   node tools/Build-Garden.mjs                 every stage not yet applied, in order
//   node tools/Build-Garden.mjs <stage>         one named stage
//   node tools/Build-Garden.mjs --list          what the stages are
//   node tools/Build-Garden.mjs --dry-run       say what would be sent, take no lease
//   node tools/Build-Garden.mjs compare         read the built file back and check it
//
// The shape is in tools/garden/definition.mjs and the reasons in docs/design/garden.md. The
// empty file is made by Nendo itself (Nendo.Desktop.exe -new <path>). When the person has set the
// file's Agent access to Unattended the script accepts its own proposal; below it, it prints
// the proposal's title and stops, because acceptance is theirs. A development planner is never
// a target, and the schema stage refuses a file that already holds another application.

import crypto from 'node:crypto';
import { target, withLease, fail } from './archi-mcp.mjs';
import { STAGES, STAGE_ORDER, CALL_CHARACTERS, NEW_FILE_LABEL, SKILL_PACKAGE_ID, PACKAGE_ID, GRAPH_PACKAGE_ID, seedRecords } from './garden/definition.mjs';

const TARGET_FILE_NAME = process.env.NENDO_GARDEN_TARGET || 'Garden.nendo';

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
  if (name === 'schema' && present.length > 0 && !dryRun) fail(`Refused: ${TARGET_FILE_NAME} already holds ${present.join(', ')}. Build only into an empty file.`);

  const mutations = await stage.mutations({ applicationId: file.manifest.applicationId });
  const operations = mutations.reduce((total, mutation) => total + mutation.operations.length, 0);
  for (const mutation of mutations) {
    if (mutation.operations.length > 16) fail(`"${mutation.description}" holds ${mutation.operations.length} operations; a call carries 16.`);
  }
  if (operations > 128) fail(`Stage ${name} holds ${operations} operations; a change set carries 128. Split it.`);
  console.log(`Stage           ${name}: ${stage.title}`);
  console.log(`                ${mutations.length} mutations, ${operations} operations`);
  if (dryRun) { console.log('Dry run: nothing sent, no lease taken.'); return true; }

  return withLease(file.client, async (owned, lease) => {
    const draft = await file.client.tool('nendo.change_set.begin', { ...owned, title: stage.title, idempotencyKey: crypto.randomUUID() });
    let batch = [], batched = 0, characters = 0, lane = null;
    const send = async () => {
      if (batch.length === 0) return;
      await file.client.tool('nendo.change_set.add_operations', { ...owned, changeSetId: draft.changeSetId, mutations: batch, idempotencyKey: crypto.randomUUID() });
      batch = []; batched = 0; characters = 0;
    };
    for (const mutation of mutations) {
      const size = JSON.stringify(mutation).length;
      // Data operations never share a call with definition operations.
      const nextLane = mutation.operations[0].operationType.startsWith('data.') ? 'data' : 'definition';
      if (batch.length === 8 || batched + mutation.operations.length > 16 || characters + size > CALL_CHARACTERS || (lane !== null && lane !== nextLane)) await send();
      lane = nextLane;
      batch.push(mutation); batched += mutation.operations.length; characters += size;
    }
    await send();
    const validated = await file.client.tool('nendo.change_set.validate', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    const diagnostics = (validated.diagnostics ?? []).filter(d => d.severity !== 'warning');
    for (const warning of (validated.diagnostics ?? []).filter(d => d.severity === 'warning')) console.log(`  warning ${warning.code ?? ''} ${warning.message ?? ''}`);
    if (diagnostics.length > 0 || validated.isValid === false || validated.state === 'invalid') {
      console.error('\nThe draft did not validate. It stays open.\n');
      for (const diagnostic of diagnostics) console.error(`  ${diagnostic.code ?? ''} ${diagnostic.message ?? JSON.stringify(diagnostic)}`);
      process.exitCode = 1;
      return false;
    }
    if (lease.mode !== 'unattended') {
      console.log(`Validated. ${TARGET_FILE_NAME} is not at Unattended, so accept the proposal in Nendo:\n  ${stage.title}`);
      return false;
    }
    const accepted = await file.client.tool('nendo.change_set.accept', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    if (accepted.applied !== true) { console.error(`Not applied: ${accepted.state}. ${accepted.message ?? ''}`); process.exitCode = 1; return false; }
    console.log(`Accepted at Unattended: definition revision ${accepted.definitionRevision}.`);
    return true;
  });
}

/** Reads the built file back: every stage applied, the seeds kept, the calculations alive. */
async function compare(file) {
  const problems = [];
  for (const stage of STAGE_ORDER) if (!await applied(file, stage)) problems.push(`stage ${stage} is not applied`);
  const describe = await file.read.json('nendo://application/describe?include=manifest,entities,extensions');
  if (describe.manifest.newFileLabel !== NEW_FILE_LABEL) problems.push(`new-file label is ${describe.manifest.newFileLabel}, not ${NEW_FILE_LABEL}`);
  const packages = (describe.extensions ?? []).map(p => p.packageId);
  for (const id of [PACKAGE_ID, GRAPH_PACKAGE_ID, SKILL_PACKAGE_ID]) if (!packages.includes(id)) problems.push(`package ${id} is not in the file`);
  const full = await file.read.json('nendo://application/describe?include=newFile');
  const kept = (full.newFile?.types ?? []).reduce((n, t) => n + (t.kept ?? 0), 0);
  const seeds = seedRecords().length;
  if (kept !== seeds) problems.push(`a new garden would keep ${kept} records, not the ${seeds} seeds (newFile: ${JSON.stringify(full.newFile)})`);
  if ((full.newFile?.conflictCount ?? 0) !== 0) problems.push(`newFile has ${full.newFile.conflictCount} conflicts`);
  const start = await file.read.json(`nendo://application/entity/gd.note/records?recordId=gd.note.start-here`);
  const record = start.items?.[0] ?? start;
  const calculation = (record?.calculations ?? []).find(c => c.fieldId === 'gd.note.linksIn');
  const linksIn = calculation?.state === 'value' ? calculation.value : null;
  if (!(linksIn > 0)) problems.push(`start-here has no backlinks (${JSON.stringify(record?.calculations ?? start).slice(0, 300)})`);
  if (problems.length) { console.error(`Compare failed:\n  ${problems.join('\n  ')}`); process.exitCode = 1; return; }
  console.log(`Compare passed: ${STAGE_ORDER.length} stages applied, ${packages.length} packages, ${kept} kept seed records, start-here has ${linksIn} backlinks.`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args.find(value => !value.startsWith('--'));
  if (args.includes('--list')) { for (const stage of STAGE_ORDER) console.log(`${stage.padEnd(12)}${STAGES[stage].title}`); return; }
  const to = await target('nendo-garden-build', TARGET_FILE_NAME);
  console.log(`Target          ${to.entry.displayName}  ${to.manifest.applicationId}  ${to.entry.endpoint}`);
  console.log(`Revision        definition ${to.manifest.definitionRevision}, data ${to.manifest.dataRevision}\n`);
  if (name === 'compare') { await compare(to); return; }
  if (name) {
    if (!STAGES[name]) fail(`Unknown stage ${name}. Run with --list.`);
    if (await applied(to, name)) fail(`Stage ${name} is already applied.`);
    await runStage(to, name, dryRun);
    return;
  }
  for (const stage of STAGE_ORDER) {
    if (!dryRun && await applied(to, stage)) continue;
    if (!await runStage(to, stage, dryRun)) return;
    console.log('');
  }
  if (!dryRun) console.log('Every stage is applied. Run: node tools/Build-Garden.mjs compare');
}

main().catch(error => fail(error.stack ?? String(error)));
