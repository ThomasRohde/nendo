import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// The Workbench as the browser host's page (ADR-0036): every script, stylesheet and picture is
// inlined, so the page opens from disk with nothing beside it. tools/Build-BrowserHost.ps1 then puts
// the .NET runtime and the view API into it.
const publicDir = new URL('./public/', import.meta.url);

// The runtime's modules and the views' files are blob URLs made in the page; WebAssembly is
// compiled from bytes the page carries; a view keeps the network it has in Nendo.
const contentSecurityPolicy = [
  "default-src 'none'",
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  "font-src data: blob:",
  "style-src 'unsafe-inline' blob:",
  "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'",
  "connect-src blob: data: https:",
  "worker-src blob:",
  "frame-src blob: data:",
  "form-action 'none'",
].join('; ');

function dataUrl(name: string, bytes: Uint8Array): string {
  const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

const inlineEverything: Plugin = {
  name: 'nendo-browser-host-inline',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const html = bundle['index.html'];
    if (html?.type !== 'asset') throw new Error('No index.html in the bundle.');
    const bytesOf = (name: string): Uint8Array => {
      const item = bundle[name];
      if (item?.type === 'asset') return typeof item.source === 'string' ? Buffer.from(item.source) : item.source;
      return readFileSync(new URL(name.replace(/^\//, ''), publicDir));
    };
    const pictures = (text: string): string =>
      text.replace(/(?:\.\/|\/)?(?:assets\/)?([\w.-]+\.(?:png|svg))/g, (match, file: string) => {
        const key = Object.keys(bundle).find((name) => name.endsWith(`/${file}`) || name === file);
        try { return dataUrl(file, bytesOf(key ?? `/${file}`)); } catch { return match; }
      });
    let page = String(html.source);
    page = page.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
      `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />`);
    page = page.replace(/<script\s+src="\/theme-boot\.js"><\/script>/,
      () => `<script>${readFileSync(new URL('theme-boot.js', publicDir), 'utf8')}</script>`);
    page = page.replace(/<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+\.css)"[^>]*>/g,
      (_match, name: string) => `<style>${pictures(Buffer.from(bytesOf(name)).toString('utf8'))}</style>`);
    page = page.replace(/<script type="module" crossorigin src="\.?\/?(assets\/[^"]+\.js)"><\/script>/g, (_match, name: string) => {
      const chunk = bundle[name];
      if (chunk?.type !== 'chunk') throw new Error(`No chunk ${name}.`);
      // Every chunk is inlined, so a dynamic import has nothing to preload: the helper's marker,
      // which Vite fills in only for chunks it emits, is given no dependencies.
      const code = chunk.code.replaceAll('__VITE_PRELOAD__', 'void 0').replaceAll('</script', '<\\/script');
      return `<script type="module">${code}</script>`;
    });
    page = page.replace(/(<(?:img|link)[^>]*(?:src|href)=")([^"]+\.png)"/g, (_match, head: string, file: string) => `${head}${pictures(file)}"`);
    html.source = page;
    for (const name of Object.keys(bundle)) if (name !== 'index.html') delete bundle[name];
  },
};

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [inlineEverything],
  build: {
    outDir: '../../artifacts/browser-host/page',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    // One inlined page has no chunks to preload, and the runtime's own import() is of a blob URL.
    modulePreload: false,
    rolldownOptions: { output: { inlineDynamicImports: true } },
  },
});
