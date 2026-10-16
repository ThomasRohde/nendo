// The manuscript as Markdown and as a Word document (C-11), from the blocks as saved in the
// file. Pure functions: the libraries and marked's Lexer are passed in, so Node tests drive the
// same code the view runs (tools/manus/export.test.mjs).
import { levelOf } from './model.mjs';
import { pictureOf, markdownToInline } from './inline.mjs';

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
// The picture types a Word document holds without a fallback image.
const WORD_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

/**
 * What an export writes, in reading order: the title, then headings (the shallowest heading in
 * the manuscript is level 1), paragraphs and pictures. Empty paragraphs are left out.
 */
export function exportPlan(manuscript) {
  const levels = manuscript.nodes.map(n => levelOf(n.kind)).filter(Boolean);
  const top = levels.length ? Math.min(...levels) : 1;
  const items = [];
  for (const n of manuscript.nodes) {
    const level = levelOf(n.kind);
    if (level) { items.push({ type: 'heading', level: level - top + 1, text: n.text ?? '', id: n.id }); continue; }
    const picture = pictureOf(n.text);
    if (picture) { items.push({ type: 'picture', alt: picture.alt, address: picture.address, id: n.id }); continue; }
    if ((n.text ?? '').trim()) items.push({ type: 'paragraph', text: n.text, id: n.id });
  }
  return { title: (manuscript.title ?? '').trim() || 'Untitled manuscript', items };
}

/** A file name Windows takes, from the manuscript's title. */
export function safeName(title) {
  const name = (title ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').replace(/[. ]+$/, '').trim().slice(0, 80).trim();
  return name || 'Manuscript';
}

/** Where each embedded picture that was read goes in a Markdown export: media/picture-01.jpg, … */
export function pictureFiles(plan, pictures) {
  const files = new Map();
  for (const item of plan.items) {
    if (item.type !== 'picture' || files.has(item.address) || !pictures.has(item.address)) continue;
    const ext = EXTENSION[pictures.get(item.address).mediaType] ?? 'bin';
    files.set(item.address, `media/picture-${String(files.size + 1).padStart(2, '0')}.${ext}`);
  }
  return files;
}

/** The manuscript as one Markdown document. Each block's text is already Markdown. */
export function toMarkdown(plan, files = new Map()) {
  const parts = [`# ${plan.title}`];
  for (const item of plan.items) {
    if (item.type === 'heading') parts.push(`${'#'.repeat(Math.min(item.level + 1, 6))} ${item.text}`);
    else if (item.type === 'paragraph') parts.push(item.text);
    else parts.push(`![${item.alt.replace(/[\\[\]]/g, '\\$&')}](${files.get(item.address) ?? item.address})`);
  }
  return parts.join('\n\n') + '\n';
}

function runs(markdown, lib, Lexer, size, base = 22) {
  const out = [];
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out.push(new lib.TextRun({ text: '', break: 1 })); continue; }
    const marks = new Set((node.marks ?? []).map(m => m.type));
    // Only marks that are on: a run that says bold false would override a bold heading style.
    out.push(new lib.TextRun({ text: node.text, bold: marks.has('bold') || undefined, italics: marks.has('italic') || undefined, strike: marks.has('strike') || undefined,
      font: marks.has('code') ? 'Consolas' : undefined, size: marks.has('code') ? Math.round((size ?? base) * 0.88) : size }));
  }
  return out;
}

