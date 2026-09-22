import { isConfirmedRejection } from './pending-mutations';

/**
 * What a caller should do with the view after a write failed.
 *
 * `retain-draft` — the host confirmed the file is unchanged and nothing is in
 * flight. Whatever the user typed is still the best copy of their intent, and it
 * lives in the DOM rather than in application state, so the form must be left
 * standing and only its error display updated. Re-rendering here discards the
 * draft to show values the host already holds.
 *
 * `refresh-view` — the outcome is not settled, or the session may have moved
 * underneath the view. Read the session again and rebuild, which is also what
 * drops a stale file, applies a read-only transition and disables submission.
 */
export type WriteFailureOutcome = 'retain-draft' | 'refresh-view';

/** The host's error code, or an empty string when the failure carries none. */
export function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}

/**
 * Decide between keeping the user's unsaved input and rebuilding the view.
 *
 * A confirmed refusal — a validation error, a version conflict, a retired choice —
 * is the case where rebuilding is both unnecessary and destructive: the file did
 * not move, so the saved values the rebuild would show are the same ones the user
 * was editing away from. Everything else keeps the existing recovery behaviour,
 * because an unknown outcome may mean the write did land.
 *
 * The choice deliberately does not depend on the error message, only on the code
 * the host classified it with.
 */
export function decideWriteFailure(error: unknown): WriteFailureOutcome {
  return isConfirmedRejection(errorCode(error)) ? 'retain-draft' : 'refresh-view';
}
