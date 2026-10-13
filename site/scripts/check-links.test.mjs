// check-links.mjs is the build's last word on internal references, so it has to fail
// on each kind of broken one. This builds two tiny sites of its own, one sound and one
// with a broken reference of every kind, and runs the real script over each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const script = path.join(import.meta.dirname, 'check-links.mjs');

async function site(pages) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nendo-check-links-'));
  for (const [file, content] of Object.entries(pages)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

function check(root) {
  const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const page = body => `<!doctype html><html><body>${body}</body></html>`;
const concepts = page('<h2 id="reference">Reference</h2>');
const image = 'not really a picture';

test('a sound site passes', async () => {
  const root = await site({
    'index.html': page(`<h1 id="top">Home</h1>
      <a href="#top">top</a>
      <a href="/nendo/concepts/#reference">reference</a>
      <a href="concepts/">relative</a>
      <img src="/nendo/_astro/shot.webp" srcset="/nendo/_astro/shot.webp 1x, /nendo/_astro/shot.webp 2x">
      <script>const markup = '<a href="\${anything}">';</script>`),
    'concepts/index.html': concepts,
    '_astro/shot.webp': image,
  });
  try {
    const result = check(root);
    assert.equal(result.status, 0, `A site whose references all resolve was refused:\n${result.output}`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('each kind of broken reference fails the check', async () => {
  const root = await site({
    'index.html': page(`<h1 id="top">Home</h1>
      <a href="#nowhere">same page</a>
      <a href="../nope">relative</a>
      <img src="/nendo/_astro/shot.webp" srcset="/nendo/_astro/shot.webp 1x, /nendo/_astro/missing.webp 2x">
      <a href="/nendo/concepts">no slash</a>
      <a href="/nendo/concepts/#gone">cross-page anchor</a>
      <a href="/nendo/concepts/#%E0%A4">malformed escape</a>
      <script src="/nendo/_astro/missing.js"></script>`),
    'concepts/index.html': concepts,
    '_astro/shot.webp': image,
  });
  try {
    const result = check(root);
    assert.equal(result.status, 1, `A site with broken references passed:\n${result.output}`);
    assert.match(result.output, /#nowhere — this page has no element with id "nowhere"/,
      'A same-page link to an anchor that does not exist was not reported.');
    assert.match(result.output, /\.\.\/nope — no such page or file/,
      'A relative link to a page that does not exist was not reported.');
    assert.match(result.output, /missing\.webp — no such page or file/,
      'A srcset candidate that does not exist was not reported.');
    assert.match(result.output, /\/nendo\/concepts — links to a page without the trailing slash/,
      'A link that costs a redirect because it has no trailing slash was not reported.');
    assert.match(result.output, /#gone — \/concepts\/index\.html has no element with id "gone"/,
      'A link to a missing anchor on another page was not reported.');
    assert.match(result.output, /%E0%A4 — the link has a malformed % escape/,
      'A link with a malformed % escape was not reported (or stopped the check).');
    assert.match(result.output, /missing\.js — no such page or file/,
      'A script whose src does not exist was not reported.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
