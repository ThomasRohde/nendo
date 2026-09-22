// Every internal reference in the built site must resolve: a page, a file beside it,
// or an anchor that exists on the page it points at.
//
// This exists because the repository documents link to each other as files, and the
// rewriter that turns those into routes can be wrong in a way nothing else notices —
// a rendered page is still a valid page when one link inside it goes nowhere. The
// first run of this check found `docs/design/adr-0008-dependencies.lock.json`
// rewritten to a copied asset that the sync step never copies, because it copies
// images and the rewriter was sending any data file.
//
// One caveat when changing the rewriter: the content layer caches a rendered document
// by its source digest, so editing the plugin alone leaves the previous HTML in place
// and this check reads it. Falsifying this guard needed BOTH `site/.astro` and
// `site/node_modules/.astro` removed — with only the first cleared, the build passed
// against the defect. A CI checkout has neither, so this only bites locally.
import fs from 'node:fs/promises';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const dist = path.resolve(process.argv[2] ?? path.join(siteRoot, 'dist'));
const BASE = '/nendo';

const htmlFiles = [];
const allFiles = new Set();
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    const served = '/' + path.relative(dist, full).split(path.sep).join('/');
    allFiles.add(served);
    if (entry.name.endsWith('.html')) htmlFiles.push({ full, served });
  }
}
try {
  await walk(dist);
} catch {
  throw new Error(`No built site at ${dist}. Run the build first.`);
}
if (htmlFiles.length === 0) throw new Error(`No pages under ${dist}.`);

const pages = new Map();
const idsByPage = new Map();
for (const file of htmlFiles) {
  const html = await fs.readFile(file.full, 'utf8');
  pages.set(file.served, html);
  idsByPage.set(file.served, new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])));
}

// dist/ is what is served at the base path, so the base prefix is not part of the
// file path on disk.
const resolveTarget = url => {
  const stripped = url.startsWith(BASE) ? url.slice(BASE.length) || '/' : url;
  for (const candidate of [`${stripped}.html`, `${stripped}/index.html`, stripped]) {
    const normalised = candidate.replace(/\/{2,}/g, '/');
    if (allFiles.has(normalised)) return normalised;
  }
  return null;
};

const problems = [];
let checked = 0;
for (const [pageUrl, html] of pages) {
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:)/i.test(raw)) continue;
    if (!raw.startsWith('/')) continue;
    checked += 1;
    const [pathPart, anchor] = raw.split('#');
    const withoutTrailingSlash = pathPart.replace(/\/$/, '') || '/';
    const target = resolveTarget(
      withoutTrailingSlash === BASE || withoutTrailingSlash === '/' ? `${BASE}/index.html` : withoutTrailingSlash,
    );
    if (target === null) {
      problems.push(`${pageUrl} -> ${raw} — no such page or file in the build`);
      continue;
    }
    if (anchor && target.endsWith('.html') && !idsByPage.get(target)?.has(anchor)) {
      problems.push(`${pageUrl} -> ${raw} — ${target} has no element with id "${anchor}"`);
    }
  }
}

console.log(`Checked ${checked} internal reference(s) across ${pages.size} page(s).`);
if (problems.length === 0) {
  console.log('Every internal reference resolves.');
} else {
  console.error(`${problems.length} broken internal reference(s):`);
  for (const problem of problems.slice(0, 80)) console.error(`  ${problem}`);
  if (problems.length > 80) console.error(`  … and ${problems.length - 80} more.`);
  process.exitCode = 1;
}
