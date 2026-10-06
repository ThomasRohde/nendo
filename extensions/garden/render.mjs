// A small Markdown renderer for a note's preview, with Garden's [[wikilinks]] and #tags as anchors.
// Every character of the note passes through one escape, so a body is never markup. It knows
// headings, paragraphs, emphasis, inline and fenced code, lists with checkboxes, quotes, rules and
// http links. Tables, footnotes, embeds and images are not in it.
//
//   render(body, { resolve })   -> HTML text. resolve(target) answers { recordId, title } or null.

const WIKILINK = /\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g;
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;

export function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function render(body, { resolve = () => null } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  let paragraph = [], list = null, quote = [], fence = null, code = [];
  const flushParagraph = () => { if (paragraph.length) { out.push(`<p>${inline(paragraph.join(' '), resolve)}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '), resolve)}</blockquote>`); quote = []; } };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
  for (const line of lines) {
    const opening = FENCE.exec(line);
    if (fence !== null) {
      if (opening !== null && opening[1][0] === fence[0] && opening[1].length >= fence.length) {
        out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
        fence = null; code = [];
      } else code.push(line);
      continue;
    }
    if (opening !== null) { flushAll(); fence = opening[1]; continue; }
    if (line.trim() === '') { flushAll(); continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) { flushAll(); out.push(`<h${heading[1].length}>${inline(heading[2], resolve)}</h${heading[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted !== null) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item !== null) {
      flushParagraph(); flushQuote();
      const tag = item[1] ? 'ul' : 'ol';
      if (list === null || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(item[3]);
      list.items.push(task === null
        ? `<li>${inline(item[3], resolve)}</li>`
        : `<li class="task${task[1] === ' ' ? '' : ' done'}"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2], resolve)}</li>`);
      continue;
    }
    flushList(); flushQuote();
    paragraph.push(line.trim());
  }
  if (fence !== null) out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

/** Inline markup over one run of text: code spans first, so nothing inside them is read. */
export function inline(text, resolve) {
  const parts = String(text).split(/(`[^`\n]*`)/);
  return parts.map((part, index) => {
    if (index % 2 === 1) return `<code>${escape(part.slice(1, -1))}</code>`;
    return spans(part, resolve);
  }).join('');
}

function spans(text, resolve) {
  // Structural tokens are replaced by placeholders before escaping, so their markup survives it.
  const holds = [];
  const hold = html => { holds.push(html); return `\u0000${holds.length - 1}\u0000`; };
  let work = text.replace(WIKILINK, (_, target, alias) => {
    const name = target.trim(), label = alias?.trim() || null;
    const found = resolve(name);
    const classes = found ? 'wikilink' : 'wikilink missing';
    const id = found ? ` data-id="${escape(found.recordId)}"` : '';
    return hold(`<a class="${classes}" href="#" data-target="${escape(name)}"${id}>${escape(label ?? found?.title ?? name)}</a>`);
  });
  work = work.replace(LINK, (_, label, href) => hold(`<a href="${escape(href)}" rel="noopener" target="_blank">${escape(label)}</a>`));
  work = work.replace(TAG, (_, before, name) => {
    const tag = name.replace(/[/-]+$/, '');
    if (!/\p{L}/u.test(tag)) return `${before}#${name}`;
    return `${before}${hold(`<a class="tag" href="#" data-tag="${escape(tag.toLowerCase())}">#${escape(tag)}</a>`)}`;
  });
  work = escape(work)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return work.replace(/\u0000(\d+)\u0000/g, (_, index) => holds[Number(index)]);
}
