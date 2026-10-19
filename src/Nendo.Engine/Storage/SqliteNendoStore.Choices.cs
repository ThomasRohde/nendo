using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private const string ChoiceSchemaSql = """
        CREATE TABLE __nendo_choice (
            field_id TEXT NOT NULL,
            choice_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
            PRIMARY KEY (field_id, choice_id),
            FOREIGN KEY (field_id) REFERENCES __nendo_field(field_id)
        );
        """;

    /// <summary>
    /// A choice option's colour, ADR-0004. Its own table rather
    /// than a column on <c>__nendo_choice</c>, because the protected layout is a
    /// fingerprint of verbatim DDL: a fresh file and an older one that gains a tone
    /// must end with byte-identical schema text, which an ALTER TABLE rewrite does not
    /// promise. A row exists only for an option that has a tone, and the closed set is
    /// checked here as well as in the vocabulary, so a row nothing authored cannot be
    /// read back as a colour.
    /// </summary>
    private const string ChoiceToneSchemaSql = """
        CREATE TABLE __nendo_choice_tone (
            field_id TEXT NOT NULL,
            choice_id TEXT NOT NULL,
            tone TEXT NOT NULL CHECK (tone IN ('red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'grey')),
            PRIMARY KEY (field_id, choice_id),
            FOREIGN KEY (field_id, choice_id) REFERENCES __nendo_choice(field_id, choice_id)
        );
        """;

    private async Task PopulateChoicesAsync(List<FieldMapping> fields, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_choice", transaction, ct)) return;
        var sql = await TableExistsAsync("__nendo_choice_tone", transaction, ct)
            ? "SELECT c.field_id,c.choice_id,c.display_name,c.retired,t.tone FROM __nendo_choice c LEFT JOIN __nendo_choice_tone t ON t.field_id=c.field_id AND t.choice_id=c.choice_id;"
            : "SELECT field_id,choice_id,display_name,retired,NULL FROM __nendo_choice;";
        var entries = new Dictionary<string, List<NendoChoiceOption>>(StringComparer.Ordinal);
        await using (var query = Command(sql, transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
            {
                var id = rows.GetString(0);
                if (!entries.TryGetValue(id, out var options)) entries[id] = options = [];
                options.Add(new(rows.GetString(1), rows.GetString(2), rows.GetInt64(3) != 0, rows.IsDBNull(4) ? null : rows.GetString(4)));
            }
        for (var index = 0; index < fields.Count; index++)
            if (entries.TryGetValue(fields[index].FieldId, out var choices))
                fields[index] = fields[index] with { Choices = choices.AsReadOnly() };
    }

    private async Task<OperationEvidence> ExecuteSetChoiceMetadataAsync(SetChoiceMetadataOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        RequireActive(entity);
        var field = entity.Fields.SingleOrDefault(field => field.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The field does not belong to this record type.");
        if (field.Presentation != "singleChoice" || !field.Options.Contains(operation.ChoiceId, StringComparer.Ordinal))
            throw new NendoValidationException(
                "Choose an existing stable option from a single-choice field. A new option is added with schema.addChoice.");
        RequireActive(entity, field);
        NendoChoiceRules.RequireLabel(operation.DisplayName);
        NendoChoiceRules.RequireTone(operation.Tone);
        var choices = field.Options.Select(id => field.Choices.SingleOrDefault(choice => choice.Id == id) ?? new(id, id, false)).ToList();
        var previous = choices.Single(choice => choice.Id == operation.ChoiceId);
        var updated = choices.Select(choice => choice.Id == operation.ChoiceId ? new NendoChoiceOption(choice.Id, operation.DisplayName, operation.Retired, operation.Tone) : choice).ToList();
        if (updated.Select(choice => choice.DisplayName.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() != updated.Count)
            throw new NendoPreconditionException("label-conflict", "Choice labels must be unique within this field.");
        await WriteChoiceRowsAsync(field.FieldId, updated, operation.ChoiceId, operation.Tone, transaction, ct);
        return new(operation, Evidence(new { previousDisplayName = previous.DisplayName, previousRetired = previous.Retired,
            previousTone = previous.Tone, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            RequiredHostVersion = operation.Tone is null ? NendoFormat.ChoiceMinimumHostVersion : NendoFormat.ColourAndHeaderMinimumHostVersion,
        };
    }

    /// <summary>
    /// Writes a field's whole option metadata, every option in its order, and the one option's
    /// tone, creating the tables the choice rung needs first. Shared by the operation that names an
    /// option and the one that adds one, so both land a file on the same layout.
    /// </summary>
    private async Task WriteChoiceRowsAsync(string fieldId, IReadOnlyList<NendoChoiceOption> choices, string tonedChoiceId, string? tone,
        SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_reference", transaction, ct)) await NonQueryAsync(ReferenceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) await NonQueryAsync(DeletionSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_choice", transaction, ct)) await NonQueryAsync(ChoiceSchemaSql, transaction, ct);
        // A tone is the last rung of the protected layout ladder, so the first one a
        // file takes creates the whole prefix, as a first choice edit and a first
        // behaviour definition do. A file that never colours anything keeps the
        // layout it had.
        if (tone is not null) await EnsureChoiceToneLayoutAsync(transaction, ct);
        foreach (var choice in choices)
        {
            await using var save = Command("""
                INSERT INTO __nendo_choice(field_id,choice_id,display_name,retired) VALUES(@field,@id,@name,@retired)
                ON CONFLICT(field_id,choice_id) DO UPDATE SET display_name=excluded.display_name,retired=excluded.retired;
                """, transaction);
            save.Parameters.AddWithValue("@field", fieldId); save.Parameters.AddWithValue("@id", choice.Id);
            save.Parameters.AddWithValue("@name", choice.DisplayName); save.Parameters.AddWithValue("@retired", choice.Retired ? 1 : 0);
            await save.ExecuteNonQueryAsync(ct);
        }
        if (await TableExistsAsync("__nendo_choice_tone", transaction, ct))
        {
            await using var toned = Command(tone is null
                ? "DELETE FROM __nendo_choice_tone WHERE field_id=@field AND choice_id=@id;"
                : """
                  INSERT INTO __nendo_choice_tone(field_id,choice_id,tone) VALUES(@field,@id,@tone)
                  ON CONFLICT(field_id,choice_id) DO UPDATE SET tone=excluded.tone;
                  """, transaction);
            toned.Parameters.AddWithValue("@field", fieldId); toned.Parameters.AddWithValue("@id", tonedChoiceId);
            if (tone is not null) toned.Parameters.AddWithValue("@tone", tone);
            await toned.ExecuteNonQueryAsync(ct);
        }
    }

    /// <summary>
    /// A new stable option at the end of a single-choice field (ADR-0003). The
    /// options list in <c>__nendo_field</c> gains the ID and <c>__nendo_choice</c> gains its label,
    /// with a row for every option as a first label edit writes them, so the two stay one list.
    /// No table is altered and no record is touched.
    /// </summary>
    private async Task<OperationEvidence> ExecuteAddChoiceAsync(AddChoiceOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        RequireActive(entity);
        var field = entity.Fields.SingleOrDefault(field => field.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The field does not belong to this record type.");
        if (field.Presentation != "singleChoice" || field.StorageKind != NendoStorageKind.Text)
            throw new NendoValidationException($"{field.DisplayName} is not a single-choice field, so it takes no options.");
        RequireActive(entity, field);
        if (field.Options.Contains(operation.ChoiceId, StringComparer.Ordinal))
            throw new NendoValidationException(
                $"{field.DisplayName} already has the option {operation.ChoiceId}" +
                (field.Choices.Any(choice => choice.Id == operation.ChoiceId && choice.Retired) ? ", retired" : "") +
                ". Use schema.setChoiceMetadata to rename it, colour it or make it available again.");
        if (field.Options.Count >= NendoChoiceRules.MaximumOptions)
            throw new NendoValidationException(
                $"{field.DisplayName} already has {field.Options.Count} options, retired ones included, and a single-choice field holds at most {NendoChoiceRules.MaximumOptions}.");
        NendoChoiceRules.RequireLabel(operation.DisplayName);
        NendoChoiceRules.RequireTone(operation.Tone);
        var choices = field.Options.Select(id => field.Choices.SingleOrDefault(choice => choice.Id == id) ?? new(id, id, false)).ToList();
        if (choices.FirstOrDefault(choice => string.Equals(choice.DisplayName.Trim(), operation.DisplayName.Trim(), StringComparison.OrdinalIgnoreCase)) is { } clash)
            throw new NendoPreconditionException("label-conflict",
                $"Choice labels must be unique within this field: {clash.DisplayName} already names the option {clash.Id} in {field.DisplayName}.");
        choices.Add(new NendoChoiceOption(operation.ChoiceId, operation.DisplayName, false, operation.Tone));
        await using (var options = Command("UPDATE __nendo_field SET options_json=@options WHERE field_id=@field;", transaction))
        {
            options.Parameters.AddWithValue("@options", JsonSerializer.Serialize(field.Options.Append(operation.ChoiceId).ToArray()));
            options.Parameters.AddWithValue("@field", field.FieldId);
            await options.ExecuteNonQueryAsync(ct);
        }
        await WriteChoiceRowsAsync(field.FieldId, choices, operation.ChoiceId, operation.Tone, transaction, ct);
        return new(operation, Evidence(new { hadChoiceMetadata = field.Choices.Count > 0,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            // Nothing newer than a label edit: the options list and the choice table are the ones
            // that edit already uses, and a tone states the colour rung as it does there.
            RequiredHostVersion = operation.Tone is null ? NendoFormat.ChoiceMinimumHostVersion : NendoFormat.ColourAndHeaderMinimumHostVersion,
        };
    }

    /// <summary>
    /// The undo of an added option: takes it off the field again, with its label and tone. Refused
    /// by name while any record holds it, a deleted one kept for its own undo included, because
    /// that record would then hold a value its field does not offer.
    /// </summary>
    private async Task<OperationEvidence> ExecuteRemoveChoiceAsync(RemoveChoiceOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = entity.Fields.SingleOrDefault(field => field.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The field does not belong to this record type.");
        if (field.Presentation != "singleChoice" || !field.Options.Contains(operation.ChoiceId, StringComparer.Ordinal))
            throw new NendoValidationException("Choose an existing stable option from a single-choice field.");
        var label = field.Choices.SingleOrDefault(choice => choice.Id == operation.ChoiceId)?.DisplayName ?? operation.ChoiceId;
        await RequireChoiceUnheldAsync(entity, field, operation.ChoiceId, label, transaction, ct);
        await using (var options = Command("UPDATE __nendo_field SET options_json=@options WHERE field_id=@field;", transaction))
        {
            options.Parameters.AddWithValue("@options", JsonSerializer.Serialize(field.Options.Where(id => id != operation.ChoiceId).ToArray()));
            options.Parameters.AddWithValue("@field", field.FieldId);
            await options.ExecuteNonQueryAsync(ct);
        }
        if (await TableExistsAsync("__nendo_choice_tone", transaction, ct))
        {
            await using var tone = Command(operation.ClearsChoiceMetadata
                ? "DELETE FROM __nendo_choice_tone WHERE field_id=@field;"
                : "DELETE FROM __nendo_choice_tone WHERE field_id=@field AND choice_id=@id;", transaction);
            tone.Parameters.AddWithValue("@field", field.FieldId); tone.Parameters.AddWithValue("@id", operation.ChoiceId);
            await tone.ExecuteNonQueryAsync(ct);
        }
        if (await TableExistsAsync("__nendo_choice", transaction, ct))
        {
            await using var rows = Command(operation.ClearsChoiceMetadata
                ? "DELETE FROM __nendo_choice WHERE field_id=@field;"
                : "DELETE FROM __nendo_choice WHERE field_id=@field AND choice_id=@id;", transaction);
            rows.Parameters.AddWithValue("@field", field.FieldId); rows.Parameters.AddWithValue("@id", operation.ChoiceId);
            await rows.ExecuteNonQueryAsync(ct);
        }
        return new(operation, Evidence(new { removedDisplayName = label, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            RequiredHostVersion = NendoFormat.ChoiceMinimumHostVersion,
        };
    }

    /// <summary>
    /// Refuses, naming the record, while a record of the type holds the option, or a deleted one
    /// keeps it for the undo of its deletion: restoring that record would bring back a value its
    /// field no longer offers, so the option stays and the remedy is to retire it instead.
    /// </summary>
    private async Task RequireChoiceUnheldAsync(EntityMapping entity, FieldMapping field, string choiceId, string label,
        SqliteTransaction transaction, CancellationToken ct)
    {
        if (await TableExistsAsync(entity.PhysicalTableName, transaction, ct) &&
            await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct))
        {
            await using var live = Command(
                $"SELECT __nendo_record_id FROM {Quote(entity.PhysicalTableName)} WHERE {Quote(field.PhysicalColumnName)} = @choice " +
                "ORDER BY __nendo_record_id LIMIT 1;", transaction);
            live.Parameters.AddWithValue("@choice", choiceId);
            if (await live.ExecuteScalarAsync(ct) is string recordId)
                throw new NendoCompensationNotSupportedException(
                    $"{entity.DisplayName} {recordId} holds {label} in {field.DisplayName}, so adding {label} is not undone. " +
                    $"Choose another option on every record that holds it and undo again, or retire {label} instead.");
        }
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) return;
        await using var kept = Command(
            "SELECT record_id, values_json FROM __nendo_deleted_record WHERE entity_id=@entity AND is_deleted=1 ORDER BY record_id;",
            transaction);
        kept.Parameters.AddWithValue("@entity", entity.EntityId);
        // Each kept record's own value for the field is read; matching the stored text instead
        // would depend on how its JSON escaped the option.
        await using var rows = await kept.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            using var values = JsonDocument.Parse(rows.GetString(1));
            if (values.RootElement.ValueKind == JsonValueKind.Object &&
                values.RootElement.TryGetProperty(field.FieldId, out var held) &&
                held.ValueKind == JsonValueKind.String && held.GetString() == choiceId)
                throw new NendoCompensationNotSupportedException(
                    $"The deleted {entity.DisplayName} {rows.GetString(0)} held {label} in {field.DisplayName}, and keeps it so its deletion can be undone, " +
                    $"so adding {label} is not undone. Retire {label} instead.");
        }
    }

    /// <summary>Brings the protected layout up to the tone rung: the whole ladder, then the tone table.</summary>
    private async Task EnsureChoiceToneLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureBehaviourLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_choice_tone", transaction, ct)) await NonQueryAsync(ChoiceToneSchemaSql, transaction, ct);
    }

    private static void ValidateChoiceAssignment(FieldMapping field, JsonElement value, JsonElement? previous = null)
    {
        if (value.ValueKind != JsonValueKind.String || !field.Choices.Any(choice => choice.Id == value.GetString() && choice.Retired)) return;
        if (previous is { } retained && JsonElement.DeepEquals(value, retained)) return;
        throw new NendoPreconditionException("choice-retired", "This choice is retired. Select an available choice.");
    }

    /// <summary>
    /// A restore brings back only what the record held, so a retired option it held refuses
    /// the restore by name, with the route that works, rather than asking for a choice there is
    /// nothing to make.
    /// </summary>
    private static void RequireRestorableChoice(EntityMapping entity, FieldMapping field, string recordId, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String ||
            field.Choices.FirstOrDefault(choice => choice.Id == value.GetString() && choice.Retired) is not { } retired) return;
        throw new NendoPreconditionException("choice-retired",
            $"{recordId} held {retired.DisplayName} in {entity.DisplayName}'s {field.DisplayName}, and {retired.DisplayName} is retired now, " +
            $"so the deletion is not undone. Make {retired.DisplayName} available again in Structure, undo again, then retire it.");
    }

    private static bool ChoiceMetadataIsValid(IReadOnlyList<EntityMapping> entities) => entities.SelectMany(entity => entity.Fields)
        .All(field => field.Choices.Count == 0 || (field.Presentation == "singleChoice" && field.StorageKind == NendoStorageKind.Text &&
            field.Choices.Count == field.Options.Count && field.Choices.All(choice => field.Options.Contains(choice.Id, StringComparer.Ordinal) &&
                !string.IsNullOrWhiteSpace(choice.DisplayName) && choice.DisplayName.Length <= 200 &&
                (choice.Tone is null || NendoSemanticVocabulary.ChoiceTones.Contains(choice.Tone))) &&
            field.Choices.Select(choice => choice.DisplayName.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() == field.Choices.Count));

    /// <summary>The undo of an added option, from its own payload and evidence.</summary>
    private static RemoveChoiceOperation CreateAddChoiceInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson); using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload"); var prior = evidence.RootElement;
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            payload.GetProperty("entityId").GetString()!, payload.GetProperty("fieldId").GetString()!, payload.GetProperty("choiceId").GetString()!,
            !prior.GetProperty("hadChoiceMetadata").GetBoolean(), prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    private static SetChoiceMetadataOperation CreateChoiceInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson); using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload"); var prior = evidence.RootElement;
        // Evidence written before tones existed has no previousTone; the option had none.
        var previousTone = prior.TryGetProperty("previousTone", out var tone) && tone.ValueKind == JsonValueKind.String ? tone.GetString() : null;
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            payload.GetProperty("entityId").GetString()!, payload.GetProperty("fieldId").GetString()!, payload.GetProperty("choiceId").GetString()!,
            prior.GetProperty("previousDisplayName").GetString()!, prior.GetProperty("previousRetired").GetBoolean(), prior.GetProperty("appliedDefinitionRevision").GetInt64(),
            previousTone);
    }
}
