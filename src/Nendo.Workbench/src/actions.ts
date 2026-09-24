import type { ViewName } from './app-state';
import type { ApplicationRecipe } from './application-recipes';
import { client } from './client';
import { announce, clearError, content, refreshChrome, requiredElement, rerender, setBusy, showError, showRetainedNotice } from './shell';
import { messageFor, mutationKey } from './format';
import { decideWriteFailure } from './write-failure';
import { refuseWhileDirty } from './draft-guard';
import { decideDraftState, draftRetentionMessage, type DraftReason } from './draft-state';
import { declaredQuery, emptyWindowQuery, windowRequest, type WindowQuery } from './record-window';
import {
  accumulatedWindows, clearFileScoped, focusedRecords, recordWindows, relatedWindows, state, studioQueries, studioWindows,
  summaryCounts, surfaceErrors, surfaceWindows,
} from './app-state';
import { recordPlanOf, recordsForEntity, selectedSurfaceNode, sessionEntity } from './plan-selection';
import { accumulatesPages, isCustomViewKind } from './surface-model';
import {
  WorkbenchHostError, type AgentStatus, type CompileResult, type DesktopMutationView, type DesktopPromotionView,
  type DesktopSessionView, type ProposalPreview, type ReadPage, type RecordSnapshot, type RevisionSummary,
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
 * <paramref name="restate" /> replaces the host's refusal with one the caller's screen can
 * act on, for the cases where the host's own words name a remedy that screen does not have.
 * It answers null to keep the host's message, which is what everything else does: the
 * host's wording is right far more often than not, and this is a deliberate exception
 * rather than a translation layer.
 */
export async function runMutation(
  method: string,
  payload: Record<string, unknown>,
  success: string,
  refreshAfterFailure = false,
  beforeRender?: () => void,
  restate?: (error: unknown) => string | null,
): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<DesktopMutationView>(method, payload);
    if (result.session !== null) state.session = result.session;
    beforeRender?.();
    const notice = await refreshAfterOutcome(result);
    rerender();
    announce(success);
    if (notice !== null) showOutcomeRefreshNotice(success, notice);
  } catch (error) {
    // A confirmed refusal leaves the file unchanged, so the form's draft is still
    // the user's current intent and must survive. Only an unsettled outcome is
    // worth rebuilding the view for, and then exactly once: recoverAfterWriteFailure
    // renders on its own.
    if (decideWriteFailure(error) === 'refresh-view') {
      if (refreshAfterFailure) await recoverAfterWriteFailure();
      else rerender();
    }
    showError(restate?.(error) ?? messageFor(error));
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

export function showOutcomeRefreshNotice(outcome: string, notice: string): void {
  showRetainedNotice(`${outcome} ${notice}`, async (refresh) => {
    if (state.actionInFlight) return;
    state.actionInFlight = true;
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
    } finally { state.actionInFlight = false; }
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
  state.proposal = null;
  state.agentProposal = null;
  state.compilation = null;
  state.history = [];
  state.historyWindow = null;
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
      showError('The file changed. These results are from the earlier query. Restart to see the current records.');
      const slot = content.querySelector<HTMLElement>('.message-slot');
      if (slot) {
        const restart = document.createElement('button');
        restart.id = 'restart-record-query'; restart.type = 'button'; restart.className = 'secondary-button';
        restart.textContent = 'Restart query';
        restart.addEventListener('click', () => void (async () => {
          if (state.actionInFlight) return;
          state.actionInFlight = true; setBusy(true);
          clearError();
          try { await reloadReadWindows(); rerender(); announce('Showing the first page of current records.'); }
          catch (refreshError) { showError(messageFor(refreshError)); }
          finally { state.actionInFlight = false; setBusy(false); }
        })());
        slot.append(restart);
      }
      return;
    }
    try {
      await reloadReadWindows();
      rerender();
      announce('The file changed. Showing the first page again.');
    } catch (refreshError) { showError(messageFor(refreshError)); }
  } else showError(messageFor(error));
}

