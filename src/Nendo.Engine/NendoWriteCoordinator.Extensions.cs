namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    public async Task<NendoExtensionViewSnapshot> ReadExtensionViewAsync(string viewId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(viewId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null || !Capabilities.ReadData)
                throw new NendoPreconditionException("extension-projection-unavailable", "This file's current state does not permit extension projection. Use Studio to inspect its data.");
            return await GetStore().ReadExtensionViewAsync(viewId, cancellationToken);
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
