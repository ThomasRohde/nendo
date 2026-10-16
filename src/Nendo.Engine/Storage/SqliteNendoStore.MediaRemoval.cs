using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

/// <summary>
/// Removing unused pictures (ADR-0031 point 8, W-273). A picture is unused when nothing the file
/// keeps names it: no value of a media field, retired fields included, no deleted record that can
/// be brought back, no kept value of a view, and no retained operation, whose undo or replay may
/// need it. Only folding history lets go of the last of those, so removal follows a fold.
/// </summary>
internal sealed partial class SqliteNendoStore
{
    /// <summary>What the file's embedded pictures weigh, and how much of that nothing names.</summary>
    internal async Task<NendoMediaUsage> ReadMediaUsageAsync(CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, ct);
        var usage = await MediaUsageAsync(transaction, ct);
        transaction.Rollback();
        return usage;
    }

    private async Task<NendoMediaUsage> MediaUsageAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return new(0, 0, 0, 0, NendoMedia.MaximumFileBytes);
        var (count, bytes) = await ReadMediaTotalsAsync(transaction, ct);
        var (unusedCount, unusedBytes) = await CountAsync($"SELECT COUNT(*), COALESCE(SUM(m.byte_length), 0) FROM __nendo_media m WHERE {await UnusedMediaWhereAsync(transaction, ct)};", transaction, ct);
        return new(count, bytes, unusedCount, unusedBytes, NendoMedia.MaximumFileBytes);
    }

    /// <summary>
    /// Removes every unused picture in one write transaction and answers what it removed. The
    /// caller has made the backup, and compacts the file afterwards.
    /// </summary>
    internal async Task<(NendoMediaUsage Removed, NendoAuthoritySnapshot Authority)> RemoveUnusedMediaAsync(
        NendoAuthoritySnapshot expectedAuthority, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        using var transaction = BeginWriteTransaction();
        var committed = false;
        try
        {
            if (await ReadAuthoritySnapshotAsync(transaction, ct) != expectedAuthority)
                throw new NendoRecoveryRequiredException("The open Nendo state changed outside the write coordinator; recovery is required before removing its pictures.");
            await RequireSupportedWritableLayoutAsync(transaction, ct);
            var before = await MediaUsageAsync(transaction, ct);
            if (before.UnusedCount == 0)
                throw new NendoPreconditionException("media-removal-nothing", "Every picture in the file is named by a record or by its history, so none was removed.");
            var unused = $"SELECT m.sha256 FROM __nendo_media m WHERE {await UnusedMediaWhereAsync(transaction, ct)}";
            await NonQueryAsync($"""
                CREATE TEMP TABLE __nendo_media_unused AS {unused};
                DELETE FROM __nendo_media_content WHERE sha256 IN (SELECT sha256 FROM temp.__nendo_media_unused);
                DELETE FROM __nendo_media WHERE sha256 IN (SELECT sha256 FROM temp.__nendo_media_unused);
                DROP TABLE temp.__nendo_media_unused;
                """, transaction, ct);
            var committedAuthority = await PrepareCommittedAuthorityAsync(transaction, ct);
            ct.ThrowIfCancellationRequested();
            transaction.Commit();
            committed = true;
            _authorityCache = committedAuthority;
            _verifiedContentDigest = null;
            return (new(before.UnusedCount, before.UnusedBytes, 0, 0, NendoMedia.MaximumFileBytes), committedAuthority);
        }
        catch (Exception exception)
        {
            if (!committed)
            {
                transaction.Rollback();
                if (IsBusy(exception)) throw FileBusy();
            }
            throw;
        }
    }

    /// <summary>The file's size as its pages count it, which a compaction brings down to what is left.</summary>
    internal async Task<long> ReadPagedBytesAsync(CancellationToken ct) =>
        Convert.ToInt64(await ScalarAsync("PRAGMA page_count;", null, ct), CultureInfo.InvariantCulture) *
        Convert.ToInt64(await ScalarAsync("PRAGMA page_size;", null, ct), CultureInfo.InvariantCulture);

    /// <summary>
    /// The condition on <c>__nendo_media m</c> that holds for a picture nothing names. Addresses
    /// are matched by their hash anywhere in the stored text, so a name in an operation's own
    /// encoding, in an undo's evidence or in a view's JSON counts as well as a field's value.
    /// </summary>
    private async Task<string> UnusedMediaWhereAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        var named = new List<string>();
        foreach (var entity in await ReadEntityMappingsAsync(transaction, ct))
        {
            if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) continue;
            foreach (var field in entity.Fields.Where(field => field.Presentation == NendoMedia.Presentation))
            {
                if (!await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) continue;
                named.Add($"SELECT 1 FROM {Quote(entity.PhysicalTableName)} WHERE {Quote(field.PhysicalColumnName)} = '{NendoMedia.EmbeddedScheme}' || m.sha256");
            }
        }
        named.Add("SELECT 1 FROM __nendo_operation o WHERE instr(o.canonical_json, m.sha256) > 0 OR instr(o.inverse_evidence_json, m.sha256) > 0");
        if (await TableExistsAsync("__nendo_deleted_record", transaction, ct))
            named.Add("SELECT 1 FROM __nendo_deleted_record d WHERE instr(d.values_json, m.sha256) > 0");
        if (await TableExistsAsync("__nendo_extension_state", transaction, ct))
            named.Add("SELECT 1 FROM __nendo_extension_state s WHERE instr(s.value_json, m.sha256) > 0");
        return string.Join(" AND ", named.Select(query => $"NOT EXISTS ({query})"));
    }

    private async Task<(long, long)> CountAsync(string sql, SqliteTransaction transaction, CancellationToken ct)
    {
        await using var command = Command(sql, transaction);
        await using var reader = await command.ExecuteReaderAsync(ct);
        await reader.ReadAsync(ct);
        return (reader.GetInt64(0), reader.GetInt64(1));
    }
}
