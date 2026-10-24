// The shape of Brandkits.nendo as the view and its lane know it. The file was built by hand over
// MCP, so its record types are recorded here as the file held them (file.json, with the Ember & Oak
// example kit), and each later change is a list of operations Put-NendoPackage.mjs sends with the
// package: slides-operations.json gives the Kit its slide choices and their pictures.
//
//   node tools/Put-NendoPackage.mjs extensions/brandkits --endpoint <Brandkits' MCP> --operations tools/brandkits/slides-operations.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FILE = JSON.parse(fs.readFileSync(path.join(here, 'file.json'), 'utf8'));
export const SLIDES_OPERATIONS = JSON.parse(fs.readFileSync(path.join(here, 'slides-operations.json'), 'utf8'));
export const PACKAGE_FOLDER = path.resolve(here, '..', '..', 'extensions', 'brandkits');
export const SKILL_FOLDER = path.join(here, 'skill');
export const EXAMPLE_KIT = FILE.example.kit[0].recordId;

/** What the fixture broker serves the view in tools/Review-Brandkits.ps1: the schema with the slide fields, and the example kit. */
export function fixture({ seeds = true } = {}) {
  const entities = FILE.schema.map(e => ({ entityId: e.entityId, displayName: e.displayName, hierarchy: null, fields: e.fields.map(f => ({
    fieldId: f.fieldId, displayName: f.displayName, storageKind: f.storageKind, required: f.required, presentation: f.presentation, calculated: false,
    choices: (f.options ?? []).map(id => ({ id, displayName: id, retired: false, tone: null })), reference: f.reference, scale: null })) }));
  const kit = entities.find(e => e.entityId === 'kit');
  for (const { payload: p } of SLIDES_OPERATIONS) kit.fields.push({ fieldId: p.fieldId, displayName: p.displayName, storageKind: p.storageKind.toLowerCase(), required: p.required,
    presentation: p.presentation, calculated: false, choices: [], reference: null, scale: null });
  const records = Object.fromEntries(entities.map(e => [e.entityId, []]));
  if (seeds) for (const [entityId, list] of Object.entries(FILE.example)) for (const r of list) records[entityId].push({ entityId, recordId: r.recordId, version: 1, values: r.values, labels: {}, exact: {}, calculated: {} });
  return {
    changeSequence: 1, schema: { entities, commands: [] }, hierarchies: {}, records, commandEffects: {},
    context: { viewId: 'brandkits', kind: 'extensionView', placement: 'screen', title: 'Brandkits', entityId: 'kit', recordId: null,
      bindings: { labelFieldId: null, statusFieldId: null, fields: [], filters: [] }, theme: 'light' },
  };
}
