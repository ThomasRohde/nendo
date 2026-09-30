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
import { parser, recordSets } from './archimate-records.mjs';

const source = process.argv[2] ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online', 'public', 'examples', 'Archisurance.archimate');
const parseArchimate = await parser();
const { records } = recordSets(parseArchimate(await fs.readFile(source, 'utf8')));

// archi-online's own geometry for every view of its own parse: the reference the workbench's
// mirror is measured against (tools/archi/canvas.test.mjs). Built by build-canvas.mjs first.
const { geometry } = await import('../../extensions/archi/canvas.js');
const parsed = parseArchimate(await fs.readFile(source, 'utf8'));
const round = value => Math.round(value * 100) / 100;
const reference = {};
for (const viewId of Object.keys(parsed.views)) {
  const { bounds, routes } = geometry(parsed, viewId);
  reference[`ar-${viewId}`] = {
    bounds: Object.fromEntries([...bounds].map(([id, b]) => [`ar-${id}`, [b.x, b.y, b.width, b.height].map(round)])),
    routes: Object.fromEntries([...routes].map(([id, points]) => [`ar-${id}`, points.map(p => [round(p.x), round(p.y)])])),
  };
}
await fs.writeFile(path.join(import.meta.dirname, 'archisurance-geometry.json'), JSON.stringify(reference) + '\n');

const out = path.join(import.meta.dirname, 'archisurance.json');
await fs.writeFile(out, JSON.stringify({ source: path.basename(source), records }, null, 1) + '\n');
console.log(`${out}: ${Object.entries(records).map(([entityId, list]) => `${list.length} ${entityId}`).join(', ')}`);
