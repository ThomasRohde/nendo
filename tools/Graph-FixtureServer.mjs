import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// Serves one custom-view package's assets from disk for a browser measurement lane.
// argv[2] is where to write the server's {pid,url}; argv[3] names the package directory and
// argv[4] its assets, both defaulting to the offline dependency graph.
const directory = process.argv[3] ?? '../extensions/dependency-graph';
const names = (process.argv[4] ?? 'index.html,graph.js,graph.css').split(',');
const assets = new Map(await Promise.all(names.map(async name =>
  [name, await fs.readFile(fileURLToPath(new URL(directory.replace(/\/?$/, '/') + name, import.meta.url)))])));
const server = http.createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const name = request.url?.slice(1);
  if (!assets.has(name)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css', 'Cache-Control': 'no-store' });
  response.end(assets.get(name));
});
server.listen(0, '127.0.0.1', async () => {
  const info = { pid: process.pid, url: 'http://127.0.0.1:' + server.address().port };
  if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(info));
  console.log(JSON.stringify(info));
});
setTimeout(() => server.close(), 10 * 60 * 1000).unref();
