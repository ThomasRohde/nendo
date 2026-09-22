using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal async Task<string> GetContentDigestAsync(CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        if (_authorityCache is null) return await ReadContentDigestAsync(cancellationToken, transaction);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        return _verifiedContentDigest ??= await ReadContentDigestAsync(cancellationToken, transaction);
    }

    internal async Task VerifyBackupAuthorityAsync(NendoAuthoritySnapshot expectedAuthority, CancellationToken cancellationToken)
    {
        try
        {
            if (await ReadAuthoritySnapshotAsync(null, cancellationToken) != expectedAuthority)
            {
                throw new NendoRecoveryRequiredException("The open file changed outside its write coordinator. Reopen it for recovery inspection.");
            }
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode is 5 or 6)
        {
            throw new NendoPreconditionException("backup-source-busy", "The source is busy. Retry after its current operation finishes.");
        }
        catch (Exception exception) when (IsProjectionFailure(exception) && exception is not NendoRecoveryRequiredException)
        {
            throw new NendoRecoveryRequiredException("The open file's trusted state can no longer be verified. Reopen it for recovery inspection.");
        }
    }

    /// <summary>
    /// Hashes storage contents, including uninterpretable custom JSON and retained
    /// audit/idempotency evidence. Call inside one read transaction. It is not a
    /// semantic revision or a physical-file hash and never leaves the Engine.
    /// </summary>
    private async Task<string> ReadContentDigestAsync(CancellationToken cancellationToken, SqliteTransaction? transaction = null)
    {
        using var timing = NendoStartupDiagnostics.Source.StartActivity("engine.content-digest");
        using var hash = SHA256.Create();
        using var sink = new CryptoStream(Stream.Null, hash, CryptoStreamMode.Write);
        using var writer = new Utf8JsonWriter(sink);
        writer.WriteStartArray();
        writer.WriteNumberValue(Convert.ToInt64(await ScalarAsync("PRAGMA application_id;", transaction, cancellationToken), CultureInfo.InvariantCulture));
        writer.WriteNumberValue(Convert.ToInt64(await ScalarAsync("PRAGMA user_version;", transaction, cancellationToken), CultureInfo.InvariantCulture));
        var tables = new List<string>();
        await using (var command = Command("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name;", transaction))
        await using (var rows = await command.ExecuteReaderAsync(cancellationToken))
        {
            var count = 0;
            while (await rows.ReadAsync(cancellationToken))
            {
                if (++count > 512)
                {
                    throw new NendoValidationException("The file exceeds the bounded storage-object inspection limit.");
                }
                WriteStorageRow(writer, rows);
                if (rows.GetString(0) == "table") tables.Add(rows.GetString(1));
            }
        }
        foreach (var table in tables)
        {
            writer.WriteStartArray();
            writer.WriteStringValue(table);
            // Known production layouts use ordinary rowid tables. Preserve rowid
            // too: metadata insertion order is part of the current projection.
            await using var command = Command($"SELECT rowid, * FROM {Quote(table)} ORDER BY rowid;", transaction);
            await using var rows = await command.ExecuteReaderAsync(cancellationToken);
            var count = 0;
            while (await rows.ReadAsync(cancellationToken))
            {
                if (++count > MaximumInspectionRows)
                {
                    throw new NendoValidationException("The file exceeds the bounded storage-row inspection limit.");
                }
                WriteStorageRow(writer, rows);
                writer.Flush();
            }
            writer.WriteEndArray();
        }
        writer.WriteEndArray();
        writer.Flush();
        sink.FlushFinalBlock();
        return Convert.ToHexString(hash.Hash!);
    }

    private static void WriteStorageRow(Utf8JsonWriter writer, SqliteDataReader row)
    {
        writer.WriteStartArray();
        for (var index = 0; index < row.FieldCount; index++)
        {
            // Explicit tags distinguish SQLite integer/real/text/null storage.
            writer.WriteStartArray();
            switch (row.GetValue(index))
            {
                case DBNull:
                    writer.WriteStringValue("null");
                    break;
                case long value:
                    writer.WriteStringValue("integer");
                    writer.WriteStringValue(value.ToString(CultureInfo.InvariantCulture));
                    break;
                case double value:
                    writer.WriteStringValue("real");
                    writer.WriteStringValue(value.ToString("R", CultureInfo.InvariantCulture));
                    break;
                case string value:
                    writer.WriteStringValue("text");
                    writer.WriteStringValue(value);
                    break;
                case byte[] value:
                    writer.WriteStringValue("blob");
                    writer.WriteBase64StringValue(value);
                    break;
                default:
                    throw new NendoValidationException("A stored value cannot be safely fingerprinted.");
            }
            writer.WriteEndArray();
        }
        writer.WriteEndArray();
    }

    internal static async Task BackupSnapshotIntoReservedFileAsync(
        string sourcePath,
        string reservedDestinationPath,
        string expectedContentDigest,
        NendoAuthoritySnapshot? expectedAuthority,
        Func<Task> activateValidatedCopy,
        int? maximumPageCountForTest,
        CancellationToken cancellationToken)
    {
        await using var source = await OpenConnectionAsync(sourcePath, SqliteOpenMode.ReadOnly, cancellationToken);
        var store = new SqliteNendoStore(sourcePath, source);
        await store.NonQueryAsync("PRAGMA query_only = ON; BEGIN DEFERRED;", null, cancellationToken);
        // The first read fixes the snapshot. A DELETE-journal writer cannot commit
        // between these checks and the backup; no source profile is changed.
        if (expectedAuthority is not null)
        {
            // A session token belongs to the active connection. This separate
            // source snapshot is verified by the full content digest below.
            var manifest = await store.ReadManifestAsync(null, cancellationToken);
            if (manifest.ApplicationId != expectedAuthority.ApplicationId || manifest.InstanceId != expectedAuthority.InstanceId ||
                manifest.DefinitionRevision != expectedAuthority.DefinitionRevision || manifest.DataRevision != expectedAuthority.DataRevision ||
                manifest.ChangeSequence != expectedAuthority.ChangeSequence) throw OutsideChange();
        }
        if (await store.ReadContentDigestAsync(cancellationToken) != expectedContentDigest)
        {
            if (expectedAuthority is not null) throw OutsideChange();
            throw new NendoPreconditionException("backup-source-changed", "The source changed since this backup was prepared. Review a new backup before continuing.");
        }
        await using (var destination = await OpenConnectionAsync(reservedDestinationPath, SqliteOpenMode.ReadWrite, cancellationToken))
        {
            var destinationStore = new SqliteNendoStore(reservedDestinationPath, destination);
            await destinationStore.ApplyAndVerifyProfileAsync(cancellationToken);
            if (maximumPageCountForTest is { } pageLimit)
            {
                ArgumentOutOfRangeException.ThrowIfLessThan(pageLimit, 1);
                // Same destination connection as BackupDatabase: deterministic
                // native SQLITE_FULL injection, not a real full-volume claim.
                await destinationStore.NonQueryAsync($"PRAGMA max_page_count = {pageLimit};", null, cancellationToken);
            }
            // ReadWrite cannot create a missing stage or consume a user's destination.
            source.BackupDatabase(destination);
        }
        cancellationToken.ThrowIfCancellationRequested();
        // Retain the source read transaction through validation and activation.
        // This callback is Engine-internal, never a caller-supplied privileged tool.
        await activateValidatedCopy();
    }
}
