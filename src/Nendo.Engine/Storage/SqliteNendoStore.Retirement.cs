using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private const string RetirementSchemaSql = """
        CREATE TABLE __nendo_retirement (
            kind TEXT NOT NULL CHECK (kind IN ('entity', 'field')),
            semantic_id TEXT NOT NULL,
            retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
            PRIMARY KEY (kind, semantic_id)
        );
        """;

    private async Task<HashSet<string>> RetiredIdsAsync(string kind, SqliteTransaction? transaction, CancellationToken ct)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!await TableExistsAsync("__nendo_retirement", transaction, ct)) return result;
        await using var query = Command("SELECT semantic_id FROM __nendo_retirement WHERE kind=@kind AND retired=1;", transaction);
        query.Parameters.AddWithValue("@kind", kind);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) result.Add(rows.GetString(0));
        return result;
    }

    private static void RequireActive(EntityMapping entity, FieldMapping? field = null)
    {
        if (entity.Retired) throw new NendoPreconditionException("entity-retired", "This record type is retired. Reactivate it before editing.");
        if (field?.Retired == true) throw new NendoPreconditionException("field-retired", "This field is retired. Reactivate it before editing.");
    }

    private async Task<bool> RetirementMetadataIsValidAsync(CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_retirement", null, ct)) return true;
        return Convert.ToInt64(await ScalarAsync("""
            SELECT EXISTS(SELECT 1 FROM __nendo_retirement r WHERE
                (r.kind='entity' AND NOT EXISTS(SELECT 1 FROM __nendo_entity e WHERE e.entity_id=r.semantic_id)) OR
                (r.kind='field' AND NOT EXISTS(SELECT 1 FROM __nendo_field f WHERE f.field_id=r.semantic_id)));
            """, null, ct), CultureInfo.InvariantCulture) == 0;
    }

    private async Task<OperationEvidence> ExecuteSetRetiredAsync(SetRetiredOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = operation.FieldId is null ? null : entity.Fields.SingleOrDefault(field => field.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The field does not belong to this record type.");
        var previous = field?.Retired ?? entity.Retired;
        if (field is not null && entity.Retired) throw new NendoPreconditionException("entity-retired", "Reactivate the record type before changing field retirement.");
        if (field is null && operation.Retired)
        {
            foreach (var source in await ReadEntityMappingsAsync(transaction, ct))
            foreach (var reference in source.Fields.Where(candidate => candidate.Reference?.TargetEntityId == entity.EntityId))
                if (Convert.ToInt64(await ScalarAsync($"SELECT EXISTS(SELECT 1 FROM {Quote(source.PhysicalTableName)} WHERE {Quote(reference.PhysicalColumnName)} IS NOT NULL);", transaction, ct), CultureInfo.InvariantCulture) != 0)
                    throw new NendoPreconditionException("entity-referenced", "Clear or reassign incoming references before retiring this record type.");
        }
        if (field is not null && !operation.Retired && field.Required && await TableExistsAsync(entity.PhysicalTableName, transaction, ct) &&
            Convert.ToInt64(await ScalarAsync($"SELECT EXISTS(SELECT 1 FROM {Quote(entity.PhysicalTableName)} WHERE {Quote(field.PhysicalColumnName)} IS NULL);", transaction, ct), CultureInfo.InvariantCulture) != 0)
            throw new NendoPreconditionException("required-backfill-needed", "Records created while this required field was retired have no value. Review an explicit backfill before reactivation.");
        if (!await TableExistsAsync("__nendo_reference", transaction, ct)) await NonQueryAsync(ReferenceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) await NonQueryAsync(DeletionSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_choice", transaction, ct)) await NonQueryAsync(ChoiceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_retirement", transaction, ct)) await NonQueryAsync(RetirementSchemaSql, transaction, ct);
        await using (var save = Command("""
            INSERT INTO __nendo_retirement(kind,semantic_id,retired) VALUES(@kind,@id,@retired)
            ON CONFLICT(kind,semantic_id) DO UPDATE SET retired=excluded.retired;
            """, transaction))
        {
            save.Parameters.AddWithValue("@kind", field is null ? "entity" : "field"); save.Parameters.AddWithValue("@id", operation.FieldId ?? operation.EntityId);
            save.Parameters.AddWithValue("@retired", operation.Retired ? 1 : 0); await save.ExecuteNonQueryAsync(ct);
        }
        if (field?.Required == true && previous != operation.Retired && await TableExistsAsync(entity.PhysicalTableName, transaction, ct))
            await RebuildRequiredConstraintsAsync(await GetEntityMappingAsync(entity.EntityId, transaction, ct), transaction, ct);
        return new(operation, Evidence(new { previousRetired = previous, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        { RequiredHostVersion = NendoFormat.RetirementMinimumHostVersion };
    }

    private async Task RebuildRequiredConstraintsAsync(EntityMapping entity, SqliteTransaction transaction, CancellationToken ct)
    {
        // Transactional rebuild changes only nullability; retain every value, ID/version and declared index/trigger.
        var retainedObjects = new List<string>();
        await using (var query = Command("SELECT sql FROM sqlite_schema WHERE tbl_name=@table AND type IN ('index','trigger') AND sql IS NOT NULL;", transaction))
        {
            query.Parameters.AddWithValue("@table", entity.PhysicalTableName);
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct)) retainedObjects.Add(rows.GetString(0));
        }
        var temporary = "retirement_" + Guid.NewGuid().ToString("N");
        var definitions = new List<string> { "__nendo_record_id TEXT NOT NULL PRIMARY KEY", "__nendo_record_version INTEGER NOT NULL CHECK (__nendo_record_version >= 1)" };
        definitions.AddRange(entity.Fields.Select(field => $"{Quote(field.PhysicalColumnName)} {SqliteType(field.StorageKind)}{(field.Required && !field.Retired ? " NOT NULL" : "")}"));
        await NonQueryAsync($"CREATE TABLE {Quote(temporary)} ({string.Join(",", definitions)});", transaction, ct);
        var columns = string.Join(",", new[] { "__nendo_record_id", "__nendo_record_version" }.Concat(entity.Fields.Select(field => field.PhysicalColumnName)).Select(Quote));
        await NonQueryAsync($"INSERT INTO {Quote(temporary)} ({columns}) SELECT {columns} FROM {Quote(entity.PhysicalTableName)};", transaction, ct);
        await NonQueryAsync($"DROP TABLE {Quote(entity.PhysicalTableName)}; ALTER TABLE {Quote(temporary)} RENAME TO {Quote(entity.PhysicalTableName)};", transaction, ct);
        foreach (var sql in retainedObjects) await NonQueryAsync(sql, transaction, ct);
    }

    private async Task ValidateRetiredBindingsAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        var entities = await RetiredIdsAsync("entity", transaction, ct);
        var fields = await RetiredIdsAsync("field", transaction, ct);
        if (entities.Count == 0 && fields.Count == 0) return;
        foreach (var entity in await ReadEntityMappingsAsync(transaction, ct))
            if (entity.Retired) fields.UnionWith(entity.Fields.Select(field => field.FieldId));
        foreach (var node in await ReadUiNodesAsync(transaction, ct))
        foreach (var pair in node.Properties)
        {
            var retired = pair.Key is "entityId" or "edgeEntityId" ? entities : fields;
            if (pair.Key is not ("entityId" or "fieldId" or "groupByFieldId" or "cardFieldIds") &&
                !(NendoExtensionViewDefinition.IsViewKind(node.Kind) && pair.Key is "edgeEntityId" or "labelFieldId" or "sourceFieldId" or "targetFieldId" or "statusFieldId")) continue;
            if ((pair.Value.ValueKind == JsonValueKind.String && retired.Contains(pair.Value.GetString()!)) ||
                (pair.Value.ValueKind == JsonValueKind.Array && pair.Value.EnumerateArray().Any(value => value.ValueKind == JsonValueKind.String && retired.Contains(value.GetString()!))))
                throw new NendoPreconditionException("retired-binding", "Remove or replace surface bindings to the retired definition in the same proposal.");
        }
    }

    private static SetRetiredOperation CreateRetirementInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson); using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload"); var prior = evidence.RootElement;
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0), payload.GetProperty("entityId").GetString()!,
            payload.GetProperty("fieldId").GetString(), prior.GetProperty("previousRetired").GetBoolean(), prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }
}
