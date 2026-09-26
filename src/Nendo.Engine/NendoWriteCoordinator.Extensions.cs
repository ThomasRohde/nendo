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
