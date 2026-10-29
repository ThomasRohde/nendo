// Writes the page the browser host lane opens to measure what a view can load while it runs in a
// web page (ADR-0035): a probe package handed to the Workbench's own view frame loader, mounted in an
// opaque-origin frame with the view frame's sandbox, under the content-security policy the browser
// host page carries. The package asks for a script, a stylesheet, a picture and two workers only
// after its document is written, which is what views such as Envelope, Garden's diagrams and
// Dynamo's simulation do. The frame posts what loaded; Gate-BrowserHost.mjs reads it.
// Usage: node tools/View-FrameLoads.mjs <browser host page.html> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { opaqueFrameSandbox, viewFrameDocument } from '../src/Nendo.Workbench/src/view-frame-loader.ts';

const [runtimePage, out] = process.argv.slice(2);
if (!runtimePage || !out) throw Error('Usage: node tools/View-FrameLoads.mjs <browser host page.html> <out.html>');

const runtime = readFileSync(runtimePage, 'utf8');
const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(runtime)?.[1];
if (!policy) throw Error(`${runtimePage} carries no content-security policy.`);
const markup = readFileSync(new URL('../src/Nendo.Workbench/src/view-frame-markup.ts', import.meta.url), 'utf8');
const frameSandbox = /export const frameSandbox = '([^']+)'/.exec(markup)?.[1];
if (!frameSandbox) throw Error('view-frame-markup.ts names no frameSandbox.');

const main = `
const results = {};
const within = (promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(Error('timed out')), 5000))]);
const step = async (name, run) => { try { results[name] = await within(new Promise(run)); } catch (error) { results[name] = 'failed: ' + (error?.message ?? error); } };
await step('script property', (ok, no) => {
  const script = document.createElement('script');
  script.src = 'late.js';
  script.onload = () => ok(window.lateLoaded === 1 ? 'loaded' : 'ran nothing');
  script.onerror = () => no(Error('did not load'));
  document.head.append(script);
});
await step('script attribute', (ok, no) => {
  const script = document.createElement('script');
  script.setAttribute('src', 'more/late-two.js');
  script.onload = () => ok(window.lateTwo === 2 ? 'loaded' : 'ran nothing');
  script.onerror = () => no(Error('did not load'));
  document.head.append(script);
});
await step('stylesheet', (ok, no) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'late.css';
  link.onload = () => ok(getComputedStyle(document.body).getPropertyValue('--late').trim() === 'yes' ? 'loaded' : 'applied nothing');
  link.onerror = () => no(Error('did not load'));
  document.head.append(link);
});
await step('picture', (ok, no) => {
  const picture = new Image();
  picture.onload = () => ok(picture.naturalWidth === 1 ? 'loaded' : 'drew ' + picture.naturalWidth);
  picture.onerror = () => no(Error('did not load'));
  picture.src = 'dot.png';
});
await step('module worker', (ok, no) => {
  const worker = new Worker('worker.mjs', { type: 'module' });
  worker.onmessage = (event) => ok(event.data);
  worker.onerror = (event) => { event.preventDefault?.(); no(Error(event.message || 'worker error')); };
  // Sent before the module has run: a module worker still receives it.
  worker.postMessage('early');
});
await step('classic worker', (ok, no) => {
  const worker = new Worker('classic.js');
  worker.onmessage = (event) => ok(event.data);
  worker.onerror = (event) => { event.preventDefault?.(); no(Error(event.message || 'worker error')); };
});
parent.postMessage({ viewLoads: results }, '*');
`;
const text = (body, mediaType) => ({ mediaType, base64: Buffer.from(body).toString('base64') });
const files = {
  'index.html': text('<!doctype html><meta charset="utf-8"><title>Loads</title><script type="module" src="main.js"></script>', 'text/html'),
  'main.js': text(main, 'text/javascript'),
  'late.js': text('window.lateLoaded = 1;', 'text/javascript'),
  'more/late-two.js': text('window.lateTwo = 2;', 'text/javascript'),
  'late.css': text('body { --late: yes; }', 'text/css'),
  // A 1 by 1 PNG.
  'dot.png': { mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==' },
  'worker.mjs': text("import { answer } from './engine.mjs';\nconst data = await (await fetch('data.json')).json();\nself.onmessage = (event) => postMessage(answer + ' ' + data.n + ' ' + event.data);", 'text/javascript'),
  'engine.mjs': text("export const answer = 'engine';", 'text/javascript'),
  'data.json': text('{"n": 42}', 'application/json'),
  'classic.js': text("importScripts('helper.js');\nfetch('data.json').then((r) => r.json()).then((data) => postMessage(helperValue + ' ' + data.n));", 'text/javascript'),
  'helper.js': text("var helperValue = 'helper';", 'text/javascript'),
};

const document = viewFrameDocument(files, 'index.html', '// The probe uses no view API.');
const script = `
window.__viewLoads = null;
addEventListener('message', (event) => { if (event.data && event.data.viewLoads) window.__viewLoads = event.data.viewLoads; });
const frame = document.createElement('iframe');
frame.setAttribute('sandbox', ${JSON.stringify(opaqueFrameSandbox(frameSandbox))});
frame.srcdoc = ${JSON.stringify(document)};
document.body.append(frame);
`.replaceAll('</script', '<\\/script');
writeFileSync(out, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>View loads</title></head><body><script>${script}</script></body></html>`);
console.log(out);
