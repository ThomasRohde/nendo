using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    /// <summary>What the file's embedded pictures weigh against the budget, and how much of that nothing names (ADR-0031).</summary>
    public async Task<NendoMediaUsage> ReadMediaUsageAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return await GetStore().ReadMediaUsageAsync(cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Removes the pictures nothing names any more, then gives their pages back (ADR-0031 point 8,
    /// W-273). Like a fold, only after the backup this session made of the file exactly as it now
    /// stands, named by its plan; afterwards the file is inspected again as if it were being opened.
    /// </summary>
    public async Task<NendoMediaRemovalResult> RemoveUnusedMediaAsync(string backupPlanId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(backupPlanId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var store = GetStore();
            if (_recoveryRequired || _authority is null)
                throw new NendoRecoveryRequiredException("The coordinator no longer trusts the open file; recovery is required before its pictures can be removed.");
            if (!Capabilities.Mutate)
                throw new NendoPreconditionException("media-removal-unavailable", "This file cannot be changed in its current state, so its pictures cannot be removed.");
            var backup = _backups.Values.SingleOrDefault(context => context.Plan.PlanId == backupPlanId);
            if (backup?.ActivatedIdentity is null)
                throw new NendoPreconditionException("media-removal-needs-backup", "Removing pictures needs a backup of the file made first, in this session. Nothing was removed.");
            if (backup.Authority != _authority)
                throw new NendoPreconditionException("media-removal-backup-stale", "The file changed after its backup was made. Make a new backup first. Nothing was removed.");
            using var backupPin = await PinHistoryFoldBackupAsync(backup, cancellationToken, "Nothing was removed.");
            try
            {
                var bytesBefore = await store.ReadPagedBytesAsync(cancellationToken);
                var (removed, trusted) = await store.RemoveUnusedMediaAsync(_authority, cancellationToken);
                if (trusted.ApplicationId != _authority.ApplicationId || trusted.InstanceId != _authority.InstanceId ||
                    trusted.ChangeSequence != _authority.ChangeSequence)
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException("The file's identity or counters moved while its pictures were removed.");
                }
                _authority = trusted;
                AfterCommit?.Invoke();
                NotifyCommitted(trusted.ChangeSequence);
                var reclaimed = true;
                try { await store.VacuumAsync(CancellationToken.None); }
                catch (Exception exception) when (exception is SqliteException or IOException) { reclaimed = false; }
                var bytesAfter = await store.ReadPagedBytesAsync(CancellationToken.None);
                var inspected = await SqliteNendoStore.InspectAsync(_path, CancellationToken.None);
                if (!inspected.Inspection.Findings.Any(finding => finding.Code is "file-busy" or "file-unavailable") &&
                    inspected.Inspection.Classification is not (NendoOpenClassification.NormalWritable or NendoOpenClassification.NormalReadOnly))
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException(
                        $"After removing pictures, the file did not open normally ({string.Join(", ", inspected.Inspection.Findings.Select(finding => finding.Code))}). Restore it from the backup {backup.Plan.DestinationFileName}.");
                }
                return new(removed.Count, removed.Bytes, bytesBefore, bytesAfter, backup.Plan.DestinationFileName, reclaimed);
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
