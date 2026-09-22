using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// The protected table holding behaviour definitions, keyed by stable definition ID.
    /// <para>
    /// One table for all four kinds rather than four shaped tables: the kinds share an
    /// identity, a contract version and a lifecycle, and the differences live inside a
    /// canonical body this host wrote and validates on the way back out. That keeps the
    /// digest rules in one place and keeps a new definition kind from being a schema
    /// migration.
    /// </para>
    /// <para>
    /// The table is created only when a file first stores a definition. A file with no
    /// behaviour keeps exactly the schema it has, so opening one never writes.
    /// </para>
    /// </summary>
    private const string BehaviourSchemaSql = """
        CREATE TABLE __nendo_behaviour (
            definition_id TEXT NOT NULL PRIMARY KEY,
            definition_kind TEXT NOT NULL CHECK (definition_kind IN ('Calculation', 'Function', 'Action', 'Trigger')),
            contract_version TEXT NOT NULL,
            owning_entity_id TEXT NULL,
            body_json TEXT NOT NULL,
            FOREIGN KEY (owning_entity_id) REFERENCES __nendo_entity(entity_id) ON DELETE CASCADE
        );

        CREATE TABLE __nendo_attribution (
            revision_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            root_scope TEXT NOT NULL,
            root_key TEXT NOT NULL,
            trigger_id TEXT NOT NULL,
            action_id TEXT NOT NULL,
            step_id TEXT NOT NULL,
            event_kind TEXT NOT NULL CHECK (event_kind IN ('Created', 'Updated', 'Deleted')),
            event_entity_id TEXT NOT NULL,
            event_record_id TEXT NOT NULL,
            behaviour_digest TEXT NOT NULL,
            PRIMARY KEY (revision_id, ordinal),
            FOREIGN KEY (revision_id, ordinal) REFERENCES __nendo_operation(revision_id, ordinal) ON DELETE CASCADE
        );
        """;

    /// <summary>
    /// Brings the protected layout up to the behaviour rung.
    /// <para>
    /// The writable-layout check recognises a fixed ladder of protected schemas rather
    /// than any combination of optional tables, so a file that reaches a later rung
    /// creates the whole prefix — the same thing a first choice edit does. Without
    /// that, storing a definition in a file that never used relationships would leave a
    /// layout no host is willing to write to again.
    /// </para>
    /// </summary>
    private async Task EnsureBehaviourLayoutAsync(SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync("__nendo_reference", transaction, cancellationToken))
            await NonQueryAsync(ReferenceSchemaSql, transaction, cancellationToken);
        if (!await TableExistsAsync("__nendo_deleted_record", transaction, cancellationToken))
            await NonQueryAsync(DeletionSchemaSql, transaction, cancellationToken);
        if (!await TableExistsAsync("__nendo_choice", transaction, cancellationToken))
            await NonQueryAsync(ChoiceSchemaSql, transaction, cancellationToken);
        if (!await TableExistsAsync("__nendo_retirement", transaction, cancellationToken))
            await NonQueryAsync(RetirementSchemaSql, transaction, cancellationToken);
        if (!await TableExistsAsync("__nendo_behaviour", transaction, cancellationToken))
            await NonQueryAsync(BehaviourSchemaSql, transaction, cancellationToken);
        // The only way the answer becomes yes, so this is the only place that has to
        // say so. A rolled-back transaction leaves a store that believes the table
        // exists, which costs one wasted lookup and never a wrong answer: the
        // readers all re-check the table's contents, not its presence.
        _behaviourTablePresent = true;
    }

    /// <summary>
    /// Every stored definition, ordered by stable ID so a digest taken over the result
    /// never depends on how SQLite happened to return the rows.
    /// </summary>
    private async Task<Dictionary<string, NendoBehaviourDefinition>> ReadBehaviourDefinitionsAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return definitions;
        await using var query = Command(
            "SELECT definition_id, definition_kind, contract_version, body_json FROM __nendo_behaviour ORDER BY definition_id;",
            transaction);
        await using var rows = await query.ExecuteReaderAsync(cancellationToken);
        while (await rows.ReadAsync(cancellationToken))
        {
            var definitionId = rows.GetString(0);
            if (!Enum.TryParse<NendoBehaviourKind>(rows.GetString(1), ignoreCase: false, out var kind))
            {
                throw new NendoValidationException(
                    $"The stored definition '{definitionId}' has a kind this version of Nendo does not implement.");
            }
            definitions.Add(definitionId, NendoBehaviourCodec.Read(definitionId, kind, rows.GetString(2), rows.GetString(3)));
        }
        return definitions;
    }

    /// <summary>
    /// The contract versions a file's stored definitions were written against. Used to
    /// decide whether this host may edit the file at all, without parsing bodies it may
    /// not understand.
    /// </summary>
    private async Task<IReadOnlyList<string>> ReadBehaviourContractVersionsAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return [];
        var versions = new List<string>();
        await using var query = Command(
            "SELECT DISTINCT contract_version FROM __nendo_behaviour ORDER BY contract_version;", transaction);
        await using var rows = await query.ExecuteReaderAsync(cancellationToken);
        while (await rows.ReadAsync(cancellationToken)) versions.Add(rows.GetString(0));
        return versions;
    }

    /// <summary>
    /// The calculated fields each record type declares, keyed by entity ID and ordered
    /// by stable ID. Reading these is a projection of the definitions; it evaluates
    /// nothing and so can never write, start an action or raise a revision.
    /// </summary>
    private async Task<Dictionary<string, IReadOnlyList<NendoDerivedFieldSnapshot>>> ReadDerivedFieldsAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        var derived = new Dictionary<string, IReadOnlyList<NendoDerivedFieldSnapshot>>(StringComparer.Ordinal);
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return derived;
        foreach (var group in (await ReadBehaviourDefinitionsAsync(transaction, cancellationToken))
            .Values
            .OfType<NendoCalculationDefinition>()
            .GroupBy(calculation => calculation.EntityId, StringComparer.Ordinal))
        {
            derived[group.Key] = group
                .OrderBy(calculation => calculation.DefinitionId, StringComparer.Ordinal)
                .Select(calculation => new NendoDerivedFieldSnapshot(
                    calculation.FieldId,
                    calculation.DisplayName,
                    calculation.DefinitionId,
                    calculation.ResultType,
                    calculation.ResultNullable,
                    calculation.Expression))
                .ToArray();
        }
        return derived;
    }

    private async Task<OperationEvidence> ExecuteSetBehaviourDefinitionAsync(
        SetBehaviourDefinitionOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);

        var definition = operation.Definition;
        var existing = await ReadBehaviourDefinitionsAsync(transaction, cancellationToken);
        if (existing.TryGetValue(definition.DefinitionId, out var previous) && previous.Kind != definition.Kind)
        {
            throw new NendoValidationException(
                $"'{definition.DefinitionId}' is already a {previous.Kind.ToString().ToLowerInvariant()}. Remove it before defining a {definition.Kind.ToString().ToLowerInvariant()} with the same ID.");
        }

        await RequireBehaviourBindingsResolveAsync(definition, transaction, cancellationToken);

        // Validate the set this operation would leave behind, not the definition alone:
        // a cycle or a dangling call only exists relative to everything else installed.
        // Compiling it is what checks the formulas themselves — that every name is one
        // the closed catalogue offers and every type lines up. Shape validation alone
        // would install a definition that cannot be evaluated, and a file whose
        // calculations silently stop appearing is worse than one that refused the edit.
        existing[definition.DefinitionId] = definition;
        CompileCandidate(existing, cancellationToken);
        await RequireActionTargetsResolveAsync(existing, definition, transaction, cancellationToken);

        await EnsureBehaviourLayoutAsync(transaction, cancellationToken);
        await using (var save = Command("""
            INSERT INTO __nendo_behaviour(definition_id, definition_kind, contract_version, owning_entity_id, body_json)
            VALUES(@id, @kind, @contract, @entity, @body)
            ON CONFLICT(definition_id) DO UPDATE SET
                definition_kind = excluded.definition_kind,
                contract_version = excluded.contract_version,
                owning_entity_id = excluded.owning_entity_id,
                body_json = excluded.body_json;
            """, transaction))
        {
            save.Parameters.AddWithValue("@id", definition.DefinitionId);
            save.Parameters.AddWithValue("@kind", definition.Kind.ToString());
            save.Parameters.AddWithValue("@contract", definition.ContractVersion);
            save.Parameters.AddWithValue("@entity", (object?)definition.OwningEntityId ?? DBNull.Value);
            save.Parameters.AddWithValue("@body", definition.CanonicalBody());
            await save.ExecuteNonQueryAsync(cancellationToken);
        }

        return new OperationEvidence(operation, Evidence(new
        {
            created = previous is null,
            previousBody = previous?.CanonicalBody(),
            previousContractVersion = previous?.ContractVersion,
            previousKind = previous?.Kind.ToString(),
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        { RequiredHostVersion = NendoFormat.BehaviourMinimumHostVersion };
    }

    private async Task<OperationEvidence> ExecuteRemoveBehaviourDefinitionAsync(
        RemoveBehaviourDefinitionOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);

        var existing = await ReadBehaviourDefinitionsAsync(transaction, cancellationToken);
        if (!existing.TryGetValue(operation.DefinitionId, out var previous))
        {
            throw new NendoPreconditionException(
                "definition-not-found",
                $"'{operation.DefinitionId}' is not defined in this file.");
        }
        if (previous.Kind != operation.DefinitionKind)
        {
            throw new NendoValidationException(
                $"'{operation.DefinitionId}' is a {previous.Kind.ToString().ToLowerInvariant()}, and the request removes a {operation.DefinitionKind.ToString().ToLowerInvariant()}.");
        }

        // Earlier operations in the same ordered change set have already been staged, so
        // this reads the state the removal actually lands in: a change set that rewires
        // the dependants first is accepted, one that strands them is not.
        existing.Remove(operation.DefinitionId);
        var dependants = NendoBehaviourGraph.DependantsOf(existing, operation.DefinitionId);
        if (dependants.Count != 0)
        {
            throw new NendoPreconditionException(
                "definition-referenced",
                $"'{operation.DefinitionId}' is still used by {string.Join(", ", dependants)}. Change or remove those first, in this same review.");
        }
        CompileCandidate(existing, cancellationToken);

        await using (var remove = Command("DELETE FROM __nendo_behaviour WHERE definition_id = @id;", transaction))
        {
            remove.Parameters.AddWithValue("@id", operation.DefinitionId);
            await remove.ExecuteNonQueryAsync(cancellationToken);
        }

        return new OperationEvidence(operation, Evidence(new
        {
            removedBody = previous.CanonicalBody(),
            removedContractVersion = previous.ContractVersion,
            removedKind = previous.Kind.ToString(),
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        { RequiredHostVersion = NendoFormat.BehaviourMinimumHostVersion };
    }

    /// <summary>
    /// Compiles the definition set a change would leave behind, so a formula that
    /// cannot be evaluated is refused while somebody is still looking at it.
    /// </summary>
    /// <remarks>
    /// Kept out of the caller so the expression assembly is resolved only when a
    /// definition is actually being installed or removed, never when an ordinary file
    /// is written.
    /// </remarks>
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private void CompileCandidate(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> candidate,
        CancellationToken cancellationToken) =>
        CompiledBehaviour.Compile(candidate, BehaviourAdapter, new BehaviourBudget(_behaviourLimits, cancellationToken));

    /// <summary>
    /// Reverses one behaviour definition change.
    /// <para>
    /// Installing over nothing is undone by removing; installing over something is
    /// undone by putting the retained definition back, rebuilt through the same codec
    /// a stored body is read with. The expected definition revision is the one the
    /// operation left behind, never today's: a later definition change therefore
    /// conflicts loudly instead of being silently reversed along with this one.
    /// </para>
    /// </summary>
    private static NendoOperation CreateBehaviourDefinitionInverse(
        string canonicalJson,
        string evidenceJson,
        string idempotencyKey)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var definitionId = payload.GetProperty("definitionId").GetString()!;
        var revision = evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64();
        var operationId = NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0);

        // A removal is undone by restoring what it removed.
        if (evidence.RootElement.TryGetProperty("removedBody", out var removed) && removed.ValueKind == JsonValueKind.String)
        {
            return new SetBehaviourDefinitionOperation(operationId, Restore(definitionId, evidence.RootElement, "removed"), revision);
        }
        return evidence.RootElement.GetProperty("created").GetBoolean()
            ? new RemoveBehaviourDefinitionOperation(operationId, definitionId,
                Enum.Parse<NendoBehaviourKind>(payload.GetProperty("definitionKind").GetString()!), revision)
            : new SetBehaviourDefinitionOperation(operationId, Restore(definitionId, evidence.RootElement, "previous"), revision);
    }

    private static NendoBehaviourDefinition Restore(string definitionId, JsonElement evidence, string prefix) =>
        NendoBehaviourCodec.Read(
            definitionId,
            Enum.Parse<NendoBehaviourKind>(evidence.GetProperty(prefix + "Kind").GetString()
                ?? throw new NendoCompensationNotSupportedException($"The retained definition '{definitionId}' has no kind.")),
            evidence.GetProperty(prefix + "ContractVersion").GetString()
                ?? throw new NendoCompensationNotSupportedException($"The retained definition '{definitionId}' has no contract version."),
            evidence.GetProperty(prefix + "Body").GetString()
                ?? throw new NendoCompensationNotSupportedException($"The retained definition '{definitionId}' has no body."));

    /// <summary>
    /// Checks every entity, field and reference a definition names against the schema it
    /// will run over. A binding that does not resolve is refused here, at installation,
    /// rather than becoming a calculation error on every record forever.
    /// </summary>
    private async Task RequireBehaviourBindingsResolveAsync(
        NendoBehaviourDefinition definition,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (definition.OwningEntityId is { } owner)
        {
            var entity = await GetEntityMappingAsync(owner, transaction, cancellationToken);
            RequireActive(entity);
            if (definition is NendoCalculationDefinition calculation &&
                entity.Fields.Any(field => string.Equals(field.FieldId, calculation.FieldId, StringComparison.Ordinal)))
            {
                throw new NendoValidationException(
                    $"'{calculation.FieldId}' is already a stored field on this record type. A calculated field needs its own stable ID.");
            }
        }

        foreach (var binding in BindingsOf(definition))
        {
            var entity = await GetEntityMappingAsync(binding.EntityId, transaction, cancellationToken);
            RequireActive(entity);
            switch (binding.Kind)
            {
                case NendoBindingKind.SameRecordField:
                    RequireScalarField(entity, binding.FieldId!, binding.ResultType, binding.Nullable);
                    break;
                case NendoBindingKind.SameRecordCalculation:
                    // The calculation it names is checked against the candidate set by
                    // the graph, which is the only place that can see a definition this
                    // same change set is installing alongside this one.
                    break;
                case NendoBindingKind.ReferenceTraversal:
                {
                    RequireReferenceField(entity, binding.ReferenceFieldId!, binding.RelatedEntityId!);
                    var target = await GetEntityMappingAsync(binding.RelatedEntityId!, transaction, cancellationToken);
                    RequireActive(target);
                    RequireScalarField(target, binding.FieldId!, binding.ResultType, binding.Nullable);
                    break;
                }
                case NendoBindingKind.RelatedAggregate:
                {
                    var related = await GetEntityMappingAsync(binding.RelatedEntityId!, transaction, cancellationToken);
                    RequireActive(related);
                    RequireReferenceField(related, binding.RelatedReferenceFieldId!, binding.EntityId);
                    if (binding.PredicateFieldId is { } predicate)
                        RequireScalarField(related, predicate, NendoBehaviourScalar.Boolean, nullable: false);
                    if (binding.ValueFieldId is { } value)
                        RequireScalarField(related, value, binding.ResultType, nullable: false);
                    break;
                }
                default:
                    throw new NendoValidationException("The binding kind is not supported by this contract.");
            }
        }
    }

    /// <summary>
    /// Refuses an action step that writes to a record type the step cannot reach.
    /// </summary>
    /// <remarks>
    /// An action does not know the record type it runs against: <c>OwningEntityId</c> is
    /// null for one, and a step says only whether it writes the event record or one
    /// reached by following a reference. Only the trigger names the record type whose
    /// events raise it. So the pair is the smallest thing that can be checked, and until
    /// this ran nothing checked it — a step that bound the event record while writing a
    /// field of the referenced one installed cleanly and failed at the next save, which is
    /// the mistake the published example warns about (F-003).
    /// <para>
    /// This resolves each step exactly as the planner's <c>TargetEntityId</c> does at run
    /// time, and refuses the same shapes the planner would fail on. Where the planner has
    /// a record in hand and throws, this has the schema and can say which action, which
    /// step, which record type and which field, before anything is stored.
    /// </para>
    /// <para>
    /// Only the pairs this operation touches are checked — the trigger being installed, or
    /// every trigger pointing at the action being installed. Validating every pair in the
    /// file would let an unrelated definition from before this check existed refuse an
    /// install that has nothing to do with it.
    /// </para>
    /// </remarks>
    private async Task RequireActionTargetsResolveAsync(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> candidate,
        NendoBehaviourDefinition installed,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var pairs = new List<(NendoTriggerDefinition Trigger, NendoActionDefinition Action)>();
        void Pair(NendoTriggerDefinition trigger)
        {
            if (candidate.TryGetValue(trigger.ActionId, out var found) && found is NendoActionDefinition action)
                pairs.Add((trigger, action));
        }

        switch (installed)
        {
            case NendoTriggerDefinition trigger:
                Pair(trigger);
                break;
            case NendoActionDefinition action:
                foreach (var trigger in candidate.Values.OfType<NendoTriggerDefinition>()
                    .Where(candidateTrigger => string.Equals(candidateTrigger.ActionId, action.DefinitionId, StringComparison.Ordinal)))
                {
                    Pair(trigger);
                }
                break;
            default:
                return;
        }

        foreach (var (trigger, action) in pairs)
        {
            foreach (var step in action.Steps)
            {
                var entityId = step.Kind == NendoActionStepKind.CreateRecord
                    ? step.EntityId!
                    : await StepTargetEntityIdAsync(trigger, action, step, transaction, cancellationToken);
                var entity = await GetEntityMappingAsync(entityId, transaction, cancellationToken);
                RequireActive(entity);
                foreach (var assignment in step.Assignments)
                {
                    var field = entity.Fields.SingleOrDefault(candidateField =>
                        string.Equals(candidateField.FieldId, assignment.FieldId, StringComparison.Ordinal));
                    if (field is null)
                    {
                        throw new NendoPreconditionException("action-target-mismatch",
                            $"The action '{action.DisplayName}' writes '{assignment.FieldId}' in step '{step.StepId}', " +
                            $"but that step targets a '{entityId}' record, which has no such field. " +
                            "A step writes the record the event was raised on unless it follows a reference; " +
                            "point the step at the record that holds the field, or name a field that record has.");
                    }
                    RequireActive(entity, field);
                }
            }
        }
    }

    /// <summary>
    /// The record type one step writes to, resolved the way the planner resolves it, and
    /// refusing by name where the planner would fail on a missing or unbound reference.
    /// </summary>
    private async Task<string> StepTargetEntityIdAsync(
        NendoTriggerDefinition trigger,
        NendoActionDefinition action,
        NendoActionStep step,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (step.Target.Kind == NendoActionTargetKind.EventRecord) return trigger.EntityId;
        var source = await GetEntityMappingAsync(trigger.EntityId, transaction, cancellationToken);
        RequireActive(source);
        var referenceFieldId = step.Target.ReferenceFieldId!;
        var reference = source.Fields.SingleOrDefault(field =>
            string.Equals(field.FieldId, referenceFieldId, StringComparison.Ordinal))
            ?? throw new NendoPreconditionException("action-target-mismatch",
                $"The action '{action.DisplayName}' follows '{referenceFieldId}' in step '{step.StepId}', " +
                $"but '{trigger.EntityId}' — the record type this trigger listens to — has no such field.");
        RequireActive(source, reference);
        if (reference.StorageKind != NendoStorageKind.Reference || reference.Reference is null)
        {
            throw new NendoPreconditionException("action-target-mismatch",
                $"The action '{action.DisplayName}' follows '{referenceFieldId}' in step '{step.StepId}', " +
                $"but that field of '{trigger.EntityId}' is not a reference pointing anywhere. " +
                "Bind it with schema.configureReference, or target the event record instead.");
        }
        return reference.Reference.TargetEntityId;
    }

    private static IEnumerable<NendoBehaviourBinding> BindingsOf(NendoBehaviourDefinition definition) => definition switch
    {
        NendoCalculationDefinition calculation => calculation.Bindings,
        NendoTriggerDefinition trigger => trigger.ConditionBindings,
        NendoActionDefinition action => action.Steps.SelectMany(step => step.Assignments).SelectMany(assignment => assignment.Bindings),
        _ => [],
    };

    private static void RequireScalarField(
        EntityMapping entity,
        string fieldId,
        NendoBehaviourScalar expected,
        bool nullable)
    {
        var field = entity.Fields.SingleOrDefault(candidate => string.Equals(candidate.FieldId, fieldId, StringComparison.Ordinal))
            ?? throw new NendoPreconditionException("field-not-found",
                $"'{fieldId}' is not a field of '{entity.EntityId}'.");
        RequireActive(entity, field);
        if (BehaviourScalarOf(field.StorageKind) is not { } actual)
        {
            throw new NendoValidationException(
                $"'{fieldId}' stores a kind of value a formula cannot read.");
        }
        if (actual != expected)
        {
            throw new NendoValidationException(
                $"'{fieldId}' stores {actual.ToString().ToLowerInvariant()} values, and the formula declares {expected.ToString().ToLowerInvariant()}.");
        }
        // An optional field can be empty, so a formula that promises a value from it
        // would have to invent one. Declaring the binding nullable is the fix.
        if (!field.Required && !nullable)
        {
            throw new NendoValidationException(
                $"'{fieldId}' is optional, so the formula must accept an empty value from it.");
        }
    }

    private static void RequireReferenceField(EntityMapping entity, string fieldId, string targetEntityId)
    {
        var field = entity.Fields.SingleOrDefault(candidate => string.Equals(candidate.FieldId, fieldId, StringComparison.Ordinal))
            ?? throw new NendoPreconditionException("field-not-found",
                $"'{fieldId}' is not a field of '{entity.EntityId}'.");
        RequireActive(entity, field);
        if (field.StorageKind != NendoStorageKind.Reference)
            throw new NendoValidationException($"'{fieldId}' is not a relationship.");
        if (field.Reference is not { } reference)
            throw new NendoPreconditionException("reference-unbound",
                $"'{fieldId}' is not bound to a record type yet.");
        if (!string.Equals(reference.TargetEntityId, targetEntityId, StringComparison.Ordinal))
            throw new NendoValidationException(
                $"'{fieldId}' points at '{reference.TargetEntityId}', and the formula expects '{targetEntityId}'.");
    }

    /// <summary>
    /// The expression scalar a stored kind produces, or null when a formula cannot read
    /// it at all. DateTime, Uuid and Reference are deliberately absent.
    /// </summary>
    internal static NendoBehaviourScalar? BehaviourScalarOf(NendoStorageKind storageKind) => storageKind switch
    {
        NendoStorageKind.Integer => NendoBehaviourScalar.Integer,
        NendoStorageKind.Decimal => NendoBehaviourScalar.Decimal,
        NendoStorageKind.Boolean => NendoBehaviourScalar.Boolean,
        NendoStorageKind.Text => NendoBehaviourScalar.Text,
        NendoStorageKind.Date => NendoBehaviourScalar.Date,
        _ => null,
    };
}
