// What the built pages say, held to what they must say. check-links.mjs owns the
// references; this owns the rest of what a reader, a screen reader, a link preview or
// a version cut sees in dist/, plus the few source facts the site copies from the
// repository. Each failure names the defect in plain words and the page it is on.
import fs from 'node:fs/promises';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const dist = path.join(siteRoot, 'dist');
const SITE = 'https://thomasrohde.github.io';
const BASE = '/nendo';

const problems = [];
const fail = message => problems.push(message);

const htmlFiles = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'pagefind') await walk(full); continue; }
    if (entry.name.endsWith('.html')) htmlFiles.push({ full, served: '/' + path.relative(dist, full).split(path.sep).join('/') });
  }
}
try { await walk(dist); } catch { throw new Error(`No built site at ${dist}. Run the build first.`); }
const pages = new Map();
for (const file of htmlFiles) pages.set(file.served, await fs.readFile(file.full, 'utf8'));
const read = name => fs.readFile(path.join(repoRoot, name), 'utf8');

// Text a reader sees: no scripts, styles, comments or code blocks.
const prose = html => html
  .replace(/<script\b[\s\S]*?<\/script>/g, '')
  .replace(/<style\b[\s\S]*?<\/style>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<pre\b[\s\S]*?<\/pre>/g, '');
