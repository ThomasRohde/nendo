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
        if (operation.Required && entity.Hierarchy?.ParentFieldId == field.FieldId)
            throw new NendoPreconditionException("hierarchy-parent-required",
                "A tree needs top-level records, so the parent field of a declared hierarchy stays optional.");
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

    /// <summary>
    /// Refuses a requirement change that breaks behaviour already installed (EBH-09). Install
    /// checks a definition against the schema once; without this a field could become optional
    /// under a total or a formula that counts on it having a value, or required under a create
    /// step that never fills it, and every later save that ran the behaviour was refused.
    /// <para>
    /// Only the fields this mutation or change set changes are checked, and against the final
    /// candidate, so one proposal that rewires the behaviour and changes the requirement is
    /// accepted whatever order it lists them in.
    /// </para>
    /// <para>
    /// A create step can also come to need a value it never gives when a required field is made
    /// active again, or loses the sequence that filled it: install's exemptions for a retired and
    /// a numbered field no longer hold, so those two changes are checked against create steps too.
    /// </para>
    /// </summary>
    private async Task ValidateRequirementBehaviourAsync(
        IEnumerable<NendoOperation> operations, SqliteTransaction transaction, CancellationToken ct)
    {
        var listed = operations as IReadOnlyCollection<NendoOperation> ?? operations.ToArray();
        var changed = listed.OfType<SetFieldRequiredOperation>().Select(operation => operation.FieldId).ToHashSet(StringComparer.Ordinal);
        // Every field a create step may now have to fill: one made required, one made active
        // again, and one whose sequence was removed.
        var needed = changed
            .Concat(listed.OfType<SetRetiredOperation>().Where(operation => !operation.Retired && operation.FieldId is not null).Select(operation => operation.FieldId!))
            .Concat(listed.OfType<SetFieldSequenceOperation>().Where(operation => operation.Prefix is null).Select(operation => operation.FieldId))
            .ToHashSet(StringComparer.Ordinal);
        if (needed.Count == 0) return;
        var definitions = await ReadBehaviourDefinitionsAsync(transaction, ct);
        if (definitions.Count == 0) return;
        var mappings = (await ReadEntityMappingsAsync(transaction, ct)).ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        FieldMapping? Field(string? entityId, string? fieldId) =>
            entityId is not null && fieldId is not null && changed.Contains(fieldId) && mappings.TryGetValue(entityId, out var entity)
                ? entity.Fields.SingleOrDefault(field => string.Equals(field.FieldId, fieldId, StringComparison.Ordinal))
                : null;

        foreach (var definition in definitions.Values)
        {
            foreach (var binding in BindingsOf(definition))
            {
                // The reads that promise a value: a non-nullable field read, and every member
                // field a total or a filtered count reads, which install requires to be required.
                var promised = binding.Kind switch
                {
                    NendoBindingKind.SameRecordField when !binding.Nullable => [Field(binding.EntityId, binding.FieldId)],
                    NendoBindingKind.ReferenceTraversal when !binding.Nullable => [Field(binding.RelatedEntityId, binding.FieldId)],
                    NendoBindingKind.RelatedAggregate => [Field(binding.RelatedEntityId, binding.PredicateFieldId), Field(binding.RelatedEntityId, binding.ValueFieldId)],
                    NendoBindingKind.SubtreeAggregate => [Field(binding.EntityId, binding.PredicateFieldId), Field(binding.EntityId, binding.ValueFieldId)],
                    _ => Array.Empty<FieldMapping?>(),
                };
                if (promised.FirstOrDefault(field => field is { Required: false, Retired: false }) is { } optional)
                    throw new NendoPreconditionException("field-requirement-in-use",
                        $"'{definition.DefinitionId}' reads '{optional.FieldId}' through '{binding.BindingId}' and counts on it always having a value, " +
                        $"so '{optional.FieldId}' cannot become optional. Let the formula accept an empty value, or change or remove " +
                        $"'{definition.DefinitionId}' in the same proposal.");
            }
        }

        foreach (var trigger in definitions.Values.OfType<NendoTriggerDefinition>())
        {
            if (!definitions.TryGetValue(trigger.ActionId, out var found) || found is not NendoActionDefinition action) continue;
            foreach (var step in action.Steps.Where(step => step.Kind == NendoActionStepKind.CreateRecord))
            {
                if (!mappings.TryGetValue(step.EntityId!, out var entity)) continue;
                if (MissingRequiredFields(step, entity).FirstOrDefault(field => needed.Contains(field.FieldId)) is { } missing)
                    throw new NendoPreconditionException("field-requirement-in-use",
                        $"'{action.DefinitionId}' creates a '{entity.EntityId}' record in step '{step.StepId}' without a value for '{missing.FieldId}', " +
                        $"so '{missing.FieldId}' cannot become a required field the step must fill, whether by a requirement, by being made active " +
                        $"again or by losing its sequence: every save that runs the action would be refused. " +
                        $"Give the step a value for '{missing.FieldId}' in the same proposal, or leave the field as it was.");
            }
        }
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
