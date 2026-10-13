using System.Security.Cryptography;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly Dictionary<string, RecoveryExportContext> _recoveryExports = new(StringComparer.Ordinal);

    // Where each prepared part left off: the snapshot it read, and what the parts so far wrote and
    // left out. A next part is only ever a continuation of one of these (R2SMA-13).
    private readonly Dictionary<(string EntityId, string After), RecoveryContinuation> _recoveryContinuations = [];

    private sealed record RecoveryContinuation(long ChangeSequence, int Written, int Omitted);

    internal int RecoveryExportRowLimit { get; set; } = RecoveryCsvWriter.MaximumRows;
    internal int RecoveryExportByteLimit { get; set; } = RecoveryCsvWriter.MaximumBytes;
    internal Action? BeforeRecoveryExportActivation { get; set; }
    internal Action? AfterRecoveryExportActivation { get; set; }
    internal Action? DuringRecoveryExportWrite { get; set; }

    public async Task<NendoRecoveryExportPlan> PrepareRecoveryExportAsync(string entityId, string destinationPath,
        string requestId, string? afterRecordId = null, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (requestId.Length > 200) throw new NendoValidationException("The export request ID is too long.");
        var destination = Path.GetFullPath(destinationPath);
        if (!Path.GetExtension(destination).Equals(".csv", StringComparison.OrdinalIgnoreCase) ||
            Path.GetFileName(destination).IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new NendoValidationException("Choose a new CSV filename without special filesystem characters.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_recoveryExports.TryGetValue(requestId, out var previous))
            {
                if (!string.Equals(previous.Destination, destination, StringComparison.OrdinalIgnoreCase) || previous.Plan.EntityId != entityId ||
                    previous.Plan.AfterRecordId != afterRecordId)
                    throw new NendoIdempotencyConflictException("This export request already identifies a different table, destination or part.");
                return previous.Plan;
            }
            RequireRecoveryExport();
            // A saved part no longer holds its bytes or counts against the session, so a table is
            // exported in as many parts as it needs (R2SMA-13).
            if (_recoveryExports.Values.Count(value => value.ActivatedIdentity is null) >= 32 ||
                _recoveryExports.Values.Sum(value => value.Bytes?.Length ?? 0) >= 16 * 1024 * 1024)
                throw new NendoPreconditionException("export-session-limit", "Close and reopen the file before preparing more recovery exports.");
            RequireUnoccupiedBackupDestination(destination);
            NendoSessionSnapshot snapshot;
            if (_readOnlySnapshot is not null) snapshot = _readOnlySnapshot;
            else
            {
                await GetStore().VerifyBackupAuthorityAsync(_authority!, cancellationToken);
                var inspected = await SqliteNendoStore.InspectAsync(_path, cancellationToken);
                if (!inspected.Inspection.Capabilities.Export || inspected.Snapshot is null)
                {
                    EnterRecovery();
                    throw new NendoFileOpenException(inspected.Inspection);
                }
                await GetStore().VerifyBackupAuthorityAsync(_authority!, cancellationToken);
                snapshot = inspected.Snapshot;
            }
            var entity = snapshot.Entities.SingleOrDefault(value => value.EntityId == entityId)
                ?? throw new NendoPreconditionException("entity-not-found", "Choose an available table to export.");
            RecoveryContinuation earlier = new(snapshot.Manifest.ChangeSequence, 0, 0);
            if (afterRecordId is not null)
            {
                earlier = _recoveryContinuations.GetValueOrDefault((entity.EntityId, afterRecordId))
                    ?? throw new NendoPreconditionException("export-continuation-unknown",
                        "No earlier part of this export ended there. Export again from the first part.");
                // A part read from a later snapshot could miss a record added before the cursor,
                // and count it as written by the parts before it.
                if (earlier.ChangeSequence != snapshot.Manifest.ChangeSequence)
                    throw new NendoPreconditionException("export-source-changed",
                        "The file changed after the earlier parts were prepared, so a next part could miss records. Export again from the first part.");
            }
            var csv = RecoveryCsvWriter.Create(entity, snapshot.Records, cancellationToken,
                RecoveryExportByteLimit, RecoveryExportRowLimit, afterRecordId);
            var findings = csv.Findings;
            if (earlier.Omitted != 0)
                findings = [.. findings, new("csv-earlier-omissions", $"{earlier.Omitted} record(s) that earlier parts left out are in no part.")];
            if (_recoveryExports.Values.Sum(value => value.Bytes?.Length ?? 0) + csv.Bytes.Length > 16 * 1024 * 1024)
                throw new NendoPreconditionException("export-session-limit", "Close and reopen the file before preparing more recovery exports.");
            var plan = new NendoRecoveryExportPlan($"export-{Guid.NewGuid():N}", entity.EntityId, entity.DisplayName,
                Path.GetFileName(destination), snapshot.Manifest.ChangeSequence, csv.SourceRows, csv.ExportedRows,
                csv.SourceRows - earlier.Written - csv.ExportedRows, csv.OmittedFields, csv.EscapedCells, csv.Bytes.Length,
                csv.IsPartial || earlier.Omitted != 0, findings)
            {
                AfterRecordId = afterRecordId,
                PrecedingRecordCount = earlier.Written,
                NextAfterRecordId = csv.ContinueAfter,
            };
            if (csv.ContinueAfter is { } next)
                _recoveryContinuations[(entity.EntityId, next)] = new(earlier.ChangeSequence,
                    earlier.Written + csv.ExportedRows, earlier.Omitted + csv.OmittedRows);
            _recoveryExports.Add(requestId, new(plan, destination, csv.Bytes, _authority));
            return plan;
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoRecoveryExportResult> CreateRecoveryExportAsync(string planId, bool confirmPartial,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            var context = _recoveryExports.Values.SingleOrDefault(value => value.Plan.PlanId == planId)
                ?? throw new NendoPreconditionException("export-plan-not-found", "Review a new recovery export before saving it.");
            if (context.ActivatedIdentity is not null)
            {
                try
                {
                    using var result = new FileStream(context.Destination, FileMode.Open, FileAccess.Read, FileShare.Read);
                    if (LocalFileIdentity.Read(result) == context.ActivatedIdentity && VerifiedFileMove.Digest(result) == context.Digest)
                        return new(context.Plan, true);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
                throw new NendoIdempotencyConflictException("The committed export is no longer the same verified file. It was not recreated or overwritten.");
            }
            RequireRecoveryExport();
            if (context.Plan.IsPartial && !confirmPartial)
                throw new NendoPreconditionException("partial-export-confirmation", "This export omits data. Review and explicitly accept the omissions before saving it.");
            if (_authority != context.Authority)
                throw new NendoPreconditionException("export-source-changed", "The file changed after the export review. Prepare a new export.");
            if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
            RequireUnoccupiedBackupDestination(context.Destination);
            var stage = Path.Combine(Path.GetDirectoryName(context.Destination)!, $".nendo-export-{Guid.NewGuid():N}.tmp");
            LocalFileIdentity? identity = null;
            var activated = false;
            try
            {
                await using (var output = new FileStream(stage, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    identity = LocalFileIdentity.Read(output);
                    var bytes = context.Bytes!;
                    for (var offset = 0; offset < bytes.Length; offset += 4096)
                    {
                        await output.WriteAsync(bytes.AsMemory(offset, Math.Min(4096, bytes.Length - offset)), cancellationToken);
                        DuringRecoveryExportWrite?.Invoke();
                    }
                    await output.FlushAsync(cancellationToken);
                    output.Flush(true);
                }
                BeforeRecoveryExportActivation?.Invoke();
                cancellationToken.ThrowIfCancellationRequested();
                using var move = VerifiedFileMove.Acquire(stage, identity, context.Digest);
                move.MoveTo(context.Destination);
                activated = true;
                context.ActivatedIdentity = identity;
                context.Bytes = null;
                AfterRecoveryExportActivation?.Invoke();
                return new(context.Plan, false);
            }
            finally
            {
                if (!activated && identity is not null)
                {
                    try { VerifiedFileMove.DeleteOwnedFile(stage, identity); }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
                }
            }
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    private void RequireRecoveryExport()
    {
        if (!Capabilities.Export) throw new NendoPreconditionException("export-unavailable",
            "No proven-readable table is available for recovery export in this file state.");
    }

    private sealed class RecoveryExportContext(NendoRecoveryExportPlan plan, string destination, byte[] bytes, NendoAuthoritySnapshot? authority)
    {
        internal NendoRecoveryExportPlan Plan { get; } = plan;
        internal string Destination { get; } = destination;
        internal byte[]? Bytes { get; set; } = bytes;
        internal string Digest { get; } = Convert.ToHexString(SHA256.HashData(bytes));
        internal NendoAuthoritySnapshot? Authority { get; } = authority;
        internal LocalFileIdentity? ActivatedIdentity { get; set; }
    }
}
