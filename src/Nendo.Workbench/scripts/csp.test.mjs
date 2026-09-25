import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'vite';

// The Workbench document's own boundary (ADR-0013). Its content-security policy keeps it local
// and gains exactly one thing for custom views, frames from view origins; and the Workbench
// refuses to start inside a frame, so no view can hold a second copy of it.
const expected = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src https://*.example";

test('the Workbench document’s content-security policy is exactly the expected one', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const policies = [...html.matchAll(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g)].map((match) => match[1]);
  assert.equal(policies.length, 1, 'The document carries more or fewer than one policy.');
  assert.equal(policies[0], expected);
  const directives = Object.fromEntries(policies[0].split(';').map((directive) => directive.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives['frame-src'], ['https://*.example'], 'Frames are allowed from somewhere other than view origins.');
  assert.deepEqual(directives['connect-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.equal(directives['child-src'], undefined);
});

test('the Workbench refuses to start inside a frame, before any other module has run', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const firstImport = main.split('\n').find((line) => /^import\s/.test(line));
  assert.equal(firstImport, "import './frame-guard';", 'Something runs before the guard that stops a framed Workbench.');

  const top = { document: { documentElement: { dataset: {} }, body: { replaceChildren() { throw new Error('A top-level Workbench was cleared.'); } } } };
  top.top = top;
  globalThis.window = top;
  try {
    const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/frame-guard.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
    const { refuseFraming } = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));
    assert.equal(top.document.documentElement.dataset.framed, undefined, 'A Workbench that is its own top was refused.');
    let cleared = false;
    const framed = { top: {}, document: { documentElement: { dataset: {} }, body: { replaceChildren() { cleared = true; } } } };
    assert.throws(() => refuseFraming(framed), /does not run inside a frame/);
    assert.equal(framed.document.documentElement.dataset.framed, 'refused');
    assert.ok(cleared, 'A framed Workbench left its page in place.');
  } finally {
    delete globalThis.window;
  }
});
