using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private async Task<OperationEvidence> ExecuteSetFieldPresentationAsync(
        SetFieldPresentationOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = entity.Fields.SingleOrDefault(candidate => candidate.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", $"Field {operation.FieldId} does not belong to {entity.DisplayName}.");
        RequireActive(entity, field);
        var previous = field.Presentation ?? "singleLine";
        if (field.StorageKind != NendoStorageKind.Text || !SetFieldPresentationOperation.TextPresentations.Contains(previous))
            throw new NendoPreconditionException("field-presentation-invalid",
                $"{field.DisplayName} is not a text field shown as a single line, long text or Markdown, so its presentation cannot change.");
        if (previous == operation.Presentation)
            throw new NendoPreconditionException("field-presentation-unchanged",
                $"{field.DisplayName} is already shown as {operation.Presentation}.");
        if (field.Unique && operation.Presentation != "singleLine")
            throw new NendoPreconditionException("field-presentation-invalid",
                $"{field.DisplayName} is unique, which only a single-line text field can be. Stop keeping it unique first.");

        await using (var update = Command("UPDATE __nendo_field SET presentation = @presentation WHERE field_id = @field;", transaction))
        {
            update.Parameters.AddWithValue("@presentation", operation.Presentation);
            update.Parameters.AddWithValue("@field", field.FieldId);
            await update.ExecuteNonQueryAsync(ct);
        }
        return new OperationEvidence(operation, Evidence(new
        {
            previousPresentation = field.Presentation,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            // A new operation in the file's history, whichever presentation it chose: no older host
            // can replay it.
            RequiredHostVersion = NendoFormat.MarkdownPresentationMinimumHostVersion,
        };
    }

    private static SetFieldPresentationOperation CreateSetFieldPresentationInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var previous = evidence.RootElement.GetProperty("previousPresentation");
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            payload.GetProperty("entityId").GetString()!,
            payload.GetProperty("fieldId").GetString()!,
            previous.ValueKind == JsonValueKind.String ? previous.GetString()! : "singleLine",
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }
}