// Sizes are half-points and distances twentieths of a point (twips), as Word stores them.
export const LAYOUTS = {
  /** An arXiv-style article: one column, Times, justified, a centred title block. */
  paper: {
    font: 'Times New Roman', size: 22, line: 240, firstLine: 360, after: 0,
    page: { width: 12240, height: 15840, margin: 1440 },
    title: { size: 34, before: 0, after: 200 }, front: { size: 22, after: 60 },
    headings: [{ size: 24, before: 300, after: 120 }, { size: 22, before: 220, after: 80 }, { size: 22, before: 160, after: 60, italics: true }],
    abstract: { size: 20, indent: 720 }, caption: { size: 18 }, references: { size: 18, hanging: 360 },
    figureWidth: 400, textWidth: 624, pageNumbers: true, chapterBreaks: false, titlePage: false,
  },
  /** A book: a title page, chapters on new pages, a 6 by 9 inch page. */
  book: {
    font: 'Georgia', size: 22, line: 300, firstLine: 360, after: 0,
    page: { width: 8640, height: 12960, margin: 1080 },
    title: { size: 48, before: 2400, after: 0 }, front: { size: 22, after: 120 },
    headings: [{ size: 32, before: 1200, after: 480, center: true }, { size: 26, before: 360, after: 160 }, { size: 22, before: 240, after: 120, italics: true }],
    abstract: null, caption: { size: 18, italics: true }, references: { size: 20, hanging: 360 },
    figureWidth: 432, textWidth: 432, pageNumbers: true, chapterBreaks: true, titlePage: true,
  },
};

const FIGURE = /^\*?(Figure|Fig\.|Table)\s+(\d+)[.:]\*?\s*/i;

/**
 * The manuscript as a Word document in a layout, `paper` or `book`: a Title, Heading 1 to 3,
 * justified paragraphs with a first-line indent (none after a heading or a figure), bold,
 * italic, strikethrough and code runs, and pictures centred with their description as
 * alternative text. In the paper layout the paragraphs before the first heading are the
 * centred front matter, a section headed Abstract is set narrower and smaller, a paragraph
 * after a picture that starts "Figure n." is its caption, and a section headed References is
 * set small with hanging indents. `pictures` maps an address to {data, mediaType, width,
 * height}. A picture Word cannot take, or one that could not be read, stands as its
 * description in brackets and is named in `missing`.
 */
