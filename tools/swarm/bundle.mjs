import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../extensions/swarm/vendor');
await fs.mkdir(root, { recursive: true });
const moduleRoot = path.join(import.meta.dirname, 'node_modules/bpmn-js');
for (const [source, name] of [['dist/bpmn-modeler.production.min.js', 'bpmn-modeler.js'], ['dist/assets/diagram-js.css', 'diagram-js.css'], ['LICENSE', 'bpmn-js.LICENSE.txt']]) {
  const bytes = await fs.readFile(path.join(moduleRoot, source));
  await fs.writeFile(path.join(root, name), bytes.toString('utf8').replace(/\r\n/g, '\n'));
  console.log(`${name}: ${bytes.length} bytes`);
}
console.log('Pinned bpmn-js distribution copied with its licence; logo/link are retained.');
const dependencyRoot = path.join(import.meta.dirname, 'node_modules');
const notices = [];
const names = [];
for (const name of (await fs.readdir(dependencyRoot)).filter(name => !name.startsWith('.'))) {
  if (name.startsWith('@')) names.push(...(await fs.readdir(path.join(dependencyRoot, name))).map(child => `${name}/${child}`));
  else names.push(name);
}
for (const name of names) {
  const folder = path.join(dependencyRoot, name);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const licence = (await fs.readdir(folder)).find(name => /^licen[cs]e(?:\.|$)/i.test(name));
  if (!licence) throw Error(`Missing distribution licence for ${metadata.name}.`);
  notices.push(`${metadata.name} ${metadata.version}\n${await fs.readFile(path.join(folder, licence), 'utf8')}`);
}
await fs.writeFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n').replace(/\r\n/g, '\n'));
