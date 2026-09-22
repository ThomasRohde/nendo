/**
 * What the shell should do with an unsaved form when the session moves underneath it.
 *
 * Separate from {@link ./write-failure} on purpose: that one answers "did the save
 * settle?", this one answers "is the thing I was editing still there?". A save can
 * settle as refused while the file itself has been closed, replaced or dropped to
 * read-only, and the right answer then is neither "carry on typing" nor "throw the
 * typing away".
 */

/**
 * `keep-editable` — the same file, still editable. Nothing about the draft changed.
 *
 * `retain-read-only` — what the user typed is still on screen and must stay there,
 * but it can no longer be saved from this page. Submission is switched off and the
 * reason is said out loud, so the values can be read and copied rather than
 * silently replaced by whatever the host currently holds.
 *
 * `discard` — there is no unsaved input, so the ordinary rebuild is free to happen.
 */
export type DraftOutcome = 'keep-editable' | 'retain-read-only' | 'discard';

export type DraftReason = 'unchanged' | 'no-draft' | 'file-changed' | 'read-only' | 'session-unknown';

/** The part of a session a draft depends on for still being savable. */
export interface DraftSession {
  /** The host's identity for the open file session, or null when no file is open. */
  fileSessionId: string | null;
  /** Whether the host permits ordinary edits. */
  canMutate: boolean;
}

export interface DraftState {
  outcome: DraftOutcome;
  reason: DraftReason;
}

/**
 * Decide what happens to an unsaved form.
 *
 * `current` is null when the session could not be read at all. That is deliberately
 * not treated as "unchanged": not knowing whether editing is still authorised is a
 * reason to stop offering to save, not a reason to assume it is.
 */
export function decideDraftState(
  started: DraftSession,
  current: DraftSession | null,
  hasDraft: boolean,
): DraftState {
  if (!hasDraft) return { outcome: 'discard', reason: 'no-draft' };
  if (current === null) return { outcome: 'retain-read-only', reason: 'session-unknown' };
  // A different file session is a different file, even when it carries the same
  // path: applying values typed against the old one would write one record's input
  // onto whatever now happens to sit at that ID.
  if (current.fileSessionId !== started.fileSessionId) return { outcome: 'retain-read-only', reason: 'file-changed' };
  if (!current.canMutate) return { outcome: 'retain-read-only', reason: 'read-only' };
  return { outcome: 'keep-editable', reason: 'unchanged' };
}

/** What to tell the reader when their draft is retained but can no longer be saved. */
export function draftRetentionMessage(reason: DraftReason): string {
  switch (reason) {
    case 'file-changed':
      return 'This is no longer the file you were editing, so these values cannot be saved here. ' +
        'They are kept on screen so you can copy anything you still need.';
    case 'read-only':
      return 'This file is no longer editable, so these values cannot be saved. ' +
        'They are kept on screen so you can copy anything you still need.';
    case 'session-unknown':
      return 'Nendo could not check whether this file is still editable, so saving is switched off. ' +
        'Nothing you typed has been changed.';
    default:
      return '';
  }
}
