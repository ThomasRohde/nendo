import test from 'node:test';
import assert from 'node:assert/strict';
import { inline, inlineMarkdown, paragraphs, blocksMarkdown, linesMarkdown, rowCells, rows, table, parseFormat, formatText } from '../../extensions/deck/model.mjs';
import { readDoc, writeDoc, conform, slice, remove, insert, split, typed, marksAt, hasMark, setMark, wordAt, inward, trimLeads, withEdges, setKind, shiftLevel, toPlain, toHtml, clampPos, textOf } from '../../extensions/deck/textedit.mjs';

const plain = runs => runs.map(r => ({ text: r.text, ...(r.b ? { b: true } : {}), ...(r.i ? { i: true } : {}), ...(r.u ? { u: true } : {}), ...(r.code ? { code: true } : {}), ...(r.link ? { link: r.link } : {}) }));

test('inline marks nest, underline reads, and a backslash keeps a mark character as itself', () => {
  assert.deepEqual(plain(inline('**bold _both_** <u>under</u>')), [{ text: 'bold ', b: true }, { text: 'both', b: true, i: true }, { text: ' ' }, { text: 'under', u: true }]);
  assert.deepEqual(plain(inline('***all***')), [{ text: 'all', b: true, i: true }]);
  assert.deepEqual(plain(inline('2 \\* 3 \\_x\\_')), [{ text: '2 * 3 _x_' }]);
  assert.deepEqual(plain(inline('a * b')), [{ text: 'a * b' }]);
});

test('any runs written as inline Markdown read back as the same runs', () => {
  const cases = [
    [{ text: 'a' }, { text: 'b', b: true }, { text: 'c', b: true, i: true }, { text: 'd', i: true }, { text: 'e' }],
    [{ text: 'x', u: true }, { text: 'y', u: true, b: true }, { text: 'z', i: true, u: true }],
    [{ text: 'stars * and _under_ and [brackets] and `ticks` and <u> and \\' }],
    [{ text: 'site', link: 'https://example.com' }, { text: ' then ', b: true }, { text: 'code', code: true }],
    [{ text: 'trailing ', b: true }, { text: ' ' }],
  ];
  for (const runs of cases) assert.deepEqual(plain(inline(inlineMarkdown(runs))), runs, JSON.stringify(runs));
  assert.equal(inlineMarkdown([{ text: 'b', b: true }, { text: 'i', i: true }]), '**b**_i_');
  // An address with brackets keeps them, as %28 and %29, and its words lose nothing.
  const wiki = inline(inlineMarkdown([{ text: 'Function', link: 'https://en.wikipedia.org/wiki/Function_(mathematics)' }, { text: ' after' }]));
  assert.deepEqual(plain(wiki), [{ text: 'Function', link: 'https://en.wikipedia.org/wiki/Function_%28mathematics%29' }, { text: ' after' }]);
});

