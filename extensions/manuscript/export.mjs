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

function runs(markdown, lib, Lexer) {
  const out = [];
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out.push(new lib.TextRun({ text: '', break: 1 })); continue; }
    const marks = new Set((node.marks ?? []).map(m => m.type));
    out.push(new lib.TextRun({ text: node.text, bold: marks.has('bold'), italics: marks.has('italic'), strike: marks.has('strike'), font: marks.has('code') ? 'Consolas' : undefined }));
  }
  return out;
}

/**
 * The manuscript as a Word document: a Title, Heading 1 to 3, paragraphs with bold, italic,
 * strikethrough and code runs, and each picture at the text's width with its description as
 * its alternative text. `pictures` maps an address to {data, mediaType, width, height}. A
 * picture Word cannot take, or one that could not be read, stands as its description in
 * brackets and is named in `missing`.
 */
export function toDocx(plan, pictures, lib, Lexer) {
  const headings = [lib.HeadingLevel.HEADING_1, lib.HeadingLevel.HEADING_2, lib.HeadingLevel.HEADING_3];
  const children = [new lib.Paragraph({ heading: lib.HeadingLevel.TITLE, children: [new lib.TextRun({ text: plan.title })] })];
  const missing = [];
  for (const item of plan.items) {
    if (item.type === 'heading') { children.push(new lib.Paragraph({ heading: headings[Math.min(item.level, 3) - 1], children: runs(item.text, lib, Lexer) })); continue; }
    if (item.type === 'paragraph') { children.push(new lib.Paragraph({ children: runs(item.text, lib, Lexer) })); continue; }
    const picture = pictures.get(item.address), type = picture && WORD_TYPE[picture.mediaType];
    if (!picture || !type || !picture.width || !picture.height) {
      missing.push({ alt: item.alt, address: item.address, why: !picture ? 'not read' : 'a type Word does not hold' });
      children.push(new lib.Paragraph({ children: [new lib.TextRun({ text: `[Picture: ${item.alt || 'no description'}]`, italics: true })] }));
      continue;
    }
    const width = Math.min(600, picture.width), height = Math.round(width * picture.height / picture.width);
    children.push(new lib.Paragraph({ alignment: lib.AlignmentType.CENTER, children: [new lib.ImageRun({ type, data: picture.data,
      transformation: { width, height }, altText: { name: item.alt || 'Picture', title: item.alt || 'Picture', description: item.alt || '' } })] }));
  }
  const document = new lib.Document({ creator: 'Nendo Manuscript', title: plan.title,
    styles: { default: { document: { run: { font: 'Georgia', size: 24 } } } }, sections: [{ children }] });
  return { document, missing };
}
