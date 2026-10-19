// The manuscript as Markdown and as a Word document (C-11), from the blocks as saved in the
// file. Pure functions: the libraries and marked's Lexer are passed in, so Node tests drive the
// same code the view runs (tools/manus/export.test.mjs).
import { levelOf, MAX_LEVEL } from './model.mjs';
import { pictureOf, markdownToInline, FOOTNOTE } from './inline.mjs';
import { setLines, timesWidth, termesWidth, lineDepth, drawnSpaces, softHyphens, balancedSplit, TEX } from './typeset.mjs';
import { hyphenate } from './hyphenation.mjs';

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
  // Footnotes numbered as they are first cited, in reading order, cells included.
  const numbers = new Map(), footnotes = [];
  const cite = text => { for (const m of (text ?? '').matchAll(FOOTNOTE)) if (!numbers.has(m[1])) { numbers.set(m[1], numbers.size + 1); footnotes.push({ id: m[1], n: numbers.size, text: manuscript.footnotes?.get(m[1])?.text ?? '' }); } };
  for (const item of items) { if (item.type === 'table') item.rows.flat().forEach(cite); else cite(item.text); }
  return { title: (manuscript.title ?? '').trim() || 'Untitled manuscript', items: numberLists(items), footnotes, footnoteNumbers: numbers };
}

/** A block's text with each footnote cited by its number, as Markdown's footnotes write it. */
const markdownFootnotes = (text, numbers) => (text ?? '').replace(FOOTNOTE, (all, id) => numbers?.has(id) ? `[^${numbers.get(id)}]` : '');

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

