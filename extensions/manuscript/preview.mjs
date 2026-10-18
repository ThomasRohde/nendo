// What a reader would see: the manuscript as the Word export lays it out, for the view's
// Preview. Pure: it turns the export plan into blocks with the layout's rules (which block
// starts a page, which is indented, which is a caption, which pictures share a row), and the
// view draws them on page-sized sheets. Tested in Node (tools/manus/preview.test.mjs).
import { FIGURE, paperHeadings, columnsStart, article } from './export.mjs';
import { softHyphens } from './typeset.mjs';
export { softHyphens };

// Where a browser sets a Times baseline in a line box, in the line's units: half the line's
// height, then half the difference of the face's ascent (0.891 em) and descent (0.216 em). The
// view measures it instead (paperStyle's `below`), since a browser rounds the face's metrics.
const baseline = (line, size) => line / 2 + 0.3375 * size;

/**
 * The paper's sheet in CSS pixels (96 to the inch) from the article's points: its size, side
 * margins, columns, the body's top, and `limit`, how far below the body's top a column's lines
 * may reach, so that its last baseline is no lower than the article's.
 */
export function paperSheet(A = article()) {
  const px = pt => pt * 4 / 3;
  const top = px(A.top - baseline(A.pitch, A.size));
  return { width: px(A.width), height: px(A.height), margin: px(A.left), right: px(A.right), top, columns: 2, column: px(A.column), gap: px(A.gap),
    limit: px(A.bottom + A.pitch - baseline(A.pitch, A.size)) - top, line: px(A.pitch) };
}

/**
 * Page and text sizes in CSS pixels, as the Word layouts set them: `margin` at the sides (the
 * paper's left, with `right` its right), `top` above. An article's body runs in `columns` of
 * `column` pixels, and its type and spacing come from paperStyle.
 */
export const PAGES = {
  book: { width: 576, height: 864, margin: 72, top: 72, font: "Georgia, 'Sitka Text', serif", size: 14.7, line: 1.25 },
  paper: { font: "'Times New Roman', Times, serif", size: 40 / 3, ...paperSheet() },
};

/**
 * The paper's type and spacing for the preview, as CSS, from the article's points: every
 * distance the Word export sets between baselines, turned into the margins that put a browser's
 * baselines in the same places. Margins between siblings collapse to the larger, so a heading's
 * room below and the text's none give the heading's; a heading after a heading takes none.
 */
