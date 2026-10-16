// The manuscript as Markdown and as a Word document (C-11), from the blocks as saved in the
// file. Pure functions: the libraries and marked's Lexer are passed in, so Node tests drive the
// same code the view runs (tools/manus/export.test.mjs).
import { levelOf } from './model.mjs';
import { pictureOf, markdownToInline } from './inline.mjs';

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
// The picture types a Word document holds without a fallback image.
const WORD_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

// What a heading's words say it is, for a block that names no role: the guess an older file needs.
const NAMED = [
  [/^abstract$/, 'Abstract'], [/^(references|bibliography|works cited)$/, 'References'], [/^acknowledge?ments?$/, 'Acknowledgements'],
  [/^(appendix|appendices)\b/, 'Appendix'], [/^preface$/, 'Preface'], [/^foreword$/, 'Foreword'], [/^afterword$/, 'Afterword'],
  [/^glossary$/, 'Glossary'], [/^dedication$/, 'Dedication'], [/^about the author$/, 'About the author'], [/^colophon$/, 'Colophon'],
];
function namedRole(text) {
  const name = (text ?? '').replace(/^[\dA-Z]?[\d.\s]*\s/, '').replace(/[*_`]/g, '').trim().toLowerCase();
  return NAMED.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/**
 * What an export writes, in reading order: the title, then headings (the shallowest heading in
 * the manuscript is level 1), paragraphs and pictures, each with its role. A block's own role
 * comes first; a heading without one takes the role its words name (Abstract, References, …);
 * a paragraph without one takes the role of the heading it sits under, or is a caption when it
 * follows a picture and starts "Figure n.". Paragraphs before the first heading are marked as
 * front matter. Empty paragraphs are left out.
 */
export function exportPlan(manuscript) {
  const levels = manuscript.nodes.map(n => levelOf(n.kind)).filter(Boolean);
  const top = levels.length ? Math.min(...levels) : 1;
  const items = [], open = [];
  let previous = null, front = true;
  for (const n of manuscript.nodes) {
    const level = levelOf(n.kind);
    if (level) {
      while (open.length && open.at(-1).level >= level) open.pop();
      const role = n.role ?? namedRole(n.text) ?? open.at(-1)?.role ?? null;
      open.push({ level, role });
      front = false;
      items.push(previous = { type: 'heading', level: level - top + 1, kind: n.kind, text: n.text ?? '', id: n.id, role });
      continue;
    }
    const picture = pictureOf(n.text);
    if (picture) { items.push(previous = { type: 'picture', alt: picture.alt, address: picture.address, id: n.id, role: n.role ?? null }); continue; }
    const text = n.text ?? '';
    if (!text.trim() && n.role !== 'Scene break') continue;
    const role = n.role ?? (previous?.type === 'picture' && FIGURE.test(text) ? 'Caption' : null) ?? open.at(-1)?.role ?? null;
    items.push(previous = { type: 'paragraph', text, id: n.id, role, front: front && !n.role });
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
  const quoted = text => text.split('\n').map(line => `> ${line}`).join('\n');
  for (const item of plan.items) {
    if (item.type === 'heading') parts.push(`${'#'.repeat(Math.min(item.level + 1, 6))} ${item.text}`);
    else if (item.type === 'picture') parts.push(`![${item.alt.replace(/[\\[\]]/g, '\\$&')}](${files.get(item.address) ?? item.address})`);
    else if (item.role === 'Scene break') parts.push('* * *');
    else if (['Quotation', 'Epigraph', 'Aside'].includes(item.role)) parts.push(quoted(item.text));
    else parts.push(item.text);
  }
  return parts.join('\n\n') + '\n';
}

function runs(markdown, lib, Lexer, size, base = 22, italic = false) {
  const out = [];
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out.push(new lib.TextRun({ text: '', break: 1 })); continue; }
    const marks = new Set((node.marks ?? []).map(m => m.type));
    // Only marks that are on: a run that says bold false would override a bold heading style.
    out.push(new lib.TextRun({ text: node.text, bold: marks.has('bold') || undefined, italics: italic || marks.has('italic') || undefined, strike: marks.has('strike') || undefined,
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

export const FIGURE = /^\*?(Figure|Fig\.|Table)\s+(\d+)[.:]\*?\s*/i;

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
  let indentNext = false, previous = null;
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
  // The parts a book or an article sets apart: a heading with one of these roles starts it.
  const PARTS = new Set(['Foreword', 'Preface', 'Acknowledgements', 'Abstract', 'Appendix', 'Afterword', 'Glossary', 'References', 'About the author', 'Colophon']);
  const paper = layoutName === 'paper';
  const text = (markdown, size) => runs(markdown, lib, Lexer, size, L.size);
  const para = (options, markdown, size) => new lib.Paragraph({ ...options, children: text(markdown, size) });
  let firstAppendix = true;
  for (const item of plan.items) {
    if (item.type !== 'picture') flushRow();
    if (item.type === 'heading') {
      const level = Math.min(item.level, 3), h = L.headings[level - 1];
      const part = PARTS.has(item.role) && level === 1;
      const centred = h.center || (part && (!paper || item.role === 'Abstract'));
      // A book starts every part and chapter on a new page; an article only its first appendix.
      const opensPage = item.kind ? item.kind === 'Part' || item.kind === 'Chapter' : level === 1;
      const breakBefore = (L.chapterBreaks && opensPage) || (level === 1 && paper && item.role === 'Appendix' && firstAppendix);
      if (item.role === 'Appendix' && level === 1) firstAppendix = false;
      children.push(new lib.Paragraph({ heading: headingLevels[level - 1], alignment: centred ? A.CENTER : A.LEFT, pageBreakBefore: breakBefore,
        children: text(item.text, paper && item.role === 'Abstract' ? L.abstract.size : undefined) }));
      indentNext = false; previous = item;
      continue;
    }
    if (item.type === 'picture') { row.push(item); continue; }
    const role = item.role;
    let block = null, continues = false;
    switch (role) {
      case 'Caption': {
        const caption = FIGURE.exec(item.text);
        const label = caption ? `${caption[1][0].toUpperCase()}${caption[1].slice(1).toLowerCase()} ${caption[2]}:` : null;
        block = new lib.Paragraph({ alignment: A.CENTER, spacing: { after: 240 }, indent: { left: 360, right: 360 }, children: [
          ...(label ? [new lib.TextRun({ text: `${label} `, bold: !L.caption.italics || undefined, italics: L.caption.italics || undefined, size: L.caption.size })] : []),
          ...text(caption ? item.text.slice(caption[0].length) : item.text, L.caption.size)] });
        break;
      }
      case 'Subtitle':
        block = para({ alignment: A.CENTER, spacing: { after: 200 } }, item.text, Math.round(L.title.size * 0.6));
        break;
      case 'Author':
        block = para({ alignment: A.CENTER, spacing: { after: L.front.after } }, item.text, L.front.size);
        break;
      case 'Dedication':
        // Word drops the space before a paragraph at the top of a page, so a dedication on its own
        // page is lowered by an empty paragraph's space after.
        if (L.titlePage) children.push(new lib.Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 2400 }, children: [] }));
        block = new lib.Paragraph({ alignment: A.CENTER, spacing: { before: L.titlePage ? 0 : 240, after: 240 }, children: runs(item.text, lib, Lexer, undefined, L.size, true) });
        break;
      case 'Epigraph':
        block = new lib.Paragraph({ alignment: A.LEFT, spacing: { before: 120, after: 240 }, indent: { left: Math.round(L.page.width * 0.3) },
          children: runs(item.text, lib, Lexer, Math.round(L.size * 0.95), L.size, true) });
        break;
      case 'Quotation':
        block = para({ alignment: A.JUSTIFIED, spacing: { before: 120, after: 120 }, indent: { left: 720, right: 720 } }, item.text, Math.round(L.size * 0.95));
        break;
      case 'Verse':
        block = para({ alignment: A.LEFT, spacing: { after: 160 }, indent: { left: 720 } }, item.text);
        break;
      case 'Aside':
        block = para({ alignment: A.JUSTIFIED, spacing: { before: 120, after: 120 }, indent: { left: 720, right: 720 } }, item.text, Math.round(L.size * 0.9));
        break;
      case 'Scene break':
        block = para({ alignment: A.CENTER, spacing: { before: 240, after: 240 } }, item.text.trim() || '\\* \\* \\*');
        break;
      case 'Abstract':
        block = paper
          ? para({ alignment: A.JUSTIFIED, indent: { left: L.abstract.indent, right: L.abstract.indent, firstLine: indentNext ? L.firstLine : 0 } }, item.text, L.abstract.size)
          : para({ alignment: A.JUSTIFIED, indent: { firstLine: indentNext ? L.firstLine : 0 } }, item.text);
        continues = true;
        break;
      case 'Keywords':
        block = para({ alignment: A.LEFT, spacing: { before: 120 }, indent: paper ? { left: L.abstract.indent, right: L.abstract.indent } : {} }, item.text, paper ? L.abstract.size : undefined);
        break;
      case 'References':
      case 'Glossary':
        block = para({ alignment: A.LEFT, spacing: { after: 60 }, indent: { left: L.references.hanging, hanging: L.references.hanging } }, item.text, L.references.size);
        break;
      case 'Colophon':
        block = para({ alignment: A.CENTER, spacing: { after: 120 } }, item.text, Math.round(L.size * 0.85));
        break;
      default:
        if (item.front && paper) { block = para({ alignment: A.CENTER, spacing: { after: L.front.after } }, item.text, L.front.size); break; }
        block = para({ alignment: A.JUSTIFIED, indent: { firstLine: indentNext ? L.firstLine : 0 } }, item.text);
        continues = true;
    }
    children.push(block);
    indentNext = continues; previous = item;
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
