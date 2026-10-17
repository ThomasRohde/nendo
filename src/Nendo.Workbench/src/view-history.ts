import { compensateRevision, foldHistory, handlePageFailure, removeUnusedPictures } from './actions';
import { mediaUsageMarkup, mediaUsageState, type MediaUsage } from './media-usage';
import { fileScopedClearable, state } from './app-state';
import { client } from './client';
import { canCompensate, counted, escapeAttribute, escapeHtml, foldDate, formatDateTime, laneLabel, messageFor, originLabel, shortId } from './format';
import { historyUndoOffer, operationDetailsMarkup } from './history-markup';
import { type HistoryFoldPreview, type ReadPage, type RevisionSummary, type StoredOperationSnapshot, WorkbenchHostError } from './host';
import { icon } from './icons';
import { content, rerender, setBusy, showError } from './shell';
/**
 * Studio history: the revisions of this file, one page at a time, and the
 * operations inside whichever one is opened.
 */

export function renderHistory(): void {
  const ordered = [...state.history].sort((left, right) => right.changeSequence - left.changeSequence);
  content.innerHTML = `<div class="studio-page history-page"><header class="page-heading"><span class="record-total">${counted(state.history.length, 'revision')} shown</span></header>
    ${foldMarkup()}
    ${mediaUsageMarkup(mediaUsageState.usage, state.session.capabilities.mutate)}
    <div class="page-controls" aria-label="History pages"><span>Page ${(state.historyWindow?.index ?? 0) + 1}</span><button class="text-button" data-history-page="-1" type="button" ${!state.historyWindow || state.historyWindow.index === 0 ? 'disabled' : ''}>Previous</button><button class="text-button" data-history-page="1" type="button" ${!state.historyWindow?.page.nextCursor ? 'disabled' : ''}>Next</button></div>
    ${ordered.length === 0 ? `<div class="quiet-empty"><span class="quiet-empty-glyph" aria-hidden="true">${icon('history')}</span><h3>No revisions yet</h3><p>Every definition and data change you save appears here in one ordered sequence.</p></div>` : ''}
    <div class="history-list" ${ordered.length === 0 ? 'hidden' : ''}>${ordered.map((revision) => `<article class="history-entry"><div class="history-sequence">${revision.changeSequence}</div><div><div class="history-meta"><span class="lane-chip ${laneLabel(revision.lane).toLowerCase()}">${laneLabel(revision.lane)}</span><time>${escapeHtml(formatDateTime(revision.createdAt))}</time><span class="history-origin">by ${escapeHtml(originLabel(revision.origin, state.session.extensions?.packages ?? []))}</span>${revision.compensationOfRevisionId ? '<span>Undo</span>' : ''}</div><h3>${escapeHtml(revision.description)}</h3><p>${counted(revision.operationCount, 'change')} · <button class="text-button" data-history-detail="${escapeAttribute(revision.revisionId)}" type="button">View changes</button></p><div data-operation-detail="${escapeAttribute(revision.revisionId)}"></div><code>${escapeHtml(shortId(revision.revisionId))}</code></div><div class="history-action">${canCompensate(revision, state.history) ? `<span>Checked against the file when you press it</span><button class="secondary-button" data-compensate="${escapeAttribute(revision.revisionId)}" data-action type="button">Undo</button>` : '<span>Cannot be undone here</span>'}</div></article>`).join('')}</div>
  </div>`;
  content.querySelector<HTMLButtonElement>('[data-fold-history]')?.addEventListener('click', () => void foldHistory());
  void loadFoldPreview();
  content.querySelector<HTMLButtonElement>('[data-remove-unused-media]')?.addEventListener('click', () => void removeUnusedPictures());
  void loadMediaUsage();
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-compensate]')) {
    button.addEventListener('click', () => void compensateRevision(button.dataset.compensate!));
  }
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-history-page]'))
    button.addEventListener('click', () => void loadHistoryWindow(Number(button.dataset.historyPage)));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-history-detail]'))
    button.addEventListener('click', () => void loadHistoryDetails(button.dataset.historyDetail!));
  // What was opened stays open across a redraw: the fold section's first reply redrew History and
  // closed a list just opened (WSP-16).
  for (const [revisionId, opened] of openedDetails) drawDetails(revisionId, opened.page, opened.cursor);
}

/**
 * The operations shown under each opened entry, by revision. A revision's operations never
 * change, so a page read once stays true; the labels are drawn again from the file as it is.
 */
const openedDetails = fileScopedClearable(new Map<string, { page: ReadPage<StoredOperationSnapshot>; cursor: string | null }>());

