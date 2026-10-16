import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { missingNotices, thirdPartyNotices } from './third-party-notices.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const lockText = await readFile(new URL('../package-lock.json', import.meta.url), 'utf8');

const productionDependencies = Object.keys(manifest.dependencies ?? {});
// AG Grid for Studio's grids (ADR-0015); Tiptap and the Markdown reader it uses for the Markdown
// field's editor (ADR-0017's amendment of 2026-10-16), each pinned to an exact version.
const expectedDependencies = ['@tiptap/core', '@tiptap/extension-image', '@tiptap/extension-table', '@tiptap/markdown', '@tiptap/pm', '@tiptap/starter-kit', 'ag-grid-community', 'marked'];

if (JSON.stringify(productionDependencies) !== JSON.stringify(expectedDependencies)) {
  throw new Error(
    `Production dependencies must be exactly ${expectedDependencies.join(', ')}; found ${productionDependencies.join(', ') || 'none'}.`,
  );
}

const forbiddenTokens = [
  ['ag-grid', 'enterprise'].join('-'),
  'react',
  'react-dom',
];

for (const token of forbiddenTokens) {
  if (lockText.toLowerCase().includes(`node_modules/${token}`)) {
    throw new Error(`Forbidden Workbench dependency detected: ${token}`);
  }
}

// Every licence the bundle owes, in the notices the build writes beside it (WST-02).
const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));
const missing = missingNotices(workbenchRoot, thirdPartyNotices(workbenchRoot));
if (missing.length > 0) {
  throw new Error(`dist/THIRD-PARTY-NOTICES.txt would not carry every licence the bundle owes: ${missing.join('; ')}.`);
}

for (const name of productionDependencies) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.dependencies[name])) throw new Error(`${name} is not pinned to one version: ${manifest.dependencies[name]}.`);
}

console.log('Workbench dependency boundary verified: AG Grid Community and the Markdown editor (Tiptap, marked), pinned; no React or Enterprise package; every production licence is in the notices.');
