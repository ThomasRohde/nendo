import { compensateRevision, handlePageFailure } from './actions';
import { state } from './app-state';
import { client } from './client';
import { canCompensate, escapeAttribute, escapeHtml, formatDateTime, laneLabel, operationLabel, reversibilityLabel, shortId } from './format';
import { type ReadPage, type RevisionSummary, type StoredOperationSnapshot, WorkbenchHostError } from './host';
import { icon } from './icons';
import { content, rerender, setBusy } from './shell';
/**
 * Studio history: the revisions of this file, one page at a time, and the
 * operations inside whichever one is opened.
 */

export function renderHistory(): void {
  const ordered = [...state.history].sort((left, right) => right.changeSequence - left.changeSequence);
  content.innerHTML = `<div class="studio-page history-page"><header class="page-heading"><span class="record-total">${state.history.length} revisions shown</span></header><div class="message-slot" role="alert" hidden></div>
    <div class="page-controls" aria-label="History pages"><span>Page ${(state.historyWindow?.index ?? 0) + 1}</span><button class="text-button" data-history-page="-1" type="button" ${!state.historyWindow || state.historyWindow.index === 0 ? 'disabled' : ''}>Previous</button><button class="text-button" data-history-page="1" type="button" ${!state.historyWindow?.page.nextCursor ? 'disabled' : ''}>Next</button></div>
    ${ordered.length === 0 ? `<div class="quiet-empty"><span class="quiet-empty-glyph" aria-hidden="true">${icon('history')}</span><h3>No revisions yet</h3><p>Every definition and data change you save appears here in one ordered sequence.</p></div>` : ''}
    <div class="history-list" ${ordered.length === 0 ? 'hidden' : ''}>${ordered.map((revision) => `<article class="history-entry"><div class="history-sequence">${revision.changeSequence}</div><div><div class="history-meta"><span class="lane-chip ${laneLabel(revision.lane).toLowerCase()}">${laneLabel(revision.lane)}</span><time>${escapeHtml(formatDateTime(revision.createdAt))}</time>${revision.compensationOfRevisionId ? '<span>Compensation</span>' : ''}</div><h3>${escapeHtml(revision.description)}</h3><p>${revision.operationCount} operations · <button class="text-button" data-history-detail="${escapeAttribute(revision.revisionId)}" type="button">View changes</button></p><div data-operation-detail="${escapeAttribute(revision.revisionId)}"></div><code>${escapeHtml(shortId(revision.revisionId))}</code></div><div class="history-action">${canCompensate(revision, state.history) ? `<span>Current state is checked when requested</span><button class="secondary-button" data-compensate="${escapeAttribute(revision.revisionId)}" data-action type="button">Compensate</button>` : '<span>No compensation offered</span>'}</div></article>`).join('')}</div>
  </div>`;
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-compensate]')) {
    button.addEventListener('click', () => void compensateRevision(button.dataset.compensate!));
  }
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-history-page]'))
    button.addEventListener('click', () => void loadHistoryWindow(Number(button.dataset.historyPage)));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-history-detail]'))
    button.addEventListener('click', () => void loadHistoryDetails(button.dataset.historyDetail!));
}

export async function loadHistoryWindow(direction: number): Promise<void> {
  const window = state.historyWindow;
  if (state.actionInFlight || !window) return;
  const index = window.index + direction;
  if (index < 0 || (direction > 0 && !window.page.nextCursor)) return;
  const cursor = direction > 0 ? window.page.nextCursor : window.cursors[index];
  state.actionInFlight = true;
  setBusy(true);
  try {
    const page = await client.request<ReadPage<RevisionSummary>>('history.query', { limit: 50, cursor });
    if (page.changeSequence !== state.session.manifest?.changeSequence) throw new WorkbenchHostError('stale-cursor', 'The file changed.');
    const cursors = [...window.cursors];
    cursors[index] = cursor;
    state.historyWindow = { page, cursors, index };
    state.history = page.items;
    rerender();
  } catch (error) { await handlePageFailure(error); }
  finally { state.actionInFlight = false; setBusy(false); }
}

export async function loadHistoryDetails(revisionId: string, cursor: string | null = null): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const page = await client.request<ReadPage<StoredOperationSnapshot>>('history.operations', { revisionId, limit: 50, cursor });
    if (page.changeSequence !== state.session.manifest?.changeSequence) throw new WorkbenchHostError('stale-cursor', 'The file changed.');
    const slot = content.querySelector<HTMLElement>(`[data-operation-detail="${CSS.escape(revisionId)}"]`);
    if (!slot) return;
    slot.innerHTML = `<ul class="operation-details">${page.items.map(operation => `<li>${escapeHtml(operationLabel(operation.operationType))} · ${escapeHtml(reversibilityLabel(operation.reversibility))}</li>`).join('')}</ul><div class="page-controls"><span>${page.items.length} operations shown</span><button class="text-button" data-operation-first type="button" ${cursor === null ? 'disabled' : ''}>First</button><button class="text-button" data-operation-next type="button" ${page.nextCursor === null ? 'disabled' : ''}>Next</button></div>`;
    slot.querySelector<HTMLButtonElement>('[data-operation-first]')?.addEventListener('click', () => void loadHistoryDetails(revisionId));
    slot.querySelector<HTMLButtonElement>('[data-operation-next]')?.addEventListener('click', () => void loadHistoryDetails(revisionId, page.nextCursor));
  } catch (error) { await handlePageFailure(error); }
  finally { state.actionInFlight = false; setBusy(false); }
}

