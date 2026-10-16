import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// The Markdown field's editor (Tiptap, 2026-10-16) stores Markdown that markdown.ts draws. What it
// reads and writes back must draw the same, and text must stay the text that was typed.
const { markdownManager, writtenMarkdown } = await bundleOf('src/markdown-editor-kit.ts', { withPackages: true });
const { markdownMarkup } = await bundleOf('src/markdown.ts');

const manager = markdownManager();
const roundTrip = source => writtenMarkdown(manager, manager.parse(source));
const sha = 'a'.repeat(64);

test('every construct markdown.ts reads draws the same after the editor writes it back', () => {
  for (const source of [
    '# Findings\n\nThe **first** run was *slow*, and `npm test` took ~~ten~~ two minutes.',
    '- one\n- two', '3. three\n4. four', '- item\n  - nested\n- next', '> quoted',
    '```\nconst a = 1 < 2;\n```', '| Lane | Result |\n| --- | ---: |\n| unit | passed |', '---',
    '[click](https://example.org/a?b=1&c=2)', 'line one  \nline two', '\\*not em\\*', 'file_name and [brackets]',
    '**bold _nested_ text**', 'Plain paragraph.\n\nSecond paragraph.', `![The chart](media:${sha})`,
  ]) {
    const written = roundTrip(source);
    assert.equal(markdownMarkup(written), markdownMarkup(source), `${JSON.stringify(source)} came back as ${JSON.stringify(written)}`);
  }
});

test('text is written as typed: no HTML entities, and HTML stays text', () => {
  // Tiptap encoded these as entities, which markdown.ts then showed literally (a &amp; b).
  assert.equal(roundTrip('a & b < c > d'), 'a & b < c > d');
  // Raw HTML is text in markdown.ts. Node has no DOM, so Tiptap keeps it as text here whatever the
  // reader does; the reader's rule is measured in a browser by Gate-WorkbenchShell's editor check.
  assert.equal(roundTrip('<b>bold?</b> and <script>alert(1)</script>'), '<b>bold?</b> and <script>alert(1)</script>');
});

test('a picture keeps the address it was named by', () => {
  assert.equal(roundTrip(`Before\n\n![The same leaf in autumn](media:${sha})`), `Before\n\n![The same leaf in autumn](media:${sha})`);
  assert.equal(roundTrip('![scan](C:\\Scans\\a.png)'), '![scan](C:\\Scans\\a.png)');
});
