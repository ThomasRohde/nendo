// Builds workspace/Archi.nendo from an empty file over MCP alone (W-107): the ArchiMate 3.2
// metamodel as record types, its screens, and the records every Archi file starts with.
//
//   node tools/Build-Archi.mjs                 every stage not yet applied, then the seed
//   node tools/Build-Archi.mjs <stage>         one named stage, or seed
//   node tools/Build-Archi.mjs --list          what the stages are
//   node tools/Build-Archi.mjs --dry-run       say what would be sent, take no lease
//   node tools/Build-Archi.mjs compare         measure the seeded records against the tables
//
// The shape is in tools/archi-definition.mjs and the reasons in docs/design/archi-in-nendo.md.
// One stage is one change set, validated into a proposal. When the person has set the file's
// Agent access to Unattended the script accepts its own proposal, as Build-Planner.mjs does;
// below it, it prints the proposal's title and stops, because acceptance is theirs.
//
// Make the empty file with Nendo itself: `Nendo.exe -new <path>` is what Explorer's New menu
// sends, so the file is the one New file makes. NENDO_ARCHI_TARGET names another file to build.

import crypto from 'node:crypto';
import { STAGES, STAGE_ORDER, CALL_CHARACTERS, ROOT_FOLDERS, TYPES, MODEL } from './archi-definition.mjs';
import { CONCEPT_TYPES } from './archi-concept-types.mjs';
import { TARGET_FILE_NAME, fail, target, withLease } from './archi-mcp.mjs';

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
  const mutations = await stage.mutations();
  const operations = mutations.reduce((total, mutation) => total + mutation.operations.length, 0);
  for (const mutation of mutations) {
    if (mutation.operations.length > 16) fail(`"${mutation.description}" holds ${mutation.operations.length} operations; a call carries 16.`);
  }
  if (operations > 128) fail(`Stage ${name} holds ${operations} operations; a change set carries 128. Split it.`);
  console.log(`Stage           ${name}: ${stage.title}`);
  console.log(`                ${mutations.length} mutations, ${operations} operations`);
  if (dryRun) return true;

  const present = await file.read.entities();
  const missing = (stage.needs ?? []).filter(id => !present.includes(id));
  if (missing.length > 0) fail(`Stage ${name} needs ${missing.join(', ')}, which an earlier stage makes.`);

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

// The folders, concept types and model record a new Archi file starts with. A type already
// holding its records is left alone; one holding some but not all is refused, not topped up.
async function seed(file, dryRun) {
  const plan = [['ar.folder', ROOT_FOLDERS], ['ar.type', TYPES], ['ar.model', [MODEL]]];
  for (const [entityId, records] of plan) console.log(`${String(records.length).padStart(5)}  ${entityId}`);
  if (dryRun) return;
  await withLease(file.client, async owned => {
    for (const [entityId, records] of plan) {
      const held = await file.read.records(entityId);
      if (held.length >= records.length) { console.log(`    -  ${entityId} already holds ${held.length}; left alone`); continue; }
      if (held.length > 0) fail(`${entityId} holds ${held.length} of ${records.length} seeded records. Start from a new file.`);
      for (let start = 0; start < records.length; start += 50) {
        const slice = records.slice(start, start + 50);
        const key = crypto.createHash('sha256').update(JSON.stringify(slice)).digest('hex').slice(0, 32);
        await file.client.tool('nendo.data.create_records', { ...owned, entityId, records: slice, idempotencyKey: `archi-seed-${key}` });
      }
      console.log(`    +  ${entityId}: ${records.length}`);
    }
  });
}

// Every seeded concept type against the table it came from, field by field.
async function compare(file) {
  const held = new Map((await file.read.records('ar.type')).map(record => [record.values['ar.type.key'], record.values]));
  const problems = [];
  if (held.size !== CONCEPT_TYPES.length) problems.push(`${held.size} concept types, not ${CONCEPT_TYPES.length}`);
  for (const type of CONCEPT_TYPES) {
    const values = held.get(type.key);
    if (!values) { problems.push(`${type.key} is missing`); continue; }
    const expected = { name: type.name, category: type.category, layer: type.layer, fill: type.fill ?? null,
      width: type.width ?? null, height: type.height ?? null, letter: type.letter ?? null };
    for (const [name, value] of Object.entries(expected)) {
      if (values[`ar.type.${name}`] !== value) problems.push(`${type.key}.${name} is ${JSON.stringify(values[`ar.type.${name}`])}, not ${JSON.stringify(value)}`);
    }
  }
  const folders = (await file.read.records('ar.folder')).filter(record => record.values['ar.folder.parent'] === null);
  if (folders.length !== ROOT_FOLDERS.length) problems.push(`${folders.length} top-level folders, not ${ROOT_FOLDERS.length}`);
  const letters = CONCEPT_TYPES.filter(type => type.letter).map(type => type.letter).sort().join('');
  console.log(`${held.size} concept types, ${folders.length} top-level folders; relationship letters ${letters}`);
  if (problems.length > 0) fail(`The seeded records differ from the tables:\n  ${problems.join('\n  ')}`);
  console.log('Every concept type matches its table entry.');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const named = args.filter(arg => !arg.startsWith('--'));

if (args.includes('--list')) {
  for (const name of STAGE_ORDER) console.log(`${name.padEnd(10)} ${STAGES[name].title}`);
  console.log(`${'seed'.padEnd(10)} The top-level folders, the 72 concept types and the model record`);
  console.log(`${'compare'.padEnd(10)} The seeded concept types against their table`);
  process.exit(0);
}

if (dryRun && named.length === 0) {
  for (const name of STAGE_ORDER) await runStage(null, name, true);
  await seed(null, true);
  console.log('Dry run: nothing sent, no lease taken.');
  process.exit(0);
}

const file = await target('nendo-archi-build');
console.log(`Target          ${TARGET_FILE_NAME} (${file.manifest.applicationId})`);
if (named[0] === 'compare') await compare(file);
else if (named[0] === 'seed') await seed(file, dryRun);
else if (named.length > 0) {
  if (!STAGES[named[0]]) fail(`No stage is called ${named[0]}. --list names them.`);
  await runStage(file, named[0], dryRun);
} else {
  for (const name of STAGE_ORDER) {
    if (await applied(file, name)) { console.log(`Stage           ${name}: applied`); continue; }
    if (!await runStage(file, name, dryRun)) process.exit(process.exitCode ?? 0);
  }
  await seed(file, dryRun);
  await compare(file);
}
