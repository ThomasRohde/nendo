// What a note's body says in Garden's own notation: [[wikilinks]], #tags and - [ ] checkboxes.
// Pure functions over text, shared by the view, the seed and the tests. Nothing here reads the file.
//
//   parse(body)        -> { links: [{target, label, excerpt, line}], tags: [name], tasks: [{text, done, key, line}] }
//   slugify(text)      -> a stable lower-case address, letters, digits and hyphens, at most 64 characters
//   fnv1a(text)        -> eight hex digits, the key a checkbox task keeps across edits of its note
//   excerptAround(line, index, width) -> the line around a match, cut to width

const WIKILINK = /\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g;
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+?)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;

export const EXCERPT_WIDTH = 200;
export const SLUG_WIDTH = 64;

/**
 * The body's links, tags and tasks, in the order they appear: a link or a tag once however often it
 * is written, and every checkbox line, since two lines that say the same task are two tasks. Each
 * keeps a key of its own: the key of its text, then -2, -3 for the lines after it that say it again.
 */
export function parse(body) {
  const links = [], tags = [], tasks = [];
  const seenLinks = new Set(), seenTags = new Set(), seenTasks = new Map();
  let fence = null;
  const lines = String(body ?? '').split(/\r?\n/);
  lines.forEach((line, number) => {
    const opening = FENCE.exec(line);
    if (fence !== null) {
      if (opening !== null && opening[1][0] === fence[0] && opening[1].length >= fence.length) fence = null;
      return;
    }
    if (opening !== null) { fence = opening[1]; return; }
    const task = CHECKBOX.exec(line);
    if (task !== null) {
      const text = task[2], base = fnv1a(normalise(text)), nth = (seenTasks.get(base) ?? 0) + 1;
      seenTasks.set(base, nth);
      tasks.push({ text, done: task[1] !== ' ', key: nth === 1 ? base : `${base}-${nth}`, line: number });
    }
    // Inline code keeps its width, so an excerpt's window lands where the match is.
    const scan = line.replace(INLINE_CODE, code => ' '.repeat(code.length));
    for (const match of scan.matchAll(WIKILINK)) {
      const target = match[1].trim(), label = match[2]?.trim() || null;
      if (target.length === 0) continue;
      const key = target.toLowerCase();
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push({ target, label, excerpt: excerptAround(line, match.index, EXCERPT_WIDTH), line: number });
    }
    for (const match of scan.matchAll(TAG)) {
      const name = match[2].replace(/[/-]+$/, '').toLowerCase();
      if (!/\p{L}/u.test(name) || seenTags.has(name)) continue;
      seenTags.add(name);
      tags.push(name);
    }
  });
  return { links, tags, tasks };
}

/** A stable address made from a title: lower-case letters, digits and single hyphens. */
export function slugify(text) {
  const slug = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_WIDTH).replace(/-+$/, '');
  return slug.length === 0 ? 'note' : slug;
}

/** FNV-1a over the UTF-8 bytes, as eight hex digits: short, stable, and the same in any runtime. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(text ?? ''))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The line around a match, trimmed, cut to `width` characters with the match kept inside. */
export function excerptAround(line, index, width = EXCERPT_WIDTH) {
  const text = String(line ?? '');
  if (text.trim().length <= width) return text.trim();
  let start = Math.max(0, Math.min(index - Math.floor(width / 3), text.length - width));
  let end = Math.min(text.length, start + width);
  // Cut between words, never inside one.
  if (start > 0) { const space = text.indexOf(' ', start); if (space !== -1 && space < index) start = space + 1; }
  if (end < text.length) { const space = text.lastIndexOf(' ', end); if (space > index) end = space; }
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function normalise(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
