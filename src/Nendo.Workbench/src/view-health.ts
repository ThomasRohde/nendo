import { refreshDerived, resetFileView } from './actions';
import { state } from './app-state';
import { client } from './client';
import { fileActionButton, wireFileActions } from './file-actions';
import { escapeHtml, formatDateTime, messageFor } from './format';
import { type DesktopSessionView, WorkbenchHostError } from './host';
import { type IconName, icon } from './icons';
import { announce, clearError, content, requiredElement, rerender, setBusy, showError } from './shell';
import { offReasonSentence } from './view-frame-markup';
/**
 * File health and the consents this device has given: what the host can still
 * do with the open file, and the approval that automatic actions wait on.
 *
 * Approving or withdrawing consent is not an edit to the file — it is how a
 * person gets out of the state that switched editing off — so its control stays
 * live when the read-only sweep disables everything else.
 */

/**
 * What this file's automatic actions may do, and whether this device has agreed.
 *
 * Written as what will happen to the owner's data rather than as a permission
 * grant, because that is the thing they can actually weigh: "records will be
 * changed for you" is something somebody can weigh, where "grant behaviour
 * capability UpdateRecords" is not. The behaviour's short digest is shown so that
 * two different sets of rules visibly differ — approving once is not approving
 * whatever the file does next.
 */
export function behaviourApprovalMarkup(): string {
  const trust = state.session.behaviourTrust;
  if (!trust?.requiresApproval) return '';
  const effects = [
    trust.createsRecords ? 'add records' : null,
    trust.updatesRecords ? 'change records' : null,
    trust.deletesRecords ? 'delete records' : null,
  ].filter((effect): effect is string => effect !== null);
  const summary = effects.length === 0 ? 'run automatically when you edit' : effects.join(', ');
  return `<div class="behaviour-approval" data-testid="behaviour-approval" data-approved="${trust.isApproved}">
    <h3>Automatic actions</h3>
    <p>When you edit this file, it can <strong>${escapeHtml(summary)}</strong> on its own.
      ${trust.isApproved
        ? 'You approved this on this device.'
        : 'Editing is off until you approve it here. Your data is unaffected and stays readable.'}</p>
    ${trust.behaviourDigest ? `<p class="subtle-note">Rules <code>${escapeHtml(trust.behaviourDigest)}</code>. Changing what they do asks again.</p>` : ''}
    ${trust.notice ? `<p class="subtle-note">${escapeHtml(trust.notice)}</p>` : ''}
    <div class="behaviour-approval-actions">
      ${trust.isApproved
        ? '<button id="revoke-behaviour" class="secondary-button" data-action type="button">Withdraw approval</button>'
        : '<button id="approve-behaviour" class="primary-button" data-action type="button">Approve automatic actions</button>'}
    </div>
  </div>`;
}

export function renderHealth(): void {
  const capabilities = state.session.capabilities;
  const local = client.mode === 'desktop';
  const status = state.session.health === 'normal' ? 'Ready for editing' : state.session.health === 'readOnly' ? 'Open read-only' : state.session.fileName === null ? 'No file open' : 'Recovery required';
  content.innerHTML = `<div class="studio-page file-health-page"><header class="page-heading"><span class="health-chip ${state.session.health === 'normal' ? 'healthy' : 'warning'}">${status}</span></header>
    <div class="message-slot" role="alert" hidden></div>
    <div class="health-grid">
      ${healthCard('Data', capabilities.readData, capabilities.readData ? 'Available' : 'Unavailable', capabilities.readData ? '' : 'Not available for inspection.', 'data')}
      ${healthCard('History', capabilities.readHistory, capabilities.readHistory ? 'Available' : 'Unavailable', capabilities.readHistory ? '' : 'Not available for inspection.', 'history')}
      ${customViewsCard()}
    </div>
    <div class="recovery-layout"><section class="recovery-findings"><h2>File status</h2>
      ${state.session.findings.length ? state.session.findings.map(finding => `<p>${escapeHtml(finding.message)}</p>`).join('') : `<p>${state.session.health === 'normal' ? 'This file passed the checks required for editing. Changes are saved as you work.' : state.session.health === 'readOnly' ? 'You can inspect this file and create a backup without changing it. Editing and agent access are off.' : 'Choose Open file to inspect an application or a verified backup.'}</p>`}
      ${state.session.agentCleanupNotice ? `<p>${escapeHtml(state.session.agentCleanupNotice)}</p>` : ''}
      ${state.session.storage?.integrityCheckedAt ? `<p>Last integrity check: ${escapeHtml(formatDateTime(state.session.storage.integrityCheckedAt))} · change ${state.session.storage.integrityChangeSequence ?? 'unknown'}.</p>` : ''}
      ${state.session.locationWarning ? `<p>${escapeHtml(state.session.locationWarning.message)}</p>` : ''}
      ${state.session.replacementRecovery?.hasPendingReplacement ? `<p>${escapeHtml(state.session.replacementRecovery.message)}</p>` : ''}
      ${behaviourApprovalMarkup()}
      <details class="subtle-note"><summary>About backups and Restore</summary><p>A backup preserves the whole application. Restore retains the previous file beside it; retained copies are not deleted automatically.</p></details>
    </section><section class="recovery-action-list"><h2>Recovery actions</h2>
      <button id="recovery-data" class="recovery-action" type="button" ${capabilities.readData ? '' : 'disabled'}>
        <span class="recovery-icon" aria-hidden="true">${icon('data')}</span>
        <span class="recovery-text"><strong>Inspect Data</strong><small>Browse records using the built-in data view.</small></span>
        <span class="recovery-chevron" aria-hidden="true">${icon('chevronRight')}</span>
      </button>
      ${fileActionButton('file.export', 'Export readable data…', local && capabilities.export && state.session.entities.length !== 0, 'Write the stored values to a readable file.', 'export')}
      ${fileActionButton('file.backup', 'Create backup…', local && capabilities.backup, 'Save a recovery copy of this file.', 'backup')}
      ${fileActionButton('file.restore', 'Restore backup…', local && capabilities.backup, 'Replace from a backup and retain this version.', 'history')}
      ${fileActionButton('file.inspect', 'Inspect file again', local && state.session.fileName !== null && !capabilities.mutate, 'Re-run the checks required for editing.', 'search')}
      ${state.session.findings.some(finding => finding.code === 'upgrade-required') ? fileActionButton('file.upgrade', 'Upgrade file…', local && capabilities.backup, 'Move this file to the current format.', 'health') : ''}
      ${fileActionButton('file.diagnostics', 'Save diagnostics…', local, 'Write a report you can share for support.', 'info')}
      ${fileActionButton('file.resolveRecovery', 'Review recovery…', local, 'Resolve an interrupted replacement.', 'health')}
      ${fileActionButton('session.openFile', 'Open file or backup…', client.mode !== 'unavailable', 'Choose another Nendo file to inspect.', 'open')}
    </section></div>
  </div>`;
  wireFileActions(content);
  requiredElement<HTMLButtonElement>('#recovery-data').addEventListener('click', () => { state.view = 'data'; rerender(); });
  wireBehaviourApproval(content);
}

