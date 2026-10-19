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

test('a closed mermaid fence is a diagram figure holding its escaped source; other fences stay code', () => {
  const html = render(['```mermaid', 'flowchart LR', '  A["<b>"] --> B', '```', '', '```Mermaid', 'graph TD; X-->Y', '```', '', '```text', 'flowchart LR', '```'].join('\n'));
  assert.ok(html.includes('<figure class="diagram"><pre><code>flowchart LR\n  A[&quot;&lt;b&gt;&quot;] --&gt; B</code></pre></figure>'), html);
  assert.ok(html.includes('<figure class="diagram"><pre><code>graph TD; X--&gt;Y</code></pre></figure>'), 'the language is read without case');
  assert.equal(html.match(/<figure/g).length, 2, 'a text fence is not a diagram');
  assert.ok(!render('```mermaid\nflowchart LR\nA-->B').includes('<figure'), 'an unclosed fence, as in a cut hover preview, stays code');
  assert.ok(!render('```mermaid\n\n```').includes('<figure'), 'an empty fence is not a diagram');
  assert.ok(!render('```mermaid\n[[note]] #tag\n```').includes('<a '), 'nothing inside a diagram is a link or a tag');
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

test('emphasis pairs across inline code, and markup inside the code stays text', () => {
  const html = render('- **`src/Nendo.Engine`**: storage. *`a`* and ~~`b`~~ and `**not bold**`');
  assert.ok(html.includes('<li><strong><code>src/Nendo.Engine</code></strong>: storage.'), html);
  assert.ok(html.includes('<em><code>a</code></em>') && html.includes('<del><code>b</code></del>'), html);
  assert.ok(html.includes('<code>**not bold**</code>') && !html.replace('<code>**not bold**</code>', '').includes('**'), 'no asterisks are left outside code');
});

test('a body is text, never markup', () => {
  const html = render('<script>alert(1)</script> [[<b>x</b>]] #<i>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('data-target="&lt;b&gt;x&lt;/b&gt;"'));
  assert.equal(escape('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});

test('a heading ending in # keeps it, and a link whose words are code shows the code', () => {
  assert.ok(render('# Learning C#').includes('<h1>Learning C#</h1>'), `'# Learning C#' must keep its #: ${render('# Learning C#')}`);
  assert.ok(render('## Title ##').includes('<h2>Title</h2>'), 'a closing run after a space is still cut');
  const html = render('Run [`npm ci`](https://docs.npmjs.com/cli/ci) first.');
  assert.ok(html.includes('<a href="https://docs.npmjs.com/cli/ci" rel="noopener" target="_blank"><code>npm ci</code></a>'),
    `a link whose words are code must show the code, not a placeholder: ${JSON.stringify(html)}`);
  assert.ok(!html.includes('\u0000'), 'no placeholder is left in the HTML');
});

test('a box in a numbered list is text, not a box that ticks and saves nothing', () => {
  const html = render('1. [ ] Call Sam\n2. [x] Done', { interactive: true });
  assert.ok(!html.includes('<input'), `a numbered '[ ]' must not be drawn as a checkbox, since parse() makes no task of it: ${html}`);
  assert.ok(html.includes('<ol><li>[ ] Call Sam</li>'), html);
  assert.ok(render('- [ ] Call Sam', { interactive: true }).includes('data-line="0"'), 'a bullet task still ticks');
  assert.ok(!render('- [ ] ', { interactive: true }).includes('<input'), 'a box with no words is no task, as parse() reads it');
});

test('a body carrying U+0000 or self-referring code spans stays escaped text, and its HTML stays small', () => {
  const NUL = '\u0000';
  // A body that writes the placeholder form itself: inside a wikilink's target, a link's address, and a task's words.
  const forged = [
    `- [ ] \`<b>\` ${NUL}0${NUL} [[${NUL}0${NUL}]] [x](https://e.org/${NUL}0${NUL})`,
    `See [[\`"><img src=x onerror=alert(1)>\`]] and [\`<i>\`](https://e.org/\`a"b\`).`,
  ].join('\n');
  const html = render(forged, { resolve, interactive: true });
  assert.ok(!html.includes(NUL), `no U+0000 may be left in the HTML: ${JSON.stringify(html)}`);
  const attributes = [...html.matchAll(/\s[\w-]+="([^"]*)"/g)].map(m => m[1]);
  const marked = attributes.filter(value => /[<>]/.test(value));
  assert.deepEqual(marked, [], `an attribute value must never hold markup from the body: ${JSON.stringify(marked)} in ${html}`);
  assert.ok(!/<(b|i|img)[\s>]/.test(html), `the body's own tags must stay escaped text: ${html}`);
  // Code spans whose text is the placeholder form of the span before: once grew without bound.
  const chain = Array.from({ length: 40 }, (_, i) => `\`${NUL}${i}${NUL}${NUL}${i}${NUL}\``).join(' ');
  const grown = render(chain);
  assert.ok(!grown.includes(NUL) && grown.length < chain.length * 20, `self-referring code spans must render in bounded length: ${grown.length} characters from ${chain.length}`);
});
