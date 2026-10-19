using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// A field's rules, ADR-0020: whether it is unique, and the sequence that fills it in. Its
    /// own table on the last rung of the layout ladder, for the reason the tone, scale and
    /// hierarchy tables give. A row exists only for a unique field; the sequence columns are
    /// set together or not at all, and only on a unique field. The whole shape is fixed here,
    /// sequences included, because a rung's DDL is its fingerprint and cannot grow later.
    /// </summary>
    private const string FieldRuleSchemaSql = """
        CREATE TABLE __nendo_field_rule (
            field_id TEXT NOT NULL PRIMARY KEY,
            is_unique INTEGER NOT NULL CHECK (is_unique = 1),
            sequence_prefix TEXT NULL,
            sequence_width INTEGER NULL,
            sequence_next INTEGER NULL,
            CHECK ((sequence_prefix IS NULL) = (sequence_width IS NULL) AND (sequence_prefix IS NULL) = (sequence_next IS NULL)),
            CHECK (sequence_width IS NULL OR sequence_width BETWEEN 1 AND 9),
            CHECK (sequence_next IS NULL OR sequence_next >= 1),
            FOREIGN KEY (field_id) REFERENCES __nendo_field(field_id)
        );
        """;

    /// <summary>Brings the protected layout up to the field-rule rung: the whole ladder, then the rule table.</summary>
    private async Task EnsureFieldRuleLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureHierarchyLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_field_rule", transaction, ct)) await NonQueryAsync(FieldRuleSchemaSql, transaction, ct);
    }

    /// <summary>The unique fields by ID. A file that never declared one carries no table.</summary>
    private async Task<HashSet<string>> ReadUniqueFieldsAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var unique = new HashSet<string>(StringComparer.Ordinal);
        if (!await TableExistsAsync("__nendo_field_rule", transaction, ct)) return unique;
        await using var query = Command("SELECT field_id FROM __nendo_field_rule WHERE is_unique = 1;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) unique.Add(rows.GetString(0));
        return unique;
    }

    /// <summary>Reads each field's rules back onto its mapping, on both read paths.</summary>
    private async Task PopulateFieldRulesAsync(List<FieldMapping> fields, SqliteTransaction? transaction, CancellationToken ct)
    {
        var unique = await ReadUniqueFieldsAsync(transaction, ct);
        if (unique.Count == 0) return;
        for (var index = 0; index < fields.Count; index++)
            if (unique.Contains(fields[index].FieldId)) fields[index] = fields[index] with { Unique = true };
    }

    /// <summary>What a unique field may be: single-line Text or a plain Integer, stored rather than calculated.</summary>
    private static bool CanBeUnique(FieldMapping field) =>
        field.StorageKind == NendoStorageKind.Text && field.Presentation is null or "singleLine" ||
        field.StorageKind == NendoStorageKind.Integer && field.Presentation is null;

    /// <summary>A stored rule must still name a field that can carry it; anything else is drift, reported at open.</summary>
    private async Task<bool> FieldRuleMetadataIsValidAsync(IReadOnlyList<EntityMapping> entities, CancellationToken ct)
    {
        var fields = entities.SelectMany(entity => entity.Fields).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        foreach (var id in await ReadUniqueFieldsAsync(null, ct))
            if (!fields.TryGetValue(id, out var field) || !CanBeUnique(field)) return false;
        foreach (var id in (await ReadSequencesAsync(null, ct)).Keys)
            if (!fields.TryGetValue(id, out var field) || field.StorageKind != NendoStorageKind.Text) return false;
        return true;
    }

    private static string UniqueIndexName(EntityMapping entity, FieldMapping field) =>
        $"nendo_unique_{entity.PhysicalTableName}_{field.PhysicalColumnName}";

    /// <summary>
    /// The name a unique index takes when <see cref="UniqueIndexName"/> already belongs to another
    /// table: physical names may hold underscores, so task.due_code and task_due.code both read
    /// nendo_unique_task_due_code, and IF NOT EXISTS skipped the second without a word.
    /// The field ID's digest tells them apart; an index made under the plain name keeps it.
    /// </summary>
    private static string ClashFreeUniqueIndexName(EntityMapping entity, FieldMapping field) =>
        $"{UniqueIndexName(entity, field)}_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(field.FieldId)).AsSpan(0, 4)).ToLowerInvariant()}";

    /// <summary>The table an index of this name belongs to, or null when there is none.</summary>
    private async Task<string?> IndexTableAsync(string name, SqliteTransaction transaction, CancellationToken ct)
    {
        await using var query = Command("SELECT tbl_name FROM sqlite_schema WHERE type = 'index' AND name = @name;", transaction);
        query.Parameters.AddWithValue("@name", name);
        return await query.ExecuteScalarAsync(ct) as string;
    }

    /// <summary>
    /// The index that makes the rule hold even on a path that forgot to check. Outside the
    /// protected namespace, as reference indexes are, because how many there are is the
    /// application's. Created only once the column exists: a field added in the same mutation
    /// gets it when the mutation materializes.
    /// </summary>
    private async Task EnsureUniqueIndexAsync(EntityMapping entity, FieldMapping field, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct) ||
            !await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) return;
        var column = Quote(field.PhysicalColumnName);
        var text = field.StorageKind == NendoStorageKind.Text;
        var name = UniqueIndexName(entity, field);
        if (await IndexTableAsync(name, transaction, ct) is { } owner && owner != entity.PhysicalTableName)
            name = ClashFreeUniqueIndexName(entity, field);
        await NonQueryAsync(
            $"CREATE UNIQUE INDEX IF NOT EXISTS {Quote(name)} ON {Quote(entity.PhysicalTableName)}" +
            $"({column}{(text ? " COLLATE NOCASE" : string.Empty)}) WHERE {column} IS NOT NULL{(text ? $" AND {column} <> ''" : string.Empty)};",
            transaction, ct);
    }

    private async Task<OperationEvidence> ExecuteSetFieldUniqueAsync(SetFieldUniqueOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = entity.Fields.SingleOrDefault(candidate => candidate.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", $"Field {operation.FieldId} does not belong to {entity.DisplayName}.");
        RequireActive(entity, field);
        if (operation.Unique && !CanBeUnique(field))
            throw new NendoPreconditionException("field-unique-invalid",
                $"{field.DisplayName} is {UniqueShape(field)}. Only a single-line Text field or a plain Integer field can be unique.");
        // A hierarchy orders each parent's children on their own, so positions repeat across
        // parents; uniqueness over the whole record type refused ordinary moves.
        if (operation.Unique && entity.Hierarchy?.OrderFieldId == field.FieldId)
            throw new NendoPreconditionException("hierarchy-field-in-use",
                $"{entity.DisplayName} orders its hierarchy by {field.DisplayName}, and children of different parents share positions, so it cannot be unique.");
        if (!operation.Unique && field.Sequence is not null)
            throw new NendoPreconditionException("field-sequence-in-use",
                $"{field.DisplayName} has a sequence, which needs it unique. Remove the sequence first.");
        if (operation.Unique == field.Unique)
            throw new NendoPreconditionException("field-unique-unchanged",
                $"{field.DisplayName} is already {(field.Unique ? "unique" : "not unique")}.");

        if (operation.Unique)
        {
            await RequireNoCollisionsAsync(entity, field, transaction, ct);
            await EnsureFieldRuleLayoutAsync(transaction, ct);
            await using (var insert = Command("INSERT INTO __nendo_field_rule(field_id,is_unique) VALUES(@field,1);", transaction))
            {
                insert.Parameters.AddWithValue("@field", field.FieldId);
                await insert.ExecuteNonQueryAsync(ct);
            }
            await EnsureUniqueIndexAsync(entity, field, transaction, ct);
        }
        else
        {
            await using (var delete = Command("DELETE FROM __nendo_field_rule WHERE field_id=@field;", transaction))
            {
                delete.Parameters.AddWithValue("@field", field.FieldId);
                await delete.ExecuteNonQueryAsync(ct);
            }
            // Only this table's own index: the plain name may be another table's.
            foreach (var name in new[] { UniqueIndexName(entity, field), ClashFreeUniqueIndexName(entity, field) })
                if (await IndexTableAsync(name, transaction, ct) == entity.PhysicalTableName)
                    await NonQueryAsync($"DROP INDEX {Quote(name)};", transaction, ct);
        }
        return new OperationEvidence(operation, Evidence(new { previousUnique = field.Unique, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            RequiredHostVersion = NendoFormat.FieldRuleMinimumHostVersion,
        };
    }

    private static SetFieldUniqueOperation CreateSetFieldUniqueInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var prior = evidence.RootElement;
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            payload.GetProperty("entityId").GetString()!, payload.GetProperty("fieldId").GetString()!,
            prior.GetProperty("previousUnique").GetBoolean(), prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    private static string UniqueShape(FieldMapping field) => field.Presentation switch
    {
        "singleChoice" => "a single choice",
        "longText" => "long text",
        "markdown" => "Markdown text",
        "rating" => "a rating",
        _ => $"a {field.StorageKind} field",
    };

    /// <summary>
    /// Declaring on existing data: no two records may already collide. The refusal lists the
    /// records that share a value, group by group, the first 20 groups; nothing is renumbered.
    /// It names records and never the values, which an agent reading the refusal may not see.
    /// </summary>
    private async Task RequireNoCollisionsAsync(EntityMapping entity, FieldMapping field, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct) ||
            !await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) return;
        var column = Quote(field.PhysicalColumnName);
        var text = field.StorageKind == NendoStorageKind.Text;
        var key = text ? $"{column} COLLATE NOCASE" : column;
        var collisions = new List<string>();
        await using (var query = Command($"""
            SELECT json_group_array(__nendo_record_id) FROM {Quote(entity.PhysicalTableName)}
            WHERE {column} IS NOT NULL{(text ? $" AND {column} <> ''" : string.Empty)}
            GROUP BY {key} HAVING count(*) > 1 ORDER BY min(__nendo_record_id) LIMIT 21;
            """, transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
            {
                // A record ID may hold spaces, so the group is read as a JSON array, never split on
                // a space: 'Task 1' and 'Task 2' were named '1 and 2 and Task and Task'.
                collisions.Add(string.Join(" and ", JsonSerializer.Deserialize<string[]>(rows.GetString(0))!.Order(StringComparer.Ordinal)));
            }
        if (collisions.Count == 0) return;
        var more = collisions.Count > 20 ? " and more" : string.Empty;
        throw new NendoPreconditionException("field-values-not-unique",
            $"{field.DisplayName} of {entity.DisplayName} already holds the same value on more than one record, in these groups: " +
            $"{string.Join("; ", collisions.Take(20))}{more}. Give each record its own value first; nothing was renumbered.");
    }

    /// <summary>
    /// The rule every write to a unique field obeys (ADR-0020): no other record of the type may
    /// already hold an equal value. Checked in the write's transaction before the write, so the
    /// refusal can name the record that holds it; the index stops any path that did not ask.
    /// </summary>
    private async Task RequireUniqueValueAsync(EntityMapping entity, FieldMapping field, string recordId, JsonElement value,
        SqliteTransaction transaction, CancellationToken ct)
    {
        if (!field.Unique || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return;
        var text = field.StorageKind == NendoStorageKind.Text;
        if (text && value.ValueKind == JsonValueKind.String && value.GetString()!.Length == 0) return;
        if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct) ||
            !await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) return;
        await using var query = Command(
            $"SELECT __nendo_record_id FROM {Quote(entity.PhysicalTableName)} " +
            $"WHERE {Quote(field.PhysicalColumnName)} = @value{(text ? " COLLATE NOCASE" : string.Empty)} AND __nendo_record_id <> @record " +
            "ORDER BY __nendo_record_id LIMIT 1;", transaction);
        query.Parameters.AddWithValue("@value", ConvertValue(field, value));
        query.Parameters.AddWithValue("@record", recordId);
        if (await query.ExecuteScalarAsync(ct) is string holder)
            throw new NendoPreconditionException("value-not-unique",
                $"That {field.DisplayName} is already used by {holder} in {entity.DisplayName}; each record needs its own.")
            { RecordId = holder };
    }
}
