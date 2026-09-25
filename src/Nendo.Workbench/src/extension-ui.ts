import { openWorkspaceView, refreshDerived } from './actions';
import { focusedRecords, leaveRecordContext, selectedSurfaces, state, surfaceErrors } from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { messageFor } from './format';
import { WorkbenchHostError } from './host';
import { applicationPlans, overviewPlan } from './plan-selection';
import { loadFocusedRecord } from './reads';
import { loadOpenedRecordPanels } from './related-actions';
import { rerender, setBusy, showError, showOutcome } from './shell';
import { useSurfaces } from './surface-model';
import { renderDataRecordDialog } from './view-data';

/**
 * What a custom view may ask the Workbench to do for the person (ADR-0013): open a record, a
 * screen or Studio, and say one sentence. Each is the Workbench's own navigation, under the
 * same rules a click follows: nothing moves while another action is running, and nothing
 * moves while a record page holds unsaved typing. A view is told why when it is refused.
 */

function refuseNow(action: string): void {
  if (state.actionInFlight)
    throw new WorkbenchHostError('busy', 'Nendo is finishing something else. Ask again in a moment.');
  if (refuseWhileDirty(action))
    throw new WorkbenchHostError('not-allowed', 'A record page has unsaved changes, so Nendo stays where it is until they are saved or closed.');
}

/**
 * Open a record. On a Use screen of its record type the record opens beside the view, which
 * keeps running; a record of a type Use does not show opens in Studio's Data view, as a
 * graph's Open record always has.
 */
export async function openRecordFromView(entityId: string, recordId: string): Promise<{ opened: boolean }> {
  refuseNow('opening a record from a custom view');
  const entity = state.session.entities.find((candidate) => candidate.entityId === entityId && candidate.retired !== true);
  if (entity === undefined) throw new WorkbenchHostError('not-found', 'That record type is not in this file.');
  const inUse = state.view === 'use' && applicationPlans().some((plan) => plan.entity.semanticId === entityId);
  const fileSessionId = state.session.fileSessionId;
  state.actionInFlight = true;
  setBusy(true);
  // Said after the redraw, which would otherwise replace the sentence with the page.
  let failure: string | null = null;
  let inStudio = false;
  try {
    await loadFocusedRecord(entityId, recordId);
    if (state.session.fileSessionId !== fileSessionId) failure = 'The file changed while the record was being opened.';
    else if (!focusedRecords.has(recordId)) failure = 'That record is no longer in this file.';
    else if (inUse) {
      state.showOverview = false;
      state.selectedApplicationEntity = entityId;
      leaveRecordContext();
      state.selectedRecordId = recordId;
      await refreshDerived();
      await loadOpenedRecordPanels(recordId);
    } else {
      state.view = 'data';
      state.selectedEntityId = entityId;
      state.creatingRecord = false;
      inStudio = true;
    }
  } catch (error) {
    failure = messageFor(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
  const record = focusedRecords.get(recordId);
  if (failure === null && inStudio && record !== undefined) renderDataRecordDialog(entity, record);
  if (failure !== null) {
    showError(failure);
    return { opened: false };
  }
  return { opened: true };
}

/**
 * Show a screen in Use. A screen is named by its root node's ID, as schema.describe lists it,
 * or by the surface that holds that root; the front page is a screen too.
 */
export async function openScreenFromView(surfaceId: string): Promise<{ opened: boolean }> {
  refuseNow('opening another screen');
  const node = state.session.uiNodes.find((candidate) => candidate.parentNodeId === null &&
    (candidate.nodeId === surfaceId || candidate.surfaceId === surfaceId));
  const rootId = node?.nodeId ?? surfaceId;
  const overview = overviewPlan();
  const front = overview !== null && overview.surface.semanticId === rootId;
  const plan = applicationPlans().find((candidate) => useSurfaces(candidate).some((root) => root.semanticId === rootId));
  if (!front && plan === undefined) throw new WorkbenchHostError('not-found', 'That is not a screen Use can show.');
  if (front) state.showOverview = true;
  else {
    state.showOverview = false;
    state.selectedApplicationEntity = plan!.entity.semanticId;
    selectedSurfaces.set(plan!.entity.semanticId, rootId);
    surfaceErrors.delete(rootId);
  }
  leaveRecordContext();
  state.view = 'use';
  state.actionInFlight = true;
  setBusy(true);
  let failure: string | null = null;
  try {
    await refreshDerived();
  } catch (error) {
    failure = messageFor(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
  }
  if (failure !== null) {
    showError(failure);
    return { opened: false };
  }
  return { opened: true };
}

/** Open Studio's Data view, on one record type when the view names it. */
export async function openStudioFromView(entityId: string | null): Promise<{ opened: boolean }> {
  refuseNow('opening Studio');
  if (entityId !== null) {
    if (!state.session.entities.some((entity) => entity.entityId === entityId))
      throw new WorkbenchHostError('not-found', 'That record type is not in this file.');
    state.selectedEntityId = entityId;
  }
  await openWorkspaceView('data');
  return { opened: state.view === 'data' };
}

/**
 * One sentence from a view, in the Workbench's own outcome line. It carries the view's name,
 * so a sentence from a view is never mistaken for one from Nendo.
 */
export function toastFromView(title: string, text: string): void {
  showOutcome(`${title}: ${text}`);
}
