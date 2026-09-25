namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    public Task<NendoExtensionViewSnapshot> ReadExtensionViewAsync(string viewId, CancellationToken cancellationToken = default) =>
        ReadExtensionViewAsync(viewId, null, cancellationToken);

    /// <param name="recordId">The record a view on a record page is scoped to; null for any other view.</param>
    public async Task<NendoExtensionViewSnapshot> ReadExtensionViewAsync(string viewId, string? recordId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(viewId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null || !Capabilities.ReadData)
                throw new NendoPreconditionException("extension-projection-unavailable", "This file's current state does not permit extension projection. Use Studio to inspect its data.");
            return await GetStore().ReadExtensionViewAsync(viewId, recordId, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

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

    public async Task<NendoGraphProjection> ReadGraphProjectionAsync(NendoGraphBinding binding, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(binding);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            // Recovery data remains available through Studio; extensions receive no
            // projection from a classification whose complete bindings cannot be proven.
            if (_readOnlySnapshot is not null || !Capabilities.ReadData)
                throw new NendoPreconditionException("extension-projection-unavailable", "This file's current state does not permit extension projection. Use Studio to inspect its data.");
            return await GetStore().ReadGraphProjectionAsync(binding, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }
}
