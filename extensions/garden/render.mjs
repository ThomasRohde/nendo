// A small Markdown renderer for a note's preview, with Garden's [[wikilinks]] and #tags as anchors.
// Every character of the note passes through one escape, so a body is never markup. It knows
// headings, paragraphs, emphasis, inline and fenced code, lists with checkboxes, quotes, rules and
// http links. Tables, footnotes, embeds and images are not in it. A closed ```mermaid fence becomes
// a figure.diagram holding its source as code, which diagrams.js draws once the HTML is on the page.
//
//   render(body, { resolve, interactive })   -> HTML text. resolve(target) answers { recordId, title } or null;
//   interactive leaves task checkboxes enabled, each naming its source line as data-line.

const WIKILINK = /\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g;
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;

export function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// U+0000 marks a held piece of markup while a line is read, so a body's own is read as U+FFFD
// and can never stand for one.
const plainText = text => String(text ?? '').replace(/\u0000/g, '\uFFFD');

export function render(body, { resolve = () => null, interactive = false } = {}) {
  const lines = plainText(body).split(/\r?\n/);
  const out = [];
  let paragraph = [], list = null, quote = [], fence = null, language = '', code = [];
  const flushParagraph = () => { if (paragraph.length) { out.push(`<p>${inline(paragraph.join(' '), resolve)}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '), resolve)}</blockquote>`); quote = []; } };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
  for (const [number, line] of lines.entries()) {
    const opening = FENCE.exec(line);
    if (fence !== null) {
      if (opening !== null && opening[1][0] === fence[0] && opening[1].length >= fence.length) {
        const block = `<pre><code>${escape(code.join('\n'))}</code></pre>`;
        out.push(language === 'mermaid' && code.some(text => text.trim() !== '') ? `<figure class="diagram">${block}</figure>` : block);
        fence = null; code = [];
      } else code.push(line);
      continue;
    }
    if (opening !== null) { flushAll(); fence = opening[1]; language = opening[2].toLowerCase(); continue; }
    if (line.trim() === '') { flushAll(); continue; }
    // A closing run of # is cut only after a space, so '# Learning C#' keeps its #.
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading !== null) { flushAll(); out.push(`<h${heading[1].length}>${inline(heading[2], resolve)}</h${heading[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted !== null) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item !== null) {
      flushParagraph(); flushQuote();
      const tag = item[1] ? 'ul' : 'ol';
      if (list === null || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      // A task is a bullet item, as parse() and a tick read one: a numbered '1. [ ] x' stays text,
      // never a box that ticks and saves nothing.
      const task = item[1] ? /^\[( |x|X)\]\s+(.+?)\s*$/.exec(item[3]) : null;
      list.items.push(task === null
        ? `<li>${inline(item[3], resolve)}</li>`
        : `<li class="task${task[1] === ' ' ? '' : ' done'}"><input type="checkbox"${interactive ? ` data-line="${number}" aria-label="${escape(task[2])}"` : ' disabled'}${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2], resolve)}</li>`);
      continue;
    }
    flushList(); flushQuote();
    paragraph.push(line.trim());
  }
  if (fence !== null) out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

/** Inline markup over one run of text: code spans first, so nothing inside them is read. A code
 * span is held in place rather than cut out, so emphasis around it, as in **`name`**, still pairs. */
export function inline(text, resolve) {
  // Structural tokens are replaced by placeholders before escaping, so their markup survives it.
  // A piece held later can hold an earlier one (a link whose words are code): its placeholders are
  // expanded as it is held, so the line is expanded once at the end, and its text never grows.
  // Where a piece's words go into an attribute, an earlier piece stands there as the text it was
  // written as, escaped like the rest, never as its markup.
  const holds = [], sources = [];
  const PLACE = /\u0000(\d+)\u0000/g;
  const expand = html => html.replace(PLACE, (_, index) => holds[Number(index)] ?? '');
  const source = text => text.replace(PLACE, (_, index) => sources[Number(index)] ?? '');
  const hold = (html, written) => { holds.push(expand(html)); sources.push(source(written)); return `\u0000${holds.length - 1}\u0000`; };
  const work = plainText(text).replace(/`([^`\n]*)`/g, (written, code) => hold(`<code>${escape(code)}</code>`, written));
  return spans(work, resolve, hold, expand, source);
}

function spans(text, resolve, hold, expand, source) {
  let work = text.replace(WIKILINK, (written, target, alias) => {
    const name = source(target.trim()), label = alias?.trim() || null;
    const found = resolve(name);
    const classes = found ? 'wikilink' : 'wikilink missing';
    const id = found ? ` data-id="${escape(found.recordId)}"` : '';
    const words = label !== null ? escape(label) : found ? escape(found.title) : escape(target.trim());
    return hold(`<a class="${classes}" href="#" data-target="${escape(name)}"${id}>${words}</a>`, written);
  });
  work = work.replace(LINK, (written, label, href) => hold(`<a href="${escape(source(href))}" rel="noopener" target="_blank">${escape(label)}</a>`, written));
  work = work.replace(TAG, (_, before, name) => {
    const tag = name.replace(/[/-]+$/, '');
    if (!/\p{L}/u.test(tag)) return `${before}#${name}`;
    return `${before}${hold(`<a class="tag" href="#" data-tag="${escape(tag.toLowerCase())}">#${escape(tag)}</a>`, `#${name}`)}`;
  });
  work = escape(work)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return expand(work);
}
