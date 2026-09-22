/**
 * How often a screen may chase the reads it is missing.
 *
 * A surface that draws exact numbers asks for the ones it does not have for the
 * current revision, and redraws when they arrive. That is a loop, and it only
 * terminates because the answers normally land: the next draw finds nothing
 * missing and stops.
 *
 * While an agent is writing, the answers never land. Each read is issued against
 * one change sequence and discarded when the file moves under it, so a draw finds
 * the same tiles missing, asks again, and redraws again — as fast as the host can
 * answer, rebuilding the page every time. That is what stopped the app view: not a
 * leak and not the machine running out of memory, but a redraw loop with nothing to
 * end it, running until WebView2 declared the renderer unresponsive.
 *
 * So the chase is bounded here rather than trusted to end on its own. One pass at a
 * time, at most one a second, and a pass that leaves something unread asks to be
 * woken once instead of immediately. A file being written to continuously then
 * costs one redraw a second, and catches up by itself the moment the writing stops.
 *
 * The sibling path in `refreshDerived` already bounds the same chase, by counting
 * attempts and refusing the third; this is the same rule where the reads are per tile.
 */
export const chaseIntervalMs = 1000;

export interface ChaseClock {
  now(): number;
  later(run: () => void, ms: number): void;
}

const systemClock: ChaseClock = {
  now: () => Date.now(),
  later: (run, ms) => { globalThis.setTimeout(run, ms); },
};

export interface ReadChase {
  /**
   * Runs one pass if one is allowed, and redraws when it finishes. When a pass is
   * already running, or the interval has not elapsed, it starts nothing — and if
   * the caller says work remains, it arranges exactly one later redraw, which is
   * what brings the screen up to date without spinning.
   *
   * `holding` says the person has hold of something a redraw would take away, such
   * as an open menu. Nothing is read and nothing is redrawn while it is true: a
   * screen that rebuilt itself under an open picker closed it before the click
   * landed, which is a worse failure than a number that waits.
   *
   * A pass that finishes while the hold is on is drawn when the hold ends, without the
   * person having to do anything. Waiting is the promise; waiting for ever is not.
   */
  run(
    pass: () => Promise<void>,
    redraw: () => void,
    failed: (error: unknown) => void,
    holding?: () => boolean,
  ): void;
  /** Whether a pass is running now. For tests and for callers that must not stack work. */
  readonly busy: boolean;
}

export function createReadChase(clock: ChaseClock = systemClock): ReadChase {
  let inFlight = false;
  let allowedAt = 0;
  let waking = false;

  /**
   * Asks to be woken once, and draws when the hold is off.
   *
   * A hold has no end the clock knows about, so it is asked again one interval later
   * rather than waited out. And asked is all: a wake-up that redrew while the hold was
   * still on would take the open menu with it, which is the one thing the hold exists to
   * prevent.
   */
  const wakeOnce = (redraw: () => void, holding: (() => boolean) | undefined, delay: number): void => {
    if (waking) return;
    waking = true;
    const wake = (): void => {
      if (holding?.() === true) { clock.later(wake, chaseIntervalMs); return; }
      waking = false;
      redraw();
    };
    clock.later(wake, delay);
  };

  return {
    get busy() { return inFlight; },
    run(pass, redraw, failed, holding) {
      if (inFlight) return;
      const now = clock.now();
      if (holding?.() === true || now < allowedAt) {
        // One wake-up, however many draws happen inside the interval: a draw per
        // keystroke would otherwise queue a timer per keystroke.
        //
        // The wake-up cannot redraw through a hold — the page would rebuild under the
        // pointer once a second for as long as somebody had hold of it, and the picker
        // on the front page could not be used at all.
        wakeOnce(redraw, holding, Math.max(allowedAt - now, holding?.() === true ? chaseIntervalMs : 0));
        return;
      }
      inFlight = true;
      void pass().then(
        () => {
          inFlight = false;
          allowedAt = clock.now() + chaseIntervalMs;
          if (holding?.() !== true) { redraw(); return; }
          // The answers are in hand and the screen is still saying it is waiting for
          // them, so the draw is arranged rather than left to the person.
          //
          // This used to say the next thing they do draws them, and that is exactly what
          // it meant: a read that came back inside the quiet window after a click — which
          // is most of them, because the click is what started it — was stored and never
          // drawn. The owner switched to a matrix, watched a loading tile for thirty
          // seconds, and clicked an empty space to make the whole screen appear.
          wakeOnce(redraw, holding, chaseIntervalMs);
        },
        (error: unknown) => {
          inFlight = false;
          // A failed pass waits the same interval. Failing fast in a loop is the
          // same defect wearing an error message.
          allowedAt = clock.now() + chaseIntervalMs;
          failed(error);
        },
      );
    },
  };
}
