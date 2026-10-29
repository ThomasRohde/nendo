/**
 * A custom view's frame where the host cannot serve the package from an origin of its own: the
 * browser host and an exported page (ADR-0035, ADR-0036). The frame runs without allow-same-origin,
 * so it has an opaque origin and no reach into the page. It is handed every file of its package;
 * this loader makes each one a blob URL inside the frame, rewrites relative module specifiers onto
 * one fixed base so an import map sends them to those blobs, answers `fetch` of a package path from
 * them, sends a script, stylesheet, picture, sound or worker given a package path while the view
 * runs to its blob, and writes the package's entry document in place. `/_nendo/api.js` is the view
 * API.
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
  // A package file the view asks for while it runs: a script, stylesheet, picture or sound given
  // its address after the document was written, as a property or an attribute.
  const packaged = (value) => { const k = keyOf(String(value), entryPoint); return k && urls[k] ? urls[k] : null; };
  const redirect = (type, property) => {
    const own = type && Object.getOwnPropertyDescriptor(type.prototype, property);
    if (!own || !own.set) return;
    Object.defineProperty(type.prototype, property, { ...own, set(value) { own.set.call(this, packaged(value) ?? value); } });
  };
  redirect(window.HTMLScriptElement, 'src');
  redirect(window.HTMLLinkElement, 'href');
  redirect(window.HTMLImageElement, 'src');
  redirect(window.HTMLMediaElement, 'src');
  redirect(window.HTMLSourceElement, 'src');
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const attribute = String(name).toLowerCase();
    const loads = (attribute === 'src' && !(this instanceof HTMLIFrameElement)) || (attribute === 'href' && this instanceof HTMLLinkElement);
    const url = loads ? packaged(value) : null;
    return nativeSetAttribute.call(this, name, url ?? value);
  };
  // A worker started from a package file. An import map does not reach into a worker, so its
  // modules are copied with each relative specifier pointing straight at the copy it names, and a
  // prelude answers fetch and importScripts of package paths there as the frame does.
  const direct = Object.create(null);
  const directUrl = (path, seen) => {
    if (direct[path]) return direct[path];
    if (!/\\.m?js$/.test(path) || seen.has(path)) return urls[path];
    seen.add(path);
    const code = text(files[path]).replace(moduleSpecifiers, (m, head, q, spec) => {
      const k = keyOf(spec, path);
      return k && files[k] ? head + q + directUrl(k, seen) + q : m;
    });
    return (direct[path] = blob(code, 'text/javascript'));
  };
  const prelude = (path) => 'const u=' + JSON.stringify(urls) + ',B=' + JSON.stringify(BASE) + ',P=' + JSON.stringify(path) + ';'
    + 'const k=(s)=>{try{const x=new URL(String(s),B+P);return x.href.startsWith(B)?decodeURIComponent(x.pathname.slice(1)):null}catch{return null}};'
    + 'const m=(s)=>{const p=k(s);return p&&u[p]?u[p]:s};const f=self.fetch.bind(self);'
    + 'self.fetch=(i,o)=>{const r=typeof i==="string"?i:i instanceof URL?i.href:i.url;const t=m(r);return f(t===r?i:t,o)};'
    + 'if(typeof importScripts==="function"){const s=importScripts;self.importScripts=(...a)=>s(...a.map(m))}\\n';
  // A module worker does not start in an opaque origin, so it starts as a classic worker that
  // imports its module, holding the messages that arrive before the module has run.
  const holdUntil = (url) => 'const q=[],h=(e)=>{q.push(e);e.stopImmediatePropagation()};self.addEventListener("message",h);'
    + 'import(' + JSON.stringify(url) + ').then(()=>{self.removeEventListener("message",h);'
    + 'for(const e of q)self.dispatchEvent(new MessageEvent("message",{data:e.data,ports:[...e.ports]}))},(e)=>setTimeout(()=>{throw e}));';
  const worker = (url, options) => {
    const path = keyOf(url instanceof URL ? url.href : String(url), entryPoint);
    if (!path || !files[path]) return [url, options];
    if (options && options.type === 'module')
      return [blob(prelude(path) + holdUntil(directUrl(path, new Set())), 'text/javascript'), { ...options, type: 'classic' }];
    return [blob(prelude(path) + text(files[path]), 'text/javascript'), options];
  };
  for (const name of ['Worker', 'SharedWorker']) {
    const Native = window[name];
    if (typeof Native !== 'function') continue;
    window[name] = class extends Native { constructor(url, options) { super(...worker(url, options)); } };
  }
  const entry = files[entryPoint];
  if (!entry) { document.body.textContent = 'This view has no entry document.'; return; }
  let html = text(entry).replace(/(\\s(?:src|href)=)(["'])([^"']+)\\2/g, (m, attr, q, value) => { const k = keyOf(value, entryPoint); return k && urls[k] ? attr + q + urls[k] + q : m; });
  const map = '<script type="importmap">' + JSON.stringify({ imports }) + '<' + '/script>';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + map) : map + html;
  document.open(); document.write(html); document.close();
})();`;
