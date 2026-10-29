// The browser host as one page (ADR-0036): the inlined Workbench, the .NET runtime's files gzipped
// and base64 with its boot config, and the view API. The Workbench's browser client starts the
// runtime from them, so nothing is fetched. The licences of all of it travel in the page as an
// inert template (browser-host-notices.mjs), read from the runtime's notices/ beside wwwroot. Usage:
//   node scripts/pack-browser-host.mjs <workbench page> <runtime wwwroot> <api.js> <out.html>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { browserHostNotices } from './browser-host-notices.mjs';

const [pagePath, wwwroot, apiPath, out] = process.argv.slice(2);
if (!out) throw new Error('Usage: pack-browser-host.mjs <workbench page> <runtime wwwroot> <api.js> <out.html>');

const framework = join(wwwroot, '_framework');
const files = {};
const builds = new Map();
for (const name of readdirSync(framework)) {
  if (name.endsWith('.gz') || name.endsWith('.br') || name.endsWith('.map')) continue;
  // One build of each file: a second fingerprint of the same name is a stale build the page would carry for nothing.
  const unprinted = name.replace(/\.[a-z0-9]{10}(\.[a-z]+)$/, '$1');
  if (builds.has(unprinted)) throw new Error(`${framework} holds two builds of ${unprinted}: ${builds.get(unprinted)} and ${name}. Publish into an empty folder.`);
  builds.set(unprinted, name);
  files[name] = gzipSync(readFileSync(join(framework, name)), { level: 9 }).toString('base64');
}
// The page runs Nendo compiled ahead of time (ADR-0036): interpreted, a large file took twice as
// long to open. The native module names each assembly it compiled; a publish without it has none.
const native = readFileSync(join(framework, builds.get('dotnet.native.wasm') ?? 'dotnet.native.wasm')).toString('latin1');
const interpreted = ['Nendo_Engine', 'Nendo_Session', 'Nendo_Browser'].filter((name) => !native.includes(`mono_aot_${name}_get_method`));
if (interpreted.length > 0) throw new Error(`The runtime in ${framework} was not compiled ahead of time: ${interpreted.join(', ')}. Publish Nendo.Browser with RunAOTCompilation.`);
const dotnetJs = readFileSync(join(framework, 'dotnet.js'), 'utf8');
const config = JSON.parse(/\/\*json-start\*\/([\s\S]*?)\/\*json-end\*\//.exec(dotnetJs)[1]);

const json = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
const notices = browserHostNotices(fileURLToPath(new URL('..', import.meta.url)), join(wwwroot, '..', 'notices'),
  fileURLToPath(new URL('../../Nendo.Browser/licences', import.meta.url)));
const html = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const carried = `<template id="nendo-notices"><pre>${html(notices)}</pre></template>\n`
  + `<script type="application/json" id="nendo-runtime">${json({ files, config: { mainAssemblyName: config.mainAssemblyName } })}</script>\n`
  + `<script type="application/json" id="nendo-view-api">${json(readFileSync(apiPath, 'utf8'))}</script>\n`;

const page = readFileSync(pagePath, 'utf8');
// The inlined code may hold '</body>' in its own strings; the document's is the last one.
const at = page.lastIndexOf('</body>');
if (at < 0) throw new Error('The Workbench page has no </body>.');
// Before the module script runs: the client reads them when it is created.
const head = page.indexOf('<script type="module">');
const where = head >= 0 && head < at ? head : at;
writeFileSync(out, page.slice(0, where) + carried + page.slice(where));
console.log(out, Buffer.byteLength(page) + Buffer.byteLength(carried));
