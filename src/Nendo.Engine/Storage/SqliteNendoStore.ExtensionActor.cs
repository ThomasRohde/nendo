using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>The origin prefix a host gives a write made in a custom view's package's name (ADR-0013 Phase 3).</summary>
    internal const string ExtensionActorPrefix = "extension:";

    /// <summary>
    /// Refuses a write made in the name of a package the file no longer carries, inside the
    /// transaction that would commit it.
    /// <para>
    /// A host admits a view's write before it reaches this store, and the package can be
    /// removed in between by a writer that host does not serialize with: an agent accepting
    /// its own removal proposal commits through this store's lock and nothing else. Checking
    /// here, under the same lock and in the same transaction, leaves no such gap (R-014). An
    /// exact replay of a write that did commit is answered before this check, so its receipt
    /// still says what happened.
    /// </para>
    /// </summary>
    private async Task RequireExtensionActorPackageAsync(string origin, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!origin.StartsWith(ExtensionActorPrefix, StringComparison.Ordinal)) return;
        var packageId = origin[ExtensionActorPrefix.Length..];
        if (packageId.Length == 0 ||
            !await ExtensionLayoutExistsAsync(transaction, ct) ||
            !await ExtensionPackageExistsAsync(packageId, transaction, ct))
            throw new NendoPreconditionException("actor-not-allowed",
                $"This file carries no package {packageId}, so nothing may write in its name.");
    }
}
