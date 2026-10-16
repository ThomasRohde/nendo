import type { FileHelpPage } from './help';
import type { OutcomeNotice, ViewName } from './app-state';
import type { ApplicationRecipe } from './application-recipes';
import { client } from './client';
import { confirmDialog } from './confirm-dialog';
import { announce, clearError, content, refreshChrome, requiredElement, rerender, setBusy, showError, showKeptAlert, showOutcome, showRetainedNotice } from './shell';
import { blockedConditionsNotice, escapeHtml, foldDate, isProposalPreviewable, messageFor, mutationKey, valueDisplay } from './format';
import { undoMayAsk, undoQuestion } from './history-markup';
import { byteSize, mediaUsageState, removeUnusedQuestion, type MediaRemovalResult } from './media-usage';
import { proposalRefusal } from './proposal-markup';
import { decideWriteFailure, errorCode, nameHolder, nameTarget, namingFieldId, referenceRefusalCodes, referenceTargetOf } from './write-failure';
import { refuseWhileDirty } from './draft-guard';
import { deferWhileBusy } from './busy-queue';
import { decideDraftState, draftRetentionMessage, type DraftReason } from './draft-state';
import { accumulatorIsCurrent, emptyWindowQuery, readDay, windowIsCurrent, windowRequest, type WindowQuery } from './record-window';
import {
  accumulatedWindows, clearFileScoped, focusedRecords, recordWindows, relatedWindows, state, studioQueries, studioWindows,
  summaryCounts, surfaceErrors, surfaceWindows,
} from './app-state';
import { effectiveSurfaceQuery, recordPlanOf, recordsForEntity, selectedSurfaceNode, sessionEntity } from './plan-selection';
import { openingFileView } from './file-view-model';
import { readsOwnRecords } from './surface-model';
import {
  WorkbenchHostError, type AgentStatus, type CompileResult, type DesktopMutationView, type DesktopOperationView, type DesktopPromotionView,
  type DesktopSessionView, type HelpPagesView, type HistoryFoldPreview, type HistoryFoldResult, type ProposalPreview, type ReadPage, type RecordSnapshot, type RevisionSummary,
  type StoredOperationSnapshot,
} from './host';

/**
 * Everything that changes the file, and everything that re-reads it afterwards.
 *
 * One write path: a mutation is sent, the session it returns is adopted, the
 * derived view is rebuilt from a single coherent revision, and only then is the
 * screen redrawn. A refused save leaves the file alone, so the draft on screen
 * is still the owner's intent and survives; only an unsettled outcome is worth
 * rebuilding the view for.
 */

/**
 * A duplicate refused on a write, said with the record that holds the value named by its label
 * rather than its ID (ADR-0020). Null keeps the host's sentence: no holder, no field to name it
 * by, or a read that failed.
 */
async function holderNamed(error: unknown, payload: Record<string, unknown>): Promise<string | null> {
  if (!(error instanceof WorkbenchHostError) || error.code !== 'value-not-unique' || error.recordId === null ||
    typeof payload.entityId !== 'string') return null;
  const fieldId = namingFieldId(state.session.entities, payload.entityId);
  if (fieldId === null) return null;
  try {
    const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', { entityId: payload.entityId, recordId: error.recordId, limit: 1 });
    const holder = page.items[0];
    return holder === undefined ? null : nameHolder(error.message, error.recordId, valueDisplay(holder.values[fieldId]));
  } catch {
    return null;
  }
}

/**
 * A reference refusal said with the record it points at named by its label rather than its ID
 * (R2AP-07). Null keeps the host's sentence: no target named, a target that does not exist, or a
 * read that failed.
 */
async function targetNamed(error: unknown, payload: Record<string, unknown>): Promise<string | null> {
  if (!(error instanceof WorkbenchHostError) || !referenceRefusalCodes.includes(error.code) || error.recordId === null) return null;
  const target = referenceTargetOf(state.session.entities, payload, error.recordId);
  if (target === null) return null;
  try {
    const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', { entityId: target.targetEntityId, recordId: error.recordId, limit: 1 });
    const record = page.items[0];
    return record === undefined ? null : nameTarget(error.message, error.recordId, valueDisplay(record.values[target.labelFieldId]));
  } catch {
    return null;
  }
}

/**
 * <paramref name="restate" /> replaces the host's refusal with one the caller's screen can
 * act on, for the cases where the host's own words name a remedy that screen does not have.
 * It answers null to keep the host's message, which is what everything else does: the
 * host's wording is right far more often than not, and this is a deliberate exception
 * rather than a translation layer.
 */
/**
 * What became of a change: saved; refused with the screen left as it was, which keeps a
 * record form's draft; or refused with the view read again.
 */
