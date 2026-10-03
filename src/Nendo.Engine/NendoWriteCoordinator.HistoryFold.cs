using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    /// <summary>What a fold keeps; a test seam, like the backup page bound, not a host or agent knob.</summary>
    internal SqliteNendoStore.HistoryFoldPolicy HistoryFoldPolicy { get; set; } = SqliteNendoStore.HistoryFoldPolicy.Default;
    internal Action? BeforeHistoryFoldCommit { get; set; }

    /// <summary>What folding the file's older history would do now (ADR-0021), for the person to read first.</summary>
    public async Task<NendoHistoryFoldPreview> PreviewHistoryFoldAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return await GetStore().PreviewHistoryFoldAsync(HistoryFoldPolicy, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Folds the file's older history into a checkpoint (ADR-0021). Only after the backup this
    /// session made of the file exactly as it now stands, named by its plan: a change since the
    /// backup, or a backup not yet made, refuses the fold and changes nothing. Afterwards the
    /// file gives the folded pages back and is inspected again as if it were being opened.
    /// </summary>
    public async Task<NendoHistoryFoldResult> FoldHistoryAsync(string backupPlanId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(backupPlanId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var store = GetStore();
            if (_recoveryRequired || _authority is null)
                throw new NendoRecoveryRequiredException("The coordinator no longer trusts the open file; recovery is required before its history can be folded.");
            if (!Capabilities.Mutate)
                throw new NendoPreconditionException("history-fold-unavailable", "This file cannot be changed in its current state, so its history cannot be folded.");
            var backup = _backups.Values.SingleOrDefault(context => context.Plan.PlanId == backupPlanId);
            if (backup?.ActivatedIdentity is null)
                throw new NendoPreconditionException("history-fold-needs-backup", "Folding needs a backup of the file made first, in this session. Nothing was folded.");
            if (backup.Authority != _authority)
                throw new NendoPreconditionException("history-fold-backup-stale", "The file changed after its backup was made, so the backup does not hold its whole history. Make a new backup first. Nothing was folded.");
            // Keep the recovery copy immutable until the destructive transaction has
            // committed. A cached activation receipt alone cannot protect its history.
            using var backupPin = await PinHistoryFoldBackupAsync(backup, cancellationToken);
            try
            {
                BeforeHistoryFoldCommit?.Invoke();
                var (result, trusted) = await store.FoldHistoryAsync(_authority, backup.Plan.DestinationFileName,
                    HistoryFoldPolicy, DateTimeOffset.UtcNow, cancellationToken);
                if (trusted.ApplicationId != _authority.ApplicationId || trusted.InstanceId != _authority.InstanceId ||
                    trusted.DefinitionRevision != _authority.DefinitionRevision || trusted.DataRevision != _authority.DataRevision ||
                    trusted.ChangeSequence != _authority.ChangeSequence)
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException("The folded file's counters did not match the ones it had before the fold.");
                }
                _authority = trusted;
                await store.VacuumAsync(cancellationToken);
                // Inspected as if opened: a fold that left anything this host would not open is recovery, not a success.
                var inspected = await SqliteNendoStore.InspectAsync(_path, cancellationToken);
                if (inspected.Inspection.Classification is not (NendoOpenClassification.NormalWritable or NendoOpenClassification.NormalReadOnly))
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException(
                        $"After folding, the file did not open normally ({string.Join(", ", inspected.Inspection.Findings.Select(finding => finding.Code))}). Restore it from the backup {backup.Plan.DestinationFileName}.");
                }
                AfterCommit?.Invoke();
                Committed?.Invoke(trusted.ChangeSequence);
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

    private static async Task<FileStream> PinHistoryFoldBackupAsync(BackupContext backup, CancellationToken cancellationToken)
    {
        FileStream? pin = null;
        try
        {
            pin = new FileStream(backup.Destination, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (LocalFileIdentity.Read(pin) == backup.ActivatedIdentity)
            {
                var inspected = await SqliteNendoStore.InspectAsync(backup.Destination, cancellationToken);
                if (inspected.Inspection.Capabilities.Backup && inspected.ContentDigest == backup.ContentDigest)
                    return pin;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
        catch { pin?.Dispose(); throw; }
        pin?.Dispose();
        throw new NendoPreconditionException("history-fold-backup-changed",
            "The required backup is missing, changed or unavailable. Make a new backup first. Nothing was folded.");
    }
}
