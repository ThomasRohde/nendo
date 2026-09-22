using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly Dictionary<string, BackupContext> _backups = new(StringComparer.Ordinal);

    // Fault seams are internal to the Engine test boundary, not host/agent knobs.
    internal Action<string>? BeforeBackupValidation { get; set; }
    internal Action? BeforeBackupActivation { get; set; }
    internal Action? AfterBackupActivation { get; set; }
    internal int? BackupMaximumPageCountForTest { get; set; }

    /// <summary>The native host supplies a selected path. Only the safe plan may cross its UI bridge.</summary>
    public async Task<NendoBackupPlan> PrepareBackupAsync(
        string destinationPath,
        string requestId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (requestId.Length > 200) throw new NendoValidationException("The backup request ID is too long.");
        var destination = ValidatePath(destinationPath);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_backups.TryGetValue(requestId, out var existing))
            {
                if (!string.Equals(existing.Destination, destination, StringComparison.OrdinalIgnoreCase))
                {
                    throw new NendoIdempotencyConflictException("This backup request already identifies a different destination.");
                }
                return existing.Plan;
            }
            if (!Capabilities.Backup)
            {
                throw new NendoPreconditionException("backup-unavailable", "A verified backup is unavailable in this file state. Preserve the original and inspect a backup separately.");
            }
            if (_backups.Count >= 64)
            {
                throw new NendoPreconditionException("backup-session-limit", "This session has reached its backup request limit. Close and reopen the file before preparing another backup.");
            }
            if (string.Equals(_path, destination, StringComparison.OrdinalIgnoreCase))
            {
                throw new NendoPreconditionException("backup-source-destination", "Choose a different destination for the backup.");
            }
            RequireUnoccupiedBackupDestination(destination);
            if (!Directory.Exists(Path.GetDirectoryName(destination)))
            {
                throw new DirectoryNotFoundException("The selected backup folder is no longer available.");
            }
            var inspected = await InspectBackupSourceAsync(cancellationToken);
            if (_store is not null)
            {
                await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
            }
            if (_readOnlySnapshot is not null && inspected.ContentDigest != _readOnlyContentDigest)
            {
                throw SourceChanged();
            }
            var plan = new NendoBackupPlan($"backup-{Guid.NewGuid():N}", Path.GetFileName(destination), inspected.Inspection.Manifest!);
            _backups.Add(requestId, new(plan, destination, inspected.ContentDigest!, _authority));
            return plan;
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

    public async Task<NendoBackupResult> CreateBackupAsync(
        string planId,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var context = _backups.Values.SingleOrDefault(value => value.Plan.PlanId == planId)
                ?? throw new NendoPreconditionException("backup-plan-not-found", "This backup confirmation is no longer available. Prepare a new backup.");
            if (context.ActivatedIdentity is not null)
            {
                return await VerifyBackupReplayAsync(context, cancellationToken);
            }
            if (!Capabilities.Backup)
            {
                throw new NendoPreconditionException("backup-unavailable", "Backup is no longer available for this file state.");
            }
            // A coordinated edit makes a prepared confirmation stale, not an
            // outside-authority failure. A committed retry still returns its old result.
            if (_authority != context.Authority) throw SourceChanged();
            RequireUnoccupiedBackupDestination(context.Destination);
            // Reclassify before SQLite can open a newly changed journal/profile.
            var current = await InspectBackupSourceAsync(cancellationToken);
            if (current.ContentDigest != context.ContentDigest)
            {
                if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
                throw SourceChanged();
            }
            var stage = Path.Combine(Path.GetDirectoryName(context.Destination)!, $".nendo-stage-{Guid.NewGuid():N}.nendo");
            FileStream? stagePin = null;
            LocalFileIdentity? stageIdentity = null;
            var activated = false;
            try
            {
                stagePin = new FileStream(stage, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
                stageIdentity = LocalFileIdentity.Read(stagePin);
                await SqliteNendoStore.BackupSnapshotIntoReservedFileAsync(
                    _path, stage, context.ContentDigest, context.Authority,
                    async () =>
                    {
                        BeforeBackupValidation?.Invoke(stage);
                        var copied = await SqliteNendoStore.InspectAsync(stage, cancellationToken);
                        if (!copied.Inspection.Capabilities.Backup || copied.ContentDigest != context.ContentDigest)
                        {
                            throw new NendoPreconditionException("backup-validation-failed", "The staged backup did not match the source. No destination was activated.");
                        }
                        BeforeBackupActivation?.Invoke();
                        cancellationToken.ThrowIfCancellationRequested();
                        RequireUnoccupiedBackupDestination(context.Destination);
                        stagePin.Flush(flushToDisk: true);
                        stagePin.Dispose();
                        stagePin = null;
                        // Atomic no-overwrite namespace operation. An existing empty
                        // file is someone else's file, not a Save-picker reservation.
                        File.Move(stage, context.Destination, overwrite: false);
                        activated = true;
                        context.ActivatedIdentity = stageIdentity;
                        // Cancellation after this point cannot uncommit a backup.
                        AfterBackupActivation?.Invoke();
                    }, BackupMaximumPageCountForTest, cancellationToken);
                return BackupResult(context, replay: false);
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
        finally
        {
            _gate.Release();
        }
    }

    private static async Task<NendoBackupResult> VerifyBackupReplayAsync(BackupContext context, CancellationToken cancellationToken)
    {
        try
        {
            using var pin = new FileStream(context.Destination, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (LocalFileIdentity.Read(pin) == context.ActivatedIdentity)
            {
                var inspected = await SqliteNendoStore.InspectAsync(context.Destination, cancellationToken);
                if (inspected.ContentDigest == context.ContentDigest) return BackupResult(context, replay: true);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A missing/replaced/unreadable result cannot authorise another write.
        }
        throw new NendoIdempotencyConflictException("The committed backup is no longer the same verified file. It was not recreated or overwritten.");
    }

    private static NendoBackupResult BackupResult(BackupContext context, bool replay) =>
        new(context.Plan.PlanId, context.Plan.DestinationFileName, context.Plan.Source, replay);

    private async Task<InspectedNendoFile> InspectBackupSourceAsync(CancellationToken cancellationToken)
    {
        var inspected = await SqliteNendoStore.InspectAsync(_path, cancellationToken);
        if (inspected.Inspection.Findings.Any(finding => finding.Code is "file-busy" or "operational-sidecars"))
        {
            throw new NendoPreconditionException("backup-source-busy", "The source has an active or unsupported storage operation. Close its writer or inspect again before retrying.");
        }
        if (!inspected.Inspection.Capabilities.Backup || inspected.ContentDigest is null)
        {
            if (_store is not null) EnterRecovery();
            throw new NendoFileOpenException(inspected.Inspection);
        }
        return inspected;
    }

    private static NendoPreconditionException SourceChanged() =>
        new("backup-source-changed", "The source changed after inspection or confirmation. Review a new backup before continuing.");

    private static void RequireUnoccupiedBackupDestination(string destination)
    {
        if (File.Exists(destination) || Directory.Exists(destination) ||
            new[] { "-journal", "-wal", "-shm", ".write-owner" }.Any(suffix => File.Exists(destination + suffix)))
        {
            throw new IOException("The backup destination or its operational files already exist. Choose a new name; no existing file was changed.");
        }
    }

    private static void DeleteOwnedBackupStage(string stage, LocalFileIdentity identity)
    {
        try
        {
            // Do not remove a matching-name replacement after losing ownership.
            using (var pin = new FileStream(stage, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (LocalFileIdentity.Read(pin) != identity) return;
            }
            DeletePartialCreation(stage);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Leave an inaccessible owned stage for explicit recovery; never
            // broaden cleanup to a directory or to the selected destination.
        }
    }

    private sealed class BackupContext(NendoBackupPlan plan, string destination, string contentDigest, NendoAuthoritySnapshot? authority)
    {
        internal NendoBackupPlan Plan { get; } = plan;
        internal string Destination { get; } = destination;
        internal string ContentDigest { get; } = contentDigest;
        internal NendoAuthoritySnapshot? Authority { get; } = authority;
        internal LocalFileIdentity? ActivatedIdentity { get; set; }
    }
}
