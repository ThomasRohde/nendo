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
                $"{field.DisplayName} is not a text field shown as a single line, long text, Markdown or media, so its presentation cannot change.");
        if (previous == operation.Presentation)
            throw new NendoPreconditionException("field-presentation-unchanged",
                $"{field.DisplayName} is already shown as {operation.Presentation}.");
        if (field.Unique && operation.Presentation != "singleLine")
            throw new NendoPreconditionException("field-presentation-invalid",
                $"{field.DisplayName} is unique, which only a single-line text field can be. Stop keeping it unique first.");
        await RequireNotLinkRuleFieldAsync(entity, field.FieldId, "shown another way", transaction, ct);
        if (operation.Presentation == NendoMedia.Presentation) await RequireMediaValuesAsync(entity, field, transaction, ct);

        await using (var update = Command("UPDATE __nendo_field SET presentation = @presentation WHERE field_id = @field;", transaction))
        {
            update.Parameters.AddWithValue("@presentation", operation.RestoresNone ? DBNull.Value : operation.Presentation);
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
            // can replay it. Media is newer still, and so is a field that leaves it.
            RequiredHostVersion = operation.Presentation == NendoMedia.Presentation || previous == NendoMedia.Presentation
                ? NendoFormat.MediaMinimumHostVersion
                : NendoFormat.MarkdownPresentationMinimumHostVersion,
        };
    }

    /// <summary>
    /// A field becomes media only while every value it holds is an address, and every embedded one
    /// names a picture the file holds (ADR-0031 points 2 and 5). The refusal names the first record
    /// that is not, by ID, never by what it holds.
    /// </summary>
    private async Task RequireMediaValuesAsync(EntityMapping entity, FieldMapping field, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct) ||
            !await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) return;
        await using (var query = Command(
            $"SELECT __nendo_record_id, {Quote(field.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} " +
            $"WHERE {Quote(field.PhysicalColumnName)} IS NOT NULL ORDER BY __nendo_record_id;", transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct))
            {
                if (rows.GetValue(1) is not string value || !NendoMediaAddress.TryParse(value, out _))
                    throw new NendoPreconditionException("media-address-invalid",
                        $"{field.DisplayName} cannot be shown as media while {entity.DisplayName} {rows.GetString(0)} holds a value that is not a picture's address. Correct or clear it first.");
            }
        }
        await RequireMediaPresentAsync(entity, [field], null, transaction, ct);
    }

    private static SetFieldPresentationOperation CreateSetFieldPresentationInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var previous = evidence.RootElement.GetProperty("previousPresentation");
        // A field that had no presentation gets none back. Mapped to singleLine, its undo left a
        // presentation the author never set (ESS-06).
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            payload.GetProperty("entityId").GetString()!,
            payload.GetProperty("fieldId").GetString()!,
            previous.ValueKind == JsonValueKind.String ? previous.GetString()! : "singleLine",
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64())
        { RestoresNone = previous.ValueKind != JsonValueKind.String };
    }
}
