import { openHelp, refreshAfterOutcome, showOutcomeRefreshNotice } from './actions';
import { state } from './app-state';
import { client } from './client';
import { type ConnectionClient, connectionClients, connectionCommand } from './client-help';
import { activityLabel, agentModeLabel, escapeAttribute, escapeHtml, formatDateTime, isAgentAccessMode, isProposalPreviewable, messageFor, proposalStateLabel, reversibilityLabel, reviewKindLabel, shortId } from './format';
import { type AgentAccessMode, type AgentActivity, type AgentPreviewSummary, type AgentProposalPreview, type AgentStatus, type DesktopPromotionView, type ProposalPreview } from './host';
import { announce, clearError, content, requiredElement, rerender, setBusy, showError, showOutcome } from './shell';
import { applicationPlans, overviewPlan } from './plan-selection';
import { addedSurfaceSentence } from './surface-model';
import { behaviourApprovalMarkup, refreshHealth, wireBehaviourApproval } from './view-health';
import { attachScreenPreview } from './view-proposal';
/**
 * Agent access: what this device has granted, where an agent connects, what it
 * has been doing, and the review of anything it proposes.
 *
 * The owner sets the access level here and nothing else can raise it. A proposal
 * an agent prepares leaves the active file alone until it is accepted on this
 * screen.
 */

/**
 * What the ladder says about itself, which depends on which rung is standing.
 *
 * The fixed sentence claimed the person reviews every proposed change. At Unattended
 * they review none, so the panel was telling them the opposite of what the level beside
 * it was doing -- on the one screen whose whole job is to say what has been given away.
 */
function ladderIntro(mode: AgentAccessMode): string {
  return mode === 'unattended'
    ? 'Higher levels include the abilities before them. At Unattended you review nothing: '
      + 'an agent accepts its own changes and its automatic actions run. Lower the level '
      + 'when the building is done.'
    : 'Higher levels include the abilities before them. You review every proposed app '
      + 'change, unless you choose the level that stops asking.';
}

