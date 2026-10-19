import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// A proposal's changes to custom-view code (ADR-0013), rendered by the function both
// review screens use. Code is reviewed as its lines: each changed line marked, context
// kept, and a line of code never becoming markup however it is written.
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
  assert.match(markup, /Not shown as lines: it is not text, or it is longer than the review lays out line by line\./);
  assert.match(markup, /3 bytes → 4 bytes/);
  assert.match(markup, /The change continues past what the review shows\./);
});

// A proposal can change many files, and every file's lines shown open would bury the
// rest of the review. Each file is a disclosure that starts folded, and its summary row is
// an overview on its own: name, change, sizes and how many lines it adds and removes.
test('each file starts folded, and its summary says enough to choose which to open', async () => {
  const markup = packageChangesMarkup([replaced, { ...replaced, path: 'style.css' }]);
  const files = [...markup.matchAll(/<details class="package-change"([^>]*)>/g)];
  assert.equal(files.length, 2, 'each changed file should be its own disclosure');
  for (const [, attributes] of files) assert.doesNotMatch(attributes, /\bopen\b/, 'a file opened by default');
  const summary = markup.slice(markup.indexOf('<summary>'), markup.indexOf('</summary>'));
  assert.match(summary, /<strong>map\.js<\/strong>/);
  assert.match(summary, /Changed in org\.example\.map · 2 KB → 2\.1 KB · \+1 −1 lines/);
  assert.doesNotMatch(summary, /diff-line/, 'the lines themselves belong below the summary, folded');
  assert.match(markup, /<\/summary><div class="package-change-body"><pre class="package-hunk"/);
  const styles = (await import('node:fs')).readFileSync(new URL('../src/styles/08-panels.css', import.meta.url), 'utf8');
  assert.match(styles, /\.package-change > summary:focus-visible/, 'the folded file has no visible keyboard focus');
});

test('a proposal that touches no package says nothing about code', () => {
  assert.equal(packageChangesMarkup(undefined), '');
  assert.equal(packageChangesMarkup([]), '');
});

// A change longer than the review shows must not end with a sentence and nothing to read it by
// while Accept is live. Every file a proposal adds or replaces offers its
// whole proposed bytes, read from the proposal through the host and checked by digest.
const reader = await bundleOf('src/package-file-reader.ts');

test('every added or replaced file can be read whole, and a cut-short one says so folded', () => {
  const long = { ...replaced, truncated: true };
  const removed = { ...replaced, path: 'old.js', change: 'removed', hunks: [] };
  const markup = packageChangesMarkup([long, removed]);
  const files = markup.split('<details').slice(1);
  assert.match(files[0], /data-package-read="map\.js" data-package-id="org\.example\.map"/, 'A replaced file offers no way to read it whole.');
  assert.doesNotMatch(files[1], /data-package-read=/, 'A removed file has nothing proposed to read.');
  const summary = files[0].slice(0, files[0].indexOf('</summary>'));
  assert.match(summary, /longer than the review shows/, `The folded summary hides that the change is cut short: ${summary}`);
});

