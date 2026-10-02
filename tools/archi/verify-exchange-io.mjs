// W-121: the workbench opens and saves Open Exchange XML with archi-online's semantics, and its
// export is what Archi 5.9's schemas and Desktop Archi accept.
//
// - archi-online's exchange fixtures (exchange-sample1.xml, exchange-bendpoint.xml) and an
//   exchange export Desktop Archi makes of Archisurance are each opened as the workbench opens
//   them (canvas.js: readModelFile, planImport, importBatches) into an empty Archi.nendo, saved
//   back as .archimate, and compared with archi-online's own reading of the same Exchange file
//   by archi-online's Phase 2 semantics (tools/phase2-semantics.mjs).
// - Archisurance, saved from its records as the workbench saves it (exportExchange), validates
//   against Archi 5.9's five schemas (xsd.js, libxml2), and Desktop Archi imports it as
//   archi-online does: both readings of that one file compared the same way.
//
//   node tools/archi/verify-exchange-io.mjs                  with Desktop Archi
//   node tools/archi/verify-exchange-io.mjs --skip-desktop   without it
//
// It needs the archi-online checkout beside this one (ARCHI_ONLINE names another) for its
// fixtures, jsdom and the semantics, and Desktop Archi 5.9 (ARCHI_HOME, default C:\Program Files\Archi).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT_FOLDERS, TYPES } from '../archi-definition.mjs';

