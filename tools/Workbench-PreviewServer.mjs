// Serves the built Workbench (src/Nendo.Workbench/dist) on a free loopback port, for a browser
// lane that drives it with ?preview=1: the browser preview host answers every request from a
// script, so the page runs without Nendo. Writes {pid, url} to the path given once it listens.
//   node tools/Workbench-PreviewServer.mjs <info.json>
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const infoPath = process.argv[2];
if (!infoPath) throw new Error('Name the file to write the address to.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Nendo.Workbench', 'dist');
await fs.access(path.join(root, 'index.html')).catch(() => { throw new Error(`The Workbench is not built: ${root}. Run npm --prefix src/Nendo.Workbench run build.`); });

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await fs.writeFile(infoPath, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/` }), 'utf8');
});
