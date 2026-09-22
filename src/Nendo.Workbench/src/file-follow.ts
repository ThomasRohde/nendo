/**
 * How far behind the open file a screen is allowed to think it is.
 *
 * The host nudges the renderer with the change sequence it has just committed, and the
 * renderer re-reads until its own session has caught up. That is a loop with one exit:
 * the sequence it read is at least the sequence it was told about.
 *
 * The exit only works while both numbers are about the same file. A change sequence
 * counts the changes to one file and starts at zero in a new one, so a target carried
 * across a file switch is a number the new file may never reach: a planner at 318 is
 * swapped for a reading log at 16, the renderer keeps asking whether 16 is 318 yet, and
 * the answer is no once a second for as long as the file is open. Every screen redraws on
 * each pass, which is what a person sees -- a details pane that flickers, a cell that
 * scrolls back to the top, a record that stops being selected.
 *
 * So a target belongs to a file session, and one from another session is not behind: it
 * is about a file nobody is looking at.
 */
export interface FollowTarget {
  fileSessionId: string | null;
  changeSequence: number;
}

/**
 * The target after a nudge. A nudge about another file session replaces the target
 * rather than raising it, because the two numbers do not compare.
 */
export function followTarget(
  current: FollowTarget | null,
  fileSessionId: string | null,
  changeSequence: number,
): FollowTarget {
  return current !== null && current.fileSessionId === fileSessionId
    ? { fileSessionId, changeSequence: Math.max(current.changeSequence, changeSequence) }
    : { fileSessionId, changeSequence };
}

/** Whether the session named here still owes a read against the target. */
export function stillBehind(
  target: FollowTarget | null,
  fileSessionId: string | null,
  changeSequence: number,
): boolean {
  return target !== null && target.fileSessionId === fileSessionId && changeSequence < target.changeSequence;
}
