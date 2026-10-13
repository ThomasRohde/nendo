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

/** What following the file needs from the window; main.ts wires it, and a test can. */
export interface FileFollowParts {
  chase: import('./read-chase').ReadChase;
  /** The file session and change the screen was last drawn from (actions.ts derivedAt). */
  drawnAt(): FollowTarget | null;
  /** Read the session again and rebuild what the screens draw from. */
  pass(): Promise<void>;
  redraw(): void;
  /** A pass failed; `first` is false while the same streak of failures goes on. */
  failed(error: unknown, first: boolean): void;
  /** A pass succeeded after one or more failed. */
  recovered(): void;
  holding(): boolean;
  /** Runs `run` after `ms`; the window's timer unless a test hands its own. */
  later?(run: () => void, ms: number): void;
}

/** The longest a failing follow waits before it asks again. */
export const followRetryCeilingMs = 30_000;

/**
 * Catch the view up with the file, and keep asking until it has (WCS-07).
 *
 * Behind is measured against what the screen was drawn from, not against the session snapshot: a
 * pass adopts the newer snapshot before it rebuilds, so one that failed after that left the screen
 * on the old revision while the snapshot said it was current, and every later nudge for that
 * change was ignored. A failed pass asks again by itself, after one second, then two, four and so
 * on up to thirty, so a host that keeps failing is not read once a second for ever; a new nudge
 * asks at once. Only a pass that read something redraws: a wake-up with nothing new read starts
 * the pass it was waiting for instead of rebuilding the page.
 */
export function createFileFollow(parts: FileFollowParts): { nudge(fileSessionId: string | null, changeSequence: number): void; follow(): void } {
  const later = parts.later ?? ((run: () => void, ms: number) => { globalThis.setTimeout(run, ms); });
  let target: FollowTarget | null = null;
  let failures = 0;
  let passed = false;
  let requested = false;
  const behind = (): boolean => {
    const drawn = parts.drawnAt();
    return target !== null && (drawn === null || stillBehind(target, drawn.fileSessionId, drawn.changeSequence));
  };
  const follow = (): void => {
    requested = true;
    parts.chase.run(
      async () => { requested = false; await parts.pass(); passed = true; },
      () => {
        // Called after a pass and after a wait, which are different things: only a pass has
        // something new to draw, and only a pass ends a streak of failures.
        if (!passed) { if (requested || behind()) follow(); return; }
        passed = false;
        if (failures > 0) { failures = 0; parts.recovered(); }
        parts.redraw();
        if (behind()) follow();
      },
      (error) => {
        parts.failed(error, failures === 0);
        failures += 1;
        const wait = Math.min(1_000 * 2 ** (failures - 1), followRetryCeilingMs);
        later(() => { if (behind()) follow(); }, wait);
      },
      parts.holding,
    );
  };
  return {
    nudge(fileSessionId, changeSequence) {
      // Our own writes already refreshed; only a change ahead of what is drawn is news.
      const drawn = parts.drawnAt();
      if (drawn !== null && drawn.fileSessionId === fileSessionId && drawn.changeSequence >= changeSequence) return;
      target = followTarget(target, fileSessionId, changeSequence);
      follow();
    },
    follow,
  };
}
