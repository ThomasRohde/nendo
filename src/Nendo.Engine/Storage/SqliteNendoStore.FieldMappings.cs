using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    // Counts the actual field SELECT, so a bulk snapshot cannot quietly become one per entity.
    internal long FieldMappingReadCount { get; private set; }

    /// <summary>
    /// Shared field metadata, loaded once for either one entity or the whole file.
    /// Inspection preserves unknown kinds; the write path keeps its strict enum parsing.
    /// </summary>
    private async Task<List<FieldMapping>> ReadFieldMappingsAsync(
        string? entityId,
        bool preserveUnknownKinds,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        var hasPresentation = await ColumnExistsAsync("__nendo_field", "presentation", transaction, cancellationToken);
        var hasOptions = await ColumnExistsAsync("__nendo_field", "options_json", transaction, cancellationToken);
        var fieldSql = $"""
            SELECT field_id, entity_id, display_name, physical_column_name, storage_kind, required,
                   {(hasPresentation ? "presentation" : "NULL")},
                   {(hasOptions ? "options_json" : "'[]'")}
            FROM __nendo_field
            {(entityId is null ? "" : "WHERE entity_id = @entityId")}
            ORDER BY {(entityId is null ? "entity_id, rowid" : "rowid")};
            """;
        var fields = new List<FieldMapping>();
        await using (var command = Command(fieldSql, transaction))
        {
            if (entityId is not null) command.Parameters.AddWithValue("@entityId", entityId);
            FieldMappingReadCount++;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var kindName = reader.GetString(4);
                NendoStorageKind kind;
                string? unsupportedKind = null;
                if (preserveUnknownKinds)
                {
                    var known = Enum.TryParse(kindName, ignoreCase: false, out kind) &&
                        Enum.IsDefined(kind) && kind != NendoStorageKind.Unsupported && kind.ToString() == kindName;
                    if (!known) { kind = NendoStorageKind.Unsupported; unsupportedKind = kindName; }
                }
                else kind = Enum.Parse<NendoStorageKind>(kindName, ignoreCase: false);
                fields.Add(new FieldMapping(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    kind,
                    reader.GetInt64(5) == 1,
                    reader.IsDBNull(6) ? null : StoredPresentation(reader.GetString(6), kind),
                    ParseOptions(reader.GetString(7))) { UnsupportedStorageKind = unsupportedKind });
            }
        }
        await PopulateReferencesAsync(fields, transaction, cancellationToken);
        await PopulateChoicesAsync(fields, transaction, cancellationToken);
        await PopulateRatingScalesAsync(fields, transaction, cancellationToken);
        await PopulateFieldRulesAsync(fields, transaction, cancellationToken);
        await PopulateFieldSequencesAsync(fields, transaction, cancellationToken);
        var retiredFields = await RetiredIdsAsync("field", transaction, cancellationToken);
        for (var index = 0; index < fields.Count; index++) fields[index] = fields[index] with { Retired = retiredFields.Contains(fields[index].FieldId) };
        return fields;
    }
}
