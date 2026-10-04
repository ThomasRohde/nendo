// Builds extensions/archi/canvas.js: tools/archi/canvas (the mirror and the canvas controller)
// with archi-online's renderer, geometry and Manhattan router, and React, as one module the
// package loads. archi-online is MIT; the notice travels in the bundle's banner and in
// extensions/archi/THIRD-PARTY.txt.
//
//   node tools/archi/build-canvas.mjs            build from the pinned archi-online commit
//   node tools/archi/build-canvas.mjs --any      build from whatever the checkout holds
//
// It needs the archi-online checkout beside this one (ARCHI_ONLINE names another) with its
// node_modules, for the source, esbuild and React. The output is committed, so nothing that
// runs the package or its tests needs archi-online.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const ARCHI_ONLINE_COMMIT = '6205a6a52b42cec4c990c8c992a25c0c0aa243fe';
const ARCHI_ONLINE = path.resolve(process.env.ARCHI_ONLINE ?? path.join(import.meta.dirname, '..', '..', '..', 'archi-online'));
const out = path.join(import.meta.dirname, '..', '..', 'extensions', 'archi', 'canvas.js');

const head = execFileSync('git', ['-C', ARCHI_ONLINE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', ARCHI_ONLINE, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim();
if (!process.argv.includes('--any') && (head !== ARCHI_ONLINE_COMMIT || dirty !== '')) {
  console.error(`archi-online is at ${head}${dirty ? ' with changes in src' : ''}, not the pinned ${ARCHI_ONLINE_COMMIT}. Check it out, or pass --any.`);
  process.exit(1);
}

const require = createRequire(path.join(ARCHI_ONLINE, 'package.json'));
const esbuild = require('esbuild');
const result = await esbuild.build({
  entryPoints: [path.join(import.meta.dirname, 'canvas', 'entry.tsx')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  jsx: 'automatic', outfile: out, logLevel: 'warning', metafile: true,
  alias: { '@archi': path.join(ARCHI_ONLINE, 'src') },
  // Every id archi-online makes is a record ID, `ar-id-…`, as the importer names what it loads,
  // so a new object names its record before it is written (W-111).
  plugins: [{ name: 'record-ids', setup(build) {
    const idModule = path.join(ARCHI_ONLINE, 'src', 'model', 'id.ts');
    build.onLoad({ filter: /[\\/]model[\\/]id\.ts$/ }, args => path.resolve(args.path) === idModule
      ? { contents: `export function newId(): string { return 'ar-id-' + crypto.randomUUID().replace(/-/g, ''); }`, loader: 'ts' }
      : undefined);
  } }, { name: 'visualiser-without-saving', setup(build) {
    // W-118: the Visualiser's SVG export is archi-online's own (VisualiserPanel.tsx), whose module
    // also saves files through archi-online's persistence, which brings the Exchange schemas. The
    // workbench saves through the view's own downloads, so that one import is stood in for there.
    const panel = path.join(ARCHI_ONLINE, 'src', 'ui', 'VisualiserPanel.tsx');
    build.onResolve({ filter: /^\.\.\/persistence\/files$/ }, args => path.resolve(args.importer) === panel
      ? { path: 'visualiser-files', namespace: 'visualiser-without-saving' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'visualiser-without-saving' }, () => ({ loader: 'ts', contents:
      `export function saveBlobToDisk(): Promise<boolean> { throw new Error('The workbench saves through its own downloads.'); }
       export const sanitizeFileName = (name: string) => name;` }));
  } }, { name: 'elk-in-a-worker', setup(build) {
    // archi-online's layouts load ELK whole on the page; here they run it in a worker (W-115).
    build.onResolve({ filter: /^elkjs\/lib\/elk\.bundled\.js$/ }, () => ({ path: path.join(import.meta.dirname, 'canvas', 'elk.ts') }));
  } }],
  nodePaths: [path.join(ARCHI_ONLINE, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', __ARCHI_ONLINE_COMMIT__: JSON.stringify(head) },
  banner: { js: [
    `// The Archi workbench's canvas: built by tools/archi/build-canvas.mjs from tools/archi/canvas and`,
    `// archi-online ${head} (MIT, Copyright (c) archi-online contributors), with React (MIT). Do not edit.`,
  ].join('\n') },
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`${out}: ${(bytes / 1024).toFixed(0)} KiB from archi-online ${head.slice(0, 7)}`);

// W-115: the ELK worker the layouts run in, from the elkjs release whose API the bundle carries,
// copied unchanged with its licence. extensions/archi/vendor/elkjs/README.md records the hashes.
const elkjs = path.dirname(require.resolve('elkjs/package.json'));
const elkVersion = JSON.parse(readFileSync(path.join(elkjs, 'package.json'), 'utf8')).version;
const elkOut = path.join(path.dirname(out), 'vendor', 'elkjs');
mkdirSync(elkOut, { recursive: true });
for (const [from, to] of [['lib/elk-worker.min.js', 'elk-worker.min.js'], ['LICENSE.md', 'LICENSE.md']]) {
  copyFileSync(path.join(elkjs, from), path.join(elkOut, to));
  console.log(`${path.join(elkOut, to)}: elkjs ${elkVersion}, sha256 ${createHash('sha256').update(readFileSync(path.join(elkOut, to))).digest('hex')}`);
}

// W-121: the Open Exchange schema check, a file of its own that the workbench loads only when it
// checks an export: archi-online's validation, libxml2-wasm (MIT; libxml2 itself MIT) with its
// WebAssembly inlined, and Archi 5.9's five schemas, which archi-online imports as text (`?raw`).
const xsdOut = path.join(path.dirname(out), 'xsd.js');
const xsd = await esbuild.build({
  entryPoints: [path.join(import.meta.dirname, 'canvas', 'xsd.ts')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  outfile: xsdOut, logLevel: 'warning', metafile: true,
  alias: { '@archi': path.join(ARCHI_ONLINE, 'src') },
  nodePaths: [path.join(ARCHI_ONLINE, 'node_modules')],
  // Node's own modules are named only on the path libxml2-wasm takes under Node.
  external: ['module', 'node:*'],
  plugins: [{ name: 'raw-text', setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-text' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => ({ contents: await (await import('node:fs/promises')).readFile(args.path, 'utf8'), loader: 'text' }));
  } }],
  banner: { js: [
    `// The Open Exchange schema check: built by tools/archi/build-canvas.mjs from archi-online ${head}`,
    `// (MIT, Copyright (c) archi-online contributors), libxml2-wasm (MIT) and libxml2 (MIT), with Archi 5.9's schemas. Do not edit.`,
  ].join('\n') },
});
console.log(`${xsdOut}: ${(Object.values(xsd.metafile.outputs)[0].bytes / 1024).toFixed(0)} KiB`);
