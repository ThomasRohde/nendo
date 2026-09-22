using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    // The manifest already holds the value the caller should have sent: UpdateManifestAsync runs once per
    // mutation inside this transaction, so at the moment an operation fails the revision equals the captured
    // revision plus the definition-lane mutations before it. Hand that number back instead of a bare refusal.
    private static NendoPreconditionException DefinitionVersionConflict(
        long expected,
        long actual,
        string retry = "proposal") =>
        new(
            "definition-version-conflict",
            $"This operation expected definition revision {expected}; the file is at {actual}. "
            + $"Use expectedDefinitionRevision {actual} for this operation. Within one change set the definition "
            + "revision increases by one for each definition-lane mutation that precedes it. "
            + $"Review a fresh {retry}.");

    private async Task RequireUniqueDisplayNameAsync(string displayName, string? entityId, string? excludeId,
        SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        if (displayName.Length is < 1 or > 200 || string.IsNullOrWhiteSpace(displayName))
            throw new NendoValidationException("Display names require 1–200 characters.");
        var sql = entityId is null ? "SELECT entity_id, display_name FROM __nendo_entity;"
            : "SELECT field_id, display_name FROM __nendo_field WHERE entity_id = @entity;";
        await using var command = Command(sql, transaction);
        if (entityId is not null) command.Parameters.AddWithValue("@entity", entityId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            if (reader.GetString(0) != excludeId && StringComparer.OrdinalIgnoreCase.Equals(reader.GetString(1).Trim(), displayName.Trim()))
                throw new NendoPreconditionException("label-conflict", "That display name is already used in this scope.");
    }

    private async Task<OperationEvidence> ExecuteRenameAsync(NendoOperation operation, string entityId, string? fieldId,
        string displayName, long expectedDefinitionRevision, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        if (manifest.DefinitionRevision != expectedDefinitionRevision)
            throw DefinitionVersionConflict(expectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(entityId, transaction, cancellationToken);
        RequireActive(entity, fieldId is null ? null : entity.Fields.SingleOrDefault(field => field.FieldId == fieldId));
        var previous = fieldId is null ? entity.DisplayName : entity.Fields.SingleOrDefault(f => f.FieldId == fieldId)?.DisplayName
            ?? throw new NendoPreconditionException("field-not-found", "The field does not belong to this record type.");
        await RequireUniqueDisplayNameAsync(displayName, fieldId is null ? null : entityId, fieldId ?? entityId, transaction, cancellationToken);
        var sql = fieldId is null ? "UPDATE __nendo_entity SET display_name = @name WHERE entity_id = @id;"
            : "UPDATE __nendo_field SET display_name = @name WHERE field_id = @id;";
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@name", displayName);
        command.Parameters.AddWithValue("@id", fieldId ?? entityId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return new(operation, Evidence(new { previousDisplayName = previous, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        { RequiredHostVersion = NendoFormat.EvolutionMinimumHostVersion };
    }

    private static NendoOperation CreateRenameInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var id = NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0);
        var entity = payload.GetProperty("entityId").GetString()!;
        var previous = evidence.RootElement.GetProperty("previousDisplayName").GetString()!;
        var version = evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64();
        return payload.TryGetProperty("fieldId", out var field)
            ? new RenameFieldOperation(id, entity, field.GetString()!, previous, version)
            : new RenameEntityOperation(id, entity, previous, version);
    }
}
