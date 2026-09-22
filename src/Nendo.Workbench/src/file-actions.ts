import { client } from './client';
import { announce, clearError, content, requiredElement, rerender, setBusy, showError } from './shell';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import { icon, type IconName } from './icons';
import type { DesktopFileActionView, DesktopSessionView, RecentFiles } from './host';
import { state } from './app-state';
import { openHelp, recoverAfterWriteFailure, refreshDerived, resetFileView, showOutcomeRefreshNotice } from './actions';

/**
 * The File menu, the start screen, and the host dialogs behind them.
 *
 * Opening a file, creating one and recovering one are not edits to the open
 * file — they are how a person gets out of the state that switched editing off —
 * so these stay reachable when everything else on the page is disabled.
 */

export function renderUnavailable(): void {
  content.innerHTML = `<section class="empty-state compact-empty" data-testid="host-unavailable">
    <img class="empty-brand-mark" src="/nendo-mark.png" alt="" />
    <h2>Open Nendo Desktop</h2>
    <p>Nendo files can only be created or opened from the desktop app.</p>
    <div class="inline-alert" role="alert">This preview cannot access files on your computer.</div>
  </section>`;
}

export function renderNoFile(): void {
  content.innerHTML = `<section class="empty-state no-file-empty" data-testid="no-file-state">
    <img class="empty-brand-mark" src="/nendo-mark.png" alt="" />
    <h2>Open a local workspace</h2>
    <p>Create a Nendo file, or open one you already own. Your work stays local and offline.</p>
    <div class="action-row">
      <button id="create-file" class="primary-button" data-action type="button">Create Nendo file</button>
      <button id="open-file" class="secondary-button" data-action type="button">Open Nendo file</button>
    </div>
    <p class="empty-help-entry">New to Nendo? <button id="no-file-help" class="text-button" type="button">Read how Nendo works</button></p>
    <div class="message-slot" role="alert" hidden></div>
    ${state.recentFiles.files.length === 0 ? '' : `<section class="recent-files" aria-label="Recent files"><h3>Recent files</h3>${state.recentFiles.files.slice(0, 4).map(file => `<button class="recent-file" data-file-action="file.openRecent" data-recent-id="${escapeAttribute(file.id)}" type="button" ${file.state !== 'available' ? 'disabled' : ''}><span>${escapeHtml(file.fileName)}</span><span>${file.state === 'available' ? 'Open' : escapeHtml(file.state)}</span></button>`).join('')}</section>`}
    ${state.recentFiles.notice ? `<p class="recent-notice">${escapeHtml(state.recentFiles.notice)}</p>` : ''}
  </section>`;
  requiredElement<HTMLButtonElement>('#create-file').addEventListener('click', () => void chooseFile('session.createFile', null));
  requiredElement<HTMLButtonElement>('#open-file').addEventListener('click', () => void chooseFile('session.openFile', null));
  requiredElement<HTMLButtonElement>('#no-file-help').addEventListener('click', () => void openHelp('overview'));
  wireFileActions(content);
}

/**
 * What the file says it is for, on a page of its own.
 *
 * Not in the menu itself: a purpose is prose, and prose long enough to be worth writing
 * pushed the actions it sat above off the bottom of a menu somebody opened to reach
 * them. A file nobody has told says so here rather than showing a blank panel, because
 * the honest answer to "what is this file for" is sometimes that nobody has said.
 */
