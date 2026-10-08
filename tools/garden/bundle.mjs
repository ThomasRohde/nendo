// Copies the pinned d3 and Mermaid distributions into the Garden package, with every licence
// they carry.
//
//   npm.cmd ci --prefix tools/garden
//   node tools/garden/bundle.mjs
//
// d3's dist/d3.min.js and Mermaid's dist/mermaid.min.js are each one self-contained file that
// sets a global (window.d3, window.mermaid), so the package needs no bundler: the graph loads d3
// with a classic script tag before its own modules, and diagrams.js adds Mermaid's tag the first
// time a note has a diagram.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../extensions/garden/vendor');
await fs.mkdir(root, { recursive: true });
const dependencyRoot = path.join(import.meta.dirname, 'node_modules');
const versions = [];
for (const [name, files] of [
  ['d3', [['dist/d3.min.js', 'd3.min.js'], ['LICENSE', 'd3.LICENSE.txt']]],
  ['mermaid', [['dist/mermaid.min.js', 'mermaid.min.js'], ['LICENSE', 'mermaid.LICENSE.txt']]],
]) {
  const folder = path.join(dependencyRoot, name);
  versions.push(`${name} ${JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')).version}`);
  for (const [source, target] of files) {
    // The source map is not shipped, so the line that names it would point at nothing.
    const text = (await fs.readFile(path.join(folder, source), 'utf8')).replace(/\r\n/g, '\n').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
    await fs.writeFile(path.join(root, target), text);
    console.log(`${target}: ${Buffer.byteLength(text)} bytes`);
  }
}
// The bundles are built from the modules installed beside them, so their notices travel with them:
// every package under node_modules, scoped and nested ones included, once per name and version.
async function packages(folder) {
  const found = [];
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const at = path.join(folder, entry.name);
    if (entry.name.startsWith('@')) { found.push(...await packages(at)); continue; }
    found.push(at, ...await packages(path.join(at, 'node_modules')));
  }
  return found;
}
const seen = new Map();
for (const folder of await packages(dependencyRoot)) {
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const key = `${metadata.name}@${metadata.version}`;
  if (seen.has(key)) continue;
  const files = await fs.readdir(folder);
  const licence = files.find(file => /^licen[cs]e(?:\.|-|$)/i.test(file));
  let text = licence ? await fs.readFile(path.join(folder, licence), 'utf8') : null;
  // A few packages carry their licence only as the last section of their README.
  const readme = files.find(file => /^readme\.md$/i.test(file));
  if (text === null && readme) text = /^#+\s*licen[cs]e\s*\n([\s\S]+?)(?=^#\s|(?![\s\S]))/im.exec(await fs.readFile(path.join(folder, readme), 'utf8'))?.[1].trim() ?? null;
  if (!text) throw Error(`Missing distribution licence for ${key}.`);
  seen.set(key, `${metadata.name} ${metadata.version} (${metadata.license})\n${text}`);
}
const notices = [...seen.keys()].sort().map(key => seen.get(key));
await fs.writeFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n').replace(/\r\n/g, '\n'));
console.log(`${versions.join(', ')} copied with ${notices.length} notices.`);
