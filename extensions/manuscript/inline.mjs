// A block's text is Markdown of one paragraph's inline content: bold, italic, strikethrough,
// code and hard line breaks. This module turns it into the editor's inline content and back.
// Only inline syntax is read: a block never holds a heading, a list or a second paragraph,
// because the hierarchy is what holds structure. Links, pictures and raw HTML are kept as
// the characters they were written with, so nothing a block holds is lost when it is edited.

const RANK = ['bold', 'italic', 'strike'];

// A block whose whole text is one picture, `![alt](address)`, is a picture on the sheet.
const PICTURE = /^!\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^\s<>()]+)>?\s*\)$/;

/** The picture a block's text is, or null: `{alt, address}`. */
export function pictureOf(markdown) {
  const match = PICTURE.exec((markdown ?? '').trim());
  return match ? { alt: match[1].replace(/\\(.)/g, '$1'), address: match[2] } : null;
}

/** A picture as a block's text. */
export function pictureMarkdown(alt, address) {
  return `![${(alt ?? '').replace(/[\\[\]]/g, '\\$&')}](${address})`;
}
const DELIMITER = { bold: '**', italic: '*', strike: '~~' };

/** Escapes what Markdown would otherwise read as syntax, inline or at the start of a block. */
export function escapeText(text, atStart) {
  let out = text.replace(/[\\`*_~[\]<>]/g, '\\$&');
  if (atStart) out = out.replace(/^(\s*)([#>+-])/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2');
  return out;
}

function codeSpan(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map(r => r.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || /^ .* $/.test(text) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/**
 * Inline content (ProseMirror JSON: text nodes with marks, hardBreak nodes) to Markdown.
 * Marks nest in one fixed order, so a run that is bold and italic opens bold first; spaces at
 * the edge of a marked run move outside its delimiters, where Markdown can read them.
 */
export function inlineToMarkdown(content = []) {
  let out = '';
  const open = [];
  const close = upTo => {
    const trailing = /\s*$/.exec(out)[0];
    out = out.slice(0, out.length - trailing.length);
    while (open.length > upTo) out += DELIMITER[open.pop()];
    out += trailing;
  };
  for (const node of content) {
    if (node.type === 'hardBreak') { close(0); out += '\\\n'; continue; }
    if (node.type !== 'text' || !node.text) continue;
    const marks = new Set((node.marks ?? []).map(m => m.type));
    const wanted = RANK.filter(m => marks.has(m));
    let keep = 0;
    while (keep < open.length && keep < wanted.length && open[keep] === wanted[keep]) keep++;
    close(keep);
    let text = node.text;
    const lead = /^\s*/.exec(text)[0];
    if (open.length < wanted.length && lead) { out += lead; text = text.slice(lead.length); }
    for (const m of wanted.slice(open.length)) { out += DELIMITER[m]; open.push(m); }
    out += marks.has('code') ? codeSpan(text) : escapeText(text, out.length === 0 || out.endsWith('\n'));
  }
  close(0);
  return out;
}

function textNodes(text, marks) {
  const nodes = [];
  const parts = text.split(/(\n{2,})/);
  for (const part of parts) {
    if (/^\n{2,}$/.test(part)) { nodes.push({ type: 'hardBreak' }); continue; }
    const flat = part.replace(/\n/g, ' ');
    if (flat) nodes.push(marks.length ? { type: 'text', text: flat, marks: marks.map(type => ({ type })) } : { type: 'text', text: flat });
  }
  return nodes;
}

function fromTokens(tokens, marks, out) {
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': fromTokens(t.tokens, [...marks, 'bold'], out); break;
      case 'em': fromTokens(t.tokens, [...marks, 'italic'], out); break;
      case 'del': fromTokens(t.tokens, [...marks, 'strike'], out); break;
      case 'codespan': out.push({ type: 'text', text: unescapeEntities(t.text), marks: [...marks, 'code'].map(type => ({ type })) }); break;
      case 'br': out.push({ type: 'hardBreak' }); break;
      case 'escape': out.push(...textNodes(t.text, marks)); break;
      case 'text': if (t.tokens && t.tokens.length) fromTokens(t.tokens, marks, out); else out.push(...textNodes(t.text, marks)); break;
      default: out.push(...textNodes(t.raw ?? t.text ?? '', marks));
    }
  }
  return out;
}

// marked encodes &, <, > and quotes in a code span's text; the span means its characters.
function unescapeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
}

/** Merges neighbouring text nodes that carry the same marks, as the editor would. */
function normalise(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && last.type === 'text' && n.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) last.text += n.text;
    else out.push({ ...n });
  }
  return out;
}

/**
 * Markdown to inline content. `Lexer` is marked's, passed in so this module needs no bundle.
 * A value written elsewhere with blank lines comes back with a hard break where each blank
 * line was.
 */
export function markdownToInline(markdown, Lexer) {
  if (!markdown) return [];
  const tokens = Lexer.lexInline(markdown, { gfm: true, breaks: false });
  return normalise(fromTokens(tokens, [], []));
}
