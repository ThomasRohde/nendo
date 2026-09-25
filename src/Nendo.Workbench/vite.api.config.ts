import { defineConfig } from 'vite';

// The in-frame client a custom view loads (ADR-0013), built on its own as one classic
// script: the host serves dist/_nendo/api.js at /_nendo/api.js on every view origin. It runs
// after the Workbench build, into the same folder, so it must not empty it. Left readable,
// because a view's author meets it in the view's own DevTools, but without the Workbench's
// source comments, which describe the Workbench rather than the API.
export default defineConfig({
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
