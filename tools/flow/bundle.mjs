// Bundle React and @xyflow/react into one offline script for the Flow view, with the
// stylesheet and every distributed licence beside it. Run from tools/flow: npm run bundle.
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '../../extensions/flow/vendor');
await fs.mkdir(root, { recursive: true });
const modules = path.join(import.meta.dirname, 'node_modules');

const result = await build({
  entryPoints: [path.join(import.meta.dirname, 'entry.mjs')], bundle: true, minify: true, format: 'iife',
  target: 'es2022', legalComments: 'none', write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
});
const script = result.outputFiles[0].text.replace(/\r\n/g, '\n');
await fs.writeFile(path.join(root, 'xyflow.js'), script);
console.log(`xyflow.js: ${Buffer.byteLength(script)} bytes`);

const css = (await fs.readFile(path.join(modules, '@xyflow/react/dist/style.css'), 'utf8')).replace(/\r\n/g, '\n');
await fs.writeFile(path.join(root, 'xyflow.css'), css);
console.log(`xyflow.css: ${Buffer.byteLength(css)} bytes`);

// Every package the bundle can contain, with its own licence text. A package without one
// stops the bundle rather than shipping code nobody can attribute.
const names = [];
for (const name of (await fs.readdir(modules)).filter(name => !name.startsWith('.'))) {
  if (name.startsWith('@')) names.push(...(await fs.readdir(path.join(modules, name))).map(child => `${name}/${child}`));
  else names.push(name);
}
const notices = [];
// esbuild builds the bundle and @types only types it; neither ships in it.
for (const name of names.filter(name => name !== 'esbuild' && !/^@(esbuild|types)\//.test(name)).sort()) {
  const folder = path.join(modules, name);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  const licence = (await fs.readdir(folder)).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
  if (!licence) throw Error(`Missing distribution licence for ${metadata.name}.`);
  notices.push(`${metadata.name} ${metadata.version}\n${await fs.readFile(path.join(folder, licence), 'utf8')}`);
}
await fs.writeFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n').replace(/\r\n/g, '\n'));
console.log(`THIRD-PARTY-NOTICES.txt: ${notices.length} packages`);
