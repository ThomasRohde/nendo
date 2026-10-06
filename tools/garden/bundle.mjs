// Copies the pinned d3 distribution into the Garden package, with every licence it carries.
//
//   npm.cmd ci --prefix tools/garden
//   node tools/garden/bundle.mjs
//
// d3's own dist/d3.min.js is one self-contained UMD file that sets window.d3, so the package
// needs no bundler: the graph loads it with a classic script tag before its own modules.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../extensions/garden/vendor');
await fs.mkdir(root, { recursive: true });
const dependencyRoot = path.join(import.meta.dirname, 'node_modules');
const d3 = path.join(dependencyRoot, 'd3');
const version = JSON.parse(await fs.readFile(path.join(d3, 'package.json'), 'utf8')).version;
for (const [source, name] of [['dist/d3.min.js', 'd3.min.js'], ['LICENSE', 'd3.LICENSE.txt']]) {
  const text = (await fs.readFile(path.join(d3, source), 'utf8')).replace(/\r\n/g, '\n');
  await fs.writeFile(path.join(root, name), text);
  console.log(`${name}: ${Buffer.byteLength(text)} bytes`);
}
// The bundle is built from d3's modules, so their notices travel with it.
const names = (await fs.readdir(dependencyRoot)).filter(name => !name.startsWith('.')).sort();
const notices = [];
for (const name of names) {
  const folder = path.join(dependencyRoot, name);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const licence = (await fs.readdir(folder)).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
  if (!licence) throw Error(`Missing distribution licence for ${metadata.name}.`);
  notices.push(`${metadata.name} ${metadata.version} (${metadata.license})\n${await fs.readFile(path.join(folder, licence), 'utf8')}`);
}
await fs.writeFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n').replace(/\r\n/g, '\n'));
console.log(`d3 ${version} copied with ${notices.length} notices.`);
