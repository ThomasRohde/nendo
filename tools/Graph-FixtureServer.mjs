import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Two origins for one custom-view package, as a package meets them in Nendo (ADR-0013):
//  - the view origin serves the package folder the way the host serves a package from a file,
//    with /_nendo/api.js from the Workbench build (src/Nendo.Workbench/dist/_nendo/api.js);
//  - the broker origin serves Graph-FixtureBroker.html, which frames the view origin and
//    answers it from fixture data as the Workbench's broker does.
// argv[2] is where to write {pid, viewOrigin, brokerUrl}; argv[3] names the package folder,
// relative to this file, defaulting to the offline dependency graph.
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..');
const packageRoot = path.resolve(here, process.argv[3] ?? '../extensions/dependency-graph');
const apiPath = path.join(repository, 'src', 'Nendo.Workbench', 'dist', '_nendo', 'api.js');
const protocol = await fs.readFile(path.join(repository, 'src', 'Nendo.Workbench', 'src', 'extension-api', 'protocol.ts'), 'utf8');
const apiVersion = Number(/export const apiVersion = (\d+);/.exec(protocol)?.[1]);
if (!Number.isInteger(apiVersion)) throw new Error('protocol.ts no longer declares apiVersion as a number.');
await fs.access(apiPath).catch(() => { throw new Error(`The view API is not built: ${apiPath}. Run npm --prefix src/Nendo.Workbench run build.`); });
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'nendo-package.json'), 'utf8'));
if (typeof manifest.packageId !== 'string' || typeof manifest.title !== 'string') throw new Error('nendo-package.json names no packageId and title.');
const entryPoint = manifest.entryPoint ?? 'index.html';
const brokerPage = await fs.readFile(path.join(here, 'Graph-FixtureBroker.html'), 'utf8');
if (!brokerPage.includes("'__FIXTURE_CONFIG__'")) throw new Error('Graph-FixtureBroker.html has no configuration placeholder.');

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};
const textual = type => type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml';

// The headers the host sends on a view origin: the media type, no-store and nosniff.
function send(response, status, type, body) {
  response.writeHead(status, {
    'Content-Type': textual(type) ? `${type}; charset=utf-8` : type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

// A package file, read afresh on every request. `/` is the entry point; `_nendo/` belongs to
// the host; the manifest is never served, because the package row holds it, not a file.
async function serveView(request, response) {
  const name = decodeURIComponent(new URL(request.url, 'http://view').pathname).replace(/^\/+/, '') || entryPoint;
  if (name === '_nendo/api.js') return send(response, 200, 'text/javascript', await fs.readFile(apiPath));
  const segments = name.split('/');
  if (segments[0].toLowerCase() === '_nendo' || name === 'nendo-package.json' ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.') || segment.includes('\\')))
    return send(response, 404, 'text/plain', 'Not found');
  try {
    const body = await fs.readFile(path.join(packageRoot, ...segments));
    return send(response, 200, types[path.extname(name).toLowerCase()] ?? 'application/octet-stream', body);
  } catch {
    return send(response, 404, 'text/plain', 'Not found');
  }
}

function serveBroker(request, response, config) {
  const pathname = new URL(request.url, 'http://broker').pathname;
  if (pathname === '/' || pathname === '/broker.html')
    return send(response, 200, 'text/html', brokerPage.replace("'__FIXTURE_CONFIG__'", JSON.stringify(config)));
  if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return undefined; }
  return send(response, 404, 'text/plain', 'Not found');
}

function listen(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => { if (!response.headersSent) send(response, 500, 'text/plain', 'The fixture failed.'); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let config = null;
const view = await listen(serveView);
const broker = await listen((request, response) => serveBroker(request, response, config));
const viewOrigin = `http://127.0.0.1:${view.address().port}`;
const brokerOrigin = `http://127.0.0.1:${broker.address().port}`;
config = {
  viewOrigin,
  viewUrl: `${viewOrigin}/${entryPoint.split('/').map(encodeURIComponent).join('/')}`,
  apiVersion,
  packageId: manifest.packageId,
};
const info = { pid: process.pid, viewOrigin, brokerOrigin, brokerUrl: `${brokerOrigin}/broker.html`, packageId: manifest.packageId };
if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(info));
console.log(JSON.stringify(info));
setTimeout(() => { view.close(); broker.close(); }, 10 * 60 * 1000).unref();