export function renderAgent(): void {
  const status = state.agentStatus;
  if (status === null) {
    content.innerHTML = '<div class="studio-page"><p>Agent access status is unavailable.</p></div>';
    return;
  }
  const modes: Array<{ value: AgentAccessMode; label: string; short: string }> = [
    { value: 'off', label: 'Off', short: 'No connections' },
    { value: 'inspect', label: 'Inspect', short: 'Read this workspace' },
    { value: 'editData', label: 'Edit data', short: 'Change records' },
    { value: 'shapeApp', label: 'Shape app', short: 'Propose structure and surfaces' },
    { value: 'unattended', label: 'Unattended', short: 'Accept and run its own changes' },
  ];
  const modeLabel = modes.find((mode) => mode.value === status.mode)?.label ?? 'Off';
  // The live pane opens with the state as its title. The pill repeats it in one word so the
  // colour carries the same meaning as on Health.
  const heading = ((): { title: string; detail: string; chip: string } => {
    switch (status.state) {
      case 'ready': return status.mode === 'unattended'
        ? { title: 'Unattended: an agent decides for you', detail: 'An agent may change this file\u2019s shape and run its automatic actions without asking. This ends when you lower the level or close the file.', chip: 'Unattended' }
        : { title: 'Ready for local agents', detail: `${modeLabel} is on while this file is open. Editing is granted to one agent at a time.`, chip: 'Ready' };
      case 'off': return { title: 'Agent access is off', detail: 'Choose an access level to let a local agent connect while this file is open.', chip: 'Off' };
      case 'recoveryRequired': return { title: 'Unavailable during recovery', detail: 'Agent access returns once this file is healthy again. See Health.', chip: 'Recovery' };
      case 'readOnly': return { title: 'Open read-only', detail: 'Agents cannot connect while this file is open read-only.', chip: 'Read-only' };
      case 'noFile': return { title: 'No file open', detail: 'Open a file to let local agents connect to it.', chip: 'No file' };
      default: return { title: 'Agent access unavailable', detail: 'Local agent access is not available in this session.', chip: 'Unavailable' };
    }
  })();
  const pendingCount = status.pendingProposals.length;
  content.innerHTML = `<div class="agent-page" data-testid="agent-access">
    <aside class="agent-controls" aria-label="Agent access settings">
      <section class="permission-ladder" aria-labelledby="permission-title">
        <div class="permission-intro"><h2 id="permission-title">Access level</h2><p>${escapeHtml(ladderIntro(status.mode))}</p></div>
        <div class="permission-track" role="group" aria-label="Agent access level">
          ${modes.map((mode, index) => `<button class="permission-step" type="button" data-agent-mode="${mode.value}" aria-pressed="${status.mode === mode.value}" ${!status.available ? 'disabled' : ''}><span class="step-marker" aria-hidden="true">${index + 1}</span><span class="step-text"><strong>${mode.label}</strong><small>${mode.short}</small></span></button>`).join('')}
        </div>
      </section>
      <section class="agent-connection" aria-labelledby="connection-title">
        <div class="permission-intro"><h2 id="connection-title">Connection</h2></div>
        <div class="connection-endpoint"><span class="presence-label">Address</span><code id="agent-endpoint">${status.endpoint === null ? 'Shown while agent access is on' : escapeHtml(status.endpoint)}</code><small>No credential. Register it with your client once.</small><div class="connection-copy">${connectionClients.map((item) => `<button class="secondary-button" data-connection-client="${item.id}" data-action type="button" ${status.endpoint === null ? 'disabled' : ''}>${escapeHtml(item.label)}</button>`).join('')}</div></div>
        ${status.usingPreferredPort ? '' : `<p class="connection-warning">Port ${status.portPreference} was in use. Nendo is listening on a temporary port for this session, so a pinned client address must be re-read from the connection entry.</p>`}
        <div class="connection-settings">
          <div class="connection-setting">
            <button class="connection-toggle" type="button" data-agent-setting="fixedPort" aria-pressed="${status.fixedPort}" ${!status.available ? 'disabled' : ''}><span class="switch-glyph" aria-hidden="true"></span><span class="toggle-text"><strong>Fixed port</strong><small>${status.fixedPort ? 'A saved client address keeps working' : 'A new port each time this starts'}</small></span></button>
            <label class="connection-field"><span>Port</span><input id="agent-port" type="number" min="1024" max="65535" value="${status.portPreference}" ${!status.fixedPort || !status.available ? 'disabled' : ''}></label>
          </div>
          <div class="connection-setting">
            <button class="connection-toggle" type="button" data-agent-setting="leaseExpiry" aria-pressed="${status.leaseExpiry}" ${!status.available ? 'disabled' : ''}><span class="switch-glyph" aria-hidden="true"></span><span class="toggle-text"><strong>Lease expiry</strong><small>${status.leaseExpiry ? 'Editing lapses without renewal' : 'Editing ends only on release or revoke'}</small></span></button>
            <label class="connection-field"><span>Seconds</span><input id="agent-lease-seconds" type="number" min="15" max="86400" value="${status.leaseExpirySeconds}" ${!status.leaseExpiry || !status.available ? 'disabled' : ''}></label>
          </div>
        </div>
        <p class="connection-note">These are the local defaults. Harden any of them if this machine is shared.${status.settingsPersisted ? '' : ' Settings could not be saved for the next launch.'}</p>
      </section>
      <p class="agent-help-entry"><span>New to agent access?</span><button id="agent-help" class="text-button" type="button">Learn how to connect with MCP</button><button id="agent-help-access" class="text-button" type="button">What an agent can see and do</button></p>
    </aside>
    <div class="agent-live">
      <div class="message-slot" role="alert" hidden></div>
      <header class="agent-heading"><div><h2>${escapeHtml(heading.title)}</h2><p>${escapeHtml(heading.detail)}</p></div><span class="agent-ready ${status.state}"><span aria-hidden="true"></span>${escapeHtml(heading.chip)}</span></header>
      ${behaviourApprovalMarkup()}
      <section class="agent-presence" aria-label="Recent agent activity and edit access">
        <div><span class="presence-label">Most recent agent</span><strong>${escapeHtml(status.connectedAgent ?? 'No activity yet')}</strong><small>${status.connectedAgent === null ? 'Shown after the first request' : 'Available only while this file is open'}</small></div>
        <div><span class="presence-label">Editing owner</span><strong>${escapeHtml(status.editingOwner ?? 'No edit lease')}</strong><small>${status.editingOwner === null ? 'Editing is granted to one agent at a time' : status.leaseExpiresAt === null ? 'Does not expire · use Revoke edit access to end it' : `Expires ${escapeHtml(formatDateTime(status.leaseExpiresAt))}`}</small></div>
        <button id="revoke-agent" class="secondary-button" data-action type="button" ${status.editingOwner === null ? 'disabled' : ''}>Revoke edit access</button>
      </section>
      <section class="pending-changes"><header><h3>Pending changes</h3><span class="${pendingCount === 0 ? '' : 'pending-badge'}">${pendingCount === 0 ? 'None waiting' : `${pendingCount} waiting`}</span></header>${pendingCount === 0
        ? '<div class="quiet-state"><strong>No changes waiting</strong><p>Agent proposals appear here for your review.</p></div>'
        : status.pendingProposals.map((pending) => `<article><span class="proposal-spark" aria-hidden="true">✦</span><div><strong>${escapeHtml(pending.title)}</strong><p>${pending.operationCount} proposed changes · ${escapeHtml(reversibilityLabel(pending.reversibility))}</p></div><button class="secondary-button" data-review-agent-proposal="${escapeAttribute(pending.proposalId)}" data-action type="button">Review changes</button></article>`).join('')}</section>
      <section class="agent-activity"><header><h3>Recent activity</h3><span>${status.recentActivity.length} shown</span></header>${activityMarkup(status.recentActivity)}</section>
    </div>
  </div>`;
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-agent-mode]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.agentMode;
      if (mode !== undefined && isAgentAccessMode(mode)) void setAgentMode(mode);
    });
  }
  for (const toggle of content.querySelectorAll<HTMLButtonElement>('[data-agent-setting]')) {
    toggle.addEventListener('click', () => {
      const key = toggle.dataset.agentSetting;
      if (key === undefined) return;
      void saveAgentSettings({ [key]: toggle.getAttribute('aria-pressed') !== 'true' });
    });
  }
  // Commit numbers on change, never on input: the status poll re-renders this panel and would otherwise
  // discard a half-typed value.
  for (const [id, key] of [['#agent-port', 'port'], ['#agent-lease-seconds', 'leaseExpirySeconds']] as const) {
    const field = content.querySelector<HTMLInputElement>(id);
    field?.addEventListener('change', () => void saveAgentSettings({ [key]: Number(field.value) }));
  }
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-connection-client]')) {
    button.addEventListener('click', () => void copyConnectionCommand(button.dataset.connectionClient as ConnectionClient));
  }
  requiredElement<HTMLButtonElement>('#agent-help').addEventListener('click', () => void openHelp('mcp'));
  requiredElement<HTMLButtonElement>('#agent-help-access').addEventListener('click', () => void openHelp('agent-access'));
  requiredElement<HTMLButtonElement>('#revoke-agent').addEventListener('click', () => void revokeAgentEditing());
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-review-agent-proposal]')) {
    button.addEventListener('click', () => void reviewAgentProposal(button.dataset.reviewAgentProposal!));
  }
  wireBehaviourApproval(content);
}

