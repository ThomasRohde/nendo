// Writes tools/archi/archisurance.json: Archisurance as Archi.nendo holds it after
// tools/Build-Archi.mjs and tools/Import-Archimate.mjs, one record per entry in the shape
// window.nendo reads ({ entityId, recordId, version, values }). The workbench's tests and its
// review lane read it, so they need neither Nendo nor archi-online. Regenerate it when the
// mapping or the record types change:
//
//   node tools/archi/make-fixture.mjs [file.archimate]
//
// It needs the archi-online checkout beside this one, as the import does.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT_FOLDERS, TYPES, MODEL } from '../archi-definition.mjs';
import { parser, plan } from './archimate-records.mjs';

const source = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online', 'public', 'examples', 'Archisurance.archimate');
const parseArchimate = await parser();
const planned = plan(parseArchimate(await fs.readFile(source, 'utf8')));

const record = (entityId, recordId, values) => ({ entityId, recordId, version: 1, values });
const records = {};
const add = (entityId, entry) => (records[entityId] ??= []).push(entry);
const rootArchiIds = new Map(planned.rootIds.map(({ recordId, archiId }) => [recordId, archiId]));
for (const folder of ROOT_FOLDERS) add('ar.folder', record('ar.folder', folder.recordId, { ...folder.values, 'ar.folder.archiId': rootArchiIds.get(folder.recordId) ?? null }));
for (const type of TYPES) add('ar.type', record('ar.type', type.recordId, type.values));
add('ar.model', record('ar.model', MODEL.recordId, { ...MODEL.values, ...planned.modelValues }));
for (const [entityId, list] of planned.writes) for (const entry of list) add(entityId, record(entityId, entry.recordId, entry.values));
for (const list of Object.values(records)) list.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));

const out = path.join(import.meta.dirname, 'archisurance.json');
await fs.writeFile(out, JSON.stringify({ source: path.basename(source), records }, null, 1) + '\n');
console.log(`${out}: ${Object.entries(records).map(([entityId, list]) => `${list.length} ${entityId}`).join(', ')}`);
