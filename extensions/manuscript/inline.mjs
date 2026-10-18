// A block's text is Markdown of one paragraph's inline content: bold, italic, strikethrough,
// code, hard line breaks and links, with underline and highlight as the HTML Markdown allows
// inline, <u> and <mark>. This module turns it into the editor's inline content and back.
// Only inline syntax is read: a block never holds a heading, a list or a second paragraph,
// because the hierarchy is what holds structure. A link written [words](address) is a link on
// the sheet; a bare address, a link with a title, pictures and raw HTML are kept as the
// characters they were written with, so nothing a block holds is lost when it is edited.

// Tags open outside Markdown's delimiters: `<u>**word**</u>` reads as bold inside a word, where
// `**<u>word</u>**` would not, because a delimiter next to `<` inside a word cannot open.
const RANK = ['link', 'underline', 'highlight', 'bold', 'italic', 'strike'];
// A footnote cited by its block's ID: [^b-…]. Marks close before it and open again after, so
// each side of it reads on its own.
export const FOOTNOTE = /\[\^(b-[A-Za-z0-9_-]+)\]/g;
// A link's mark is kept here as one name with its address, so two links side by side stay two.
const LINK = 'link\u0000';
const linkOf = key => key.startsWith(LINK) ? key.slice(LINK.length) : null;
/** An address as Markdown writes it after the words: in angle brackets when it holds a space or a bracket. */
const destination = href => /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;

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
const OPEN = { bold: '**', italic: '*', strike: '~~', underline: '<u>', highlight: '<mark>' };
const CLOSE = { ...OPEN, underline: '</u>', highlight: '</mark>' };
const opener = key => linkOf(key) !== null ? '[' : OPEN[key];
const closer = key => linkOf(key) !== null ? `](${destination(linkOf(key))})` : CLOSE[key];
const TAG = { u: 'underline', mark: 'highlight' };

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
    while (open.length > upTo) out += closer(open.pop());
    out += trailing;
  };
  for (const node of content) {
    if (node.type === 'hardBreak') { close(0); out += '\\\n'; continue; }
    if (node.type === 'footnote') { if (node.attrs?.id) { close(0); out += `[^${node.attrs.id}]`; } continue; }
    if (node.type !== 'text' || !node.text) continue;
    const marks = new Set((node.marks ?? []).map(m => m.type));
    const href = (node.marks ?? []).find(m => m.type === 'link')?.attrs?.href;
    const wanted = RANK.filter(m => marks.has(m)).map(m => m === 'link' ? (href ? LINK + href : null) : m).filter(Boolean);
    let keep = 0;
    while (keep < open.length && keep < wanted.length && open[keep] === wanted[keep]) keep++;
    close(keep);
    let text = node.text;
    const lead = /^\s*/.exec(text)[0];
    if (open.length < wanted.length && lead) { out += lead; text = text.slice(lead.length); }
    for (const m of wanted.slice(open.length)) { out += opener(m); open.push(m); }
    out += marks.has('code') ? codeSpan(text) : escapeText(text, out.length === 0 || out.endsWith('\n'));
  }
  close(0);
  return out;
}

const markOf = key => linkOf(key) !== null ? { type: 'link', attrs: { href: linkOf(key) } } : { type: key };

function textNodes(text, marks) {
  const nodes = [];
  const parts = text.split(/(\n{2,})/);
  for (const part of parts) {
    if (/^\n{2,}$/.test(part)) { nodes.push({ type: 'hardBreak' }); continue; }
    const flat = part.replace(/\n/g, ' ');
    if (flat) nodes.push(marks.length ? { type: 'text', text: flat, marks: marks.map(markOf) } : { type: 'text', text: flat });
  }
  return nodes;
}

/** An inline <u>, </u>, <mark> or </mark> token as {mark, close}, or null. */
function tagOf(token) {
  if (token?.type !== 'html') return null;
  const match = /^<(\/?)(u|mark)>$/i.exec(token.raw ?? '');
  return match ? { mark: TAG[match[2].toLowerCase()], close: match[1] === '/' } : null;
}

function fromTokens(tokens, marks, out) {
  const list = tokens ?? [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i], tag = tagOf(t);
    // An opening tag marks everything up to its own closing tag at this level; one left open is
    // kept as the characters it was written with.
    if (tag && !tag.close) {
      let depth = 0, j = i + 1;
      for (; j < list.length; j++) {
        const next = tagOf(list[j]);
        if (!next || next.mark !== tag.mark) continue;
        if (!next.close) depth++;
        else if (depth-- === 0) break;
      }
      if (j < list.length) { fromTokens(list.slice(i + 1, j), marks.includes(tag.mark) ? marks : [...marks, tag.mark], out); i = j; continue; }
    }
    switch (t.type) {
      case 'strong': fromTokens(t.tokens, [...marks, 'bold'], out); break;
      case 'em': fromTokens(t.tokens, [...marks, 'italic'], out); break;
      case 'del': fromTokens(t.tokens, [...marks, 'strike'], out); break;
      case 'codespan': out.push({ type: 'text', text: unescapeEntities(t.text), marks: [...marks, 'code'].map(markOf) }); break;
      // [words](address): a link. A bare address, <address> or a link with a title stays as written.
      case 'link':
        if (!t.title && t.href && t.raw.startsWith('[') && !marks.some(m => linkOf(m) !== null)) fromTokens(t.tokens, [LINK + t.href, ...marks], out);
        else out.push(...textNodes(t.raw, marks));
        break;
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
  const out = [];
  let at = 0;
  for (const m of markdown.matchAll(FOOTNOTE)) {
    if (m.index > at) fromTokens(Lexer.lexInline(markdown.slice(at, m.index), { gfm: true, breaks: false }), [], out);
    out.push({ type: 'footnote', attrs: { id: m[1] } });
    at = m.index + m[0].length;
  }
  if (at < markdown.length) fromTokens(Lexer.lexInline(markdown.slice(at), { gfm: true, breaks: false }), [], out);
  return normalise(out);
}
