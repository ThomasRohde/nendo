import { readFile } from 'node:fs/promises';

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

console.log('Workbench dependency boundary verified: AG Grid Community only; no React or Enterprise package.');
