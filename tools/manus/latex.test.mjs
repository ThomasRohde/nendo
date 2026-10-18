import assert from 'node:assert/strict';
import test from 'node:test';
import { Lexer } from '../../extensions/manuscript/vendor/editor.js';
import { exportPlan } from '../../extensions/manuscript/export.mjs';
import { toLatex, inlineLatex } from './latex.mjs';

const address = `media:${'ab'.repeat(32)}`;
const plan = exportPlan({ title: 'A Paper', nodes: [
  { id: 'a', kind: 'Paragraph', text: 'Ada and Bo', role: 'Author' },
  { id: 'f', kind: 'Paragraph', text: '*Draft.*' },
  { id: 'h0', kind: 'Chapter', text: 'Abstract' }, { id: 'b', kind: 'Paragraph', text: 'We describe it.' },
  { id: 'h1', kind: 'Chapter', text: '1 Introduction' }, { id: 'c', kind: 'Paragraph', text: 'First, 50% & more.' },
  { id: 'l1', kind: 'Paragraph', text: 'One.', list: 'Numbered' }, { id: 'l2', kind: 'Paragraph', text: 'Two.', list: 'Numbered' },
  { id: 'p1', kind: 'Paragraph', text: `![One](${address})` }, { id: 'p2', kind: 'Paragraph', text: `![Two](${address})` },
  { id: 'cap', kind: 'Paragraph', text: '*Figure 1.* Two panels.' },
  { id: 'h2', kind: 'Section', text: '1.1 Details' }, { id: 'd', kind: 'Paragraph', text: 'More.' },
  { id: 'r', kind: 'Chapter', text: 'References' }, { id: 'r1', kind: 'Paragraph', text: '[1] Someone. 2020. *A Work.*' },
] });

test('the reference render: AASTeX twocolumn with the plan\'s title block, sections, lists, figures and references', () => {
  const tex = toLatex(plan, new Map([[address, 'one.png']]), Lexer, { breakBefore: new Set(['1.1 Details']) });
  assert.match(tex, /^\\documentclass\[twocolumn\]\{aastex631\}/);
  assert.match(tex, /\\title\{A Paper\}\n\\author\{Ada and Bo\}\n\\affiliation\{\\textit\{Draft\.\}\}/);
  assert.match(tex, /\\begin\{abstract\}\nWe describe it\.\n\\end\{abstract\}/);
  assert.match(tex, /\\setcounter\{section\}\{0\}\n\\section\{Introduction\}/);
  assert.match(tex, /\\begin\{enumerate\}\n\\item One\.\n\\item Two\.\n\\end\{enumerate\}/);
  // Two pictures side by side in the column, 18 points apart, under one caption, not floated.
  assert.match(tex, /\\begin\{inlinefloat\}\{figure\}\n\\includegraphics\[width=\\dimexpr\(\\columnwidth-18pt\)\/2-0\.01pt\\relax\]\{one\.png\}\\hspace\{18pt\}\\includegraphics/);
  assert.match(tex, /\\caption\{Two panels\.\}\n\\end\{inlinefloat\}/);
  // A heading named by the caller starts a column of its own.
  assert.match(tex, /\\newpage\n\\setcounter\{subsection\}\{0\}\n\\subsection\{Details\}/);
  assert.match(tex, /\\begin\{thebibliography\}\{\}\n\\bibitem\[\{R\(\d+\)\}\]\{r\d+\} \[1\] Someone\. 2020\. \\textit\{A Work\.\}\n\\end\{thebibliography\}/);
  // Every paragraph of running text is indented, as the class indents it.
  assert.doesNotMatch(tex.split('\\begin{document}')[1], /\\noindent/);
});

test('inline Markdown as LaTeX, its special characters escaped', () => {
  assert.equal(inlineLatex('**bold** *it* `code` 50% & $5 #1 a_b ~ {x}', Lexer),
    '\\textbf{bold} \\textit{it} \\texttt{code} 50\\% \\& \\$5 \\#1 a\\_b \\textasciitilde{} \\{x\\}');
  assert.equal(inlineLatex('<mark>two words</mark>', Lexer), '\\hlbox{two} \\hlbox{words}');
  assert.equal(inlineLatex('[site](https://example.org/a#b)', Lexer), '\\href{https://example.org/a\\#b}{site}');
});
