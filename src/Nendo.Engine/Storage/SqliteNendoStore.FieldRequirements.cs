using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private async Task EnsureEvolutionLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_reference", transaction, ct)) await NonQueryAsync(ReferenceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, ct)) await NonQueryAsync(DeletionSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_choice", transaction, ct)) await NonQueryAsync(ChoiceSchemaSql, transaction, ct);
        if (!await TableExistsAsync("__nendo_retirement", transaction, ct)) await NonQueryAsync(RetirementSchemaSql, transaction, ct);
    }

    private async Task<OperationEvidence> ExecuteSetFieldRequiredAsync(SetFieldRequiredOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = entity.Fields.SingleOrDefault(field => field.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The field does not belong to this record type.");
        RequireActive(entity, field);
        var materialized = await TableExistsAsync(entity.PhysicalTableName, transaction, ct) &&
            await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct);
        if (!materialized && await TableExistsAsync(entity.PhysicalTableName, transaction, ct))
            throw new NendoPreconditionException("required-backfill-needed", "Add the optional field in an earlier mutation of the proposal, then fill it and change its requirement.");
        if (operation.Required && materialized && Convert.ToInt64(await ScalarAsync(
            $"SELECT EXISTS(SELECT 1 FROM {Quote(entity.PhysicalTableName)} WHERE {Quote(field.PhysicalColumnName)} IS NULL);", transaction, ct), CultureInfo.InvariantCulture) != 0)
            throw new NendoPreconditionException("required-backfill-needed", "Provide explicit values for all missing records in the proposal before requiring this field.");
        if (operation.Required && field.StorageKind == NendoStorageKind.Reference && field.Reference is null)
            throw new NendoPreconditionException("reference-unbound", "Configure the reference target before requiring this field.");
        await EnsureEvolutionLayoutAsync(transaction, ct);
        await using (var update = Command("UPDATE __nendo_field SET required=@required WHERE field_id=@field;", transaction))
        {
            update.Parameters.AddWithValue("@required", operation.Required ? 1 : 0); update.Parameters.AddWithValue("@field", field.FieldId);
            await update.ExecuteNonQueryAsync(ct);
        }
        if (materialized && field.Required != operation.Required)
            await RebuildRequiredConstraintsAsync(await GetEntityMappingAsync(entity.EntityId, transaction, ct), transaction, ct);
        return new(operation, Evidence(new { previousRequired = field.Required, appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        { RequiredHostVersion = NendoFormat.RetirementMinimumHostVersion };
    }

    private async Task<OperationEvidence> ExecuteBackfillRetiredFieldAsync(BackfillRetiredFieldOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var entity = await GetEntityMappingAsync(operation.Edit.EntityId, transaction, ct);
        var field = entity.Fields.SingleOrDefault(field => field.FieldId == operation.Edit.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The retained field does not exist.");
        if (!field.Retired) throw new NendoPreconditionException("field-not-retired", "This repair operation requires a retired field.");
        var evidence = await ExecuteSetFieldAsync(operation.Edit, transaction, ct, allowRetiredField: true);
        return new(operation, evidence.EvidenceJson) { RequiredHostVersion = NendoFormat.RetirementMinimumHostVersion };
    }

    private static SetFieldRequiredOperation CreateRequiredInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson); using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload"); var prior = evidence.RootElement;
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0), payload.GetProperty("entityId").GetString()!,
            payload.GetProperty("fieldId").GetString()!, prior.GetProperty("previousRequired").GetBoolean(), prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }
}