const ARCHI_ONLINE = path.resolve(process.env.ARCHI_ONLINE ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online'));
const ARCHI_HOME = process.env.ARCHI_HOME ?? 'C:\\Program Files\\Archi';
const skipDesktop = process.argv.includes('--skip-desktop');
const require = createRequire(path.join(ARCHI_ONLINE, 'package.json'));
globalThis.DOMParser = new (require('jsdom').JSDOM)('').window.DOMParser;
const canvas = await import('../../extensions/archi/canvas.js');
const xsd = await import('../../extensions/archi/xsd.js');
const { canonicalizePhase2Model, comparePhase2Semantics } = await import(pathToFileURL(path.join(ARCHI_ONLINE, 'tools', 'phase2-semantics.mjs')).href);

/** A new Archi model's records: the concept types, the nine folders and an empty Model record. */
function emptyFile() {
  return {
    'ar.type': TYPES.map(type => ({ entityId: 'ar.type', recordId: type.recordId, version: 1, values: type.values })),
    'ar.folder': ROOT_FOLDERS.map(folder => ({ entityId: 'ar.folder', recordId: folder.recordId, version: 1, values: { ...folder.values } })),
    'ar.model': [{ entityId: 'ar.model', recordId: 'ar.model.r.new', version: 1, values: { 'ar.model.name': 'New model' } }],
  };
}

/** The writes applied as the host would: a create at version 1, an update merged and moved on. */
function apply(sets, batches) {
  const byKey = new Map();
  for (const [entityId, list] of Object.entries(sets)) for (const record of list) byKey.set(`${entityId} ${record.recordId}`, record);
  for (const write of batches.flat()) {
    const key = `${write.entityId} ${write.recordId}`;
    if (write.op === 'create') {
      if (byKey.has(key)) throw new Error(`${key} was made twice.`);
      const record = { entityId: write.entityId, recordId: write.recordId, version: 1, values: { ...write.values } };
      byKey.set(key, record);
      (sets[write.entityId] ??= []).push(record);
    } else {
      const record = byKey.get(key);
      if (!record || record.version !== write.version) throw new Error(`${key} was updated over version ${write.version}, not ${record?.version}.`);
      Object.assign(record.values, write.values);
      record.version += 1;
    }
  }
  return sets;
}

/**
 * A model opened as the workbench opens it, into an empty file; the records that came of it. The
 * model is the one parse of the file the reference is made from too: archi-online gives an object
 * the file names no identifier for a new random one, so two parses never agree on those.
 */
function openAsWorkbench(model, leftOut) {
  const sets = emptyFile();
  const plan = canvas.planImport(model, {
    rootFolders: Object.fromEntries(ROOT_FOLDERS.map(folder => [folder.values['ar.folder.kind'], folder.recordId])),
    modelRecordId: 'ar.model.r.new',
  }, leftOut);
  const batches = canvas.importBatches(plan, sets, 200);
  apply(sets, batches);
  return { sets, plan, batches };
}

/**
 * archi-online's own handling of a model it read: saved as .archimate and read back, as archi-online
 * opens an Exchange file and saves it. Both sides of every comparison go through that save, so a
 * font held as a style object on one side and as Archi's string on the other is not a difference.
 */
const asArchiOnlineSaves = model => canvas.parseArchimateText(canvas.serializeArchimate(model));

/** The kinds of difference two readings have, without the index each was found at: `$.nodes[].textAlignment: undefined != 1`. */
function kindsOf(expected, actual) {
  return new Set(comparePhase2Semantics(canonicalizePhase2Model(expected), canonicalizePhase2Model(actual)).map(line => line.replace(/\[\d+\]/g, '[]')));
}

/** One Exchange file read by archi-online (saved as .archimate, as it saves one) and by Desktop Archi, as two models to compare. */
async function bothReadings(xml, name) {
  const source = path.join(work, `${name}.xml`), target = path.join(work, `${name}.archimate`);
  await fs.writeFile(source, xml, 'utf8');
  desktop(['--xmlexchange.import', source, '--saveModel', target]);
  const reference = withParsedFonts(asArchiOnlineSaves(canvas.readExchange(new TextEncoder().encode(xml)).model));
  return { reference, desktop: alignToReference(reference, canvas.readArchimate(new Uint8Array(await fs.readFile(target))).model) };
}

function compare(label, expected, actual) {
  const differences = comparePhase2Semantics(canonicalizePhase2Model(expected), canonicalizePhase2Model(actual));
  return differences.length === 0 ? null : `${label}: ${differences.length} differences\n    ${differences.slice(0, process.argv.includes('--all') ? differences.length : 12).join('\n    ')}`;
}


/**
 * Two importers of one Exchange file agree on what each object is, not on every name for it. Desktop
 * Archi and archi-online keep the identifier the file gives each element, relationship, view and
 * box, but each names the folders of the organization, and a connection the file gives no usable
 * identifier, itself. Those are matched by what they are (a folder by its path, a connection by its
 * view and ends) and named as the reference names them. Desktop writes a font as SWT's whole
 * description where archi-online writes Archi's short one; the font is compared as both parse it.
 */
function alignToReference(reference, other) {
  const rename = new Map();
  const folderPath = (model, id) => { const folder = model.folders[id]; return folder ? `${folderPath(model, folder.parentId)}/${folder.folderType ?? ''}:${folder.name}` : ''; };
  const byPath = new Map(Object.keys(reference.folders).map(id => [folderPath(reference, id), id]));
  for (const id of Object.keys(other.folders)) { const match = byPath.get(folderPath(other, id)); if (match && match !== id) rename.set(id, match); }
  const ends = connection => `${connection.viewId}|${connection.sourceId}|${connection.targetId}|${connection.relationshipId ?? ''}`;
  const byEnds = new Map(Object.values(reference.connections).map(connection => [ends(connection), connection.id]));
  const added = [];
  for (const connection of Object.values(other.connections)) {
    if (reference.connections[connection.id]) continue;
    const match = byEnds.get(ends(connection));
    if (match) rename.set(connection.id, match); else added.push(connection.id);
  }
  let text = JSON.stringify(other);
  for (const [from, to] of rename) text = text.split(`"${from}"`).join(`"${to}"`);
  const aligned = withParsedFonts(JSON.parse(text));
  // A connection the reference does not have at all is one archi-online's reader adds for a nesting
  // the file draws no line for. It has a random identifier and shifts every comparison after it, so
  // it is taken out and counted: alignToReference.added says how many.
  for (const id of added) delete aligned.connections[id];
  for (const item of [...Object.values(aligned.nodes), ...Object.values(aligned.connections)]) {
    if (item.sourceConnectionIds) item.sourceConnectionIds = item.sourceConnectionIds.filter(id => !added.includes(id));
    if (item.targetConnectionIds) item.targetConnectionIds = item.targetConnectionIds.filter(id => !added.includes(id));
  }
  alignToReference.added = added.length;
  return aligned;
}
function asExchangeIds(model) {
  const ids = [model.info.id, ...['folders', 'elements', 'relationships', 'views', 'nodes', 'connections', 'profiles'].flatMap(key => Object.keys(model[key]))];
  let text = JSON.stringify(model);
  for (const id of ids.filter(id => /^\d/.test(id))) text = text.split(`"${id}"`).join(`"id-${id}"`);
  return JSON.parse(text);
}
function withParsedFonts(model) {
  for (const item of [...Object.values(model.nodes), ...Object.values(model.connections)]) if (item.fontStyle) delete item.font;
  return model;
}

function desktop(args) {
  execFileSync(path.join(ARCHI_HOME, 'Archi.exe'), ['-application', 'com.archimatetool.commandline.app', '-consoleLog', '-nosplash', ...args],
    { stdio: 'pipe', timeout: 180_000 });
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'exchange-io-'));
const problems = [];
const lines = [];
try {
  const sources = [
    ['exchange-sample1.xml', await fs.readFile(path.join(ARCHI_ONLINE, 'tests', 'fixtures', 'exchange-sample1.xml'), 'utf8')],
    ['exchange-bendpoint.xml', await fs.readFile(path.join(ARCHI_ONLINE, 'tests', 'fixtures', 'exchange-bendpoint.xml'), 'utf8')],
  ];
  if (!skipDesktop) {
    // Desktop Archi's own export of Archisurance, with its folders, as a third Exchange file.
    const exported = path.join(work, 'desktop-archisurance.xml');
    desktop(['--loadModel', path.join(ARCHI_ONLINE, 'tests', 'fixtures', 'Archisurance.archimate'), '--xmlexchange.export', exported, '--xmlexchange.exportFolders']);
    sources.push(['Archisurance exported by Desktop Archi', await fs.readFile(exported, 'utf8')]);
  }
  for (const [name, xml] of sources) {
    const read = canvas.readModelFile(new TextEncoder().encode(xml));
    if (read.format !== 'exchange') problems.push(`${name} was not taken for Open Exchange XML.`);
    const opened = openAsWorkbench(read.model, read.leftOut);
    const saved = canvas.exportArchimate(opened.sets);
    const ours = compare(`${name}, opened by the workbench`, asArchiOnlineSaves(read.model), canvas.parseArchimateText(saved.xml));
    if (ours) problems.push(ours);
    const counts = opened.plan.counts;
    lines.push(`${ours ? 'DIFF' : 'ok  '} ${name}: ${counts.elements} elements, ${counts.relationships} relationships, ${counts.views} views, ` +
      `${opened.plan.creates.length} records in ${opened.batches.length} ${opened.batches.length === 1 ? 'save' : 'saves'}`);
  }

  // Archisurance as the workbench saves it, from its records.
  const { records } = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'archisurance.json'), 'utf8'));
  const exported = canvas.exportExchange(records);
  const invalid = await xsd.validateExchangeXml(exported.xml);
  if (invalid.length > 0) problems.push(`The workbench's Exchange XML of Archisurance does not validate: ${invalid.slice(0, 3).map(problem => problem.message).join(' | ')}`);
  let desktopReading = 'not run', tripReading = 'not run';
  if (!skipDesktop) {
    // Desktop Archi and archi-online do not read every Exchange file alike: each fills in some of
    // Archi's defaults the other leaves unsaid. What they disagree on over Desktop's own export of
    // Archisurance is the calibration; over the workbench's export they may disagree on those
    // things and nothing else, so Desktop reads the workbench's file as it reads its own.
    const own = await bothReadings(sources.at(-1)[1], 'desktop-own');
    const calibration = kindsOf(own.reference, own.desktop);
    const ours = await bothReadings(exported.xml, 'workbench');
    const found = kindsOf(ours.reference, ours.desktop);
    const beyond = [...found].filter(kind => !calibration.has(kind));
    if (beyond.length > 0) problems.push(`Desktop Archi reads the workbench's Exchange XML of Archisurance otherwise than archi-online does, beyond how the two read Desktop's own export:\n    ${beyond.slice(0, 20).join('\n    ')}`);
    desktopReading = beyond.length > 0 ? 'differs' : `same, apart from ${found.size} kinds of difference the two importers have over Desktop's own export too (${[...calibration].join('; ') || 'none'})`;
  }

  // What the trip through Exchange XML loses. The format does not carry everything an .archimate
  // does; archi-online's own export of Archisurance, read back by archi-online, is the measure of
  // what it loses. The workbench's export, from the records, may lose that and nothing more: what
  // it adds is the records, and the records hold Archisurance whole (verify-archimate-io.mjs).
  // An Exchange identifier is an XML name, so an Archi ID that starts with a digit travels as
  // id-<ID> (archi-online's mapping.ts, as Archi does); the original is named so before comparing.
  const archisurance = canvas.readArchimate(new Uint8Array(await fs.readFile(path.join(ARCHI_ONLINE, 'tests', 'fixtures', 'Archisurance.archimate')))).model;
  const reference = withParsedFonts(asArchiOnlineSaves(asExchangeIds(archisurance)));
  const readBack = xml => withParsedFonts(asArchiOnlineSaves(canvas.readExchange(new TextEncoder().encode(xml)).model));
  const onlineLoses = kindsOf(reference, alignToReference(reference,
    readBack(canvas.serializeExchange(archisurance, { includeOrganization: true, metadata: archisurance.info.metadata }))));
  const workbenchLoses = kindsOf(reference, alignToReference(reference, readBack(exported.xml)));
  const lost = [...workbenchLoses].filter(kind => !onlineLoses.has(kind));
  if (lost.length > 0) problems.push(`Archisurance saved as Exchange XML by the workbench and opened again loses more than archi-online's own export of it:\n    ${lost.slice(0, 20).join('\n    ')}`);
  tripReading = lost.length > 0 ? 'loses more' : `loses only what archi-online's own export loses (${onlineLoses.size} kinds: ${[...onlineLoses].slice(0, 6).join('; ')}${onlineLoses.size > 6 ? '; …' : ''})`;
  lines.push(`${invalid.length || desktopReading === 'differs' || tripReading === 'loses more' ? 'DIFF' : 'ok  '} Archisurance saved as Exchange XML: ${exported.xml.length} bytes, ` +
    `${invalid.length === 0 ? 'valid against Archi 5.9’s schemas' : `${invalid.length} schema problems`}; Desktop Archi imports it as archi-online does: ${desktopReading}; ` +
    `opened again it ${tripReading}`);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
for (const line of lines) console.log(line);
if (problems.length > 0) {
  console.error(`\n${problems.join('\n\n')}`);
  process.exit(1);
}
console.log(`Every Exchange file opens as archi-online reads it, and the workbench's export validates${skipDesktop ? '' : ' and Desktop Archi reads it as archi-online does'}.`);
