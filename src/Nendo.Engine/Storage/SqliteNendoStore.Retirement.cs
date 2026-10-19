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
        if (operation.Retired) RequireNotHierarchyField(entity, operation.FieldId, "retired");
        if (operation.Retired) await RequireNotLinkRuleFieldAsync(entity, operation.FieldId, "retired", transaction, ct);
        if (operation.Retired && field is not null) await RequireNotReferenceLabelAsync(entity, field, transaction, ct);
        var previous = field?.Retired ?? entity.Retired;
        if (field is not null && entity.Retired) throw new NendoPreconditionException("entity-retired", "Reactivate the record type before changing field retirement.");
        if (field is null && operation.Retired)
        {
            foreach (var source in await ReadEntityMappingsAsync(transaction, ct))
            foreach (var reference in source.Fields.Where(candidate => candidate.Reference?.TargetEntityId == entity.EntityId))
                // A reference added in this mutation has no column yet, and so points at nothing.
                if (await ColumnExistsAsync(source.PhysicalTableName, reference.PhysicalColumnName, transaction, ct) &&
                    Convert.ToInt64(await ScalarAsync($"SELECT EXISTS(SELECT 1 FROM {Quote(source.PhysicalTableName)} WHERE {Quote(reference.PhysicalColumnName)} IS NOT NULL);", transaction, ct), CultureInfo.InvariantCulture) != 0)
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

    /// <summary>
    /// A bound reference shows its target by a label field, so retiring that field left every
    /// target created afterwards with no label and a board grouped by it refusing with advice
    /// nobody could follow. schema.setReferenceLabel moves the reference to another label
    /// first. A retired reference, or one on a retired record type, draws and groups
    /// nothing and cannot be relabelled, so it does not hold its label: reactivating it later
    /// meets a retired label as any reactivation meets what retired after it.
    /// </summary>
    private async Task RequireNotReferenceLabelAsync(EntityMapping entity, FieldMapping field,
        SqliteTransaction transaction, CancellationToken ct)
    {
        foreach (var source in await ReadEntityMappingsAsync(transaction, ct))
        foreach (var reference in source.Fields)
            if (!source.Retired && !reference.Retired &&
                reference.Reference is { } bound && bound.TargetEntityId == entity.EntityId && bound.LabelFieldId == field.FieldId)
                throw new NendoPreconditionException("reference-label-in-use",
                    $"{source.DisplayName}.{reference.DisplayName} shows {entity.DisplayName} by {field.DisplayName}, so {field.DisplayName} cannot be retired. Show {entity.DisplayName} by another text field with schema.setReferenceLabel first.");
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
        // Only the columns the table has: a field added earlier in the same mutation gets its
        // column when the mutation ends, appended after these. Copying it from a table that does
        // not have it yet failed as a raw SQLite error.
        var existing = new List<FieldMapping>();
        foreach (var field in entity.Fields)
            if (await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) existing.Add(field);
        entity = entity with { Fields = existing };
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
            // Every property that names one: an ordering, a date, an axis or a relation's target
            // as well as a binding. Only four were read, so a retirement under any other bound
            // field was accepted and every custom screen then failed to compile.
            var namesEntity = pair.Key == "entityId" || pair.Key.EndsWith("EntityId", StringComparison.Ordinal);
            var namesField = pair.Key is "fieldId" or "cardFieldIds" || pair.Key.EndsWith("FieldId", StringComparison.Ordinal);
            if (!namesEntity && !namesField) continue;
            var retired = namesEntity ? entities : fields;
            if ((pair.Value.ValueKind == JsonValueKind.String && retired.Contains(pair.Value.GetString()!)) ||
                (pair.Value.ValueKind == JsonValueKind.Array && pair.Value.EnumerateArray().Any(value => value.ValueKind == JsonValueKind.String && retired.Contains(value.GetString()!))))
                throw new NendoPreconditionException("retired-binding", "Remove or replace surface bindings to the retired definition in the same proposal.");
        }
        await ValidateRetiredBehaviourAsync(entities, fields, transaction, ct);
    }

    /// <summary>
    /// Refuses a candidate whose calculations, triggers or automatic actions still read or
    /// write a retired record type or field. Installing such a definition is refused when it
    /// is installed; this is the other half, for a retirement that lands under a definition
    /// already in place. Without it the retirement commits and the next routine edit that
    /// raises the trigger rolls back on the retired target.
    /// <para>
    /// It runs over the final candidate — after every operation of the mutation or change
    /// set — so one proposal that rewires or removes the behaviour and retires its target
    /// is accepted, whatever order it lists them in.
    /// </para>
    /// </summary>
    private async Task ValidateRetiredBehaviourAsync(
        HashSet<string> entities, HashSet<string> fields, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await HasBehaviourAsync(transaction, ct)) return;
        var definitions = await ReadBehaviourDefinitionsAsync(transaction, ct);
        if (definitions.Count == 0) return;

        static NendoPreconditionException Refuse(NendoBehaviourDefinition definition, string retiredId) => new("retired-binding",
            $"'{definition.DefinitionId}' still uses {retiredId}, which this change retires. " +
            "Change or remove that behaviour in the same proposal, or leave the definition active.");

        foreach (var definition in definitions.Values)
        {
            if (definition.OwningEntityId is { } owner && entities.Contains(owner)) throw Refuse(definition, owner);
            // A retired relevant field never changes again, so the trigger would never run on an
            // update.
            if (definition is NendoTriggerDefinition listening &&
                listening.RelevantFieldIds.FirstOrDefault(fields.Contains) is { } relevant)
                throw Refuse(definition, relevant);
            foreach (var binding in BindingsOf(definition))
            {
                foreach (var entityId in new[] { binding.EntityId, binding.RelatedEntityId })
                    if (entityId is not null && entities.Contains(entityId)) throw Refuse(definition, entityId);
                foreach (var fieldId in new[] { binding.FieldId, binding.ReferenceFieldId, binding.RelatedReferenceFieldId, binding.PredicateFieldId, binding.ValueFieldId })
                    if (fieldId is not null && fields.Contains(fieldId)) throw Refuse(definition, fieldId);
            }
        }

        // What an action writes is only known beside the trigger that raises it: the step
        // targets the event record, or the record one of its references reaches.
        Dictionary<string, EntityMapping>? mappings = null;
        foreach (var trigger in definitions.Values.OfType<NendoTriggerDefinition>())
        {
            if (!definitions.TryGetValue(trigger.ActionId, out var found) || found is not NendoActionDefinition action) continue;
            foreach (var step in action.Steps)
            {
                string? target;
                if (step.Kind == NendoActionStepKind.CreateRecord) target = step.EntityId;
                else if (step.Target.Kind == NendoActionTargetKind.EventRecord) target = trigger.EntityId;
                else
                {
                    var referenceFieldId = step.Target.ReferenceFieldId!;
                    if (fields.Contains(referenceFieldId)) throw Refuse(action, referenceFieldId);
                    mappings ??= (await ReadEntityMappingsAsync(transaction, ct)).ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
                    target = mappings.TryGetValue(trigger.EntityId, out var source)
                        ? source.Fields.SingleOrDefault(field => field.FieldId == referenceFieldId)?.Reference?.TargetEntityId
                        : null;
                }
                if (target is not null && entities.Contains(target)) throw Refuse(action, target);
                foreach (var assignment in step.Assignments)
                    if (fields.Contains(assignment.FieldId)) throw Refuse(action, assignment.FieldId);
                // A link sets a reference of the new record, so retiring that reference, or the
                // one the link follows from the event record, left the next create refused with
                // field-retired.
                foreach (var link in step.Links)
                {
                    if (fields.Contains(link.FieldId)) throw Refuse(action, link.FieldId);
                    if (link.Target.ReferenceFieldId is { } followed && fields.Contains(followed)) throw Refuse(action, followed);
                }
            }
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
