import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// W-173: a text field presented as Markdown reads formatted on a record page, and stored text
// never becomes markup: every character is escaped before a tag is added.
const { markdownMarkup } = await bundleOf('src/markdown.ts');
const { fieldControlMarkup, recordSheetMarkup } = await bundleOf('src/record-markup.ts');

test('the subset AI-written text uses reads formatted', () => {
  const markup = markdownMarkup([
    '# Findings', '', 'The **first** run was *slow*, and `npm test` took ~~ten~~ two minutes.', '',
    '- one', '- two', '', '3. three', '4. four', '', '> quoted', '', '```', 'const a = 1 < 2;', '```', '',
    '| Lane | Result |', '| --- | ---: |', '| unit | passed |', '', '---',
  ].join('\n'));
  assert.match(markup, /<h3>Findings<\/h3>/);
  assert.match(markup, /<strong>first<\/strong>/);
  assert.match(markup, /<em>slow<\/em>/);
  assert.match(markup, /<code>npm test<\/code>/);
  assert.match(markup, /<del>ten<\/del>/);
  assert.match(markup, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(markup, /<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/);
  assert.match(markup, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(markup, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(markup, /<th>Lane<\/th><th style="text-align:right">Result<\/th>/);
  assert.match(markup, /<td>unit<\/td><td style="text-align:right">passed<\/td>/);
  assert.match(markup, /<hr>/);
});

test('stored text never becomes markup, and a link is not followed', () => {
  const markup = markdownMarkup([
    '<script>alert(1)</script>', '', '<img src=x onerror=alert(1)>', '',
    '[click](javascript:alert(1)) and [quote]("onmouseover=alert(1)) and ![chart](https://example.test/a.png)',
    '', '`<b>code</b>`', '', '| <i>x</i> |', '| --- |', '| <u>y</u> |',
  ].join('\n'));
  // The only tags are the renderer's own.
  const tags = new Set([...markup.matchAll(/<\/?([a-z0-9]+)/g)].map(match => match[1]));
  for (const tag of tags) assert.ok(['p', 'span', 'code', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(tag), `unexpected <${tag}> in ${markup}`);
  for (const [tag] of markup.matchAll(/<[^>]+>/g)) assert.doesNotMatch(tag.replace(/"[^"]*"/g, '""'), /\b(href|src|on\w+)=/i, tag);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /<span class="markdown-link" title="javascript:alert\(1\)">click<\/span>/);
  assert.match(markup, /title="&quot;onmouseover=alert\(1\)"/);
  assert.match(markup, /<span class="markdown-image" title="https:\/\/example.test\/a.png">chart<\/span>/);
  assert.match(markup, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
});

const field = (presentation, extra = {}) => ({ semanticId: 'notes', displayName: 'Notes', presentation, retired: false, required: false, storageKind: 0, options: [], choices: [], ...extra });

test('a markdown field shows its text formatted with its source a control of the form', () => {
  const markup = fieldControlMarkup(field('markdown'), '## Plan\n\n- **ship** it');
  assert.match(markup, /<div class="markdown-body"><h4>Plan<\/h4><ul><li><strong>ship<\/strong> it<\/li><\/ul><\/div>/);
  assert.match(markup, /<details class="markdown-source"><summary>Edit Notes as Markdown<\/summary><textarea name="notes" rows="8"/);
  assert.match(markup, />## Plan\n\n- \*\*ship\*\* it<\/textarea>/);
  // Nothing to read yet: the source is open, so a required field is never hidden from the browser.
  const empty = fieldControlMarkup(field('markdown', { required: true }), '');
  assert.doesNotMatch(empty, /markdown-body/);
  assert.match(empty, /<details class="markdown-source" open><summary>Write Notes as Markdown/);
  assert.match(empty, /required/);
});

test('a record sheet treats a markdown field as long text', () => {
  const sheet = recordSheetMarkup('Note', null, [field('singleLine', { semanticId: 'title', displayName: 'Title' }), field('markdown')], [],
    { backId: 'back', backLabel: 'Back', heading: 'New note', headingId: 'heading', submitLabel: 'Save' });
  assert.match(sheet, /<div class="record-sheet-long">[\s\S]*markdown-source/);
  assert.match(sheet, /<div class="record-sheet-title">[\s\S]*name="title"/);
});

test('Structure offers long text as Markdown and back, and nothing else', async () => {
  const { presentationToggleMarkup } = await bundleOf('src/field-presentation.ts');
  const text = (presentation, extra = {}) => ({ fieldId: 'notes', displayName: 'Notes', storageKind: 'text', presentation, retired: false, ...extra });
  assert.match(presentationToggleMarkup({ retired: false }, text('longText')), /data-presentation="markdown"[^>]*>Show as Markdown</);
  assert.match(presentationToggleMarkup({ retired: false }, text('markdown')), /data-presentation="longText"[^>]*>Show as long text</);
  assert.equal(presentationToggleMarkup({ retired: false }, text('singleLine')), '');
  assert.equal(presentationToggleMarkup({ retired: false }, text('singleChoice')), '');
  assert.match(presentationToggleMarkup({ retired: true }, text('longText')), /disabled/);
});

test('a heading shift moves every heading, inside a quote too, and stops at h6 (ADR-0027)', () => {
  assert.match(markdownMarkup('# One\n## Two'), /<h3>One<\/h3><h4>Two<\/h4>/);
  assert.match(markdownMarkup('## Two\n\n> ## Quoted', { headingShift: 1 }), /<h3>Two<\/h3><blockquote><h3>Quoted<\/h3><\/blockquote>/);
  assert.match(markdownMarkup('###### Six', { headingShift: 1 }), /<h6>Six<\/h6>/);
});
