import { escapeAttribute, escapeHtml } from './format';
import { mediaUrl, parseMediaAddress } from './media-model';

/**
 * A text field presented as Markdown, as a page shows it. AI-written notes and answers
 * arrive as Markdown, and an outside author wrote a custom view and a parser only to read them.
 *
 * The subset is the one such text uses: headings, paragraphs, bulleted and numbered lists (nested
 * by indentation), block quotes, fenced code, pipe tables, rules, hard line breaks, backslash
 * escapes, and inline code, strong, emphasis and strikethrough. Every character of the source is
 * escaped before any tag is added, and the only tags in the result are the ones written here, so
 * stored text can never become markup. A link is not followed: its text shows, with the address as
 * its tooltip. An image shows its alt text, unless the caller gives the file's pictures and the
 * image's address is a picture's (ADR-0031): then the picture is shown from the file's media
 * origin, or from the web while this device loads web pictures. No other address becomes a source.
 */
export function markdownMarkup(source: string, { headingShift = 2, pictures = null }: { headingShift?: number; pictures?: MarkdownPictures | null } = {}): string {
  const outer = shownPictures;
  shownPictures = pictures;
  try {
    return blocksOf(source.replace(/\r\n?/g, '\n').split('\n'), headingShift, 0);
  } finally {
    shownPictures = outer;
  }
}

/** Where a Markdown image's picture comes from: the open file's media origin, and whether web pictures load. */
export interface MarkdownPictures {
  origin: string | null | undefined;
  loadWeb: boolean;
}

/** The pictures of the call being rendered; null shows every image as its alt text. */
let shownPictures: MarkdownPictures | null = null;

