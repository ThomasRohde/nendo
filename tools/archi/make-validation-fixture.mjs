// Writes tools/archi/validation-parity.json: what archi-online's validator reports for each of its
// own models and validation scenarios, the reference the workbench's validator is measured
// against (W-117, tools/archi/validation.test.mjs). Each entry is archi-online's model and the
// issues archi-online's validateModel gives it; the test turns the model into Archi.nendo's
// records, reads them back through the mirror and validates that. Regenerate it when the pinned
// archi-online commit changes:
//
//   node tools/archi/make-validation-fixture.mjs
//
// It needs the archi-online checkout beside this one, at the commit extensions/archi/canvas.js was built from.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { archiOnlineCommit } from '../../extensions/archi/canvas.js';

const ARCHI_ONLINE = path.resolve(process.env.ARCHI_ONLINE ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online'));
const head = execFileSync('git', ['-C', ARCHI_ONLINE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== archiOnlineCommit) {
  console.error(`archi-online is at ${head}, and the canvas was built from ${archiOnlineCommit}.`);
  process.exit(1);
}

// archi-online's validation tests (tests/validation.test.ts), each case in the state it checks,
// built with archi-online's own operations. A rule is flagged, then cleared, as the test does.
const SCENARIOS = String.raw`
import { addConnectionToView, addElement, addElementNodeToView, addRelationship, addView, createEmptyModel, setViewpoint } from './src/model/ops';
import { createModelStore } from './src/model/store';
export { validateModel } from './src/model/validation';
export { parseArchimateDocument } from './src/model/io/archimate-xml';

const box = (x, y, width = 120, height = 55) => ({ x, y, width, height });
function scenario(name, build) {
  const store = createModelStore({ model: createEmptyModel(name) });
  const snapshots = [];
  build(store, label => snapshots.push({ name: name + ': ' + label, model: structuredClone(store.getState().model) }));
  return snapshots;
}

export function scenarios() {
  return [
    ...scenario('invalid-relationship', (s, keep) => {
      const a = addElement('BusinessActor', 'A', undefined, s);
      const b = addElement('BusinessActor', 'B', undefined, s);
      const rel = addRelationship('TriggeringRelationship', a, b, '', undefined, s);
      keep('a valid type');
      // archi-online refuses the invalid type, so its test sets it on the model, as here.
      s.setState(state => { const model = structuredClone(state.model); model.relationships[rel].type = 'RealizationRelationship'; return { model }; });
      keep('a type the matrix disallows');
    }),
    ...scenario('junction', (s, keep) => {
      const j = addElement('Junction', 'J', undefined, s);
      const a = addElement('BusinessActor', 'A', undefined, s);
      const b = addElement('BusinessActor', 'B', undefined, s);
      addRelationship('TriggeringRelationship', j, a, '', undefined, s);
      addRelationship('TriggeringRelationship', j, b, '', undefined, s);
      keep('one relationship type');
      const c = addElement('BusinessActor', 'C', undefined, s);
      addRelationship('FlowRelationship', j, c, '', undefined, s);
      keep('two relationship types');
    }),
    ...scenario('duplicate-name', (s, keep) => {
      addElement('BusinessActor', 'X', undefined, s);
      addElement('BusinessRole', 'X', undefined, s);
      addElement('Junction', 'J', undefined, s);
      addElement('Junction', 'J', undefined, s);
      keep('different types and junction pairs');
      addElement('BusinessActor', 'Same', undefined, s);
      addElement('BusinessActor', 'Same', undefined, s);
      keep('a name and type used twice');
    }),
    ...scenario('unused-element', (s, keep) => {
      const a = addElement('BusinessActor', 'Lonely', undefined, s);
      keep('on no view');
      const view = addView('V', undefined, s);
      addElementNodeToView(view, a, view, box(0, 0), false, {}, s);
      keep('placed');
    }),
    ...scenario('unused-relationship', (s, keep) => {
      const a = addElement('BusinessActor', 'A', undefined, s);
      const b = addElement('BusinessActor', 'B', undefined, s);
      const rel = addRelationship('TriggeringRelationship', a, b, '', undefined, s);
      keep('on no view');
      const view = addView('V', undefined, s);
      const na = addElementNodeToView(view, a, view, box(0, 0), false, {}, s);
      const nb = addElementNodeToView(view, b, view, box(200, 0), false, {}, s);
      addConnectionToView(view, rel, na, nb, s);
      keep('connected');
    }),
    ...scenario('empty-view', (s, keep) => {
      const view = addView('Empty', undefined, s);
      keep('empty');
      const a = addElement('BusinessActor', 'A', undefined, s);
      addElementNodeToView(view, a, view, box(0, 0), false, {}, s);
      keep('with content');
    }),
    ...scenario('viewpoint', (s, keep) => {
      const view = addView('V', undefined, s);
      setViewpoint(view, 'strategy', s);
      const a = addElement('BusinessActor', 'A', undefined, s);
      addElementNodeToView(view, a, view, box(0, 0), false, {}, s);
      keep('outside the viewpoint');
      setViewpoint(view, '', s);
      keep('no viewpoint');
    }),
    ...scenario('nested-elements', (s, keep) => {
      const view = addView('V', undefined, s);
      const parent = addElement('BusinessActor', 'Parent', undefined, s);
      const child = addElement('BusinessActor', 'Child', undefined, s);
      const parentNode = addElementNodeToView(view, parent, view, box(0, 0, 200, 200), false, {}, s);
      const childNode = addElementNodeToView(view, child, parentNode, box(10, 10, 80, 40), false, {}, s);
      keep('no relationship');
      const rel = addRelationship('CompositionRelationship', parent, child, '', undefined, s);
      addConnectionToView(view, rel, parentNode, childNode, s);
      keep('a composition');
      const other = addElement('BusinessActor', 'Other', undefined, s);
      const otherNode = addElementNodeToView(view, other, parentNode, box(100, 10, 80, 40), false, {}, s);
      const flow = addRelationship('TriggeringRelationship', parent, other, '', undefined, s);
      addConnectionToView(view, flow, parentNode, otherNode, s);
      keep('and a non-nesting relationship');
    }),
  ];
}
`;

const require = createRequire(path.join(ARCHI_ONLINE, 'package.json'));
const esbuild = require('esbuild');
globalThis.DOMParser = new (require('jsdom').JSDOM)('').window.DOMParser;
const outfile = path.join(os.tmpdir(), `archi-validation-${process.pid}.mjs`);
await esbuild.build({
  stdin: { contents: SCENARIOS, resolveDir: ARCHI_ONLINE, loader: 'ts', sourcefile: 'validation-scenarios.ts' },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error',
  nodePaths: [path.join(ARCHI_ONLINE, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
});
let module;
try { module = await import(pathToFileURL(outfile).href); } finally { await fs.rm(outfile, { force: true }); }
const { scenarios, parseArchimateDocument, validateModel } = module;

// archi-online's example models and its phase fixtures, as archi-online parses them. The two
// malformed phase 2 files are left out: records cannot hold a connection whose end is missing.
const MODELS = [
  'public/examples/Archisurance.archimate',
  'public/examples/archi-online-capability-model.archimate',
  'public/examples/c4-customer-portal.archimate',
  'tests/fixtures/phase1/phase1-desktop.archimate',
  'tests/fixtures/phase1/phase1-online.archimate',
  'tests/fixtures/phase2/phase2-desktop.archimate',
  'tests/fixtures/phase2/phase2-online.archimate',
  'tests/fixtures/phase3/phase3-online.archimate',
];
const entries = [];
for (const file of MODELS) {
  // An archive (phase 1 is zipped, with its images) is read as archi-online opens a document.
  entries.push({ name: path.basename(file), model: await parseArchimateDocument(new Uint8Array(await fs.readFile(path.join(ARCHI_ONLINE, file)))) });
}
entries.push(...scenarios());

const fixture = { archiOnline: head, entries: entries.map(({ name, model }) => ({ name, model, issues: validateModel(model) })) };
const out = path.join(import.meta.dirname, 'validation-parity.json');
await fs.writeFile(out, JSON.stringify(fixture) + '\n');
console.log(`${out}: ${fixture.entries.map(entry => `${entry.name} ${entry.issues.length}`).join(', ')}`);
