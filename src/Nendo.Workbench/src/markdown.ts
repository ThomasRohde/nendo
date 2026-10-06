import { escapeHtml } from './format';

/**
 * A text field presented as Markdown, as a page shows it (W-173). AI-written notes and answers
 * arrive as Markdown, and an outside author wrote a custom view and a parser only to read them.
 *
 * The subset is the one such text uses: headings, paragraphs, bulleted and numbered lists,
 * block quotes, fenced code, pipe tables, rules, and inline code, strong, emphasis and
 * strikethrough. Every character of the source is escaped before any tag is added, and the only
 * tags in the result are the ones written here, so stored text can never become markup. A link
 * is not followed: its text shows, with the address as its tooltip. An image shows its alt text.
 */
export function markdownMarkup(source: string, { headingShift = 2 }: { headingShift?: number } = {}): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
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
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      // A record page's own headings come first; a field's start below them.
      const level = Math.min(heading[1].length + headingShift, 6);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push('<hr>'); continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; index < lines.length && /^\s{0,3}>/.test(lines[index]); index++) quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
      index--;
      blocks.push(`<blockquote>${markdownMarkup(quoted.join('\n'), { headingShift })}</blockquote>`);
      continue;
    }
    const item = listItem(line);
    if (item) {
      flush();
      const items: string[] = [];
      for (; index < lines.length; index++) {
        const next = listItem(lines[index]);
        if (next && next.ordered === item.ordered) { items.push(next.text); continue; }
        // A line indented under an item continues it.
        if (items.length > 0 && /^\s{2,}\S/.test(lines[index]) && !listItem(lines[index])) { items[items.length - 1] += `\n${lines[index].trim()}`; continue; }
        break;
      }
      index--;
      const tag = item.ordered ? 'ol' : 'ul';
      const start = item.ordered && item.start !== 1 ? ` start="${item.start}"` : '';
      blocks.push(`<${tag}${start}>${items.map(text => `<li>${inline(text)}</li>`).join('')}</${tag}>`);
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
    paragraph.push(line.trim());
  }
  flush();
  return blocks.join('');
}

function listItem(line: string): { ordered: boolean; start: number; text: string } | null {
  const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { ordered: false, start: 1, text: bullet[1] };
  const numbered = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/.exec(line);
  return numbered ? { ordered: true, start: Number(numbered[1]), text: numbered[2] } : null;
}

function isTableRule(line: string): boolean {
  return line.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

/** One run of inline text: code spans kept literal, everything else escaped and then formatted. */
function inline(text: string): string {
  return text.split(/(`+[^`]*?`+)/).map((part, index) => {
    if (index % 2 === 1) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`;
    return escapeHtml(part)
      .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<span class="markdown-image" title="$2">$1</span>')
      .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<span class="markdown-link" title="$2">$1</span>')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '<strong>$2</strong>')
      .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '<em>$1</em>')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>')
      .replace(/ {2,}\n/g, '<br>')
      .replace(/\n/g, ' ');
  }).join('');
}
