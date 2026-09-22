using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private NendoAuthoritySnapshot? _authorityCache;
    private long _authorityDataVersion;
    private bool _authorityTainted;
    private string? _verifiedContentDigest;
    internal long FullAuthorityScanCount { get; private set; }

    private async Task<NendoAuthoritySnapshot> ReadAuthoritySnapshotAsync(
        SqliteTransaction? transaction, CancellationToken cancellationToken)
    {
        if (_authorityTainted) throw OutsideChange();
        using var owned = transaction is null ? _connection.BeginTransaction(deferred: true) : null;
        transaction ??= owned;
        // Establish the read snapshot before observing this connection's token.
        _ = await ScalarAsync("SELECT COUNT(*) FROM sqlite_schema;", transaction, cancellationToken);
        if (await ScalarAsync("PRAGMA data_version;", transaction, cancellationToken) is not long version)
            throw new NendoValidationException("The connection cannot supply an outside-change token.");
        if (_authorityCache is not null)
        {
            if (version == _authorityDataVersion) return _authorityCache;
            _authorityTainted = true;
            throw OutsideChange();
        }
        FullAuthorityScanCount++;
        // Use the same streaming, complete storage fingerprint as inspection:
        // includes raw canonical/inverse evidence and every protected/user row.
        var digest = await ReadContentDigestAsync(cancellationToken, transaction);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var authority = new NendoAuthoritySnapshot(manifest.ApplicationId, manifest.InstanceId,
            manifest.DefinitionRevision, manifest.DataRevision, manifest.ChangeSequence, Guid.NewGuid().ToString("N"));
        var health = await GetStorageHealthAsync(cancellationToken, transaction);
        if (!string.Equals(health.IntegrityResult, "ok", StringComparison.OrdinalIgnoreCase))
            throw new NendoValidationException("The file did not pass integrity verification.");
        _authorityDataVersion = version;
        _verifiedContentDigest = digest;
        _authorityCache = authority;
        return authority;
    }

    private async Task<NendoAuthoritySnapshot> PrepareCommittedAuthorityAsync(
        SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        return new(manifest.ApplicationId, manifest.InstanceId, manifest.DefinitionRevision,
            manifest.DataRevision, manifest.ChangeSequence, Guid.NewGuid().ToString("N"));
    }

    private static NendoRecoveryRequiredException OutsideChange() => new(
        "The open file changed outside its trusted connection. Reopen it for recovery inspection.");

    private void RequireUnattachedStage()
    {
        if (_authorityCache is not null)
            throw new InvalidOperationException("A staged transformation cannot use an active authority-bearing connection.");
    }
}
