using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// Who answers for this file's automatic actions. Denied until a host supplies
    /// something better, so an embedding that never wired up consent refuses rather
    /// than running a stranger's actions.
    /// </summary>
    internal INendoBehaviourAuthority BehaviourAuthority { get; set; } = DeniedBehaviourAuthority.Instance;

    /// <summary>
    /// What consent this file would need, and whether the host holds it.
    /// <para>
    /// A file with calculations but no trigger needs nothing: calculating reads data
    /// and writes none. The moment a trigger exists, editing the file can write
    /// records nobody typed, and that is what consent is for.
    /// </para>
    /// </summary>
    /// <summary>
    /// What consent this file's behaviour would need, regardless of whether anyone
    /// holds it. Used when preparing a proposal, to record on the reviewed plan what
    /// promoting it will require.
    /// </summary>
    internal async Task<NendoBehaviourGrant?> GetRequiredBehaviourGrantAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return null;
        return await RequiredGrantAsync(
            await GetCompiledBehaviourAsync(transaction, cancellationToken), transaction, cancellationToken);
    }

    internal async Task<NendoBehaviourTrust> GetBehaviourTrustAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return NendoBehaviourTrust.None;
        return await ResolveBehaviourTrustAsync(transaction, cancellationToken);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private async Task<NendoBehaviourTrust> ResolveBehaviourTrustAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        CompiledBehaviour behaviour;
        try
        {
            behaviour = await GetCompiledBehaviourAsync(transaction, cancellationToken);
        }
        catch (Exception exception) when (exception is NendoException or System.Text.Json.JsonException)
        {
            // Definitions this host cannot read might do anything, so they are treated
            // as needing consent that cannot be given rather than as needing none.
            return new NendoBehaviourTrust(true, false, null);
        }
        var required = await RequiredGrantAsync(behaviour, transaction, cancellationToken);
        if (required is null) return NendoBehaviourTrust.None;
        return new NendoBehaviourTrust(true, BehaviourAuthority.IsGranted(required), required);
    }

    /// <summary>
    /// The grant a file's behaviour would need, or null when it needs none.
    /// Capabilities are read off the actions a trigger can actually reach, so the
    /// consent asked for is what the file can really do.
    /// </summary>
    private async Task<NendoBehaviourGrant?> RequiredGrantAsync(
        CompiledBehaviour behaviour,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        var triggers = behaviour.Definitions.Values.OfType<NendoTriggerDefinition>().ToArray();
        if (triggers.Length == 0) return null;
        var capabilities = NendoBehaviourCapabilities.None;
        foreach (var trigger in triggers)
        {
            if (!behaviour.Definitions.TryGetValue(trigger.ActionId, out var definition) ||
                definition is not NendoActionDefinition action)
            {
                continue;
            }
            foreach (var step in action.Steps)
            {
                capabilities |= step.Kind switch
                {
                    NendoActionStepKind.CreateRecord => NendoBehaviourCapabilities.CreateRecords,
                    NendoActionStepKind.DeleteRecord => NendoBehaviourCapabilities.DeleteRecords,
                    _ => NendoBehaviourCapabilities.UpdateRecords,
                };
            }
        }
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        return new NendoBehaviourGrant(
            manifest.ApplicationId,
            manifest.InstanceId,
            BehaviourDigest(behaviour),
            NendoBehaviourContract.Version,
            manifest.DefinitionRevision,
            capabilities);
    }

    /// <summary>
    /// Called after each generated write, with the number applied so far.
    /// <para>
    /// A seam for proving atomicity: a test throws from it to interrupt a chain at an
    /// exact point and assert that nothing at all survived. It is internal and set by
    /// the host, never reachable from a file, a request or an agent.
    /// </para>
    /// </summary>
    internal Action<int>? GeneratedOperationCheckpoint { get; set; }

    /// <summary>
    /// The records an incoming mutation names, read before anything is staged.
    /// <para>
    /// This is what makes an event logical rather than physical. Comparing the state
    /// before the whole request against the state after it means a four-field form
    /// edit is one update, not four, and a field set back to its original value in
    /// the same request is no change at all.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyDictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?>> CaptureBehaviourBeforeAsync(
        IReadOnlyList<NendoOperation> operations,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var captured = new Dictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?>();
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return captured;
        return await CaptureTouchedRecordsAsync(operations, transaction, cancellationToken);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private async Task<IReadOnlyDictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?>> CaptureTouchedRecordsAsync(
        IReadOnlyList<NendoOperation> operations,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var captured = new Dictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?>();
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        foreach (var key in operations.Select(TouchedRecord).OfType<RecordKey>().Distinct())
        {
            if (captured.ContainsKey(key)) continue;
            captured[key] = await ReadRecordValuesAsync(key, mappings, transaction, cancellationToken);
        }
        return captured;
    }

    /// <summary>The record an operation changes, or null when it changes no single record.</summary>
    private static RecordKey? TouchedRecord(NendoOperation operation) => operation switch
    {
        CreateRecordOperation create => new RecordKey(create.EntityId, create.RecordId),
        SetFieldOperation set => new RecordKey(set.EntityId, set.RecordId),
        DeleteRecordOperation delete => new RecordKey(delete.EntityId, delete.RecordId),
        RestoreDeletedRecordOperation restore => new RecordKey(restore.EntityId, restore.RecordId),
        // A backfill changes a record, so a trigger must be able to fire on it and its
        // before-state must be captured like any other data write.
        BackfillRetiredFieldOperation backfill => new RecordKey(backfill.Edit.EntityId, backfill.Edit.RecordId),
        _ => null,
    };

    private async Task<IReadOnlyDictionary<string, JsonElement>?> ReadRecordValuesAsync(
        RecordKey key,
        IReadOnlyList<EntityMapping> mappings,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var entity = mappings.SingleOrDefault(candidate => string.Equals(candidate.EntityId, key.EntityId, StringComparison.Ordinal));
        if (entity is null || entity.Fields.Count == 0) return null;
        await using var command = Command(
            $"SELECT {string.Join(", ", entity.Fields.Select(field => Quote(field.PhysicalColumnName)))} " +
            $"FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @recordId;",
            transaction);
        command.Parameters.AddWithValue("@recordId", key.RecordId);
        await using var rows = await command.ExecuteReaderAsync(cancellationToken);
        if (!await rows.ReadAsync(cancellationToken)) return null;
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        for (var index = 0; index < entity.Fields.Count; index++)
        {
            values[entity.Fields[index].FieldId] = ToJsonElement(
                rows.IsDBNull(index) ? null : rows.GetValue(index), entity.Fields[index].StorageKind);
        }
        return values;
    }

    /// <summary>
    /// Runs the automatic actions the staged changes selected and appends their
    /// generated operations to this revision's evidence.
    /// <para>
    /// Anything that goes wrong here propagates, and the surrounding transaction rolls
    /// back — the initiating edit included. That is the contract: an edit and the
    /// actions it triggers commit together or not at all, so a save never half-happens.
    /// The one exception is a condition that cannot be evaluated, which blocks its own
    /// action and is reported without touching the edit.
    /// </para>
    /// </summary>
    /// <summary>
    /// What the actions wrote, one entry per record at the version it now holds. A
    /// write result used to name only the caller's own record, so an agent whose save
    /// fired a trigger had to read the other record back to learn it had moved.
    /// </summary>
    private static IReadOnlyList<NendoGeneratedChange> GeneratedChanges(BehaviourExecutionContext? chain) =>
        chain is null || chain.Generated.Count == 0
            ? []
            : CollapseGeneratedChanges(chain.Generated.Select(generated => generated.Operation), withVersions: true);

    /// <summary>
    /// One entry per record the generated operations touched, in execution order, the
    /// last write to a record being the one that stands. Versions are stated only for
    /// the write that just committed: read back from a receipt or on a replay, the
    /// record may have moved since, so the entry names what changed and not a number
    /// that would be read as current.
    /// </summary>
    private static IReadOnlyList<NendoGeneratedChange> CollapseGeneratedChanges(
        IEnumerable<NendoOperation> generated,
        bool withVersions)
    {
        var latest = new Dictionary<(string EntityId, string RecordId), NendoGeneratedChange>();
        foreach (var operation in generated)
        {
            NendoGeneratedChange? change = operation switch
            {
                CreateRecordOperation create => new(create.EntityId, create.RecordId, "created", withVersions ? 1 : null),
                SetFieldOperation set => new(set.EntityId, set.RecordId, "updated", withVersions ? set.ExpectedRecordVersion + 1 : null),
                DeleteRecordOperation delete => new(delete.EntityId, delete.RecordId, "deleted", null),
                _ => null,
            };
            if (change is not null) latest[(change.EntityId, change.RecordId)] = change;
        }
        return [.. latest.Values];
    }

    private async Task<BehaviourExecutionContext?> RunBehaviourChainAsync(
        NendoMutation mutation,
        IReadOnlyDictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?> before,
        List<OperationEvidence> evidence,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (before.Count == 0) return null;
        if (mutation.Operations[0].Lane != NendoRevisionLane.Data) return null;
        return await ExecuteBehaviourChainAsync(mutation, before, evidence, transaction, cancellationToken);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private async Task<BehaviourExecutionContext?> ExecuteBehaviourChainAsync(
        NendoMutation mutation,
        IReadOnlyDictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?> before,
        List<OperationEvidence> evidence,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var behaviour = await GetCompiledBehaviourAsync(transaction, cancellationToken);
        if (!behaviour.Definitions.Values.OfType<NendoTriggerDefinition>().Any()) return null;

        // Consent is checked before a single action runs, and again immediately before
        // commit. Checking only here would leave a window in which the owner withdraws
        // consent and the writes land regardless.
        var required = await RequiredGrantAsync(behaviour, transaction, cancellationToken);
        if (required is not null && !BehaviourAuthority.IsGranted(required))
        {
            throw new NendoPreconditionException(
                "behaviour-not-approved",
                "This file's automatic actions have not been approved on this device. Review what they do and approve them before editing.");
        }

        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        BehaviourExecutionContext? scope = null;
        var source = new BehaviourRecordSource(this, transaction, mappings,
            (key, version) => scope?.Observe(key, version));
        // One budget for the whole chain. A trigger that starts another trigger spends
        // the same allowance, so a chain cannot outrun the ceiling by going deeper.
        var context = new BehaviourExecutionContext(
            behaviour,
            new BehaviourBudget(_behaviourLimits, cancellationToken),
            mutation.IdempotencyScope,
            mutation.IdempotencyKey,
            BehaviourDigest(behaviour))
        { RequiredGrant = required, GrantedAtRevocationGeneration = BehaviourAuthority.RevocationGeneration };
        scope = context;
        var planner = new BehaviourActionPlanner(this, transaction, context, mappings, source);
        await planner.RunAsync(before, cancellationToken);

        foreach (var generated in context.Generated)
        {
            // The dispatch's own evidence, not an empty object: a generated write that
            // retained nothing could never be reversed, so compensating a causal
            // revision would undo the typed half and leave the rest standing.
            evidence.Add(generated.Evidence with
            {
                RequiredHostVersion = NendoFormat.RequireAtLeast(
                    generated.Evidence.RequiredHostVersion, NendoFormat.BehaviourMinimumHostVersion),
            });
        }
        return context;
    }

    /// <summary>
    /// The last thing checked before the transaction commits.
    /// <para>
    /// It runs while the transaction still holds the write lock, so consent withdrawn
    /// at any point during a save — including while its actions were running — aborts
    /// the whole thing rather than being noticed afterwards. The revocation generation
    /// is compared as well as the grant, so consent withdrawn and re-given mid-save is
    /// still treated as a change the owner should see.
    /// </para>
    /// </summary>
    private void RequireBehaviourStillGranted(BehaviourExecutionContext? context)
    {
        if (context?.RequiredGrant is not { } required) return;
        if (BehaviourAuthority.RevocationGeneration != context.GrantedAtRevocationGeneration ||
            !BehaviourAuthority.IsGranted(required))
        {
            throw new NendoPreconditionException(
                "behaviour-not-approved",
                "Approval for this file's automatic actions was withdrawn while saving, so nothing was changed.");
        }
    }

    private async Task WriteAttributionAsync(
        string revisionId,
        int initiatingCount,
        BehaviourExecutionContext? context,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (context is null || context.Generated.Count == 0) return;
        for (var index = 0; index < context.Generated.Count; index++)
        {
            var attribution = context.Generated[index].Attribution;
            await using var command = Command("""
                INSERT INTO __nendo_attribution (
                    revision_id, ordinal, root_scope, root_key, trigger_id, action_id, step_id,
                    event_kind, event_entity_id, event_record_id, behaviour_digest)
                VALUES (@revisionId, @ordinal, @rootScope, @rootKey, @triggerId, @actionId, @stepId,
                    @eventKind, @eventEntityId, @eventRecordId, @behaviourDigest);
                """, transaction);
            command.Parameters.AddWithValue("@revisionId", revisionId);
            command.Parameters.AddWithValue("@ordinal", initiatingCount + index);
            command.Parameters.AddWithValue("@rootScope", attribution.RootScope);
            command.Parameters.AddWithValue("@rootKey", attribution.RootKey);
            command.Parameters.AddWithValue("@triggerId", attribution.TriggerId);
            command.Parameters.AddWithValue("@actionId", attribution.ActionId);
            command.Parameters.AddWithValue("@stepId", attribution.StepId);
            command.Parameters.AddWithValue("@eventKind", attribution.EventKind.ToString());
            command.Parameters.AddWithValue("@eventEntityId", attribution.EventEntityId);
            command.Parameters.AddWithValue("@eventRecordId", attribution.EventRecordId);
            command.Parameters.AddWithValue("@behaviourDigest", attribution.BehaviourDigest);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    /// <summary>
    /// Writes attribution for reviewed generated operations replayed by a promotion.
    /// <para>
    /// A promotion has no live chain to read from, so the provenance comes from the
    /// reviewed plan. The ordinal base is the count of the mutation's author operations,
    /// because the generated operations were folded in after them, and the
    /// <c>(revision_id, ordinal)</c> join is what later rebuilds the generated changes.
    /// </para>
    /// </summary>
    private async Task WriteReviewedAttributionAsync(
        string revisionId,
        int baseOrdinal,
        IReadOnlyList<PreparedBehaviourOperation> generated,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        for (var index = 0; index < generated.Count; index++)
        {
            var attribution = generated[index].Attribution;
            await using var command = Command("""
                INSERT INTO __nendo_attribution (
                    revision_id, ordinal, root_scope, root_key, trigger_id, action_id, step_id,
                    event_kind, event_entity_id, event_record_id, behaviour_digest)
                VALUES (@revisionId, @ordinal, @rootScope, @rootKey, @triggerId, @actionId, @stepId,
                    @eventKind, @eventEntityId, @eventRecordId, @behaviourDigest);
                """, transaction);
            command.Parameters.AddWithValue("@revisionId", revisionId);
            command.Parameters.AddWithValue("@ordinal", baseOrdinal + index);
            command.Parameters.AddWithValue("@rootScope", attribution.RootScope);
            command.Parameters.AddWithValue("@rootKey", attribution.RootKey);
            command.Parameters.AddWithValue("@triggerId", attribution.TriggerId);
            command.Parameters.AddWithValue("@actionId", attribution.ActionId);
            command.Parameters.AddWithValue("@stepId", attribution.StepId);
            command.Parameters.AddWithValue("@eventKind", attribution.EventKind.ToString());
            command.Parameters.AddWithValue("@eventEntityId", attribution.EventEntityId);
            command.Parameters.AddWithValue("@eventRecordId", attribution.EventRecordId);
            command.Parameters.AddWithValue("@behaviourDigest", attribution.BehaviourDigest);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    /// <summary>
    /// Identifies the exact set of definitions a chain ran under, so a later review can
    /// tell whether the behaviour that produced a change is still the behaviour in the
    /// file.
    /// </summary>
    private static string BehaviourDigest(CompiledBehaviour behaviour)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartArray();
            foreach (var definition in behaviour.Definitions.Values.OrderBy(item => item.DefinitionId, StringComparer.Ordinal))
            {
                writer.WriteStartObject();
                writer.WriteString("contractVersion", definition.ContractVersion);
                writer.WriteString("definitionId", definition.DefinitionId);
                writer.WriteString("kind", definition.Kind.ToString());
                writer.WritePropertyName("body");
                using var body = JsonDocument.Parse(definition.CanonicalBody());
                body.RootElement.WriteTo(writer);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream.ToArray())).ToLowerInvariant();
    }
}
