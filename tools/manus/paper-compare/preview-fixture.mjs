// Writes preview-probe.mjs with a snapshot as the fixture broker's file: the Manuscript schema
// from the lane's fixture, the snapshot's records, and its pictures as data addresses.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../definition.mjs';

const [dir, probeOut, brokerUrl, output, root = ''] = process.argv.slice(2);
const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8'));
const records = Object.fromEntries(Object.entries(snapshot.records).map(([entityId, items]) =>
  [entityId, items.map(r => ({ entityId, recordId: r.recordId, version: r.recordVersion, labels: {}, values: r.values }))]));
// Notes and links play no part in the paper; the broker answers for the types the view reads.
const base = fixture();
const file = { ...base, records: { ...Object.fromEntries(Object.keys(base.records).map(k => [k, []])), ...records } };
const index = JSON.parse(await fs.readFile(path.join(dir, 'media', 'index.json'), 'utf8'));
const media = {};
for (const [address, m] of Object.entries(index)) media[address] = `data:${m.mediaType};base64,${(await fs.readFile(path.join(dir, 'media', m.file))).toString('base64')}`;
let probe = await fs.readFile(path.join(import.meta.dirname, 'preview-probe.mjs'), 'utf8');
probe = probe.replace('__BROKER_URL__', brokerUrl).replace("'__FIXTURE__'", () => JSON.stringify(file)).replace("'__MEDIA__'", () => JSON.stringify(media))
  .replace("'__ROOT__'", () => JSON.stringify(root)).replaceAll('__OUTPUT__', output.replaceAll('\\', '/'));
await fs.writeFile(probeOut, probe);
