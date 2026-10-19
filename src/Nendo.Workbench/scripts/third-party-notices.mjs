import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The licence notices the Workbench bundle owes its readers. The bundle carries AG Grid
// Community and the packages it brings (MIT) and Lucide's icon paths (ISC), and both licences
// require their notice in every copy. The minified bundle keeps none, so the build writes this
// text beside it as dist/THIRD-PARTY-NOTICES.txt, which the Desktop project copies into the
// payload with the rest of dist. Not a test: vite.config.ts emits it and verify:dependencies and
// scripts/third-party-notices.test.mjs hold it to the lockfile.

/** The packages the bundle can carry: every lockfile entry that is not a development one. */
export function productionPackages(workbenchRoot) {
  const lock = JSON.parse(readFileSync(join(workbenchRoot, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.startsWith('node_modules/') && entry.dev !== true)
    .map(([path, entry]) => ({ name: path.slice('node_modules/'.length), version: entry.version, license: entry.license ?? 'unknown', path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function licenceText(directory) {
  const file = readdirSync(directory).find((name) => /^(licen[cs]e|copying)(\.(txt|md))?$/i.test(name));
  if (file === undefined) throw new Error(`${directory} has no licence file to carry into the notices.`);
  return readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n').trim();
}

function section(title, text) {
  return `${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n\n${text}\n`;
}

/** The whole notices file: Nendo's own licence, then each production package's, then Lucide's. */
export function thirdPartyNotices(root) {
  const workbenchRoot = typeof root === 'string' ? root : fileURLToPath(root);
  const repository = join(workbenchRoot, '..', '..');
  const parts = [
    'Nendo Workbench: licences of the software in this folder.\n\nThe Workbench bundle (assets/index-*.js) contains code from the packages below, and its icons are drawn from Lucide. Each licence requires its notice to travel with every copy.\n',
    section('Nendo', readFileSync(join(repository, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim()),
  ];
  for (const pkg of productionPackages(workbenchRoot))
    parts.push(section(`${pkg.name} ${pkg.version} (${pkg.license})`, licenceText(join(workbenchRoot, pkg.path))));
  parts.push(section('Lucide icons (ISC), the icon paths in src/icons.ts', readFileSync(join(workbenchRoot, 'LICENSE.lucide.txt'), 'utf8').replace(/\r\n/g, '\n').trim()));
  return parts.join('\n');
}

/** What the notices are missing, as sentences; empty when every licence is carried. */
export function missingNotices(workbenchRoot, text) {
  const missing = [];
  for (const pkg of productionPackages(workbenchRoot)) {
    if (!text.includes(`${pkg.name} ${pkg.version}`)) missing.push(`${pkg.name} ${pkg.version} is not named`);
    else if (!text.includes(licenceText(join(workbenchRoot, pkg.path)))) missing.push(`${pkg.name}'s licence text is not carried`);
  }
  if (!text.includes(readFileSync(join(workbenchRoot, 'LICENSE.lucide.txt'), 'utf8').replace(/\r\n/g, '\n').trim())) missing.push("Lucide's ISC licence is not carried");
  if (!text.includes(readFileSync(join(workbenchRoot, '..', '..', 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim())) missing.push("Nendo's own licence is not carried");
  return missing;
}
