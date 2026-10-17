// The manuscript as Markdown and as a Word document (C-11), from the blocks as saved in the
// file. Pure functions: the libraries and marked's Lexer are passed in, so Node tests drive the
// same code the view runs (tools/manus/export.test.mjs).
import { levelOf, MAX_LEVEL } from './model.mjs';
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
 * front matter. Empty paragraphs are left out. A list item carries its list, level and marker
 * (numberLists); a table is one item holding its rows of cell text, the first row its header.
 */
export function exportPlan(manuscript) {
  const levels = manuscript.nodes.map(n => levelOf(n.kind)).filter(Boolean);
  const top = levels.length ? Math.min(...levels) : 1;
  const items = [], open = [];
  let previous = null, front = true, table = null;
  for (const n of manuscript.nodes) {
    if (n.kind === 'Table') { items.push(previous = table = { type: 'table', id: n.id, rows: [] }); front = false; continue; }
    if (n.kind === 'Row') { table?.rows.push([]); continue; }
    if (n.kind === 'Cell') { table?.rows.at(-1)?.push(n.text ?? ''); continue; }
    table = null;
    const level = levelOf(n.kind);
    if (level) {
      while (open.length && open.at(-1).level >= level) open.pop();
      const role = n.role ?? namedRole(n.text) ?? open.at(-1)?.role ?? null;
      open.push({ level, role });
      front = false;
      items.push(previous = { type: 'heading', level: level - top + 1, kind: n.kind, text: n.text ?? '', id: n.id, role, align: n.align ?? null });
      continue;
    }
    const picture = pictureOf(n.text);
    if (picture) { items.push(previous = { type: 'picture', alt: picture.alt, address: picture.address, id: n.id, role: n.role ?? null }); continue; }
    const text = n.text ?? '';
    if (!text.trim() && n.role !== 'Scene break') continue;
    const role = n.role ?? (previous?.type === 'picture' && FIGURE.test(text) ? 'Caption' : null) ?? open.at(-1)?.role ?? null;
    items.push(previous = { type: 'paragraph', text, id: n.id, role, front: front && !n.role, align: n.align ?? null,
      list: n.list ?? null, listLevel: n.list ? Math.min(MAX_LEVEL, n.level ?? 0) : 0 });
  }
  return { title: (manuscript.title ?? '').trim() || 'Untitled manuscript', items: numberLists(items) };
}

