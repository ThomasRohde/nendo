// Reads a manuscript file Nendo has open, over its MCP endpoint, into a folder: every record of
// the Manuscript types (snapshot.json) and the pictures its blocks show (media/). Reading only:
// no lease is taken and nothing is written to the file (Compare-ManusPaper.ps1).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNendoMcpClient } from '../../Nendo-McpClient.mjs';

const [endpoint, out] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint ?? '') || !out) throw Error('Usage: snapshot.mjs http://127.0.0.1:PORT/mcp <folder>');
const client = createNendoMcpClient({ endpoint }, 'nendo-manuscript-paper-compare');
const read = async uri => JSON.parse((await client.rpc('resources/read', { uri })).contents[0].text);
const snapshot = { records: {} };
for (const entity of ['mn.block', 'mn.profile']) {
  const items = [];
  let cursor = null;
  do {
    const page = await read(`nendo://application/entity/${entity}/records?${cursor ? `cursor=${encodeURIComponent(cursor)}&` : ''}limit=100`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  snapshot.records[entity] = items;
}
await fs.mkdir(path.join(out, 'media'), { recursive: true });
await fs.writeFile(path.join(out, 'snapshot.json'), JSON.stringify(snapshot));
const index = {};
const addresses = new Set(snapshot.records['mn.block'].flatMap(r => [...String(r.values['mn.block.text'] ?? '').matchAll(/media:([0-9a-f]{64})/g)].map(m => m[1])));
for (const sha of addresses) {
  const info = await read(`nendo://application/media/${sha}`);
  const part = (await client.rpc('resources/read', { uri: `nendo://application/media/${sha}?content=true` })).contents[0];
  if (!part.blob) continue;
  const file = `${sha}.${{ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[info.mediaType] ?? 'bin'}`;
  await fs.writeFile(path.join(out, 'media', file), Buffer.from(part.blob, 'base64'));
  index[`media:${sha}`] = { file, mediaType: info.mediaType, width: info.width, height: info.height };
}
await fs.writeFile(path.join(out, 'media', 'index.json'), JSON.stringify(index, null, 1));
console.log(`${snapshot.records['mn.block'].length} blocks, ${Object.keys(index).length} pictures`);
