// W-120: the workbench opens and saves .archimate files with archi-online's semantics. For
// Archisurance and each of archi-online's phase fixtures, this reads the file as archi-online
// does, opens it into an empty Archi.nendo as the workbench does (canvas.js: readArchimate,
// planImport, importBatches), saves the records back (exportArchimate), and compares archi-online's
// own reading of that save with its reading of the original, by archi-online's Phase 2 semantics
// (tools/phase2-semantics.mjs: ids, order, attributes and Archi 5.9's defaults). Images are left
// out on purpose (F-208), so they are taken out of the original before comparing, and named.
// Then Desktop Archi opens each save and saves it again, and its save is compared the same way.
//
//   node tools/archi/verify-archimate-io.mjs                 every fixture, with Desktop Archi
//   node tools/archi/verify-archimate-io.mjs --skip-desktop  without Desktop Archi
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
const { canonicalizePhase2Model, comparePhase2Semantics } = await import(pathToFileURL(path.join(ARCHI_ONLINE, 'tools', 'phase2-semantics.mjs')).href);

const FIXTURES = [
  'tests/fixtures/Archisurance.archimate',
  'tests/fixtures/phase1/phase1-online.archimate',
  'tests/fixtures/phase1/phase1-desktop.archimate',
  'tests/fixtures/phase2/phase2-online.archimate',
  'tests/fixtures/phase2/phase2-desktop.archimate',
  'tests/fixtures/phase3/phase3-online.archimate',
];

/** The original as archi-online reads it, without what Archi.nendo leaves out: every image. */
function withoutImages(model) {
  const out = structuredClone(model);
  out.assets = {};
  const images = new Set(Object.values(out.nodes).filter(node => node.nodeType === 'image').map(node => node.id));
  const gone = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const connection of Object.values(out.connections)) {
      if (!gone.has(connection.id) && [connection.sourceId, connection.targetId].some(id => images.has(id) || gone.has(id))) { gone.add(connection.id); grew = true; }
    }
  }
  for (const id of images) delete out.nodes[id];
  for (const id of gone) delete out.connections[id];
  const keep = list => list.filter(id => !images.has(id) && !gone.has(id));
  for (const view of Object.values(out.views)) view.childIds = keep(view.childIds);
  for (const item of [...Object.values(out.nodes), ...Object.values(out.connections)]) {
    if (item.childIds) item.childIds = keep(item.childIds);
    item.sourceConnectionIds = keep(item.sourceConnectionIds ?? []);
    item.targetConnectionIds = keep(item.targetConnectionIds ?? []);
    delete item.imagePath; delete item.imageSource; delete item.imagePosition;
  }
  for (const profile of Object.values(out.profiles)) delete profile.imagePath;
  return { model: out, images: images.size, connections: gone.size };
}

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

function compare(label, expected, actual) {
  const differences = comparePhase2Semantics(canonicalizePhase2Model(expected), canonicalizePhase2Model(actual));
  return differences.length === 0 ? null : `${label}: ${differences.length} differences\n    ${differences.slice(0, 12).join('\n    ')}`;
}

function desktopVersion() {
  const bundles = path.join(ARCHI_HOME, 'configuration', 'org.eclipse.equinox.simpleconfigurator', 'bundles.info');
  return require('node:fs').readFileSync(bundles, 'utf8').split(/\r?\n/).map(line => line.split(',')).find(fields => fields[0] === 'com.archimatetool.editor')?.[1] ?? null;
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'archimate-io-'));
const problems = [];
const lines = [];
let labels = 0;
let version = null;
if (!skipDesktop) {
  version = desktopVersion();
  if (!version) throw new Error(`Desktop Archi was not found at ${ARCHI_HOME}. Set ARCHI_HOME, or pass --skip-desktop.`);
}
try {
  for (const fixture of FIXTURES) {
    const name = path.basename(fixture);
    const bytes = new Uint8Array(await fs.readFile(path.join(ARCHI_ONLINE, fixture)));
    const { model: original, leftOut } = canvas.readArchimate(bytes);
    const reference = withoutImages(original);

    const sets = emptyFile();
    const plan = canvas.planImport(original, {
      rootFolders: Object.fromEntries(ROOT_FOLDERS.map(folder => [folder.values['ar.folder.kind'], folder.recordId])),
      modelRecordId: 'ar.model.r.new',
    }, leftOut);
    const batches = canvas.importBatches(plan, sets, 200);
    apply(sets, batches);
    const saved = canvas.exportArchimate(sets);
    const reread = canvas.parseArchimateText(saved.xml);
    const ours = compare(`${name}, opened and saved by the workbench`, reference.model, reread);
    if (ours) problems.push(ours);
    // W-114: every label expression gives archi-online's text after the trip through the records.
    const labelled = [...Object.values(reference.model.nodes), ...Object.values(reference.model.connections), ...Object.values(reference.model.folders)]
      .filter(item => item.labelExpression);
    const differentLabels = labelled.filter(item => canvas.evaluateLabelExpression(reference.model, item.id).text !== canvas.evaluateLabelExpression(reread, item.id).text);
    labels += labelled.length;
    if (differentLabels.length > 0) problems.push(`${name}: ${differentLabels.length} of ${labelled.length} label expressions read differently, first ${differentLabels[0].id}: ` +
      `${JSON.stringify(canvas.evaluateLabelExpression(reference.model, differentLabels[0].id).text)} != ${JSON.stringify(canvas.evaluateLabelExpression(reread, differentLabels[0].id).text)}`);

    let desktop = 'not run';
    if (!skipDesktop) {
      const source = path.join(work, `${name}.saved.archimate`);
      const target = path.join(work, `${name}.desktop.archimate`);
      await fs.writeFile(source, saved.xml, 'utf8');
      execFileSync(path.join(ARCHI_HOME, 'Archi.exe'), ['-application', 'com.archimatetool.commandline.app', '-consoleLog', '-nosplash',
        '--loadModel', source, '--saveModel', target], { stdio: 'pipe', timeout: 120_000 });
      const again = canvas.readArchimate(new Uint8Array(await fs.readFile(target))).model;
      const theirs = compare(`${name}, saved by the workbench and then by Desktop Archi ${version}`, reference.model, again);
      if (theirs) problems.push(theirs);
      desktop = theirs ? 'differs' : 'same';
    }
    const left = canvas.leftOutSentence(plan.leftOut);
    lines.push(`${ours ? 'DIFF' : 'ok  '} ${name}: ${plan.counts.elements} elements, ${plan.counts.relationships} relationships, ${plan.counts.views} views, ` +
      `${plan.creates.length} records in ${batches.length} ${batches.length === 1 ? 'save' : 'saves'}; Desktop Archi: ${desktop}${left ? `; ${left}` : ''}`);
  }
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
for (const line of lines) console.log(line);
if (problems.length > 0) {
  console.error(`\n${problems.join('\n\n')}`);
  process.exit(1);
}
console.log(`Every fixture opens and saves with archi-online's semantics, and its ${labels} label expressions read as archi-online reads them${skipDesktop ? '' : `; Desktop Archi ${version} opens and saves each save the same`}.`);