export function openAboutFile(): void {
  const fileName = state.session.fileName ?? 'No file open';
  const purpose = state.session.manifest?.purpose ?? null;
  const dialog = document.createElement('dialog');
  dialog.className = 'about-file-dialog';
  dialog.setAttribute('aria-labelledby', 'about-file-heading');
  dialog.innerHTML = `<h2 id="about-file-heading">${escapeHtml(fileName)}</h2>
    ${purpose === null
      ? '<p class="about-file-empty">Nobody has said what this file is for.</p>'
      : `<p class="about-file-purpose">${escapeHtml(purpose)}</p>`}
    <div class="form-actions"><button class="primary-button" data-close type="button" autofocus>Close</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  dialog.showModal();
}

export function renderFileMenu(): void {
  const menu = requiredElement<HTMLElement>('#file-actions');
  const local = client.mode === 'desktop';
  const item = (method: string, label: string, detail: string, glyph: IconName, enabled: boolean): string =>
    `<button type="button" data-file-action="${method}" ${enabled ? '' : 'disabled'}>${icon(glyph)}<span><strong>${label}</strong><small>${detail}</small></span></button>`;
  menu.innerHTML = `<div class="file-menu-heading">${escapeHtml(state.session.fileName ?? 'No file open')}</div>
    <button type="button" id="about-file" data-file-action="about" ${state.session.hasFile ? '' : 'disabled'}>${icon('file')}<span><strong>About this file</strong><small>What it is for, in the author's words</small></span></button>
    ${item('session.createFile', 'New file', state.session.hasFile ? 'Close this file to start another' : 'Start with an empty workspace', 'file', !state.session.hasFile && client.mode !== 'unavailable')}
    ${item('session.openFile', 'Open file…', 'Choose a Nendo file', 'open', client.mode !== 'unavailable')}
    <div class="file-menu-divider"></div><p class="file-menu-label">Copies</p>
    ${item('file.backup', 'Create backup…', 'Save a recovery copy', 'backup', local && state.session.capabilities.backup)}
    ${item('file.duplicate', 'Duplicate…', 'Another copy of this application', 'duplicate', local && state.session.capabilities.backup)}
    ${item('file.fork', 'Fork…', 'Start a separate application', 'fork', local && state.session.capabilities.backup)}
    <div class="file-menu-divider"></div><p class="file-menu-label">Data</p>
    ${item('file.importCsv', 'Import CSV…', 'Map fields and review batches of up to 100 new records', 'data', local && state.session.capabilities.mutate && state.session.entities.some(entity => !entity.retired))}
    ${item('file.exportCsv', 'Export CSV…', 'Faithful UTF-8 values from one record type', 'data', local && state.session.capabilities.mutate && state.session.entities.some(entity => !entity.retired))}
    ${item('file.customViews', 'Custom views…', 'Offline packages and permission for this file', 'surfaces', local)}
    <div class="file-menu-divider"></div><p class="file-menu-label">Recovery</p>
    ${item('file.restore', 'Restore backup…', 'Replace from a backup; retain this version', 'history', local && state.session.capabilities.backup)}
    ${item('file.resolveRecovery', 'Review recovery record…', 'Resolve an interrupted replacement', 'health', local)}
    <div class="file-menu-divider"></div>
    ${item('file.close', 'Close file', 'Return to the start screen', 'close', state.session.fileName !== null && client.mode !== 'unavailable')}`;
  wireFileActions(menu);
}

export function fileActionButton(method: string, label: string, enabled: boolean, detail = '', glyph: IconName = 'file'): string {
  return `<button class="recovery-action" type="button" data-file-action="${method}" ${enabled ? '' : 'disabled'}>
    <span class="recovery-icon" aria-hidden="true">${icon(glyph)}</span>
    <span class="recovery-text"><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>
    <span class="recovery-chevron" aria-hidden="true">${icon('chevronRight')}</span>
  </button>`;
}

export function wireFileActions(element: Element): void {
  for (const button of element.querySelectorAll<HTMLButtonElement>('[data-file-action]')) {
    button.addEventListener('click', () => {
      requiredElement<HTMLDetailsElement>('#file-menu').open = false;
      const method = button.dataset.fileAction!;
      // The only file action that asks the host nothing: what a file is for is already
      // in hand, and a round trip to be told it again would be a round trip for nothing.
      if (method === 'about') openAboutFile();
      else if (method === 'session.createFile' || method === 'session.openFile') void chooseFile(method, null);
      else void runFileAction(method, button.dataset.recentId);
    });
  }
}

export async function chooseFile(method: 'session.createFile' | 'session.openFile', success: string | null): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<DesktopSessionView | DesktopFileActionView>(method);
    await showFileActionOutcome('session' in result ? result : { session: result, notice: result.hasFile ? success : null });
  } catch (error) {
    await recoverAfterWriteFailure();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function refreshRecentFiles(): Promise<void> {
  // Recents are displayed only on the no-file screen. Inspecting every recent
  // file while an application is open adds unrelated startup and refresh work.
  if (state.session.hasFile) { state.recentFiles = { files: [], notice: null }; return; }
  try { state.recentFiles = await client.request<RecentFiles>('session.getRecentFiles'); }
  catch { state.recentFiles = { files: [], notice: 'Recent files could not be checked. Use Open file to choose one.' }; }
}

export async function runFileAction(method: string, recentId?: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    const result = await client.request<DesktopFileActionView>(method, recentId ? { recentId } : {});
    await showFileActionOutcome(result);
  } catch (error) {
    await recoverAfterWriteFailure();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/**
 * Opens a file the person dropped on the window.
 *
 * The same path as Open file from here on: the host asks the same questions about an
 * instance collision, a read-only file and an unsupported location, because a drop is
 * a shortcut to the picker and not a different way in.
 */
export async function openDroppedFile(file: File): Promise<void> {
  if (state.actionInFlight) return;
  if (client.openDroppedFile === undefined) {
    showError('This Nendo cannot open a dropped file. Use Open file from the File menu.');
    return;
  }
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    await showFileActionOutcome(await client.openDroppedFile<DesktopFileActionView>(file));
  } catch (error) {
    await recoverAfterWriteFailure();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function showFileActionOutcome(result: DesktopFileActionView): Promise<void> {
  let refreshNotice: string | null = null;
  try {
    const refreshed = result.session ?? await client.request<DesktopSessionView>('session.getSnapshot');
    const changed = state.session.fileSessionId !== refreshed.fileSessionId;
    state.session = refreshed;
    if (changed) resetFileView();
    await refreshDerived();
    await refreshRecentFiles();
  } catch {
    refreshNotice = result.refreshNotice ?? 'Refresh the view to see the current file state.';
  }
  rerender();
  const notice = requiredElement<HTMLElement>('#file-notice');
  notice.textContent = result.notice ?? '';
  notice.hidden = result.notice === null;
  if (result.notice) announce(result.notice);

  if (refreshNotice !== null) showOutcomeRefreshNotice(result.notice ?? 'Check the file status.', refreshNotice);
}
