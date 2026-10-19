// The paper as AASTeX 6.3.1 sets it (aastex631, twocolumn): a LaTeX render of the same export
// plan the Word export and the preview read, the reference the paper layout is measured
// against (tools/manus/compare-paper.mjs). Not part of the view: a person exports Word.
import { previewBlocks } from '../../extensions/manuscript/preview.mjs';
import { markdownToInline } from '../../extensions/manuscript/inline.mjs';
import { FIGURE, paperHeadings, PARTS, paperTableColumns } from '../../extensions/manuscript/export.mjs';

const SPECIAL = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '^': '\\^{}', '_': '\\_', '%': '\\%', '~': '\\textasciitilde{}' };
export const escape = text => String(text).replace(/[\\{}$&#^_%~]/g, c => SPECIAL[c]);

/** Inline Markdown as LaTeX: bold, italic, underline, strikethrough, highlight, code and links. */
export function inlineLatex(markdown, Lexer) {
  let out = '';
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out += '\\\\ '; continue; }
    if (node.type !== 'text') continue;
    let text = escape(node.text);
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = `\\textbf{${text}}`;
      else if (mark.type === 'italic') text = `\\textit{${text}}`;
      else if (mark.type === 'underline') text = `\\underline{${text}}`;
      else if (mark.type === 'strike') text = `\\sout{${text}}`;
      // A box per word, so a highlighted run still breaks across lines.
      else if (mark.type === 'highlight') text = text.split(/ +/).map(word => `\\hlbox{${word}}`).join(' ');
      else if (mark.type === 'code') text = `\\texttt{${text}}`;
      else if (mark.type === 'link') text = `\\href{${String(mark.attrs.href).replace(/[\\#%{}]/g, '\\$&')}}{${text}}`;
    }
    out += text;
  }
  return out;
}

/**
 * The plan as one LaTeX document. `pictures` maps an address to the file name the document
 * includes it by. Blocks come from previewBlocks, so which paragraph is indented, which is a
 * caption and which pictures share a row is decided once, for all three renders. Pictures and
 * tables stand where the plan has them, as the Word export sets them, not floated.
 */