const text = html => prose(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// SITE-03. An inline element glued to the word before or after it: HTML whitespace
// compression turned "are\n<strong>not</strong>" into "arenot".
for (const [served, html] of pages) {
  const body = prose(html).replace(/<(\/?\w+)\b[^>]*>/g, '<$1>');
  const glued = [
    ...body.matchAll(/([^\s<>]{0,20}[A-Za-z0-9,;:])<(code|strong|em|a)>([^<]{0,20})/g),
    ...body.matchAll(/([^<>]{0,20})<\/(code|strong|em|a)>([A-Za-z0-9(][^\s<]{0,15})/g),
  ].map(match => match[0].replace(/<[^>]+>/g, ''));
  for (const sample of glued.slice(0, 5)) fail(`${served}: no space between a word and an inline element, so it reads "${sample.trim()}"`);
}

// SITE-23. Japanese text on an English page must say it is Japanese, or a screen
// reader reads the kanji in the English voice.
for (const [served, html] of pages) {
  const body = prose(html);
  const all = [...body.matchAll(/[\u3040-\u30ff\u3400-\u9fff]+/g)].length;
  const marked = [...body.matchAll(/<span lang="ja"[^>]*>[\u3040-\u30ff\u3400-\u9fff]+<\/span>/g)].length;
  if (all !== marked) fail(`${served}: ${all - marked} run(s) of Japanese text are not marked lang="ja", so a screen reader reads them in the English voice`);
}

// SITE-24. A guide's list of guides is a navigation landmark, and the page's own
// title is its first heading.
for (const [served, html] of pages) {
  if (!/^\/docs\/[^/]+\/index\.html$/.test(served)) continue;
  if (!/<nav\b[^>]*aria-label="Guides"/.test(html)) fail(`${served}: the list of guides is not a navigation landmark named Guides`);
  const first = prose(html).match(/<h([1-6])\b/);
  if (first?.[1] !== '1') fail(`${served}: the first heading is an h${first?.[1] ?? '?'}, not the page title's h1`);
}

// SITE-21. Every page names a share image that exists, a large-image card has one,
// and the 404 page, served for every missing URL, claims no address of its own.
for (const [served, html] of pages) {
  const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  const card = html.match(/<meta name="twitter:card" content="([^"]+)"/)?.[1];
  if (!image) {
    fail(`${served}: no og:image, so a link preview has no picture${card === 'summary_large_image' ? ' although the card asks for a large one' : ''}`);
  } else {
    const local = image.startsWith(`${SITE}${BASE}/`) ? image.slice(SITE.length + BASE.length) : null;
    if (local === null) fail(`${served}: og:image ${image} is not on this site`);
    else await fs.access(path.join(dist, local)).catch(() => fail(`${served}: og:image ${image} is not in the build`));
  }
  if (served === '/404.html') {
    if (/rel="canonical"/.test(html)) fail('/404.html: the not-found page declares a canonical URL, /nendo/404/, which is itself a 404');
    if (/property="og:url"/.test(html)) fail('/404.html: the not-found page declares an og:url of its own');
  }
}

// SITE-17. Version facts come from the files that decide them, and a change to those
// files deploys the site.
const productVersion = (await read('Directory.Build.props')).match(/<Version>([^<]+)<\/Version>/)?.[1];
const dotnetSdk = JSON.parse(await read('global.json')).sdk.version;
const expectFact = (served, pattern, expected, what) => {
  const html = pages.get(served);
  const found = html ? text(html).match(pattern)?.[1] : undefined;
  if (found !== expected) fail(`${served}: ${what} reads ${found ?? 'nothing'}, but the repository says ${expected}. If the guide writes the {{fact}} token, the content cache is stale: clear site/.astro and site/node_modules/.astro and build again`);
};
expectFact('/index.html', /v(\d+\.\d+\.\d+) for Windows/, productVersion, 'the version badge');
expectFact('/docs/roadmap/index.html', /The current version is (\d+\.\d+\.\d+)/, productVersion, 'the roadmap\'s current version (Directory.Build.props)');
expectFact('/docs/getting-started/index.html', /global\.json \((\d+\.\d+\.\d+)/, dotnetSdk, 'the .NET SDK (global.json)');
for (const [served, html] of pages) {
  if (/\{\{\w+\}\}/.test(text(html))) fail(`${served}: a {{fact}} token reached the page unreplaced`);
}
const workflow = await read('.github/workflows/pages.yml');
for (const input of ['Directory.Build.props', 'global.json']) {
  if (!new RegExp(`^\\s*-\\s*'${input.replace(/\./g, '\\.')}'\\s*$`, 'm').test(workflow)) {
    fail(`.github/workflows/pages.yml: a push that changes only ${input} does not deploy the site, though the site prints what it says`);
  }
}

// SITE-16. ADR-0018: the Status page reproduces the roadmap's Not qualified table,
// one row for each of its areas, rather than summarising rows away.
const roadmap = await read('docs/roadmap.md');
const notQualified = roadmap.split(/^## Not qualified\s*$/m)[1]?.split(/^## /m)[0] ?? '';
const roadmapAreas = [...notQualified.matchAll(/^\| ([^|]+?) \| [^|]/gm)].map(match => match[1]).filter(area => area !== 'Area' && !/^-+$/.test(area));
// A roadmap area the Status page names in plainer words goes here as roadmap: status.
const renamed = {};
const statusHtml = pages.get('/status/index.html') ?? '';
const statusAreas = new Set([...statusHtml.matchAll(/<td[^>]*><strong[^>]*>([^<]+)<\/strong><\/td>/g)].map(match => match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'")));
if (roadmapAreas.length === 0) fail('docs/roadmap.md: no rows found under "## Not qualified"');
for (const area of roadmapAreas) {
  if (!statusAreas.has(renamed[area] ?? area)) fail(`/status/: the Not qualified table drops the roadmap's "${area}" row`);
}

// SITE-19 and SITE-20. The committed captures are exactly the set the capture lane
// takes, and a page shows each of them.
const captureSet = JSON.parse(await fs.readFile(path.join(siteRoot, 'src/capture-set.json'), 'utf8')).names;
const expected = new Set(captureSet.flatMap(name => [`${name}-light.png`, `${name}-dark.png`]));
const committed = new Set((await fs.readdir(path.join(siteRoot, 'src/assets/screenshots'))).filter(name => name.endsWith('.png')));
for (const file of committed) if (!expected.has(file)) fail(`site/src/assets/screenshots/${file} is not in src/capture-set.json, so no capture run refreshes it`);
for (const file of expected) if (!committed.has(file)) fail(`site/src/assets/screenshots/${file} is missing; run tools/Capture-SiteScreenshots.ps1 -UpdateSite`);
const allHtml = [...pages.values()].join('\n');
for (const file of committed) {
  const stem = file.replace(/\.png$/, '');
  if (!allHtml.includes(`/_astro/${stem}.`)) fail(`site/src/assets/screenshots/${file} is committed and shipped, but no page shows it`);
}

// SITE-14. The no-script dark theme repeats the [data-theme="dark"] tokens under
// prefers-color-scheme; the two copies must not drift apart.
const tokens = await fs.readFile(path.join(siteRoot, 'src/styles/tokens.css'), 'utf8');
const block = pattern => tokens.match(pattern)?.[1].replace(/\s+/g, ' ').trim();
const explicitDark = block(/:root\[data-theme="dark"\] \{([^}]*)\}/);
const deviceDark = block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{([^}]*)\}/);
if (!explicitDark || explicitDark !== deviceDark) fail('src/styles/tokens.css: the dark tokens for a page with no script differ from the [data-theme="dark"] tokens');

if (problems.length === 0) {
  console.log(`check-dist: ${pages.size} page(s) say what they must.`);
} else {
  console.error(`check-dist: ${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 80)) console.error(`  ${problem}`);
  process.exitCode = 1;
}
