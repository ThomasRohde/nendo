import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// The broad review of 2026-10-10 on the Markdown subset (W-207): each case is one finding's input.
const { markdownMarkup } = await bundleOf('src/markdown.ts');
const balanced = (markup, tag) => (markup.match(new RegExp(`<${tag}>`, 'g')) ?? []).length === (markup.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;

test('WMX-02: thousands of nested quotes render, nested to a bound and then as typed', () => {
  const markup = markdownMarkup('>'.repeat(100_000) + ' x');
  assert.ok(markup.includes('x'), 'the quoted text is not shown');
  assert.ok((markup.match(/<blockquote>/g) ?? []).length <= 8, 'quotes nest without a bound');
});

test('WMX-06: an indented list nests under its item, a bullet under a numbered step too', () => {
  assert.equal(markdownMarkup('- Parent\n    - child one\n    - child two\n- Next'),
    '<ul><li>Parent<ul><li>child one</li><li>child two</li></ul></li><li>Next</li></ul>');
  assert.equal(markdownMarkup('- Parent\n  - child\n- Next'), '<ul><li>Parent<ul><li>child</li></ul></li><li>Next</li></ul>');
  assert.equal(markdownMarkup('1. Step one\n   - detail a\n   - detail b\n2. Step two'),
    '<ol><li>Step one<ul><li>detail a</li><li>detail b</li></ul></li><li>Step two</li></ol>');
});

test('WMX-07: a delimiter in an address never pairs with the text, and no tag lands in a tooltip', () => {
  for (const source of ['**Bold [link](https://x.y/a**b) rest', '[docs](https://example.com/_next/a_b_)', '[x](https://a/~~b~~)', '[__init__.py](pkg/__init__.py)']) {
    const markup = markdownMarkup(source);
    for (const tag of ['strong', 'em', 'del']) assert.ok(balanced(markup, tag), `${source}: unbalanced <${tag}> in ${markup}`);
    for (const [, title] of markup.matchAll(/title="([^"]*)"/g)) assert.doesNotMatch(title, /</, `${source}: a tag in the tooltip ${title}`);
  }
  assert.match(markdownMarkup('[**bold** label](https://a/b)'), /<span class="markdown-link" title="https:\/\/a\/b"><strong>bold<\/strong> label<\/span>/);
  // An image held inside a link's address was restored inside its tooltip, breaking the attribute.
  for (const source of ['[a](![b](c))', '![a](![b](c))']) {
    const markup = markdownMarkup(source);
    for (const [, title] of markup.matchAll(/title="([^"]*)"/g)) assert.doesNotMatch(title, /</, `${source}: markup in the tooltip: ${markup}`);
    assert.equal((markup.match(/<span/g) ?? []).length, (markup.match(/<\/span>/g) ?? []).length, `${source}: unbalanced spans: ${markup}`);
  }
  assert.ok(markdownMarkup('a\uE0001\uE001b').includes('&#xE000;'), 'a stored private-use character is dropped or read as held text');
});

test('WMX-08: a hash in a heading, a hard break, an escape and stray stars read as written', () => {
  assert.equal(markdownMarkup('# Learn C#'), '<h3>Learn C#</h3>');
  assert.equal(markdownMarkup('## Fix issue #'), '<h4>Fix issue</h4>', 'a closing run after a space still closes');
  assert.equal(markdownMarkup('line one  \nline two'), '<p>line one<br>line two</p>');
  assert.equal(markdownMarkup('Price 5\\*3 and \\*not em\\*'), '<p>Price 5*3 and *not em*</p>');
  assert.equal(markdownMarkup('**a **b'), '<p>**a **b</p>');
});

test('WMX-09: a line of unmatched delimiters renders in linear time', () => {
  for (const unit of ['**a ', '*a ', '_a ', '~~a ']) {
    const started = performance.now();
    markdownMarkup(unit.repeat(100_000 / unit.length * 4));
    const spent = performance.now() - started;
    assert.ok(spent < 500, `${JSON.stringify(unit)} x many took ${Math.round(spent)} ms`);
  }
});

test('WMX-13: Markdown blocks take their direction from their own text, with logical edges', () => {
  const css = readFileSync(new URL('../src/styles/10-forms.css', import.meta.url), 'utf8');
  const body = [...css.matchAll(/([^{}]*\.markdown-body[^{}]*)\{([^}]*)\}/g)];
  assert.ok(body.some(([, selector, rules]) => /\bp\b/.test(selector) && /\bli\b/.test(selector) && /unicode-bidi:\s*plaintext/.test(rules) && /text-align:\s*start/.test(rules)),
    'no .markdown-body block rule sets unicode-bidi: plaintext and text-align: start');
  for (const [, selector, rules] of body) assert.doesNotMatch(rules, /\b(padding|margin|border)-(left|right)\b/, `${selector.trim()} uses a physical edge`);
});
