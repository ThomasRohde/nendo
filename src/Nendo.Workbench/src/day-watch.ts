import { readDay, untilNextDay } from './record-window';

/** The two timer calls a day watch needs, so a test can hold the clock and the timer. */
export interface DayWatchTimers {
  set(callback: () => void, milliseconds: number): number;
  clear(handle: number | undefined): void;
}

/**
 * Notices the person's civil day turning. Every answer that may say `today` carries the
 * day it was read on, so a new day makes it pending; something has to wake the page to see that.
 *
 * A timer is armed for the next local midnight itself, not a moment after it, so no screen sits
 * on "Loading" with nothing asked for in between; a timer that fires a little early finds the
 * same day and arms again for what is left. A computer asleep at midnight wakes with a timer that
 * may have slept too, so `check` is also called on any key or pointer press and when the window
 * is shown or focused again, and `wake` re-arms the timer after those last two.
 */
export function createDayWatch(onTurn: () => void, timers: DayWatchTimers): { check(): void; wake(): void } {
  let day = readDay();
  let handle: number | undefined;
  const arm = (): void => {
    timers.clear(handle);
    handle = timers.set(() => { check(); arm(); }, untilNextDay());
  };
  const check = (): void => {
    const now = readDay();
    if (now === day) return;
    day = now;
    onTurn();
    arm();
  };
  const wake = (): void => { check(); arm(); };
  return { check, wake };
}