export async function refreshDerived(attempt = 0): Promise<void> {
  if (!state.session.hasFile) {
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
  const [definition, revisions, status] = await Promise.all([
    state.session.capabilities.customSurfaces ? client.request<CompileResult>('semantic.compile') : Promise.resolve(null),
    state.session.capabilities.readHistory ? client.request<ReadPage<RevisionSummary>>('history.query', { limit: 50 }) : Promise.resolve(null),
    client.request<AgentStatus>('agent.getStatus'),
  ]);
  const applicationEntity =
    (definition?.applications?.find(app => app.entity.semanticId === state.selectedApplicationEntity) ?? definition?.applications?.[0])?.entity.semanticId;
  const entityIds = state.session.capabilities.readData ? [...new Set([sessionEntity()?.entityId, applicationEntity]
    .filter((id): id is string => id !== undefined))] : [];
  const browseQuery = emptyWindowQuery();
  const pages = await Promise.all(entityIds.map(async entityId => ({ entityId,
    page: await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', windowRequest(entityId, browseQuery)) })));

  // Only the selected surface is read. An unselected one keeps whatever window it
  // already had for this revision and is reloaded lazily when it is chosen.
  const surfacePlan = (definition?.applications ?? []).find(app => app.entity.semanticId === applicationEntity) ?? null;
  const surfaceNode = surfacePlan === null ? null : selectedSurfaceNode(surfacePlan);
  // A calendar or a timeline reads its own bounded pages when it renders, so
  // the shared refresh must not open an unbounded window for one.
  const declared = surfaceNode === null || accumulatesPages(surfaceNode.kind) || isCustomViewKind(surfaceNode.kind)
    ? null
    : declaredQuery(surfaceNode);
  const surfacePage = surfaceNode === null || declared === null || applicationEntity === undefined ? null
    : await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', windowRequest(applicationEntity, declared));
  if (state.session.fileSessionId !== generation ||
      (definition?.sourceChangeSequence != null && definition.sourceChangeSequence !== sequence) ||
      (revisions !== null && revisions.changeSequence !== sequence) || pages.some(value => value.page.changeSequence !== sequence) ||
      (surfacePage !== null && surfacePage.changeSequence !== sequence)) {
    if (attempt >= 2) throw new WorkbenchHostError('view-changed', 'The file is changing. Refresh the view when the current changes finish.');
    const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
    const changed = refreshed.fileSessionId !== state.session.fileSessionId;
    state.session = refreshed;
    if (changed) resetFileView();
    await refreshDerived(attempt + 1);
    return;
  }
  state.compilation = definition;
  // The file's definition is known now, so the screen Use opens on is settled:
  // a file with a front page opens on it, and one without opens on a record type
  // exactly as it did. Already answered for this file, it stays as the person
  // last left it.
  if (state.showOverview === null)
    state.showOverview = definition?.isValid === true && (definition.overview ?? null) !== null;
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
    if (window.page.changeSequence !== sequence) surfaceWindows.delete(surfaceId);
  // A calendar's or a timeline's accumulated pages are one snapshot of a range.
  // Keeping them across a revision would either duplicate a record or mix two
  // snapshots.
  for (const [key, accumulated] of [...accumulatedWindows])
    if (accumulated.changeSequence !== sequence) accumulatedWindows.delete(key);
  surfaceErrors.clear();
  if (surfacePage !== null && surfaceNode !== null && declared !== null)
    surfaceWindows.set(surfaceNode.semanticId, { page: surfacePage, cursors: [null], index: 0, query: declared });
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
  if (state.actionInFlight) return;
  // Another view is a redraw, and a redraw is the open form's unsaved typing gone.
  if (refuseWhileDirty('leaving this screen')) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    // MCP writes use the same live host but do not pass through this renderer's
    // mutation receipts. Navigation is an explicit refresh boundary, so cached
    // empty record windows or old definitions cannot hide accepted agent work.
    const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
    const changed = refreshed.fileSessionId !== state.session.fileSessionId;
    state.session = refreshed;
    if (changed) resetFileView();
    state.view = target;
    state.creatingRecord = false;
    await refreshDerived();
    rerender();
  } catch (error) {
    showError(messageFor(error));
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
  const draftState = draft === null
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
  state.openDraft = null;
  for (const control of content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    '#record-form input, #record-form select, #record-form textarea, #record-form button, #record-form [data-action]')) {
    control.disabled = true;
    // setBusy stamped each control with the state to restore when the request
    // finishes, and this runs inside that request. Restating it keeps the release
    // from handing the Save button back a moment later.
    control.dataset.busyWasDisabled = 'true';
  }
  showError(draftRetentionMessage(reason));
}

export async function compensateRevision(revisionId: string): Promise<void> {
  await runMutation('history.compensate', { revisionId, idempotencyKey: mutationKey() }, 'Compensation added to history.', true);
}

export async function retryPendingSave(): Promise<void> {
  if (state.actionInFlight || client.retryPendingMutation === undefined) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const result = await client.retryPendingMutation();
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
      announce(confirmed);
      if (notice !== null) showOutcomeRefreshNotice(confirmed, notice);
    } else rerender();
  } catch (error) {
    rerender();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function refreshStudioQuery(entityId: string): Promise<void> {
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

export async function openHelp(topicId = 'start'): Promise<void> {
  if (refuseWhileDirty('opening Help')) return;
  state.helpTopicId = topicId; state.view = 'help'; state.creatingRecord = false;
  rerender();
  if (client.mode === 'desktop' && !state.actionInFlight) {
    state.actionInFlight = true;
    setBusy(true);
    try { state.session = await client.request<DesktopSessionView>('session.getSnapshot'); await refreshDerived(); }
    catch { /* Built-in guidance remains available if the file cannot refresh. */ }
    finally { state.actionInFlight = false; setBusy(false); }
  }
  rerender();
}

export async function prepareApplication(recipe: ApplicationRecipe, returnView: ViewName): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.proposal = await client.request<ProposalPreview>('proposal.prepareChangeSet', recipe.proposalPayload);
    state.proposalReturnView = returnView;
    state.view = 'proposal';
    rerender();
    announce('Proposal ready to review.');
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

