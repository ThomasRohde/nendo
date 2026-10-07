// What the Overview shows, from records as the view reads them. Pure, so it is tested in Node.
//
//   overview({ notes, links, tags, noteTags }, { stages }) -> {
//     counts: { notes, links, unlinked }, stages: [{ id, label, count }], unlinked: [noteId],
//     pinned: [card], tags: [{ id, name, count, size }] }
//   excerpt(values) -> the note's summary, or its first line of prose, as plain text
//   whenTended(date, today) -> today, yesterday, a weekday within the week, or the day and month
//   findNotes(notes, text, ids) -> { notes: up to six, exact }
//
// The links are counted as the graph draws them, one per linked pair and direction, so the number
// beside the graph is the number of lines on it. A card is { id, title, stage, touched, excerpt,
// linksIn, linksOut }.

import { buildGraph } from './graph-data.mjs';
import { plainText } from './related.mjs';
import { localMatch } from './search.mjs';
import { F } from './sync.mjs';

export const PINNED = 8;
export const TAGS = 12;

export function overview({ notes = [], links = [], tags = [], noteTags = [] } = {}, { stages = [] } = {}) {
  const graph = buildGraph({ notes, links });
  const degree = new Map(graph.nodes.map(node => [node.id, node.degree]));
  const linksIn = new Map(), linksOut = new Map();
  for (const edge of graph.links) {
    linksIn.set(edge.target, (linksIn.get(edge.target) ?? 0) + 1);
    linksOut.set(edge.source, (linksOut.get(edge.source) ?? 0) + 1);
  }
  const card = note => ({ id: note.recordId, title: String(note.values[F.note.title] ?? note.recordId), stage: note.values[F.note.stage] ?? null,
    touched: note.values[F.note.touched] ?? null, excerpt: excerpt(note.values), linksIn: linksIn.get(note.recordId) ?? 0, linksOut: linksOut.get(note.recordId) ?? 0 });
  const byTitle = (a, b) => String(a.values[F.note.title] ?? '').localeCompare(String(b.values[F.note.title] ?? ''));

  const pinnedNotes = notes.filter(note => note.values[F.note.pinned] === true).sort(byTitle);

  const counted = new Map();
  for (const note of notes) { const stage = note.values[F.note.stage]; if (stage) counted.set(stage, (counted.get(stage) ?? 0) + 1); }
  const known = stages.map(choice => ({ id: choice.id, label: choice.displayName ?? choice.id, count: counted.get(choice.id) ?? 0 }));
  for (const [id, count] of counted) if (!known.some(stage => stage.id === id)) known.push({ id, label: id, count });

  const carriers = new Map();
  for (const row of noteTags) {
    const tag = row.values[F.noteTag.tag], note = row.values[F.noteTag.note];
    if (!carriers.has(tag)) carriers.set(tag, new Set());
    carriers.get(tag).add(note);
  }
  const ranked = tags.map(tag => ({ id: tag.recordId, name: String(tag.values[F.tag.name] ?? tag.recordId), count: carriers.get(tag.recordId)?.size ?? 0 }))
    .filter(tag => tag.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TAGS);
  const most = ranked[0]?.count ?? 0, least = ranked.at(-1)?.count ?? 0;
  for (const tag of ranked) tag.size = most === least ? 2 : 1 + Math.round(3 * (tag.count - least) / (most - least));

  const unlinked = graph.nodes.filter(node => node.degree === 0).map(node => node.id);
  return {
    counts: { notes: notes.length, links: graph.links.length, unlinked: unlinked.length },
    stages: known, unlinked, degree,
    pinned: pinnedNotes.slice(0, PINNED).map(card), tags: ranked,
  };
}

/** A note in a sentence: its summary when it has one, else its first line of prose, plain. */
export function excerpt(values, max = 160) {
  const summary = String(values?.[F.note.summary] ?? '').trim();
  let text = summary;
  if (!text) {
    let fenced = false;
    for (const line of String(values?.[F.note.body] ?? '').split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced || /^\s*(#{1,6}\s|---\s*$|\|)/.test(line) || line.trim() === '') continue;
      text = plainText(line.trim()).replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, '$1$2').trim();
      if (text) break;
    }
  }
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text;
}

const DAY = 86_400_000;
const asDay = text => { const [y, m, d] = String(text).split('-').map(Number); return Date.UTC(y, m - 1, d); };

/** When a note was tended, in words a person says: today, yesterday, Monday, or 3 Oct. */
export function whenTended(date, today, locale = 'en') {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return '';
  const days = Math.round((asDay(today) - asDay(date)) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  const day = new Date(asDay(date));
  if (days > 1 && days < 7) return day.toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' });
  return day.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC', ...(Math.abs(days) > 300 ? { year: 'numeric' } : {}) });
}

/**
 * The notes that answer what was typed into the Overview's find: by the index's hits when they have
 * come (`ids`), by the notes held here until then. A title that starts with the words comes first.
 * `exact` says a note already has that title, so the box offers no new one.
 */
export function findNotes(notes, text, ids = null, max = 6) {
  const words = String(text ?? '').trim();
  if (!words) return { notes: [], exact: false };
  const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
  const wanted = fold(words);
  const index = notes.map(note => ({ ...note, title: String(note.values[F.note.title] ?? note.recordId), slug: String(note.values[F.note.slug] ?? '') }));
  const found = index.filter(note => ids !== null ? ids.has(note.recordId) || fold(note.title).includes(wanted) : localMatch(note, words, F.note.body));
  const rank = note => fold(note.title).startsWith(wanted) ? 0 : fold(note.title).includes(wanted) ? 1 : 2;
  found.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  return { notes: found.slice(0, max).map(note => ({ id: note.recordId, title: note.title, stage: note.values[F.note.stage] ?? null })),
    exact: index.some(note => fold(note.title) === wanted) };
}
