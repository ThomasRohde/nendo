import assert from 'node:assert/strict';
import test from 'node:test';
import { Lexer } from '../../extensions/manuscript/vendor/editor.js';
import { inlineToMarkdown, markdownToInline, pictureOf, pictureMarkdown } from '../../extensions/manuscript/inline.mjs';

const t = (text, ...marks) => marks.length ? { type: 'text', text, marks: marks.map(type => ({ type })) } : { type: 'text', text };
const roundTrip = content => markdownToInline(inlineToMarkdown(content), Lexer);

test('marked runs survive the round trip, nested and side by side', () => {
  const cases = [
    [t('plain words')],
    [t('a '), t('bold', 'bold'), t(' word')],
    [t('bold ', 'bold'), t('both', 'bold', 'italic'), t(' bold', 'bold')],
    [t('em', 'italic'), t('strong', 'bold')],
    [t('strong', 'bold'), t('em', 'italic')],
    [t('gone', 'strike'), t(' and '), t('x = 1', 'code')],
    [t('first line'), { type: 'hardBreak' }, t('second line')],
  ];
  for (const content of cases) assert.deepEqual(roundTrip(content), content, inlineToMarkdown(content));
});

test('a space at the edge of a marked run moves outside it, where Markdown can read the run', () => {
  assert.equal(inlineToMarkdown([t('ends in space ', 'italic'), t('next')]), '*ends in space* next');
  assert.deepEqual(roundTrip([t('ends in space ', 'italic'), t('next')]), [t('ends in space', 'italic'), t(' next')]);
});

test('characters Markdown would read as syntax come back as typed', () => {
  for (const text of ['2 * 3 * 4', 'snake_case_name', '# not a heading', '1. not a list', '- not a bullet', '> not a quote',
    'a <b>tag</b> stays text', '[not](a link)', 'back\\slash', 'tilde ~~ here', 'a & b; &amp; literal', 'quote "this"']) {
    assert.deepEqual(roundTrip([t(text)]), [t(text)], `${text} -> ${inlineToMarkdown([t(text)])}`);
  }
  assert.deepEqual(roundTrip([t('a `tick` inside', 'code')]), [t('a `tick` inside', 'code')]);
});

test('Markdown written elsewhere keeps its characters when it is not inline syntax', () => {
  assert.deepEqual(markdownToInline('see ![a map](https://example.org/map.png) here', Lexer), [t('see ![a map](https://example.org/map.png) here')]);
  assert.deepEqual(markdownToInline('one\n\ntwo', Lexer), [t('one'), { type: 'hardBreak' }, t('two')]);
  assert.deepEqual(markdownToInline('soft\nwrap', Lexer), [t('soft wrap')]);
  assert.deepEqual(markdownToInline('', Lexer), []);
});

test('a block that is one picture reads as that picture, and writes back as it was named', () => {
  const address = `media:${'0f'.repeat(32)}`;
  assert.deepEqual(pictureOf(`![Milo at the window](${address})`), { alt: 'Milo at the window', address });
  assert.deepEqual(pictureOf(pictureMarkdown('a [bracketed] alt', address)), { alt: 'a [bracketed] alt', address });
  assert.equal(pictureOf(`See ![x](${address}) here`), null);
  assert.equal(pictureOf('plain words'), null);
  assert.deepEqual(pictureOf('![](https://example.org/a.png)'), { alt: '', address: 'https://example.org/a.png' });
});

test('underline and highlight are kept as <u> and <mark>, outside the delimiters, and come back', () => {
  const cases = [
    [t('a '), t('line', 'underline'), t(' under')],
    [t('lit', 'highlight'), t(' up')],
    [t('mid'), t('word', 'underline', 'bold'), t('end')],
    [t('both', 'underline', 'highlight', 'italic')],
    [t('under ', 'underline'), t('and bold', 'underline', 'bold'), t(' then not')],
  ];
  for (const content of cases) assert.deepEqual(roundTrip(content), content, inlineToMarkdown(content));
  assert.equal(inlineToMarkdown([t('mid'), t('word', 'bold', 'underline'), t('end')]), 'mid<u>**word**</u>end');
  assert.equal(inlineToMarkdown([t('lit ', 'highlight'), t('up')]), '<mark>lit</mark> up');
});

test('a tag typed as text stays text, and one written elsewhere without its closing tag stays as written', () => {
  assert.deepEqual(roundTrip([t('type <u> and <mark> here')]), [t('type <u> and <mark> here')]);
  assert.deepEqual(markdownToInline('open <u>never closed', Lexer), [t('open <u>never closed')]);
  assert.deepEqual(markdownToInline('<U>upper</U> and <mark>**bold**</mark>', Lexer), [t('upper', 'underline'), t(' and '), t('bold', 'highlight', 'bold')]);
});

test('a link written [words](address) is a link with its marks, and comes back as written', () => {
  const link = (text, href, ...marks) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }, ...marks.map(type => ({ type }))] });
  const cases = [
    [t('see '), link('the tide table', 'https://example.org/tides'), t('.')],
    [link('bold link', 'https://a.example', 'bold'), t(' and '), link('other', 'https://b.example')],
    [link('one', 'https://a.example'), link('two', 'https://b.example')],
    [link('spaced', 'https://example.org/a b(c)')],
  ];
  for (const content of cases) assert.deepEqual(roundTrip(content), content, inlineToMarkdown(content));
  assert.equal(inlineToMarkdown(cases[0]), 'see [the tide table](https://example.org/tides).');
  // Written elsewhere, a bare address, an angle-bracket one and a titled link stay as their characters.
  for (const text of ['https://example.org', '<https://example.org>', '[titled](https://example.org "Title")'])
    assert.equal(markdownToInline(text, Lexer).some(n => n.marks?.some(m => m.type === 'link')), false, text);
});

test('a footnote is cited by its block ID, and the marks around it close before it and open after', () => {
  const fn = id => ({ type: 'footnote', attrs: { id } });
  const cases = [
    [t('The bar'), fn('b-fn1'), t(' was dry.')],
    [t('bold ', 'bold'), t('word', 'bold'), fn('b-fn2'), t(' still bold', 'bold')],
  ];
  assert.deepEqual(roundTrip(cases[0]), cases[0]);
  assert.equal(inlineToMarkdown(cases[0]), 'The bar[^b-fn1] was dry.');
  // A space at the edge of a marked run moves outside it, as everywhere else.
  assert.equal(inlineToMarkdown(cases[1]), '**bold word**[^b-fn2] **still bold**');
  assert.deepEqual(roundTrip(cases[1]), [t('bold word', 'bold'), fn('b-fn2'), t(' '), t('still bold', 'bold')]);
  // Typed by the person, the same characters are text, not a citation.
  assert.deepEqual(roundTrip([t('see [^b-x] here')]), [t('see [^b-x] here')]);
});
