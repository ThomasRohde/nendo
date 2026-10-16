// What a reader would see: the manuscript as the Word export lays it out, for the view's
// Preview. Pure: it turns the export plan into blocks with the layout's rules (which block
// starts a page, which is indented, which is a caption, which pictures share a row), and the
// view draws them on page-sized sheets. Tested in Node (tools/manus/preview.test.mjs).
import { FIGURE } from './export.mjs';

/** Page and text sizes in CSS pixels (96 to the inch), as the Word layouts set them. */
export const PAGES = {
  book: { width: 576, height: 864, margin: 72, font: "Georgia, 'Sitka Text', serif", size: 14.7, line: 1.25 },
  paper: { width: 816, height: 1056, margin: 96, font: "'Times New Roman', Times, serif", size: 14.7, line: 1.15 },
};

const PARTS = new Set(['Foreword', 'Preface', 'Acknowledgements', 'Abstract', 'Appendix', 'Afterword', 'Glossary', 'References', 'About the author', 'Colophon']);
// Roles a reader sees as a block apart from running text, after which the text starts flush.
const APART = new Set(['Subtitle', 'Author', 'Dedication', 'Epigraph', 'Quotation', 'Verse', 'Aside', 'Scene break', 'Caption', 'Keywords', 'Colophon']);

/**
 * Blocks for a preview in `layout` ('book' or 'paper'): each {kind, text?, level?, role?,
 * pictures?, label?, indent, breakBefore, front?}. kind is title, heading, paragraph, figure,
 * caption or spacer.
 */
export function previewBlocks(plan, layout) {
  const book = layout === 'book';
  const blocks = [{ kind: 'title', text: plan.title, breakBefore: false, indent: false, titlePage: book }];
  let indentNext = false, row = null, firstAppendix = true, previous = null, afterTitle = true;
  const flush = () => { if (row) { blocks.push(row); row = null; indentNext = false; } };
  for (const item of plan.items) {
    if (item.type === 'picture') {
      row ??= { kind: 'figure', pictures: [], breakBefore: false, indent: false };
      row.pictures.push({ alt: item.alt, address: item.address });
      previous = item;
      continue;
    }
    flush();
    if (item.type === 'heading') {
      const level = Math.min(item.level, 3);
      const opensPage = item.kind ? item.kind === 'Part' || item.kind === 'Chapter' : level === 1;
      const breakBefore = (book && opensPage) || (level === 1 && item.role === 'Appendix' && firstAppendix);
      if (item.role === 'Appendix' && level === 1) firstAppendix = false;
      blocks.push({ kind: 'heading', level, text: item.text, role: item.role, breakBefore,
        centred: (book && level === 1) || (PARTS.has(item.role) && level === 1 && (book || item.role === 'Abstract')), indent: false });
      indentNext = false; afterTitle = false; previous = item;
      continue;
    }
    const role = item.role;
    if (role === 'Caption') {
      const caption = FIGURE.exec(item.text);
      blocks.push({ kind: 'caption', role, label: caption ? `${caption[1][0].toUpperCase()}${caption[1].slice(1).toLowerCase()} ${caption[2]}:` : null,
        text: caption ? item.text.slice(caption[0].length) : item.text, breakBefore: false, indent: false });
      indentNext = false; previous = item;
      continue;
    }
    // A book's title page holds the title, subtitle and author; a dedication has a page of its own.
    const titlePage = book && afterTitle && (role === 'Subtitle' || role === 'Author');
    const breakBefore = book && role === 'Dedication';
    blocks.push({ kind: 'paragraph', role, text: item.text, front: !book && item.front, titlePage, breakBefore,
      indent: indentNext && !APART.has(role) && !(item.front && !book) && role !== 'References' && role !== 'Glossary' });
    indentNext = !APART.has(role) && !(item.front && !book) && role !== 'References' && role !== 'Glossary';
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
  const page = PAGES[layout], text = page.width - 2 * page.margin, n = block.pictures.length;
  if (n === 1) return [Math.round(text * (layout === 'paper' ? 0.64 : 1))];
  const each = Math.floor((text - 24 * (n - 1)) / n);
  return block.pictures.map(() => each);
}
