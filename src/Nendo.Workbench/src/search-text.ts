import { storageKindName } from './extension-model';
import type { DesktopSessionView, EntitySnapshot } from './host-types';

/**
 * Search text on the Workbench side (ADR-0028): the preview host's stand-in for the Engine's index,
 * and the highlighting every search result list shares. The native host answers a search from the
 * file's FTS5 index; this matches the same syntax in memory so the preview can be tried.
 */

export interface SearchHitView {
  entityId: string;
  recordId: string;
  version: number;
  label: string | null;
  score: number;
  fields: Array<{ fieldId: string; snippet: string; ranges: Array<{ start: number; length: number }> }>;
}

export interface SearchPageView {
  items: SearchHitView[];
  nextCursor: string | null;
  changeSequence: number;
}

interface Term { readonly words: string[]; readonly prefix: boolean }

/** Lower case, accents folded, as the index's tokenizer folds them. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function words(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/** The syntax the Engine reads: words, "phrases", -word, and the last word as a prefix. */
export function parseSearch(text: string): { required: Term[]; excluded: Term[] } {
  const tokens: Array<{ text: string; phrase: boolean; excluded: boolean }> = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index += 1; continue; }
    let excluded = false;
    if (text[index] === '-' && index + 1 < text.length && !/\s/.test(text[index + 1])) { excluded = true; index += 1; }
    if (text[index] === '"') {
      const close = text.indexOf('"', index + 1);
      const end = close < 0 ? text.length : close;
      tokens.push({ text: text.slice(index + 1, end), phrase: true, excluded });
      index = close < 0 ? text.length : close + 1;
      continue;
    }
    const start = index;
    while (index < text.length && !/\s/.test(text[index]) && text[index] !== '"') index += 1;
    tokens.push({ text: text.slice(start, index), phrase: false, excluded });
  }
  const searchable = tokens.filter((token) => words(token.text).length > 0);
  const lastRequired = searchable.map((token) => !token.excluded).lastIndexOf(true);
  const required: Term[] = [];
  const excluded: Term[] = [];
  searchable.forEach((token, position) => {
    const term = { words: words(token.text), prefix: position === lastRequired && !token.phrase && !text.endsWith(' ') };
    (token.excluded ? excluded : required).push(term);
  });
  return { required, excluded };
}

/** Where a term matches in a text: each matched word as a range of the original text. */
function termRanges(text: string, term: Term): Array<{ start: number; length: number }> {
  const spans: Array<{ word: string; start: number; length: number }> = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) spans.push({ word: foldText(match[0]), start: match.index ?? 0, length: match[0].length });
  const ranges: Array<{ start: number; length: number }> = [];
  for (let at = 0; at + term.words.length <= spans.length; at += 1) {
    const hit = term.words.every((word, offset) => {
      const span = spans[at + offset];
      const last = offset === term.words.length - 1;
      return last && term.prefix ? span.word.startsWith(word) : span.word === word;
    });
    if (hit) for (let offset = 0; offset < term.words.length; offset += 1) ranges.push({ start: spans[at + offset].start, length: spans[at + offset].length });
  }
  return ranges;
}

function searchedFields(entity: EntitySnapshot): EntitySnapshot['fields'] {
  return entity.retired === true ? [] : entity.fields.filter((field) => field.retired !== true &&
    storageKindName(field.storageKind) === 'text' && (field.choices ?? []).length === 0 && field.options.length === 0);
}

/** A short excerpt around the first match, with its ranges moved to the excerpt. */
function excerpt(text: string, ranges: Array<{ start: number; length: number }>): { snippet: string; ranges: Array<{ start: number; length: number }> } {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const from = Math.max(0, (sorted[0]?.start ?? 0) - 40);
  const to = Math.min(text.length, from + 160);
  const prefix = from > 0 ? '…' : '';
  const snippet = prefix + text.slice(from, to) + (to < text.length ? '…' : '');
  return {
    snippet,
    ranges: sorted.filter((range) => range.start >= from && range.start + range.length <= to)
      .map((range) => ({ start: range.start - from + prefix.length, length: range.length })),
  };
}

/** The preview host's answer to data.searchRecords. */
export function previewSearch(session: DesktopSessionView, payload: Record<string, unknown>): SearchPageView {
  const { required, excluded } = parseSearch(typeof payload.text === 'string' ? payload.text : '');
  const entityIds = Array.isArray(payload.entityIds) ? payload.entityIds as string[] : [];
  const fieldIds = Array.isArray(payload.fieldIds) ? payload.fieldIds as string[] : [];
  const limit = typeof payload.limit === 'number' ? payload.limit : 20;
  const offset = typeof payload.cursor === 'string' ? Number(payload.cursor) || 0 : 0;
  const changeSequence = session.manifest?.changeSequence ?? 0;
  if (required.length === 0) return { items: [], nextCursor: null, changeSequence };
  const hits: SearchHitView[] = [];
  for (const entity of session.entities) {
    if (entityIds.length > 0 && !entityIds.includes(entity.entityId)) continue;
    const all = searchedFields(entity);
    const fields = all.filter((field) => fieldIds.length === 0 || fieldIds.includes(field.fieldId));
    if (fields.length === 0) continue;
    for (const record of session.records) {
      if (record.entityId !== entity.entityId) continue;
      const texts = fields.map((field) => ({ fieldId: field.fieldId, text: typeof record.values[field.fieldId] === 'string' ? record.values[field.fieldId] as string : '' }));
      if (!required.every((term) => texts.some((field) => termRanges(field.text, term).length > 0))) continue;
      if (excluded.some((term) => texts.some((field) => termRanges(field.text, term).length > 0))) continue;
      const matched = texts.map((field) => ({ field, ranges: required.flatMap((term) => termRanges(field.text, term)) }))
        .filter((entry) => entry.ranges.length > 0);
      const label = all[0] === undefined ? null : String(record.values[all[0].fieldId] ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? null;
      hits.push({
        entityId: entity.entityId, recordId: record.recordId, version: record.recordVersion, label,
        // Shorter fields with more matches first, as BM25 would put them.
        score: Math.max(...matched.map((entry) => entry.ranges.length / Math.sqrt(Math.max(1, words(entry.field.text).length)))),
        fields: matched.map((entry) => ({ fieldId: entry.field.fieldId, ...excerpt(entry.field.text, entry.ranges) })),
      });
    }
  }
  hits.sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId) || left.recordId.localeCompare(right.recordId));
  const page = hits.slice(offset, offset + limit);
  return { items: page, nextCursor: offset + limit < hits.length ? String(offset + limit) : null, changeSequence };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** An excerpt as HTML: the text escaped, and each matched range in a <mark>. */
export function highlightedSnippet(snippet: string, ranges: ReadonlyArray<{ start: number; length: number }>): string {
  let html = '';
  let at = 0;
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    if (range.start < at || range.start + range.length > snippet.length) continue;
    html += escapeHtml(snippet.slice(at, range.start)) + '<mark>' + escapeHtml(snippet.slice(range.start, range.start + range.length)) + '</mark>';
    at = range.start + range.length;
  }
  return html + escapeHtml(snippet.slice(at));
}
