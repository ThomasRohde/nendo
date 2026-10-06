import test from 'node:test';
import assert from 'node:assert/strict';
import { render, escape } from '../../extensions/garden/render.mjs';

const resolve = target => target.toLowerCase() === 'how links work' || target === 'how-links-work' ? { recordId: 'gd.note.how-links-work', title: 'How links work' } : null;

test('blocks: headings, paragraphs, lists with checkboxes, quotes, rules and fences', () => {
  const html = render(['# Title', '', 'One line', 'same paragraph', '', '- [ ] open', '- [x] done', '- plain', '', '1. first', '2. second', '', '> quoted', '', '---', '', '```js', 'const a = "<b>";', '```'].join('\n'));
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<p>One line same paragraph</p>'));
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled> open</li>'));
  assert.ok(html.includes('<li class="task done"><input type="checkbox" disabled checked> done</li>'));
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'));
  assert.ok(html.includes('<blockquote>quoted</blockquote>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>'));
});

test('wikilinks resolve to anchors carrying the record ID, or are marked missing', () => {
  const html = render('See [[How links work]], [[how-links-work|alias]] and [[Nowhere]].', { resolve });
  assert.ok(html.includes('<a class="wikilink" href="#" data-target="How links work" data-id="gd.note.how-links-work">How links work</a>'));
  assert.ok(html.includes('data-id="gd.note.how-links-work">alias</a>'));
  assert.ok(html.includes('<a class="wikilink missing" href="#" data-target="Nowhere">Nowhere</a>'));
});

test('tags become anchors, headings do not, and inline code keeps its text', () => {
  const html = render('#garden rules `#notatag [[nolink]]` **bold** *it* ~~gone~~ [site](https://example.org) [bad](javascript:alert(1))');
  assert.ok(html.includes('<a class="tag" href="#" data-tag="garden">#garden</a>'));
  assert.ok(html.includes('<code>#notatag [[nolink]]</code>'));
  assert.ok(html.includes('<strong>bold</strong>'), html);
  assert.ok(html.includes('<em>it</em>'));
  assert.ok(html.includes('<del>gone</del>'));
  assert.ok(html.includes('<a href="https://example.org" rel="noopener" target="_blank">site</a>'));
  assert.ok(!html.includes('href="javascript:') && html.includes('[bad](javascript:alert(1))'), 'an unsafe scheme is never an href: it stays text');
});

test('a body is text, never markup', () => {
  const html = render('<script>alert(1)</script> [[<b>x</b>]] #<i>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('data-target="&lt;b&gt;x&lt;/b&gt;"'));
  assert.equal(escape('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});
