// An exported page (ADR-0035): the browser host's page carrying one .nendo file, gzipped and base64,
// which the page opens as it starts. Usage:
//   node scripts/carry-file.mjs <browser host page> <file.nendo> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';

const [pagePath, filePath, out] = process.argv.slice(2);
if (!out) throw new Error('Usage: carry-file.mjs <browser host page> <file.nendo> <out.html>');

const page = readFileSync(pagePath, 'utf8');
const name = basename(filePath).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
const carried = `<script type="application/octet-stream" id="nendo-file" data-name="${name}">`
  + `${gzipSync(readFileSync(filePath), { level: 9 }).toString('base64')}</script>\n`;
// Before the module script, beside the runtime the page already carries.
const at = page.indexOf('<script type="module">');
if (at < 0) throw new Error('The browser host page has no module script.');
writeFileSync(out, page.slice(0, at) + carried + page.slice(at));
console.log(out, Buffer.byteLength(page) + Buffer.byteLength(carried));
