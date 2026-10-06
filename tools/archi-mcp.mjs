// Finding Archi.nendo among the running Nendo windows, reading it and holding its lease: what
// tools/Build-Archi.mjs and tools/Import-Archimate.mjs share. Identity is read from the file
// itself, never trusted to the discovery entry, and a development planner is never a target.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient, isRunning } from './Nendo-McpClient.mjs';

export const TARGET_FILE_NAME = process.env.NENDO_ARCHI_TARGET || 'Archi.nendo';
const PLANNER_APPLICATION_IDS = ['application-5c52097771f342d5a648fcb514318e7c', 'application-7efd926c073f4be9974be19bbc39ff41'];

export function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function running() {
  // NENDO_MCP_DISCOVERY names a host's own discovery folder: one started with a device-state root of
  // its own (NENDO_DEVICE_STATE_ROOT) lists itself there rather than in the person's.
  const root = process.env.NENDO_MCP_DISCOVERY || path.join(process.env.LOCALAPPDATA ?? '', 'Nendo', 'Mcp', 'active');
  let names = [];
  try { names = (await fs.readdir(root)).filter(name => name.endsWith('.json')); } catch { /* none */ }
  const entries = [];
  for (const name of names) {
    try { entries.push(JSON.parse(await fs.readFile(path.join(root, name), 'utf8'))); } catch { /* half-written */ }
  }
  return entries.filter(entry => /^http:\/\/127\.0\.0\.1:\d+\/mcp\/?$/.test(entry.endpoint ?? '') && isRunning(entry));
}

/** The running Nendo that has `fileName` open (Archi.nendo unless said otherwise), never a planner. */
export async function target(clientName, fileName = TARGET_FILE_NAME) {
  const entries = (await running()).filter(entry => entry.displayName === fileName);
  if (entries.length === 0) fail(`No Nendo has ${fileName} open with Agent access on. Open it, turn Agent access on, and run this again.`);
  if (entries.length > 1) fail(`More than one Nendo has a file named ${fileName} open. Close all but one.`);
  const client = createNendoMcpClient(entries[0], clientName);
  const manifest = JSON.parse((await client.rpc('resources/read', { uri: 'nendo://application/manifest' })).contents[0].text);
  if (PLANNER_APPLICATION_IDS.includes(manifest.applicationId)) {
    fail(`${fileName} answers with a development planner's application ID. Nothing was written.`);
  }
  return { entry: entries[0], client, manifest, read: reader(client) };
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

export async function withLease(client, work) {
  const lease = await client.tool('nendo.lease.acquire');
  const owned = { applicationHandle: lease.applicationHandle, leaseId: lease.leaseId };
  try {
    return await work(owned, lease);
  } finally {
    await client.tool('nendo.lease.release', owned).catch(() => { /* the person may have revoked it */ });
  }
}