test('the windows are put together, checked by digest, and decoded as the proposal holds them', async () => {
  const text = 'const city = "Århus";\n'.repeat(30000);
  const bytes = new TextEncoder().encode(text);
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const asked = [];
  const host = (sha256) => async (method, payload) => {
    asked.push({ method, ...payload });
    const slice = bytes.slice(payload.offset, payload.offset + payload.length);
    return { proposalId: payload.proposalId, reviewedDigest: payload.reviewedDigest, packageId: payload.packageId, path: payload.path,
      mediaType: 'text/javascript', sha256, totalBytes: bytes.length, offset: payload.offset, content: Buffer.from(slice).toString('base64') };
  };
  const target = { proposalId: 'proposal-1', reviewedDigest: 'sha256:abc', packageId: 'org.example.map', path: 'map.js' };
  const file = await reader.readProposedFile(target, host(hex));
  assert.equal(file.text, text);
  assert.ok(asked.length > 1, 'A file past one window was read in one call.');
  assert.ok(asked.every(call => call.method === 'proposal.readPackageFile' && call.reviewedDigest === 'sha256:abc'), 'Every window must be bound to the reviewed digest.');
  await assert.rejects(reader.readProposedFile(target, host('0'.repeat(64))), /did not read back/, 'Bytes that do not match the digest must not be shown.');
  const shown = reader.proposedFileMarkup('map.js', { mediaType: 'text/javascript', sha256: hex, bytes: new Uint8Array(4), text: '<b>x</b>' });
  assert.match(shown, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(shown, /<b>x/);
  assert.match(shown, /data-copy/);
});

// A direction control reorders the line under review, so `"user\u202E \u2066// Check if
// admin\u2069 \u2066"` reads as a closed string and a comment while it runs as one literal.
// One character from each family the review must draw as its code point.
const hidden = ['\u061C', '\u200B', '\u200E', '\u202A', '\u202E', '\u2060', '\u2066', '\u2069', '\u206A', '\u180E',
  '\uFEFF', '\u{E0041}', '\u115F', '\u3164', '\uFFA0'];
const code = (character) => `[U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`;
const withLines = (lines, start = 17) => ({ ...replaced, hunks: [{ ...replaced.hunks[0], oldStart: start, newStart: start, lines }] });

test('hidden direction, format and filler characters are shown as code points, with a warning', () => {
  for (const character of hidden) {
    const text = `const access = "user${character} // Check if admin";`;
    const markups = [packageChangesMarkup([withLines([{ kind: 'added', text }])]),
      reader.proposedFileMarkup('map.js', { mediaType: 'text/javascript', bytes: new Uint8Array(4), sha256: 'a'.repeat(64), text })];
    for (const markup of markups) {
      assert.equal(markup.includes(character), false, `the review shows ${code(character)} raw`);
      assert.ok(markup.includes(code(character)), `${code(character)} is drawn as its code point`);
      assert.match(markup, /invisible or direction-changing characters/);
    }
    const summary = markups[0].slice(markups[0].indexOf('<summary>'), markups[0].indexOf('</summary>'));
    assert.match(summary, /hidden characters/, `the folded summary flags ${code(character)}`);
  }
  assert.doesNotMatch(packageChangesMarkup([replaced]), /hidden-char/, 'a file without them carries no warning');
});

test('a soft hyphen, a leading byte-order mark and a removed hidden line raise no warning', () => {
  assert.doesNotMatch(packageChangesMarkup([withLines([{ kind: 'added', text: 'const word = "co\u00ADoperate";' }])]), /hidden-char/);
  assert.doesNotMatch(packageChangesMarkup([withLines([{ kind: 'added', text: '\uFEFFconst first = 1;' }], 1)]), /hidden-char/,
    'a byte-order mark at the start of the file is encoding');
  assert.match(packageChangesMarkup([withLines([{ kind: 'added', text: 'x;\uFEFF' }], 1)]), /\[U\+FEFF\]/, 'one elsewhere is shown');
  const removed = packageChangesMarkup([withLines([{ kind: 'removed', text: 'a\u202Eb' }, { kind: 'added', text: 'ab' }])]);
  assert.doesNotMatch(removed, /hidden-char-note|hidden characters/, 'a change that removes them leaves no warning');
  assert.match(removed, /\[U\+202E\]/, 'the removed line still shows what it held');
});

// The same bytes put as text/html instead of text/plain become a page at the view's
// origin, so the review says what the file is served as.
test('a file whose media type alone changes says what it is served as now and was before', () => {
  const retyped = { ...replaced, path: 'index.html', mediaTypeBefore: 'text/plain', mediaTypeAfter: 'text/html', bytesAfter: 2048, hunks: [] };
  const markup = packageChangesMarkup([retyped]);
  const summary = markup.slice(markup.indexOf('<summary>'), markup.indexOf('</summary>'));
  assert.match(summary, /served as text\/html, was text\/plain/, 'the folded summary names both media types');
  assert.match(markup, /Served as text\/html instead of text\/plain\./);
  assert.doesNotMatch(packageChangesMarkup([replaced]), /[Ss]erved as/, 'a file keeping its media type says nothing about it');
});
