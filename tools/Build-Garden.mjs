// Builds workspace/Garden.nendo into an empty file over MCP alone, one stage per change set,
// as tools/Build-Planner.mjs builds the planner.
//
//   node tools/Build-Garden.mjs                 every stage not yet applied, in order
//   node tools/Build-Garden.mjs <stage>         one named stage
//   node tools/Build-Garden.mjs --list          what the stages are
//   node tools/Build-Garden.mjs --dry-run       say what would be sent, take no lease
//   node tools/Build-Garden.mjs compare         read the built file back and check it
//   node tools/Build-Garden.mjs upgrade         bring a built file's Garden package up to this folder
//   node tools/Build-Garden.mjs upgrade --skip-index   the same without building the search index, for a
//                                               host that cannot take the build in a proposal (1.46.0)
//
// The shape is in tools/garden/definition.mjs and the reasons in docs/design/garden.md. The
// empty file is made by Nendo itself (Nendo.Desktop.exe -new <path>). When the person has set the
// file's Agent access to Unattended the script accepts its own proposal; below it, it prints
// the proposal's title and stops, because acceptance is theirs. A development planner is never
// a target, and the schema stage refuses a file that already holds another application.

import crypto from 'node:crypto';
import { target, withLease, fail } from './archi-mcp.mjs';
import { STAGES, STAGE_ORDER, CALL_CHARACTERS, NEW_FILE_LABEL, SKILL_PACKAGE_ID, PACKAGE_ID, PACKAGE_FOLDER, RETIRED_GRAPH_PACKAGE_ID, FRONT_TITLE, FRONT_DESCRIPTION, seedRecords, packageFiles, hasSearchIndex, skillPackage } from './garden/definition.mjs';

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
  return runChangeSet(file, name, stage.title, mutations, dryRun);
}

