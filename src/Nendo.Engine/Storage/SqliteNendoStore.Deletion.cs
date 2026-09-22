using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private const string DeletionSchemaSql = """
        CREATE TABLE __nendo_deleted_record (
            entity_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            deleted_version INTEGER NOT NULL CHECK (deleted_version >= 1),
            is_deleted INTEGER NOT NULL CHECK (is_deleted IN (0, 1)),
            values_json TEXT NOT NULL CHECK (json_valid(values_json)),
            target_versions_json TEXT NOT NULL CHECK (json_valid(target_versions_json)),
            PRIMARY KEY (entity_id, record_id),
            FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id)
        );
        """;

    private async Task<bool> IsReservedRecordIdAsync(string entityId, string recordId, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) return false;
        await using var query = Command("SELECT EXISTS(SELECT 1 FROM __nendo_deleted_record WHERE entity_id=@entity AND record_id=@record);", transaction);
        query.Parameters.AddWithValue("@entity", entityId); query.Parameters.AddWithValue("@record", recordId);
        return Convert.ToInt64(await query.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) != 0;
    }

    private async Task<OperationEvidence> ExecuteDeleteRecordAsync(DeleteRecordOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        RequireActive(entity);
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var columns = entity.Fields.Select(field => Quote(field.PhysicalColumnName));
        var projection = string.Join(", ", new[] { Quote("__nendo_record_version") }.Concat(columns));
        await using (var query = Command($"SELECT {projection} FROM {Quote(entity.PhysicalTableName)} WHERE __nendo_record_id=@record;", transaction))
        {
            query.Parameters.AddWithValue("@record", operation.RecordId);
            await using var row = await query.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct)) throw new NendoPreconditionException("record-not-found", "The record no longer exists.");
            if (row.GetInt64(0) != operation.ExpectedRecordVersion)
                throw new NendoPreconditionException("record-version-conflict", "The record changed. Review its current values before deleting.");
            for (var index = 0; index < entity.Fields.Count; index++)
                values[entity.Fields[index].FieldId] = ToJsonElement(row.IsDBNull(index + 1) ? null : row.GetValue(index + 1), entity.Fields[index].StorageKind);
        }
        if (operation.ExpectedRecordVersion == long.MaxValue)
            throw new NendoPreconditionException("record-version-exhausted", "This record cannot retain a restorable next version.");

        foreach (var source in await ReadEntityMappingsAsync(transaction, ct))
        foreach (var field in source.Fields.Where(field => field.StorageKind == NendoStorageKind.Reference &&
                     (field.Reference is null || field.Reference.TargetEntityId == entity.EntityId)))
        {
            // The refusal names the records that still point here, not just the field
            // they point through: "clear the references" is a remedy only when the
            // caller can find them. Six are read so the message can say "more than five".
            await using var incoming = Command($"SELECT {Quote("__nendo_record_id")} FROM {Quote(source.PhysicalTableName)} WHERE {Quote(field.PhysicalColumnName)}=@record LIMIT 6;", transaction);
            incoming.Parameters.AddWithValue("@record", operation.RecordId);
            var referring = new List<string>();
            await using (var rows = await incoming.ExecuteReaderAsync(ct))
                while (await rows.ReadAsync(ct)) referring.Add(rows.GetString(0));
            if (referring.Count > 0)
                throw new NendoPreconditionException("record-referenced",
                    $"{(referring.Count > 5 ? "More than 5" : referring.Count.ToString(CultureInfo.InvariantCulture))} {source.DisplayName} " +
                    $"record{(referring.Count == 1 ? " still points" : "s still point")} at this one through {field.DisplayName} " +
                    $"({string.Join(", ", referring.Take(5))}{(referring.Count > 5 ? ", …" : "")}). Clear or reassign those references before deleting it.");
        }
        var targets = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var field in entity.Fields)
            if (await ReadReferenceVersionAsync(field, values[field.FieldId], transaction, ct) is { } version)
                targets[field.FieldId] = version;

        // The deletion extension includes reference metadata so supported layouts form a linear chain.
        if (!await TableExistsAsync("__nendo_reference", transaction, ct)) await NonQueryAsync(ReferenceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) await NonQueryAsync(DeletionSchemaSql, transaction, ct);
        await using (var retain = Command("""
            INSERT INTO __nendo_deleted_record(entity_id,record_id,deleted_version,is_deleted,values_json,target_versions_json)
            VALUES(@entity,@record,@version,1,@values,@targets)
            ON CONFLICT(entity_id,record_id) DO UPDATE SET deleted_version=excluded.deleted_version,
                is_deleted=1,values_json=excluded.values_json,target_versions_json=excluded.target_versions_json;
            """, transaction))
        {
            retain.Parameters.AddWithValue("@entity", entity.EntityId); retain.Parameters.AddWithValue("@record", operation.RecordId);
            retain.Parameters.AddWithValue("@version", operation.ExpectedRecordVersion);
            retain.Parameters.AddWithValue("@values", JsonSerializer.Serialize(values)); retain.Parameters.AddWithValue("@targets", JsonSerializer.Serialize(targets));
            await retain.ExecuteNonQueryAsync(ct);
        }
        await using (var delete = Command($"DELETE FROM {Quote(entity.PhysicalTableName)} WHERE __nendo_record_id=@record AND __nendo_record_version=@version;", transaction))
        {
            delete.Parameters.AddWithValue("@record", operation.RecordId); delete.Parameters.AddWithValue("@version", operation.ExpectedRecordVersion);
            if (await delete.ExecuteNonQueryAsync(ct) != 1) throw new NendoPreconditionException("record-version-conflict", "The record changed before deletion.");
        }
        return new(operation, Evidence(new { deletedVersion = operation.ExpectedRecordVersion, values, targetVersions = targets }))
        { RequiredHostVersion = NendoFormat.DeletionMinimumHostVersion };
    }

    private async Task<OperationEvidence> ExecuteRestoreDeletedRecordAsync(RestoreDeletedRecordOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        Dictionary<string, JsonElement> values;
        Dictionary<string, long> targets;
        await using (var query = Command("SELECT values_json,target_versions_json FROM __nendo_deleted_record WHERE entity_id=@entity AND record_id=@record AND is_deleted=1 AND deleted_version=@version;", transaction))
        {
            query.Parameters.AddWithValue("@entity", operation.EntityId); query.Parameters.AddWithValue("@record", operation.RecordId);
            query.Parameters.AddWithValue("@version", operation.DeletedVersion);
            await using var row = await query.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct)) throw new NendoPreconditionException("deletion-state-conflict", "This record is no longer in the selected deleted state.");
            values = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.GetString(0))!;
            targets = JsonSerializer.Deserialize<Dictionary<string, long>>(row.GetString(1))!;
        }
        // Reuse all typed create validation, including required fields, current choices and reference versions.
        await ExecuteCreateRecordAsync(new CreateRecordOperation(operation.OperationId, operation.EntityId, operation.RecordId,
            values.ToDictionary(pair => pair.Key, pair => (object?)pair.Value, StringComparer.Ordinal), targets), transaction, ct, restoring: true);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        await using (var version = Command($"UPDATE {Quote(entity.PhysicalTableName)} SET __nendo_record_version=@version WHERE __nendo_record_id=@record;", transaction))
        {
            version.Parameters.AddWithValue("@version", checked(operation.DeletedVersion + 1)); version.Parameters.AddWithValue("@record", operation.RecordId);
            await version.ExecuteNonQueryAsync(ct);
        }
        await using (var restored = Command("UPDATE __nendo_deleted_record SET is_deleted=0 WHERE entity_id=@entity AND record_id=@record;", transaction))
        {
            restored.Parameters.AddWithValue("@entity", operation.EntityId); restored.Parameters.AddWithValue("@record", operation.RecordId);
            await restored.ExecuteNonQueryAsync(ct);
        }
        return new(operation, Evidence(new { restoredVersion = operation.DeletedVersion + 1 })) { RequiredHostVersion = NendoFormat.DeletionMinimumHostVersion };
    }
}