export function activityMarkup(activity: AgentActivity[]): string {
  if (activity.length === 0) {
    return '<div class="quiet-state"><strong>No activity yet</strong><p>Reads, edits and proposals will be summarized here.</p></div>';
  }
  return `<ol class="activity-list">${[...activity].reverse().map((item) => `<li><span class="activity-mark ${escapeAttribute(item.outcome)}" aria-hidden="true"></span><div><strong>${escapeHtml(activityLabel(item))}</strong><p>${escapeHtml(item.client)}${item.revisionId === null ? '' : ` · ${escapeHtml(shortId(item.revisionId))}`}</p></div><time>${escapeHtml(formatDateTime(item.timestamp))}</time></li>`).join('')}</ol>`;
}

export function renderAgentProposal(): void {
  const preview = state.agentProposal!;
  content.innerHTML = `<div class="proposal-page agent-proposal-page" data-testid="agent-proposal-review">
    <header class="proposal-heading"><button id="close-agent-proposal" class="text-button" type="button" data-dismiss>Back to Agent</button><span class="proposal-state">${escapeHtml(proposalStateLabel(preview.state))}</span><h2>${escapeHtml(preview.title)}</h2><p>An agent prepared these changes. Your active file is unchanged until you accept.</p></header>
    <div class="message-slot" role="alert" hidden></div>
    <div class="proposal-layout">
      <section class="proposal-changes"><h3>What changes</h3>${preview.semanticDiff.map((entry) => `<article><span class="change-mark" aria-hidden="true">＋</span><div><strong>${escapeHtml(entry.summary)}</strong><p>${escapeHtml(reversibilityLabel(entry.reversibility))}</p></div></article>`).join('')}${preview.diagnostics.map((item) => `<article class="proposal-diagnostic"><span class="change-mark" aria-hidden="true">!</span><div><strong>${escapeHtml(item.message)}</strong><p>${escapeHtml(item.hint)}</p></div></article>`).join('')}</section>
      <aside class="proposal-summary"><h3>What this builds</h3>${agentPreviewMarkup(preview.preview, preview.operationCount)}
        <div class="proposal-actions"><button id="reject-agent-proposal" class="secondary-button" data-action type="button">Reject</button><button id="accept-agent-proposal" class="primary-button" data-action type="button" ${!isProposalPreviewable(preview.state) || preview.diagnostics.some((item) => item.severity === 'error' || item.severity === 0) ? 'disabled' : ''}>Accept changes</button></div>
      </aside>
    </div>
  </div>`;
  if (state.agentScreenPreview?.proposalId === preview.proposalId && state.agentScreenPreview.operationDigest === preview.operationDigest)
    attachScreenPreview(state.agentScreenPreview.previewApplications ?? [], state.agentScreenPreview.previewRecordCounts,
      state.agentScreenPreview.previewOverview ?? null);
  requiredElement<HTMLButtonElement>('#close-agent-proposal').addEventListener('click', () => { state.agentProposal = null; state.view = 'agent'; rerender(); });
  requiredElement<HTMLButtonElement>('#reject-agent-proposal').addEventListener('click', () => void resolveAgentProposal(false));
  requiredElement<HTMLButtonElement>('#accept-agent-proposal').addEventListener('click', () => void resolveAgentProposal(true));
}

