/**
 * A custom view's frame where the host cannot serve the package from an origin of its own: the
 * browser host and an exported page (ADR-0035, ADR-0036). The frame runs without allow-same-origin,
 * so it has an opaque origin and no reach into the page. It is handed every file of its package;
 * this loader makes each one a blob URL inside the frame, rewrites relative module specifiers onto
 * one fixed base so an import map sends them to those blobs, answers `fetch` of a package path from
 * them, and writes the package's entry document in place. `/_nendo/api.js` is the view API.
 */

/** Package files as the host hands them over: path to media type and base64 content. */
export type ViewPackageFiles = Record<string, { mediaType: string; base64: string }>;

/** The sandbox of such a frame: a view frame's, less the same origin. */
export function opaqueFrameSandbox(sandbox: string): string {
  return sandbox.split(' ').filter((token) => token !== 'allow-same-origin').join(' ');
}

/** The document a frame starts from: the package, the view API and the loader. */
export function viewFrameDocument(files: ViewPackageFiles, entryPoint: string, api: string): string {
  const payload = JSON.stringify({ files, entryPoint, api }).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><script type="application/json" id="p">${payload}</script><script>${frameLoader}</script>`;
}

const frameLoader = `(() => {
  const { files, entryPoint, api } = JSON.parse(document.getElementById('p').textContent);
  const BASE = 'https://package.nendo-view.invalid/';
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const text = (file) => new TextDecoder().decode(bytes(file.base64));
  const urls = Object.create(null);
  const keyOf = (spec, from) => { try { const u = new URL(spec, BASE + from); return u.href.startsWith(BASE) ? decodeURIComponent(u.pathname.slice(1)) : null; } catch { return null; } };
  const moduleSpecifiers = /(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)(['"])(\\.{1,2}\\/[^'"]+)\\2/g;
  const cssUrls = /url\\((['"]?)(?!data:|blob:|https?:|#)([^'")]+)\\1\\)/g;
  const paths = Object.keys(files);
  const blob = (body, type) => URL.createObjectURL(new Blob([body], { type }));
  for (const path of paths.filter((p) => !/\\.(m?js|css|html?)$/.test(p))) urls[path] = blob(bytes(files[path].base64), files[path].mediaType);
  for (const path of paths.filter((p) => /\\.css$/.test(p)))
    urls[path] = blob(text(files[path]).replace(cssUrls, (m, q, spec) => { const k = keyOf(spec, path); return k && urls[k] ? 'url(' + urls[k] + ')' : m; }), 'text/css');
  urls['_nendo/api.js'] = blob(api, 'text/javascript');
  for (const path of paths.filter((p) => /\\.m?js$/.test(p)))
    urls[path] = blob(text(files[path]).replace(moduleSpecifiers, (m, head, q, spec) => head + q + new URL(spec, BASE + path).href + q), 'text/javascript');
  const imports = {};
  for (const [path, url] of Object.entries(urls)) imports[BASE + path] = url;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const k = keyOf(raw, entryPoint);
    return nativeFetch(k && urls[k] ? urls[k] : input, init);
  };
  const entry = files[entryPoint];
  if (!entry) { document.body.textContent = 'This view has no entry document.'; return; }
  let html = text(entry).replace(/(\\s(?:src|href)=)(["'])([^"']+)\\2/g, (m, attr, q, value) => { const k = keyOf(value, entryPoint); return k && urls[k] ? attr + q + urls[k] + q : m; });
  const map = '<script type="importmap">' + JSON.stringify({ imports }) + '<' + '/script>';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + map) : map + html;
  document.open(); document.write(html); document.close();
})();`;
