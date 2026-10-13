import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { missingNotices, thirdPartyNotices } from './third-party-notices.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const lockText = await readFile(new URL('../package-lock.json', import.meta.url), 'utf8');

const productionDependencies = Object.keys(manifest.dependencies ?? {});
const expectedDependencies = ['ag-grid-community'];

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

console.log('Workbench dependency boundary verified: AG Grid Community only; no React or Enterprise package; every production licence is in the notices.');