async function runChangeSet(file, name, title, mutations, dryRun) {
  const stage = { title };
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
  for (const id of [PACKAGE_ID, SKILL_PACKAGE_ID]) if (!packages.includes(id)) problems.push(`package ${id} is not in the file`);
  const overview = (await file.read.json('nendo://application/surfaces')).overview;
  if (overview?.properties.title !== FRONT_TITLE) problems.push(`the front page is titled ${overview?.properties.title}, not ${FRONT_TITLE}: run upgrade`);
  if (packages.includes(RETIRED_GRAPH_PACKAGE_ID)) problems.push(`${RETIRED_GRAPH_PACKAGE_ID} is still in the file: run upgrade`);
  const garden = (describe.extensions ?? []).find(p => p.packageId === PACKAGE_ID);
  const { manifest: wanted, files: wantedFiles } = await packageFiles(PACKAGE_FOLDER);
  if (garden && garden.version !== wanted.version) problems.push(`the file carries Garden ${garden.version}, the folder ${wanted.version}: run upgrade`);
  const held = new Map((garden?.files ?? []).map(f => [f.path, f.sha256]));
  const differ = wantedFiles.filter(f => held.get(f.path) !== f.sha256).map(f => f.path);
  if (differ.length) problems.push(`the file's Garden package differs from the folder in ${differ.join(', ')}: run upgrade`);
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

/**
 * One change set that brings a built file up to this folder: the Garden package's changed files
 * (each put names the content it replaces, so a newer package is never overwritten), the Graph
 * screen moved onto the Garden package, and the retired Dependency graph package taken out.
 */
async function upgrade(file, dryRun, skipIndex = false) {
  const listing = await file.read.json('nendo://application/extensions');
  const current = listing.find(p => p.packageId === PACKAGE_ID);
  if (!current) fail(`${TARGET_FILE_NAME} does not carry ${PACKAGE_ID}; build it first.`);
  const { manifest, files } = await packageFiles(PACKAGE_FOLDER);
  const op = (operationType, payload) => ({ operationType, payload });
  const operations = [];
  if (current.version !== manifest.version || current.title !== manifest.title || current.description !== manifest.description) {
    operations.push(op('extension.setPackage', { packageId: PACKAGE_ID, title: manifest.title, entryPoint: manifest.entryPoint ?? 'index.html', version: manifest.version, description: manifest.description }));
  }
  const held = new Map(current.files.map(f => [f.path, f.sha256]));
  const partBytes = 70 * 1024;
  for (const f of files) {
    if (held.get(f.path) === f.sha256) continue;
    for (let offset = 0; offset === 0 || offset < f.bytes.length; offset += partBytes) {
      operations.push(op('extension.putFile', { packageId: PACKAGE_ID, path: f.path, base64: f.bytes.subarray(offset, offset + partBytes).toString('base64'),
        ...(offset === 0 ? { expectedSha256: held.get(f.path) ?? 'absent' } : { append: true }) }));
    }
  }
  for (const [path, sha256] of held) if (!files.some(f => f.path === path)) operations.push(op('extension.removeFile', { packageId: PACKAGE_ID, path, expectedSha256: sha256 }));
  // The Garden skill: its SKILL.md and version, when the folder's differ from the file's.
  const heldSkill = listing.find(p => p.packageId === SKILL_PACKAGE_ID);
  if (heldSkill) {
    const { manifest: skillManifest, skill } = await skillPackage(file.manifest.applicationId);
    const heldText = heldSkill.files.find(f => f.path === 'SKILL.md')?.sha256 ?? 'absent';
    const wantedText = crypto.createHash('sha256').update(skill, 'utf8').digest('hex');
    if (heldSkill.version !== skillManifest.version || heldText.toLowerCase() !== wantedText) {
      operations.push(op('extension.setPackage', { packageId: SKILL_PACKAGE_ID, kind: 'skill', title: skillManifest.title, version: skillManifest.version, description: skillManifest.description }));
      if (heldText.toLowerCase() !== wantedText) operations.push(op('extension.putFile', { packageId: SKILL_PACKAGE_ID, path: 'SKILL.md', text: skill, expectedSha256: heldText }));
    }
  }
  const retired = listing.find(p => p.packageId === RETIRED_GRAPH_PACKAGE_ID);
  if (retired) {
    operations.push(op('ui.setProperty', { surfaceId: 'garden', nodeId: 'gd.note.graph', propertyName: 'packageId', value: PACKAGE_ID }));
    for (const f of retired.files) operations.push(op('extension.removeFile', { packageId: RETIRED_GRAPH_PACKAGE_ID, path: f.path, expectedSha256: f.sha256 }));
    operations.push(op('extension.removePackage', { packageId: RETIRED_GRAPH_PACKAGE_ID }));
  }
  // The front page was first titled Garden, the Garden view's own name, so Use listed two.
  const front = (await file.read.json('nendo://application/surfaces')).overview;
  if (front && front.properties.title !== FRONT_TITLE) operations.push(op('ui.setProperty', { surfaceId: 'garden', nodeId: 'gd.front', propertyName: 'title', value: FRONT_TITLE }));
  if (front && front.properties.description !== FRONT_DESCRIPTION) operations.push(op('ui.setProperty', { surfaceId: 'garden', nodeId: 'gd.front', propertyName: 'description', value: FRONT_DESCRIPTION }));
  // Find reads the file's search index (ADR-0028): build it with the upgrade when the file has none,
  // as its own mutation, since it is a definition change with nothing to undo.
  const buildIndex = !skipIndex && !(await hasSearchIndex(file.read));
  if (operations.length === 0 && !buildIndex) { console.log('Nothing to upgrade: the file carries the Garden package in this folder.'); return true; }
  const mutations = [];
  for (const operation of operations) {
    const size = JSON.stringify(operation).length, last = mutations.at(-1);
    if (!last || last.operations.length === 16 || last.size + size > CALL_CHARACTERS) mutations.push({ description: `Bring Garden up to ${manifest.version}`, operations: [], size: 0 });
    mutations.at(-1).operations.push(operation);
    mutations.at(-1).size += size;
  }
  if (buildIndex) mutations.push({ description: 'Build the search index', operations: [op('application.buildSearchIndex', {})], size: 0 });
  return runChangeSet(file, 'upgrade', `Garden: bring the file up to the package ${manifest.version} and its definition`,
    mutations.map(({ description, operations: o }) => ({ description, operations: o })), dryRun);
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
  if (name === 'upgrade') { await upgrade(to, dryRun, args.includes('--skip-index')); return; }
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
