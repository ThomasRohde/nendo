// An .archimate model as Archi.nendo's records: archi-online's own parser, bundled for Node, and
// the workbench's mapping from its model onto the record types tools/Build-Archi.mjs makes. Shared by
// tools/Import-Archimate.mjs, which writes the records into a file, and tools/archi/make-fixture.mjs,
// which writes them as the fixture the workbench's tests read.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MODEL, ROOT_FOLDERS, TYPES } from '../archi-definition.mjs';
import { planImport, recordIdOf } from '../../extensions/archi/canvas.js';
import { fail } from '../archi-mcp.mjs';

const ARCHI_ONLINE = path.resolve(process.env.ARCHI_ONLINE ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online'));

export async function parser() {
  const require = createRequire(path.join(ARCHI_ONLINE, 'package.json'));
  let esbuild, jsdom;
  try { esbuild = require('esbuild'); jsdom = require('jsdom'); } catch {
    fail(`The parser comes from archi-online, which was not found with its dependencies at ${ARCHI_ONLINE}. Set ARCHI_ONLINE.`);
  }
  globalThis.DOMParser = new jsdom.JSDOM('').window.DOMParser;
  const outfile = path.join(os.tmpdir(), `archi-parse-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(ARCHI_ONLINE, 'src', 'model', 'io', 'archimate-xml', 'parse.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error',
  });
  try { return (await import(pathToFileURL(outfile).href)).parseArchimate; } finally { await fs.rm(outfile, { force: true }); }
}

export const rid = recordIdOf;
export const present = value => value !== undefined && value !== null && value !== '';

/**
 * The model as rows per record type, in the order they can be written. The mapping is the
 * workbench's own (tools/archi/canvas/io.ts, in canvas.js), so a file the workbench opens and one
 * this importer loads hold the same records.
 */
export function plan(model) {
  const rootFolders = Object.fromEntries(ROOT_FOLDERS.map(folder => [folder.values['ar.folder.kind'], folder.recordId]));
  const planned = planImport(model, { rootFolders, modelRecordId: MODEL.recordId });
  const byEntity = new Map(['ar.folder', 'ar.specialization', 'ar.concept', 'ar.view', 'ar.item', 'ar.property'].map(entityId => [entityId, []]));
  for (const { entityId, recordId, values } of planned.creates) byEntity.get(entityId).push({ recordId, values });
  return {
    images: planned.leftOut.imageObjects,
    writes: [...byEntity],
    modelValues: planned.modelValues,
    rootUpdates: planned.rootUpdates,
  };
}

/**
 * The model as Archi.nendo holds it after tools/Build-Archi.mjs and an import: every record, in
 * the shape window.nendo reads ({ entityId, recordId, version, values }), sorted by ID, with the
 * seeded folders, types and model record. `recordIdOf` turns an archi-online id into the ID of
 * the record that holds it.
 */
export function recordSets(model) {
  const planned = plan(model);
  const record = (entityId, recordId, values) => ({ entityId, recordId, version: 1, values });
  const records = {};
  const add = (entityId, entry) => (records[entityId] ??= []).push(entry);
  const rootValues = new Map(planned.rootUpdates.map(({ recordId, values }) => [recordId, values]));
  for (const folder of ROOT_FOLDERS) add('ar.folder', record('ar.folder', folder.recordId, { ...folder.values, 'ar.folder.archiId': null, ...rootValues.get(folder.recordId) }));
  for (const type of TYPES) add('ar.type', record('ar.type', type.recordId, type.values));
  add('ar.model', record('ar.model', MODEL.recordId, { ...MODEL.values, ...planned.modelValues }));
  for (const [entityId, list] of planned.writes) for (const entry of list) add(entityId, record(entityId, entry.recordId, entry.values));
  for (const list of Object.values(records)) list.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  const roots = new Map(planned.rootUpdates.map(({ recordId, values }) => [values['ar.folder.archiId'], recordId]));
  const recordIdOf = id => (id === model.info.id ? MODEL.recordId : roots.get(id) ?? rid(id));
  return { records, recordIdOf, images: planned.images };
}
