// Bundles the manuscript view's dependencies into ES modules with their licences: the editor
// (vendor/editor.js, loaded with the view) and the exports (vendor/export.js, loaded only when
// the person exports).
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
const here = import.meta.dirname;
const out = path.resolve(here, '../../extensions/manuscript/vendor');
await fs.mkdir(out, { recursive: true });
const packages = new Set();
for (const [entry, file] of [['vendor-entry.mjs', 'editor.js'], ['export-entry.mjs', 'export.js']]) {
  const result = await build({
    entryPoints: [path.join(here, entry)], bundle: true, format: 'esm', minify: true,
    target: 'es2022', platform: 'browser', legalComments: 'none', metafile: true, write: false, charset: 'utf8',
  });
  const code = result.outputFiles[0].text.replace(/\r\n/g, '\n');
  await fs.writeFile(path.join(out, file), code);
  const used = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join('/'));
    if (match) { used.add(match[1]); packages.add(match[1]); }
  }
  console.log(`${file}: ${Buffer.byteLength(code)} bytes from ${used.size} packages`);
}
// docx's own build inlines its dependencies rather than importing them, so the packages it
// carries are its dependency closure, not esbuild's inputs.
const closure = async name => {
  const metadata = JSON.parse(await fs.readFile(path.join(here, 'node_modules', name, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    if (dependency.startsWith('@types/') || packages.has(dependency)) continue;
    packages.add(dependency);
    await closure(dependency);
  }
};
if (packages.has('docx')) await closure('docx');
// One notice per npm package whose code is in either bundle, read from its own licence file.
const notices = [];
for (const name of [...packages].sort()) {
  const folder = path.join(here, 'node_modules', name);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const files = await fs.readdir(folder);
  const licence = files.find(file => /^licen[cs]e(?:\.|$)/i.test(file));
  let text;
  if (licence) text = await fs.readFile(path.join(folder, licence), 'utf8');
  else {
    // A package without a licence file (hash.js) states it in its README.
    const readme = files.find(file => /^readme/i.test(file));
    const section = readme ? /^#+\s*licen[cs]e\s*$([\s\S]*?)(?=^#+\s|(?![\s\S]))/im.exec(await fs.readFile(path.join(folder, readme), 'utf8')) : null;
    if (!section && !metadata.license) throw Error(`No licence in ${name}; its notice cannot be written.`);
    text = section ? section[1] : `Licensed ${metadata.license}, as its package.json declares; the package carries no licence text.`;
  }
  notices.push(`${metadata.name} ${metadata.version} (${metadata.license})\n\n${text.trim()}`);
}
await fs.writeFile(path.join(out, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n').replace(/\r\n/g, '\n') + '\n');
console.log(`Notices for ${packages.size} packages: ${[...packages].sort().join(', ')}`);
