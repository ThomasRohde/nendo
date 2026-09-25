import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

// A proposal's changes to custom-view code (ADR-0013), rendered by the function both
// review screens use. Code is reviewed as its lines: each changed line marked, context
// kept, and a line of code never becoming markup however it is written.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { packageChangesMarkup } = await bundleOf('src/package-diff-markup.ts');

const replaced = {
  packageId: 'org.example.map', path: 'map.js', change: 'replaced', mediaTypeBefore: 'text/javascript', mediaTypeAfter: 'text/javascript',
  bytesBefore: 2048, bytesAfter: 2100, textual: true, truncated: false,
  hunks: [{ oldStart: 17, oldLines: 7, newStart: 17, newLines: 7, lines: [
    { kind: 'context', text: 'line 17;' },
    { kind: 'removed', text: 'line 20;' },
    { kind: 'added', text: "document.body.innerHTML = '<img src=x onerror=alert(1)>';" },
    { kind: 'context', text: 'line 21;' },
  ] }],
};

test('each changed line is marked and a line of code stays text', () => {
  const markup = packageChangesMarkup([replaced]);
  assert.match(markup, /data-testid="package-changes"/);
  assert.match(markup, /<strong>map\.js<\/strong>/);
  assert.match(markup, /Changed in org\.example\.map · 2 KB → 2\.1 KB/);
  assert.equal((markup.match(/class="diff-line diff-added"/g) ?? []).length, 1);
  assert.equal((markup.match(/class="diff-line diff-removed"/g) ?? []).length, 1);
  assert.equal((markup.match(/class="diff-line diff-context"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /<img/, 'A line of code became an element.');
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // Each line is a block of its own inside the <pre>; a newline between two of them is drawn
  // as an empty line, which double-spaced every hunk the first time it rendered.
  assert.doesNotMatch(markup, /<\/span>\s+<span class="diff-line/, 'Lines of a hunk are separated by whitespace the <pre> draws as blank lines.');
});

test('a binary file is said by its size, and a long change says it continues', () => {
  const binary = { ...replaced, path: 'tiles.bin', textual: false, hunks: [], bytesBefore: 3, bytesAfter: 4 };
  const long = { ...replaced, truncated: true };
  const markup = packageChangesMarkup([binary, long]);
  assert.match(markup, /Not text, so it is shown by its size\./);
  assert.match(markup, /3 bytes → 4 bytes/);
  assert.match(markup, /The change continues past what the review shows\./);
});

test('a proposal that touches no package says nothing about code', () => {
  assert.equal(packageChangesMarkup(undefined), '');
  assert.equal(packageChangesMarkup([]), '');
});
