// Builds a Deck file (workspace/Deck.nendo) into an empty file over MCP alone, one stage per change
// set, as tools/Build-Garden.mjs builds Garden.nendo.
//
//   node tools/Build-Deck.mjs                 every stage not yet applied, in order
//   node tools/Build-Deck.mjs <stage>         one named stage
//   node tools/Build-Deck.mjs --list          what the stages are
//   node tools/Build-Deck.mjs --dry-run       say what would be sent, take no lease
//   node tools/Build-Deck.mjs compare         read the built file back and check it
//   node tools/Build-Deck.mjs upgrade         bring a built file's Deck package and skill up to this folder
//
// The shape is in tools/deck/definition.mjs and the reasons in extensions/deck/README.md. The empty
// file is made by Nendo itself. When the person has set the file's Agent access to Unattended the
// script accepts its own proposal; below it, it prints the proposal's title and stops, because
// acceptance is theirs. A development planner is never a target, and the schema stage refuses a
// file that already holds another application.

import crypto from 'node:crypto';
import { target, withLease, fail } from './archi-mcp.mjs';
import { STAGES, STAGE_ORDER, CALL_CHARACTERS, NEW_FILE_LABEL, PACKAGE_ID, PACKAGE_FOLDER, SKILL_PACKAGE_ID, VIEW_NODE, EXAMPLE_ID, seedRecords, packageFiles, fileMutations, skillPackage, newFileProblems } from './deck/definition.mjs';
import { E } from '../extensions/deck/model.mjs';

const TARGET_FILE_NAME = process.env.NENDO_DECK_TARGET || 'Deck.nendo';

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
  const mutations = await stage.mutations({ applicationId: file.manifest.applicationId, read: file.read });
  if (mutations.length === 0) { console.log(`Stage           ${name}: nothing to send.`); return true; }
  return runChangeSet(file, name, stage.title, mutations, dryRun);
}

async function runChangeSet(file, name, title, mutations, dryRun) {
  const operations = mutations.reduce((total, mutation) => total + mutation.operations.length, 0);
  for (const mutation of mutations) {
    if (mutation.operations.length > 16) fail(`"${mutation.description}" holds ${mutation.operations.length} operations; a call carries 16.`);
  }
  if (operations > 128) fail(`Stage ${name} holds ${operations} operations; a change set carries 128. Split it.`);
  console.log(`Stage           ${name}: ${title}`);
  console.log(`                ${mutations.length} mutations, ${operations} operations`);
  if (dryRun) { console.log('Dry run: nothing sent, no lease taken.'); return true; }

  return withLease(file.client, async (owned, lease) => {
    const draft = await file.client.tool('nendo.change_set.begin', { ...owned, title, idempotencyKey: crypto.randomUUID() });
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
      console.log(`Validated. ${TARGET_FILE_NAME} is not at Unattended, so accept the proposal in Nendo:\n  ${title}`);
      return false;
    }
    const accepted = await file.client.tool('nendo.change_set.accept', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    if (accepted.applied !== true) { console.error(`Not applied: ${accepted.state}. ${accepted.message ?? ''}`); process.exitCode = 1; return false; }
    console.log(`Accepted at Unattended: definition revision ${accepted.definitionRevision}.`);
    return true;
  });
}

/** Reads the built file back: every stage applied, the package and skill current, the seeds kept. */
async function compare(file) {
  const problems = [];
  for (const stage of STAGE_ORDER) if (!await applied(file, stage)) problems.push(`stage ${stage} is not applied`);
  const describe = await file.read.json('nendo://application/describe?include=manifest,entities,extensions');
  if (describe.manifest.newFileLabel !== NEW_FILE_LABEL) problems.push(`new-file label is ${describe.manifest.newFileLabel}, not ${NEW_FILE_LABEL}`);
  const packages = describe.extensions ?? [];
  for (const id of [PACKAGE_ID, SKILL_PACKAGE_ID]) if (!packages.some(p => p.packageId === id)) problems.push(`package ${id} is not in the file`);
  if (!await file.read.hasNode(VIEW_NODE)) problems.push(`the file has no Deck view (${VIEW_NODE})`);
  const held = packages.find(p => p.packageId === PACKAGE_ID);
  const { manifest, files } = await packageFiles(PACKAGE_FOLDER);
  if (held && held.version !== manifest.version) problems.push(`the file carries Deck ${held.version}, the folder ${manifest.version}: run upgrade`);
  const sums = new Map((held?.files ?? []).map(f => [f.path, f.sha256?.toLowerCase()]));
  const differ = files.filter(f => sums.get(f.path) !== f.sha256).map(f => f.path);
  if (held && differ.length) problems.push(`the file's Deck package differs from the folder in ${differ.join(', ')}: run upgrade`);
  const full = await file.read.json('nendo://application/describe?include=newFile');
  const kept = (full.newFile?.types ?? []).reduce((n, t) => n + (t.kept ?? 0), 0);
  if (kept !== seedRecords().length) problems.push(`a new file would keep ${kept} records, not the ${seedRecords().length} seeds`);
  problems.push(...newFileProblems(full.newFile));
  const slides = (await file.read.records(E.slide)).filter(s => s.values['dk.slide.deck'] === EXAMPLE_ID);
  if (slides.length !== seedRecords().filter(r => r.entityId === E.slide).length) problems.push(`the example deck has ${slides.length} slides`);
  if (problems.length) { console.error(`Compare failed:\n  ${problems.join('\n  ')}`); process.exitCode = 1; return; }
  console.log(`Compare passed: ${STAGE_ORDER.length} stages applied, Deck ${manifest.version} and its skill current, ${kept} kept seed records, ${slides.length} example slides.`);
}

