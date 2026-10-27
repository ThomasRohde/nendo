// Serves a folder as a static site on a free loopback port, as a web host would publish an exported
// page (ADR-0035): each folder's index.html answers its own address. Writes {pid, url} to the path
// given once it listens.
//   node tools/Serve-StaticSite.mjs <folder> <info.json>
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeInfoFile } from './info-file.mjs';

const [folder, infoPath] = process.argv.slice(2);
if (!folder || !infoPath) throw new Error('Name the folder to serve and the file to write the address to.');
const root = path.resolve(folder);

const types = { '.html': 'text/html; charset=utf-8', '.nendo': 'application/octet-stream' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const name = decodeURIComponent(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
  const file = path.resolve(root, '.' + name);
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
  await writeInfoFile(infoPath, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/` }));
});
