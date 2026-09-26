import { refreshAfterOutcome, showOutcomeRefreshNotice } from './actions';
import { state } from './app-state';
import { client } from './client';
import { escapeHtml, isProposalPreviewable, messageFor, proposalAuthorLine, proposalStateLabel, reversibilityLabel } from './format';
import { type ApplicationPlan, type DesktopPromotionView, type OverviewPlan, type ProposalPreview } from './host';
import { packageChangesMarkup } from './package-diff-markup';
import { announce, content, requiredElement, rerender, setBusy, showError, showOutcome } from './shell';
import { landAddedView } from './view-packages';
import { surfaceTitle } from './surface-model';
import { renderSurfacePreview } from './surface-preview';
/**
 * Studio's proposal review: what a change set builds, shown against a validated
 * clone. The active file is untouched until the owner accepts, and accepting
 * replays the validated operations rather than swapping the clone in.
 */

export function renderProposal(): void {
  const preview = state.proposal!;
  const plan = preview.previewApplications?.[0] ?? null;
  content.innerHTML = `<div class="proposal-page" data-testid="proposal-review">
    <header class="proposal-heading"><button id="close-proposal" class="text-button" type="button" data-dismiss>Back</button><span class="proposal-state">${escapeHtml(proposalStateLabel(preview.state))}</span><h2>${escapeHtml(preview.title)}</h2><p>${escapeHtml(proposalAuthorLine(preview, state.session.extensions?.packages ?? []))}</p></header>
    <div class="message-slot" role="alert" hidden></div>
    <div class="proposal-layout">
      <section class="proposal-changes"><h3>What changes</h3>${preview.semanticDiff.map((entry) => `<article><span class="change-mark" aria-hidden="true">＋</span><div><strong>${escapeHtml(entry.summary)}</strong><p>${escapeHtml(reversibilityLabel(entry.reversibility))}</p></div></article>`).join('')}${packageChangesMarkup(preview.packageChanges)}</section>
      <aside class="proposal-summary"><h3>Preview</h3>${plan === null ? isProposalPreviewable(preview.state) ? (preview.packageChanges?.length ?? 0) > 0 ? (preview.packageChanges ?? []).every((change) => change.change === 'removed') ? '<p>Validated. Accepting takes this code out of the file; a view that uses the package then says its package is missing.</p>' : '<p>Validated. Read the code beside this panel: once you accept, it runs wherever a screen or a record page shows its view.</p>' : '<p>Validated for Studio. Review the field and record changes beside this panel. No custom surface is added.</p>' : '<p>No healthy preview is available.</p>' : `<dl><div><dt>Record type</dt><dd>${escapeHtml(plan.entity.displayName)}</dd></div><div><dt>Screen</dt><dd>${escapeHtml(surfaceTitle(plan) ?? '')}</dd></div><div><dt>Operations</dt><dd>${preview.operationCount}</dd></div></dl><p>Explore the read-only screen preview below.</p>`}
        <div class="proposal-actions"><button id="reject-proposal" class="secondary-button" data-action type="button">Reject</button><button id="accept-proposal" class="primary-button" data-action type="button" ${!isProposalPreviewable(preview.state) ? 'disabled' : ''}>Accept changes</button></div>
        ${preview.diagnostics.map((item) => `<p class="proposal-diagnostic">${escapeHtml(item.message)} ${escapeHtml(item.hint)}</p>`).join('')}
      </aside>
    </div>
  </div>`;
  attachScreenPreview(preview.previewApplications ?? [], preview.previewRecordCounts, preview.previewOverview ?? null);
  requiredElement<HTMLButtonElement>('#close-proposal').addEventListener('click', () => { state.proposal = null; state.view = state.proposalReturnView; rerender(); });
  requiredElement<HTMLButtonElement>('#reject-proposal').addEventListener('click', () => void rejectProposal());
  requiredElement<HTMLButtonElement>('#accept-proposal').addEventListener('click', () => void promoteProposal());
}

export function attachScreenPreview(
  plans: ApplicationPlan[],
  counts?: Record<string, number>,
  overview: OverviewPlan | null = null,
): void {
  const root = document.createElement('section'); root.className = 'proposal-live-preview';
  content.querySelector('.proposal-page')?.append(root);
  renderSurfacePreview(root, plans, counts, overview);
}

export async function promoteProposal(): Promise<void> {
  if (state.proposal === null || state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const acceptedTitle = state.proposal.title;
    const result = await client.request<DesktopPromotionView>('proposal.promote', {
      proposalId: state.proposal.proposalId, expectedOperationDigest: state.proposal.operationDigest,
    });
    if (result.session !== null) state.session = result.session;
    if (!result.promotion.applied) {
      state.proposal = await client.request<ProposalPreview>('proposal.get', { proposalId: state.proposal.proposalId });
      rerender();
      showError(result.promotion.message);
      return;
    }
    // A proposal that only brings code goes back to where it began: Use, where its view now
    // runs, or Studio's Custom views panel.
    const codeOnly = !state.proposal.previewApplications?.length && (state.proposal.packageChanges?.length ?? 0) > 0;
    // A view's own proposal goes back to the view, which is still running there (ADR-0013 Phase 3).
    const fromView = state.proposal.origin?.startsWith('extension:') === true;
    state.view = fromView || codeOnly ? state.proposalReturnView : state.proposal.previewApplications?.length ? 'use' : 'data';
    // A view the Add view form made lands the person on it, or names where it is (W-062).
    const landed = landAddedView(state.proposal.proposalId);
    state.proposal = null;
    const notice = await refreshAfterOutcome(result);
    rerender();
    const outcome = landed === null ? `${acceptedTitle} accepted.` : `${acceptedTitle} accepted. ${landed}`;
    announce(outcome);
    if (notice !== null) showOutcomeRefreshNotice(outcome, notice);
    else if (landed !== null) showOutcome(outcome);
  } catch (error) {
    rerender();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

export async function rejectProposal(): Promise<void> {
  if (state.proposal === null || state.actionInFlight) return;
  state.actionInFlight = true;
  setBusy(true);
  try {
    const result = await client.request<DesktopPromotionView>('proposal.reject', { proposalId: state.proposal.proposalId });
    if (result.session !== null) state.session = result.session;
    state.proposal = null;
    state.view = state.proposalReturnView;
    rerender();
    announce(result.promotion.message);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

