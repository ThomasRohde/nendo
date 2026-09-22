import { state } from './app-state';
import { interactionInProgress, showError } from './shell';

/**
 * Whether the record page on screen is holding typing that a redraw would lose, and
 * the one sentence every move off that page says when it is.
 *
 * Every renderer replaces the content pane, and the draft lives in the DOM it replaces
 * (`main.render` clears `openDraft` for exactly that reason). So anything that redraws
 * on the person's behalf -- another surface, another record type, another record, a
 * page of records, a month, a drill, a command, another view -- declines while there is
 * unsaved typing, in the words the board's drag already uses, rather than saving on the
 * person's behalf so that their next click can proceed. Two moves preserve a draft
 * instead of declining: switching tab and paging a relation, which patch the read-only
 * parts of the page in place and never redraw (`record-form.ts`).
 *
 * "Edited" means different from what is stored, not touched. A field typed into and
 * restored is not an edit, and neither is a reference picker's search box, which sits
 * inside the form but names no field: `wireRecordForm` keeps the set on those terms.
 *
 * Here rather than in `related-actions.ts`, where the guard began, because the reads
 * module needs it for the record pager and is imported by that module: a guard living in
 * a view would close the loop.
 */
export function recordFormIsDirty(): boolean {
  return (state.openDraft?.edited.size ?? 0) > 0;
}

/** Decline a move while there is unsaved typing, and say so. True when declined. */
export function refuseWhileDirty(action: string): boolean {
  if (!recordFormIsDirty()) return false;
  showError(`Save your changes or close record details before ${action}.`);
  return true;
}

/**
 * What a redraw that nobody asked for waits on: the person's hold on the page, or their
 * unsaved typing.
 *
 * The reads a screen chases and the file being followed both redraw when they land, and
 * both already wait while a menu is open or a control is focused. Unsaved typing is the
 * same kind of thing held for the same reason, and it outlasts focus: somebody who typed,
 * clicked elsewhere on the page and paused was redrawn out from under by the next write
 * an agent made, with nothing on screen to say what had gone. The chase asks again each
 * interval, so the redraw lands the moment the draft is saved or closed.
 */
export function holdingThePage(): boolean {
  return interactionInProgress() || recordFormIsDirty();
}
