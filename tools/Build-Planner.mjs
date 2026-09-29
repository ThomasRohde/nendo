// Builds workspace/Planner.nendo from an empty file over MCP alone, and fills it
// from the development planner it replaced on 2026-09-29, workspace/Nendo.nendo.
// Planner.nendo is the primary planner since then, so migrate and catch-up are
// history: a rebuild from empty would copy the archive, not the live work.
//
//   node tools/Build-Planner.mjs                 the first stage not yet applied
//   node tools/Build-Planner.mjs <stage>         one named stage
//   node tools/Build-Planner.mjs --list          what the stages are
//   node tools/Build-Planner.mjs --dry-run       say what would be sent, take no lease
//   node tools/Build-Planner.mjs migrate         copy every record across
//   node tools/Build-Planner.mjs compare         measure the copy against the source
//   node tools/Build-Planner.mjs catch-up        bring a filled copy up to the source
//
// The shape is in tools/planner-definition.mjs and the reasons in
// docs/design/planner.md. One stage is one change set, validated into a proposal.
// When the person has set Planner.nendo's Agent access to Unattended the script
// accepts its own proposal, as tools/Put-NendoPackage.mjs --accept does; below it,
// it prints the proposal's title and stops, because acceptance is theirs.
//
// The development planner is only ever read. It is found by its application ID,
// and a target with that ID is refused before any lease is taken.
// NENDO_PLANNER_SOURCE_ID exists so that guard can be falsified without writing.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import { STAGES, STAGE_ORDER, CARRY, LEFT_BEHIND, CALL_CHARACTERS } from './planner-definition.mjs';

const SOURCE_APPLICATION_ID =
  process.env.NENDO_PLANNER_SOURCE_ID || 'application-7efd926c073f4be9974be19bbc39ff41';
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
  return entries.filter(entry => /^http:\/\/127\.0\.0\.1:\d+\/mcp\/?$/.test(entry.endpoint ?? ''));
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
  const file = await open(entries[0]);
  if (file.manifest.applicationId === SOURCE_APPLICATION_ID) {
    fail([
      `${TARGET_FILE_NAME} answers with the development planner's application ID, ${SOURCE_APPLICATION_ID}.`,
      'This script only ever reads that file. Nothing was written.',
    ].join('\n'));
  }
  return file;
}

async function source() {
  for (const entry of await running()) {
    const file = await open(entry).catch(() => null);
    if (file?.manifest.applicationId === SOURCE_APPLICATION_ID) return file;
  }
  fail(`The development planner (${SOURCE_APPLICATION_ID}) is not open in Nendo, so there is nothing to read.`);
}

