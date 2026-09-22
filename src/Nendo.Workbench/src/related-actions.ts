import { refreshDerived } from './actions';
import { focusedRecords, leaveRecordContext, state, type CreateRelated } from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { messageFor } from './format';
import type { ApplicationPlan, RecordPlan, SurfaceNodePlan } from './host';
import { refreshVisibleTiles } from './panels';
import { activePlan, applicationPlans, relatedLists } from './plan-selection';
import { loadFocusedRecord, loadRelatedWindows } from './reads';
import { recordFieldDisplay } from './record-markup';
import { content, rerender, setBusy, showError } from './shell';
import { pageRoot } from './surface-model';

/**
 * Adding and opening a record from a related list (ADR-0004, 2026-09-18 amendment).
 *
 * A related list has shown the inverse of a reference since contract version 3 and done
 * nothing else, so recording a linked record meant leaving the page that already knew
 * which record you meant, finding it again in a picker, and navigating back. Nothing is
 * stored for this: the node already names the record type and the field that points back,
 * and the compiler has already proved both are active and aimed at this record type.
 *
 * It lives in its own module because both the view that draws a record page and the patch
 * that redraws a relation in place have to wire the same two buttons, and neither of those
 * may import the other.
 */

/** The record type a related list leads to, when Use can show it. */
export function relatedTargetPlan(targetEntityId: string | null): ApplicationPlan | null {
  return targetEntityId === null
    ? null
    : applicationPlans().find((plan) => plan.entity.semanticId === targetEntityId) ?? null;
}

// Both actions redraw the page, and a redraw discards a form's drafts, so both decline
// while there are unsaved edits: `draft-guard.ts` has the rule and the words. Switching
// tabs and paging a relation still preserve a draft; those patch in place and never redraw.

/**
 * How the record a relation belongs to is named on screen: by the field the reference
 * was configured to label its targets with, which is the field the picker already reads.
 * A stable ID names nothing to a reader, and this is the one place a reference is filled
 * in without anybody having seen the picker.
 */
function parentLabel(targetEntityId: string, viaFieldId: string, record: RecordPlan): string {
  const via = state.session.entities
    .find((entity) => entity.entityId === targetEntityId)?.fields
    .find((field) => field.fieldId === viaFieldId);
  const labelFieldId = via?.reference?.labelFieldId;
  return labelFieldId === undefined ? '(No label)' : String(record.values[labelFieldId] ?? '(No label)');
}

/**
 * How the record being left is named on the way back to it.
 *
 * The field its own page is headed by, where it declares one, and otherwise the first
 * field that page binds — which is how a card and a recent list title themselves, and is
 * right far more often than not, because the first thing on a record page is what the
 * record is. The record type's name is the last resort: "Back to Remit" names the type
 * when four remits are open to go back to, which is no answer at all.
 */
function recordLabel(plan: ApplicationPlan, record: RecordPlan): string {
  const root = pageRoot(plan);
  const declared = root !== null && typeof root.properties.titleFieldId === 'string'
    ? root.properties.titleFieldId
    : null;
  const fieldId = declared ?? (root === null ? null : firstBoundFieldId(root));
  const title = fieldId === null ? '' : recordFieldDisplay(record, fieldId, plan.entity.derivedFields);
  return title || plan.entity.displayName;
}

/** The first field a record page binds, read depth first in authored order. */
function firstBoundFieldId(node: SurfaceNodePlan): string | null {
  for (const child of node.children) {
    if (child.kind === 'fieldBinding' && typeof child.properties.fieldId === 'string') return child.properties.fieldId;
    // A relation binds the fields of another record type, so it is not descended into.
    if (child.kind === 'relatedList') continue;
    const found = firstBoundFieldId(child);
    if (found !== null) return found;
  }
  return null;
}

/** The record in view, whether it was selected from the surface or opened from a relation. */
export function recordInView(plan: ApplicationPlan): RecordPlan | null {
  if (state.selectedRecordId === null) return null;
  return plan.records.find((record) => record.semanticId === state.selectedRecordId)
    ?? focusedRecords.get(state.selectedRecordId)
    ?? null;
}

/**
 * Begin a record of the related type, with the reference back already filled in.
 *
 * The parent's version travels with it because a non-null reference write is refused
 * without the target's current version, and the record it points at is the one on screen.
 * `selectedRecordId` is deliberately left alone: the relation still belongs to the record
 * in view, so closing the form or saving it returns there rather than to an empty pane.
 */
export function beginRelatedCreate(plan: ApplicationPlan, record: RecordPlan, nodeId: string): void {
  if (state.actionInFlight) return;
  const node = relatedLists(plan).find((candidate) => candidate.semanticId === nodeId);
  if (node === undefined) return;
  const targetEntityId = typeof node.properties.targetEntityId === 'string' ? node.properties.targetEntityId : null;
  const viaFieldId = typeof node.properties.viaFieldId === 'string' ? node.properties.viaFieldId : null;
  if (targetEntityId === null || viaFieldId === null || relatedTargetPlan(targetEntityId) === null) return;
  if (refuseWhileDirty('adding a related record')) return;
  state.createRelated = {
    targetEntityId,
    viaFieldId,
    parentRecordId: record.semanticId,
    parentVersion: record.version,
    parentLabel: parentLabel(targetEntityId, viaFieldId, record),
  };
  rerender();
}

