// Brings a running BCM.nendo up to the Capability Atlas of W-080: assessments over time.
//
//   node tools/bcm-atlas/Upgrade-BcmAtlas.mjs schema [--endpoint <url>] [--dry-run] [--accept]
//   node tools/bcm-atlas/Upgrade-BcmAtlas.mjs data   [--endpoint <url>] [--dry-run]
//
// schema  proposes upgrade.mjs's mutations: the Assessment record type and its screens, a unique
//         capability code, both ends of a support link required, and the map's configuration.
//         The person accepts it in Nendo (--accept only at Unattended, as Put-NendoPackage.mjs).
// data    once that is accepted, reads the file's capabilities and imports each current
//         maturity as its first assessment (assessments.mjs: migrated), with the Northstar demo's
//         fictional history (demonstration). The capabilities themselves are not changed, so
//         their maturity and target stay where they were. Needs Agent access at Edit data.
//
// The file is found by its application ID in this device's agent-ports.json (W-089), or named
// with --endpoint. Update the package itself with Put-NendoPackage.mjs extensions/bcm-atlas.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createNendoMcpClient } from '../Nendo-McpClient.mjs';
import { upgradeMutations } from './upgrade.mjs';
import { migrated, demonstration } from './assessments.mjs';

const BCM = 'application-7ee604c2f5df4a9f8dab9ae0079b498e';
const args = process.argv.slice(2);
const phase = args[0];
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dryRun = args.includes('--dry-run'), accept = args.includes('--accept');
const fail = message => { console.error(`\n${message}\n`); process.exit(1); };
if (phase !== 'schema' && phase !== 'data') fail('Say which: node tools/bcm-atlas/Upgrade-BcmAtlas.mjs schema | data');

async function endpoint() {
  if (option('--endpoint')) return option('--endpoint');
  const ports = JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA ?? '', 'Nendo', 'agent-ports.json'), 'utf8')
    .catch(() => fail('This device keeps no agent ports yet. Open BCM.nendo in Nendo, turn on Agent access, or pass --endpoint.')));
  const port = ports.Files?.[BCM]?.Port;
  if (!port) fail('BCM.nendo has no agent port on this device. Open it in Nendo and turn on Agent access, or pass --endpoint.');
  return `http://127.0.0.1:${port}/mcp`;
}

const client = createNendoMcpClient({ endpoint: await endpoint() }, 'nendo-upgrade-bcm-atlas');
const manifest = JSON.parse((await client.rpc('resources/read', { uri: 'nendo://application/manifest' }).catch(() =>
  fail('Nothing answers there. Open BCM.nendo in Nendo with Agent access on.'))).contents[0].text);
if (manifest.applicationId !== BCM && !option('--endpoint')) fail(`That port answers for ${manifest.applicationId}, not BCM.nendo.`);

async function withLease(work) {
  const lease = await client.tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try { return await work(owned); } finally { await client.tool('nendo.lease.release', owned).catch(() => undefined); }
}

if (phase === 'schema') {
  const mutations = upgradeMutations();
  const title = 'Assessments over time for the Capability Atlas (W-080)';
  console.log(`Mutations       ${mutations.length} (${mutations.reduce((sum, m) => sum + m.operations.length, 0)} operations)`);
  if (dryRun) { console.log('Dry run: nothing was sent.'); process.exit(0); }
  await withLease(async owned => {
    const draft = await client.tool('nendo.change_set.begin', { ...owned, title, idempotencyKey: crypto.randomUUID() });
    // One call carries at most 16 operations in all, so each mutation goes in a call of its own.
    for (const mutation of mutations)
      await client.tool('nendo.change_set.add_operations', { ...owned, changeSetId: draft.changeSetId, mutations: [mutation], idempotencyKey: crypto.randomUUID() });
    const validated = await client.tool('nendo.change_set.validate', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    const errors = (validated.diagnostics ?? []).filter(diagnostic => diagnostic.severity !== 'warning');
    if (errors.length > 0) {
      for (const diagnostic of errors) console.error(`  ${diagnostic.code} ${diagnostic.operationId ?? ''} ${diagnostic.message}`);
      fail('The upgrade did not validate. The draft stays open; nothing in the file changed.');
    }
    if (!accept) { console.log(`\nValidated on a clone. In Nendo, review and accept the proposal\n  ${title}`); return; }
    const accepted = await client.tool('nendo.change_set.accept', { ...owned, changeSetId: draft.changeSetId, idempotencyKey: crypto.randomUUID() });
    console.log(accepted.applied ? `Accepted: ${title}` : `Not applied: ${accepted.message}`);
  });
} else {
  const capabilities = [];
  let cursor = null;
  do {
    const uri = `nendo://application/entity/bcm.capability/records?${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ''}limit=100`;
    const page = JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
    capabilities.push(...page.items.map(item => ({ recordId: item.recordId, values: item.values, version: item.recordVersion })));
    cursor = page.nextCursor;
  } while (cursor);
  // A reference is written against its target's version, which the import is refused without.
  const versions = new Map(capabilities.map(capability => [capability.recordId, capability.version]));
  const records = [...migrated(capabilities), ...demonstration(capabilities)].map(record => ({
    ...record, expectedTargetVersions: { 'assess.capability': versions.get(record.values['assess.capability']) },
  }));
  console.log(`Capabilities    ${capabilities.length}\nAssessments     ${records.length} (${migrated(capabilities).length} from current maturity)`);
  if (dryRun) { console.log('Dry run: nothing was sent.'); process.exit(0); }
  await withLease(async owned => {
    for (let start = 0; start < records.length; start += 250) {
      const imported = await client.tool('nendo.data.import_records', {
        ...owned, entityId: 'bcm.assessment', format: 'json', records: records.slice(start, start + 250),
        idempotencyKey: `w080-assessments-${start}`,
      });
      console.log(`Imported        ${start + imported.committed} of ${records.length}`);
    }
  });
}
