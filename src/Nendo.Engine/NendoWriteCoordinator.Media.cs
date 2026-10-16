using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    /// <summary>
    /// One embedded picture's metadata, or null when the file holds none by that hash (ADR-0031).
    /// Data, readable whenever records are; a read-only session reads it from the file it
    /// inspected, while that file still holds what was inspected.
    /// </summary>
    public Task<NendoMediaItem?> ReadMediaAsync(string sha256, CancellationToken cancellationToken = default) =>
        ReadMediaCoreAsync(sha256, (store, token) => store.ReadMediaAsync(sha256, null, token), cancellationToken);

    /// <summary>One embedded picture's bytes, or null when the file holds none by that hash.</summary>
    public Task<byte[]?> ReadMediaContentAsync(string sha256, CancellationToken cancellationToken = default) =>
        ReadMediaCoreAsync(sha256, (store, token) => store.ReadMediaContentAsync(sha256, null, token), cancellationToken);

    private async Task<T?> ReadMediaCoreAsync<T>(string sha256, Func<SqliteNendoStore, CancellationToken, Task<T?>> read,
        CancellationToken cancellationToken) where T : class
    {
        if (!NendoExtensionContent.IsSha256(sha256)) return null;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null && _readOnlyContentDigest is { } inspected)
                return await SqliteNendoStore.ReadInspectedContentAsync(_path, inspected, ReadOnlyContentStamp, read, cancellationToken);
            return await read(GetStore(), cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }
}