/** A picture for an image whose address is a media address, or null to show its alt text. */
function pictureMarkup(alt: string, escapedAddress: string): string | null {
  if (shownPictures === null) return null;
  const address = parseMediaAddress(escapedAddress.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  const url = address === null ? null : mediaUrl(address, shownPictures.origin, shownPictures.loadWeb);
  return url === null ? null
    : `<span class="markdown-picture"><img src="${escapeAttribute(url)}" alt="${alt}" loading="lazy" decoding="async" data-media-thumb /><span class="markdown-picture-missing">Picture not found: ${alt}</span></span>`;
}

/**
 * How deep quotes nest before the rest is shown as it was typed. Each level was a recursive call,
 * so a few thousand '>' overflowed the stack and left the page undrawn.
 */
const maximumQuoteDepth = 8;

function blocksOf(lines: string[], headingShift: number, depth: number): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push(`<p>${inline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (index++; index < lines.length && !lines[index].trimStart().startsWith(fence[1]); index++) code.push(lines[index]);
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    // A closing run of '#' counts only after a space: '# Learn C#' keeps its '#'.
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flush();
      // A record page's own headings come first; a field's start below them.
      const level = Math.min(heading[1].length + headingShift, 6);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push('<hr>'); continue; }
    if (/^\s{0,3}>/.test(line) && depth < maximumQuoteDepth) {
      flush();
      const quoted: string[] = [];
      for (; index < lines.length && /^\s{0,3}>/.test(lines[index]); index++) quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
      index--;
      blocks.push(`<blockquote>${blocksOf(quoted, headingShift, depth + 1)}</blockquote>`);
      continue;
    }
    const item = listItem(line);
    if (item && item.indent <= 3) {
      flush();
      const entries: ListLine[] = [];
      for (; index < lines.length; index++) {
        const next = listItem(lines[index]);
        // A list of the other kind at the list's own level starts a list of its own.
        if (next && next.indent <= item.indent + 1 && next.ordered !== item.ordered) break;
        if (next) { entries.push(next); continue; }
        // A line indented under an item continues it.
        if (entries.length > 0 && /^\s{2,}\S/.test(lines[index])) { entries[entries.length - 1].text += `\n${lines[index].trim()}`; continue; }
        break;
      }
      index--;
      blocks.push(listMarkup(entries));
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && isTableRule(lines[index + 1])) {
      flush();
      const align = cells(lines[index + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null);
      const cellMarkup = (tag: string, cell: string, column: number): string =>
        `<${tag}${align[column] ? ` style="text-align:${align[column]}"` : ''}>${inline(cell)}</${tag}>`;
      const head = cells(line);
      const rows: string[][] = [];
      for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim() !== ''; index++) rows.push(cells(lines[index]));
      index--;
      blocks.push(`<div class="markdown-table"><table><thead><tr>${head.map((cell, column) => cellMarkup('th', cell, column)).join('')}</tr></thead>`
        + `<tbody>${rows.map(row => `<tr>${head.map((_, column) => cellMarkup('td', row[column] ?? '', column)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    // Only the start is trimmed: two spaces at a line's end are a line break.
    paragraph.push(line.trimStart());
  }
  flush();
  return blocks.join('');
}

interface ListLine { indent: number; ordered: boolean; start: number; text: string }
interface ListNode { ordered: boolean; start: number; indent: number; items: { text: string; children: ListNode[] }[] }

function listItem(line: string): ListLine | null {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { indent: bullet[1].length, ordered: false, start: 1, text: bullet[2] };
  const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
  return numbered ? { indent: numbered[1].length, ordered: true, start: Number(numbered[2]), text: numbered[3] } : null;
}

/**
 * A list, with a line indented two or more spaces past an item nesting under it, as AI-written
 * text routinely does: a bullet under a numbered step stays inside that step.
 */
function listMarkup(entries: ListLine[]): string {
  const root: ListNode = { ordered: entries[0].ordered, start: entries[0].start, indent: entries[0].indent, items: [] };
  const open: ListNode[] = [root];
  for (const entry of entries) {
    while (open.length > 1 && entry.indent < open[open.length - 1].indent) open.pop();
    let list = open[open.length - 1];
    const parent = list.items[list.items.length - 1];
    if (parent !== undefined && entry.indent >= list.indent + 2) {
      const nested: ListNode = { ordered: entry.ordered, start: entry.start, indent: entry.indent, items: [] };
      parent.children.push(nested);
      open.push(nested);
      list = nested;
    } else if (entry.ordered !== list.ordered && open.length > 1) {
      // Another kind at a nested level: a sibling list under the same item.
      open.pop();
      const holder = open[open.length - 1];
      const nested: ListNode = { ordered: entry.ordered, start: entry.start, indent: entry.indent, items: [] };
      holder.items[holder.items.length - 1].children.push(nested);
      open.push(nested);
      list = nested;
    }
    list.items.push({ text: entry.text, children: [] });
  }
  return listNodeMarkup(root);
}

function listNodeMarkup(list: ListNode): string {
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  return `<${tag}${start}>${list.items.map(item => `<li>${inline(item.text)}${item.children.map(listNodeMarkup).join('')}</li>`).join('')}</${tag}>`;
}

function isTableRule(line: string): boolean {
  return line.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

// Text held aside while the rest is formatted, so formatting never reaches inside it: a link's
// address, an escaped character. Private-use characters, which no formatting rule matches.
const held = (index: number): string => `${index}`;
const heldPattern = /(\d+)/g;

/** One run of inline text: code spans kept literal, everything else escaped and then formatted. */
function inline(text: string): string {
  return text.split(/(`+[^`]*?`+)/).map((part, index) => {
    if (index % 2 === 1) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`;
    const aside: string[] = [];
    const escapes = new Set<number>();
    const hold = (markup: string): string => { aside.push(markup); return held(aside.length - 1); };
    const holdEscape = (markup: string): string => { escapes.add(aside.length); return hold(markup); };
    // Only an escape may sit in an address: an image held there would be restored inside a tooltip.
    const addressable = (address: string): boolean => [...address.matchAll(heldPattern)].every(([, held]) => escapes.has(Number(held)));
    // A backslash before punctuation shows the punctuation itself. The private-use
    // characters held text is marked with are themselves held, as entities, never dropped.
    const escaped = part
      .replace(/[\uE000\uE001]/g, (character: string) => holdEscape(`&#x${character.charCodeAt(0).toString(16).toUpperCase()};`))
      .replace(/\\([!-/:-@[-`{-~])/g, (_, character: string) => holdEscape(escapeHtml(character)));
    // Links and images come out before any emphasis is matched, so a delimiter in an address
    // never pairs with one in the text and a tag never lands in a tooltip.
    const linked = escapeHtml(escaped)
      .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^&]*&quot;)?\)/g,
        (whole: string, alt: string, address: string) => !addressable(address) ? whole
          : hold(address.includes('\uE000') ? `<span class="markdown-image" title="${address}">${emphasis(alt)}</span>`
            : pictureMarkup(alt, address) ?? `<span class="markdown-image" title="${address}">${emphasis(alt)}</span>`))
      .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^&]*&quot;)?\)/g,
        (whole: string, label: string, address: string) => addressable(address) ? hold(`<span class="markdown-link" title="${address}">${emphasis(label)}</span>`) : whole);
    const formatted = emphasis(linked)
      .replace(/ {2,}\n/g, '<br>')
      .replace(/\n/g, ' ');
    // Held text may itself hold text (a link's label with an escape in it), so restore until none is left.
    let restored = formatted;
    for (let pass = 0; pass < 4 && restored.includes(''); pass++) restored = restored.replace(heldPattern, (_, at: string) => aside[Number(at)] ?? '');
    return restored;
  }).join('');
}

/**
 * Strong, emphasis and strikethrough. A run's content never crosses its own delimiter, so an
 * unmatched opener stops at the next one instead of scanning to the end of the line: thousands of
 * unclosed '**' took seconds, quadratically. An opener is never the second half of a
 * pair, so '**a **b' stays as typed rather than becoming emphasis with stray stars.
 */
function emphasis(text: string): string {
  return text
    .replace(/(\*\*|__)(?=\S)((?:(?!\1)[^\n])+?)(?<=\S)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![\w_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w_])/g, '<em>$1</em>')
    .replace(/~~(?=\S)((?:(?!~~)[^\n])+?)(?<=\S)~~/g, '<del>$1</del>');
}
