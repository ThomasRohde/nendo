using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    // The life of a prepared proposal: reading it back, rejecting it, promoting it,
    // and compensating a revision afterwards. Promotion replays the validated
    // operations against the active file; it never replaces that file with the clone
    // the proposal was validated against.
    internal async Task<NendoProposalPreview> GetProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return GetProposal(proposalId).ToPreview();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Every proposal this session holds, in no particular order.</summary>
    internal async Task<IReadOnlyList<NendoProposalPreview>> ListProposalsAsync(
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            RequireTrustedSession();
            return _proposals.Values.Select(context => context.ToPreview()).ToArray();
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoPromotionOutcome> RejectProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var committed = await ReadProposalReceiptCoreAsync(GetStore(), proposalId, cancellationToken);
            if (committed is not null) return await FinishCommittedProposalAsync(proposalId, committed);
            var context = GetProposal(proposalId);
            context.State = NendoProposalState.Rejected;
            await ProposalWorkspace.PersistAsync(context, cancellationToken);
            ProposalWorkspace.Delete(context);
            _proposals.Remove(proposalId);
            return new NendoPromotionOutcome(
                proposalId,
                NendoProposalState.Rejected,
                false,
                "Proposal rejected; the active file was not changed.",
                null);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoPromotionOutcome> PromoteProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default,
        string? expectedOperationDigest = null)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var store = GetStore();
            var committed = await ReadProposalReceiptCoreAsync(store, proposalId, cancellationToken);
            if (committed is not null)
            {
                RequireReviewedDigest(expectedOperationDigest, committed.ChangeSetDigest);
                return await FinishCommittedProposalAsync(proposalId, committed);
            }
            var context = GetProposal(proposalId);
            RequireReviewedDigest(expectedOperationDigest, context.ReviewedDigest);
            if (context.State != NendoProposalState.Previewable)
            {
                return new NendoPromotionOutcome(
                    proposalId,
                    context.State,
                    false,
                    "Only a previewable proposal can be applied.",
                    null);
            }
            if (_recoveryRequired || _authority is null)
            {
                throw new NendoRecoveryRequiredException(
                    "The coordinator does not trust the active file enough to promote a proposal.");
            }
            var currentAuthority = await store.GetAuthoritySnapshotAsync(cancellationToken);
            if (currentAuthority != _authority)
            {
                EnterRecovery();
                throw new NendoRecoveryRequiredException(
                    "The active file changed outside the coordinator while the proposal was open.");
            }

            var active = await store.GetSessionSnapshotAsync(FileName, Health, cancellationToken);
            if (active.Manifest.ApplicationId != context.SourceApplicationId ||
                active.Manifest.InstanceId != context.SourceInstanceId ||
                active.Manifest.DefinitionRevision != context.CapturedDefinitionRevision ||
                TouchedRecordChanged(context.TouchedRecords, active) ||
                // Records a condition merely read are checked too. A total that was
                // right when it was reviewed is not right any more if one of the
                // records it counted has changed since, even though nothing this
                // proposal writes to has moved.
                TouchedRecordChanged(context.BehaviourPlan.ReadSet, active) ||
                // And a record created since the review changes a count without
                // changing any record the review looked at, which no per-record
                // version can notice.
                (!context.BehaviourPlan.IsEmpty && active.Manifest.DataRevision != context.BehaviourPlan.DataRevision))
            {
                context.State = NendoProposalState.Stale;
                context.Diagnostics = [new("NPROP003", NendoDiagnosticSeverity.Error,
                    "The active definition or a touched record changed.", null, null,
                    "Reject this stale proposal and prepare a new proposal against the current file.")];
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
                return new NendoPromotionOutcome(
                    proposalId,
                    NendoProposalState.Stale,
                    false,
                    "The active definition or a touched record changed; prepare a new proposal.",
                    null);
            }
            if (!string.Equals(context.ChangeSet.OperationDigest, context.OperationDigest, StringComparison.Ordinal))
            {
                context.State = NendoProposalState.Failed;
                context.Diagnostics = [new("NPROP004", NendoDiagnosticSeverity.Error,
                    "The proposal operation digest no longer matches its validated evidence.", null, null,
                    "Reject this proposal and prepare a new validated proposal.")];
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
                return new NendoPromotionOutcome(
                    proposalId,
                    NendoProposalState.Failed,
                    false,
                    "The proposal operation digest no longer matches its validated evidence.",
                    null);
            }

            // The reviewed plan is loaded from the workspace rather than trusted from
            // memory, so a proposal reviewed in one session promotes the same way in
            // the next one, and a workspace somebody edited refuses instead of
            // promoting something nobody approved.
            var reviewedPlan = await ProposalWorkspace.ReadPlanAsync(context.WorkspacePath, cancellationToken);
            if (reviewedPlan.Digest() != context.BehaviourPlan.Digest())
            {
                context.State = NendoProposalState.Failed;
                context.Diagnostics = [new("NPROP005", NendoDiagnosticSeverity.Error,
                    "The reviewed plan for this proposal no longer matches what was approved.", null, null,
                    "Reject this proposal and prepare a new validated proposal.")];
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
                return new NendoPromotionOutcome(
                    proposalId,
                    NendoProposalState.Failed,
                    false,
                    "The reviewed plan for this proposal no longer matches what was approved.",
                    null);
            }

            // Promotion replays the reviewed effects instead of re-running the
            // triggers, so the chain's own consent gate never fires here. Without this
            // check a proposal would be a way to apply automatic effects this device
            // never agreed to. The revocation generation is read before the grant is
            // checked, exactly as the single-write path reads it when a chain is
            // admitted: the commit boundary compares against it, so approval withdrawn
            // and given again anywhere after this line still aborts, rather than only
            // if it happened after the store began its transaction.
            var reviewedRevocationGeneration = _behaviourAuthority.RevocationGeneration;
            if (reviewedPlan.Generated.Count > 0 &&
                (reviewedPlan.RequiredGrant is not { } candidate || !_behaviourAuthority.IsGranted(candidate)))
            {
                return await NotApprovedAsync();
            }

            context.State = NendoProposalState.Applying;
            await ProposalWorkspace.PersistAsync(context, cancellationToken);
            NendoChangeSetApplyResult committedResult;
            try
            {
                // Exactly what was reviewed, with expansion off. Running the triggers
                // again here would stack fresh effects on top of the reviewed ones. The
                // reviewed plan travels with it so the commit boundary can re-check
                // consent — a replay never runs the chain's own gate — and so the
                // generated operations keep their attribution.
                var (result, trusted) = await store.ApplyChangeSetAsync(
                    WithReviewedEffects(context.ChangeSet, reviewedPlan),
                    _authority,
                    proposalId,
                    BeforeProposalCommit,
                    cancellationToken,
                    BeforeCommitAuthorityRead,
                    reviewedPlan: reviewedPlan,
                    reviewedRevocationGeneration: reviewedRevocationGeneration);
                if (!MatchesChangeSetAuthority(result, trusted))
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException(
                        "The promoted result did not match the coordinator authority snapshot.");
                }
                _authority = trusted;
                committedResult = result;
            }
            catch (NendoRecoveryRequiredException)
            {
                throw;
            }
            catch (NendoPreconditionException exception) when (exception.Code == "behaviour-not-approved")
            {
                // Withdrawn at the commit boundary is the same refusal as withdrawn before
                // it. The proposal is still exactly what was reviewed and nothing was
                // written, so it stays previewable and can be accepted once the actions
                // are approved again. Letting it fall through to the general handler
                // marked it Failed, and the next Accept after re-approving was refused
                // with "only a previewable proposal can be applied".
                return await NotApprovedAsync();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                // Storage returns its receipt/authority together only after
                // commit. An interrupted precommit attempt can use the same
                // validated proposal and request identities on retry.
                context.State = NendoProposalState.Previewable;
                throw;
            }
            catch (Exception exception) when (exception is NendoException or InvalidOperationException)
            {
                context.State = NendoProposalState.Failed;
                // The reason the active file gave is carried through rather than replaced.
                // Without it a proposal refused because the file has reached the size it
                // can still be opened at reads as "the active file rejected the proposal",
                // and a person is left with a bound that does not say where it came from —
                // which is the defect F-043 records, arriving by a different route.
                context.Diagnostics = new[]
                {
                    new NendoCompilerDiagnostic(
                        "NPROP002",
                        NendoDiagnosticSeverity.Error,
                        $"The active file rejected the proposal; no proposed change was committed. {exception.Message}",
                        null,
                        null,
                        "Review the retained proposal evidence or prepare it again."),
                };
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
                return new NendoPromotionOutcome(
                    proposalId,
                    NendoProposalState.Failed,
                    false,
                    $"Proposal application failed; the active file is unchanged. {exception.Message}",
                    null);
            }
            // From this point the immutable database receipt is authoritative.
            // Derivative failures must never be caught as a failed transaction.
            //
            // A promoted definition can install this file's first trigger, and what a
            // file requires is cached here. Without reading it again the store would
            // refuse every edit while the shell reported nothing to approve, and the
            // only way out would be closing and reopening the file.
            if (context.ChangeSet.Mutations.Any(mutation => mutation.Operations[0].Lane == NendoRevisionLane.Definition))
                await RefreshBehaviourRequirementAsync(cancellationToken);
            if (!committedResult.Revisions.All(revision => revision.IsIdempotentReplay))
            { AfterCommit?.Invoke(); Committed?.Invoke(committedResult.ChangeSequence); }
            return await FinishCommittedProposalAsync(proposalId, committedResult);

            async Task<NendoPromotionOutcome> NotApprovedAsync()
            {
                context.State = NendoProposalState.Previewable;
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
                return new NendoPromotionOutcome(
                    proposalId,
                    NendoProposalState.Previewable,
                    false,
                    "This proposal's automatic actions have not been approved on this device. Review what they do and approve them before accepting.",
                    null);
            }
        }
        catch (NendoRecoveryRequiredException)
        {
            EnterRecovery();
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoApplyResult> CompensateRevisionAsync(
        string revisionId,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(revisionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var store = GetStore();
            if (_recoveryRequired || _authority is null)
            {
                throw new NendoRecoveryRequiredException(
                    "The coordinator does not trust the active file enough to create a compensation.");
            }
            var mutation = await store.CreateCompensationMutationAsync(
                revisionId,
                idempotencyKey,
                cancellationToken);
            try
            {
                var (result, trusted) = await store.ApplyAsync(
                    mutation,
                    _authority,
                    cancellationToken,
                    revisionId,
                    BeforeCommitAuthorityRead);
                if (!MatchesMutationAuthority(result, trusted))
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException(
                        "The compensation result did not match the coordinator authority snapshot.");
                }
                _authority = trusted;
                // Reversing a definition changes what this file's actions do, so the
                // consent given for the old ones no longer describes it. What the file
                // requires is read again rather than carried over.
                if (mutation.Operations[0].Lane == NendoRevisionLane.Definition)
                    await RefreshBehaviourRequirementAsync(cancellationToken);
                if (!result.IsIdempotentReplay) { AfterCommit?.Invoke(); Committed?.Invoke(result.ChangeSequence); }
                return result;
            }
            catch (NendoRecoveryRequiredException)
            {
                EnterRecovery();
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }
}