test('body paragraphs written as Markdown read back the same: lists, levels, headings, empty lines', () => {
  const doc = [
    { kind: 'heading', level: 0, runs: [{ text: 'Head' }] },
    { kind: 'bullet', level: 0, runs: [{ text: 'one ', b: true }] },
    { kind: 'bullet', level: 1, runs: [] },
    { kind: 'number', level: 0, runs: [{ text: 'first' }] },
    { kind: 'number', level: 0, runs: [{ text: 'second' }] },
    { kind: 'plain', level: 0, runs: [] },
    { kind: 'plain', level: 0, runs: [{ text: '- not a bullet' }] },
    { kind: 'plain', level: 0, runs: [{ text: '3. not a number' }] },
  ];
  const md = blocksMarkdown(doc);
  assert.match(md, /^### Head\n- \*\*one \*\*\n  -\n1\. first\n2\. second\n<br>\n/);
  const back = readDoc('blocks', md);
  assert.deepEqual(back.map(p => [p.kind, p.level, textOf(p)]), doc.map(p => [p.kind, p.level, textOf(p)]));
  assert.equal(writeDoc('blocks', back), md);
  assert.equal(blocksMarkdown([{ kind: 'plain', level: 0, runs: [] }]), '');
  assert.equal(paragraphs('a\nb').length, 1, 'a plain line under another continues it');
  assert.equal(paragraphs('a\n\nb').length, 2);
});

test('a title is one paragraph to a line, and a kicker takes no marks', () => {
  const title = readDoc('lines', 'Short **lines**\nread _faster_');
  assert.equal(title.length, 2);
  assert.equal(writeDoc('lines', title), 'Short **lines**\nread _faster_');
  assert.equal(linesMarkdown([{ runs: [] }]), '');
  const kicker = readDoc('plain', 'a **b**');
  assert.deepEqual(kicker[0].runs, [{ text: 'a **b**' }]);
  assert.equal(writeDoc('plain', kicker), 'a **b**');
});

test('row cells and table cells say where each one lies in the body', () => {
  const body = '- Alpha | **Beta** |  gamma\n\n  2. one|two';
  const cells = rowCells(body);
  assert.deepEqual(rows(body), [['Alpha', '**Beta**', 'gamma'], ['one', 'two']]);
  for (const row of cells) for (const c of row) assert.equal(body.slice(c.from, c.to), c.text);
  const t = '| A | B |\n|---|--:|\n| 1 | two |\n| 3 |';
  const read = table(t);
  assert.deepEqual([read.head, read.rows, read.align], [['A', 'B'], [['1', 'two'], ['3', '']], ['left', 'right']]);
  assert.equal(t.slice(read.at.head[1].from, read.at.head[1].to), 'B');
  assert.equal(t.slice(read.at.rows[0][1].from, read.at.rows[0][1].to), 'two');
  assert.equal(read.at.rows[1][1], null);
  // A cell emptied by the stage keeps its place, so the box being edited is still found.
  const emptied = c => [c.from, c.to];
  assert.deepEqual(rowCells('-  | Beta')[0].map(emptied), [[2, 2], [5, 9]], 'an emptied first cell');
  assert.deepEqual(rowCells('- a |  | c')[0].map(emptied), [[2, 3], [6, 6], [9, 10]], 'an emptied middle cell');
  assert.deepEqual(rowCells('- a | ')[0].map(emptied), [[2, 3], [6, 6]], 'an emptied last cell');
  assert.deepEqual(table('| A | B |\n|---|---|\n|  | x |').at.rows[0][0], { from: 22, to: 22 });
});

test('a format keeps only sizes and alignments that differ, and writes them in one order', () => {
  assert.deepEqual(parseFormat('{"title":{"size":1.5,"align":"center"},"body":{"size":1},"x y":{"size":2},"k":{"size":99,"align":"up"}}'), { title: { size: 1.5, align: 'center' } });
  assert.deepEqual(parseFormat('not json'), {});
  assert.deepEqual(parseFormat('[1]'), {});
  assert.equal(formatText({ b: { align: 'right' }, a: { size: 0.5 } }), '{"a":{"size":0.5},"b":{"align":"right"}}');
  assert.equal(formatText({ a: { size: 1 } }), '');
});

test('insert anywhere: in the middle of a word, across marks, and as several paragraphs', () => {
  const doc = readDoc('lines', 'Short **lines**');
  const one = insert(doc, { p: 0, o: 3 }, typed('X'));
  assert.equal(writeDoc('lines', one.doc), 'ShoXrt **lines**');
  assert.deepEqual(one.at, { p: 0, o: 4 });
  const marked = insert(doc, { p: 0, o: 8 }, typed('Y', marksAt(doc, { p: 0, o: 8 })));
  assert.equal(writeDoc('lines', marked.doc), 'Short **liYnes**');
  // Inside a link or code the letter keeps it; at its end it does not.
  const link = readDoc('lines', '[hello](https://example.com) and `code`');
  assert.equal(writeDoc('lines', insert(link, { p: 0, o: 2 }, typed('X', marksAt(link, { p: 0, o: 2 }))).doc), '[heXllo](https://example.com) and `code`');
  assert.equal(writeDoc('lines', insert(link, { p: 0, o: 5 }, typed('X', marksAt(link, { p: 0, o: 5 }))).doc), '[hello](https://example.com)X and `code`');
  assert.equal(writeDoc('lines', insert(link, { p: 0, o: 12 }, typed('X', marksAt(link, { p: 0, o: 12 }))).doc), '[hello](https://example.com) and `coXde`');
  // A paste read from HTML keeps the spaces its plain text has at its ends.
  const hello = [{ kind: 'plain', level: 0, runs: [{ text: 'hello', b: true }] }];
  assert.equal(writeDoc('lines', insert(readDoc('lines', 'world'), { p: 0, o: 0 }, withEdges(hello, 'hello ')).doc), '**hello **world');
  assert.deepEqual(withEdges(hello, ' hello\n').map(textOf), [' hello']);
  assert.deepEqual(withEdges(hello, 'hello'), hello);
  const many = insert(readDoc('blocks', '- ab'), { p: 0, o: 1 }, typed('1\n2'));
  assert.equal(writeDoc('blocks', many.doc), '- a1\n2b');
  assert.deepEqual(many.at, { p: 1, o: 1 });
  const list = readDoc('blocks', '- First\n- Second');
  assert.equal(writeDoc('blocks', insert(readDoc('blocks', ''), { p: 0, o: 0 }, list).doc), '- First\n- Second', 'an empty paragraph takes the pasted bullet');
  assert.equal(writeDoc('blocks', insert(readDoc('blocks', ''), { p: 0, o: 0 }, list.slice(0, 1)).doc), '- First');
  assert.equal(writeDoc('blocks', insert(readDoc('blocks', '-'), { p: 0, o: 0 }, typed('a')).doc), '- a', 'typing keeps an empty bullet');
  // A space typed before a paragraph's words goes, and the caret stays before them.
  const spaced = insert(readDoc('blocks', 'Alpha\n\n- Beta'), { p: 1, o: 0 }, typed('  '));
  const trimmed = trimLeads(spaced.doc, { anchor: spaced.at, focus: { p: 0, o: 3 } });
  assert.deepEqual([trimmed.doc.map(textOf), trimmed.sel], [['Alpha', 'Beta'], { anchor: { p: 1, o: 0 }, focus: { p: 0, o: 3 } }]);
  assert.equal(writeDoc('blocks', trimmed.doc), 'Alpha\n- Beta');
});

test('delete anywhere: inside a paragraph, and across paragraphs, which join', () => {
  const doc = readDoc('blocks', '- one\n- two\n- three');
  assert.equal(writeDoc('blocks', remove(doc, { p: 0, o: 1 }, { p: 0, o: 2 }).doc), '- oe\n- two\n- three');
  const across = remove(doc, { p: 2, o: 2 }, { p: 0, o: 2 });
  assert.equal(writeDoc('blocks', across.doc), '- onree');
  assert.deepEqual(across.at, { p: 0, o: 2 });
  assert.deepEqual(slice(doc, { p: 0, o: 1 }, { p: 1, o: 2 }).map(textOf), ['ne', 'tw']);
});

test('Enter continues a list, and at a paragraph start opens one above', () => {
  const doc = readDoc('blocks', '- one\n### Head');
  const mid = split(doc, { p: 0, o: 2 });
  assert.equal(writeDoc('blocks', mid.doc), '- on\n- e\n### Head');
  assert.deepEqual(mid.at, { p: 1, o: 0 });
  const start = split(doc, { p: 0, o: 0 });
  assert.equal(writeDoc('blocks', start.doc), '-\n- one\n### Head');
  assert.equal(split(doc, { p: 1, o: 4 }).doc[2].kind, 'plain', 'a heading is followed by a plain paragraph');
});

test('bold, italic and underline on a selection, a word, or across paragraphs', () => {
  const doc = readDoc('blocks', '- read faster\n- two');
  const word = wordAt(doc, { p: 0, o: 2 });
  assert.deepEqual(word, [{ p: 0, o: 0 }, { p: 0, o: 4 }]);
  assert.equal(wordAt(doc, { p: 0, o: 4 }), null, 'no word at its edge');
  const bold = setMark(doc, ...word, 'b', true);
  assert.equal(writeDoc('blocks', bold), '- **read** faster\n- two');
  assert.equal(hasMark(bold, ...word, 'b'), true);
  assert.equal(hasMark(bold, { p: 0, o: 0 }, { p: 0, o: 6 }, 'b'), false);
  assert.equal(hasMark(bold, { p: 0, o: 3 }, { p: 0, o: 3 }, 'b'), null);
  const under = setMark(bold, { p: 0, o: 2 }, { p: 1, o: 1 }, 'u', true);
  assert.equal(writeDoc('blocks', under), '- **re<u>ad</u>**<u> faster</u>\n- <u>t</u>wo');
  assert.equal(writeDoc('blocks', setMark(under, { p: 0, o: 0 }, { p: 1, o: 3 }, 'u', false)), '- **read** faster\n- two');
  // A double click on Windows takes the space after the word; a mark leaves it out.
  assert.deepEqual(inward(doc, { p: 0, o: 0 }, { p: 0, o: 5 }), [{ p: 0, o: 0 }, { p: 0, o: 4 }]);
  assert.deepEqual(inward(doc, { p: 1, o: 0 }, { p: 0, o: 4 }), [{ p: 0, o: 5 }, { p: 0, o: 11 }], 'from a space through the next paragraph start');
  assert.deepEqual(inward(doc, { p: 0, o: 4 }, { p: 0, o: 5 }), [{ p: 0, o: 4 }, { p: 0, o: 5 }], 'spaces alone stay selected');
});

test('bullets, numbering and levels; a title or a cell takes what fits it', () => {
  const doc = readDoc('blocks', 'one\n\ntwo');
  const numbered = setKind(doc, 0, 1, 'number');
  assert.equal(writeDoc('blocks', numbered), '1. one\n2. two');
  assert.equal(writeDoc('blocks', shiftLevel(numbered, 1, 1, 1)), '1. one\n  1. two');
  assert.equal(writeDoc('blocks', shiftLevel(numbered, 1, 1, 5)), '1. one\n  1. two', 'two levels at most');
  assert.equal(writeDoc('blocks', setKind(numbered, 0, 1, 'plain')), 'one\n\ntwo');
  const pasted = [{ kind: 'bullet', level: 1, runs: [{ text: 'a|b', b: true }] }, { kind: 'plain', level: 0, runs: [{ text: 'c' }] }];
  assert.equal(writeDoc('lines', conform('lines', pasted)), '**a|b**\nc');
  assert.equal(writeDoc('cell', conform('cell', pasted)), '**a b** c');
  assert.equal(writeDoc('cellPlain', conform('cellPlain', pasted)), 'a b c');
  assert.equal(writeDoc('plain', conform('plain', pasted)), 'a|b\nc');
});

test('a copy carries plain text and HTML with its marks and lists', () => {
  const doc = readDoc('blocks', '- **a** <u>b</u>\n- c\n\nplain & <x>');
  assert.equal(toPlain(doc), 'a b\nc\nplain & <x>');
  assert.equal(toHtml(doc), '<ul><li><strong>a</strong> <u>b</u></li><li>c</li></ul><p>plain &amp; &lt;x&gt;</p>');
  assert.deepEqual(clampPos(doc, { p: 9, o: 99 }), { p: 2, o: 11 });
});
