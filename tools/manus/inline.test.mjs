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
  assert.deepEqual(markdownToInline('see [the map](https://example.org)', Lexer), [t('see [the map](https://example.org)')]);
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