/** One change set that brings a built file's Deck package and skill up to this folder. */
async function upgrade(file, dryRun) {
  const listing = await file.read.json('nendo://application/extensions');
  const current = listing.find(p => p.packageId === PACKAGE_ID);
  if (!current) fail(`${TARGET_FILE_NAME} does not carry ${PACKAGE_ID}; build it first.`);
  const { manifest, files } = await packageFiles(PACKAGE_FOLDER);
  const op = (operationType, payload) => ({ operationType, payload });
  const operations = [];
  if (current.version !== manifest.version || current.title !== manifest.title || current.description !== manifest.description) {
    operations.push(op('extension.setPackage', { packageId: PACKAGE_ID, title: manifest.title, entryPoint: manifest.entryPoint ?? 'index.html', version: manifest.version, description: manifest.description }));
  }
  const held = new Map(current.files.map(f => [f.path, f.sha256.toLowerCase()]));
  const changed = files.filter(f => held.get(f.path) !== f.sha256);
  const mutations = changed.length || operations.length ? fileMutations(changed, PACKAGE_ID, `Bring Deck up to ${manifest.version}`, operations, held) : [];
  const removed = [...held].filter(([p]) => !files.some(f => f.path === p)).map(([p, sha256]) => op('extension.removeFile', { packageId: PACKAGE_ID, path: p, expectedSha256: sha256 }));
  for (let i = 0; i < removed.length; i += 16) mutations.push({ description: 'Take out files the folder no longer has', operations: removed.slice(i, i + 16) });
  const heldSkill = listing.find(p => p.packageId === SKILL_PACKAGE_ID);
  if (heldSkill) {
    const { manifest: skillManifest, skill } = await skillPackage();
    const heldText = heldSkill.files.find(f => f.path === 'SKILL.md')?.sha256?.toLowerCase() ?? 'absent';
    const wantedText = crypto.createHash('sha256').update(skill, 'utf8').digest('hex');
    if (heldSkill.version !== skillManifest.version || heldText !== wantedText) {
      const skillOps = [op('extension.setPackage', { packageId: SKILL_PACKAGE_ID, kind: 'skill', title: skillManifest.title, version: skillManifest.version, description: skillManifest.description })];
      if (heldText !== wantedText) skillOps.push(op('extension.putFile', { packageId: SKILL_PACKAGE_ID, path: 'SKILL.md', text: skill, expectedSha256: heldText }));
      mutations.push({ description: 'Bring the Deck skill up to this folder', operations: skillOps });
    }
  }
  if (mutations.length === 0) { console.log('Nothing to upgrade: the file carries the Deck package and skill in this folder.'); return true; }
  return runChangeSet(file, 'upgrade', `Deck: bring the file up to the package ${manifest.version}`, mutations, dryRun);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args.find(value => !value.startsWith('--'));
  if (args.includes('--list')) { for (const stage of STAGE_ORDER) console.log(`${stage.padEnd(12)}${STAGES[stage].title}`); return; }
  const to = await target('nendo-deck-build', TARGET_FILE_NAME);
  console.log(`Target          ${to.entry.displayName}  ${to.manifest.applicationId}  ${to.entry.endpoint}`);
  console.log(`Revision        definition ${to.manifest.definitionRevision}, data ${to.manifest.dataRevision}\n`);
  if (name === 'compare') { await compare(to); return; }
  if (name === 'upgrade') { await upgrade(to, dryRun); return; }
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
  if (!dryRun) console.log('Every stage is applied. Run: node tools/Build-Deck.mjs compare');
}

main().catch(error => fail(error.stack ?? String(error)));