// The panel is offered on Health, where the file's state is read, and on the Agent
// page, where the proposal that put the actions in the file was just accepted. A
// person who accepted there and found every button greyed had to guess that the
// consent lived under Health.
export function wireBehaviourApproval(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>('#approve-behaviour')?.addEventListener('click', () => void setBehaviourApproval(true));
  root.querySelector<HTMLButtonElement>('#revoke-behaviour')?.addEventListener('click', () => void setBehaviourApproval(false));
}

/**
 * Whether this file's custom views run here (ADR-0013): Running, or Off with the switch or the
 * condition that turned them off. They are off in safe mode and recovery whatever the switches say.
 */
function customViewsCard(): string {
  const extensions = state.session.extensions;
  if (extensions === null || extensions === undefined)
    return healthCard('Custom views', false, 'Off', state.session.fileName === null ? 'No file open.' : 'This host did not say whether views run.', 'surfaces');
  const count = extensions.packages.length;
  const packages = count === 0 ? 'No packages in this file.' : `${count} ${count === 1 ? 'package' : 'packages'} in this file.`;
  return extensions.run
    ? healthCard('Custom views', true, 'Running', packages, 'surfaces')
    : healthCard('Custom views', false, 'Off', `${offReasonSentence(extensions.offReason)} ${packages}`, 'surfaces');
}

export function healthCard(title: string, ok: boolean, state: string, detail: string, glyph: IconName): string {
  return `<section class="health-card ${ok ? 'is-ok' : 'is-off'}">
    <span class="health-symbol" aria-hidden="true">${icon(ok ? 'check' : 'alert')}</span>
    <div class="health-card-body"><h2>${escapeHtml(title)}</h2><strong class="health-state">${escapeHtml(state)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div>
    <span class="health-card-glyph" aria-hidden="true">${icon(glyph)}</span>
  </section>`;
}

export async function refreshHealth(): Promise<void> {
  if (state.actionInFlight || client.mode === 'unavailable') return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    if (state.session.capabilities.mutate) {
      try { await client.request('health.verify'); }
      catch (error) { if (!(error instanceof WorkbenchHostError) || error.code !== 'recovery-required') throw error; }
    }
    const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
    const changed = state.session.fileSessionId !== refreshed.fileSessionId;
    state.session = refreshed;
    if (changed) resetFileView();
    if (!state.session.capabilities.mutate) { state.proposal = null; state.agentProposal = null; }
    state.view = 'health';
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
 * Records or withdraws this device's approval for the open file's automatic actions.
 *
 * Deliberately not a mutation: it writes device state, not the file, so it does not
 * go through the save path, cannot be retried under an idempotency key, and never
 * appears in the file's history. What it does change is whether editing is offered
 * at all, so the whole view is re-read afterwards rather than patched.
 */
export async function setBehaviourApproval(approve: boolean): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.session = await client.request<DesktopSessionView>(approve ? 'behaviour.approve' : 'behaviour.revoke');
    rerender();
    announce(approve ? 'Automatic actions approved.' : 'Approval withdrawn.');
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

