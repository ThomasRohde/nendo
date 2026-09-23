// The brand marks live in docs/assets/brand/ and the browser tab icon is the
// application's own. This copies them beside the site instead of committing a
// second copy of a multi-megabyte PNG, so each stays edited in one place. Both
// destinations are git-ignored and rebuilt on every dev run and every build.
import fs from 'node:fs/promises';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');

const brandSource = path.join(repoRoot, 'docs', 'assets', 'brand');
const brandTarget = path.join(siteRoot, 'src', 'assets', 'brand');
const videoTarget = path.join(siteRoot, 'public', 'brand');

async function copy(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
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

// Earlier builds copied document images to public/repo-docs; remove any leftover.
await fs.rm(path.join(siteRoot, 'public', 'repo-docs'), { recursive: true, force: true });

console.log('sync-repo-assets: 4 brand file(s).');