// Times' advance widths in thousandths of an em, space to tilde: Times New Roman's, which TeX
// Gyre Termes and Nimbus Roman share.
const TIMES = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541];
const ems = text => [...text].reduce((w, c) => w + (TIMES[c.charCodeAt(0) - 32] ?? 500), 0) / 1000;
const plainWords = markdown => (markdown ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>|[*_`~\\]/g, '');

/**
 * A table's column widths, as shares of its width that add up to 1, by the rule Word's and a
 * browser's automatic layout follow: every column at least as wide as its longest word, and
 * what is left shared by how much more each column's longest cell would take. `width` is the
 * table's width and `padding` each cell's padding on both sides together, in ems of its type;
 * the words are measured in Times. The paper's three renders take the same widths from here.
 */
export function tableColumns(rows, width, padding = 0) {
  const count = Math.max(1, ...rows.map(r => r.length));
  const least = Array(count).fill(padding), most = Array(count).fill(padding);
  for (const row of rows) row.forEach((cell, c) => {
    const words = plainWords(cell).split(/\s+/).filter(Boolean);
    least[c] = Math.max(least[c], padding + Math.max(0, ...words.map(ems)));
    most[c] = Math.max(most[c], padding + ems(words.join(' ')));
  });
  const sum = list => list.reduce((a, b) => a + b, 0);
  let widths;
  if (sum(most) <= width) widths = most.map(w => w * width / sum(most));
  else if (sum(least) >= width) widths = least.map(w => w * width / sum(least));
  else widths = least.map((w, c) => w + (width - sum(least)) * (most[c] - w) / (sum(most) - sum(least)));
  return widths.map(w => w / width);
}

/** The paper's table columns, as the Word export, the preview and the reference share them. */
export const paperTableColumns = (rows, A = article()) => tableColumns(rows, A.column / A.cellSize, 2 * A.cellPad / A.cellSize);

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
  const numbers = plan.footnoteNumbers;
  plan = { ...plan, items: plan.items.map(item => item.type === 'table' ? { ...item, rows: item.rows.map(r => r.map(c => markdownFootnotes(c, numbers))) }
    : item.text !== undefined ? { ...item, text: markdownFootnotes(item.text, numbers) } : item) };
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
    // A scene break's own words ("Three years later") are kept; an empty one is the three stars.
    else if (item.role === 'Scene break') parts.push(item.text.trim() || '* * *');
    else if (['Quotation', 'Epigraph', 'Aside'].includes(item.role)) parts.push(quoted(item.text));
    else parts.push(item.text);
  }
  // The footnotes at the end, as Markdown's footnote extension writes them.
  const notes = (plan.footnotes ?? []).map(f => `[^${f.n}]: ${markdownFootnotes(f.text, numbers).replace(/\\\n/g, ' ').trim() || ' '}`);
  if (notes.length) parts.push(notes.join('\n'));
  return parts.join('\n\n') + '\n';
}

// The footnote numbers of the document being written, for runs to cite.
let citing = null;

function runs(markdown, lib, Lexer, size, base = 22, italic = false, bold = false) {
  const out = [];
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out.push(new lib.TextRun({ text: '', break: 1 })); continue; }
    if (node.type === 'footnote') {
      const n = citing?.get(node.attrs.id);
      // Word's own footnote: the number in the text, the note at the foot of its page.
      if (n) out.push(lib.FootnoteReferenceRun ? new lib.FootnoteReferenceRun(n) : new lib.TextRun({ text: String(n), superScript: true }));
      continue;
    }
    out.push(markedRun(node.text, node.marks, lib, size, base, italic, bold));
  }
  return out;
}

/** A run of `text` with its inline marks, `extra` (such as characterSpacing) added. */
function markedRun(text, markList, lib, size, base = 22, italic = false, bold = false, extra = {}) {
  const marks = new Set((markList ?? []).map(m => m.type));
  const href = (markList ?? []).find(m => m.type === 'link')?.attrs?.href;
  // Only marks that are on: a run that says bold false would override a bold heading style.
  const run = new lib.TextRun({ text, bold: bold || marks.has('bold') || undefined, italics: italic || marks.has('italic') || undefined, strike: marks.has('strike') || undefined,
    underline: marks.has('underline') ? {} : undefined, highlight: marks.has('highlight') ? 'yellow' : undefined,
    font: marks.has('code') ? 'Consolas' : undefined, size: marks.has('code') ? Math.round((size ?? base) * 0.88) : size, style: href ? 'Hyperlink' : undefined, ...extra });
  // A web link is Word's own hyperlink, which a click in Word follows.
  return href && lib.ExternalHyperlink ? new lib.ExternalHyperlink({ link: href, children: [run] }) : run;
}

// The bibliography as AASTeX sets it: ragged right, French spacing, never hyphenated.
export const BIBLIOGRAPHY = { ...TEX, ragged: true, french: true, hyphenpenalty: 10000, emergencystretch: 27 * 72 / 72.27 };

/**
 * The paper layout's page as AASTeX 6.3.1 sets its twocolumn style, in points, measured from a
 * LaTeX render of the same plan (tools/manus/latex.mjs). The Word export and the preview
 * both set the page from these. A distance named for what it leads to is from the baseline
 * before it to that baseline; `pitch` is from one line's baseline to the next.
 */
export const ARTICLE = {
  // The columns are TeX's own \columnwidth (242.26653pt) and \columnsep, not a measurement: a
  // hundredth of a point decides where some lines break.
  width: 612, height: 792, left: 50.74, column: 241.3614, gap: 28.4772,
  // A column's first baseline on a page after the first, and the lowest it may hold.
  top: 74.6, bottom: 716.85,
  // The running heads: the page number, and the draft line on the first page, indented.
  // Type sizes are TeX's (10pt is 9.963 PostScript points), so the preview's words are as wide
  // as the reference's and break where its lines break; Word rounds them to its half points.
  folio: 51.6, draft: 58.8, draftIndent: 9, draftSize: 7.9701,
  // Line pitches are TeX's baselineskips: 12.5pt, 11pt for captions and cells, 13pt for references.
  size: 9.9626, pitch: 12.4533, indent: 9,
  // The title block, across the page: the title's baseline, then each line after it.
  title: 116.3, author: 17, authorSize: 8.9664, front: 17, frontSize: 7.9701, abstractHeading: 24.4, abstract: 15.3,
  // The abstract is 444pt wide (478pt less a 34pt \leftskip), its paragraphs indented 9pt.
  abstractLeft: 33.873, abstractRight: 34.9858, abstractIndent: 8.9664, columns: 26.6,
  // Headings: a numbered section in 9 points, a part (Abstract, References) and a subsection in 10.
  heading: 21.45, afterHeading: 16.43, sectionSize: 8.9664, headingAfterTable: 29.8,
  // A list item: room above each and after the list, its number ending and its text starting.
  listSpace: 8, number: 20.9215, hang: 24.9066,
  // Pictures fill the column, a row's side by side with a gap; the caption under them. Around a
  // picture or a table TeX leaves room from the bottom of the line above, so each distance marked
  // + depth adds how far that line reaches below its baseline (lineDepth in typeset.mjs), or
  // `descender` of its type when the line is not known.
  pictureAbove: 13, pictureAfterCaption: 25, pictureGap: 18, captionBelow: 15.9, captionSize: 8.9664, captionPitch: 10.9589,
  afterCaption: 23, headingAfterCaption: 28.8, descender: 0.218,
  // A table: its caption above it, a double rule, the header row, a rule, the rows, a rule.
  tableCaption: 23.9, ruleBelowCaption: 16, rulePair: 1.9, cellSize: 8.9664, cellPitch: 10.9589, cellPad: 5, rowSpace: 2, afterTable: 20.15,
  // The references: their heading across the page under balanced columns, the entries hanging.
  references: 32.2, firstReference: 18.6, referenceSize: 8.9664, referencePitch: 12.9514, referenceHang: 8.9664,
};

// Sizes are half-points and distances twentieths of a point (twips), as Word stores them.
export const LAYOUTS = {
  /**
   * An article as arXiv carries one in the AASTeX two-column style: Times at 10 points on Letter,
   * the title block, abstract and keywords across the page, the body in two justified columns,
   * headings centred and numbered ("1. INTRODUCTION", "2.1. Documents as applications"), a
   * running head on the first page and page numbers at the top right after it.
   */
  paper: {
    // The page itself is ARTICLE's, in points; these are the sizes its styles are written with.
    font: 'Times New Roman', size: 20, line: 249, firstLine: 180, after: 0,
    page: { width: 12240, height: 15840, margin: 1293, side: 1015 }, columns: { count: 2, space: 570 },
    title: { size: 20, before: 0, after: 0 }, front: { size: 16, after: 0 },
    headings: [{ size: 18, before: 199, after: 0, center: true, bold: false }, { size: 20, before: 199, after: 0, center: true, bold: false, italics: true },
      { size: 20, before: 199, after: 0, bold: false, italics: true }],
    abstract: { size: 20, indent: 678 }, caption: { size: 18 }, references: { size: 18, hanging: 180 },
    figureWidth: 322, textWidth: 322, pageNumbers: 'header', chapterBreaks: false, titlePage: false,
  },
  /**
   * A manuscript for submission, as agents and publishers ask for one: Times New Roman at 12
   * points, double-spaced, on Letter with one-inch margins, paragraphs indented half an inch,
   * chapters on new pages, page numbers at the foot.
   */
  manuscript: {
    font: 'Times New Roman', size: 24, line: 480, firstLine: 720, after: 0,
    page: { width: 12240, height: 15840, margin: 1440 },
    title: { size: 24, before: 2880, after: 480 }, front: { size: 24, after: 0 },
    headings: [{ size: 24, before: 2880, after: 480, center: true, bold: false }, { size: 24, before: 480, after: 0, center: true, bold: false }, { size: 24, before: 480, after: 0, bold: false, italics: true }],
    abstract: null, caption: { size: 24, italics: true }, references: { size: 24, hanging: 720 },
    figureWidth: 468, textWidth: 468, pageNumbers: true, chapterBreaks: true, titlePage: false,
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

// A page by its name, in twentieths of a point.
export const PAGE_TWIPS = { 'Letter': [12240, 15840], 'A4': [11906, 16838], 'A5': [8391, 11906], '6 × 9 in': [8640, 12960] };
const SPACING_LINE = { 'Single': 240, '1.15': 276, '1.5': 360, 'Double': 480 };

/**
 * A layout with an output profile's choices over it: page size, margins in millimetres, the
 * typeface, its size in points (headings, title and the smaller roles scaled with it), line
 * spacing and page numbers. A choice left empty keeps the layout's own.
 */
export function withProfile(layout, profile) {
  if (!profile) return layout;
  const L = structuredClone(layout);
  const page = PAGE_TWIPS[profile.page];
  if (page) [L.page.width, L.page.height] = page;
  if (Number.isFinite(profile.margin) && profile.margin > 0) { L.page.margin = Math.round(profile.margin * 56.693); delete L.page.side; }
  if (profile.font) L.font = profile.font;
  if (Number.isFinite(profile.size) && profile.size > 0) {
    const scale = profile.size * 2 / L.size;
    const sized = o => { if (o && typeof o.size === 'number') o.size = Math.round(o.size * scale); };
    L.size = profile.size * 2;
    [L.title, L.front, L.abstract, L.caption, L.references, ...L.headings].forEach(sized);
  }
  if (SPACING_LINE[profile.spacing]) L.line = SPACING_LINE[profile.spacing];
  if (typeof profile.numbers === 'boolean') L.pageNumbers = profile.numbers ? (layout.pageNumbers === 'header' ? 'header' : true) : false;
  // Pictures fit what is left between the margins.
  const text = Math.floor((L.page.width - 2 * (L.page.side ?? L.page.margin)) / 20);
  L.textWidth = Math.min(L.columns ? layout.textWidth : text, text);
  L.figureWidth = Math.min(layout.figureWidth, L.textWidth);
  return L;
}

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
// What may follow w:suppressAutoHyphens in a paragraph's properties, in the schema's order.
const AFTER_HYPHENS = /<w:(?:kinsoku|wordWrap|overflowPunct|topLinePunct|autoSpaceDE|autoSpaceDN|bidi|adjustRightInd|snapToGrid|spacing|ind|contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/;

/**
 * A document toDocx built, as the bytes of a .docx (`type` as JSZip names it: 'blob' or
 * 'nodebuffer'): docx's own, with Word's Don't hyphenate added to the paragraph styles named in
 * `built.unhyphenated`, which docx 9.8.1 cannot write. An article's references and table text
 * are never hyphenated, as TeX sets them.
 */
export async function packDocx(built, lib, type = 'blob') {
  const zip = await lib.JSZip.loadAsync(await lib.Packer.toArrayBuffer(built.document));
  let styles = await zip.file('word/styles.xml').async('string');
  for (const id of built.unhyphenated ?? []) {
    styles = styles.replace(new RegExp(`(<w:style [^>]*w:styleId="${id}"[^>]*>)([\\s\\S]*?)(</w:style>)`), (all, open, inner, close) => {
      if (!inner.includes('<w:pPr>')) return `${open}${inner.replace(/(<w:rPr>|$)/, '<w:pPr><w:suppressAutoHyphens/></w:pPr>$1')}${close}`;
      return open + inner.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (p, body) => {
        const at = body.search(AFTER_HYPHENS);
        return `<w:pPr>${at < 0 ? `${body}<w:suppressAutoHyphens/>` : `${body.slice(0, at)}<w:suppressAutoHyphens/>${body.slice(at)}`}</w:pPr>`;
      }) + close;
    });
  }
  zip.file('word/styles.xml', styles);
  return zip.generateAsync({ type, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export function toDocx(plan, pictures, lib, Lexer, layoutName = 'book', options = {}) {
  citing = plan.footnoteNumbers ?? new Map();
  try { return docx(plan, pictures, lib, Lexer, layoutName, options); } finally { citing = null; }
}

/**
 * The paper's page with an output profile over it, in points: a page size or margins move the
 * columns, a type size scales the type and every distance with it, line spacing the pitches.
 */
export function article(profile) {
  const A = { ...ARTICLE, right: ARTICLE.width - ARTICLE.left - 2 * ARTICLE.column - ARTICLE.gap };
  if (!profile) return A;
  const page = PAGE_TWIPS[profile.page];
  if (page) [A.width, A.height] = page.map(t => t / 20);
  const scale = Number.isFinite(profile.size) && profile.size > 0 ? profile.size / 10 : 1;
  const spacing = { '1.15': 1.15, '1.5': 1.5, 'Double': 2 }[profile.spacing] ?? 1;
  const PAGE = new Set(['width', 'height', 'left', 'right', 'column', 'gap', 'top', 'bottom', 'folio', 'draft', 'title']);
  for (const key of Object.keys(ARTICLE)) if (!PAGE.has(key)) A[key] = ARTICLE[key] * scale;
  for (const key of ['pitch', 'captionPitch', 'cellPitch', 'referencePitch']) A[key] *= spacing;
  const margin = Number.isFinite(profile.margin) && profile.margin > 0 ? profile.margin * 72 / 25.4 : null;
  if (margin !== null) {
    A.left = A.right = margin;
    A.top = margin + 0.8 * A.pitch;
    A.folio = margin * ARTICLE.folio / ARTICLE.top;
    A.draft = margin * ARTICLE.draft / ARTICLE.top;
  } else A.top = ARTICLE.top - 0.8 * ARTICLE.pitch + 0.8 * A.pitch;
  A.bottom = A.height - (ARTICLE.height - ARTICLE.bottom) * (margin === null ? 1 : margin / ARTICLE.left);
  A.title = A.top + (ARTICLE.title - ARTICLE.top) * scale;
  A.column = (A.width - A.left - A.right - A.gap) / 2;
  return A;
}

function docx(plan, pictures, lib, Lexer, layoutName, options) {
  const L = withProfile(LAYOUTS[layoutName] ?? LAYOUTS.book, options.profile);
  const A = lib.AlignmentType;
  const paper = layoutName === 'paper';
  const G = paper ? article(options.profile) : null;
  // Twips, Word's exact line, and the room before a line: Word sets a line of exact height H
  // with its baseline 0.8 H below its top, so a baseline `gap` below the one of a line of height
  // `above` is that gap less 0.2 of the line above and 0.8 of this one.
  const T = pt => Math.round(pt * 20), half = pt => Math.round(pt * 2);
  const exact = pt => ({ line: T(pt), lineRule: 'exact' });
  const lead = (gap, above, height) => Math.max(0, T(gap - 0.2 * above - 0.8 * height));
  const headingLevels = [lib.HeadingLevel.HEADING_1, lib.HeadingLevel.HEADING_2, lib.HeadingLevel.HEADING_3];
  const children = [new lib.Paragraph({ heading: lib.HeadingLevel.TITLE, alignment: A.CENTER,
    ...(paper ? { spacing: { before: lead(G.title - (G.top - 0.8 * G.pitch), 0, G.pitch), after: 0, ...exact(G.pitch) } } : {}),
    children: [new lib.TextRun({ text: plan.title })] })];
  const missing = [];
  let indentNext = false, previous = null;
  // In the paper, what was set last decides the room above what comes next, as in AASTeX: its
  // kind, and the height of its line (0 for a table, measured from its rule).
  // Around a picture or a table the room runs from the bottom of the line above, so it grows with
  // that line's depth: known when the line was set here, else a descender of its type.
  let last = { kind: 'front', height: paper ? G.pitch : 0 };
  const depthOf = was => was.depth ?? G.descender * (was.size ?? G.size);
  const room = (kind, height, pictureTop = false) => {
    const was = last; last = { kind, height };
    if (pictureTop) return was.kind === 'top' ? 0 : Math.max(0, T((was.kind === 'caption' ? G.pictureAfterCaption : G.pictureAbove) + depthOf(was) - 0.2 * was.height));
    // At the top of the columns nothing is added: the title block's room is already there.
    if (was.kind === 'top') return 0;
    if (kind === 'heading') return lead(was.kind === 'heading' ? G.afterHeading : was.kind === 'caption' ? G.headingAfterCaption + depthOf(was) : was.kind === 'table' ? G.headingAfterTable : G.heading, was.height, height);
    if (was.kind === 'heading') return lead(G.afterHeading, was.height, height);
    if (was.kind === 'caption') return lead(G.afterCaption + depthOf(was), was.height, height);
    if (was.kind === 'table') return lead(G.afterTable, 0, height);
    if (kind === 'item' || was.kind === 'item') return lead(G.pitch + G.listSpace, was.height, height);
    return lead(height, was.height, height);
  };
  const spaced = (kind, height) => paper ? { spacing: { before: room(kind, height), after: 0, ...exact(height) } } : {};
  // The paper as TeX sets it (options.typeset): each paragraph broken into the lines the
  // reference's TeX finds (typeset.mjs, measured in Termes), every line but the last ending in a
  // manual break, its spaces widened by character spacing until Word's own Times fills the line,
  // a quarter point short so Word never wraps it again. Returns the runs and the last line's
  // depth, or null for a paragraph with a footnote or a hard break, which Word sets itself.
  const typeset = paper && !!options.typeset;
  const setText = (markdown, { size, width, indent = 0, prefix = [], params = TEX, hyphenating = true, italic = false }) => {
    const nodes = markdownToInline(markdown, Lexer);
    if (nodes.some(n => n.type === 'hardBreak' || n.type === 'footnote')) return null;
    const styleOf = (marks, code) => ({ bold: marks.has('bold'), italic: italic || marks.has('italic'), code, size: code ? size * 0.88 : size });
    const pieces = [...prefix.map(p => ({ ...p, style: styleOf(new Set(p.marks.map(m => m.type)), false) })), ...nodes.map(node => {
      const marks = new Set((node.marks ?? []).map(m => m.type));
      return { text: hyphenating && !marks.has('code') ? softHyphens(node.text, hyphenate) : node.text, marks: node.marks ?? [], style: styleOf(marks, marks.has('code')) };
    })];
    const sp = timesWidth(' ', { size });
    const lines = setLines(pieces, { measure: termesWidth, space: { width: sp, stretch: sp / 2, shrink: sp / 3, extra: sp / 3 }, widths: n => n === 0 ? width - indent : width, params });
    if (!lines) return null;
    // Word sets the type at its half points, code at 0.88 of the text rounded again.
    const words = half(size) / 2, code = Math.round(half(size) * 0.88) / 2;
    const drawn = (text, style) => timesWidth(text, { ...style, size: style.code ? code : words });
    const natural = timesWidth(' ', { size: words });
    const out = [];
    for (const line of lines) {
      const spaces = drawnSpaces({ ...line, width: line.width - 0.25 }, drawn);
      let at = 0;
      for (const part of line.parts) {
        if (part.space === undefined) out.push(markedRun(part.text, part.piece.marks, lib, undefined, L.size, italic));
        else out.push(new lib.TextRun({ text: ' ', characterSpacing: Math.floor((spaces[at++] - natural) * 20) }));
      }
      if (line.hyphen) out.push(markedRun('-', line.hyphen.piece.marks, lib, undefined, L.size, italic));
      if (!line.last) out.push(new lib.TextRun({ text: '', break: 1 }));
    }
    const final = lines.at(-1);
    return { runs: out, count: lines.length, depth: lineDepth(final.parts.filter(p => p.space === undefined).map(p => ({ text: p.text, style: p.piece.style }))) };
  };
  // Pictures next to each other share one figure row, as subfigures do, each at its share of the
  // width; a single picture is set at the layout's figure width.
  let row = [];
  const flushRow = () => {
    if (!row.length) return;
    // The paper's pictures fill the column, a row's side by side 18 points apart; in points.
    const each = paper ? (row.length === 1 ? G.column : (G.column - G.pictureGap * (row.length - 1)) / row.length - 0.05) * 4 / 3
      : row.length === 1 ? L.figureWidth : Math.floor((L.textWidth - 24 * (row.length - 1)) / row.length);
    const runsOfRow = [];
    row.forEach((item, i) => {
      const picture = pictures.get(item.address), type = picture && WORD_TYPE[picture.mediaType];
      if (i > 0) runsOfRow.push(paper ? new lib.TextRun({ text: ' ', characterSpacing: T(G.pictureGap - G.size / 4) }) : new lib.TextRun({ text: '    ' }));
      if (!picture || !type || !picture.width || !picture.height) {
        missing.push({ alt: item.alt, address: item.address, why: !picture ? 'not read' : 'a type Word does not hold' });
        runsOfRow.push(new lib.TextRun({ text: `[Picture: ${item.alt || 'no description'}]`, italics: true }));
        return;
      }
      const width = Math.min(each, paper ? Infinity : picture.width), height = width * picture.height / picture.width;
      runsOfRow.push(new lib.ImageRun({ type, data: picture.data, transformation: paper ? { width, height } : { width: Math.round(width), height: Math.round(height) },
        altText: { name: item.alt || 'Picture', title: item.alt || 'Picture', description: item.alt || '' } }));
    });
    children.push(new lib.Paragraph({ alignment: A.CENTER, keepNext: true,
      spacing: paper ? { before: room('picture', 0, true), after: 0, line: 240, lineRule: 'auto' } : { before: 200, after: 80 }, children: runsOfRow }));
    if (paper) last = { kind: 'picture', height: 0 };
    indentNext = false; previous = row.at(-1); row = [];
  };
  const { labels, parts } = paper ? paperHeadings(plan) : { labels: new Map(), parts: new Set() };
  // References that start a page sit in two columns that revtex balances; Word balances its own
  // way, so the entry the second column starts with is given a column break.
  const referenceSet = item => setText(item.text, { size: G.referenceSize, width: G.column - G.referenceHang, indent: -G.referenceHang, params: BIBLIOGRAPHY, hyphenating: false });
  let secondColumn = null;
  if (typeset && options.referencesOnNewPage) {
    const entries = plan.items.filter(i => i.type !== 'heading' && i.role === 'References');
    const counts = entries.map(i => referenceSet(i)?.count ?? 1);
    if (entries.length > 1) secondColumn = entries[balancedSplit(counts, G.referencePitch, G.size)] ?? null;
  }
  const columnsAt = paper ? columnsStart(plan) : -1;
  // The paper's sections: the title block across the page, the body in two columns, and the
  // references' heading across the page over their two columns, each starting at a child.
  const sectionsAt = [];
  // A block's own alignment wins over the one its layout or role gives it.
  const ALIGN = { Left: A.LEFT, Centre: A.CENTER, Right: A.RIGHT, Justify: A.JUSTIFIED };
  let own = null;
  const P = options => new lib.Paragraph(own ? { ...options, alignment: own } : options);
  const text = (markdown, size) => runs(markdown, lib, Lexer, size, L.size);
  const para = (options, markdown, size) => P({ ...options, children: text(markdown, size) });
  // The paragraph styles the document uses, each written once into styles.xml.
  const named = new Map();
  const styled = (id, name, paragraph = {}, run = {}) => {
    if (!named.has(id)) named.set(id, { id, name, basedOn: 'Normal', next: 'BodyText', quickFormat: true, paragraph, run });
    return id;
  };
  // Body text: the first paragraph after a heading, a picture or a set-apart block starts flush,
  // except in the paper, which indents every paragraph of running text as AASTeX does.
  const body = indented => indented || paper
    ? styled('BodyText', 'Body Text', { alignment: A.JUSTIFIED, indent: { firstLine: paper ? T(G.indent) : L.firstLine } })
    : styled('BodyTextFirst', 'Body Text First', { alignment: A.JUSTIFIED, indent: { firstLine: 0 } });
  let firstAppendix = true;
  for (const [index, item] of plan.items.entries()) {
    if (item.type !== 'picture' || index === columnsAt) flushRow();
    if (index === columnsAt) {
      // Room between the title block and the columns: an empty line of that height, so both
      // columns start level, as a heading's own room above would start only the first lower.
      children.push(new lib.Paragraph({ spacing: paper ? { before: 0, after: 0, ...exact(G.columns - 0.2 * last.height - 0.8 * G.pitch) } : { before: 0, after: 120 }, children: [] }));
      sectionsAt.push({ at: children.length, columns: 2 });
      if (paper) last = { kind: 'top', height: G.pitch };
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
      // The references' heading runs across the page, under the columns above it balanced.
      const across = paper && parts.has(item) && item.role === 'References' && index > columnsAt;
      let spacing = {};
      if (across) {
        // Where AASTeX has no room for the heading and two entries under it, the references
        // start the next page and the columns above stay as filled, not balanced: the caller
        // says so (options.referencesOnNewPage), from the preview's layout or the reference's,
        // which only a paper set as TeX sets it follows line for line.
        const newPage = typeset && !!options.referencesOnNewPage;
        sectionsAt.push({ at: children.length, columns: 1, newPage });
        spacing = { spacing: { before: newPage ? 0 : lead(G.references, last.height, G.pitch), after: T(G.firstReference - 0.2 * G.pitch - 0.8 * G.referencePitch), ...exact(G.pitch) } };
        last = { kind: 'top', height: G.referencePitch };
      } else if (paper && item.role === 'Abstract' && index < columnsAt) {
        spacing = { spacing: { before: lead(G.abstractHeading, last.height, G.pitch), after: 0, ...exact(G.pitch) } };
        last = { kind: 'abstract-heading', height: G.pitch };
      } else spacing = spaced('heading', G?.pitch);
      // A part (Abstract, References) is set at the text's size, a numbered section smaller.
      const size = paper && part ? half(G.size) : undefined;
      children.push(P({ heading: headingLevels[level - 1], alignment: centred || (paper && level <= 2) ? A.CENTER : A.LEFT, pageBreakBefore: breakBefore, ...spacing,
        children: text(labels.get(item) ?? item.text, size) }));
      if (across) sectionsAt.push({ at: children.length, columns: 2 });
      indentNext = false; previous = item;
      continue;
    }
    if (item.type === 'picture') { row.push(item); continue; }
    if (item.type === 'table') {
      if (paper) {
        // As AASTeX sets a table: a double rule above, a rule under the header row and one
        // below, no others, the columns as tableColumns shares them, in 9 points.
        const shares = paperTableColumns(item.rows, G);
        const NONE = { style: lib.BorderStyle.NONE, size: 0, color: 'auto' }, RULE = { style: lib.BorderStyle.SINGLE, size: 4, color: '000000' };
        const pad = T(G.rowSpace / 2), side = T(G.cellPad);
        children.push(new lib.Table({ width: { size: T(G.column), type: lib.WidthType.DXA }, columnWidths: shares.map(s => T(s * G.column)), layout: lib.TableLayoutType.FIXED,
          margins: { top: pad, bottom: pad, left: side, right: side },
          borders: { top: { style: lib.BorderStyle.DOUBLE, size: 4, color: '000000' }, bottom: RULE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
          rows: item.rows.map((cells, r) => new lib.TableRow({ tableHeader: r === 0 || undefined, cantSplit: true, children: shares.map((s, c) =>
            new lib.TableCell({ width: { size: T(s * G.column), type: lib.WidthType.DXA }, borders: r === 0 ? { bottom: RULE } : undefined,
              children: [new lib.Paragraph({ style: styled('TableText', 'Table Text', { alignment: A.LEFT }, { size: half(G.cellSize) }), spacing: { before: 0, after: 0, ...exact(G.cellPitch) }, children: runs(cells[c] ?? '', lib, Lexer, undefined, L.size) })] })) })) }));
        last = { kind: 'table', height: 0 };
      } else {
        // Across the text, the header row repeated on each page it runs to.
        const width = Math.max(1, ...item.rows.map(r => r.length));
        children.push(new lib.Table({ width: { size: 100, type: lib.WidthType.PERCENTAGE },
          rows: item.rows.map((cells, r) => new lib.TableRow({ tableHeader: r === 0 || undefined, children: Array.from({ length: width }, (_, c) =>
            new lib.TableCell({ children: [new lib.Paragraph({ spacing: { before: 40, after: 40, line: 240 }, children: runs(cells[c] ?? '', lib, Lexer, Math.round(L.size * 0.9), L.size, false, r === 0) })] })) })) }));
        children.push(new lib.Paragraph({ spacing: { after: 120 }, children: [] }));
      }
      indentNext = false; previous = item;
      continue;
    }
    if (item.list) {
      // A list item: Word's own numbering, each numbered list starting at 1.
      const numbering = item.list === 'Numbered' ? { reference: 'mn-numbered', level: item.listLevel, instance: item.run } : { reference: 'mn-bulleted', level: item.listLevel };
      const set = typeset ? setText(item.text, { size: G.size, width: G.column - G.hang - 18 * item.listLevel }) : null;
      if (set) { children.push(P({ alignment: A.LEFT, ...spaced('item', G.pitch), numbering, children: set.runs })); last.depth = set.depth; }
      else children.push(para({ alignment: paper ? A.JUSTIFIED : A.LEFT, ...(paper ? spaced('item', G.pitch) : { spacing: { after: 60 } }), numbering }, item.text));
      indentNext = false; previous = item;
      continue;
    }
    const role = item.role;
    let block = null, continues = false;
    // Each role a paragraph style of its own, its formatting in the style: change Quotation in
    // Word and every quotation changes. In the paper the room above is the paragraph's own.
    let lines = paper ? G.pitch : null, kind = 'text';
    const S = (id, words, italic = false) => P({ style: id, ...(paper ? spaced(kind, lines) : {}), children: runs(words, lib, Lexer, undefined, L.size, italic) });
    switch (role) {
      case 'Caption': {
        const caption = FIGURE.exec(item.text);
        const label = caption ? `${caption[1][0].toUpperCase()}${caption[1].slice(1).toLowerCase()} ${caption[2]}${paper ? '.' : ':'}` : null;
        styled('Caption', 'Caption', { alignment: paper ? A.JUSTIFIED : A.CENTER, spacing: { after: paper ? 0 : 240 }, indent: paper ? {} : { left: 360, right: 360 } }, { size: paper ? half(G.captionSize) : L.caption.size, italics: L.caption.italics || undefined });
        // A figure's caption hangs under its pictures; a table's stands over the table.
        let spacing = {};
        const words = caption ? item.text.slice(caption[0].length) : item.text;
        const set = typeset ? setText(words, { size: G.captionSize, width: G.column, prefix: label ? [{ text: `${label} `, marks: [{ type: 'bold' }] }] : [] }) : null;
        if (paper) {
          const table = plan.items[index + 1]?.type === 'table';
          const depth = set?.depth ?? G.descender * G.captionSize;
          const before = previous?.type === 'picture' ? T(G.captionBelow - 0.8 * G.captionPitch) : lead(table ? G.tableCaption + depthOf(last) : G.pitch, last.height, G.captionPitch);
          spacing = { spacing: { before, after: table ? T(G.ruleBelowCaption + depth - 0.2 * G.captionPitch) : 0, ...exact(G.captionPitch) } };
          last = { kind: table ? 'above-table' : 'caption', height: G.captionPitch, size: G.captionSize, depth };
        }
        block = P({ style: 'Caption', ...spacing, ...(set ? { alignment: A.LEFT } : {}), children: set ? set.runs : [
          ...(label ? [new lib.TextRun({ text: `${label} `, bold: !L.caption.italics || undefined })] : []),
          ...text(words)] });
        break;
      }
      case 'Subtitle':
        styled('Subtitle', 'Subtitle', { alignment: A.CENTER, spacing: { after: paper ? 0 : 200 } }, { size: paper ? L.size : Math.round(L.title.size * 0.6) });
        block = S('Subtitle', item.text);
        break;
      case 'Author':
        // An article's authors are in small capitals, as AASTeX sets them.
        styled('Author', 'Author', { alignment: A.CENTER, spacing: { after: paper ? 0 : L.front.after } }, paper ? { size: half(G.authorSize), smallCaps: true } : { size: L.front.size });
        if (paper) { block = P({ style: 'Author', spacing: { before: lead(G.author, G.pitch, G.pitch), after: 0, ...exact(G.pitch) }, children: runs(item.text, lib, Lexer, undefined, L.size) }); last = { kind: 'front', height: G.pitch }; }
        else block = S('Author', item.text);
        break;
      case 'Dedication':
        // Word drops the space before a paragraph at the top of a page, so a dedication on its own
        // page is lowered by an empty paragraph's space after.
        if (L.titlePage) children.push(new lib.Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 2400 }, children: [] }));
        styled('Dedication', 'Dedication', { alignment: A.CENTER, spacing: { before: L.titlePage ? 0 : 240, after: 240 } }, { italics: true });
        block = S('Dedication', item.text);
        break;
      case 'Epigraph':
        styled('Epigraph', 'Epigraph', { alignment: A.LEFT, spacing: { before: 120, after: 240 }, indent: { left: Math.round(L.page.width * 0.3) } }, { size: Math.round(L.size * 0.95), italics: true });
        block = S('Epigraph', item.text);
        break;
      case 'Quotation':
        styled('Quotation', 'Quotation', { alignment: A.JUSTIFIED, spacing: { before: 120, after: 120 }, indent: { left: 720, right: 720 } }, { size: Math.round(L.size * 0.95) });
        block = S('Quotation', item.text);
        break;
      case 'Verse':
        styled('Verse', 'Verse', { alignment: A.LEFT, spacing: { after: 160 }, indent: { left: 720 } });
        block = S('Verse', item.text);
        break;
      case 'Aside':
        styled('Aside', 'Aside', { alignment: A.JUSTIFIED, spacing: { before: 120, after: 120 }, indent: { left: 720, right: 720 } }, { size: Math.round(L.size * 0.9) });
        block = S('Aside', item.text);
        break;
      case 'Scene break':
        styled('SceneBreak', 'Scene Break', { alignment: A.CENTER, spacing: { before: 240, after: 240 } });
        block = S('SceneBreak', item.text.trim() || '\\* \\* \\*');
        break;
      case 'Abstract':
        if (paper) {
          styled('Abstract', 'Abstract', { alignment: A.JUSTIFIED, indent: { left: T(G.abstractLeft), right: T(G.abstractRight), firstLine: T(G.abstractIndent) } }, { size: half(G.size) });
          const first = last.kind === 'abstract-heading';
          const set = typeset ? setText(item.text, { size: G.size, width: 2 * G.column + G.gap - G.abstractLeft - G.abstractRight, indent: G.abstractIndent }) : null;
          block = P({ style: 'Abstract', ...(set ? { alignment: A.LEFT } : {}), spacing: { before: first ? lead(G.abstract, G.pitch, G.pitch) : 0, after: 0, ...exact(G.pitch) }, children: set ? set.runs : runs(item.text, lib, Lexer, undefined, L.size) });
          last = { kind: 'text', height: G.pitch };
        } else block = S(body(indentNext), item.text);
        continues = true;
        break;
      case 'Keywords':
        // "Keywords:" in italics, the list hanging under it.
        if (paper) {
          styled('Keywords', 'Keywords', { alignment: A.LEFT, spacing: { before: 200, after: 120 }, indent: { left: T(G.abstractLeft) + 950, right: T(G.abstractRight), hanging: 950 } }, { size: half(G.size) });
          block = P({ style: 'Keywords', children: [new lib.TextRun({ text: 'Keywords: ', italics: true }), ...text(item.text.replace(KEYWORDS, ''))] });
        } else {
          styled('Keywords', 'Keywords', { alignment: A.LEFT, spacing: { before: 120 } });
          block = S('Keywords', item.text);
        }
        break;
      case 'References':
      case 'Glossary':
        // As AASTeX sets its references: smaller, ragged, never hyphenated, each entry hanging.
        if (paper) { lines = G.referencePitch; kind = 'reference'; }
        styled(role, role, { alignment: A.LEFT, spacing: { after: paper ? 0 : 60 }, indent: { left: paper ? T(G.referenceHang) : L.references.hanging, hanging: paper ? T(G.referenceHang) : L.references.hanging } }, { size: paper ? half(G.referenceSize) : L.references.size });
        const set = typeset ? referenceSet(item) : null;
        block = set ? P({ style: role, ...spaced(kind, lines), children: [...(item === secondColumn ? [new lib.ColumnBreak()] : []), ...set.runs] }) : S(role, item.text);
        break;
      case 'Colophon':
        styled('Colophon', 'Colophon', { alignment: A.CENTER, spacing: { after: 120 } }, { size: Math.round(L.size * 0.85) });
        block = S('Colophon', item.text);
        break;
      default:
        if (item.front && paper) {
          styled('FrontMatter', 'Front Matter', { alignment: A.CENTER, spacing: { after: 0 } }, { size: half(G.frontSize) });
          block = P({ style: 'FrontMatter', spacing: { before: lead(G.front, G.pitch, G.pitch), after: 0, ...exact(G.pitch) }, children: runs(item.text, lib, Lexer, undefined, L.size) });
          last = { kind: 'front', height: G.pitch };
          break;
        }
        {
          const set = typeset ? setText(item.text, { size: G.size, width: G.column, indent: G.indent }) : null;
          block = set ? P({ style: body(indentNext), alignment: A.LEFT, ...spaced(kind, lines), children: set.runs }) : S(body(indentNext), item.text);
          if (set) last.depth = set.depth;
        }
        continues = true;
    }
    children.push(block);
    indentNext = continues; previous = item;
  }
  flushRow();
  const heading = h => ({ run: { font: L.font, size: h.size, bold: h.bold !== false, italics: !!h.italics, color: '000000' },
    paragraph: { spacing: { before: h.before, after: h.after }, keepNext: true, keepLines: true } });
  const listLevels = (format, text) => Array.from({ length: MAX_LEVEL + 1 }, (_, level) => ({ level, format, text: text(level),
    // An article's numbers end where AASTeX's do, right-aligned, its text hanging after them.
    ...(paper ? { alignment: A.RIGHT, style: { paragraph: { indent: { left: T(G.hang + 18 * level), hanging: T(G.hang - G.number) } } } }
      : { alignment: A.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1) + 360, hanging: 360 } } } }) }));
  const NUMBER_FORMATS = [lib.LevelFormat.DECIMAL, lib.LevelFormat.LOWER_LETTER, lib.LevelFormat.LOWER_ROMAN, lib.LevelFormat.DECIMAL, lib.LevelFormat.LOWER_LETTER];
  const footnotes = Object.fromEntries((plan.footnotes ?? []).map(f => [f.n, { children: [new lib.Paragraph({ children: runs(f.text, lib, Lexer, Math.round(L.size * 0.85), L.size) })] }]));
  const document = new lib.Document({
    creator: 'Nendo Manuscript', title: plan.title, footnotes,
    // An article hyphenates as TeX does, and numbers its pages on the outer side.
    // Set as TeX sets it, every line is already broken where TeX breaks it.
    ...(paper ? { evenAndOddHeaderAndFooters: true, hyphenation: { autoHyphenation: !typeset, doNotHyphenateCaps: true } } : {}),
    numbering: { config: [
      { reference: 'mn-bulleted', levels: listLevels(lib.LevelFormat.BULLET, level => BULLETS[level]) },
      { reference: 'mn-numbered', levels: listLevels(lib.LevelFormat.DECIMAL, level => `%${level + 1}.`).map((l, i) => ({ ...l, format: NUMBER_FORMATS[i] })) },
    ] },
    styles: {
      // docx writes its own Title and Heading styles; these are what it writes them as.
      default: {
        document: { run: { font: L.font, size: L.size, color: '000000' }, paragraph: { spacing: paper ? { after: 0, ...exact(G.pitch) } : { line: L.line, after: L.after } } },
        title: { run: { font: L.font, size: L.title.size, bold: paper, color: '000000' },
          paragraph: { alignment: A.CENTER, spacing: { before: L.title.before, after: L.title.after } } },
        heading1: heading(L.headings[0]), heading2: heading(L.headings[1]), heading3: heading(L.headings[2]),
      },
      paragraphStyles: [...named.values()],
    },
    sections: paper ? paperSections(lib, G, children, sectionsAt, L.pageNumbers, options.date) : [{
      properties: pageProperties(L),
      footers: L.pageNumbers ? { default: new lib.Footer({ children: [new lib.Paragraph({ alignment: A.CENTER, children: [new lib.TextRun({ children: [lib.PageNumber.CURRENT], size: 20 })] })] }) } : undefined,
      children: L.titlePage ? [children[0], new lib.Paragraph({ children: [], pageBreakBefore: false }), ...children.slice(1)] : children,
    }],
  });
  return { document, missing, unhyphenated: paper ? ['References', 'Glossary', 'TableText'].filter(id => named.has(id)) : [] };
}

function pageProperties(L) {
  const side = L.page.side ?? L.page.margin;
  return { page: { size: { width: L.page.width, height: L.page.height },
    margin: { top: L.page.margin, right: side, bottom: L.page.margin, left: side, header: 720, footer: 720 } } };
}

/**
 * An article's sections, all on the same run of pages: the title block across the page, the
 * body in two columns, and, when the references have a heading, that heading across the page
 * and the references in two columns again. Word balances the columns above a continuous
 * break, as AASTeX balances them above its references, and a last empty section balances the
 * last page's. The first page carries the draft line at the top left, the others their number
 * on the outer side; every section carries the set, so whichever Word reads for a page says
 * the same. Distances in points.
 */
function paperSections(lib, G, children, sectionsAt, numbers, date) {
  const A = lib.AlignmentType, T = pt => Math.round(pt * 20), half = pt => Math.round(pt * 2);
  const line = height => ({ before: 0, after: 0, line: T(height), lineRule: 'exact' });
  const folio = alignment => new lib.Header({ children: [new lib.Paragraph({ alignment, spacing: line(G.pitch),
    children: numbers ? [new lib.TextRun({ children: [lib.PageNumber.CURRENT], size: half(G.size) })] : [] })] });
  const headers = first => ({
    ...(first ? { first: new lib.Header({ children: [new lib.Paragraph({ alignment: A.LEFT, indent: { left: T(G.draftIndent) }, spacing: line((G.draft - G.folio + 0.8 * G.pitch) / 0.8),
      children: [new lib.TextRun({ text: draftLine(date), smallCaps: true, size: half(G.draftSize) })] })] }) } : {}),
    default: folio(A.RIGHT), even: folio(A.LEFT),
  });
  const page = { size: { width: T(G.width), height: T(G.height) },
    margin: { top: T(G.top - 0.8 * G.pitch), bottom: T(G.height - G.bottom - 0.2 * G.pitch), left: T(G.left), right: T(G.right), header: T(G.folio - 0.8 * G.pitch), footer: 720 } };
  const bounds = [{ at: 0, columns: 1 }, ...sectionsAt.filter(s => s.at < children.length)];
  const sections = bounds.map((s, i) => ({
    // Only the sections that start on the first page take its own header.
    properties: { page, titlePage: i === 0 || bounds[i].at <= (sectionsAt[0]?.at ?? 0), ...(i > 0 ? { type: s.newPage ? lib.SectionType.NEXT_PAGE : lib.SectionType.CONTINUOUS } : {}),
      ...(s.columns > 1 ? { column: { count: s.columns, space: T(G.gap) } } : {}) },
    headers: headers(i === 0 || s.at <= (sectionsAt[0]?.at ?? 0)),
    children: children.slice(s.at, bounds[i + 1]?.at ?? children.length),
  }));
  // A last section, empty, so Word balances the columns of the last page.
  if (bounds.at(-1).columns > 1) sections.push({ properties: { page, type: lib.SectionType.CONTINUOUS }, headers: headers(false),
    children: [new lib.Paragraph({ spacing: line(1), children: [] })] });
  return sections;
}
