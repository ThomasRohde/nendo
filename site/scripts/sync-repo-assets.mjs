// The brand marks and the images the rendered documents reference live in docs/.
// This copies them beside the site instead of committing a second copy of a
// multi-megabyte PNG, so docs/assets/ stays the one place they are edited. Both
// destinations are git-ignored and rebuilt on every dev run and every build.
import fs from 'node:fs/promises';
import path from 'node:path';
import { COPIED_ASSET_PATTERN, DOCS_PATTERN, EXCLUDED_DIRECTORIES, isRendered } from './docs-meta.mjs';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const docsRoot = path.join(repoRoot, 'docs');

const brandSource = path.join(docsRoot, 'assets', 'brand');
const brandTarget = path.join(siteRoot, 'src', 'assets', 'brand');
const videoTarget = path.join(siteRoot, 'public', 'brand');
const docAssetTarget = path.join(siteRoot, 'public', 'repo-docs');

async function copy(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function markdownFiles() {
  const found = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const relative = path.relative(docsRoot, full).replace(/\\/g, '/');
      if (isRendered(relative)) found.push({ full, relative });
    }
  }
  await walk(docsRoot);
  return found;
}

// astro:assets optimises what it can import from src/, so the two still images go
// there. A video is not an astro:assets input and is served from public/ as it is.
await fs.rm(brandTarget, { recursive: true, force: true });
for (const name of ['nendo.png', 'nendo-mark.png']) {
  await copy(path.join(brandSource, name), path.join(brandTarget, name));
}
await copy(path.join(brandSource, 'nendo.mp4'), path.join(videoTarget, 'nendo.mp4'));
// The browser tab icon is the application's own, derived from the same mark by
// tools/Build-NendoIcon.ps1.
await copy(path.join(repoRoot, 'src', 'Nendo.Desktop', 'Assets', 'AppIcon.ico'), path.join(siteRoot, 'public', 'favicon.ico'));

// Only the images the rendered documents actually reference, resolved against the
// document they appear in. Copying docs/assets/ whole would ship twenty megabytes
// of exploratory mockups no page links to.
await fs.rm(docAssetTarget, { recursive: true, force: true });
const wanted = new Set();
for (const { full, relative } of await markdownFiles()) {
  const markdown = await fs.readFile(full, 'utf8');
  const directory = path.dirname(path.join(docsRoot, relative));
  // Both an embedded image and a plain link to one: the link rewriter sends either at
  // the copied asset, so both have to be here or the site serves a link to nothing.
  for (const match of markdown.matchAll(/\]\(([^)\s]+)/g)) {
    const reference = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) continue;
    const withoutAnchor = reference.split('#')[0];
    if (!COPIED_ASSET_PATTERN.test(withoutAnchor)) continue;
    const resolved = path.resolve(directory, withoutAnchor);
    const fromDocs = path.relative(docsRoot, resolved).replace(/\\/g, '/');
    if (fromDocs.startsWith('..')) continue;
    if (EXCLUDED_DIRECTORIES.includes(fromDocs.split('/')[0])) continue;
    wanted.add(fromDocs);
  }
}
let copied = 0;
for (const relative of wanted) {
  const from = path.join(docsRoot, relative);
  try {
    await copy(from, path.join(docAssetTarget, relative));
    copied += 1;
  } catch {
    console.warn(`sync-repo-assets: ${relative} is referenced by a rendered document but is not in docs/.`);
  }
}
console.log(`sync-repo-assets: 4 brand file(s), ${copied} document image(s) from ${DOCS_PATTERN.length} pattern(s).`);
