import { defineConfig, type Plugin } from 'vite';
import { thirdPartyNotices } from './scripts/third-party-notices.mjs';

// The licences of what the bundle carries, beside it: AG Grid Community and its packages
// (MIT) and Lucide's icon paths (ISC) both require their notice in every copy, and the minified
// bundle keeps none. The Desktop project copies dist into the payload, so the installer ships it.
const thirdPartyNoticesFile: Plugin = {
  name: 'nendo-third-party-notices',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: thirdPartyNotices(new URL('.', import.meta.url)) });
  },
};

export default defineConfig({
  base: './',
  plugins: [thirdPartyNoticesFile],
  build: {
    // The offline Workbench intentionally carries its pinned AG Grid runtime in one local asset.
    chunkSizeWarningLimit: 800,
    emptyOutDir: true,
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
  },
});
