// Writes tools/archi/analysis-parity.json: what archi-online's Analysis and Visualiser give for
// archi-online's own models, the reference the workbench is measured against (W-118,
// tools/archi/analysis.test.mjs). For every concept, its model relations, the views it is used in
// and the object that stands for it on each; for Archisurance, the Visualiser's graph around every
// concept and around a few with each control set. The models are the ones in
// validation-parity.json, as archi-online parses them, plus one scenario that relates an element to
// itself. Regenerate it when the pinned archi-online commit changes, after validation-parity.json:
//
//   node tools/archi/make-analysis-fixture.mjs
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
const validation = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'validation-parity.json'), 'utf8'));
if (validation.archiOnline !== head) {
  console.error(`validation-parity.json was made from ${validation.archiOnline}; make it again first.`);
  process.exit(1);
}

const SOURCE = String.raw`
import { addElement, addRelationship, addView, addElementNodeToView, addConnectionToView, createEmptyModel } from './src/model/ops';
import { createModelStore } from './src/model/store';
export { modelRelations, viewsUsing, findInView } from './src/model/analysis';
export { buildAnalysisGraph } from './src/model/analysis-graph';

/** An element related to itself, on a view with its connection, beside one related to it twice. */
export function selfRelated() {
  const s = createModelStore({ model: createEmptyModel('self') });
  const a = addElement('BusinessActor', 'Self', undefined, s);
  const b = addElement('BusinessRole', 'Other', undefined, s);
  const loop = addRelationship('AssociationRelationship', a, a, 'loop', undefined, s);
  addRelationship('AssignmentRelationship', a, b, 'b', undefined, s);
  addRelationship('AssociationRelationship', b, a, 'a', undefined, s);
  const view = addView('Z view', undefined, s);
  const node = addElementNodeToView(view, a, view, { x: 0, y: 0, width: 120, height: 55 }, false, {}, s);
  addConnectionToView(view, loop, node, node, s);
  addView('A view', undefined, s);
  const second = addView('A view', undefined, s);
  addElementNodeToView(second, a, second, { x: 0, y: 0, width: 120, height: 55 }, false, {}, s);
  addElementNodeToView(second, a, second, { x: 200, y: 0, width: 120, height: 55 }, false, {}, s);
  return s.getState().model;
}
`;

const require = createRequire(path.join(ARCHI_ONLINE, 'package.json'));
const esbuild = require('esbuild');
const outfile = path.join(os.tmpdir(), `archi-analysis-${process.pid}.mjs`);
await esbuild.build({
  stdin: { contents: SOURCE, resolveDir: ARCHI_ONLINE, loader: 'ts', sourcefile: 'analysis-fixture.ts' },
  bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error',
  nodePaths: [path.join(ARCHI_ONLINE, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
});
let module;
try { module = await import(pathToFileURL(outfile).href); } finally { await fs.rm(outfile, { force: true }); }
const { modelRelations, viewsUsing, findInView, buildAnalysisGraph, selfRelated } = module;

/** Every concept's Analysis, as archi-online's Analysis tab lists it and opens it. */
function analysis(model) {
  const concepts = {};
  for (const id of [...Object.keys(model.elements), ...Object.keys(model.relationships)].sort()) {
    const views = viewsUsing(model, id).map(view => view.id);
    concepts[id] = { relations: modelRelations(model, id).map(relationship => relationship.id), views,
      objects: views.map(viewId => findInView(model, viewId, id) ?? null) };
  }
  return concepts;
}

const graph = (model, options) => {
  const result = buildAnalysisGraph(model, options);
  return { options, nodes: result.nodes.map(node => node.id), edges: result.edges.map(edge => edge.id),
    elements: result.elementIds.length, relationships: result.relationshipIds.length, truncated: result.truncated };
};

/** The Visualiser around every concept at its default depth, and with each control around a few. */
function graphs(model) {
  const cases = [];
  const ids = [...Object.keys(model.elements), ...Object.keys(model.relationships)].sort();
  for (const id of ids) cases.push(graph(model, { focusIds: [id], depth: 1, direction: 'both' }));
  const elements = Object.values(model.elements).sort((a, b) => (a.id < b.id ? -1 : 1));
  const few = elements.filter((element, index) => index % 40 === 0);
  const types = [...new Set(elements.map(element => element.type))].sort().slice(0, 6);
  for (const element of few) {
    for (const direction of ['both', 'outgoing', 'incoming']) for (const depth of [2, 6]) {
      cases.push(graph(model, { focusIds: [element.id], depth, direction }));
    }
    cases.push(graph(model, { focusIds: [element.id], depth: 3, direction: 'both', elementTypes: types }));
    cases.push(graph(model, { focusIds: [element.id], depth: 3, direction: 'both', relationshipTypes: ['ServingRelationship', 'RealizationRelationship'] }));
    cases.push(graph(model, { focusIds: [element.id], depth: 3, direction: 'both', viewpointId: 'application_usage' }));
    cases.push(graph(model, { focusIds: [element.id], depth: 6, direction: 'both', maxConcepts: 7 }));
  }
  return cases;
}

const MODELS = validation.entries.filter(entry => !entry.name.includes(': ')).map(entry => entry.name);
const entries = MODELS.map(name => {
  const model = validation.entries.find(entry => entry.name === name).model;
  return { name, concepts: analysis(model), ...(name === 'Archisurance.archimate' ? { graphs: graphs(model) } : {}) };
});
const self = selfRelated();
entries.push({ name: 'self-related', model: self, concepts: analysis(self), graphs: graphs(self) });

const fixture = { archiOnline: head, entries };
const out = path.join(import.meta.dirname, 'analysis-parity.json');
await fs.writeFile(out, JSON.stringify(fixture) + '\n');
console.log(`${out}: ${entries.map(entry => `${entry.name} ${Object.keys(entry.concepts).length} concepts${entry.graphs ? `, ${entry.graphs.length} graphs` : ''}`).join('; ')}`);
