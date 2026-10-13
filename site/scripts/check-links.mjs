// Every internal reference in the built site must resolve: a page, a file beside it,
// or an anchor that exists on the page it points at.
//
// A rendered page is still a valid page when one link inside it goes nowhere, so
// nothing else notices. The guides link to each other and into the site's own pages
// by absolute path under the base, and this is what holds those links to the build.
// It reads href, src and every srcset candidate; resolves a relative reference against
// the page it is on; checks a same-page '#anchor' against that page's own ids; and
// refuses a link to a page that leaves off the trailing slash, which GitHub Pages
// answers with a 301 redirect before the page loads.
//
// The content layer caches a rendered guide by its source digest. If a change seems
// not to reach this check locally, clear both `site/.astro` and
// `site/node_modules/.astro`; a CI checkout has neither.
//
// scripts/check-links.test.mjs runs this over a small broken build of its own.
import fs from 'node:fs/promises';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const dist = path.resolve(process.argv[2] ?? path.join(siteRoot, 'dist'));
const BASE = '/nendo';
const ORIGIN = 'https://site.invalid';

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

// The URL a built file is served at: dist/docs/agents/index.html is /nendo/docs/agents/.
const pageUrl = served => `${BASE}${served.replace(/(^|\/)index\.html$/, '$1')}`;

// dist/ is what is served at the base path, so the base prefix is not part of the
// file path on disk. Returns the file and whether it is a directory's index page.
const resolveTarget = urlPath => {
  if (urlPath !== BASE && !urlPath.startsWith(`${BASE}/`)) return null;
  const stripped = urlPath.slice(BASE.length).replace(/\/$/, '');
  for (const [candidate, directory] of [[`${stripped}/index.html`, true], [`${stripped}.html`, false], [stripped, false]]) {
    const normalised = candidate.replace(/\/{2,}/g, '/');
    if (allFiles.has(normalised)) return { file: normalised, directory };
  }
  return null;
};

const decode = value => value.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
// A malformed escape such as %E0%A4 is a broken link to report, not a reason to stop.
const unescape = value => { try { return decodeURIComponent(value); } catch { return null; } };
const problems = [];
let checked = 0;
for (const [served, html] of pages) {
  const here = new URL(pageUrl(served), ORIGIN);
  const references = [];
  // A script builds markup in strings of its own; those are not references. Its own
  // src is, so the tag stays and only its body goes.
  const markup = html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/g, '<script$1></script>').replace(/<!--[\s\S]*?-->/g, '');
  for (const [, tag, attributes] of markup.matchAll(/<(\w+)\b([^>]*)>/g)) {
    for (const [, attribute, value] of attributes.matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
      const urls = attribute === 'srcset'
        ? value.split(',').map(candidate => candidate.trim().split(/\s+/)[0]).filter(Boolean)
        : [value];
      for (const url of urls) references.push({ tag: tag.toLowerCase(), attribute, raw: decode(url) });
    }
  }

  for (const { tag, attribute, raw } of references) {
    if (raw === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    checked += 1;
    if (raw.startsWith('#')) {
      const anchor = unescape(raw.slice(1));
      if (anchor === null) { problems.push(`${served} -> ${raw} — the anchor has a malformed % escape`); continue; }
      if (anchor !== '' && !idsByPage.get(served).has(anchor)) {
        problems.push(`${served} -> ${raw} — this page has no element with id "${anchor}"`);
      }
      continue;
    }
    const url = new URL(raw, here);
    const pathname = unescape(url.pathname);
    const anchor = url.hash ? unescape(url.hash.slice(1)) : '';
    if (pathname === null || anchor === null) { problems.push(`${served} -> ${raw} — the link has a malformed % escape`); continue; }
    const target = resolveTarget(pathname);
    if (target === null) {
      problems.push(`${served} -> ${raw} — no such page or file in the build`);
      continue;
    }
    if (tag === 'a' && attribute === 'href' && target.directory && !url.pathname.endsWith('/')) {
      problems.push(`${served} -> ${raw} — links to a page without the trailing slash; GitHub Pages answers ${url.pathname} with a 301 redirect to ${url.pathname}/`);
    }
    if (anchor && target.file.endsWith('.html') && !idsByPage.get(target.file)?.has(anchor)) {
      problems.push(`${served} -> ${raw} — ${target.file} has no element with id "${anchor}"`);
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
