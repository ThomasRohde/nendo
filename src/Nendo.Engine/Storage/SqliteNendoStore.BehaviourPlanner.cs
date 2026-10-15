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
                // A record no trigger listens to raises nothing, so it is not read. Reading it
                // spent the save's related-row allowance on every record the request named, and a
                // batch of untriggered writes left too few rows for the one trigger's total (EBH-21).
                if (!Watched(key.EntityId)) continue;
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

        /// <summary>Whether any trigger listens to a record type's events.</summary>
        private bool Watched(string entityId) =>
            context.Behaviour.Definitions.Values.OfType<NendoTriggerDefinition>()
                .Any(trigger => string.Equals(trigger.EntityId, entityId, StringComparison.Ordinal));

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
                catch (NendoCalculationException exception) when (!exception.ExhaustedBudget)
                {
                    // A rule that cannot be decided blocks its action and is reported.
                    // It does not abort the edit: the owner's typed values are valid
                    // whether or not a condition about them could be evaluated. A spent
                    // budget is not undecidable data but a save that asked for too much,
                    // and the contract aborts the whole save on one; swallowing it here let
                    // the save commit with the action silently skipped (EBH-02). A limit the
                    // data reaches, a subtree past its descendant bound, stays a blocked
                    // condition, as ADR-0008 §6 says of a value-caused error.
                    context.BlockedConditions.Add(new NendoBlockedCondition(
                        trigger.DefinitionId, trigger.DisplayName, raised.Key.EntityId, raised.Key.RecordId,
                        exception.Code, exception.Message));
                    return;
                }
                if (!holds) return;
            }

            var action = (NendoActionDefinition)context.Behaviour.Definitions[trigger.ActionId];
            foreach (var step in action.Steps)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var target in Targets(step, raised))
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
            // Compile validates every condition of the set it holds, so one missing here is a
            // broken invariant, not an author's mistake to report.
            var expression = context.Behaviour.Conditions.TryGetValue(trigger.DefinitionId, out var compiled)
                ? compiled
                : throw new InvalidOperationException($"The condition of '{trigger.DefinitionId}' was not compiled with the file's behaviour.");
            BehaviourValue result;
            try
            {
                result = store.BehaviourAdapter.Calculate(expression, values, context.Budget);
            }
            catch (NendoCalculationException exception)
            {
                throw NendoCalculationService.Named(exception, expression.FormulaId, trigger.ConditionBindings, source, context.Behaviour);
            }
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
        private IReadOnlyList<string> Targets(NendoActionStep step, RecordEvent raised)
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
            return targets;
        }

        /// <summary>
        /// Runs one step, and attributes any refusal inside it, whether evaluating, charging the
        /// budget or writing, to the action, the step and the field. Only an assignment's formula
        /// was attributed: a create step that missed a required field refused the save with
        /// "Required field taskTitle needs a value.", naming a field the person never saw and no
        /// action, and a delete blocked by references named a record the person did not delete
        /// (EBH-05). The refusal keeps its type and code, so every surface maps it as before.
        /// </summary>
        private async Task RunStepAsync(
            NendoTriggerDefinition trigger,
            NendoActionDefinition action,
            NendoActionStep step,
            string targetRecordId,
            RecordEvent raised,
            CancellationToken cancellationToken)
        {
            string? field = null;
            try
            {
                await RunStepAsync(trigger, action, step, targetRecordId, raised, value => field = value, cancellationToken);
            }
            catch (NendoException exception) when (exception is NendoCalculationException or NendoValidationException or NendoPreconditionException)
            {
                var entityId = step.Kind == NendoActionStepKind.CreateRecord ? step.EntityId! : TargetEntityId(step, trigger);
                // By display name, as the person sees them, and by ID where the schema has no such name.
                var entity = mappings.SingleOrDefault(candidate => string.Equals(candidate.EntityId, entityId, StringComparison.Ordinal));
                var type = entity?.DisplayName ?? entityId;
                var named = field is null
                    ? null
                    : entity?.Fields.SingleOrDefault(candidate => string.Equals(candidate.FieldId, field, StringComparison.Ordinal))?.DisplayName ?? field;
                var what = step.Kind switch
                {
                    NendoActionStepKind.CreateRecord when named is not null => $"create a '{type}' record with '{named}'",
                    NendoActionStepKind.CreateRecord => $"create a '{type}' record",
                    NendoActionStepKind.DeleteRecord => $"delete a '{type}' record",
                    _ when named is not null => $"write '{named}' of a '{type}' record",
                    _ => $"change a '{type}' record",
                };
                var message = $"The automatic action '{action.DisplayName}' (run by '{trigger.DisplayName}') could not {what} " +
                    $"(step {step.StepId}): {exception.Message} The save was refused, so nothing changed.";
                throw exception switch
                {
                    NendoCalculationException calculation => new NendoCalculationException(calculation.Code, message)
                    { ExhaustedBudget = calculation.ExhaustedBudget, Spend = calculation.Spend, Path = calculation.Path },
                    NendoPreconditionException precondition => new NendoPreconditionException(precondition.Code, message)
                    { RecordId = precondition.RecordId },
                    _ => new NendoValidationException(message),
                };
            }
        }

        private async Task RunStepAsync(
            NendoTriggerDefinition trigger,
            NendoActionDefinition action,
            NendoActionStep step,
            string targetRecordId,
            RecordEvent raised,
            Action<string?> writing,
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
                        // The save is refused whole, and the refusal says which action could
                        // not run and where. Without this the person saw "a value this formula
                        // needs is empty" with no formula in sight, and an agent saw an internal
                        // error.
                        writing(assignment.FieldId);
                        var value = await EvaluateAssignmentAsync(action, step, assignment, entityId, targetRecordId, cancellationToken);
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
                    writing(null);
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
                        // A create step's bindings start from the record that raised the event,
                        // so that record is the one read and observed (EBH-23).
                        writing(assignment.FieldId);
                        values[assignment.FieldId] = Unbox(
                            await EvaluateAssignmentAsync(action, step, assignment, trigger.EntityId, raised.Key.RecordId, cancellationToken));
                    }
                    writing(null);
                    // A link sets a reference of the new record to the record that raised the
                    // event, or to the one its reference names now (before it, for a deletion),
                    // at the version it has now, as a person's own create names it.
                    var targetVersions = new Dictionary<string, long>(StringComparer.Ordinal);
                    foreach (var link in step.Links)
                    {
                        context.Budget.SpendWork();
                        var linked = LinkedRecordId(link, raised);
                        values[link.FieldId] = linked;
                        if (linked is null) continue;
                        var key = new RecordKey(LinkedEntityId(link, trigger), linked);
                        if (await ReadVersionAsync(key, cancellationToken) is { } linkedVersion)
                        {
                            targetVersions[link.FieldId] = linkedVersion;
                            context.Observe(key, linkedVersion);
                        }
                    }
                    context.Budget.SpendChange();
                    var recordId = DeterministicRecordId(attribution, raised, targetRecordId);
                    await ExecuteAsync(
                        new CreateRecordOperation(NextOperationId(), entityId, recordId, values, targetVersions),
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
            var formulaId = $"{action.DefinitionId}:{step.StepId}:{assignment.FieldId}";
            var expression = context.Behaviour.Assignments.TryGetValue(formulaId, out var compiled) && compiled.Expression is { } ready
                ? ready
                : throw new InvalidOperationException($"The formula '{formulaId}' was not compiled with the file's behaviour.");
            try
            {
                return store.BehaviourAdapter.Calculate(expression, values, context.Budget);
            }
            catch (NendoCalculationException exception)
            {
                throw NendoCalculationService.Named(exception, formulaId, assignment.Bindings, source, context.Behaviour);
            }
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
            if (changed.Count == 0 || !Watched(key.EntityId)) return;
            var after = await ReadRecordAsync(key, cancellationToken);
            if (after is null) return;
            context.Pending.Enqueue(new RecordEvent(key, NendoRecordEventKind.Updated, before, after, changed));
        }

        /// <summary>A record an action created. Every field of it is new, so all of them are the change.</summary>
        private async Task RaiseCreatedAsync(RecordKey key, CancellationToken cancellationToken)
        {
            if (!Watched(key.EntityId)) return;
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
            // A record type with no stored fields has no readable state, like an absent
            // record, and costs no scan: the store's reader returns null for it unread.
            if (entity is null || entity.Fields.Count == 0) return null;
            context.Budget.SpendScan();
            return await store.ReadRecordValuesAsync(key, mappings, transaction, cancellationToken);
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

        private string LinkedEntityId(NendoActionLink link, NendoTriggerDefinition trigger) =>
            link.Target.Kind == NendoActionTargetKind.EventRecord
                ? trigger.EntityId
                : mappings.Single(candidate => string.Equals(candidate.EntityId, trigger.EntityId, StringComparison.Ordinal))
                    .Fields.Single(field => string.Equals(field.FieldId, link.Target.ReferenceFieldId, StringComparison.Ordinal))
                    .Reference!.TargetEntityId;

        private static string? LinkedRecordId(NendoActionLink link, RecordEvent raised)
        {
            if (link.Target.Kind == NendoActionTargetKind.EventRecord)
                return raised.Kind == NendoRecordEventKind.Deleted ? null : raised.Key.RecordId;
            var side = raised.After ?? raised.Before;
            return side is not null && side.TryGetValue(link.Target.ReferenceFieldId!, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
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
