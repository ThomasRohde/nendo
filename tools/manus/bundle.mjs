// Bundles the manuscript view's editor dependencies into one ES module with their licences.
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
const here = import.meta.dirname;
const out = path.resolve(here, '../../extensions/manuscript/vendor');
await fs.mkdir(out, { recursive: true });
const result = await build({
  entryPoints: [path.join(here, 'vendor-entry.mjs')], bundle: true, format: 'esm', minify: true,
  target: 'es2022', platform: 'browser', legalComments: 'none', metafile: true, write: false, charset: 'utf8',
});
const code = result.outputFiles[0].text.replace(/\r\n/g, '\n');
await fs.writeFile(path.join(out, 'editor.js'), code);
// One notice per npm package whose code is in the bundle, read from its own licence file.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join('/'));
  if (match) packages.add(match[1]);
}
const notices = [];
for (const name of [...packages].sort()) {
  const folder = path.join(here, 'node_modules', name);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const licence = (await fs.readdir(folder)).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
  if (!licence) throw Error(`No licence file in ${name}; its notice cannot be written.`);
  notices.push(`${metadata.name} ${metadata.version} (${metadata.license})\n\n${(await fs.readFile(path.join(folder, licence), 'utf8')).trim()}`);
}
await fs.writeFile(path.join(out, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n').replace(/\r\n/g, '\n') + '\n');
console.log(`editor.js: ${Buffer.byteLength(code)} bytes from ${packages.size} packages: ${[...packages].sort().join(', ')}`);
