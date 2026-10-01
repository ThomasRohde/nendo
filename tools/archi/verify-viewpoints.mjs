// W-116: the viewpoint table the workbench draws by is Archi's. canvas.js carries archi-online's
// port of Archi's viewpoints (src/model/data/viewpoints.ts); this compares it with the
// viewpoints.xml that Desktop Archi 5.9 itself ships, independently of that port: every viewpoint's
// id, name and place, and for each of the 61 element types Archi.nendo knows (archi-definition.mjs),
// whether the viewpoint allows it. Archi's $...Elements$ collections are expanded by each type's
// layer in archi-definition.mjs, and Viewpoint.isAllowedConcept's rules apply: Junction and
// Grouping always, an empty list allows everything, no viewpoint allows everything.
//
//   node tools/archi/verify-viewpoints.mjs
//
// It needs Desktop Archi 5.9 (ARCHI_HOME, default C:\Program Files\Archi).

import fs from 'node:fs';
import path from 'node:path';
import { TYPES } from '../archi-definition.mjs';

const ARCHI_HOME = process.env.ARCHI_HOME ?? 'C:\\Program Files\\Archi';
globalThis.DOMParser ??= class {};
const canvas = await import('../../extensions/archi/canvas.js');

const plugins = path.join(ARCHI_HOME, 'plugins');
const bundle = fs.existsSync(plugins) ? fs.readdirSync(plugins).find(name => /^com\.archimatetool\.model_\d/.test(name)) : null;
const source = bundle ? path.join(plugins, bundle, 'model', 'viewpoints.xml') : null;
if (!source || !fs.existsSync(source)) throw new Error(`Desktop Archi's viewpoints.xml was not found under ${plugins}. Set ARCHI_HOME.`);
const version = /_(\d+\.\d+\.\d+)/.exec(bundle)[1];

const elements = TYPES.filter(type => type.values['ar.type.category'] === 'Element');
const LAYER = { Strategy: 'Strategy', Business: 'Business', Application: 'Application', Technology: 'Technology', Physical: 'Physical',
  Motivation: 'Motivation', ImplementationMigration: 'Implementation & Migration' };
const collection = token => {
  const layer = LAYER[/^\$(\w+)Elements\$$/.exec(token)?.[1]];
  if (!layer) throw new Error(`viewpoints.xml names ${token}, which no layer expands.`);
  return elements.filter(type => type.values['ar.type.layer'] === layer).map(type => type.values['ar.type.key']);
};

const xml = fs.readFileSync(source, 'utf8');
const archi = [...xml.matchAll(/<viewpoint id="([^"]+)">([\s\S]*?)<\/viewpoint>/g)].map(([, id, body]) => ({
  id,
  name: /<name xml:lang="en">([^<]*)<\/name>/.exec(body)[1],
  concepts: [...body.matchAll(/<concept>([^<]+)<\/concept>/g)].flatMap(([, concept]) => concept.startsWith('$') ? collection(concept) : [concept]),
}));
const keys = new Set(elements.map(type => type.values['ar.type.key']));
const strangers = [...new Set(archi.flatMap(viewpoint => viewpoint.concepts))].filter(concept => !keys.has(concept));
const allowed = (viewpoint, key) => key === 'Junction' || key === 'Grouping' || viewpoint.concepts.length === 0 || viewpoint.concepts.includes(key);

const problems = [];
if (strangers.length) problems.push(`viewpoints.xml names concepts that are not element types here: ${strangers.join(', ')}`);
const ours = canvas.VIEWPOINTS.map(viewpoint => `${viewpoint.id} ${viewpoint.name}`);
const theirs = archi.map(viewpoint => `${viewpoint.id} ${viewpoint.name}`);
if (JSON.stringify(ours) !== JSON.stringify(theirs)) problems.push(`The viewpoints differ in id, name or order:\n    canvas.js ${JSON.stringify(ours)}\n    Archi     ${JSON.stringify(theirs)}`);
let decisions = 0;
for (const viewpoint of archi) {
  const differ = elements.map(type => type.values['ar.type.key']).filter(key => { decisions++; return canvas.isAllowedElementInViewpoint(viewpoint.id, key) !== allowed(viewpoint, key); });
  const count = elements.filter(type => allowed(viewpoint, type.values['ar.type.key'])).length;
  console.log(`${differ.length ? 'DIFF' : 'ok  '} ${viewpoint.name}: ${count} of ${elements.length} element types allowed${differ.length ? `; differs on ${differ.join(', ')}` : ''}`);
  if (differ.length) problems.push(`${viewpoint.id}: canvas.js and Archi differ on ${differ.join(', ')}`);
}
for (const key of keys) if (!canvas.isAllowedElementInViewpoint(undefined, key) || !canvas.isAllowedElementInViewpoint('', key)) problems.push(`No viewpoint does not allow ${key}.`);
if (problems.length) {
  console.error(`\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`canvas.js allows what Desktop Archi ${version}'s viewpoints.xml allows: ${archi.length} viewpoints by id, name and order, and ${decisions} viewpoint and element type pairs.`);
