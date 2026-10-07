// Finding notes by what they say. Nendo searches the file's own full-text index (ADR-0028), so a
// word that sits only in a note's body is found, ranked. Until the
// answer arrives, and on a Nendo without search or a file without an index, the notes the view
// already holds are matched here instead: title, slug and body, as plain text.

const fold = text => String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** Whether a note holds every word of what was typed, in its title, slug or body. */
export function localMatch(note, text, bodyFieldId) {
  // A phrase is matched here as its words; the index matches it as one.
  const words = fold(text).replaceAll('"', ' ').split(/\s+/).filter(word => word.replace(/^-/, '').length > 0);
  if (words.length === 0) return true;
  const haystack = fold(`${note.title}\n${note.slug}\n${note.values?.[bodyFieldId] ?? ''}`);
  return words.every(word => haystack.includes(word.replace(/^-/, '')) !== word.startsWith('-'));
}

/**
 * A search that waits for a pause in typing and answers only the latest text. `onResult` gets a
 * Map of record ID to hit, or null when the index could not answer and local matching stands.
 */
export function createFinder(nendo, { entityId, onResult, pauseMs = 150, max = 500 }) {
  const can = typeof nendo.has === 'function' && nendo.has('records.search');
  let timer;
  let sequence = 0;
  return {
    get available() { return can; },
    find(text) {
      clearTimeout(timer);
      const mine = ++sequence;
      const trimmed = String(text ?? '').trim();
      if (trimmed === '' || !can) { onResult(null, trimmed, can ? 'empty' : 'unavailable'); return; }
      timer = setTimeout(async () => {
        const hits = new Map();
        try {
          let cursor = null;
          do {
            const page = await nendo.records.search(trimmed, { entityIds: [entityId], limit: 100, cursor });
            for (const hit of page.items) hits.set(hit.recordId, hit);
            cursor = page.nextCursor;
          } while (cursor !== null && hits.size < max && mine === sequence);
        } catch (error) {
          if (mine === sequence) onResult(null, trimmed, error?.code ?? 'failed');
          return;
        }
        if (mine === sequence) onResult(hits, trimmed, 'index');
      }, pauseMs);
    },
  };
}
