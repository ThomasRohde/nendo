using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal const string LegacyUpgradeId = "production-p1-v1-to-semantic-v1";
    internal const string LegacyUpgradeSourceLayout = "production-p1-v1";
    internal const string LegacyUpgradeTargetLayout = "production-semantic-v1";

    private async Task RequireSupportedWritableLayoutAsync(SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        var signature = await ProtectedSchemaSignatureAsync(cancellationToken, transaction);
        var known = await KnownLayouts.Value.WaitAsync(cancellationToken);
        if (signature != known[LegacyUpgradeTargetLayout] && signature != known["production-p1-semantic-v1"] &&
            signature != known["production-semantic-reference-v1"] && signature != known["production-p1-semantic-reference-v1"] &&
            signature != known["production-semantic-reference-deletion-v1"] && signature != known["production-p1-semantic-reference-deletion-v1"] &&
            signature != known["production-semantic-reference-deletion-choice-v1"] && signature != known["production-p1-semantic-reference-deletion-choice-v1"] &&
            signature != known["production-semantic-reference-deletion-choice-retirement-v1"] && signature != known["production-p1-semantic-reference-deletion-choice-retirement-v1"] &&
            signature != known["production-semantic-reference-deletion-choice-retirement-behaviour-v1"] &&
            signature != known["production-p1-semantic-reference-deletion-choice-retirement-behaviour-v1"] &&
            signature != known["production-semantic-reference-deletion-choice-retirement-behaviour-tone-v1"] &&
            signature != known["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-v1"] &&
            signature != known["production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-v1"] &&
            signature != known["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-v1"] &&
            signature != known["production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-v1"] &&
            signature != known["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-v1"])
            throw new NendoRecoveryRequiredException("The protected layout is no longer writable. No compatibility DDL or guessed repair was performed.");
    }

    internal static bool CanUpgradeLegacy(InspectedNendoFile inspected) =>
        inspected.Inspection.Layout == LegacyUpgradeSourceLayout &&
        inspected.Inspection.Manifest?.MinimumHostVersion == NendoFormat.MinimumHostVersion &&
        inspected.Inspection.Capabilities.Backup && inspected.ContentDigest is not null &&
        inspected.Inspection.Findings.All(finding => finding.Code is "upgrade-required" or "file-read-only");

    /// <summary>
    /// Only for an owned, reserved stage after the caller made a verified current
    /// backup. This never opens/upgrades an active source through ordinary writes.
    /// </summary>
    internal static async Task<InspectedNendoFile> UpgradeLegacyStageAsync(
        string stage, string expectedSourceDigest, Action? beforeCommit, int? maximumPageCountForTest,
        CancellationToken cancellationToken)
    {
        var inspected = await InspectAsync(stage, cancellationToken);
        if (!CanUpgradeLegacy(inspected) || inspected.ContentDigest != expectedSourceDigest)
            throw new NendoPreconditionException("upgrade-source-unsupported", "Only the original released file layout can follow this upgrade path.");
        await using (var connection = await OpenConnectionAsync(stage, SqliteOpenMode.ReadWrite, cancellationToken))
        {
            var store = new SqliteNendoStore(stage, connection);
            await store.ApplyAndVerifyProfileAsync(cancellationToken);
            if (maximumPageCountForTest is { } limit)
            {
                ArgumentOutOfRangeException.ThrowIfLessThan(limit, 1);
                await store.NonQueryAsync($"PRAGMA max_page_count = {limit};", null, cancellationToken);
            }
            using var transaction = connection.BeginTransaction(deferred: false);
            var known = await KnownLayouts.Value.WaitAsync(cancellationToken);
            if (await store.ProtectedSchemaSignatureAsync(cancellationToken, transaction) != known[LegacyUpgradeSourceLayout] ||
                await store.ReadContentDigestAsync(cancellationToken, transaction) != expectedSourceDigest)
                throw new NendoPreconditionException("upgrade-source-changed", "The staged source changed before its upgrade transaction.");
            var preserved = await store.LegacyUpgradePayloadDigestAsync(transaction, cancellationToken);
            await store.ExpandLegacyP1SchemaAsync(transaction, cancellationToken);
            await using (var compatibility = store.Command(
                "UPDATE __nendo_manifest SET minimum_host_version = @version WHERE singleton_id = 1;", transaction))
            {
                compatibility.Parameters.AddWithValue("@version", NendoFormat.SemanticMinimumHostVersion);
                if (await compatibility.ExecuteNonQueryAsync(cancellationToken) != 1)
                    throw new NendoValidationException("The staged compatibility metadata was not updated exactly once.");
            }
            beforeCommit?.Invoke();
            cancellationToken.ThrowIfCancellationRequested();
            if (await store.ProtectedSchemaSignatureAsync(cancellationToken, transaction) != known[LegacyUpgradeTargetLayout] ||
                await store.LegacyUpgradePayloadDigestAsync(transaction, cancellationToken) != preserved ||
                await store.ReadManifestAsync(transaction, cancellationToken) !=
                    inspected.Inspection.Manifest! with { MinimumHostVersion = NendoFormat.SemanticMinimumHostVersion })
                throw new NendoPreconditionException("upgrade-preservation-failed", "The upgrade changed state outside its declared layout/compatibility contract.");
            var invalidDefaults = Convert.ToInt64(await store.ScalarAsync("""
                SELECT (SELECT COUNT(*) FROM __nendo_field WHERE presentation IS NOT NULL OR options_json != '[]')
                     + (SELECT COUNT(*) FROM __nendo_revision WHERE proposal_id IS NOT NULL OR proposal_digest IS NOT NULL OR compensation_of_revision_id IS NOT NULL)
                     + (SELECT COUNT(*) FROM __nendo_ui_node) + (SELECT COUNT(*) FROM __nendo_ui_property);
                """, transaction, cancellationToken), CultureInfo.InvariantCulture);
            if (invalidDefaults != 0)
                throw new NendoPreconditionException("upgrade-defaults-invalid", "The upgrade introduced unrequested semantic metadata.");
            transaction.Commit();
        }
        // Cancellation after commit cannot undo an owned stage; the outer
        // lifecycle may still cancel/clean it before any active-file retention.
        var result = await InspectAsync(stage, CancellationToken.None);
        if (!result.Inspection.CanAcquireWriteAuthority || result.Inspection.Layout != LegacyUpgradeTargetLayout)
            throw new NendoPreconditionException("upgrade-validation-failed", "The upgraded stage did not pass complete reinspection.");
        return result;
    }

    private async Task<string> LegacyUpgradePayloadDigestAsync(SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        using var hash = SHA256.Create();
        using var sink = new CryptoStream(Stream.Null, hash, CryptoStreamMode.Write);
        using var writer = new Utf8JsonWriter(sink);
        writer.WriteStartArray();
        var tables = new List<string>();
        await using (var command = Command("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name;", transaction))
        await using (var rows = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await rows.ReadAsync(cancellationToken))
            {
                var name = rows.GetString(1);
                // Protected DDL is verified against the exact registered layouts.
                // User DDL is preserved byte-for-byte, not reconstructed from UI.
                if (!name.StartsWith("__nendo_", StringComparison.Ordinal) &&
                    !rows.GetString(2).StartsWith("__nendo_", StringComparison.Ordinal)) WriteStorageRow(writer, rows);
                if (rows.GetString(0) == "table" && name is not ("__nendo_ui_node" or "__nendo_ui_property")) tables.Add(name);
            }
        }
        foreach (var table in tables)
        {
            var projection = table switch
            {
                "__nendo_manifest" => "singleton_id, format_identifier, format_version, application_id, instance_id, created_at, modified_at, definition_revision, data_revision, change_sequence",
                "__nendo_field" => "field_id, entity_id, display_name, physical_column_name, storage_kind, required",
                "__nendo_revision" => "revision_id, created_at, origin, description, lane, definition_revision_before, definition_revision_after, data_revision_before, data_revision_after, change_sequence, operation_digest, idempotency_scope, idempotency_key",
                _ => "*",
            };
            writer.WriteStartArray();
            writer.WriteStringValue(table);
            await using var command = Command($"SELECT rowid, {projection} FROM {Quote(table)} ORDER BY rowid;", transaction);
            await using var rows = await command.ExecuteReaderAsync(cancellationToken);
            var count = 0;
            while (await rows.ReadAsync(cancellationToken))
            {
                if (++count > MaximumInspectionRows) throw new NendoValidationException("The upgrade exceeds the bounded row limit.");
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
}
