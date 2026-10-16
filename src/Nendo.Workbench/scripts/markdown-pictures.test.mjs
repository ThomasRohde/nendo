import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// W-271 (ADR-0031): an image in a Markdown field shows its picture when its address is a media
// address and the caller gives the file's pictures. Every other address stays its alt text.
const { markdownMarkup } = await bundleOf('src/markdown.ts');

const origin = 'https://media-0123456789abcdef.example';
const sha = 'a'.repeat(64);
const pictures = { origin, loadWeb: true };

test('an embedded picture shows from the media origin', () => {
  const markup = markdownMarkup(`Before\n\n![The chart](media:${sha})`, { pictures });
  assert.match(markup, new RegExp(`<span class="markdown-picture"><img src="${origin}/m/${sha}" alt="The chart" loading="lazy" decoding="async" data-media-thumb /><span class="markdown-picture-missing">Picture not found: The chart</span></span>`));
  assert.doesNotMatch(markup, /markdown-image/);
});

test('a web picture shows while web pictures load, and its address shows otherwise', () => {
  const on = markdownMarkup('![chart](https://example.test/a.png)', { pictures });
  assert.match(on, /<img src="https:\/\/example.test\/a.png" alt="chart"/);
  const off = markdownMarkup('![chart](https://example.test/a.png)', { pictures: { origin, loadWeb: false } });
  assert.match(off, /<span class="markdown-image" title="https:\/\/example.test\/a.png">chart<\/span>/);
  assert.doesNotMatch(off, /<img/);
});

test('a linked file shows through the origin, with its address escaped once', () => {
  const markup = markdownMarkup('![scan](C:\\Scans\\a&b.png)', { pictures });
  const src = /<img src="([^"]+)"/.exec(markup)?.[1];
  assert.ok(src, markup);
  assert.equal(src.replace(/&amp;/g, '&'), `${origin}/f/?a=${encodeURIComponent('C:\\Scans\\a&b.png')}`);
});

test('no other address becomes a source', () => {
  for (const address of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://example.test/a.png', '\\\\server\\share\\a.png', 'media:short']) {
    const markup = markdownMarkup(`![x](${address})`, { pictures });
    assert.doesNotMatch(markup, /<img/, address);
  }
});

test('without the file\'s pictures, or with no origin, an embedded picture is its alt text', () => {
  assert.doesNotMatch(markdownMarkup(`![x](media:${sha})`), /<img/);
  assert.doesNotMatch(markdownMarkup(`![x](media:${sha})`, { pictures: { origin: null, loadWeb: true } }), /<img/);
  // The renderer's option does not leak into the next call.
  markdownMarkup(`![x](media:${sha})`, { pictures });
  assert.doesNotMatch(markdownMarkup(`![x](media:${sha})`), /<img/);
});

test('alt text with markup stays text', () => {
  const markup = markdownMarkup(`![<b>bold</b> "q"](media:${sha})`, { pictures });
  assert.match(markup, /alt="&lt;b&gt;bold&lt;\/b&gt; &quot;q&quot;"/);
});

test('a Markdown picture is fitted to the column with tokens only', () => {
  const css = readFileSync(new URL('../src/styles/23-media.css', import.meta.url), 'utf8');
  const rule = /\.markdown-picture img \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /max-width: 100%/);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,6}\b/i);
});
