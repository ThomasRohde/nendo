using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly Dictionary<string, RestoreContext> _restores = new(StringComparer.Ordinal);
    private volatile bool _replacementRetired;

    internal Action<string>? BeforeRestoreValidation { get; set; }
    internal Action<string>? RestoreCheckpoint { get; set; }
    internal int? RestoreMaximumPageCountForTest { get; set; }

    public static Task<NendoReplacementRecovery> InspectReplacementRecoveryAsync(
        string path, CancellationToken cancellationToken = default) =>
        FileReplacementReceipt.InspectAsync(ValidatePath(path), cancellationToken);

    public async Task<NendoRestorePlan> PrepareRestoreAsync(
        string backupPath, string requestId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (requestId.Length > 200) throw new NendoValidationException("The restore request ID is too long.");
        var backup = ValidatePath(backupPath);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_restores.TryGetValue(requestId, out var prior))
            {
                if (!string.Equals(prior.BackupPath, backup, StringComparison.OrdinalIgnoreCase))
                    throw new NendoIdempotencyConflictException("This restore request already identifies another backup.");
                return prior.Plan;
            }
            if (_restores.Count >= 32)
                throw new NendoPreconditionException("restore-session-limit", "Close and reopen the file before preparing another restore.");
            if (!Capabilities.Backup || _pathPin is null)
                throw new NendoPreconditionException("restore-unavailable", "This file cannot yield a verified pre-restore backup. Preserve it and open a verified backup separately.");
            RequireReplaceableTarget();
            if (File.Exists(FileReplacementReceipt.PendingPath(_path)))
                throw new NendoPreconditionException("replacement-pending", "Inspect the previous recovery record before preparing another replacement.");
            var current = await InspectBackupSourceAsync(cancellationToken);
            if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
            if (_readOnlySnapshot is not null && current.ContentDigest != _readOnlyContentDigest) throw SourceChanged();
            var observed = await ObserveAsync(backup, cancellationToken);
            if (!IsCompatibleRestoreSource(observed.Inspection) || observed.ContentDigest is null)
                throw new NendoFileOpenException(observed.Inspection);
            if (observed.PhysicalFileKey == LocalFileIdentity.Read(_pathPin).Key)
                throw new NendoPreconditionException("restore-source-target", "Choose a separate verified backup, not the current file or an alias.");
            if (current.Inspection.Manifest!.ApplicationId != observed.Inspection.Manifest!.ApplicationId ||
                current.Inspection.Manifest.InstanceId != observed.Inspection.Manifest.InstanceId)
                throw new NendoPreconditionException("restore-identity-mismatch", "This backup belongs to a different application or instance. Open it separately instead.");
            var id = $"restore-{Guid.NewGuid():N}";
            var retained = $"{Path.GetFileNameWithoutExtension(_path)}.pre-restore-{id[8..]}.nendo";
            var plan = new NendoRestorePlan(id, Path.GetFileName(backup), retained,
                current.Inspection.Manifest, observed.Inspection.Manifest, _proposals.Count,
                "The pre-restore file and its receipt are retained beside the application until you explicitly remove them. Nendo does not expire or delete them automatically.");
            _restores.Add(requestId, new(plan, backup, observed, current.ContentDigest!, _authority, LocalFileIdentity.Read(_pathPin), RestoreProposalStamp()));
            return plan;
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Native host must stop/revoke its integrations before calling. This retires
    /// the old session before replacement; old service objects cannot resume.
    /// Confirmation does not authorise mismatching current/source observations.
    /// </summary>
    public async Task<NendoRestoreResult> RestoreAsync(
        string planId, bool confirmDiscardProposals, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            var context = _restores.Values.SingleOrDefault(value => value.Plan.PlanId == planId)
                ?? throw new NendoPreconditionException("restore-plan-not-found", "Prepare and review a new restore before continuing.");
            if (_proposals.Count != 0 && !confirmDiscardProposals)
                throw new NendoPreconditionException("restore-proposals-pending", "Confirm that pending proposals may be discarded before restoring.");
            if (context.ProposalStamp != RestoreProposalStamp())
                throw new NendoPreconditionException("restore-proposals-changed", "The pending proposals changed after this confirmation. Review a new restore.");
            if (!Capabilities.Backup || _pathPin is null || _authority != context.Authority)
                throw new NendoPreconditionException("restore-current-changed", "The current session changed. Review a new restore before continuing.");
            RequireReplaceableTarget();
            if (File.Exists(FileReplacementReceipt.PendingPath(_path)))
                throw new NendoPreconditionException("replacement-pending", "An earlier recovery record must be reviewed first.");
            var current = await InspectBackupSourceAsync(cancellationToken);
            if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
            if (current.ContentDigest != context.CurrentDigest)
            {
                if (_store is not null) EnterRecovery();
                throw SourceChanged();
            }
            using var sourcePin = new FileStream(context.BackupPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var backup = await SqliteNendoStore.InspectAsync(context.BackupPath, cancellationToken);
            if (LocalFileIdentity.Read(sourcePin).Key != context.Backup.PhysicalFileKey ||
                backup.ContentDigest != context.Backup.ContentDigest || !IsCompatibleRestoreSource(backup.Inspection))
                throw new NendoPreconditionException("restore-backup-changed", "The selected backup changed after confirmation. Inspect it again.");
            // A read-only/recovery session may restore only after acquiring the
            // same live-instance/path exclusion as a writable session.
            var acquired = AcquireReplacementLeases(context.Plan.Current.InstanceId, "restore");
            try { return await ExecuteReplacementCoreAsync(context, upgrade: false, cancellationToken); }
            finally { ReleaseUnusedReplacementLeases(acquired); }
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    private async Task<NendoRestoreResult> ExecuteReplacementCoreAsync(RestoreContext context, bool upgrade, CancellationToken cancellationToken)
    {
        void Checkpoint(string point) { if (upgrade) UpgradeCheckpoint?.Invoke(point); else RestoreCheckpoint?.Invoke(point); }
        var kind = upgrade ? "upgrade" : "restore";
        var folder = Path.GetDirectoryName(_path)!;
        var suffix = context.Plan.PlanId[8..];
        var stage = Path.Combine(folder, $".nendo-stage-{kind}-{suffix}.nendo");
        var currentCopy = Path.Combine(folder, $".nendo-stage-current-{suffix}.nendo");
        var retained = Path.Combine(folder, context.Plan.RetainedFileName);
        var receiptPath = retained + ".receipt.json";
        var pending = FileReplacementReceipt.PendingPath(_path);
        LocalFileIdentity? stageIdentity = null, currentCopyIdentity = null, markerIdentity = null, receiptIdentity = null;
        FileStream? stagePin = null, currentPin = null;
        VerifiedFileMove? originalMove = null;
        var detached = false;
        var retainedOriginal = false;
        string? currentBytes = null;
        try
        {
            RequireUnoccupiedBackupDestination(retained);
            // Both stages are exclusively reserved before SQLite opens them.
            currentPin = new FileStream(currentCopy, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
            currentCopyIdentity = LocalFileIdentity.Read(currentPin);
            await SqliteNendoStore.BackupSnapshotIntoReservedFileAsync(_path, currentCopy, context.CurrentDigest, context.Authority,
                async () =>
                {
                    var copy = await SqliteNendoStore.InspectAsync(currentCopy, cancellationToken);
                    if (!copy.Inspection.Capabilities.Backup || copy.ContentDigest != context.CurrentDigest)
                        throw new NendoPreconditionException("restore-current-backup-invalid", "The pre-restore backup could not be verified. The current file was not replaced.");
                    // Captured while the source's DELETE read transaction blocks
                    // commit. Rechecked under the exclusive rename handle later.
                    currentBytes = VerifiedFileMove.Digest(_pathPin!);
                    currentPin.Flush(flushToDisk: true);
                }, RestoreMaximumPageCountForTest, cancellationToken);
            Checkpoint("current-backup-verified");
            cancellationToken.ThrowIfCancellationRequested();
            stagePin = new FileStream(stage, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
            stageIdentity = LocalFileIdentity.Read(stagePin);
            string? stageBytes = null;
            string? resultDigest = null;
            await SqliteNendoStore.BackupSnapshotIntoReservedFileAsync(context.BackupPath, stage, context.Backup.ContentDigest!, null,
                async () =>
                {
                    if (upgrade)
                        await SqliteNendoStore.UpgradeLegacyStageAsync(stage, context.Backup.ContentDigest!,
                            BeforeUpgradeCommit, UpgradeMaximumPageCountForTest, cancellationToken);
                    else BeforeRestoreValidation?.Invoke(stage);
                    var restored = await SqliteNendoStore.InspectAsync(stage, cancellationToken);
                    if (!restored.Inspection.CanAcquireWriteAuthority || restored.Inspection.Manifest != context.Plan.Restored ||
                        !upgrade && restored.ContentDigest != context.Backup.ContentDigest ||
                        upgrade && restored.Inspection.Layout != SqliteNendoStore.LegacyUpgradeTargetLayout)
                        throw new NendoPreconditionException("restore-stage-invalid", "The staged replacement did not match the reviewed result. The current file was not replaced.");
                    resultDigest = restored.ContentDigest!;
                    stagePin.Flush(flushToDisk: true);
                    stageBytes = VerifiedFileMove.Digest(stagePin);
                }, RestoreMaximumPageCountForTest, cancellationToken);
            Checkpoint(upgrade ? "upgrade-stage-verified" : "restore-stage-verified");
            cancellationToken.ThrowIfCancellationRequested();
            // The file at the name must be the one this session reviewed. A read-only session's pin
            // follows the file it opened, and the stage and digest checks read the name, so another
            // file with the same content there passed them and the rename below then interrupted
            // the replacement (W-221 review).
            using (var named = new FileStream(_path, FileMode.Open, FileAccess.Read, ReadOnlyPinShare))
                if (LocalFileIdentity.Read(named) != context.CurrentIdentity) throw SourceChanged();
            // The original's exclusive handle is taken before any recovery record exists. Nendo's
            // own handles are closed for it and come back if anything below fails before the
            // session retires; a handle another reader holds is waited out briefly and otherwise
            // refused, with nothing changed (ECO-01, W-221 review).
            detached = true;
            if (_store is not null) { await _store.DisposeAsync(); _store = null; }
            _pathPin?.Dispose(); _pathPin = null;
            Checkpoint("before-exclusive");
            originalMove = await AcquireOriginalAsync(context.CurrentIdentity, currentBytes!, cancellationToken);
            var receipt = new FileReplacementReceipt(1, context.Plan.PlanId, kind, FileName,
                context.Plan.RetainedFileName, Path.GetFileName(stage), Path.GetFileName(currentCopy),
                context.Plan.Current, context.Plan.Restored, context.CurrentDigest, resultDigest!,
                context.CurrentIdentity.Key, stageIdentity.Key, currentCopyIdentity.Key, DateTimeOffset.UtcNow);
            // Immutable permanent receipt, then a deterministic pending marker.
            // Neither is semantic history; incomplete records grant no authority.
            receiptIdentity = await receipt.WriteNewAsync(receiptPath, cancellationToken);
            markerIdentity = await receipt.WriteNewAsync(pending, cancellationToken);
            Checkpoint("recovery-record-durable");
            cancellationToken.ThrowIfCancellationRequested();

            // From here cancellation cannot imply that the original is still
            // active. Finish safely or leave explicit retained recovery evidence.
            _replacementRetired = true;
            NotifyAuthorityLost();
            // Best effort: a locked file in a proposal's workspace turned a restore that had moved
            // nothing into an interrupted replacement (ECO-05). What is left is swept when this
            // retired session is disposed, under the instance lease it still holds.
            foreach (var proposal in _proposals.Values)
                if (!ProposalWorkspace.TryDelete(proposal)) _proposalCleanupPending = true;
            _proposals.Clear();
            currentPin.Dispose(); currentPin = null;
            stagePin.Dispose(); stagePin = null;
            Checkpoint("before-retention");
            RequireUnoccupiedBackupDestination(retained);
            originalMove.MoveTo(retained);
            retainedOriginal = true;
            originalMove.Dispose(); originalMove = null;
            Checkpoint("original-retained");
            RequireReplacementTargetVacant(_path);
            using (var stageMove = VerifiedFileMove.Acquire(stage, stageIdentity, stageBytes!))
            {
                stageMove.MoveTo(_path);
                Checkpoint("replacement-activated");
            }
            // Reopen and classify the exact activated physical result. Pending
            // marker is ignored only by this internal verification, not readers.
            NendoFileObservation resultObservation;
            using (var resultPin = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                var verified = await SqliteNendoStore.InspectAsync(_path, CancellationToken.None, ignoreReplacementMarker: true);
                if (LocalFileIdentity.Read(resultPin) != stageIdentity || !verified.Inspection.CanAcquireWriteAuthority ||
                    verified.ContentDigest != resultDigest)
                    throw new NendoPreconditionException("restore-result-unverified", "The activated file could not be verified. Keep the retained original and recovery record.");
                Checkpoint("replacement-verified");
                VerifiedFileMove.DeleteOwnedFile(pending, markerIdentity);
                markerIdentity = null;
                resultObservation = new(verified.Inspection, stageIdentity.Key, verified.ContentDigest);
            }
            return new(context.Plan.PlanId, FileName, context.Plan.RetainedFileName, Path.GetFileName(receiptPath), context.Plan.Restored)
            {
                OpenObservation = resultObservation,
            };
        }
        catch (Exception exception) when (_replacementRetired)
        {
            throw new NendoReplacementInterruptedException(context.Plan.RetainedFileName, Path.GetFileName(receiptPath), exception);
        }
        finally
        {
            currentPin?.Dispose();
            stagePin?.Dispose();
            originalMove?.Dispose();
            // A failure before retirement gives the session its own handles back.
            if (detached && !_replacementRetired) await ReattachAfterUnfinishedReplacementAsync(context.CurrentDigest);
            // After retirement, retain an unactivated stage for explicit recovery;
            // never automatically undo a namespace change or delete the original.
            if (!_replacementRetired)
            {
                // These run in a finally over the real failure path. A locked marker or
                // receipt — an indexer or sync client holding it — must not let a cleanup
                // IOException replace the caller's actual refusal and skip the remaining
                // cleanups, which is how a restore that never moved a byte left a pending
                // marker behind and locked the file read-only on the next open.
                if (markerIdentity is not null)
                    try { VerifiedFileMove.DeleteOwnedFile(pending, markerIdentity); }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
                if (receiptIdentity is not null)
                    try { VerifiedFileMove.DeleteOwnedFile(receiptPath, receiptIdentity); }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
                if (stageIdentity is not null) DeleteOwnedBackupStage(stage, stageIdentity);
            }
            if (currentCopyIdentity is not null && (!_replacementRetired || retainedOriginal))
                DeleteOwnedBackupStage(currentCopy, currentCopyIdentity);
            // Activated stages now have the active name and are never cleaned.
        }
    }

    /// <summary>How many times, 50 ms apart, the original's exclusive handle is tried before a reader's handle is refused.</summary>
    internal int ReplacementAcquireAttempts { get; set; } = 20;

    /// <summary>
    /// The original's exclusive rename handle. A sharing violation is a reader, often Nendo's own
    /// short-lived one (another window refreshing its Jump List, a digest check), so it is tried
    /// again for about a second, then refused as <c>replacement-target-in-use</c>.
    /// </summary>
    private async Task<VerifiedFileMove> AcquireOriginalAsync(LocalFileIdentity identity, string byteDigest, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { return VerifiedFileMove.Acquire(_path, identity, byteDigest); }
            catch (IOException exception) when (exception.InnerException is System.ComponentModel.Win32Exception { NativeErrorCode: 32 or 33 })
            {
                if (attempt >= ReplacementAcquireAttempts)
                    throw new NendoPreconditionException("replacement-target-in-use", ReplacementTargetInUseText);
                await Task.Delay(50, cancellationToken);
            }
        }
    }

    internal const string ReplacementTargetInUseText =
        "Another program or Nendo window is reading this file, so it could not be replaced. Nothing was changed. Close it, or wait a moment, and try again.";

    /// <summary>
    /// Opens the session's own handles again after a replacement stopped before it retired the
    /// session. A writable session gets a fresh store, trusted only while the file still holds the
    /// content it reviewed; otherwise it enters recovery rather than editing a file it did not see.
    /// </summary>
    private async Task ReattachAfterUnfinishedReplacementAsync(string reviewedDigest)
    {
        try
        {
            _pathPin = _readOnlySnapshot is null
                ? OpenPathPin(_path, FileMode.Open, FileAccess.Read)
                : new FileStream(_path, FileMode.Open, FileAccess.Read, ReadOnlyPinShare);
            if (_readOnlySnapshot is not null) return;
            var store = await SqliteNendoStore.OpenAsync(_path, CancellationToken.None);
            try
            {
                var authority = await store.GetAuthoritySnapshotAsync(CancellationToken.None);
                if (authority.ApplicationId != _authority!.ApplicationId || authority.InstanceId != _authority.InstanceId ||
                    authority.ChangeSequence != _authority.ChangeSequence ||
                    await store.GetContentDigestAsync(CancellationToken.None) != reviewedDigest)
                    throw new NendoRecoveryRequiredException("The file changed while a replacement was being prepared. Reopen it for recovery inspection.");
                store.BehaviourAuthority = _behaviourAuthority;
                _store = store;
                _authority = authority;
            }
            catch
            {
                await store.DisposeAsync();
                throw;
            }
        }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException or Microsoft.Data.Sqlite.SqliteException)
        {
            // In a finally over the real failure: say it by entering recovery, never by replacing it.
            EnterRecovery();
        }
    }

    /// <summary>
    /// The instance and write leases a read-only or recovery session takes to replace its file.
    /// True when this call took them, so a replacement that fails before it retires the session
    /// gives them back (ECO-09).
    /// </summary>
    private bool AcquireReplacementLeases(string instanceId, string kind)
    {
        if (_instanceOwnership is not null) return false;
        _instanceOwnership = InstanceOwnershipLease.Acquire(instanceId);
        try { _ownership = WriteOwnershipLease.Acquire(_path, $"{kind}-{Environment.ProcessId}"); }
        catch { _instanceOwnership.Dispose(); _instanceOwnership = null; throw; }
        return true;
    }

    /// <summary>
    /// Gives back leases a failed replacement took. Kept when the session was retired: an
    /// interrupted replacement holds the file until it is closed, as a writable session does. A
    /// read-only session kept them after a failed staging, and another window could not open the
    /// file for editing while nothing was editing it.
    /// </summary>
    private void ReleaseUnusedReplacementLeases(bool acquired)
    {
        if (!acquired || _replacementRetired) return;
        _ownership?.Dispose();
        _ownership = null;
        _instanceOwnership?.Dispose();
        _instanceOwnership = null;
    }

    /// <summary>
    /// A file marked read-only in File Explorer is kept from replacement (R2SMA-10, owner
    /// 2026-10-13). ADR-0012 gives such a file inspection, export and backup; a restore or an
    /// upgrade put a fresh file without the mark in its place and moved the mark to the retained
    /// copy without a word.
    /// </summary>
    private void RequireReplaceableTarget()
    {
        FileAttributes attributes;
        // Only a read-only session's file can move away under it; that is the file changing, said so,
        // not a raw FileNotFoundException (W-221 review).
        try { attributes = File.GetAttributes(_path); }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        { throw SqliteNendoStore.InspectedContentChanged(); }
        if ((attributes & FileAttributes.ReadOnly) != 0)
            throw new NendoPreconditionException("replacement-target-read-only", ReplacementTargetReadOnlyText);
    }

    internal const string ReplacementTargetReadOnlyText =
        "This file is marked read-only, so Nendo will not replace it. Clear Read-only in the file's Properties in File Explorer, then use Inspect file again.";

    private static void RequireReplacementTargetVacant(string target)
    {
        if (File.Exists(target) || Directory.Exists(target) ||
            new[] { "-journal", "-wal", "-shm" }.Any(suffix => File.Exists(target + suffix)))
            throw new IOException("An unexpected file or storage operation occupies the restore target. It was not overwritten.");
        // The current coordinator intentionally retains target.write-owner.
    }

    private string RestoreProposalStamp() => string.Join("\n", _proposals.Values
        .OrderBy(proposal => proposal.ProposalId, StringComparer.Ordinal)
        .Select(proposal => $"{proposal.ProposalId}:{proposal.OperationDigest}"));

    private static bool IsCompatibleRestoreSource(NendoFileInspection inspection) =>
        inspection.Classification == NendoOpenClassification.NormalReadOnly && inspection.Capabilities.Backup;

    private sealed record RestoreContext(
        NendoRestorePlan Plan, string BackupPath, NendoFileObservation Backup,
        string CurrentDigest, NendoAuthoritySnapshot? Authority, LocalFileIdentity CurrentIdentity, string ProposalStamp);
}
