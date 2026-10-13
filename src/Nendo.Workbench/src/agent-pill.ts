import type { AgentWork } from './host-types';

/**
 * When the status bar's "is working" pill comes up and goes down, without the page, so the timing
 * is measured as it runs (WST-05). shell.ts draws it.
 *
 * A read takes a few milliseconds and there are a lot of them, so reporting every one would leave
 * the corner of the window flickering for the whole of a build. The pill waits as long as the busy
 * bar does, which is what makes it mean "this is taking long enough that you noticed". Going idle
 * is immediate: a stale "still writing" is the one wrong thing this can say.
 *
 * An agent at work is a burst of short calls with gaps between them, not one long one. Hiding on
 * the first gap made the indicator flicker; restarting the countdown on every call meant it never
 * reached its delay, and the whole of an unattended build ran with nothing on screen. Measured
 * against a real build: 27 signals, every one of them under the wait.
 *
 * So one countdown runs from the first sign of work, and when it ends the pill appears for an
 * agent still working or for a burst, and not for one call that is already over: an agent that
 * reads once and goes quiet used to put "is working" up 700 ms after it had stopped, and an agent
 * polling every couple of seconds blinked the pill for the whole session.
 */
export interface PillClock {
  set(run: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface AgentPill {
  /** What the host pushed. */
  signal(work: AgentWork): void;
  /** What is drawn: the last client and activity that were actually running, and whether busy now. */
  readonly work: AgentWork;
  readonly shown: boolean;
}

export function createAgentPill(clock: PillClock, draw: () => void, appearMs: number, idleMs: number): AgentPill {
  let work: AgentWork = { busy: false, client: '', activity: '' };
  let shown = false;
  let appearTimer: number | null = null;
  let hideTimer: number | null = null;
  let callsInWait = 0;

  const hideSoon = (): void => {
    if (hideTimer !== null) return;
    hideTimer = clock.set(() => {
      hideTimer = null;
      shown = false;
      draw();
    }, idleMs);
  };

  return {
    get work() { return work; },
    get shown() { return shown; },
    signal(next) {
      // An idle signal carries no client and no activity -- there is nothing running to name --
      // so taking it whole blanked the pill to "An agent is working" the moment the run ended.
      // What is drawn keeps the last thing that was actually happening; only `busy` comes from
      // every signal.
      work = {
        busy: next.busy,
        client: next.client.length > 0 ? next.client : work.client,
        activity: next.activity.length > 0 ? next.activity : work.activity,
      };
      if (next.busy && hideTimer !== null) { clock.clear(hideTimer); hideTimer = null; }
      if (shown) {
        draw();
        if (!next.busy) hideSoon();
        return;
      }
      if (!next.busy) return;
      callsInWait += 1;
      // One countdown, from the first sign of work. It is neither restarted by the next call nor
      // cancelled by the gap before it: both of those were tried, and both meant a burst of short
      // calls never reached the delay.
      if (appearTimer !== null) return;
      appearTimer = clock.set(() => {
        appearTimer = null;
        const burst = callsInWait > 1;
        callsInWait = 0;
        // One call that finished inside the wait is work that is already over.
        if (!work.busy && !burst) return;
        shown = true;
        draw();
        if (!work.busy) hideSoon();
      }, appearMs);
    },
  };
}
