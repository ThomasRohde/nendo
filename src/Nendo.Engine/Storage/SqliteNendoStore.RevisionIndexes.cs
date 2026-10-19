using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// Three indexes on the history tables (ADR-0021), added by a
    /// file's first fold and by a new file's fold. The fold deletes revisions, and every deleted
    /// revision cascades into <c>__nendo_idempotency</c> by its revision, which without an index is a
    /// scan of the whole table per revision: minutes for a file grown by single edits. The two
    /// partial indexes serve the receipt read by proposal and the compensation read by the revision
    /// it reverses, which otherwise scan every revision on each prepare, promote and undo.
    /// <para>
    /// Not a rung of the linear ladder: a rung there needs every rung below it, and the search index
    /// is derived content a fold must not create. The three are one overlay instead, recognised only
    /// all together and only in exactly this spelling, and left out of the layout signature then, so
    /// every known layout stays known with or without them. A file that has them states
    /// <see cref="NendoFormat.RevisionIndexesMinimumHostVersion"/>; an older host does not know them
    /// and refuses the layout, which is the refusal it is owed.
    /// </para>
    /// </summary>
    private const string RevisionIndexSql = """
        CREATE INDEX __nendo_idempotency_revision ON __nendo_idempotency(revision_id);
        CREATE INDEX __nendo_revision_compensation ON __nendo_revision(compensation_of_revision_id) WHERE compensation_of_revision_id IS NOT NULL;
        CREATE INDEX __nendo_revision_proposal ON __nendo_revision(proposal_id, change_sequence) WHERE proposal_id IS NOT NULL;
        """;

    /// <summary>Each overlay index by name, as the layout signature spells its statement: without whitespace.</summary>
    internal static readonly IReadOnlyDictionary<string, string> RevisionIndexes = RevisionIndexSql
        .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .ToDictionary(statement => statement.Split(' ')[2], NormalizeSchemaSql, StringComparer.Ordinal);

    private static string NormalizeSchemaSql(string sql) => Regex.Replace(sql, @"\s+", "", RegexOptions.CultureInvariant);

    /// <summary>Whether a schema row is one of the overlay indexes, exactly as this host creates it.</summary>
    private static bool IsRevisionIndex(string type, string name, string? sql) =>
        type == "index" && sql is not null && RevisionIndexes.TryGetValue(name, out var expected) && NormalizeSchemaSql(sql) == expected;

    /// <summary>Whether the file carries all three overlay indexes in exactly this host's spelling.</summary>
    internal async Task<bool> RevisionIndexesExistAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        await using var command = Command(
            "SELECT type, name, sql FROM sqlite_schema WHERE type = 'index' AND substr(name, 1, 8) = '__nendo_';", transaction);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var found = 0;
        while (await reader.ReadAsync(ct))
            if (IsRevisionIndex(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2))) found++;
        return found == RevisionIndexes.Count;
    }

    /// <summary>
    /// Creates the overlay inside the caller's write transaction, before anything is deleted. Only a
    /// writable layout reaches here, and a file with some of them but not all is not one.
    /// </summary>
    private async Task EnsureRevisionIndexesAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await RevisionIndexesExistAsync(transaction, ct)) await NonQueryAsync(RevisionIndexSql, transaction, ct);
    }
}
