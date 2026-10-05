using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// What kind a package is (ADR-0024): the last rung of the protected layout ladder, added
    /// by the first skill package. A row names a skill package; a package without one is a
    /// view, so a file that never carried a skill carries no table and keeps its layout.
    /// <para>
    /// A skill package's row in <c>__nendo_extension_package</c> still fills the required
    /// entry point, with <see cref="NendoAgentSkill.FileName"/>, because that table's text is
    /// fixed by the layouts already released. Nothing reads it there: every read takes the
    /// kind from this table and gives a skill package no entry point.
    /// </para>
    /// </summary>
    private const string ExtensionKindSchemaSql = """
        CREATE TABLE __nendo_extension_kind (
            package_id TEXT NOT NULL PRIMARY KEY,
            kind TEXT NOT NULL,
            FOREIGN KEY (package_id) REFERENCES __nendo_extension_package(package_id),
            CHECK (kind = 'skill')
        );
        """;

    /// <summary>Brings the protected layout up to the skill rung: the whole ladder, then the kind table.</summary>
    private async Task EnsureExtensionKindLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureNewFileLayoutAsync(transaction, ct);
        if (!await ExtensionKindLayoutExistsAsync(transaction, ct)) await NonQueryAsync(ExtensionKindSchemaSql, transaction, ct);
    }

    private Task<bool> ExtensionKindLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_extension_kind", transaction, ct);

    /// <summary>The packages that are skills. Empty for a file below the rung.</summary>
    private async Task<HashSet<string>> ReadSkillPackageIdsAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var skills = new HashSet<string>(StringComparer.Ordinal);
        if (!await ExtensionKindLayoutExistsAsync(transaction, ct)) return skills;
        await using var query = Command("SELECT package_id FROM __nendo_extension_kind WHERE kind = 'skill';", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) skills.Add(rows.GetString(0));
        return skills;
    }
}
