using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly Dictionary<string, IdentityCopyContext> _identityCopies = new(StringComparer.Ordinal);
    internal Action? BeforeIdentityTransitionCommit { get; set; }
    internal Action<string>? BeforeIdentityCopyValidation { get; set; }
    internal Action? BeforeIdentityCopyActivation { get; set; }
    internal Action? AfterIdentityCopyActivation { get; set; }
    internal int? IdentityCopyMaximumPageCountForTest { get; set; }

    public async Task<NendoIdentityCopyPlan> PrepareIdentityCopyAsync(
        NendoIdentityCopyKind kind, string destinationPath, string requestId,
        CancellationToken cancellationToken = default)
    {
        if (!Enum.IsDefined(kind)) throw new NendoValidationException("Unknown identity-copy kind.");
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (requestId.Length > 200) throw new NendoValidationException("The copy request ID is too long.");
        var destination = ValidatePath(destinationPath);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_identityCopies.TryGetValue(requestId, out var previous))
            {
                if (previous.Intent.Kind != kind || !string.Equals(previous.Destination, destination, StringComparison.OrdinalIgnoreCase))
                    throw CopyConflict();
                return previous.Plan;
            }
            if (_identityCopies.Count >= 64)
                throw new NendoPreconditionException("copy-session-limit", "Close and reopen the source before preparing more file copies.");
            if (string.Equals(destination, _path, StringComparison.OrdinalIgnoreCase))
                throw new NendoPreconditionException("copy-source-destination", "Choose a new file for the copy.");
            if (!Directory.Exists(Path.GetDirectoryName(destination)))
                throw new DirectoryNotFoundException("The selected copy folder is no longer available.");
            var source = await InspectIdentitySourceAsync(cancellationToken);
            if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
            if (_readOnlySnapshot is not null && source.ContentDigest != _readOnlyContentDigest) throw CopySourceChanged();
            var intent = IdentityCopyIntent.Create(kind, requestId, source.Inspection.Manifest!, source.ContentDigest!, destination);
            var operation = intent.Operation(kind == NendoIdentityCopyKind.Duplicate ? intent.Source.ApplicationId : $"application-{Guid.NewGuid():N}", $"instance-{Guid.NewGuid():N}");
            var revisionId = $"revision-{Guid.NewGuid():N}";
            var createdAt = DateTimeOffset.UtcNow;
            LocalFileIdentity? existingIdentity = null;
            if (File.Exists(destination))
            {
                using var pin = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read);
                existingIdentity = LocalFileIdentity.Read(pin);
                if (existingIdentity == LocalFileIdentity.Read(_pathPin!)) throw CopyConflict();
                var existing = await SqliteNendoStore.InspectAsync(destination, cancellationToken);
                var evidence = SqliteNendoStore.FindIdentityCopyEvidence(existing, intent) ?? throw CopyConflict();
                operation = evidence.Operation;
                revisionId = evidence.Revision.RevisionId;
                createdAt = evidence.Revision.CreatedAt;
            }
            else RequireUnoccupiedBackupDestination(destination);
            var plan = new NendoIdentityCopyPlan($"copy-{Guid.NewGuid():N}", kind, Path.GetFileName(destination),
                intent.Source, operation.ResultApplicationId, operation.ResultInstanceId);
            _identityCopies.Add(requestId, new(plan, destination, intent, operation, revisionId, createdAt, _authority, existingIdentity));
            return plan;
        }
        catch (NendoRecoveryRequiredException)
        {
            EnterRecovery();
            throw;
        }
        finally { _gate.Release(); }
    }

    public async Task<NendoIdentityCopyResult> CreateIdentityCopyAsync(string planId, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var context = _identityCopies.Values.SingleOrDefault(value => value.Plan.PlanId == planId)
                ?? throw new NendoPreconditionException("copy-plan-not-found", "Review a new copy confirmation for this session.");
            if (context.ResultDigest is not null)
            {
                await VerifyIdentityDestinationAsync(context, context.ResultDigest, cancellationToken);
                return IdentityResult(context, replay: true);
            }
            if (_authority != context.Authority) throw CopySourceChanged();
            var current = await InspectIdentitySourceAsync(cancellationToken);
            if (current.ContentDigest != context.Intent.ContentDigest)
            {
                if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
                throw CopySourceChanged();
            }
            if (context.DestinationIdentity is null) RequireUnoccupiedBackupDestination(context.Destination);
            else if (!File.Exists(context.Destination)) throw CopyConflict();
            var stage = Path.Combine(Path.GetDirectoryName(context.Destination)!, $".nendo-stage-{Guid.NewGuid():N}.nendo");
            FileStream? stagePin = null;
            LocalFileIdentity? stageIdentity = null;
            var activated = false;
            var replay = context.DestinationIdentity is not null;
            try
            {
                stagePin = new FileStream(stage, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
                stageIdentity = LocalFileIdentity.Read(stagePin);
                await SqliteNendoStore.BackupSnapshotIntoReservedFileAsync(
                    _path, stage, context.Intent.ContentDigest, context.Authority,
                    async () =>
                    {
                        string expectedDigest;
                        await using (var store = await SqliteNendoStore.OpenAsync(stage, cancellationToken))
                        {
                            expectedDigest = await store.ApplyIdentityTransitionAsync(context.Intent, context.Operation,
                                context.RevisionId, context.CreatedAt, BeforeIdentityTransitionCommit, cancellationToken);
                        }
                        BeforeIdentityCopyValidation?.Invoke(stage);
                        var copied = await SqliteNendoStore.InspectAsync(stage, cancellationToken);
                        if (!copied.Inspection.CanAcquireWriteAuthority || copied.ContentDigest != expectedDigest ||
                            SqliteNendoStore.FindIdentityCopyEvidence(copied, context.Intent) is null)
                            throw new NendoPreconditionException("identity-copy-validation-failed", "The staged application copy did not validate. No destination was activated.");
                        BeforeIdentityCopyActivation?.Invoke();
                        cancellationToken.ThrowIfCancellationRequested();
                        if (replay)
                        {
                            // Reconstruct from the source plus the recorded operation,
                            // timestamp and revision ID. Compare every stored value, not
                            // just IDs or a plausible-looking provenance row.
                            await VerifyIdentityDestinationAsync(context, expectedDigest, cancellationToken);
                        }
                        else
                        {
                            RequireUnoccupiedBackupDestination(context.Destination);
                            stagePin.Flush(flushToDisk: true);
                            stagePin.Dispose();
                            stagePin = null;
                            File.Move(stage, context.Destination, overwrite: false);
                            activated = true;
                            context.DestinationIdentity = stageIdentity;
                        }
                        context.ResultDigest = expectedDigest;
                        context.ResultManifest = copied.Inspection.Manifest!;
                        // Once activated, cancellation cannot erase the committed copy.
                        if (activated) AfterIdentityCopyActivation?.Invoke();
                    }, IdentityCopyMaximumPageCountForTest, cancellationToken);
                return IdentityResult(context, replay);
            }
            finally
            {
                stagePin?.Dispose();
                if (!activated && stageIdentity is not null) DeleteOwnedBackupStage(stage, stageIdentity);
            }
        }
        catch (NendoRecoveryRequiredException)
        {
            EnterRecovery();
            throw;
        }
        finally { _gate.Release(); }
    }

    private async Task<InspectedNendoFile> InspectIdentitySourceAsync(CancellationToken cancellationToken)
    {
        if (!Capabilities.Backup) throw new NendoPreconditionException("identity-copy-unavailable", "This file state cannot create an identity-changing copy.");
        var inspected = await InspectBackupSourceAsync(cancellationToken);
        if (inspected.Inspection.Classification != NendoOpenClassification.NormalReadOnly)
        {
            if (_store is not null) EnterRecovery();
            throw new NendoPreconditionException("identity-copy-unavailable", "This file needs recovery or an explicit upgrade before Duplicate or Fork. A permitted recovery backup does not change identity.");
        }
        return inspected;
    }

    private static async Task VerifyIdentityDestinationAsync(IdentityCopyContext context, string expectedDigest, CancellationToken cancellationToken)
    {
        try
        {
            // Deny writable opens/replacement while checking an existing result.
            using var pin = new FileStream(context.Destination, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (LocalFileIdentity.Read(pin) != context.DestinationIdentity) throw CopyConflict();
            var current = await SqliteNendoStore.InspectAsync(context.Destination, cancellationToken);
            if (current.ContentDigest != expectedDigest || SqliteNendoStore.FindIdentityCopyEvidence(current, context.Intent) is null)
                throw CopyConflict();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw CopyConflict();
        }
    }

    private static NendoIdentityCopyResult IdentityResult(IdentityCopyContext context, bool replay) =>
        new(context.Plan.PlanId, context.Intent.Kind, context.Plan.DestinationFileName, context.ResultManifest!, context.RevisionId, replay);

    private static NendoIdempotencyConflictException CopyConflict() =>
        new("The destination does not match this exact copy request and its committed state. It was not changed or recreated.");

    private static NendoPreconditionException CopySourceChanged() =>
        new("identity-source-changed", "The source changed after inspection or confirmation. Review a new Duplicate or Fork request.");

    private sealed class IdentityCopyContext(
        NendoIdentityCopyPlan plan, string destination, IdentityCopyIntent intent, IdentityTransitionOperation operation,
        string revisionId, DateTimeOffset createdAt, NendoAuthoritySnapshot? authority, LocalFileIdentity? existingIdentity)
    {
        internal NendoIdentityCopyPlan Plan { get; } = plan;
        internal string Destination { get; } = destination;
        internal IdentityCopyIntent Intent { get; } = intent;
        internal IdentityTransitionOperation Operation { get; } = operation;
        internal string RevisionId { get; } = revisionId;
        internal DateTimeOffset CreatedAt { get; } = createdAt;
        internal NendoAuthoritySnapshot? Authority { get; } = authority;
        internal LocalFileIdentity? DestinationIdentity { get; set; } = existingIdentity;
        internal string? ResultDigest { get; set; }
        internal NendoManifestSnapshot? ResultManifest { get; set; }
    }
}
