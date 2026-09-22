import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
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
