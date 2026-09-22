using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    // Created only by an explicit typed definition operation inside its transaction.
    // Ordinary opens never create or repair metadata.
    private const string ReferenceSchemaSql = """
        CREATE TABLE __nendo_reference (
            field_id TEXT NOT NULL PRIMARY KEY,
            target_entity_id TEXT NOT NULL,
            label_field_id TEXT NOT NULL,
            FOREIGN KEY (field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (target_entity_id) REFERENCES __nendo_entity(entity_id),
            FOREIGN KEY (label_field_id) REFERENCES __nendo_field(field_id)
        );
        """;

    private async Task PopulateReferencesAsync(List<FieldMapping> fields, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_reference", transaction, ct)) return;
        var byId = fields.Select((field, index) => (field.FieldId, index)).ToDictionary(pair => pair.FieldId, pair => pair.index, StringComparer.Ordinal);
        await using var query = Command("SELECT field_id, target_entity_id, label_field_id FROM __nendo_reference;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
            if (byId.TryGetValue(rows.GetString(0), out var index))
                fields[index] = fields[index] with { Reference = new(rows.GetString(1), rows.GetString(2)) };
    }

    private async Task<OperationEvidence> ExecuteConfigureReferenceAsync(ConfigureReferenceOperation operation,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var source = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        RequireActive(source);
        var field = source.Fields.SingleOrDefault(field => field.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The reference field does not belong to this record type.");
        if (field.StorageKind != NendoStorageKind.Reference || field.Reference is not null)
            throw new NendoValidationException("Only an unbound reference field can be configured.");
        RequireActive(source, field);
        var target = await GetEntityMappingAsync(operation.TargetEntityId, transaction, ct);
        RequireActive(target);
        if (!target.Fields.Any(field => field.FieldId == operation.LabelFieldId && field.StorageKind == NendoStorageKind.Text && !field.Retired))
            throw new NendoValidationException("A reference label must be a text field on its target record type.");
        if (operation.ReviewedRecords is not null)
            await ValidateConversionRecordsAsync(source, field, new(operation.TargetEntityId, operation.LabelFieldId),
                operation.ReviewedRecords, true, transaction, ct);
        else if (await TableExistsAsync(source.PhysicalTableName, transaction, ct) &&
            await ColumnExistsAsync(source.PhysicalTableName, field.PhysicalColumnName, transaction, ct) &&
            Convert.ToInt64(await ScalarAsync($"SELECT EXISTS(SELECT 1 FROM {Quote(source.PhysicalTableName)} WHERE {Quote(field.PhysicalColumnName)} IS NOT NULL);", transaction, ct), CultureInfo.InvariantCulture) != 0)
            throw new NendoPreconditionException("reference-conversion-required", "Existing reference values require an explicit reviewed conversion; no targets were guessed.");
        if (!await TableExistsAsync("__nendo_reference", transaction, ct))
            await NonQueryAsync(ReferenceSchemaSql, transaction, ct);
        await using var insert = Command("INSERT INTO __nendo_reference(field_id, target_entity_id, label_field_id) VALUES (@field,@target,@label);", transaction);
        insert.Parameters.AddWithValue("@field", operation.FieldId);
        insert.Parameters.AddWithValue("@target", operation.TargetEntityId);
        insert.Parameters.AddWithValue("@label", operation.LabelFieldId);
        await insert.ExecuteNonQueryAsync(ct);
        return new(operation, Evidence(new { configured = true }))
        { RequiredHostVersion = operation.ReviewedRecords is null ? NendoFormat.ReferenceMinimumHostVersion : NendoFormat.ReferenceConversionMinimumHostVersion };
    }

    private async Task<OperationEvidence> ExecuteConvertLegacyReferenceAsync(ConvertLegacyReferenceOperation operation,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision, "conversion");
        var source = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = source.Fields.SingleOrDefault(value => value.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The reference field does not belong to this record type.");
        RequireActive(source, field);
        if (field.StorageKind != NendoStorageKind.Reference || field.Reference is not null)
            throw new NendoValidationException("Only an unbound legacy reference field can be converted.");
        var target = await GetEntityMappingAsync(operation.TargetEntityId, transaction, ct);
        RequireActive(target);
        if (!target.Fields.Any(value => value.FieldId == operation.LabelFieldId && value.StorageKind == NendoStorageKind.Text && !value.Retired))
            throw new NendoValidationException("A reference label must be an active text field on its target record type.");
        // Validate all targets before writing any source, including self-references and cycles.
        var previous = await ValidateConversionRecordsAsync(source, field, new(operation.TargetEntityId, operation.LabelFieldId),
            operation.Records, false, transaction, ct);
        foreach (var row in operation.Records)
        {
            await using var update = Command($"UPDATE {Quote(source.PhysicalTableName)} SET {Quote(field.PhysicalColumnName)}=@value, {Quote("__nendo_record_version")}={Quote("__nendo_record_version")}+1 WHERE {Quote("__nendo_record_id")}=@id AND {Quote("__nendo_record_version")}=@version;", transaction);
            update.Parameters.AddWithValue("@value", (object?)row.TargetRecordId ?? DBNull.Value);
            update.Parameters.AddWithValue("@id", row.RecordId);
            update.Parameters.AddWithValue("@version", row.ExpectedRecordVersion);
            if (await update.ExecuteNonQueryAsync(ct) != 1)
                throw new NendoPreconditionException("record-version-conflict", "A conversion source changed before commit.");
        }
        return new(operation, Evidence(new { previousValues = operation.Records.Select(row => new
        { recordId = row.RecordId, previousValue = previous[row.RecordId], appliedVersion = row.ExpectedRecordVersion + 1 }).ToArray() }))
        { RequiredHostVersion = NendoFormat.ReferenceConversionMinimumHostVersion };
    }

    private async Task<Dictionary<string, JsonElement>> ValidateConversionRecordsAsync(EntityMapping source, FieldMapping field,
        NendoReferenceDefinition reference, IReadOnlyList<NendoReferenceConversionRow> records, bool requireStoredTargetMatch,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var retained = new Dictionary<string, (long Version, JsonElement Value)>(StringComparer.Ordinal);
        await using (var query = Command($"SELECT {Quote("__nendo_record_id")}, {Quote("__nendo_record_version")}, {Quote(field.PhysicalColumnName)} FROM {Quote(source.PhysicalTableName)} LIMIT {ConvertLegacyReferenceOperation.MaximumRecords + 1};", transaction))
        await using (var reader = await query.ExecuteReaderAsync(ct))
            while (await reader.ReadAsync(ct))
                retained.Add(reader.GetString(0), (reader.GetInt64(1), ToJsonElement(reader.IsDBNull(2) ? null : reader.GetValue(2), field.StorageKind)));
        if (retained.Count > ConvertLegacyReferenceOperation.MaximumRecords)
            throw new NendoPreconditionException("reference-conversion-too-large", $"Conversion supports at most {ConvertLegacyReferenceOperation.MaximumRecords} records in one atomic review. No values were changed.");
        if (retained.Count != records.Count || records.Any(row => !retained.ContainsKey(row.RecordId)))
            throw new NendoPreconditionException("reference-conversion-incomplete", "Review an explicit mapping for every source record, including null values.");
        foreach (var row in records)
        {
            if (retained[row.RecordId].Version != row.ExpectedRecordVersion)
                throw new NendoPreconditionException("record-version-conflict", "A conversion source changed. Review the mapping again.");
            if (field.Required && row.TargetRecordId is null)
                throw new NendoValidationException("A required reference cannot be cleared.");
            var value = JsonSerializer.SerializeToElement(row.TargetRecordId);
            if (requireStoredTargetMatch && !JsonElement.DeepEquals(retained[row.RecordId].Value, value))
                throw new NendoPreconditionException("reference-conversion-mismatch", "Stored values do not match the reviewed conversion.");
            await ValidateReferenceValueAsync(field with { Reference = reference }, value, row.ExpectedTargetRecordVersion, transaction, ct);
        }
        return retained.ToDictionary(pair => pair.Key, pair => pair.Value.Value, StringComparer.Ordinal);
    }

    private async Task ValidateReferenceValueAsync(FieldMapping field, JsonElement value, long? expectedTargetVersion,
        SqliteTransaction transaction, CancellationToken ct)
    {
        if (field.StorageKind != NendoStorageKind.Reference || value.ValueKind == JsonValueKind.Null)
        {
            if (expectedTargetVersion is not null)
                throw new NendoValidationException("A target version is only valid for a non-null reference assignment.");
            return;
        }
        if (field.Reference is null)
            throw new NendoPreconditionException("reference-unbound", "Choose the target record type and label through a reviewed definition proposal first.");
        if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
            throw new NendoValidationException("A reference requires a target record ID.");
        if (expectedTargetVersion is null or < 1)
            throw new NendoPreconditionException("target-version-required", "Select the target again so its current version can be checked.");
        var target = await GetEntityMappingAsync(field.Reference.TargetEntityId, transaction, ct);
        RequireActive(target);
        await using var query = Command($"SELECT {Quote("__nendo_record_version")} FROM {Quote(target.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @id;", transaction);
        query.Parameters.AddWithValue("@id", value.GetString()!);
        var version = await query.ExecuteScalarAsync(ct);
        if (version is null or DBNull)
            throw new NendoPreconditionException("target-not-found", "That record does not exist in the reference's target type.");
        if (Convert.ToInt64(version, CultureInfo.InvariantCulture) != expectedTargetVersion)
            throw new NendoPreconditionException("target-version-conflict", "The selected target changed. Select it again before saving.");
    }

    private static bool ReferenceMetadataIsValid(IReadOnlyList<EntityMapping> entities)
    {
        var byId = entities.ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        return entities.SelectMany(entity => entity.Fields).All(field => field.Reference is null ||
            field.StorageKind == NendoStorageKind.Reference && byId.TryGetValue(field.Reference.TargetEntityId, out var target) &&
            target.Fields.Any(label => label.FieldId == field.Reference.LabelFieldId && label.StorageKind == NendoStorageKind.Text));
    }

    private async Task<long?> ReadReferenceVersionAsync(FieldMapping field, JsonElement value, SqliteTransaction transaction, CancellationToken ct)
    {
        if (field.Reference is null || value.ValueKind == JsonValueKind.Null) return null;
        var target = await GetEntityMappingAsync(field.Reference.TargetEntityId, transaction, ct);
        await using var query = Command($"SELECT {Quote("__nendo_record_version")} FROM {Quote(target.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @id;", transaction);
        query.Parameters.AddWithValue("@id", value.GetString()!);
        var version = await query.ExecuteScalarAsync(ct);
        return version is null or DBNull ? null : Convert.ToInt64(version, CultureInfo.InvariantCulture);
    }

    private async Task<bool> ReferencesHaveValidTargetsAsync(IReadOnlyList<EntityMapping> entities, CancellationToken ct)
    {
        var byId = entities.ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        foreach (var source in entities)
            foreach (var field in source.Fields.Where(field => field.Reference is not null))
            {
                if (!byId.TryGetValue(field.Reference!.TargetEntityId, out var target)) return false;
                var invalid = await ScalarAsync($"SELECT EXISTS(SELECT 1 FROM {Quote(source.PhysicalTableName)} s WHERE s.{Quote(field.PhysicalColumnName)} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM {Quote(target.PhysicalTableName)} t WHERE t.{Quote("__nendo_record_id")} = s.{Quote(field.PhysicalColumnName)}));", null, ct);
                if (Convert.ToInt64(invalid, CultureInfo.InvariantCulture) != 0) return false;
            }
        return true;
    }
}