export type MutationOutcome = 'saved' | 'kept' | 'redrawn' | 'busy';

export async function runMutation(
  method: string,
  payload: Record<string, unknown>,
  success: string,
  refreshAfterFailure = false,
  beforeRender?: () => void,
  restate?: (error: unknown) => string | null,
  next?: OutcomeNotice['action'],
): Promise<MutationOutcome> {
  if (state.actionInFlight) return 'busy';
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<DesktopMutationView>(method, payload);
    if (result.session !== null) state.session = result.session;
    beforeRender?.();
    const notice = await refreshAfterOutcome(result);
    rerender();
    // Drawn as well as announced: a hidden live region told a screen reader and nobody else
    // that a save, an add, a delete or a command had worked (UX-04). An action a condition
    // blocked is said in the tone of an alert and kept until the next action, since what it
    // keeps is now stale; it does not take the focus, and it keeps the success's next step.
    const blocked = blockedConditionsNotice(result.mutation.blockedConditions);
    const outcome = blocked === null ? success : `${success} ${blocked}`;
    if (notice !== null) showOutcomeRefreshNotice(outcome, notice);
    else if (blocked !== null) showKeptAlert(outcome, next);
    else showOutcome(success, next);
    return 'saved';
  } catch (error) {
    // A confirmed refusal leaves the file unchanged, so the form's draft is still
    // the user's current intent and must survive. Only an unsettled outcome is
    // worth rebuilding the view for, and then exactly once: recoverAfterWriteFailure
    // renders on its own.
    const redrawn = decideWriteFailure(error) === 'refresh-view';
    if (redrawn) {
      if (refreshAfterFailure) await recoverAfterWriteFailure();
      else rerender();
    }
    const said = restate?.(error) ?? await holderNamed(error, payload) ?? await targetNamed(error, payload);
    if (said !== null) showError(said); else showFailure(error);
    return redrawn ? 'redrawn' : 'kept';
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function refreshAfterOutcome(result: DesktopMutationView | DesktopPromotionView): Promise<string | null> {
  try {
    if (result.session === null) state.session = await client.request<DesktopSessionView>('session.getSnapshot');
    await refreshDerived();
    return null;
  } catch {
    return result.refreshNotice ?? 'Refresh the view to see the current file state.';
  }
}

/**
 * Codes whose sentence asks the person to refresh the view: the file session ended, or the file
 * kept moving while it was read. They said "Refresh the view" with nothing to press, and the
 * refresh a person reaches for, F5, reloaded the whole window and lost drafts, tabs and the trail
 * (WCS-08). They carry a Refresh view button now, and F5 is that refresh.
 */
const refreshableCodes = new Set(['stale-file-session', 'view-changed']);

/** A failure said where it can be seen; one that asks for a refresh carries the Refresh view button. */
export function showFailure(error: unknown, takeFocus = true): void {
  if (!refreshableCodes.has(errorCode(error))) {
    // A read nobody pressed for says it failed without moving anybody (WCS-07).
    if (takeFocus) showError(messageFor(error)); else showKeptAlert(messageFor(error));
    return;
  }
  showRetainedNotice(messageFor(error), async (button) => {
    if (state.actionInFlight) return;
    // Busy with the rest of the window, and released with it: the redraw inside held every
    // control disabled and the bar on "Still working..." for good when only the flag was set.
    state.actionInFlight = true;
    setBusy(true);
    button.disabled = true;
    try {
      await reloadReadWindows();
      state.lastOutcome = null;
      rerender();
      announce('The view shows the file as it is now.');
    } catch (refreshError) {
      button.disabled = false;
      announce(`${messageFor(refreshError)} Try Refresh view again.`);
    } finally { state.actionInFlight = false; setBusy(false); }
  }, takeFocus);
}

/**
 * Read the open file again and redraw, as Refresh view does: F5 and Ctrl R (WCS-08). A page
 * holding unsaved typing refuses, as every other redraw on the person's behalf does.
 */
export async function refreshView(): Promise<void> {
  if (client.mode === 'unavailable' || !state.session.hasFile) return;
  if (deferWhileBusy(() => { void refreshView(); })) return;
  if (refuseWhileDirty('refreshing the view')) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    await reloadReadWindows();
    rerender();
    announce('The view shows the file as it is now.');
  } catch (error) {
    showFailure(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export function showOutcomeRefreshNotice(outcome: string, notice: string): void {
  showRetainedNotice(`${outcome} ${notice}`, async (refresh) => {
    if (state.actionInFlight) return;
    state.actionInFlight = true;
    setBusy(true);
    refresh.disabled = true;
    try {
      state.session = await client.request<DesktopSessionView>('session.getSnapshot');
      await refreshDerived();
      // The refresh the notice asked for has happened; a redraw must not bring it back.
      state.lastOutcome = null;
      rerender();
      announce(outcome);
    } catch {
      refresh.disabled = false;
      announce(`${outcome} The view is still unavailable. Try Refresh view again.`);
    } finally { state.actionInFlight = false; setBusy(false); }
  });
}

export function resetFileView(): void {
  state.agentScreenPreview = null;
  state.selectedApplicationEntity = null;
  // Another file: which screen Use opens on is settled again when its definition
  // arrives. This is why it is not decided at one call site — a file is opened
  // from the File menu, from Recent, after a restore and on startup, and only one
  // of those was the startup path.
  state.showOverview = null;
  state.fileView = null;
  state.proposal = null;
  state.agentProposal = null;
  state.compilation = null;
  state.history = [];
  state.historyWindow = null;
  state.historyFold = null;
  // Every window, total, chart, tab and remembered choice belongs to the file that was
  // open, and each registers itself as file-scoped where it is declared. A reply still in
  // flight for the previous file is discarded by the generation.
  clearFileScoped();
  state.summaryGeneration += 1;
  state.agentStatus = null;
  state.selectedRecordId = null;
  state.selectedEntityId = null;
  state.creatingRecord = false;
  state.createRelated = null;
  state.returnTo = null;
  state.view = state.session.fileName !== null && !state.session.capabilities.mutate ? 'health' : 'data';
  requiredElement<HTMLElement>('#file-notice').hidden = true;
}

export async function reloadReadWindows(): Promise<void> {
  const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
  const changed = refreshed.fileSessionId !== state.session.fileSessionId;
  state.session = refreshed;
  if (changed) resetFileView();
  await refreshDerived();
}

export async function handlePageFailure(error: unknown): Promise<void> {
  if (error instanceof WorkbenchHostError && error.code === 'stale-cursor') {
    if (state.view === 'data') {
      // Kept with its button across redraws, and only while the results are the earlier query's:
      // the button was added to the slot by hand, so the next redraw put the sentence back without
      // it, and the sentence stayed after a redraw had already read the current records (WCS-24).
      showKeptAlert('The file changed. These results are from the earlier query. Restart to see the current records.', {
        label: 'Restart query',
        run: async () => {
          if (state.actionInFlight) return;
          state.actionInFlight = true; setBusy(true);
          clearError();
          try { await reloadReadWindows(); rerender(); announce('Showing the first page of current records.'); }
          catch (refreshError) { showFailure(refreshError); }
          finally { state.actionInFlight = false; setBusy(false); }
        },
      });
      if (state.lastOutcome !== null) state.lastOutcome.changeSequence = state.session.manifest?.changeSequence ?? undefined;
      return;
    }
    try {
      await reloadReadWindows();
      rerender();
      announce('The file changed. Showing the first page again.');
    } catch (refreshError) { showError(messageFor(refreshError)); }
  } else showError(messageFor(error));
}

/**
 * The compiled definition of the last refresh, and the revision it was compiled at. A move
 * between screens reuses it while the file has not moved (review R-014); every other refresh,
 * after a write, an acceptance or a setting, compiles again.
 */
let compiled: { key: string; definition: CompileResult | null } | null = null;

/**
 * The file session and change the derived state was last committed at (WCS-07). The session
 * snapshot moves before the derived state is rebuilt, so a refresh that failed after adopting a
 * newer snapshot left the screen on the old revision while every later nudge for that change was
 * taken as already seen. Following the file compares against this instead.
 */
let derived: { fileSessionId: string | null; changeSequence: number } | null = null;

export function derivedAt(): { fileSessionId: string | null; changeSequence: number } | null {
  return derived;
}

export interface RefreshOptions {
  /** A move between screens: reuse the definition compiled at this revision, if there is one. */
  navigation?: boolean;
}

/**
 * Rebuild what the screens draw from, from one revision. The History page and the Agent page
 * read what only they show when they are the screen (review R-014): a move elsewhere reads
 * neither, and opening either reads it then.
 */
export async function refreshDerived(attempt = 0, options: RefreshOptions = {}): Promise<void> {
  if (!state.session.hasFile) {
    compiled = null;
    derived = null;
    state.compilation = null;
    state.history = [];
    state.historyWindow = null;
    recordWindows.clear();
    relatedWindows.clear();
    surfaceWindows.clear();
    summaryCounts.clear();
    state.agentStatus = null;
    return;
  }
  const generation = state.session.fileSessionId;
  const sequence = state.session.manifest?.changeSequence;
  const compileKey = `${generation}:${sequence}:${state.session.capabilities.customSurfaces}`;
  const reuse = options.navigation === true && sequence !== undefined && compiled?.key === compileKey ? compiled : null;
  const onHistory = state.view === 'history', onAgent = state.view === 'agent' || state.view === 'agentProposal';
  const [definition, revisions, status] = await Promise.all([
    reuse !== null ? Promise.resolve(reuse.definition)
      : state.session.capabilities.customSurfaces ? client.request<CompileResult>('semantic.compile') : Promise.resolve(null),
    onHistory && state.session.capabilities.readHistory ? client.request<ReadPage<RevisionSummary>>('history.query', { limit: 50 }) : Promise.resolve(null),
    onAgent ? client.request<AgentStatus>('agent.getStatus') : Promise.resolve(state.agentStatus),
  ]);
  const applicationEntity =
    (definition?.applications?.find(app => app.entity.semanticId === state.selectedApplicationEntity) ?? definition?.applications?.[0])?.entity.semanticId;
  // A fresh file chooses its Use landing screen after compilation. Seed that screen once;
  // an already-open Studio table owns its own blocks instead.
  const studioOwnsReads = state.view === 'data' && state.compilation !== null;
  const entityIds = state.session.capabilities.readData ? [...new Set(studioOwnsReads ? [] : [sessionEntity()?.entityId, applicationEntity]
    .filter((id): id is string => id !== undefined))] : [];
  const browseQuery = emptyWindowQuery();
  const pages = await Promise.all(entityIds.map(async entityId => ({ entityId, request: JSON.stringify(windowRequest(entityId, browseQuery)),
    page: await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', windowRequest(entityId, browseQuery)) })));

  // Only the selected surface is read. An unselected one keeps whatever window it
  // already had for this revision and is reloaded lazily when it is chosen.
  const surfacePlan = (definition?.applications ?? []).find(app => app.entity.semanticId === applicationEntity) ?? null;
  const surfaceNode = surfacePlan === null ? null : selectedSurfaceNode(surfacePlan);
  // A calendar or a timeline reads its own bounded pages when it renders, so
  // the shared refresh must not open an unbounded window for one.
  // The query the screen opened under, a drill or a Filter pick included: the declared one alone
  // put records back on a narrowed screen after every write (W-172).
  const surfaceDay = readDay();
  const declared = studioOwnsReads || surfaceNode === null || readsOwnRecords(surfaceNode.kind) || applicationEntity === undefined
    ? null
    : effectiveSurfaceQuery(applicationEntity, surfaceNode);
  // A screen that asks for exactly what the browse window read takes that page rather than reading it twice.
  const surfaceRequest = surfaceNode === null || declared === null || applicationEntity === undefined ? null : windowRequest(applicationEntity, declared);
  const surfacePage = surfaceRequest === null ? null
    : pages.find(value => value.request === JSON.stringify(surfaceRequest))?.page
      ?? await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', surfaceRequest);
  if (state.session.fileSessionId !== generation ||
      (definition?.sourceChangeSequence != null && definition.sourceChangeSequence !== sequence) ||
      (revisions !== null && revisions.changeSequence !== sequence) || pages.some(value => value.page.changeSequence !== sequence) ||
      (surfacePage !== null && surfacePage.changeSequence !== sequence)) {
    if (attempt >= 2) throw new WorkbenchHostError('view-changed', 'The file is changing. Refresh the view when the current changes finish.');
    const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
    const changed = refreshed.fileSessionId !== state.session.fileSessionId;
    state.session = refreshed;
    if (changed) resetFileView();
    await refreshDerived(attempt + 1, options);
    return;
  }
  state.compilation = definition;
  compiled = { key: compileKey, definition };
  derived = { fileSessionId: generation, changeSequence: sequence ?? 0 };
  // The file's definition is known now, so the screen Use opens on is settled:
  // a file with a front page opens on it, and one without opens on a record type
  // exactly as it did. Already answered for this file, it stays as the person
  // last left it.
  // A view of the file that says opensFile comes first, where custom views run (W-106).
  if (state.showOverview === null) {
    state.fileView = openingFileView(definition, state.session.extensions);
    state.showOverview = state.fileView === null && definition?.isValid === true && (definition.overview ?? null) !== null;
  }
  // Away from History its page is not kept: opening History reads it at that moment.
  state.history = revisions?.items ?? [];
  state.historyWindow = revisions === null ? null : { page: revisions, cursors: [null], index: 0 };
  state.agentStatus = status;
  recordWindows.clear();
  relatedWindows.clear();
  for (const value of pages)
    recordWindows.set(value.entityId, { page: value.page, cursors: [null], index: 0, query: browseQuery });
  // Every surface window this revision invalidated goes, including the ones not
  // in view; a stale page is never left behind for a later selection to show.
  for (const [surfaceId, window] of [...surfaceWindows])
    if (!windowIsCurrent(window, sequence)) surfaceWindows.delete(surfaceId);
  // A calendar's or a timeline's accumulated pages are one snapshot of a range.
  // Keeping them across a revision would either duplicate a record or mix two
  // snapshots.
  for (const [key, accumulated] of [...accumulatedWindows])
    if (!accumulatorIsCurrent(accumulated, sequence)) accumulatedWindows.delete(key);
  surfaceErrors.clear();
  if (surfacePage !== null && surfaceNode !== null && declared !== null)
    surfaceWindows.set(surfaceNode.semanticId, { page: surfacePage, cursors: [null], index: 0, query: declared, day: surfaceDay });
  studioWindows.clear();
  if (state.selectedEntityId && studioQueries.has(state.selectedEntityId)) await refreshStudioQuery(state.selectedEntityId);
  const records = applicationEntity
    ? recordsForEntity(applicationEntity, surfaceNode?.semanticId ?? null)
    : [];
  // A record opened from a related row is in no window here. It was read on its own
  // because a relation is ordered as its author arranged it, so the row somebody clicked
  // need not be on the page the surface has loaded — and it is re-read here for the same
  // reason every window above is, or saving from its page would empty the page.
  if (state.selectedRecordId !== null && applicationEntity !== undefined &&
      focusedRecords.has(state.selectedRecordId) &&
      !records.some((record) => record.semanticId === state.selectedRecordId)) {
    const focused = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords',
      { entityId: applicationEntity, recordId: state.selectedRecordId, limit: 1 });
    const found = focused.items[0];
    if (found === undefined) focusedRecords.delete(state.selectedRecordId);
    else focusedRecords.set(state.selectedRecordId, recordPlanOf(found));
  }
  // A selection the view no longer holds is dropped. A focused record is held, which is
  // what makes it a selection at all.
  if (state.selectedRecordId !== null && !records.some((record) => record.semanticId === state.selectedRecordId) &&
      !focusedRecords.has(state.selectedRecordId)) state.selectedRecordId = null;
}

export async function openWorkspaceView(target: 'use' | 'data' | 'structure' | 'surfaces' | 'history'): Promise<void> {
  // A press while a save or a read runs is made when it ends, rather than dropped (WCS-16).
  if (deferWhileBusy(() => { void openWorkspaceView(target); })) return;
  // Another view is a redraw, and a redraw is the open form's unsaved typing gone.
  if (refuseWhileDirty('leaving this screen')) return;
  state.actionInFlight = true;
  setBusy(true);
  const leaving = state.view;
  let fileChanged = false;
  try {
    // MCP writes use the same live host but do not pass through this renderer's
    // mutation receipts. Navigation is an explicit refresh boundary, so cached
    // empty record windows or old definitions cannot hide accepted agent work.
    const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
    const changed = refreshed.fileSessionId !== state.session.fileSessionId;
    fileChanged = changed;
    state.session = refreshed;
    if (changed) resetFileView();
    state.view = target;
    state.creatingRecord = false;
    await refreshDerived(0, { navigation: true });
    rerender();
  } catch (error) {
    // The screen still shows where the person was, so the state says so too: it named the new
    // screen under the old one's page and rail, and the next automatic redraw swapped (WCS-18).
    // Another file is another screen anyway, and is drawn.
    if (fileChanged) rerender(); else state.view = leaving;
    showFailure(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/**
 * Re-read the session after a save whose outcome was not settled.
 *
 * The ordinary path rebuilds the view from what the host now holds. That is right
 * until there is unsaved input on screen and the file has moved underneath it: a
 * rebuild then replaces the user's typing with saved values, and — after a file
 * switch — with a different file's saved values. So the draft decides first, and a
 * retained draft is locked rather than rebuilt.
 */
export async function recoverAfterWriteFailure(): Promise<void> {
  const draft = state.openDraft;
  let refreshed: DesktopSessionView | null = null;
  try {
    refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
  } catch {
    // The host itself is unreachable. Keeping the last coherent view is right; what
    // is not right is leaving a Save button that claims an authority nobody checked.
  }
  const draftState = state.retainedDraft !== null
    ? { outcome: 'retain-read-only', reason: state.retainedDraft.reason }
    : draft === null
    ? null
    : decideDraftState(
      draft.session,
      refreshed === null ? null : { fileSessionId: refreshed.fileSessionId, canMutate: refreshed.capabilities.mutate },
      draft.edited.size > 0);
  if (refreshed === null) {
    if (draftState?.outcome === 'retain-read-only') retainDraftReadOnly(draftState.reason);
    return;
  }
  const changed = state.session.fileSessionId !== refreshed.fileSessionId;
  state.session = refreshed;
  if (changed) resetFileView();
  if (draftState?.outcome === 'retain-read-only') {
    // The shell chrome still follows the session, so the reader can leave this page
    // whenever they are done with the values it is holding.
    refreshChrome();
    retainDraftReadOnly(draftState.reason);
    return;
  }
  await refreshDerived();
  rerender();
}

export function retainDraftReadOnly(reason: DraftReason): void {
  // Editable input and retained display input have different departure rules. The
  // latter may be left deliberately, but autonomous chases must hold it even once
  // focus has moved to a blank area of the page.
  state.retainedDraft ??= Object.freeze({ reason });
  state.openDraft = null;
  for (const control of content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    '#record-form input, #record-form select, #record-form textarea, #record-form button, #record-form [data-action]')) {
    control.disabled = true;
    // setBusy stamped each control with the state to restore when the request
    // finishes, and this runs inside that request. Restating it keeps the release
    // from handing the Save button back a moment later.
    control.dataset.busyWasDisabled = 'true';
  }
  showError(draftRetentionMessage(state.retainedDraft.reason));
}

/**
 * Folds the file's older history into a checkpoint (ADR-0021), after the person has read what
 * that gives up. The host makes the backup first; the answer names it.
 */
export async function foldHistory(): Promise<void> {
  const preview = state.historyFold?.preview;
  if (state.actionInFlight || preview === undefined || !preview.canFold) return;
  if (!(await confirmFold(preview))) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<HistoryFoldResult>('history.fold', {});
    state.session = await client.request<DesktopSessionView>('session.getSnapshot');
    state.historyFold = null;
    // A fold can leave pictures only folded history named.
    mediaUsageState.key = null;
    await refreshDerived();
    rerender();
    showOutcome(`Folded ${result.revisions.toLocaleString()} older changes into one checkpoint. ${result.operationRowsAfter.toLocaleString()} of ${preview.operationCeiling.toLocaleString()} changes are now recorded. The full history is in ${result.backupLabel}, beside the file.`);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/**
 * Builds the file's search index, or builds it again from the records (ADR-0028). It changes no
 * record; from then on every save keeps the index current. Answers whether it was built.
 */
export async function buildSearchIndex(): Promise<boolean> {
  if (state.actionInFlight) return false;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    await client.request('data.buildSearchIndex', { idempotencyKey: `search-index-${crypto.randomUUID()}` });
    state.session = await client.request<DesktopSessionView>('session.getSnapshot');
    await refreshDerived();
    rerender();
    showOutcome('This file can now be searched by any word in its records. Nendo keeps the search index current from now on.');
    return true;
  } catch (error) {
    showError(messageFor(error));
    return false;
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/**
 * Removes the pictures nothing names any more, then compacts the file (ADR-0031 point 8, W-273),
 * after the person has read what that does. The host makes the backup first; the answer names it.
 */
export async function removeUnusedPictures(): Promise<void> {
  const usage = mediaUsageState.usage;
  if (state.actionInFlight || usage === null || usage.unusedCount === 0) return;
  if (!(await confirmDialog(removeUnusedQuestion(usage)))) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<MediaRemovalResult>('media.removeUnused', {});
    state.session = await client.request<DesktopSessionView>('session.getSnapshot');
    mediaUsageState.key = null;
    await refreshDerived();
    rerender();
    showOutcome(`Removed ${result.removed.toLocaleString()} unused ${result.removed === 1 ? 'picture' : 'pictures'}, ${byteSize(result.removedBytes)}. ${result.spaceReclaimed
      ? `The file went from ${byteSize(result.fileBytesBefore)} to ${byteSize(result.fileBytesAfter)}.`
      : 'The file could not be made smaller now; it will be when there is room on the disk.'} Every picture is in ${result.backupLabel}, beside the file.`);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

function confirmFold(preview: HistoryFoldPreview): Promise<boolean> {
  const day = (value: string | null) => value === null ? '' : foldDate(value);
  return confirmDialog({
    headingId: 'fold-heading',
    title: 'Fold older history?',
    bodyHtml: `
      <p>${preview.revisions.toLocaleString()} changes from ${escapeHtml(day(preview.firstAt))} to ${escapeHtml(day(preview.lastAt))}
      become one checkpoint in History. The most recent ${preview.keep.toLocaleString()} changes stay as they are, and so does every record.</p>
      <p>First Nendo saves a backup beside this file, with the whole history in it. After the fold, a folded change
      cannot be undone or inspected here; open the backup to see it.</p>`,
    confirmLabel: 'Back up and fold',
  });
}

let undoAsking = false;
const undoBusy = 'Wait for the current action to finish, then try again.';

export async function compensateRevision(revisionId: string): Promise<void> {
  // A second press while the question is read or open is the same undo asked twice.
  if (state.actionInFlight || undoAsking) { showError(undoBusy); return; }
  // A multi-record batch, a definition or a package is named and its effect said before it is
  // undone; one record's edit stays one press (WSP-05, accepted 2026-10-13).
  const revision = state.history.find(item => item.revisionId === revisionId);
  if (revision !== undefined && undoMayAsk(revision)) {
    undoAsking = true;
    try {
      let operations: StoredOperationSnapshot[] = [];
      let more = false;
      try {
        const page = await client.request<ReadPage<StoredOperationSnapshot>>('history.operations', { revisionId, limit: 50, cursor: null });
        operations = page.items;
        more = page.nextCursor !== null;
      } catch { more = true; /* Asked on what the entry itself says. */ }
      const question = undoQuestion(revision, operations, more);
      if (question !== null && !(await confirmDialog(question))) return;
    } finally { undoAsking = false; }
  }
  const outcome = await runMutation('history.compensate', { revisionId, idempotencyKey: mutationKey() }, 'Undone. History lists the undo as a new change.', true);
  // Another action began while the question was open: the undo was not sent, and that is said.
  if (outcome === 'busy') showError(`${undoBusy} Nothing was undone.`);
}

export async function retryPendingSave(): Promise<void> {
  if (client.retryPendingMutation === undefined) return;
  await settlePendingSave(() => client.retryPendingMutation!(), null);
}

/**
 * Drop a save the person stopped, without sending it (WCS-22). Offered only once the host has
 * answered the stop and a receipt check found nothing; the receipt is checked again first, and a
 * save that landed after all is confirmed rather than dropped.
 */
export async function discardPendingSave(): Promise<void> {
  if (client.discardPendingMutation === undefined) return;
  await settlePendingSave(() => client.discardPendingMutation!(), 'The stopped change was discarded. Nothing of it was saved.');
}

/**
 * Send a save made under another file name into the file open now, after the person has said this
 * file is that one renamed (WCS-03). The receipt is looked up first, as Check or retry does.
 */
export async function sendPendingSaveHere(): Promise<void> {
  if (client.retryPendingMutation === undefined) return;
  const pending = client.pendingMutation?.() ?? null;
  const confirmed = await confirmDialog({
    headingId: 'send-pending-heading',
    title: 'Send the save into this file?',
    bodyHtml: `<p>The unconfirmed save was made in ${escapeHtml(pending?.fileName ?? 'another file')}, and the file open now is
      ${escapeHtml(state.session.fileName ?? 'this file')}. Send it here only if this is that file under a new name.</p>
      <p>If this is a copy or a backup of it, discard the save here instead and open the original to check it.</p>`,
    confirmLabel: 'Send it into this file',
  });
  if (!confirmed) return;
  await settlePendingSave(() => client.retryPendingMutation!(true), null);
}

/** Drop a save made in another file from this device, after the person has confirmed it (WCS-03). */
export async function discardPendingSaveHere(): Promise<void> {
  if (client.discardPendingMutation === undefined) return;
  const pending = client.pendingMutation?.() ?? null;
  const confirmed = await confirmDialog({
    headingId: 'discard-pending-heading',
    title: 'Discard the unconfirmed save?',
    bodyHtml: `<p>The save was made in ${escapeHtml(pending?.fileName ?? 'another file')} and never confirmed. Nendo looks for it in this
      file first; if it is not here, this device forgets it, and ${escapeHtml(pending?.fileName ?? 'that file')} can no longer be checked for it from here.</p>`,
    confirmLabel: 'Discard it',
  });
  if (!confirmed) return;
  await settlePendingSave(() => client.discardPendingMutation!(), 'The unconfirmed save was discarded on this device. Nothing was sent.');
}

async function settlePendingSave(settle: () => Promise<DesktopOperationView | null>, whenNothing: string | null): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const result = await settle();
    if (result !== null) {
      if (result.session !== null) state.session = result.session;
      if ('promotion' in result && !result.promotion.applied) {
        try {
          state.proposal = await client.request<ProposalPreview>('proposal.get', { proposalId: result.promotion.proposalId });
          state.agentProposal = null;
          state.view = 'proposal';
        } catch { /* A closed proposal need not have a derivative review. */ }
        rerender();
        showError(result.promotion.message);
        return;
      }
      if ('promotion' in result) {
        state.proposal = null;
        state.agentProposal = null;
        if (state.view === 'proposal' || state.view === 'agentProposal') state.view = 'use';
      }
      const confirmed = 'promotion' in result ? 'Proposal acceptance confirmed.' : 'Previous save confirmed.';
      const notice = await refreshAfterOutcome(result);
      rerender();
      if (notice !== null) showOutcomeRefreshNotice(confirmed, notice);
      else showOutcome(confirmed);
    } else {
      rerender();
      if (whenNothing !== null) showOutcome(whenNothing);
    }
  } catch (error) {
    rerender();
    showFailure(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function refreshStudioQuery(entityId: string): Promise<void> {
  if (state.view === 'data') return; // The grid owns bounded reads of the Studio query.
  const studio = studioQueries.get(entityId);
  if (!studio) return;
  const query: WindowQuery = {
    filters: studio.filters,
    sortFieldId: studio.sortFieldId ?? undefined,
    descending: studio.descending ? true : undefined,
  };
  const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', windowRequest(entityId, query));
  if (page.changeSequence !== state.session.manifest?.changeSequence) throw new WorkbenchHostError('stale-cursor', 'The file changed. Restart the query.');
  studioWindows.set(entityId, { page, cursors: [null], index: 0, query });
}

/** Help on a topic, or with none named on the open file's own first page, where it has one (ADR-0027). */
export async function openHelp(topicId = ''): Promise<void> {
  // A press while a save or a read runs is made when it ends (WCS-16).
  if (deferWhileBusy(() => { void openHelp(topicId); })) return;
  if (refuseWhileDirty('opening Help')) return;
  state.helpTopicId = topicId; state.view = 'help'; state.creatingRecord = false;
  rerender();
  const opening = ++helpOpenings;
  // What the first draw settled on, so a topic picked while the file was read is left alone.
  const settled = state.helpTopicId;
  if (client.mode === 'desktop' && !state.actionInFlight) {
    state.actionInFlight = true;
    setBusy(true);
    try { state.session = await client.request<DesktopSessionView>('session.getSnapshot'); await refreshDerived(); }
    catch { /* Built-in guidance remains available if the file cannot refresh. */ }
    finally { state.actionInFlight = false; setBusy(false); }
  }
  const pages = await readHelpPages();
  // Opened again since, or left: the answer belongs to a page that is not on screen, and a redraw
  // would land on whatever is, a record form included (WCS-11).
  if (opening !== helpOpenings || state.view !== 'help') { if (opening === helpOpenings) state.helpPages = pages; return; }
  state.helpPages = pages;
  // The first render, before the pages arrived, settled on Start: with no topic named, choose again
  // now they are here -- unless the person has picked one meanwhile.
  if (topicId === '' && state.helpTopicId === settled) state.helpTopicId = '';
  rerender();
}

let helpOpenings = 0;

/** The open file's help pages; none without a file, or from a host that has no such read. */
async function readHelpPages(): Promise<FileHelpPage[]> {
  if (client.mode === 'unavailable' || !state.session.hasFile) return [];
  try { return (await client.request<HelpPagesView>('help.readPages')).pages; }
  catch { return []; }
}

/**
 * Prepares a Studio change as a proposal and opens its review. Answers whether the review opened.
 *
 * A press while another action runs says so: it was dropped without a word, and a column rename
 * typed into its header stayed a box nothing answered (WSP-18). A change the host refuses on its
 * copy of the file is rejected there and said in the form it came from, which keeps what was
 * typed: it opened a review nothing could accept, whose Back lost the form (WSP-19).
 */
export async function prepareApplication(recipe: ApplicationRecipe, returnView: ViewName): Promise<boolean> {
  if (state.actionInFlight) { showError('Wait for the current action to finish, then try again.'); return false; }
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const payload = recipe.prepare === undefined ? recipe.proposalPayload
      : await recipe.prepare(query => client.request<ReadPage<RecordSnapshot>>('data.queryRecords', query));
    const preview = await client.request<ProposalPreview>('proposal.prepareChangeSet', payload);
    if (!isProposalPreviewable(preview.state)) {
      try { await client.request('proposal.reject', { proposalId: preview.proposalId }); } catch { /* The refusal is what is said. */ }
      showError(proposalRefusal(preview));
      return false;
    }
    state.proposal = preview;
    state.proposalReturnView = returnView;
    state.view = 'proposal';
    rerender();
    announce('Proposal ready to review.');
    return true;
  } catch (error) {
    showError(messageFor(error));
    return false;
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}
