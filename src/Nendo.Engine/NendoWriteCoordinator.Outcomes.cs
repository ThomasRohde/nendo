using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private static void RequireReviewedDigest(string? expected, string actual)
    {
        if (expected is null) return; // Compatibility callers predate bound preview acceptance.
        if (expected.Length != 64 || expected.Any(value => !char.IsAsciiHexDigit(value)))
            throw new NendoValidationException("The reviewed proposal digest is invalid.");
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
            throw new NendoIdempotencyConflictException("The proposal content does not match the reviewed digest. Review the current proposal before accepting it.");
    }

    public async Task<NendoApplyResult?> GetMutationReceiptAsync(
        NendoOperationIdentity identity, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(identity);
        identity.Validate();
        await _gate.WaitAsync(cancellationToken);
        try { return await GetStore().GetMutationReceiptAsync(identity, _authority!, cancellationToken); }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoChangeSetApplyResult?> GetProposalReceiptAsync(
        string proposalId, CancellationToken cancellationToken = default)
    {
        ProposalWorkspace.ValidateId(proposalId);
        await _gate.WaitAsync(cancellationToken);
        try { return await GetStore().GetProposalReceiptAsync(proposalId, _authority!, cancellationToken); }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    private bool MatchesChangeSetAuthority(NendoChangeSetApplyResult result, NendoAuthoritySnapshot trusted) =>
        result.Revisions.All(revision => revision.IsIdempotentReplay)
            ? trusted == _authority
            : trusted.ApplicationId == _authority!.ApplicationId && trusted.InstanceId == _authority.InstanceId &&
              trusted.DefinitionRevision == result.DefinitionRevision && trusted.DataRevision == result.DataRevision &&
              trusted.ChangeSequence == result.ChangeSequence;

    public async Task<bool> RetryProposalCleanupAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null) return true;
            _proposalCleanupPending = !ProposalWorkspace.CleanupAbandoned(_proposalRoot, _proposals.Keys.ToHashSet(StringComparer.Ordinal));
            return !_proposalCleanupPending;
        }
        finally { _gate.Release(); }
    }

    private async Task<NendoChangeSetApplyResult?> ReadProposalReceiptCoreAsync(
        SqliteNendoStore store, string proposalId, CancellationToken cancellationToken)
    {
        try { return await store.GetProposalReceiptAsync(proposalId, _authority!, cancellationToken); }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
    }

    private async Task<NendoPromotionOutcome> FinishCommittedProposalAsync(string proposalId, NendoChangeSetApplyResult result)
    {
        if (_proposals.TryGetValue(proposalId, out var context))
        {
            context.State = NendoProposalState.Active;
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await ProposalWorkspace.PersistAsync(context, cleanup.Token); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                // The derivative may still say Applying. On restart the
                // canonical proposal audit supplies the successful receipt.
            }
            _proposals.Remove(proposalId);
        }
        var cleanupPending = !ProposalWorkspace.CleanupAbandoned(_proposalRoot, _proposals.Keys.ToHashSet(StringComparer.Ordinal));
        _proposalCleanupPending = cleanupPending;
        return new(proposalId, NendoProposalState.Active, true,
            cleanupPending
                ? "Proposal applied. Temporary proposal files still need cleanup; the saved change is intact."
                : "Proposal applied to the active file.", result) { CleanupPending = cleanupPending };
    }
}