function drawDetails(revisionId: string, page: ReadPage<StoredOperationSnapshot>, cursor: string | null): void {
  const slot = content.querySelector<HTMLElement>(`[data-operation-detail="${CSS.escape(revisionId)}"]`);
  if (!slot) return;
  // A create or a restore reads as History undoes it only where History offers that Undo (R2RM-05).
  const revision = state.history.find(item => item.revisionId === revisionId);
  const offered = historyUndoOffer(revision, state.history, client.mode === 'desktop');
  slot.innerHTML = `${operationDetailsMarkup(page.items, state.session.entities, offered)}<div class="page-controls"><span>${counted(page.items.length, 'change')} shown</span><button class="text-button" data-operation-first type="button" ${cursor === null ? 'disabled' : ''}>First</button><button class="text-button" data-operation-next type="button" ${page.nextCursor === null ? 'disabled' : ''}>Next</button></div>`;
  slot.querySelector<HTMLButtonElement>('[data-operation-first]')?.addEventListener('click', () => void loadHistoryDetails(revisionId));
  slot.querySelector<HTMLButtonElement>('[data-operation-next]')?.addEventListener('click', () => void loadHistoryDetails(revisionId, page.nextCursor));
}

/**
 * How much of the file's change bound is used, and the way to fold older history (ADR-0021).
 * Warns from 80%, where a file in daily use has months rather than years left.
 */
function foldMarkup(): string {
  const fold = state.historyFold;
  if (fold === null || !state.session.capabilities.mutate) return '';
  const preview: HistoryFoldPreview = fold.preview;
  const used = preview.operationRows / preview.operationCeiling;
  const near = used >= 0.8;
  return `<section class="history-fold callout${near ? ' is-tinted' : ''}" data-history-fold aria-label="Changes recorded in this file">
    <span class="callout-icon">${icon(near ? 'alert' : 'history')}</span>
    <strong>${preview.operationRows.toLocaleString()} of ${preview.operationCeiling.toLocaleString()} changes recorded (${Math.round(used * 100)}%)</strong>
    <p>${near ? 'This file is close to the number of changes it can record. Fold older history to keep writing.' : 'A file records every change until it reaches this number. Folding older history makes room.'}
    ${preview.lastFoldedAt === null ? '' : ` History was last folded on ${escapeHtml(foldDate(preview.lastFoldedAt))}.`}</p>
    ${preview.canFold
      ? `<p><button class="secondary-button" data-fold-history type="button">Fold older history…</button>
         <span class="quiet">${preview.revisions.toLocaleString()} older changes can be folded; the most recent ${preview.keep.toLocaleString()} stay.</span></p>`
      // Nothing to fold is said, not offered as a button that cannot be pressed.
      : `<p class="quiet" data-fold-nothing>Nothing to fold yet. ${escapeHtml(preview.reason ?? '')}</p>`}
  </section>`;
}

let foldLoading = false;
async function loadFoldPreview(): Promise<void> {
  const sequence = state.session.manifest?.changeSequence ?? -1;
  if (foldLoading || !state.session.capabilities.mutate || state.historyFold?.changeSequence === sequence) return;
  foldLoading = true;
  try {
    const preview = await client.request<HistoryFoldPreview>('history.foldPreview', {});
    state.historyFold = { preview, changeSequence: sequence };
    if (state.view === 'history') rerender();
  } catch (error) {
    // The Workbench ships with the host that answers this, so a failure is a real one. Said
    // on History, where the fold section it leaves out would have been.
    if (state.view === 'history') showError(messageFor(error));
  } finally {
    foldLoading = false;
  }
}

let usageLoading = false;
/** What the file's pictures weigh, read again whenever the file has moved on (W-273). */
async function loadMediaUsage(): Promise<void> {
  const key = `${state.session.fileSessionId ?? ''}:${state.session.manifest?.changeSequence ?? -1}`;
  if (usageLoading || !state.session.hasFile || mediaUsageState.key === key) return;
  usageLoading = true;
  try {
    mediaUsageState.usage = await client.request<MediaUsage>('media.usage', {});
    mediaUsageState.key = key;
    if (state.view === 'history') rerender();
  } catch (error) {
    if (state.view === 'history') showError(messageFor(error));
  } finally {
    usageLoading = false;
  }
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
    // A first page cannot be stale, since a revision's operations never change: refusing it
    // whenever the file had moved threw the person back to History's first page (WSP-16). A
    // later page continues a cursor, which the host checks against the file.
    if (cursor !== null && page.changeSequence !== state.session.manifest?.changeSequence) throw new WorkbenchHostError('stale-cursor', 'The file changed.');
    openedDetails.set(revisionId, { page, cursor });
    drawDetails(revisionId, page, cursor);
  } catch (error) { await handlePageFailure(error); }
  finally { state.actionInFlight = false; setBusy(false); }
}

