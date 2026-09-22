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
    /// A choice option's colour, ADR-0004 2026-09-14 amendment. Its own table rather
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
            throw new NendoValidationException("Choose an existing stable option from a single-choice field.");
        RequireActive(entity, field);
        if (operation.DisplayName.Length > 200 || string.IsNullOrWhiteSpace(operation.DisplayName))
            throw new NendoValidationException("Choice labels require 1–200 characters.");
        if (operation.Tone is not null && !NendoSemanticVocabulary.ChoiceTones.Contains(operation.Tone))
            throw new NendoValidationException(
                $"Choose a tone from {string.Join(", ", NendoSemanticVocabulary.ChoiceToneOrder)}, or null for no colour; a hex value is not a tone.");
        var choices = field.Options.Select(id => field.Choices.SingleOrDefault(choice => choice.Id == id) ?? new(id, id, false)).ToList();
        var previous = choices.Single(choice => choice.Id == operation.ChoiceId);
        var updated = choices.Select(choice => choice.Id == operation.ChoiceId ? new NendoChoiceOption(choice.Id, operation.DisplayName, operation.Retired, operation.Tone) : choice).ToList();
        if (updated.Select(choice => choice.DisplayName.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() != updated.Count)
            throw new NendoPreconditionException("label-conflict", "Choice labels must be unique within this field.");
        if (!await TableExistsAsync("__nendo_reference", transaction, ct)) await NonQueryAsync(ReferenceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) await NonQueryAsync(DeletionSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_choice", transaction, ct)) await NonQueryAsync(ChoiceSchemaSql, transaction, ct);
        // A tone is the last rung of the protected layout ladder, so the first one a
        // file takes creates the whole prefix, as a first choice edit and a first
        // behaviour definition do. A file that never colours anything keeps the
        // layout it had.
        if (operation.Tone is not null) await EnsureChoiceToneLayoutAsync(transaction, ct);
        foreach (var choice in updated)
        {
            await using var save = Command("""
                INSERT INTO __nendo_choice(field_id,choice_id,display_name,retired) VALUES(@field,@id,@name,@retired)
                ON CONFLICT(field_id,choice_id) DO UPDATE SET display_name=excluded.display_name,retired=excluded.retired;
                """, transaction);
            save.Parameters.AddWithValue("@field", field.FieldId); save.Parameters.AddWithValue("@id", choice.Id);
            save.Parameters.AddWithValue("@name", choice.DisplayName); save.Parameters.AddWithValue("@retired", choice.Retired ? 1 : 0);
            await save.ExecuteNonQueryAsync(ct);
        }
        if (await TableExistsAsync("__nendo_choice_tone", transaction, ct))
        {
            await using var tone = Command(operation.Tone is null
                ? "DELETE FROM __nendo_choice_tone WHERE field_id=@field AND choice_id=@id;"
                : """
                  INSERT INTO __nendo_choice_tone(field_id,choice_id,tone) VALUES(@field,@id,@tone)
                  ON CONFLICT(field_id,choice_id) DO UPDATE SET tone=excluded.tone;
                  """, transaction);
            tone.Parameters.AddWithValue("@field", field.FieldId); tone.Parameters.AddWithValue("@id", operation.ChoiceId);
            if (operation.Tone is not null) tone.Parameters.AddWithValue("@tone", operation.Tone);
            await tone.ExecuteNonQueryAsync(ct);
        }
        return new(operation, Evidence(new { previousDisplayName = previous.DisplayName, previousRetired = previous.Retired,
            previousTone = previous.Tone, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            RequiredHostVersion = operation.Tone is null ? NendoFormat.ChoiceMinimumHostVersion : NendoFormat.ColourAndHeaderMinimumHostVersion,
        };
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

    private static bool ChoiceMetadataIsValid(IReadOnlyList<EntityMapping> entities) => entities.SelectMany(entity => entity.Fields)
        .All(field => field.Choices.Count == 0 || (field.Presentation == "singleChoice" && field.StorageKind == NendoStorageKind.Text &&
            field.Choices.Count == field.Options.Count && field.Choices.All(choice => field.Options.Contains(choice.Id, StringComparer.Ordinal) &&
                !string.IsNullOrWhiteSpace(choice.DisplayName) && choice.DisplayName.Length <= 200 &&
                (choice.Tone is null || NendoSemanticVocabulary.ChoiceTones.Contains(choice.Tone))) &&
            field.Choices.Select(choice => choice.DisplayName.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() == field.Choices.Count));

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
