// Typing not yet saved, kept on the device. Nendo ends a view's frame without asking (ADR-0013), so
// each change the next save would make is kept with the version it was typed over, and the view
// restores it over that version when it starts again: a record nobody changed since takes it at
// once; one that changed is held until the person puts theirs back or discards it.
//
// An entry is { entityId, recordId, version, values }, values by field ID.

export const DRAFT_FORMAT = 2;

const same = (a, b) => (a ?? null) === (b ?? null);

/** The values that differ from what the record now holds. */
export function differing(values, record) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([field, value]) => !same(value, record?.values?.[field])));
}

/** Entries read back from storage, or none when they are not this format. */
export function readDrafts(text) {
  try {
    const kept = JSON.parse(text ?? 'null');
    if (kept?.format !== DRAFT_FORMAT || !Array.isArray(kept.entries)) return [];
    return kept.entries.filter(e => e && typeof e.entityId === 'string' && typeof e.recordId === 'string' && Number.isInteger(e.version) && e.values && typeof e.values === 'object');
  } catch { return []; }
}

export const writeDrafts = entries => entries.length ? JSON.stringify({ format: DRAFT_FORMAT, entries }) : null;

/**
 * Sorts kept entries against the records as they are now: fresh ones are on the version they were
 * typed over, stale ones on a newer one. An entry whose record is gone, or that the record already
 * holds, drops out. Each keeps only the values that still differ.
 */
export function sortDrafts(entries, current) {
  const fresh = [], stale = [];
  for (const entry of merged(entries)) {
    const record = current(entry.entityId, entry.recordId);
    if (!record) continue;
    const values = differing(entry.values, record);
    if (!Object.keys(values).length) continue;
    (record.version === entry.version ? fresh : stale).push({ ...entry, values });
  }
  return { fresh, stale };
}

/** One entry per record: later values win, and the earliest version is the one typed over. */
function merged(entries) {
  const byRecord = new Map();
  for (const entry of entries) {
    const key = `${entry.entityId}\n${entry.recordId}`;
    const first = byRecord.get(key);
    byRecord.set(key, first ? { ...first, version: Math.min(first.version, entry.version), values: { ...first.values, ...entry.values } } : entry);
  }
  return [...byRecord.values()];
}

/** Held entries less the fields a save of that record just wrote: the newer typing wins. */
export function withoutWritten(entries, entityId, recordId, written) {
  return entries.flatMap(entry => {
    if (entry.entityId !== entityId || entry.recordId !== recordId) return [entry];
    const values = Object.fromEntries(Object.entries(entry.values).filter(([field]) => !(field in written)));
    return Object.keys(values).length ? [{ ...entry, values }] : [];
  });
}