const BULLETS = ['\u2022', '\u25E6', '\u25AA', '\u2022', '\u25E6'];
const roman = n => [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']].reduce((out, [v, s]) => { while (n >= v) { out += s; n -= v; } return out; }, '');
const letter = n => n <= 26 ? String.fromCharCode(96 + n) : letter(Math.floor((n - 1) / 26)) + letter(((n - 1) % 26) + 1);
const NUMBERS = [n => String(n), letter, roman, n => String(n), letter];

/**
 * Gives each list item the marker the sheet draws: per level, a numbered item counts on from
 * the item before at its level, an item resets the levels below it, a bulleted item its own as
 * well, and anything else every level. `run` numbers each numbered list from its start, so Word
 * starts it again at 1.
 */
export function numberLists(items) {
  const counts = new Array(MAX_LEVEL + 1).fill(0);
  let run = 0, open = false;
  for (const item of items) {
    if (item.type !== 'paragraph' || !item.list) { counts.fill(0); open = false; continue; }
    const n = item.listLevel;
    for (let k = n + 1; k <= MAX_LEVEL; k++) counts[k] = 0;
    if (item.list === 'Bulleted') { counts[n] = 0; item.marker = BULLETS[n]; if (n === 0) open = false; }
    else {
      if (!open && n === 0) run++;
      if (n === 0) open = true;
      counts[n]++;
      item.marker = `${NUMBERS[n](counts[n])}.`;
    }
    item.run = run;
  }
  return items;
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

/** A table as GitHub's pipe table: the first row the header, a line break as <br>. */
export function pipeTable(rows) {
  const width = Math.max(1, ...rows.map(r => r.length));
  const line = cells => `| ${Array.from({ length: width }, (_, i) => (cells[i] ?? '').replace(/\\\n/g, '<br>').replace(/\n/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/**
 * The manuscript as one Markdown document. Each block's text is already Markdown; list items
 * are written as Markdown's lists, an item of the same list on the next line.
 */
export function toMarkdown(plan, files = new Map()) {
  const parts = [`# ${plan.title}`];
  const quoted = text => text.split('\n').map(line => `> ${line}`).join('\n');
  let previous = null;
  for (const item of plan.items) {
    const listed = item.type === 'paragraph' && item.list;
    if (listed) {
      const line = `${'    '.repeat(item.listLevel)}${item.list === 'Numbered' ? '1.' : '-'} ${item.text}`;
      if (previous?.list) parts[parts.length - 1] += `\n${line}`; else parts.push(line);
      previous = item;
      continue;
    }
    previous = item;
    if (item.type === 'table') { parts.push(pipeTable(item.rows)); continue; }
    if (item.type === 'heading') parts.push(`${'#'.repeat(Math.min(item.level + 1, 6))} ${item.text}`);
    else if (item.type === 'picture') parts.push(`![${item.alt.replace(/[\\[\]]/g, '\\$&')}](${files.get(item.address) ?? item.address})`);
    else if (item.role === 'Scene break') parts.push('* * *');
    else if (['Quotation', 'Epigraph', 'Aside'].includes(item.role)) parts.push(quoted(item.text));
    else parts.push(item.text);
  }
  return parts.join('\n\n') + '\n';
}

function runs(markdown, lib, Lexer, size, base = 22, italic = false, bold = false) {
  const out = [];
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out.push(new lib.TextRun({ text: '', break: 1 })); continue; }
    const marks = new Set((node.marks ?? []).map(m => m.type));
    // Only marks that are on: a run that says bold false would override a bold heading style.
    out.push(new lib.TextRun({ text: node.text, bold: bold || marks.has('bold') || undefined, italics: italic || marks.has('italic') || undefined, strike: marks.has('strike') || undefined,
      underline: marks.has('underline') ? {} : undefined, highlight: marks.has('highlight') ? 'yellow' : undefined,
      font: marks.has('code') ? 'Consolas' : undefined, size: marks.has('code') ? Math.round((size ?? base) * 0.88) : size }));
  }
  return out;
}