// Describes the proposal from what it actually builds. The previous panel read the
// four contract version 2 slots, so a version 3 proposal showed "Unavailable" in
// every row and asked a person to approve changes the UI could not name.
export function agentPreviewMarkup(summary: AgentPreviewSummary, operationCount: number): string {
  const entities = summary.entities.length === 0
    ? 'None'
    : summary.entities.map((entity) => entity.displayName).join(', ');
  // A purpose belongs to the file, so it is named here rather than left to be found
  // among the record types and screens — where it would never appear, because it has
  // neither. The row shows only when the proposal changes it.
  const purposeChanged = summary.purposeAfter !== summary.purposeBefore;
  const purposeRow = purposeChanged
    ? `<div><dt>What this file is for</dt><dd>${escapeHtml(summary.purposeAfter ?? 'Cleared')}</dd></div>`
    : '';
  const rows = `<dl>
    <div><dt>Record ${summary.entities.length === 1 ? 'type' : 'types'}</dt><dd>${escapeHtml(entities)}</dd></div>
    <div><dt>Fields</dt><dd>${summary.fieldCount}</dd></div>
    <div><dt>Screens</dt><dd>${summary.surfaces.length}</dd></div>
    <div><dt>Records</dt><dd>${summary.recordCount}</dd></div>
    ${purposeRow}
    <div><dt>Proposed changes</dt><dd>${operationCount}</dd></div>
  </dl>`;
  // Saying "structure and data only" to someone reviewing a change to what the file is
  // for describes a different proposal than the one in front of them.
  if (summary.surfaces.length === 0 && purposeChanged) return rows;
  if (summary.surfaces.length === 0) return `${rows}<p>This proposal changes structure and data only. Review it in Studio after accepting.</p>`;
  return `${rows}<ul class="proposal-surfaces">${summary.surfaces.map((surface) => {
    const entity = summary.entities.find((candidate) => candidate.entityId === surface.entityId);
    // The front page names no record type, because it is about the file. Saying so
    // is the answer; falling back to its node ID would name the wrong thing.
    const about = surface.entityId === null ? 'The whole file' : entity?.displayName ?? surface.entityId;
    // A matrix listed by kind and title alone asks someone to approve a screen without
    // saying whether it is nine cells or forty-five, and a board whose lanes come from
    // an empty record type looks like every other board until it draws nothing.
    const shape = surface.shape ? `<span class="surface-shape">${escapeHtml(surface.shape)}</span>` : '';
    return `<li><span class="surface-kind">${escapeHtml(reviewKindLabel(surface.kind))}</span>
      <strong>${escapeHtml(surface.title ?? surface.nodeId)}</strong>
      <span>${escapeHtml(about)}</span>${shape}</li>`;
  }).join('')}</ul>`;
}

