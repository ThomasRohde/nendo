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

/**
 * Presses that are never dropped: the switches that turn custom views off, which are how a person
 * gets out of a view that misbehaves (WXS-04). Each is held while an action runs and made when it
 * ends, however that action ended and whatever was pressed since; held as a move, a view's own
 * failing move said an alert first and the switch was dropped.
 */
let kept: Array<() => void> = [];

/** Hold `press` while an action runs, never to be replaced or dropped. True when it was held. */
export function keepWhileBusy(press: () => void): boolean {
  if (!state.actionInFlight) return false;
  kept.push(press);
  return true;
}

/** Whether a move is waiting for the running action. */
export function hasDeferredMove(): boolean {
  return waiting !== null || kept.length > 0;
}

/** The action ended: make the move that was held, unless another action has started since. */
export function runDeferredMove(): void {
  if (state.actionInFlight) return;
  // A kept press first; one that starts an action holds itself again, and the next waits for it.
  if (kept.length > 0) {
    const presses = kept;
    kept = [];
    for (const press of presses) press();
    if (state.actionInFlight) return;
  }
  if (waiting === null) return;
  const held = waiting;
  waiting = null;
  // A refusal said since the press is about the action the person was waiting on.
  const said = state.lastOutcome;
  if (said !== null && said !== held.saidBefore && said.tone === 'alert') return;
  held.move();
}