// Sizes are half-points and distances twentieths of a point (twips), as Word stores them.
export const LAYOUTS = {
  /**
   * An article as arXiv carries one in the AASTeX two-column style: Times at 10 points on Letter,
   * the title block, abstract and keywords across the page, the body in two justified columns,
   * headings centred and numbered ("1. INTRODUCTION", "2.1. Documents as applications"), a
   * running head on the first page and page numbers at the top right after it.
   */
  paper: {
    font: 'Times New Roman', size: 20, line: 240, firstLine: 288, after: 0,
    page: { width: 12240, height: 15840, margin: 1440, side: 1080 }, columns: { count: 2, space: 475 },
    title: { size: 24, before: 360, after: 200 }, front: { size: 20, after: 40 },
    headings: [{ size: 20, before: 240, after: 120, center: true, bold: false }, { size: 20, before: 200, after: 100, center: true, bold: false, italics: true },
      { size: 20, before: 160, after: 60, bold: false, italics: true }],
    abstract: { size: 20, indent: 680 }, caption: { size: 18 }, references: { size: 18, hanging: 216 },
    figureWidth: 320, textWidth: 320, pageNumbers: 'header', chapterBreaks: false, titlePage: false,
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

/** The parts a book or an article sets apart: a heading with one of these roles starts it. */
export const PARTS = new Set(['Foreword', 'Preface', 'Acknowledgements', 'Abstract', 'Appendix', 'Afterword', 'Glossary', 'References', 'About the author', 'Colophon']);
// A heading's own number, as typed or as the editor saves it: "4.4 History" is kept as "4\.4 History",
// the escape that stops Markdown reading a list item.
const NUMBER = /^(\d+(?:\\?\.\d+)*)\\?\.?\s+(?=\S)/;

/**
 * The paper layout's heading labels, keyed by plan item, as AASTeX sets them: a section is
 * numbered and in capitals ("1. INTRODUCTION"), a subsection numbered ("2.1. Documents as
 * applications"), and a part such as the Abstract or References in capitals without a number,
 * at whatever depth it stands; the headings inside a part keep their words. A heading's own
 * number is kept and the count goes on from it; a heading without one gets the next. `parts`
 * holds the part headings, which an article sets as its sections are set.
 */
export function paperHeadings(plan) {
  const labels = new Map(), parts = new Set(), count = [0, 0, 0];
  let part = null;
  for (const item of plan.items) {
    if (item.type !== 'heading') continue;
    const level = Math.min(item.level, 3), own = NUMBER.exec(item.text);
    const words = own ? item.text.slice(own[0].length) : item.text;
    // A heading under a part takes the part's role, so the first with the role is the part's.
    if (part && item.role === part.role && level > part.level) { labels.set(item, words); continue; }
    part = PARTS.has(item.role) ? { role: item.role, level } : null;
    if (part) { labels.set(item, words.toUpperCase()); parts.add(item); continue; }
    if (own) own[1].replace(/\\/g, '').split('.').map(Number).forEach((n, i) => { if (i < 3) count[i] = n; });
    else count[level - 1]++;
    for (let i = level; i < 3; i++) count[i] = 0;
    const number = count.slice(0, level).join('.');
    labels.set(item, `${number}. ${level === 1 ? words.toUpperCase() : words}`);
  }
  return { labels, parts };
}

/**
 * Where the paper's two columns start: at the first heading that is not the abstract's. The
 * title, the front matter, the abstract and the keywords before it run across the page.
 */
export function columnsStart(plan) {
  const at = plan.items.findIndex(item => item.type === 'heading' && item.role !== 'Abstract');
  return at < 0 ? plan.items.length : at;
}

/** "Draft version October 16, 2026", the running head of an article's first page. */
export function draftLine(date = new Date()) {
  return `Draft version ${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
}

const KEYWORDS = /^\*{0,2}keywords?\*{0,2}\s*[:.]\s*/i;

/**
 * The manuscript as a Word document in a layout, `paper` or `book`: a Title, Heading 1 to 3,
 * justified paragraphs with a first-line indent (none after a heading or a figure), bold,
 * italic, underlined, strikethrough, highlighted and code runs, a block's own alignment over
 * the layout's, and pictures centred with their description as
 * alternative text. In the paper layout the paragraphs before the first heading are the
 * centred front matter, a section headed Abstract is set narrower, a paragraph after a picture
 * that starts "Figure n." is its caption, and a section headed References is set small with
 * hanging indents; from the first heading after the abstract the body runs in two columns.
 * `pictures` maps an address to {data, mediaType, width, height}. A picture Word cannot take,
 * or one that could not be read, stands as its description in brackets and is named in
 * `missing`. `options.date` is the paper's draft date, today unless given.
 */
export function toDocx(plan, pictures, lib, Lexer, layoutName = 'book', options = {}) {
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
  const paper = layoutName === 'paper';
  const { labels, parts } = paper ? paperHeadings(plan) : { labels: new Map(), parts: new Set() };
  const columnsAt = paper ? columnsStart(plan) : -1;
  let columnsChild = children.length;
  // A block's own alignment wins over the one its layout or role gives it.
  const ALIGN = { Left: A.LEFT, Centre: A.CENTER, Right: A.RIGHT, Justify: A.JUSTIFIED };
  let own = null;
  const P = options => new lib.Paragraph(own ? { ...options, alignment: own } : options);
  const text = (markdown, size) => runs(markdown, lib, Lexer, size, L.size);
  const para = (options, markdown, size) => P({ ...options, children: text(markdown, size) });
  let firstAppendix = true;
  for (const [index, item] of plan.items.entries()) {
    if (item.type !== 'picture' || index === columnsAt) flushRow();
    if (index === columnsAt) {
      // A little room between the abstract and the columns, as an article leaves.
      children.push(new lib.Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));
      columnsChild = children.length;
    }
    own = ALIGN[item.align] ?? null;
    if (item.type === 'heading') {
      const level = parts.has(item) ? 1 : Math.min(item.level, 3), h = L.headings[level - 1];
      const part = PARTS.has(item.role) && level === 1;
      const centred = h.center || (part && (!paper || item.role === 'Abstract'));
      // A book starts every part and chapter on a new page; an article only its first appendix.
      const opensPage = item.kind ? item.kind === 'Part' || item.kind === 'Chapter' : level === 1;
      const breakBefore = (L.chapterBreaks && opensPage) || (level === 1 && paper && item.role === 'Appendix' && firstAppendix);
      if (item.role === 'Appendix' && level === 1) firstAppendix = false;
      children.push(P({ heading: headingLevels[level - 1], alignment: centred ? A.CENTER : A.LEFT, pageBreakBefore: breakBefore,
        children: text(labels.get(item) ?? item.text, paper && item.role === 'Abstract' ? L.abstract.size : undefined) }));
      indentNext = false; previous = item;
      continue;
    }
    if (item.type === 'picture') { row.push(item); continue; }
    if (item.type === 'table') {
      // Across the text, the header row repeated on each page it runs to.
      const width = Math.max(1, ...item.rows.map(r => r.length));
      children.push(new lib.Table({ width: { size: 100, type: lib.WidthType.PERCENTAGE },
        rows: item.rows.map((cells, r) => new lib.TableRow({ tableHeader: r === 0 || undefined, children: Array.from({ length: width }, (_, c) =>
          new lib.TableCell({ children: [new lib.Paragraph({ spacing: { before: 40, after: 40, line: 240 }, children: runs(cells[c] ?? '', lib, Lexer, Math.round(L.size * 0.9), L.size, false, r === 0) })] })) })) }));
      children.push(new lib.Paragraph({ spacing: { after: 120 }, children: [] }));
      indentNext = false; previous = item;
      continue;
    }
    if (item.list) {
      // A list item: Word's own numbering, each numbered list starting at 1.
      children.push(para({ alignment: A.LEFT, spacing: { after: 60 }, numbering: item.list === 'Numbered'
        ? { reference: 'mn-numbered', level: item.listLevel, instance: item.run } : { reference: 'mn-bulleted', level: item.listLevel } }, item.text));
      indentNext = false; previous = item;
      continue;
    }
    const role = item.role;
    let block = null, continues = false;
    switch (role) {
      case 'Caption': {
        const caption = FIGURE.exec(item.text);
        const label = caption ? `${caption[1][0].toUpperCase()}${caption[1].slice(1).toLowerCase()} ${caption[2]}${paper ? '.' : ':'}` : null;
        block = P({ alignment: paper ? A.JUSTIFIED : A.CENTER, spacing: { after: 240 }, indent: paper ? {} : { left: 360, right: 360 }, children: [
          ...(label ? [new lib.TextRun({ text: `${label} `, bold: (!L.caption.italics && !paper) || undefined, italics: L.caption.italics || undefined, size: L.caption.size })] : []),
          ...text(caption ? item.text.slice(caption[0].length) : item.text, L.caption.size)] });
        break;
      }
      case 'Subtitle':
        block = para({ alignment: A.CENTER, spacing: { after: 200 } }, item.text, paper ? L.size : Math.round(L.title.size * 0.6));
        break;
      case 'Author':
        // An article's authors are in small capitals, as AASTeX sets them.
        block = paper
          ? P({ alignment: A.CENTER, spacing: { after: L.front.after }, children: markdownToInline(item.text, Lexer).map(n => new lib.TextRun({ text: n.text ?? '', break: n.type === 'hardBreak' ? 1 : undefined, smallCaps: true, size: L.front.size + 2 })) })
          : para({ alignment: A.CENTER, spacing: { after: L.front.after } }, item.text, L.front.size);
        break;
      case 'Dedication':
        // Word drops the space before a paragraph at the top of a page, so a dedication on its own
        // page is lowered by an empty paragraph's space after.
        if (L.titlePage) children.push(new lib.Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 2400 }, children: [] }));
        block = P({ alignment: A.CENTER, spacing: { before: L.titlePage ? 0 : 240, after: 240 }, children: runs(item.text, lib, Lexer, undefined, L.size, true) });
        break;
      case 'Epigraph':
        block = P({ alignment: A.LEFT, spacing: { before: 120, after: 240 }, indent: { left: Math.round(L.page.width * 0.3) },
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
          ? para({ alignment: A.JUSTIFIED, indent: { left: L.abstract.indent, right: L.abstract.indent, firstLine: L.firstLine } }, item.text, L.abstract.size)
          : para({ alignment: A.JUSTIFIED, indent: { firstLine: indentNext ? L.firstLine : 0 } }, item.text);
        continues = true;
        break;
      case 'Keywords':
        // "Keywords:" in italics, the list hanging under it.
        block = paper
          ? P({ alignment: A.LEFT, spacing: { before: 200, after: 120 }, indent: { left: L.abstract.indent + 950, right: L.abstract.indent, hanging: 950 },
            children: [new lib.TextRun({ text: 'Keywords: ', italics: true }), ...text(item.text.replace(KEYWORDS, ''), L.abstract.size)] })
          : para({ alignment: A.LEFT, spacing: { before: 120 } }, item.text);
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
  const heading = h => ({ run: { font: L.font, size: h.size, bold: h.bold !== false, italics: !!h.italics, color: '000000' },
    paragraph: { spacing: { before: h.before, after: h.after }, keepNext: true, keepLines: true } });
  const listLevels = (format, text) => Array.from({ length: MAX_LEVEL + 1 }, (_, level) => ({ level, format, text: text(level), alignment: A.LEFT,
    style: { paragraph: { indent: { left: 360 * (level + 1) + 360, hanging: 360 } } } }));
  const NUMBER_FORMATS = [lib.LevelFormat.DECIMAL, lib.LevelFormat.LOWER_LETTER, lib.LevelFormat.LOWER_ROMAN, lib.LevelFormat.DECIMAL, lib.LevelFormat.LOWER_LETTER];
  const document = new lib.Document({
    creator: 'Nendo Manuscript', title: plan.title,
    numbering: { config: [
      { reference: 'mn-bulleted', levels: listLevels(lib.LevelFormat.BULLET, level => BULLETS[level]) },
      { reference: 'mn-numbered', levels: listLevels(lib.LevelFormat.DECIMAL, level => `%${level + 1}.`).map((l, i) => ({ ...l, format: NUMBER_FORMATS[i] })) },
    ] },
    styles: {
      // docx writes its own Title and Heading styles; these are what it writes them as.
      default: {
        document: { run: { font: L.font, size: L.size, color: '000000' }, paragraph: { spacing: { line: L.line, after: L.after } } },
        title: { run: { font: L.font, size: L.title.size, bold: layoutName === 'paper', color: '000000' },
          paragraph: { alignment: A.CENTER, spacing: { before: L.title.before, after: L.title.after } } },
        heading1: heading(L.headings[0]), heading2: heading(L.headings[1]), heading3: heading(L.headings[2]),
      },
    },
    sections: paper ? paperSections(lib, L, children, columnsChild, options.date) : [{
      properties: pageProperties(L),
      footers: L.pageNumbers ? { default: new lib.Footer({ children: [new lib.Paragraph({ alignment: A.CENTER, children: [new lib.TextRun({ children: [lib.PageNumber.CURRENT], size: 20 })] })] }) } : undefined,
      children: L.titlePage ? [children[0], new lib.Paragraph({ children: [], pageBreakBefore: false }), ...children.slice(1)] : children,
    }],
  });
  return { document, missing };
}

function pageProperties(L) {
  const side = L.page.side ?? L.page.margin;
  return { page: { size: { width: L.page.width, height: L.page.height },
    margin: { top: L.page.margin, right: side, bottom: L.page.margin, left: side, header: 720, footer: 720 } } };
}

/**
 * An article's two sections: the title block across the page, then the body in two columns,
 * continuing on the same page. The first page carries the draft line at the top left, every
 * later one its number at the top right; both sections carry the pair, so whichever Word
 * reads for a page says the same.
 */
function paperSections(lib, L, children, at, date) {
  const A = lib.AlignmentType;
  const headers = () => ({
    first: new lib.Header({ children: [new lib.Paragraph({ alignment: A.LEFT, children: [new lib.TextRun({ text: draftLine(date), smallCaps: true, size: 18 })] })] }),
    default: new lib.Header({ children: [new lib.Paragraph({ alignment: A.RIGHT, children: [new lib.TextRun({ children: [lib.PageNumber.CURRENT], size: 18 })] })] }),
  });
  const across = { properties: { ...pageProperties(L), titlePage: true }, headers: headers(), children: children.slice(0, at) };
  if (at >= children.length) return [across];
  return [across, { properties: { ...pageProperties(L), titlePage: true, type: lib.SectionType.CONTINUOUS, column: { count: L.columns.count, space: L.columns.space } },
    headers: headers(), children: children.slice(at) }];
}
