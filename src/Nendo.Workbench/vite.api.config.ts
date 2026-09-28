import { defineConfig, type Plugin } from 'vite';
import { viewApiReference } from './src/extension-api/reference';

// The view API as an agent reads it before it writes a view's code (W-094), written beside
// api.js from the same tables. The local MCP embeds this file and serves it at
// nendo://application/view-api.
const viewApiReferenceFile: Plugin = {
  name: 'nendo-view-api-reference',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: '_nendo/view-api.json', source: `${JSON.stringify(viewApiReference())}\n` });
  },
};

// The in-frame client a custom view loads (ADR-0013), built on its own as one classic
// script: the host serves dist/_nendo/api.js at /_nendo/api.js on every view origin. It runs
// after the Workbench build, into the same folder, so it must not empty it. Left readable,
// because a view's author meets it in the view's own DevTools, but without the Workbench's
// source comments, which describe the Workbench rather than the API.
export default defineConfig({
  plugins: [viewApiReferenceFile],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    rolldownOptions: { output: { comments: false } },
    lib: {
      entry: 'src/extension-api/nendo-api.ts',
      formats: ['iife'],
      name: 'nendoApi',
      fileName: () => '_nendo/api.js',
    },
  },
});