function reader(client) {
  const json = async uri => JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
  return {
    json,
    entities: async () => (await json('nendo://application/entities')).map(entity => entity.entityId),
    schema: entityId => json(`nendo://application/entity/${entityId}/schema`),
    hasNode: async nodeId => (await client.rpc('resources/read', { uri: 'nendo://application/surfaces' }))
      .contents[0].text.includes(`"${nodeId}"`),
    records: async entityId => {
      const items = [];
      let uri = `nendo://application/entity/${entityId}/records?limit=100`;
      for (;;) {
        const page = await json(uri);
        items.push(...page.items);
        if (!page.nextCursor) return items;
        uri = `nendo://application/entity/${entityId}/records?cursor=${page.nextCursor}&limit=100`;
      }
    },
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

// A value as the target should hold it: exact numbers travel as their lexeme, and
// only fields the target type has are carried.
function carried(item, fieldIds, transform) {
  const values = {};
  for (const [fieldId, value] of Object.entries(transform(item.values))) {
    if (!fieldIds.has(fieldId)) continue;
    const lexeme = item.numericLexemes?.[fieldId];
    values[fieldId] = lexeme !== undefined && value !== null ? { $nendoNumber: lexeme } : value;
  }
  return values;
}

async function migrate(from, to, dryRun) {
  const plan = [];
  for (const { entityId, transform } of CARRY) {
    const schema = await to.read.schema(entityId);
    const fieldIds = new Set(schema.fields.map(f => f.fieldId));
    const references = schema.fields.filter(f => f.storageKind === 'reference' && f.reference)
      .map(f => ({ fieldId: f.fieldId, targetEntityId: f.reference.targetEntityId }));
    const items = await from.read.records(entityId);
    const dropped = Object.keys(items[0]?.values ?? {}).filter(id => !fieldIds.has(id));
    const unexplained = dropped.filter(id => !LEFT_BEHIND[id]);
    if (unexplained.length > 0) fail(`${entityId} would lose ${unexplained.join(', ')}, which LEFT_BEHIND does not name.`);
    plan.push({ entityId, transform, fieldIds, references, items });
    console.log(`${String(items.length).padStart(5)}  ${entityId}${dropped.length ? `   (left behind: ${dropped.join(', ')})` : ''}`);
  }
  if (dryRun) {
    console.log('Dry run: nothing written, no lease taken.');
    return;
  }

  await withLease(to.client, async owned => {
    for (const { entityId, transform, fieldIds, references, items } of plan) {
      const held = await to.read.records(entityId);
      if (held.length === items.length) { console.log(`    -  ${entityId} already holds ${held.length}; left alone`); continue; }
      if (held.length > 0) fail(`${entityId} holds ${held.length} of ${items.length} records. Re-run to replay, or start from a new file.`);

      // Reference targets are read now, after the types they point at were written.
      const versions = new Map();
      for (const { targetEntityId } of references) {
        if (versions.has(targetEntityId)) continue;
        versions.set(targetEntityId, new Map((await to.read.records(targetEntityId)).map(r => [r.recordId, r.recordVersion])));
      }
      const records = items.map(item => {
        const values = carried(item, fieldIds, transform);
        const expected = {};
        for (const { fieldId, targetEntityId } of references) {
          const targetId = values[fieldId];
          if (targetId === null || targetId === undefined) continue;
          const version = versions.get(targetEntityId).get(targetId);
          if (version === undefined) fail(`${item.recordId} points at ${targetId}, which is not in ${targetEntityId}.`);
          expected[fieldId] = version;
        }
        return Object.keys(expected).length > 0
          ? { recordId: item.recordId, values, expectedTargetVersions: expected }
          : { recordId: item.recordId, values };
      });

      // 500 rows or 256 KiB per call, whichever comes first; the key is derived from
      // the content so an interrupted run replays rather than duplicates.
      let written = 0;
      let part = [];
      const flush = async () => {
        if (part.length === 0) return;
        const key = crypto.createHash('sha256').update(entityId + JSON.stringify(part)).digest('hex').slice(0, 40);
        const result = await to.client.tool('nendo.data.import_records', {
          ...owned, entityId, format: 'json', records: part, idempotencyKey: `planner-migrate-${key}`,
        });
        written += result.committed ?? part.length;
        part = [];
      };
      for (const record of records) {
        if (part.length === 500 || JSON.stringify(part).length + JSON.stringify(record).length > 180 * 1024) await flush();
        part.push(record);
      }
      await flush();
      console.log(`${String(written).padStart(5)}  ${entityId} written`);
    }
  });
}

// Brings a copy that was filled earlier up to the source, record by record: a record the copy
// lacks is imported, and a carried field that differs is set to the source's value. A record
// only the copy holds, or one already edited in the copy (its version is past the 1 an import
// gives it), is named and left alone: that edit is newer than the source. Each write's idempotency key is derived from
// what it writes, so an interrupted run replays.
async function catchUp(from, to, dryRun) {
  const key = (...parts) => 'planner-catch-up-' + crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
  const plan = [];
  for (const { entityId, transform } of CARRY) {
    const schema = await to.read.schema(entityId);
    const fieldIds = new Set(schema.fields.map(f => f.fieldId));
    const references = new Map(schema.fields.filter(f => f.storageKind === 'reference' && f.reference)
      .map(f => [f.fieldId, f.reference.targetEntityId]));
    const held = new Map((await to.read.records(entityId)).map(r => [r.recordId, r]));
    const missing = [], changed = [];
    for (const item of await from.read.records(entityId)) {
      const values = carried(item, fieldIds, transform);
      const copy = held.get(item.recordId);
      held.delete(item.recordId);
      if (!copy) { missing.push({ recordId: item.recordId, values }); continue; }
      const differs = Object.entries(values).filter(([fieldId, value]) =>
        JSON.stringify(value?.$nendoNumber ?? value ?? null) !== JSON.stringify(copy.numericLexemes?.[fieldId] ?? copy.values[fieldId] ?? null));
      if (differs.length > 0 && copy.recordVersion > 1) {
        console.log(`    !  ${item.recordId} was edited in the copy (version ${copy.recordVersion}); left alone: ${differs.map(([id]) => id).join(', ')}`);
        continue;
      }
      for (const [fieldId, value] of differs) changed.push({ recordId: item.recordId, fieldId, value: value ?? null });
    }
    for (const extra of held.keys()) console.log(`    !  ${entityId} ${extra} is in the copy only; left alone`);
    plan.push({ entityId, references, missing, changed });
    console.log(`${String(missing.length).padStart(5)} new, ${String(changed.length).padStart(4)} fields changed  ${entityId}`);
  }
  if (dryRun) {
    for (const { changed } of plan) for (const c of changed) console.log(`         ${c.recordId} ${c.fieldId} = ${JSON.stringify(c.value).slice(0, 80)}`);
    console.log('Dry run: nothing written, no lease taken.');
    return;
  }

  await withLease(to.client, async owned => {
    const versionOf = async (entityId, recordId) =>
      (await to.read.records(entityId)).find(r => r.recordId === recordId)?.recordVersion;
    for (const { entityId, references, missing, changed } of plan) {
      if (missing.length > 0) {
        // Reference targets are read now, after the types they point at were brought up.
        const targets = new Map();
        for (const targetEntityId of new Set(references.values()))
          targets.set(targetEntityId, new Map((await to.read.records(targetEntityId)).map(r => [r.recordId, r.recordVersion])));
        const records = missing.map(({ recordId, values }) => {
          const expected = {};
          for (const [fieldId, targetEntityId] of references) {
            const targetId = values[fieldId];
            if (targetId === null || targetId === undefined) continue;
            const version = targets.get(targetEntityId).get(targetId);
            if (version === undefined) fail(`${recordId} points at ${targetId}, which is not in ${targetEntityId}.`);
            expected[fieldId] = version;
          }
          return Object.keys(expected).length > 0 ? { recordId, values, expectedTargetVersions: expected } : { recordId, values };
        });
        await to.client.tool('nendo.data.import_records', {
          ...owned, entityId, format: 'json', records, idempotencyKey: key(entityId, records),
        });
        console.log(`${String(records.length).padStart(5)}  ${entityId} imported`);
      }
      for (const { recordId, fieldId, value } of changed) {
        const targetEntityId = references.get(fieldId);
        const expectedTargetRecordVersion = targetEntityId && value !== null ? await versionOf(targetEntityId, value) : null;
        await to.client.tool('nendo.data.set_field', {
          ...owned, entityId, recordId, fieldId, value,
          expectedRecordVersion: await versionOf(entityId, recordId),
          expectedTargetRecordVersion, idempotencyKey: key(recordId, fieldId, value),
        });
      }
      if (changed.length > 0) console.log(`${String(changed.length).padStart(5)}  ${entityId} fields set`);
    }
  });
}

// Measures the copy: every source record under its own ID, every carried field
// equal after the declared transform, nothing extra, every Reference unique.
async function compare(from, to) {
  let problems = 0;
  const report = message => { problems++; if (problems <= 40) console.log(`  ${message}`); };
  for (const { entityId, transform } of CARRY) {
    const fieldIds = new Set((await to.read.schema(entityId)).fields.map(f => f.fieldId));
    const before = await from.read.records(entityId);
    const after = new Map((await to.read.records(entityId)).map(r => [r.recordId, r]));
    let fields = 0;
    for (const item of before) {
      const copy = after.get(item.recordId);
      if (!copy) { report(`${entityId} ${item.recordId} is missing`); continue; }
      after.delete(item.recordId);
      const expected = transform(item.values);
      for (const fieldId of fieldIds) {
        if (!(fieldId in expected)) {
          if (copy.values[fieldId] !== null && copy.values[fieldId] !== undefined) report(`${item.recordId} ${fieldId} is new and set`);
          continue;
        }
        const want = item.numericLexemes?.[fieldId] ?? expected[fieldId] ?? null;
        const have = copy.numericLexemes?.[fieldId] ?? copy.values[fieldId] ?? null;
        fields++;
        if (JSON.stringify(want) !== JSON.stringify(have)) report(`${item.recordId} ${fieldId}: ${JSON.stringify(want)} became ${JSON.stringify(have)}`);
      }
    }
    for (const extra of after.keys()) report(`${entityId} ${extra} is in the copy only`);
    const refField = [...fieldIds].find(id => id.endsWith('.ref'));
    if (refField) {
      const codes = (await to.read.records(entityId)).map(r => String(r.values[refField] ?? '').toUpperCase());
      if (new Set(codes).size !== codes.length) report(`${entityId} holds a Reference twice`);
    }
    console.log(`${String(before.length).padStart(5)}  ${entityId}, ${fields} field values compared`);
  }
  console.log(problems === 0 ? '\nThe copy matches the source.' : `\n${problems} differences.`);
  if (problems > 0) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args.find(value => !value.startsWith('--'));
  if (args.includes('--list')) {
    for (const stage of STAGE_ORDER) console.log(`${stage.padEnd(14)}${STAGES[stage].title}`);
    console.log(`${'migrate'.padEnd(14)}Copy every record from the development planner`);
    console.log(`${'compare'.padEnd(14)}Measure the copy against the development planner`);
    console.log(`${'catch-up'.padEnd(14)}Bring a filled copy up to the development planner`);
    return;
  }

  const to = await target();
  console.log(`Target          ${to.entry.displayName}  ${to.manifest.applicationId}  ${to.entry.endpoint}`);
  console.log(`Revision        definition ${to.manifest.definitionRevision}, data ${to.manifest.dataRevision}\n`);

  if (name === 'migrate' || name === 'compare' || name === 'catch-up') {
    const from = await source();
    console.log(`Source          ${from.entry.displayName}  ${from.manifest.applicationId}  (read only)\n`);
    if (name === 'migrate') await migrate(from, to, dryRun);
    else if (name === 'catch-up') await catchUp(from, to, dryRun);
    else await compare(from, to);
    return;
  }

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
  if (!dryRun) console.log('Every stage is applied. Next: node tools/Build-Planner.mjs migrate');
}

main().catch(error => fail(error.stack ?? String(error)));
