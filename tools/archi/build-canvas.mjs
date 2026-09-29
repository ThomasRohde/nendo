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