/**
 * The question in front of the one level that does not ask again.
 *
 * A real dialog rather than the browser's own. The host disables those
 * (AreDefaultScriptDialogsEnabled = false) and handles none, so the browser's confirmation
 * never draws anything and reports a No. The first version of this used it, and the effect
 * was that the fifth rung of the ladder did nothing at all when it was clicked — no
 * dialog, no level change, no error (F-120). Test-Production refuses any renderer file
 * that reaches for one, which is why this comment does not write its name with brackets.
 */
function confirmUnattended(): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-delete-dialog';
    dialog.setAttribute('aria-labelledby', 'unattended-heading');
    dialog.innerHTML = `<h2 id="unattended-heading">Turn on Unattended access?</h2>
      <p>An agent will accept its own changes to this file’s record types, screens and automatic
      actions, and those actions will run — without showing them to you first.</p>
      <p>Every change is still recorded in History, and you can withdraw the approval of
      automatic actions under Health. This lasts until you lower the level or close the
      file; it is never remembered.</p>
      <div class="form-actions"><button class="secondary-button" data-cancel type="button" autofocus>Cancel</button><button class="primary-button" data-confirm type="button">Turn on Unattended</button></div>`;
    document.body.append(dialog);
    let confirmed = false;
    dialog.addEventListener('close', () => { dialog.remove(); resolve(confirmed); }, { once: true });
    dialog.querySelector('[data-cancel]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-confirm]')?.addEventListener('click', () => { confirmed = true; dialog.close(); });
    dialog.showModal();
  });
}

