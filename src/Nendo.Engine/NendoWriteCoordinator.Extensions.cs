using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    /// <summary>
    /// One file of a custom-view package with its bytes, or null when the file carries no such
    /// package or path. Definition, so it is readable whenever the definition is; what a file
    /// in recovery may run is for the host to say, not this read.
    /// </summary>
    public async Task<NendoExtensionFileContent?> ReadExtensionFileAsync(string packageId, string path, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageId);
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (!NendoExtensionContent.ValidPackageId(packageId) || !NendoExtensionContent.ValidPath(path)) return null;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            return await GetStore().ReadExtensionFileAsync(packageId, path, null, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Part of one package file as a waiting proposal would leave it (review R-017), read from the
    /// copy the proposal was validated on, never from the active file. Only a file the proposal
    /// adds or replaces, and only while the proposal is the one reviewed: a digest other than
    /// its reviewed digest is refused, so a review never reads bytes it is not accepting.
    /// </summary>
    public async Task<NendoProposalFileWindow> ReadProposalPackageFileAsync(
        string proposalId, string reviewedDigest, string packageId, string path, long offset, int length,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(proposalId);
        ArgumentException.ThrowIfNullOrWhiteSpace(reviewedDigest);
        if (!NendoExtensionContent.ValidPackageId(packageId) || !NendoExtensionContent.ValidPath(path))
            throw new NendoValidationException("Name a package and a path that the proposal changes.");
        if (offset < 0 || length < 1 || length > NendoExtensionLimits.ProposalFileWindowBytes)
            throw new NendoValidationException($"Read from offset 0 or later, 1 to {NendoExtensionLimits.ProposalFileWindowBytes} bytes at a time.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var context = GetProposal(proposalId);
            if (context.State != NendoProposalState.Previewable)
                throw new NendoPreconditionException("proposal-not-previewable", "Only a proposal waiting for review can be read this way.");
            if (!string.Equals(context.ReviewedDigest, reviewedDigest, StringComparison.Ordinal))
                throw new NendoIdempotencyConflictException("The proposal is no longer the one reviewed. Review the current proposal before reading it.");
            if (!context.PackageChanges.Any(change => change.PackageId == packageId && change.Path == path && change.Change != "removed"))
                throw new NendoValidationException($"The proposal does not add or change {path} in {packageId}.");
            var clonePath = Path.Combine(context.WorkspacePath, "proposal.nendo");
            await using var clone = await SqliteNendoStore.OpenAsync(clonePath, cancellationToken);
            var file = await clone.ReadExtensionFileAsync(packageId, path, null, cancellationToken)
                ?? throw new NendoPreconditionException("proposal-file-missing", $"The proposal's copy no longer holds {path}. Review the proposal again.");
            var start = (int)Math.Min(offset, file.Content.LongLength);
            var count = Math.Min(length, file.Content.Length - start);
            return new NendoProposalFileWindow(proposalId, context.ReviewedDigest, packageId, path, file.MediaType, file.Sha256,
                file.Content.LongLength, start, file.Content.AsSpan(start, count).ToArray());
        }
        finally { _gate.Release(); }
    }

    /// <summary>A view's kept values (ADR-0013 Phase 3): one key's, or every key with its version.</summary>
    public async Task<IReadOnlyList<NendoExtensionStateEntry>> ReadExtensionStateAsync(
        string packageId, string viewId, string? key, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(viewId);
        if (!NendoExtensionContent.ValidPackageId(packageId)) return [];
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            return await GetStore().ReadExtensionStateAsync(packageId, viewId, key, null, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }
}
