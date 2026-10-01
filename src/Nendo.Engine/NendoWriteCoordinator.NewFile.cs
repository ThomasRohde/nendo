using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly Dictionary<string, (string Destination, NendoNewFileResult Result)> _newFiles = new(StringComparer.Ordinal);
    internal Action<string>? BeforeNewFileValidation { get; set; }

    /// <summary>What a new file of the open application would hold now (ADR-0022), for the person to read first.</summary>
    public async Task<NendoNewFilePreview> PreviewNewFileAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return await GetStore().PreviewNewFileAsync(cancellationToken);
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Makes a new file of the open application at <paramref name="destinationPath"/> (ADR-0022):
    /// a staged copy of the source, with the records it leaves out removed, its history folded
    /// into one checkpoint, and an identity transition of kind New, validated and then
    /// activated without overwriting anything. The source is never changed. The same request
    /// repeated in this session answers with the file it made.
    /// </summary>
    public async Task<NendoNewFileResult> CreateNewFileAsync(
        string destinationPath, string requestId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (requestId.Length > 200) throw new NendoValidationException("The new-file request ID is too long.");
        var destination = ValidatePath(destinationPath);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_newFiles.TryGetValue(requestId, out var previous))
            {
                if (!string.Equals(previous.Destination, destination, StringComparison.OrdinalIgnoreCase)) throw CopyConflict();
                return previous.Result;
            }
            if (string.Equals(destination, _path, StringComparison.OrdinalIgnoreCase))
                throw new NendoPreconditionException("copy-source-destination", "Choose a new file for the new file.");
            if (!Directory.Exists(Path.GetDirectoryName(destination)))
                throw new DirectoryNotFoundException("The selected folder is no longer available.");
            RequireUnoccupiedBackupDestination(destination);
            var source = await InspectIdentitySourceAsync(cancellationToken);
            if (_store is not null) await _store.VerifyBackupAuthorityAsync(_authority!, cancellationToken);
            if (_readOnlySnapshot is not null && source.ContentDigest != _readOnlyContentDigest) throw CopySourceChanged();
            var sourceManifest = source.Inspection.Manifest!;
            var sourceFileName = Path.GetFileName(_path);

            var stage = Path.Combine(Path.GetDirectoryName(destination)!, $".nendo-stage-{Guid.NewGuid():N}.nendo");
            FileStream? stagePin = null;
            LocalFileIdentity? stageIdentity = null;
            var activated = false;
            NendoNewFileResult? result = null;
            try
            {
                stagePin = new FileStream(stage, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
                stageIdentity = LocalFileIdentity.Read(stagePin);
                await SqliteNendoStore.BackupSnapshotIntoReservedFileAsync(
                    _path, stage, source.ContentDigest!, _authority,
                    async () =>
                    {
                        var now = DateTimeOffset.UtcNow;
                        var revisionId = $"revision-{Guid.NewGuid():N}";
                        IdentityCopyIntent intent;
                        (long Kept, long LeftOut, long Folded) counts;
                        await using (var store = await SqliteNendoStore.OpenAsync(stage, cancellationToken))
                        {
                            counts = await store.TransformIntoNewFileAsync(sourceFileName, now, cancellationToken);
                            var (manifest, digest) = await store.ReadStageIdentityAsync(cancellationToken);
                            intent = IdentityCopyIntent.Create(NendoIdentityCopyKind.New, requestId, manifest, digest, destination);
                            await store.ApplyIdentityTransitionAsync(intent,
                                intent.Operation(sourceManifest.ApplicationId, $"instance-{Guid.NewGuid():N}"),
                                revisionId, now, null, cancellationToken);
                            await store.VacuumAsync(cancellationToken);
                        }
                        BeforeNewFileValidation?.Invoke(stage);
                        var made = await SqliteNendoStore.InspectAsync(stage, cancellationToken);
                        if (!made.Inspection.CanAcquireWriteAuthority || SqliteNendoStore.FindIdentityCopyEvidence(made, intent) is null)
                            throw new NendoPreconditionException("new-file-validation-failed",
                                "The new file did not validate when it was read back. Nothing was made, and the open file is unchanged.");
                        cancellationToken.ThrowIfCancellationRequested();
                        RequireUnoccupiedBackupDestination(destination);
                        stagePin.Flush(flushToDisk: true);
                        stagePin.Dispose();
                        stagePin = null;
                        File.Move(stage, destination, overwrite: false);
                        activated = true;
                        result = new NendoNewFileResult(Path.GetFileName(destination), made.Inspection.Manifest!,
                            counts.Kept, counts.LeftOut, counts.Folded, revisionId);
                    }, null, cancellationToken);
                _newFiles[requestId] = (destination, result!);
                return result!;
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
}
