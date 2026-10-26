// Prototype: pack a published browser-wasm app into one HTML file that opens from file://.
// Every file under _framework is gzipped and embedded as base64; the page decompresses each
// with DecompressionStream and hands it to dotnet.js through its resource loader, so the
// runtime fetches nothing. Usage: node pack.mjs <publish wwwroot> <out.html> [extra head html]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [wwwroot, out] = process.argv.slice(2);
const framework = join(wwwroot, '_framework');
const files = {};
for (const name of readdirSync(framework)) {
  if (name.endsWith('.gz') || name.endsWith('.br') || name.endsWith('.map')) continue;
  files[name] = gzipSync(readFileSync(join(framework, name)), { level: 9 }).toString('base64');
}
const dotnetJs = readFileSync(join(framework, 'dotnet.js'), 'utf8');
const config = JSON.parse(/\/\*json-start\*\/([\s\S]*?)\/\*json-end\*\//.exec(dotnetJs)[1]);

const boot = `
const { files, config } = JSON.parse(document.getElementById('nendo-runtime').textContent);
const started = performance.now();
const raw = async (name) => new Uint8Array(await new Response(new Blob([Uint8Array.from(atob(files[name]), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const jsUrls = {};
// A blob URL is no base for the runtime's relative lookups, so each module believes it sits in
// _framework beside this page; every lookup is then answered by name through the loader.
const base = JSON.stringify(new URL('_framework/', location.href).href);
for (const name of Object.keys(files)) if (name.endsWith('.js')) {
  const text = new TextDecoder().decode(await raw(name)).replaceAll('import.meta.url', base.slice(0, -1) + name + '"');
  jsUrls[name] = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
}
const { dotnet } = await import(jsUrls['dotnet.js']);
const runtime = await dotnet.withResourceLoader((type, name) => {
  if (jsUrls[name]) return jsUrls[name];
  if (!files[name]) return undefined;
  return raw(name).then(bytes => new Response(bytes, { headers: { 'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } }));
}).create();
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
window.nendoHost = exports.Host;
const answer = exports.Host.Invoke(JSON.stringify({ method: 'session.getSnapshot' }));
window.nendoProbe = { answer: JSON.parse(answer), startMs: Math.round(performance.now() - started) };
document.getElementById('out').textContent = answer + '\\nstartMs=' + window.nendoProbe.startMs;
`;

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Nendo browser host</title></head>
<body>
<pre id="out">Starting…</pre>
<script type="application/json" id="nendo-runtime">${JSON.stringify({ files, config })}</script>
<script type="module">${boot}</script>
</body>
</html>
`;
writeFileSync(out, html);
console.log(out, html.length);