export function paperStyle(A = article(), font = PAGES.paper.font, below = baseline) {
  const pt = v => `${Math.round(v * 1000) / 1000}pt`;
  const after = (line, size) => line - below(line, size);
  const gap = (distance, line, size, nextLine, nextSize) => pt(distance - after(line, size) - below(nextLine, nextSize));
  const P = A.pitch, S = A.size, C = A.captionPitch, CS = A.captionSize, R = A.referencePitch, RS = A.referenceSize;
  const s = ".preview[data-layout='paper']", b = `${s} .sheet-body`;
  return `
${s} .sheet-page { width: ${pt(A.width)}; height: ${pt(A.height)}; padding: ${pt(A.top - below(P, S))} ${pt(A.right)} 0 ${pt(A.left)}; font: ${pt(S)}/${pt(P)} ${font}; font-kerning: none; font-variant-ligatures: none; }
${s} .running { top: ${pt(A.folio - below(P, S))}; left: ${pt(A.left)}; right: ${pt(A.right)}; font-size: ${pt(S)}; line-height: ${pt(P)}; font-variant: normal; text-align: right; }
${s} .running.even { text-align: left; }
${s} .running.draft { top: ${pt(A.draft - below(P, A.draftSize))}; left: ${pt(A.left + A.draftIndent)}; font-size: ${pt(A.draftSize)}; font-variant: small-caps; text-align: left; }
${b} .pv-title { font-size: ${pt(S)}; font-weight: 700; line-height: ${pt(P)}; margin: ${pt(A.title - A.top)} 0 0; }
${b} p.role-author { font-size: ${pt(A.authorSize)}; font-variant: small-caps; margin: ${gap(A.author, P, S, P, A.authorSize)} 0 0; }
${b} p.front { font-size: ${pt(A.frontSize)}; margin: ${gap(A.front, P, A.authorSize, P, A.frontSize)} 0 0; }
${b} p.front + p.front { margin-top: ${gap(A.front, P, A.frontSize, P, A.frontSize)}; }
${b} h2.role-abstract { margin: ${gap(A.abstractHeading, P, A.frontSize, P, S)} 0 0; font-size: ${pt(S)}; }
${b} p.role-abstract { margin: 0 ${pt(A.abstractRight)} 0 ${pt(A.abstractLeft)}; }
${b} h2.role-abstract + p.role-abstract { margin-top: ${gap(A.abstract, P, S, P, S)}; }
${b} .pv-columns { gap: ${pt(A.gap)}; margin-top: ${gap(A.columns, P, S, P, S)}; }
${b} .pv-column { flex: 0 0 ${pt(A.column)}; }
${b} .pv-column > :first-child { margin-top: 0 !important; }
${b} > .pv-columns:first-child { margin-top: 0; }
${b} p { line-height: ${pt(P)}; }
${b} .pv-line { display: block; white-space: nowrap; word-spacing: 0; text-indent: 0; text-align: left; }
${b} .pv-line:first-of-type { text-indent: inherit; }
${b} mark { background: #ffff00; border-radius: 0; }
${b} p.indent { text-indent: ${pt(A.indent)}; }
${b} p.role-abstract.indent { text-indent: ${pt(A.abstractIndent)}; }
${b} :is(h2, h3, h4) { font-size: ${pt(S)}; font-weight: 400; line-height: ${pt(P)}; text-align: center; margin: ${gap(A.heading, P, S, P, S)} 0 ${gap(A.afterHeading, P, S, P, S)}; }
${b} .pv-column h2:not(.part) { font-size: ${pt(A.sectionSize)}; }
${b} :is(h3, h4) { font-style: italic; }
${b} :is(h2, h3, h4) + :is(h2, h3, h4) { margin-top: 0; }
${b} p.pv-li { margin: ${pt(A.listSpace)} 0 0; text-align: justify; padding-left: ${pt(A.hang)}; }
${b} p.pv-li.level-1 { padding-left: ${pt(A.hang + 18)}; } ${b} p.pv-li.level-2 { padding-left: ${pt(A.hang + 36)}; } ${b} p.pv-li.level-3 { padding-left: ${pt(A.hang + 54)}; } ${b} p.pv-li.level-4 { padding-left: ${pt(A.hang + 72)}; }
${b} .pv-marker { margin-left: ${pt(-A.hang)}; width: ${pt(A.number)}; text-align: right; }
${b} .pv-li + :is(p, .pv-piece):not(.pv-li) { margin-top: ${pt(A.listSpace)}; }
${b} .pv-figure { gap: ${pt(A.pictureGap)}; margin: ${pt(A.pictureAbove + A.descender * S - after(P, S))} 0 0; }
${b} .pv-caption { font-size: ${pt(CS)}; line-height: ${pt(C)}; text-align: justify !important; margin: ${gap(A.pitch, P, S, C, CS)} 0 ${gap(A.afterCaption + A.descender * CS, C, CS, P, S)}; }
${b} .pv-figure + .pv-caption { margin-top: ${pt(A.captionBelow - below(C, CS))}; }
${b} .pv-caption + :is(h2, h3, h4) { margin-top: ${gap(A.headingAfterCaption + A.descender * CS, C, CS, P, S)}; }
${b} .pv-caption.above-table { margin: ${gap(A.tableCaption + A.descender * S, P, S, C, CS)} 0 ${pt(A.ruleBelowCaption + A.descender * CS - after(C, CS))}; }
${b} table.pv-table { table-layout: fixed; width: 100%; margin: 0; font-size: ${pt(A.cellSize)}; line-height: ${pt(A.cellPitch)}; border-top: ${pt(0.4 + A.rulePair)} double #000000; border-bottom: 0.4pt solid #000000; }
${b} .pv-table :is(th, td) { border: 0; padding: ${pt(A.rowSpace / 2)} ${pt(A.cellPad)}; font-weight: 400; hyphens: manual; }
${b} .pv-table th { border-bottom: 0.4pt solid #000000; }
${b} .pv-table + :is(p, .pv-piece) { margin-top: ${pt(A.afterTable - below(P, S))}; }
${b} .pv-table + :is(h2, h3, h4) { margin-top: ${pt(A.headingAfterTable - below(P, S))}; }
${b} > h2.role-references { margin: ${gap(A.references, P, S, P, S)} 0 0; font-size: ${pt(S)}; }
${b} > h2.role-references:first-child { margin-top: 0; }
${b} > h2.role-references + .pv-columns { margin-top: ${gap(A.firstReference, P, S, R, RS)}; }
${b} p.role-references, ${b} p.role-glossary { font-size: ${pt(RS)}; line-height: ${pt(R)}; padding-left: ${pt(A.referenceHang)}; text-indent: ${pt(-A.referenceHang)}; margin: 0; hyphens: manual; }
`;
}
// Roles a reader sees as a block apart from running text, after which the text starts flush.
const APART = new Set(['Subtitle', 'Author', 'Dedication', 'Epigraph', 'Quotation', 'Verse', 'Aside', 'Scene break', 'Caption', 'Keywords', 'Colophon']);

/**
 * Blocks for a preview in `layout` ('book' or 'paper'): each {kind, text?, level?, role?,
 * pictures?, label?, indent, breakBefore, front?, across?}. kind is title, heading, paragraph,
 * figure, caption or spacer. In an article, `across` marks the blocks that run across the page
 * above its two columns, and headings read as the Word export labels them.
 */
