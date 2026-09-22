using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// Runs the automatic actions a set of staged changes selected, inside the same
    /// transaction that staged them.
    /// <para>
    /// Inside is the whole point. The initiating edit and everything the triggers do
    /// are one SQLite transaction and one revision, so either all of it is durable or
    /// the file is untouched. There is no window in which a task is marked done but
    /// its project's total has not caught up, and no repair pass that could fail
    /// separately.
    /// </para>
    /// <para>
    /// Every generated write goes through the same operation dispatch an author's own
    /// write uses, so it is checked against the same record versions, reference
    /// targets, required fields and retirement rules. A trigger is not a privileged
    /// path into the data.
    /// </para>
    /// </summary>
    private sealed class BehaviourActionPlanner(
        SqliteNendoStore store,
        SqliteTransaction transaction,
        BehaviourExecutionContext context,
        IReadOnlyList<EntityMapping> mappings,
        IBehaviourRecordSource source)
    {
        private readonly NendoCalculationService _calculations = new(store.BehaviourAdapter);

        /// <summary>
        /// Turns the difference between the captured before-state and the staged state
        /// into logical events, then runs the queue until nothing new is raised.
        /// </summary>
        internal async Task RunAsync(
            IReadOnlyDictionary<RecordKey, IReadOnlyDictionary<string, JsonElement>?> before,
            CancellationToken cancellationToken)
        {
            // Ordinal order over (record type, record) so the same edit produces the
            // same chain every time, whatever order the operations arrived in.
            foreach (var key in before.Keys.OrderBy(key => key.EntityId, StringComparer.Ordinal)
                         .ThenBy(key => key.RecordId, StringComparer.Ordinal))
            {
                var raised = await DeriveAsync(key, before[key], cancellationToken);
                if (raised is not null) context.Pending.Enqueue(raised);
            }

            while (context.Pending.Count > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                context.Budget.SpendWork();
                var raised = context.Pending.Dequeue();
                foreach (var trigger in TriggersFor(raised))
                {
                    await RunTriggerAsync(trigger, raised, cancellationToken);
                }
            }
        }

        /// <summary>
        /// The triggers one event selects, by stable ID in ordinal order so two
        /// triggers on the same record type always run in the same sequence.
        /// </summary>
        private IEnumerable<NendoTriggerDefinition> TriggersFor(RecordEvent raised) =>
            context.Behaviour.Definitions.Values
                .OfType<NendoTriggerDefinition>()
                .Where(trigger => string.Equals(trigger.EntityId, raised.Key.EntityId, StringComparison.Ordinal))
                .Where(trigger => trigger.Events.HasFlag(raised.Kind switch
                {
                    NendoRecordEventKind.Created => NendoTriggerEvents.Created,
                    NendoRecordEventKind.Deleted => NendoTriggerEvents.Deleted,
                    _ => NendoTriggerEvents.Updated,
                }))
                // Relevant fields narrow an update to the stored values that actually
                // moved, so an edit to an unrelated field raises nothing.
                .Where(trigger => raised.Kind != NendoRecordEventKind.Updated ||
                                  trigger.RelevantFieldIds.Count == 0 ||
                                  trigger.RelevantFieldIds.Any(raised.ChangedFieldIds.Contains))
                .OrderBy(trigger => trigger.DefinitionId, StringComparer.Ordinal)
                .ToArray();

        private async Task RunTriggerAsync(
            NendoTriggerDefinition trigger,
            RecordEvent raised,
            CancellationToken cancellationToken)
        {
            context.Budget.SpendWork();
            if (trigger.ConditionExpression is not null)
            {
                bool holds;
                try
                {
                    holds = await EvaluateConditionAsync(trigger, raised, cancellationToken);
                }
                catch (NendoCalculationException exception)
                {
                    // A rule that cannot be decided blocks its action and is reported.
                    // It does not abort the edit: the owner's typed values are valid
                    // whether or not a condition about them could be evaluated.
                    context.BlockedConditions.Add((trigger.DefinitionId, exception.Code, exception.Message));
                    return;
                }
                if (!holds) return;
            }

            var action = (NendoActionDefinition)context.Behaviour.Definitions[trigger.ActionId];
            foreach (var step in action.Steps)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var target in await TargetsAsync(step, raised, cancellationToken))
                {
                    await RunStepAsync(trigger, action, step, target, raised, cancellationToken);
                }
            }
        }

        private async Task<bool> EvaluateConditionAsync(
            NendoTriggerDefinition trigger,
            RecordEvent raised,
            CancellationToken cancellationToken)
        {
            // A deletion is judged like any other event, not waved through. Returning true
            // here ran a conditional action on every deletion regardless of the condition
            // the author wrote — the unsafe direction, since a DeleteRecord step could then
            // delete a parent unconditionally. A same-record binding on a deleted record
            // resolves to "no longer there", which blocks the action fail-closed; an
            // aggregate binding still evaluates against the staged rows.
            var values = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);
            foreach (var binding in trigger.ConditionBindings)
            {
                values[binding.BindingId] = binding.CalculationId is { } read
                    ? await _calculations.EvaluateAsync(
                        context.Behaviour, read, raised.Key.RecordId, source, context.Budget, cancellationToken)
                    : await source.ResolveAsync(binding, raised.Key.RecordId, context.Budget, cancellationToken);
            }
            await ObserveAsync(raised.Key, cancellationToken);
            var expression = store.BehaviourAdapter.Validate(
                new BehaviourFormula(
                    $"{trigger.DefinitionId}:condition",
                    trigger.ConditionExpression!,
                    trigger.ConditionBindings
                        .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                        .ToArray(),
                    Resolve(trigger.CallAliases)),
                context.Budget);
            var result = store.BehaviourAdapter.Calculate(expression, values, context.Budget);
            return !result.IsNull && result.AsBoolean();
        }

        /// <summary>
        /// The records one step writes to.
        /// <para>
        /// A step that follows a relationship resolves it from both sides of the event.
        /// That is what makes reassignment correct: moving a task from one project to
        /// another has to update the project it left as well as the one it joined, and
        /// only the before-state knows which one it left.
        /// </para>
        /// </summary>
        private async Task<IReadOnlyList<string>> TargetsAsync(
            NendoActionStep step,
            RecordEvent raised,
            CancellationToken cancellationToken)
        {
            context.Budget.SpendWork();
            if (step.Kind == NendoActionStepKind.CreateRecord) return [string.Empty];
            if (step.Target.Kind == NendoActionTargetKind.EventRecord)
            {
                // Nothing can be written to a record that no longer exists.
                return raised.Kind == NendoRecordEventKind.Deleted ? [] : [raised.Key.RecordId];
            }

            var field = step.Target.ReferenceFieldId!;
            var targets = new List<string>();
            foreach (var side in new[] { raised.Before, raised.After })
            {
                if (side is null || !side.TryGetValue(field, out var value) || value.ValueKind != JsonValueKind.String) continue;
                var id = value.GetString();
                if (id is not null && !targets.Contains(id, StringComparer.Ordinal)) targets.Add(id);
            }
            targets.Sort(StringComparer.Ordinal);
            await Task.CompletedTask;
            return targets;
        }

        private async Task RunStepAsync(
            NendoTriggerDefinition trigger,
            NendoActionDefinition action,
            NendoActionStep step,
            string targetRecordId,
            RecordEvent raised,
            CancellationToken cancellationToken)
        {
            var attribution = new BehaviourAttribution(
                context.RootScope, context.RootKey, trigger.DefinitionId, action.DefinitionId, step.StepId,
                raised.Kind, raised.Key.EntityId, raised.Key.RecordId, context.BehaviourDigest);

            switch (step.Kind)
            {
                case NendoActionStepKind.SetField:
                {
                    var entityId = TargetEntityId(step, trigger);
                    var key = new RecordKey(entityId, targetRecordId);
                    var current = await ReadRecordAsync(key, cancellationToken);
                    if (current is null) return;
                    // The state before this step's writes, kept so the event it raises
                    // carries a real before-state. Passing the post-write state as both
                    // sides lost the former reference target of a reassignment, so a
                    // downstream trigger that follows the moved reference only ever saw
                    // the record's new parent.
                    var beforeStep = current;
                    var version = await ReadVersionAsync(key, cancellationToken)
                        ?? throw new NendoCalculationException(NendoCalculationCodes.RelatedUnavailable,
                            "A record this action writes to is no longer there.");

                    var written = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var assignment in step.Assignments)
                    {
                        BehaviourValue value;
                        try
                        {
                            value = await EvaluateAssignmentAsync(action, step, assignment, entityId, targetRecordId, cancellationToken);
                        }
                        catch (NendoCalculationException exception)
                        {
                            // The save is refused whole, and the refusal says which
                            // action could not run and where. Without this the person
                            // saw "a value this formula needs is empty" with no formula
                            // in sight, and an agent saw an internal error.
                            throw new NendoCalculationException(exception.Code,
                                $"The automatic action '{action.DisplayName}' could not write {assignment.FieldId} " +
                                $"(step {step.StepId}): {exception.Message} The save was refused, so nothing changed.");
                        }
                        // A value that is already what it should be is not a change:
                        // writing it would burn a record version, raise an event and
                        // potentially start a chain that never settles.
                        if (current.TryGetValue(assignment.FieldId, out var stored) && SameScalar(stored, value)) continue;
                        context.Budget.SpendChange();
                        var operation = new SetFieldOperation(
                            NextOperationId(), entityId, targetRecordId, assignment.FieldId, version, Unbox(value));
                        await ExecuteAsync(operation, attribution, cancellationToken);
                        version++;
                        written.Add(assignment.FieldId);
                        current = await ReadRecordAsync(key, cancellationToken) ?? current;
                    }
                    // What this step actually wrote, and nothing else. A step that
                    // changed nothing raises nothing; one that changed two fields says
                    // those two. Saying "everything changed" would make a field
                    // subscription meaningless for generated events and turn an action
                    // that writes to its own record into a loop that only the budget
                    // stops.
                    await RaiseAsync(key, written, beforeStep, cancellationToken);
                    break;
                }

                case NendoActionStepKind.DeleteRecord:
                {
                    var entityId = TargetEntityId(step, trigger);
                    var key = new RecordKey(entityId, targetRecordId);
                    var before = await ReadRecordAsync(key, cancellationToken);
                    if (before is null) return;
                    var version = await ReadVersionAsync(key, cancellationToken)!;
                    context.Budget.SpendChange();
                    await ExecuteAsync(
                        new DeleteRecordOperation(NextOperationId(), entityId, targetRecordId, version!.Value),
                        attribution, cancellationToken);
                    context.Pending.Enqueue(new RecordEvent(key, NendoRecordEventKind.Deleted, before, null,
                        before.Keys.ToHashSet(StringComparer.Ordinal)));
                    break;
                }

                case NendoActionStepKind.CreateRecord:
                {
                    var entityId = step.EntityId!;
                    var values = new Dictionary<string, object?>(StringComparer.Ordinal);
                    foreach (var assignment in step.Assignments)
                    {
                        values[assignment.FieldId] = Unbox(
                            await EvaluateAssignmentAsync(action, step, assignment, entityId, raised.Key.RecordId, cancellationToken));
                    }
                    context.Budget.SpendChange();
                    var recordId = DeterministicRecordId(attribution, raised, targetRecordId);
                    await ExecuteAsync(
                        new CreateRecordOperation(NextOperationId(), entityId, recordId, values),
                        attribution, cancellationToken);
                    await RaiseCreatedAsync(new RecordKey(entityId, recordId), cancellationToken);
                    break;
                }

                default:
                    throw new NendoValidationException("The step kind is not supported by this contract.");
            }
        }

        private async Task<BehaviourValue> EvaluateAssignmentAsync(
            NendoActionDefinition action,
            NendoActionStep step,
            NendoActionAssignment assignment,
            string entityId,
            string recordId,
            CancellationToken cancellationToken)
        {
            var values = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);
            foreach (var binding in assignment.Bindings)
            {
                values[binding.BindingId] = binding.CalculationId is { } read
                    ? await _calculations.EvaluateAsync(context.Behaviour, read, recordId, source, context.Budget, cancellationToken)
                    : await source.ResolveAsync(binding, recordId, context.Budget, cancellationToken);
            }
            await ObserveAsync(new RecordKey(entityId, recordId), cancellationToken);
            var expression = store.BehaviourAdapter.Validate(
                new BehaviourFormula(
                    $"{action.DefinitionId}:{step.StepId}:{assignment.FieldId}",
                    assignment.Expression,
                    assignment.Bindings
                        .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                        .ToArray(),
                    Resolve(assignment.CallAliases)),
                context.Budget);
            return store.BehaviourAdapter.Calculate(expression, values, context.Budget);
        }

        private IReadOnlyDictionary<string, ValidatedExpression> Resolve(IReadOnlyList<NendoFunctionCallAlias> aliases)
        {
            var resolved = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
            foreach (var alias in aliases)
            {
                if (context.Behaviour.Functions.TryGetValue(alias.FunctionId, out var function)) resolved[alias.Alias] = function;
            }
            return resolved;
        }

        /// <summary>
        /// Runs a generated operation through the ordinary dispatch and records why it
        /// exists. Its evidence joins the initiating operations in one revision.
        /// </summary>
        private async Task ExecuteAsync(
            NendoOperation operation,
            BehaviourAttribution attribution,
            CancellationToken cancellationToken)
        {
            var evidence = await store.ExecuteOperationMetadataOrDataAsync(
                operation, new HashSet<string>(StringComparer.Ordinal), transaction, cancellationToken);
            context.Generated.Add((operation, attribution, evidence));
            store.GeneratedOperationCheckpoint?.Invoke(context.Generated.Count);
        }

        /// <summary>Re-derives an event for a record a generated write just touched.</summary>
        private async Task RaiseAsync(
            RecordKey key,
            IReadOnlySet<string> changed,
            IReadOnlyDictionary<string, JsonElement>? before,
            CancellationToken cancellationToken)
        {
            if (changed.Count == 0) return;
            var after = await ReadRecordAsync(key, cancellationToken);
            if (after is null) return;
            context.Pending.Enqueue(new RecordEvent(key, NendoRecordEventKind.Updated, before, after, changed));
        }

        /// <summary>A record an action created. Every field of it is new, so all of them are the change.</summary>
        private async Task RaiseCreatedAsync(RecordKey key, CancellationToken cancellationToken)
        {
            var after = await ReadRecordAsync(key, cancellationToken);
            if (after is null) return;
            context.Pending.Enqueue(new RecordEvent(key, NendoRecordEventKind.Created, null, after,
                after.Keys.ToHashSet(StringComparer.Ordinal)));
        }

        private async Task<RecordEvent?> DeriveAsync(
            RecordKey key,
            IReadOnlyDictionary<string, JsonElement>? before,
            CancellationToken cancellationToken)
        {
            var after = await ReadRecordAsync(key, cancellationToken);
            if (before is null && after is null) return null;
            if (before is null)
                return new RecordEvent(key, NendoRecordEventKind.Created, null, after,
                    after!.Keys.ToHashSet(StringComparer.Ordinal));
            if (after is null)
                return new RecordEvent(key, NendoRecordEventKind.Deleted, before, null,
                    before.Keys.ToHashSet(StringComparer.Ordinal));

            var changed = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (fieldId, value) in after)
            {
                if (!before.TryGetValue(fieldId, out var previous) || !JsonElement.DeepEquals(previous, value))
                    changed.Add(fieldId);
            }
            // Setting a field to the value it already holds is not a change, so it
            // raises nothing and starts nothing.
            return changed.Count == 0
                ? null
                : new RecordEvent(key, NendoRecordEventKind.Updated, before, after, changed);
        }

        internal async Task<IReadOnlyDictionary<string, JsonElement>?> ReadRecordAsync(
            RecordKey key,
            CancellationToken cancellationToken)
        {
            var entity = mappings.SingleOrDefault(candidate => string.Equals(candidate.EntityId, key.EntityId, StringComparison.Ordinal));
            // A record type with no stored fields would build `SELECT  FROM …` and raise a
            // raw SqliteException. The sibling reader guards the same case; this one must
            // too, treating a fieldless record as "no readable state" like an absent one.
            if (entity is null || entity.Fields.Count == 0) return null;
            context.Budget.SpendScan();
            var columns = entity.Fields.Select(field => Quote(field.PhysicalColumnName));
            await using var command = store.Command(
                $"SELECT {string.Join(", ", columns)} FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @recordId;",
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

        private async Task<long?> ReadVersionAsync(RecordKey key, CancellationToken cancellationToken)
        {
            var entity = mappings.SingleOrDefault(candidate => string.Equals(candidate.EntityId, key.EntityId, StringComparison.Ordinal));
            if (entity is null) return null;
            await using var command = store.Command(
                $"SELECT {Quote("__nendo_record_version")} FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @recordId;",
                transaction);
            command.Parameters.AddWithValue("@recordId", key.RecordId);
            var value = await command.ExecuteScalarAsync(cancellationToken);
            return value is null or DBNull ? null : Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
        }

        private async Task ObserveAsync(RecordKey key, CancellationToken cancellationToken)
        {
            var version = await ReadVersionAsync(key, cancellationToken);
            if (version is not null) context.Observe(key, version.Value);
        }

        private string TargetEntityId(NendoActionStep step, NendoTriggerDefinition trigger) =>
            step.Target.Kind == NendoActionTargetKind.EventRecord
                ? trigger.EntityId
                : mappings.Single(candidate => string.Equals(candidate.EntityId, trigger.EntityId, StringComparison.Ordinal))
                    .Fields.Single(field => string.Equals(field.FieldId, step.Target.ReferenceFieldId, StringComparison.Ordinal))
                    .Reference!.TargetEntityId;

        /// <summary>
        /// Operation IDs are derived from the chain's own identity and position, never
        /// generated fresh. A retry that resolves to the same receipt therefore names
        /// the same operations, and a replay cannot invent new ones.
        /// </summary>
        private string NextOperationId() =>
            NendoCanonical.DeterministicId("generated", context.RootScope, context.RootKey, context.Generated.Count);

        private string DeterministicRecordId(BehaviourAttribution attribution, RecordEvent raised, string target) =>
            NendoCanonical.DeterministicId(
                "record",
                $"{context.RootScope}\n{attribution.TriggerId}\n{attribution.StepId}",
                $"{context.RootKey}\n{raised.Key.EntityId}\n{raised.Key.RecordId}\n{target}",
                context.Generated.Count);

        private static bool SameScalar(JsonElement stored, BehaviourValue value)
        {
            if (value.IsNull) return stored.ValueKind == JsonValueKind.Null;
            return stored.ValueKind switch
            {
                JsonValueKind.Null => false,
                JsonValueKind.True or JsonValueKind.False =>
                    value.Type == NendoBehaviourScalar.Boolean && stored.GetBoolean() == value.AsBoolean(),
                JsonValueKind.Number when value.Type == NendoBehaviourScalar.Integer =>
                    stored.TryGetInt64(out var number) && number == value.AsInteger(),
                JsonValueKind.Number when value.Type == NendoBehaviourScalar.Decimal =>
                    stored.TryGetDecimal(out var number) && number == value.AsDecimal(),
                // A Text, Boolean or Date value against a stored number is a genuine
                // mismatch, not a no-op. Unboxing it as decimal here threw an
                // InvalidCastException out of the save; falling through lets the write
                // reach ConvertValue's typed "does not match storage kind" refusal. The
                // same holds the other way round: an Integer or Boolean result whose
                // rendering happens to equal the stored text is a mismatch too, and
                // comparing renderings let it pass as "already what it should be" — so
                // whether the wrong type was reported depended on the record's current
                // value. A stored text is compared only against a text or a date.
                JsonValueKind.String when value.Type is NendoBehaviourScalar.Text or NendoBehaviourScalar.Date =>
                    string.Equals(stored.GetString(), value.ToString(), StringComparison.Ordinal),
                _ => false,
            };
        }

        private static object? Unbox(BehaviourValue value) => value.Boxed switch
        {
            null => null,
            DateOnly date => date.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            var other => other,
        };
    }
}
