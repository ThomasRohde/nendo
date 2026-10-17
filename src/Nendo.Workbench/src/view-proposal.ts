import { refreshAfterOutcome, showOutcomeRefreshNotice } from './actions';
import { state } from './app-state';
import { client } from './client';
import { escapeHtml, isProposalPreviewable, messageFor, proposalAuthorLine, proposalStateLabel } from './format';
import { type ApplicationPlan, type DesktopPromotionView, type OverviewPlan, type ProposalPreview } from './host';
import { proposalConsent, proposalConsentMarkup } from './proposal-consent';
import { packageChangesMarkup } from './package-diff-markup';
import { wirePackageFileReading } from './package-file-dialog';
import { content, requiredElement, rerender, setBusy, showError, showOutcome } from './shell';
import { landAddedView } from './view-packages';
import { historyUndoNote, isStudioPrepared, packageRemovalMarkup, proposalChangesMarkup, proposalPlace, proposalPlaceMarkup, viewAfterAccepting } from './proposal-markup';
import { renderSurfacePreview } from './surface-preview';
/**
 * Studio's proposal review: what a change set builds, shown against a validated
 * clone. The active file is untouched until the owner accepts, and accepting
 * replays the validated operations rather than swapping the clone in.
 */

export function renderProposal(): void {
  const preview = state.proposal!;
  const plan = preview.previewApplications?.[0] ?? null;
  const place = proposalPlace(preview.semanticDiff, preview.previewApplications ?? [], state.session.entities);
  const consent = proposalConsent(preview.behaviour, state.session.behaviourTrust);
  content.innerHTML = `<div class="proposal-page" data-testid="proposal-review">
    <header class="proposal-heading">${isStudioPrepared(preview) ? '<button id="close-proposal" class="text-button" type="button" data-dismiss data-busy-hold title="Discard these proposed changes and go back. Nothing in the file changes.">Discard</button>' : '<button id="close-proposal" class="text-button" type="button" data-dismiss data-busy-hold>Back</button>'}<button id="leave-proposal" type="button" data-escape data-busy-hold hidden tabindex="-1">Leave the review</button><span class="proposal-state">${escapeHtml(proposalStateLabel(preview.state))}</span><h2>${escapeHtml(preview.title)}</h2><p>${escapeHtml(proposalAuthorLine(preview, state.session.extensions?.packages ?? []))}</p></header>
    <div class="proposal-layout">
      <section class="proposal-changes"><h3>What changes</h3>${proposalChangesMarkup(preview)}${packageChangesMarkup(preview.packageChanges)}</section>
      <aside class="proposal-summary"><h3>Preview</h3>${proposalConsentMarkup(consent)}${plan === null ? isProposalPreviewable(preview.state) ? (preview.packageChanges?.length ?? 0) > 0 ? (preview.packageChanges ?? []).every((change) => change.change === 'removed') ? '<p>Validated. Accepting takes this code out of the file.</p>' : '<p>Validated. Read the code beside this panel: once you accept, it runs wherever a screen or a record page shows its view.</p>' : '<p>Validated for Studio. Review the field and record changes beside this panel. No custom screen is added.</p>' : '<p>No healthy preview is available.</p>' : `${proposalPlaceMarkup(place, preview.operationCount)}<p>Explore the read-only screen preview below.</p>`}
        ${packageRemovalMarkup(preview.semanticDiff, state.session.uiNodes, state.session.entities, state.session.extensions?.packages ?? [])}${historyUndoNote(preview)}
        <div class="proposal-actions"><button id="reject-proposal" class="secondary-button" data-action type="button">Reject</button><button id="accept-proposal" class="primary-button" data-action type="button" ${!isProposalPreviewable(preview.state) || consent?.blocksAcceptance === true ? 'disabled' : ''}>Accept changes</button></div>
        ${preview.diagnostics.map((item) => `<p class="proposal-diagnostic">${escapeHtml(item.message)} ${escapeHtml(item.hint)}</p>`).join('')}
      </aside>
    </div>
  </div>`;
  attachScreenPreview(preview.previewApplications ?? [], preview.previewRecordCounts, preview.previewOverview ?? null, place.start);
  wirePackageFileReading(content, () => state.proposal === null ? null : { proposalId: state.proposal.proposalId, reviewedDigest: state.proposal.operationDigest });
  requiredElement<HTMLButtonElement>('#close-proposal').addEventListener('click', () => void discardProposal());
  requiredElement<HTMLButtonElement>('#leave-proposal').addEventListener('click', () => leaveProposal());
  requiredElement<HTMLButtonElement>('#reject-proposal').addEventListener('click', () => void rejectProposal());
  requiredElement<HTMLButtonElement>('#accept-proposal').addEventListener('click', () => void promoteProposal());
}