export function toDocx(plan, pictures, lib, Lexer, layoutName = 'book') {
  const L = LAYOUTS[layoutName] ?? LAYOUTS.book;
  const A = lib.AlignmentType;
  const headingLevels = [lib.HeadingLevel.HEADING_1, lib.HeadingLevel.HEADING_2, lib.HeadingLevel.HEADING_3];
  const children = [new lib.Paragraph({ heading: lib.HeadingLevel.TITLE, alignment: A.CENTER, children: [new lib.TextRun({ text: plan.title })] })];
  const missing = [];
  let section = null, indentNext = false, seenHeading = false, previous = null;
  // Pictures next to each other share one figure row, as subfigures do, each at its share of the
  // width; a single picture is set at the layout's figure width.
  let row = [];
  const flushRow = () => {
    if (!row.length) return;
    const runsOfRow = [], each = row.length === 1 ? L.figureWidth : Math.floor((L.textWidth - 24 * (row.length - 1)) / row.length);
    row.forEach((item, i) => {
      const picture = pictures.get(item.address), type = picture && WORD_TYPE[picture.mediaType];
      if (i > 0) runsOfRow.push(new lib.TextRun({ text: '    ' }));
      if (!picture || !type || !picture.width || !picture.height) {
        missing.push({ alt: item.alt, address: item.address, why: !picture ? 'not read' : 'a type Word does not hold' });
        runsOfRow.push(new lib.TextRun({ text: `[Picture: ${item.alt || 'no description'}]`, italics: true }));
        return;
      }
      const width = Math.min(each, picture.width), height = Math.round(width * picture.height / picture.width);
      runsOfRow.push(new lib.ImageRun({ type, data: picture.data, transformation: { width, height },
        altText: { name: item.alt || 'Picture', title: item.alt || 'Picture', description: item.alt || '' } }));
    });
    children.push(new lib.Paragraph({ alignment: A.CENTER, keepNext: true, spacing: { before: 200, after: 80 }, children: runsOfRow }));
    indentNext = false; previous = row.at(-1); row = [];
  };
  for (const item of plan.items) {
    if (item.type !== 'picture') flushRow();
    if (item.type === 'heading') {
      seenHeading = true;
      const name = item.text.replace(/^[\d.\s]+/, '').trim().toLowerCase();
      section = item.level === 1 ? (name === 'abstract' ? 'abstract' : /^(references|bibliography)$/.test(name) ? 'references' : 'body') : section;
      const h = L.headings[Math.min(item.level, 3) - 1];
      const centred = h.center || section === 'abstract';
      children.push(new lib.Paragraph({ heading: headingLevels[Math.min(item.level, 3) - 1], alignment: centred ? A.CENTER : A.LEFT,
        pageBreakBefore: L.chapterBreaks && item.level === 1,
        children: runs(item.text, lib, Lexer, section === 'abstract' ? L.abstract?.size : undefined) }));
      indentNext = false; previous = item;
      continue;
    }
    if (item.type === 'picture') { row.push(item); continue; }
    flushRow();
    const caption = previous?.type === 'picture' ? FIGURE.exec(item.text) : null;
    if (caption) {
      const label = `${caption[1][0].toUpperCase()}${caption[1].slice(1).toLowerCase()} ${caption[2]}:`;
      children.push(new lib.Paragraph({ alignment: A.CENTER, spacing: { after: 240 }, indent: { left: 360, right: 360 },
        children: [new lib.TextRun({ text: `${label} `, bold: !L.caption.italics, italics: L.caption.italics, size: L.caption.size }),
          ...runs(item.text.slice(caption[0].length), lib, Lexer, L.caption.size).map(r => r)] }));
      indentNext = false; previous = item;
      continue;
    }
    if (!seenHeading && layoutName === 'paper') {
      children.push(new lib.Paragraph({ alignment: A.CENTER, spacing: { after: L.front.after }, children: runs(item.text, lib, Lexer, L.front.size) }));
      previous = item;
      continue;
    }
    if (section === 'references') {
      children.push(new lib.Paragraph({ alignment: A.LEFT, spacing: { after: 60 }, indent: { left: L.references.hanging, hanging: L.references.hanging }, children: runs(item.text, lib, Lexer, L.references.size) }));
      previous = item;
      continue;
    }
    if (section === 'abstract' && L.abstract) {
      children.push(new lib.Paragraph({ alignment: A.JUSTIFIED, indent: { left: L.abstract.indent, right: L.abstract.indent, firstLine: indentNext ? L.firstLine : 0 },
        children: runs(item.text, lib, Lexer, L.abstract.size) }));
      indentNext = true; previous = item;
      continue;
    }
    children.push(new lib.Paragraph({ alignment: A.JUSTIFIED, indent: { firstLine: indentNext ? L.firstLine : 0 }, children: runs(item.text, lib, Lexer) }));
    indentNext = true; previous = item;
  }
  flushRow();
  const heading = h => ({ run: { font: L.font, size: h.size, bold: true, italics: !!h.italics, color: '000000' },
    paragraph: { spacing: { before: h.before, after: h.after }, keepNext: true, keepLines: true } });
  const document = new lib.Document({
    creator: 'Nendo Manuscript', title: plan.title,
    styles: {
      // docx writes its own Title and Heading styles; these are what it writes them as.
      default: {
        document: { run: { font: L.font, size: L.size, color: '000000' }, paragraph: { spacing: { line: L.line, after: L.after } } },
        title: { run: { font: L.font, size: L.title.size, bold: layoutName === 'paper', color: '000000' },
          paragraph: { alignment: A.CENTER, spacing: { before: L.title.before, after: L.title.after } } },
        heading1: heading(L.headings[0]), heading2: heading(L.headings[1]), heading3: heading(L.headings[2]),
      },
    },
    sections: [{
      properties: { page: { size: { width: L.page.width, height: L.page.height },
        margin: { top: L.page.margin, right: L.page.margin, bottom: L.page.margin, left: L.page.margin, header: 720, footer: 720 } } },
      footers: L.pageNumbers ? { default: new lib.Footer({ children: [new lib.Paragraph({ alignment: A.CENTER, children: [new lib.TextRun({ children: [lib.PageNumber.CURRENT], size: 20 })] })] }) } : undefined,
      children: L.titlePage ? [children[0], new lib.Paragraph({ children: [], pageBreakBefore: false }), ...children.slice(1).map((c, i) => i === 0 && !L.chapterBreaks ? c : c)] : children,
    }],
  });
  return { document, missing };
}
