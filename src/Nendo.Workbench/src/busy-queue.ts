import { state, type OutcomeNotice } from './app-state';

/**
 * A move pressed while an action is still running, made when it ends (WCS-16).
 *
 * The window runs one action at a time, so a press on the rail, Back or Forward or a tab while a
 * save or a read is in flight was dropped without a word: a grid cell saved by the click that
 * blurred it, and the click itself went nowhere, so the person clicked again. The latest such
 * move is held here and made as soon as the action ends; a newer press replaces it.
 *
 * An action that ends in a refusal keeps its sentence on screen instead: the move would take the
 * person away from the only place that says what went wrong, so it is dropped.
 */
let waiting: { move: () => void; saidBefore: OutcomeNotice | null } | null = null;

/** Hold `move` while an action runs. True when it was held, false when nothing is running. */
export function deferWhileBusy(move: () => void): boolean {
  if (!state.actionInFlight) return false;
  waiting = { move, saidBefore: state.lastOutcome };
  return true;
}

/** Whether a move is waiting for the running action. */
export function hasDeferredMove(): boolean {
  return waiting !== null;
}

/** The action ended: make the move that was held, unless another action has started since. */
export function runDeferredMove(): void {
  if (waiting === null || state.actionInFlight) return;
  const held = waiting;
  waiting = null;
  // A refusal said since the press is about the action the person was waiting on.
  const said = state.lastOutcome;
  if (said !== null && said !== held.saidBefore && said.tone === 'alert') return;
  held.move();
}
