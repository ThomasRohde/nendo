// One view of the Garden package asks another to do something: the Overview hands the Garden view
// the note to open, a title to plant, or today's note. Both frames are the package's, so they share
// its origin and its storage, which carries the request across the screen change. It is taken once,
// and only while it is fresh, so a request nobody took never opens a note later.
//
//   handOver({ open: noteId } | { plant: title } | { daily: true }) -> whether it was kept
//   takeHandover() -> the request, or null

export const HANDOVER_KEY = 'garden.handover.v1';
const FRESH_MS = 15_000;

const store = storage => { try { return storage ?? globalThis.localStorage ?? null; } catch { return null; } };

export function handOver(request, { storage = null, now = Date.now() } = {}) {
  const kept = store(storage);
  if (kept === null) return false;
  try { kept.setItem(HANDOVER_KEY, JSON.stringify({ ...request, at: now })); return true; } catch { return false; }
}

export function takeHandover({ storage = null, now = Date.now() } = {}) {
  const kept = store(storage);
  if (kept === null) return null;
  try {
    const raw = kept.getItem(HANDOVER_KEY);
    if (raw === null) return null;
    kept.removeItem(HANDOVER_KEY);
    const request = JSON.parse(raw);
    if (typeof request?.at !== 'number' || now - request.at > FRESH_MS || request.at - now > 1000) return null;
    if (typeof request.open === 'string' || typeof request.plant === 'string' || request.daily === true) return request;
    return null;
  } catch { return null; }
}
