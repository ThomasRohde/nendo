import { build } from 'vite';

// One module of the Workbench, bundled on its own for the server side and imported, so a test
// exercises the real code without a page. Not a test itself: npm test runs scripts/*.test.mjs.
export const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
