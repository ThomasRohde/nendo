// What a note's typing needs to outlast: a save that is still on its way, a move to another
// screen of Nendo, and a view started again. Pure, apart from the storage it is handed.
//
//   localDate(date)                 the person's calendar day, YYYY-MM-DD, never UTC's
//   uncertain(error)                whether a failed write may still have been kept
//   readDrafts(storage, key)        the drafts kept for this view, newest first
//   writeDrafts(storage, key, map)  keep them, within DRAFT_LIMITS: { kept, dropped, refused }
//   readUnanswered(storage, key)    the save Nendo never answered, kept until it is sent again
//   writeUnanswered(storage, key, sent)   keep it, or with null let it go
//
// The drafts live in the view's own browser storage. Nendo gives each package in each file an
// origin of its own, so they are this file's and this package's, on this device only; they are
// never records, and nothing in the file changes until the person saves.

/** The day a person means by Today: their own calendar's, which toISOString is not. */
export function localDate(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A write that failed without Nendo saying no: it timed out, or the view was reconnected while
 * it waited. It may have been kept. Sending the same batch again with the same writeKey finishes
 * it without writing twice; a refusal (anything else) wrote nothing.
 */
const UNCERTAIN = new Set(['host-timeout', 'disconnected']);
export const uncertain = error => UNCERTAIN.has(error?.code);

// Within what a browser lets one origin keep (about five million characters), with room to spare.
export const DRAFT_LIMITS = { count: 50, characters: 2 * 1024 * 1024 };

/**
 * The kept drafts, by note, or by 'new:…' for a note not saved yet, as { title, body, version, hash,
 * values, at }: version and hash say which version of the note the draft was written over. Bad or
 * missing storage keeps none.
 */
export function readDrafts(storage, key) {
  const drafts = new Map();
  let parsed;
  try { parsed = JSON.parse(storage?.getItem(key) ?? 'null'); } catch { return drafts; }
  if (!Array.isArray(parsed)) return drafts;
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') continue;
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') continue;
    drafts.set(entry.id, { title: entry.title, body: entry.body, version: Number.isInteger(entry.version) ? entry.version : null,
      hash: typeof entry.hash === 'string' ? entry.hash : null,
      values: typeof entry.values === 'object' && entry.values !== null ? entry.values : {}, at: Number(entry.at) || 0 });
  }
  return drafts;
}

/**
 * Keep the drafts, newest first, until the count or the characters run out. Answers how many were
 * kept and which were not: `dropped` names every draft this device will not have if the view stops,
 * because it did not fit or because the storage refused (`refused`, when nothing could be kept and
 * no older copy is left behind to come back stale). The view still holds them all, and says so.
 */
export function writeDrafts(storage, key, drafts) {
  const entries = [...drafts].map(([id, draft]) => ({ id, title: draft.title, body: draft.body, version: draft.version ?? null, hash: draft.hash ?? null,
    values: draft.values ?? {}, at: draft.at ?? 0 })).sort((a, b) => b.at - a.at);
  if (!storage) return { kept: 0, dropped: entries.map(entry => entry.id), refused: true };
  const kept = [], dropped = [];
  let characters = 2;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (kept.length === DRAFT_LIMITS.count || characters + size > DRAFT_LIMITS.characters) { dropped.push(entry.id); continue; }
    kept.push(entry);
    characters += size;
  }
  try {
    if (kept.length === 0) storage.removeItem(key); else storage.setItem(key, JSON.stringify(kept));
    return { kept: kept.length, dropped, refused: false };
  } catch {
    try { storage.removeItem(key); } catch { /* nothing more can be done here */ }
    return { kept: 0, dropped: entries.map(entry => entry.id), refused: true };
  }
}

/** The save Nendo never answered, as it was sent, or null. */
export function readUnanswered(storage, key) {
  try {
    const sent = JSON.parse(storage?.getItem(key) ?? 'null');
    return sent && typeof sent === 'object' && Array.isArray(sent.writes) && typeof sent.writeKey === 'string' && typeof sent.draftKey === 'string' ? sent : null;
  } catch { return null; }
}

/** Keep the save Nendo never answered, so a view started again sends the same batch under the same key; null lets it go. */
export function writeUnanswered(storage, key, sent) {
  try {
    if (sent === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify({ draftKey: sent.draftKey, noteId: sent.noteId, title: sent.title, body: sent.body,
      writes: sent.writes, stubs: sent.stubs, removed: sent.removed ?? [], label: sent.label, writeKey: sent.writeKey }));
    return !!storage;
  } catch { return false; }
}