export function attachScreenPreview(
  plans: ApplicationPlan[],
  counts?: Record<string, number>,
  overview: OverviewPlan | null = null,
  start: { entityId: string; surfaceId: string | null } | null = null,
): void {
  const root = document.createElement('section'); root.className = 'proposal-live-preview';
  content.querySelector('.proposal-page')?.append(root);
  renderSurfacePreview(root, plans, counts, overview, start);
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
    // A view the Add view form made lands the person on it, or names where it is (W-062).
    const landing = landAddedView(state.proposal.proposalId);
    const landed = landing?.sentence ?? null;
    state.view = viewAfterAccepting({ returnView: state.proposalReturnView, buildsScreens: (state.proposal.previewApplications?.length ?? 0) > 0,
      hadScreens: (state.compilation?.applications?.length ?? 0) > 0, fromView, codeOnly, landsOn: landing?.view ?? null });
    state.proposal = null;
    const notice = await refreshAfterOutcome(result);
    rerender();
    const outcome = landed === null ? `${acceptedTitle} accepted.` : `${acceptedTitle} accepted. ${landed}`;
    if (notice !== null) showOutcomeRefreshNotice(outcome, notice);
    else showOutcome(outcome);
  } catch (error) {
    rerender();
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

/**
 * Escape on the review: leave it without rejecting. A package import or update would need the
 * native picker again, and a key pressed by mistake should cost nothing, so the proposal stays
 * the review's and the trail's Back returns to it.
 */
export function leaveProposal(): void {
  if (state.proposal === null || state.actionInFlight) return;
  const { title } = state.proposal;
  state.view = state.proposalReturnView;
  rerender();
  showOutcome(`${title} is still waiting. Back returns to its review.`);
}

/**
 * The review's Discard. A proposal Studio prepared stayed in the host after Back, with its copy
 * of the file, where nothing in Studio could reach it, and the trail then called it no longer
 * waiting (UIT-10). Discard rejects it and says so; preparing it again is one press on the page
 * it came from. Only a proposal Studio itself prepared is rejected: a custom view's waits for the
 * view (ADR-0013), and an agent's is rejected only on the Agent page, which asks first (UX-24).
 */
export async function discardProposal(): Promise<void> {
  if (state.proposal === null || state.actionInFlight) return;
  if (!isStudioPrepared(state.proposal)) { state.proposal = null; state.view = state.proposalReturnView; rerender(); return; }
  state.actionInFlight = true;
  setBusy(true);
  const { proposalId, title } = state.proposal;
  try {
    const result = await client.request<DesktopPromotionView>('proposal.reject', { proposalId });
    if (result.session !== null) state.session = result.session;
    state.proposal = null;
    state.view = state.proposalReturnView;
    rerender();
    showOutcome(`${title} discarded. Nothing in the file changed.`);
  } catch (error) {
    // Back still leaves: the person asked to, and the review cannot be accepted from here either.
    state.proposal = null;
    state.view = state.proposalReturnView;
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
    showOutcome(result.promotion.message);
  } catch (error) {
    showError(messageFor(error));
  } finally {
    state.actionInFlight = false;
    setBusy(false);
  }
}