/** Abandon the new related record and go back to the page it was started from. */
export function closeRelatedCreate(): void {
  state.createRelated = null;
  rerender();
}

/**
 * Fill in the reference back at the record the relation belongs to, once the form is wired.
 *
 * The hidden input already carries the ID, because the form was built over a seed record
 * holding it. What the markup cannot carry is the target's version, which the picker
 * normally records when somebody selects in it, and the label, which the control normally
 * reads back for a stored value. Both are already in hand here, so both are written rather
 * than read: setting the version also tells the control's own deferred read to leave the
 * label alone.
 */
export function seedRelatedReference(created: CreateRelated): void {
  const root = content.querySelector<HTMLElement>(`#record-form [data-reference-field="${CSS.escape(created.viaFieldId)}"]`);
  if (root === null) return;
  root.dataset.targetVersion = String(created.parentVersion);
  const selected = root.querySelector<HTMLElement>('.reference-selected');
  if (selected === null) return;
  selected.textContent = `${created.parentLabel} · ${created.parentRecordId}`;
  selected.classList.remove('is-unset');
}

/**
 * Open a related row as its own record page, and remember one step back.
 *
 * The record is read by its own ID rather than looked for in whichever page the target
 * type's surface has loaded: a relation is ordered as its author arranged it, so the row
 * that was clicked need not be there at all. The read happens before anything moves, so a
 * record that has gone leaves the person where they were with a sentence about it.
 */
export async function openRelatedRecord(entityId: string, recordId: string): Promise<void> {
  const plan = activePlan();
  if (state.actionInFlight || plan === null || entityId === '') return;
  if (refuseWhileDirty('opening a related record')) return;
  const parent = recordInView(plan);
  const back = parent === null
    ? null
    : { entityId: plan.entity.semanticId, recordId: parent.semanticId, label: recordLabel(plan, parent) };
  state.actionInFlight = true;
  setBusy(true);
  // Held rather than shown. Whatever this says is written into the content pane, and the
  // redraw below replaces it — so a row whose record had gone said so and wiped its own
  // sentence in the same tick, leaving a click that did nothing and explained nothing.
  //
  // And held in a branch rather than behind a return: a `return` inside the try runs the
  // finally and then leaves, and the sentence below the finally was never reached — which
  // was the same click doing nothing and explaining nothing, one fix later (W-051).
  let failure: string | null = null;
  try {
    await loadFocusedRecord(entityId, recordId);
    if (!focusedRecords.has(recordId)) {
      failure = 'That record is no longer there. The related list will show the current records when it is read again.';
    } else {
      state.selectedApplicationEntity = entityId;
      leaveRecordContext();
      state.selectedRecordId = recordId;
      state.returnTo = back;
      await refreshDerived();
      await loadOpenedRecordPanels(recordId);
    }
  } catch (error) {
    failure = messageFor(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
  if (failure !== null) showError(failure);
}

/** Go back to the record a related row was opened from. */
export async function returnFromRelatedRecord(): Promise<void> {
  const back = state.returnTo;
  if (state.actionInFlight || back === null) return;
  if (refuseWhileDirty('going back')) return;
  state.actionInFlight = true;
  setBusy(true);
  // Said after the redraw, for the reason openRelatedRecord gives.
  let failure: string | null = null;
  try {
    state.selectedApplicationEntity = back.entityId;
    leaveRecordContext();
    state.selectedRecordId = back.recordId;
    await refreshDerived();
    // The window the record was originally selected from may have moved on since, so the
    // record is read on its own where the surface no longer carries it.
    const plan = activePlan();
    if (plan !== null && !plan.records.some((record) => record.semanticId === back.recordId))
      await loadFocusedRecord(back.entityId, back.recordId);
    await loadOpenedRecordPanels(back.recordId);
  } catch (error) {
    failure = messageFor(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
  if (failure !== null) showError(failure);
}

/**
 * The relations and totals of the record just arrived at, under the plan it belongs to.
 *
 * Exported because going back through the trail (W-046) arrives at a record page the same
 * way this does, and two copies of the arrival would be two chances to load one of them.
 */
export async function loadOpenedRecordPanels(recordId: string): Promise<void> {
  const plan = activePlan();
  if (plan === null) return;
  await loadRelatedWindows(plan, recordId);
  await refreshVisibleTiles(plan);
}

/**
 * The two buttons a related list carries, wired wherever its markup has just been written.
 *
 * Called from the view that draws a record page and again from the patch that replaces a
 * relation's markup in place, because that patch discards the elements these listeners
 * were attached to.
 */
export function wireRelatedActions(plan: ApplicationPlan, record: RecordPlan): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-related-add]'))
    button.addEventListener('click', () => beginRelatedCreate(plan, record, button.dataset.relatedAdd!));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-related-open]'))
    button.addEventListener('click', () =>
      void openRelatedRecord(button.dataset.relatedEntity ?? '', button.dataset.relatedOpen!));
}