export function previewBlocks(plan, layout) {
  const book = layout === 'book';
  const { labels, parts } = book ? { labels: new Map(), parts: new Set() } : paperHeadings(plan);
  const columnsAt = book ? -1 : columnsStart(plan);
  const blocks = [{ kind: 'title', text: plan.title, breakBefore: false, indent: false, titlePage: book, across: !book }];
  let indentNext = false, row = null, firstAppendix = true, previous = null, afterTitle = true, index = -1;
  const flush = () => { if (row) { blocks.push(row); row = null; indentNext = false; } };
  for (const item of plan.items) {
    index++;
    if (index === columnsAt) flush();
    const across = !book && index < columnsAt;
    if (item.type === 'picture') {
      row ??= { kind: 'figure', pictures: [], breakBefore: false, indent: false, across };
      row.pictures.push({ alt: item.alt, address: item.address });
      previous = item;
      continue;
    }
    flush();
    if (item.type === 'heading') {
      const level = parts.has(item) ? 1 : Math.min(item.level, 3);
      const opensPage = item.kind ? item.kind === 'Part' || item.kind === 'Chapter' : level === 1;
      const breakBefore = (book && opensPage) || (level === 1 && item.role === 'Appendix' && firstAppendix);
      if (item.role === 'Appendix' && level === 1) firstAppendix = false;
      blocks.push({ kind: 'heading', level, text: labels.get(item) ?? item.text, role: item.role, breakBefore, across,
        centred: book ? level === 1 : level <= 2, indent: false, align: item.align ?? null, part: parts.has(item) });
      indentNext = false; afterTitle = false; previous = item;
      continue;
    }
    if (item.type === 'table') {
      blocks.push({ kind: 'table', rows: item.rows, breakBefore: false, indent: false, across });
      indentNext = false; afterTitle = false; previous = item;
      continue;
    }
    const role = item.role;
    if (role === 'Caption') {
      const caption = FIGURE.exec(item.text);
      blocks.push({ kind: 'caption', role, label: caption ? `${caption[1][0].toUpperCase()}${caption[1].slice(1).toLowerCase()} ${caption[2]}${book ? ':' : '.'}` : null,
        text: caption ? item.text.slice(caption[0].length) : item.text, breakBefore: false, indent: false, across, align: item.align ?? null,
        aboveTable: plan.items[index + 1]?.type === 'table' });
      indentNext = false; previous = item;
      continue;
    }
    // A book's title page holds the title, subtitle and author; a dedication has a page of its own.
    const titlePage = book && afterTitle && (role === 'Subtitle' || role === 'Author');
    const breakBefore = book && role === 'Dedication';
    // An article's abstract indents every paragraph, and its keywords hang under their label.
    const keywords = !book && role === 'Keywords';
    // An article indents every paragraph of running text, the first after a heading, a picture
    // or a list too, as AASTeX does; a book starts each of those flush.
    const running = !item.list && !APART.has(role) && !(item.front && !book) && role !== 'References' && role !== 'Glossary';
    blocks.push({ kind: 'paragraph', role, text: keywords ? item.text.replace(/^\*{0,2}keywords?\*{0,2}\s*[:.]\s*/i, '') : item.text, label: keywords ? 'Keywords:' : undefined,
      front: !book && item.front, titlePage, breakBefore, across, align: item.align ?? null,
      list: item.list ?? null, listLevel: item.listLevel ?? 0, marker: item.marker ?? null,
      indent: running && (!book || indentNext) });
    // A list is set apart: the paragraph after it starts flush, as one after a heading does.
    indentNext = !item.list && !APART.has(role) && !(item.front && !book) && role !== 'References' && role !== 'Glossary';
    if (role === 'Dedication') indentNext = false;
    previous = item;
  }
  flush();
  // Text after a book's title page, or after its dedication, starts a page.
  if (book) {
    for (let i = 1; i < blocks.length; i++) {
      const before = blocks[i - 1];
      if ((before.titlePage || before.kind === 'title' || before.role === 'Dedication') && !blocks[i].titlePage) { blocks[i].breakBefore = true; }
      if (blocks[i].titlePage) blocks[i].breakBefore = false;
    }
  }
  return blocks;
}

/** How many pictures share the row a figure block draws, and the width each takes, in pixels. */
export function figureWidths(block, layout) {
  const page = PAGES[layout], text = page.column ?? page.width - 2 * page.margin, n = block.pictures.length;
  if (n === 1) return [text];
  // The paper's row fills its column exactly, as the Word export and the reference set it.
  const each = layout === 'paper' ? (text - 24 * (n - 1)) / n : Math.floor((text - 24 * (n - 1)) / n);
  return block.pictures.map(() => each);
}