export function toLatex(plan, pictures, Lexer, { date = 'October 18, 2026', font = 'texgyretermes', breakBefore = new Set() } = {}) {
  const inline = text => inlineLatex(text, Lexer);
  const blocks = previewBlocks(plan, 'paper');
  const { parts } = paperHeadings(plan);
  // previewBlocks keeps the plan's order; the plan item of each heading says whether it is a part.
  const headingItems = plan.items.filter(i => i.type === 'heading');
  const front = [], body = [];
  let abstract = null, inList = false, bib = false, headingIndex = -1, figures = 0;
  const closeList = () => { if (inList) { body.push('\\end{enumerate}'); inList = false; } };
  let pendingCaption = null;
  for (const block of blocks) {
    if (block.kind === 'title') continue;
    if (block.kind === 'heading') headingIndex++;
    if (block.across) {
      if (block.kind === 'heading' && block.role === 'Abstract') { abstract = []; continue; }
      if (block.role === 'Abstract' && abstract) { abstract.push(inline(block.text)); continue; }
      if (block.role === 'Author') { front.push(`\\author{${inline(block.text)}}`); continue; }
      if (block.role === 'Keywords') { front.push(`\\keywords{${inline(block.text)}}`); continue; }
      if (block.front) { front.push(`\\affiliation{${inline(block.text)}}`); continue; }
      continue;
    }
    if (block.kind !== 'paragraph' || !block.list) closeList();
    if (block.kind === 'heading') {
      const item = headingItems[headingIndex];
      if (block.role === 'References' && parts.has(item)) { body.push(...(breakBefore.has(item.text) ? ['\\newpage'] : []), '\\begin{thebibliography}{}'); bib = true; continue; }
      if (bib) { body.push('\\end{thebibliography}'); bib = false; }
      // The class's grid can end a column right under a heading; the exports keep a heading with
      // the lines after it. The caller names the headings a first run left at a column's foot,
      // and the column ends before them instead, as a typesetter would end it.
      if (breakBefore.has(item.text)) body.push('\\newpage');
      if (PARTS.has(block.role) && parts.has(item)) { body.push(`\\section*{${inline(item.text.replace(/^[\d.\\]+\s+/, ''))}}`); continue; }
      const number = /^(\d+(?:\.\d+)*)\./.exec(block.text)?.[1];
      const command = ['section', 'subsection', 'subsubsection'][Math.min(block.level, 3) - 1];
      if (number) {
        const n = number.split('.').map(Number);
        body.push(`\\setcounter{${command}}{${n.at(-1) - 1}}`);
      }
      body.push(`\\${command}{${inline(item.text.replace(/^(\d+(?:\\?\.\d+)*)\\?\.?\s+/, ''))}}`);
      continue;
    }
    if (block.kind === 'caption') {
      // A caption follows its figure; a table's comes before the table.
      pendingCaption = block;
      if (body.at(-1) === '%figure') { body.pop(); body.push(caption(block, inline), '\\end{inlinefloat}'); pendingCaption = null; }
      continue;
    }
    if (block.kind === 'figure') {
      figures++;
      const n = block.pictures.length;
      // Side by side within the column, 18 points (24 pixels) apart, as the exports set a row.
      const width = n === 1 ? '\\columnwidth' : `\\dimexpr(\\columnwidth-${18 * (n - 1)}pt)/${n}-0.01pt\\relax`;
      body.push('\\begin{inlinefloat}{figure}',
        block.pictures.map(p => pictures.has(p.address) ? `\\includegraphics[width=${width}]{${pictures.get(p.address)}}` : `\\fbox{${escape(p.alt)}}`).join('\\hspace{18pt}') + '%',
        '%figure');
      continue;
    }
    if (block.kind === 'table') {
      // Columns as tableColumns shares them, in the table's 9 points with 5 points either side.
      const shares = paperTableColumns(block.rows);
      body.push('\\begin{inlinefloat}{table}', '\\small');
      if (pendingCaption) { body.push(caption(pendingCaption, inline)); pendingCaption = null; }
      body.push('\\setlength{\\tabcolsep}{5pt}', `\\begin{tabular}{${shares.map(s => `>{\\raggedright\\arraybackslash}p{\\dimexpr${s.toFixed(4)}\\columnwidth-10pt\\relax}`).join('')}}`, '\\hline\\hline');
      block.rows.forEach((cells, r) => {
        body.push(shares.map((_, c) => inline(cells[c] ?? '')).join(' & ') + ' \\\\');
        if (r === 0) body.push('\\hline');
      });
      body.push('\\hline', '\\end{tabular}', '\\end{inlinefloat}');
      continue;
    }
    if (body.at(-1) === '%figure') { body.pop(); body.push('\\end{inlinefloat}'); }
    // natbib's author-year form wants a label with a year; AASTeX does not print it.
    if (bib) { body.push(`\\bibitem[{R(${body.length})}]{r${body.length}} ${inline(block.text)}`); continue; }
    if (block.list) {
      if (!inList) { body.push('\\begin{enumerate}'); inList = true; }
      body.push(`\\item ${inline(block.text)}`);
      continue;
    }
    body.push('', `${block.indent ? '' : '\\noindent '}${inline(block.text)}`);
  }
  closeList();
  if (bib) body.push('\\end{thebibliography}');
  void figures;
  return [
    '\\documentclass[twocolumn]{aastex631}',
    '\\usepackage{fontspec}',
    `\\setmainfont{${font}}[Extension=.otf, UprightFont=*-regular, BoldFont=*-bold, ItalicFont=*-italic, BoldItalicFont=*-bolditalic]`,
    '\\setmonofont{consola.ttf}[Scale=0.88]',
    '\\usepackage{ulem,etoolbox}',
    '\\newcommand{\\hlbox}[1]{{\\fboxsep=0pt\\colorbox{yellow}{\\strut #1}}}',
    '\\normalem',
    `\\renewcommand{\\today}{${date}}`,
    // What the exports do not carry: the class's credit under the draft line (its room is kept),
    // and the marks tying an author to the front matter, which is not an affiliation there.
    '\\makeatletter',
    '\\patchcmd{\\frontmatter@title@above}{Typeset using \\LaTeX\\ {\\bf twocolumn} style in AASTeX631}{\\strut}{}{}',
    // The title block is set late, when the first page is, so the marks stay off for the whole
    // document; the render sets no footnotes.
    '\\AtBeginDocument{\\def\\@makefnmark{}\\let\\textsuperscript\\@gobble\\let\\@textsuperscript\\@gobble\\def\\frontmatter@makefnmark{}}',
    // A picture or table where the text has it, kept whole, with the class's own caption and
    // the room an in-text float takes above and below (\intextsep), rigid as the exports' room is
    // where the class's may shrink by 2pt.
    '\\newenvironment{inlinefloat}[1]{\\par\\vspace{12pt}\\noindent\\begin{minipage}{\\columnwidth}\\def\\@captype{#1}\\centering}{\\end{minipage}\\par\\vspace{12pt}}',
    // Pictures and tables stand where the text has them, as in the exports, so a column that
    // ends before one is left short, as Word leaves it, rather than stretched to the foot; and
    // columns balanced above the references end ragged rather than with their glue stretched.
    '\\@booleantrue\\raggedcolumn@sw',
    // The room around headings and lists at its natural size, never shrunk to fit a line more
    // into a column, which Word and the preview cannot do.
    '\\patchcmd{\\section}{9pt plus 1pt minus 1pt}{9pt}{}{}',
    '\\patchcmd{\\subsection}{9pt plus 1pt minus 1pt}{9pt}{}{}',
    '\\def\\@listi{\\leftmargin\\leftmargini\\parsep 4pt\\topsep 8pt\\itemsep 4pt}\\let\\@listI\\@listi',
    '\\setlength{\\partopsep}{0pt}',
    // Nor is a break before a section or around a list preferred: with the foot ragged every
    // break is free, so TeX would end columns early there, and the exports never do.
    '\\@secpenalty=0 \\@itempenalty=0 \\@beginparpenalty=0 \\@endparpenalty=0',
    '\\patchcmd{\\thebibliography}{\\parskip=1pt plus 1pt}{\\parskip=0pt}{}{}',
    '\\patchcmd{\\thebibliography}{\\baselineskip=13pt plus 1pt}{\\baselineskip=13pt}{}{}',
    '\\patchcmd{\\thebibliography}{\\baselineskip=13pt plus 1pt}{\\baselineskip=13pt}{}{}',
    '\\patchcmd{\\thebibliography}{\\baselineskip=13pt plus 1pt}{\\baselineskip=13pt}{}{}',
    '\\bibskip=0pt',
    '\\makeatother',
    '\\raggedbottom',
    '\\begin{document}',
    `\\title{${inline(plan.title)}}`,
    ...front,
    ...(abstract ? ['\\begin{abstract}', abstract.join('\n\n'), '\\end{abstract}'] : []),    ...body,
    '\\end{document}', '',
  ].join('\n');
}

function caption(block, inline) {
  const match = FIGURE.exec(block.label ?? '') ?? null;
  void match;
  return `\\caption{${inline(block.text)}}`;
}
