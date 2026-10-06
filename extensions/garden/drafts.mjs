// What a note's typing needs to outlast: a save that is still on its way, a move to another
// screen of Nendo, and a view started again. Pure, apart from the storage it is handed.
//
//   localDate(date)                 the person's calendar day, YYYY-MM-DD, never UTC's
//   uncertain(error)                whether a failed write may still have been kept
//   readDrafts(storage, key)        the drafts kept for this view, newest first
//   writeDrafts(storage, key, map)  keep them, within DRAFT_LIMITS
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

export const DRAFT_LIMITS = { count: 20, characters: 512 * 1024 };

/** The kept drafts, by note (or 'new'), as { title, body, version, values, at }. Bad or missing storage keeps none. */
export function readDrafts(storage, key) {
  const drafts = new Map();
  let parsed;
  try { parsed = JSON.parse(storage?.getItem(key) ?? 'null'); } catch { return drafts; }
  if (!Array.isArray(parsed)) return drafts;
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string') continue;
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') continue;
    drafts.set(entry.id, { title: entry.title, body: entry.body, version: Number.isInteger(entry.version) ? entry.version : null,
      values: typeof entry.values === 'object' && entry.values !== null ? entry.values : {}, at: Number(entry.at) || 0 });
  }
  return drafts;
}

/**
 * Keep the drafts, newest first, until the count or the characters run out: an older draft past
 * the bound is the one let go. Answers how many were kept, or null when the storage refused.
 */
export function writeDrafts(storage, key, drafts) {
  const entries = [...drafts].map(([id, draft]) => ({ id, title: draft.title, body: draft.body, version: draft.version ?? null, values: draft.values ?? {}, at: draft.at ?? 0 }))
    .sort((a, b) => b.at - a.at);
  const kept = [];
  let characters = 2;
  for (const entry of entries) {
    if (kept.length === DRAFT_LIMITS.count) break;
    const size = JSON.stringify(entry).length + 1;
    if (characters + size > DRAFT_LIMITS.characters) continue;
    kept.push(entry);
    characters += size;
  }
  try {
    if (kept.length === 0) storage?.removeItem(key); else storage?.setItem(key, JSON.stringify(kept));
    return kept.length;
  } catch { return null; }
}