export async function setAgentMode(mode: AgentAccessMode): Promise<void> {
  if (state.actionInFlight || state.agentStatus?.mode === mode) return;
  // The only level with a question in front of it. Every other one is a click, because
  // every other one still ends at a review; this is the one where nobody reads the change
  // before the file takes it, and a ladder where the last rung is the same gesture as the
  // others would be a ladder somebody steps off by accident.
  if (mode === 'unattended' && !(await confirmUnattended())) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.agentStatus = await client.request<AgentStatus>('agent.setMode', { mode });
    rerender();
    announce(`${agentModeLabel(mode)} selected.`);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export type AgentSettingsChange = Partial<{
  leaseExpiry: boolean;
  leaseExpirySeconds: number;
  fixedPort: boolean;
  port: number;
}>;

export async function saveAgentSettings(change: AgentSettingsChange): Promise<void> {
  if (state.actionInFlight || state.agentStatus === null) return;
  const current = state.agentStatus;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.agentStatus = await client.request<AgentStatus>('agent.setSettings', {
      leaseExpiry: change.leaseExpiry ?? current.leaseExpiry,
      leaseExpirySeconds: change.leaseExpirySeconds ?? current.leaseExpirySeconds,
      fixedPort: change.fixedPort ?? current.fixedPort,
      port: change.port ?? current.portPreference,
    });
    rerender();
    announce('Connection settings updated.');
  } catch (error) {
    showError(messageFor(error));
    rerender();
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

// The address is the whole configuration, so the copied line is complete as it stands.
export async function copyConnectionCommand(target: ConnectionClient): Promise<void> {
  const endpoint = state.agentStatus?.endpoint;
  if (!endpoint) return;
  const command = connectionCommand(target, endpoint);
  try {
    await navigator.clipboard.writeText(command);
    announce(`Copied. Run it once in a terminal: ${command}`);
  } catch {
    announce(`Copy failed. Run this once in a terminal: ${command}`);
  }
}

export async function revokeAgentEditing(): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.agentStatus = await client.request<AgentStatus>('agent.revokeEditing');
    rerender();
    announce('Agent edit access revoked.');
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function reviewAgentProposal(proposalId: string): Promise<void> {
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  try {
    state.agentProposal = await client.request<AgentProposalPreview>('agent.getProposal', { proposalId });
    state.agentScreenPreview = await client.request<ProposalPreview>('proposal.get', { proposalId });
    state.view = 'agentProposal';
    rerender();
  } catch (error) {
    await refreshAgentStatus();
    rerender();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function resolveAgentProposal(accept: boolean): Promise<void> {
  if (state.agentProposal === null || state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  clearError();
  const title = state.agentProposal.title;
  // Taken before the proposal is cleared and before the file moves: the roots this file
  // already had are what make the new ones identifiable afterwards.
  // The front page is not one of the applications -- it belongs to the file -- so a set
  // built from those alone reports it as new every time anything is accepted.
  const surfacesBefore = new Set([
    ...applicationPlans().flatMap((plan) => (plan.surfaces ?? []).map((node) => node.semanticId)),
    ...(overviewPlan() === null ? [] : [overviewPlan()!.surface.semanticId]),
  ]);
  const previewSurfaces = state.agentProposal.preview.surfaces;
  const previewEntities = state.agentProposal.preview.entities;
  try {
    const method = accept ? 'proposal.promote' : 'proposal.reject';
    const result = await client.request<DesktopPromotionView>(method, {
      proposalId: state.agentProposal.proposalId,
      ...(accept ? { expectedOperationDigest: state.agentProposal.operationDigest } : {}),
    });
    if (result.session !== null) state.session = result.session;
    if (accept && !result.promotion.applied) {
      state.agentProposal = await client.request<AgentProposalPreview>('agent.getProposal', { proposalId: state.agentProposal.proposalId });
      rerender();
      showError(result.promotion.message);
      return;
    }
    state.agentProposal = null;
    state.view = 'agent';
    const notice = await refreshAfterOutcome(result);
    rerender();
    // Accepting a proposal that adds automatic actions turns editing off until this
    // device approves them; saying so here, beside the panel that approves, is the
    // difference between a next step and a mystery.
    const approvalNeeded = result.promotion.applied && state.session.behaviourTrust?.requiresApproval === true && !state.session.behaviourTrust.isApproved;
    // A proposal that adds a screen has added it somewhere, and saying where is the
    // difference between an outcome and a puzzle: the panel disappears, the screen is
    // behind a picker on another page, and "accepted" mentions neither.
    const whereItWent = result.promotion.applied
      ? addedSurfaceSentence(surfacesBefore, previewSurfaces, previewEntities)
      : '';
    const outcomeMessage = approvalNeeded
      ? `${title} accepted. This file now has automatic actions — approve them below before editing continues.`
      : result.promotion.applied
        ? `${title} accepted.${whereItWent === '' ? '' : ` ${whereItWent}`}`
        : result.promotion.message;
    if (notice !== null) showOutcomeRefreshNotice(outcomeMessage, notice);
    else if (result.promotion.applied) showOutcome(outcomeMessage);
    else announce(outcomeMessage);
  } catch (error) {
    rerender();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function refreshAgentStatus(): Promise<void> {
  if (!state.session.hasFile || client.mode === 'unavailable') return;
  state.agentStatus = await client.request<AgentStatus>('agent.getStatus');
  if (state.agentStatus.state === 'recoveryRequired' && state.session.health !== 'recoveryRequired') {
    // MCP can discover outside file changes without a Workbench mutation. Its
    // revoked status must not leave the renderer advertising cached write access.
    await refreshHealth();
  }
}

