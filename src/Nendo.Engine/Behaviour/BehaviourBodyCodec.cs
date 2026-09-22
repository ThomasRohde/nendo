using System.Text.Json;

namespace Nendo.Engine;

/// <summary>Where a definition body came from, which decides what a refusal is for.</summary>
public enum NendoBehaviourBodySource
{
    /// <summary>
    /// This host's own canonical serialization, read back from the protected table.
    /// A refusal means the file is damaged or was written by another contract.
    /// </summary>
    Stored,

    /// <summary>
    /// A body an author sent. A refusal is the only way the author learns the shape,
    /// so it names the binding, the key and what the key is for.
    /// </summary>
    Authored,
}

/// <summary>
/// Rebuilds a typed definition from a canonical body.
/// <para>
/// Nothing here is best-effort. A body that does not parse back into a valid typed
/// definition is refused whole, never partially interpreted: a formula that
/// half-loaded would compute a number nobody authored. And a key this contract does
/// not define is refused by name rather than dropped, because a dropped key is how
/// an author sends <c>aggregateFieldId</c> three different ways and is told nothing
/// each time.
/// </para>
/// </summary>
internal static class NendoBehaviourCodec
{
    internal static NendoBehaviourDefinition Read(
        string definitionId,
        NendoBehaviourKind kind,
        string contractVersion,
        string bodyJson,
        NendoBehaviourBodySource source = NendoBehaviourBodySource.Stored)
    {
        var reader = new BodyReader(definitionId, source);
        if (!NendoBehaviourContract.IsSupported(contractVersion))
            throw reader.Refuse(
                $"'{definitionId}' was written against behaviour contract {contractVersion}, and this version of Nendo implements {NendoBehaviourContract.Version}.");
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(bodyJson);
        }
        catch (JsonException)
        {
            throw reader.Refuse($"The definition '{definitionId}' is not readable as JSON.");
        }
        using (document)
        {
            var body = document.RootElement;
            if (body.ValueKind != JsonValueKind.Object)
                throw reader.Refuse($"The definition '{definitionId}' needs its body as a JSON object.");
            var definition = kind switch
            {
                NendoBehaviourKind.Calculation => reader.ReadCalculation(contractVersion, body),
                NendoBehaviourKind.Function => reader.ReadFunction(contractVersion, body),
                NendoBehaviourKind.Action => reader.ReadAction(contractVersion, body),
                NendoBehaviourKind.Trigger => reader.ReadTrigger(contractVersion, body),
                _ => throw reader.Refuse($"The definition '{definitionId}' has a kind this version of Nendo does not implement."),
            };
            return definition.Validate();
        }
    }

    private sealed class BodyReader(string definitionId, NendoBehaviourBodySource source)
    {
        // The keys each object of a body may carry, exactly as the canonical writer
        // emits them. Anything else is refused by name.
        private static readonly string[] CalculationKeys =
            ["entityId", "fieldId", "displayName", "resultType", "resultNullable", "expression", "bindings", "callAliases"];
        private static readonly string[] FunctionKeys =
            ["displayName", "parameters", "resultType", "resultNullable", "expression", "callAliases"];
        private static readonly string[] ActionKeys = ["displayName", "steps"];
        private static readonly string[] TriggerKeys =
            ["entityId", "displayName", "events", "actionId", "relevantFieldIds", "conditionExpression", "conditionBindings", "callAliases"];
        private static readonly string[] StepKeys = ["stepId", "kind", "target", "entityId", "assignments"];
        private static readonly string[] AssignmentKeys = ["fieldId", "expression", "bindings", "callAliases"];
        private static readonly string[] ParameterKeys = ["parameterId", "displayName", "parameterType", "nullable"];
        private static readonly string[] AliasKeys = ["alias", "functionId"];
        private static readonly string[] TargetKeys = ["kind", "referenceFieldId"];

        /// <summary>What a refusal is about right now: the definition, or one binding of it.</summary>
        private string _subject = $"'{definitionId}'";

        internal NendoBehaviourDefinition ReadCalculation(string contractVersion, JsonElement body)
        {
            RequireKnownKeys(body, CalculationKeys, "Calculation body");
            return new NendoCalculationDefinition(
                definitionId,
                Text(body, "entityId"),
                Text(body, "fieldId"),
                Text(body, "displayName"),
                Enum<NendoBehaviourScalar>(body, "resultType"),
                Flag(body, "resultNullable"),
                Text(body, "expression"),
                Bindings(body, "bindings"),
                Aliases(body),
                contractVersion);
        }

        internal NendoBehaviourDefinition ReadFunction(string contractVersion, JsonElement body)
        {
            RequireKnownKeys(body, FunctionKeys, "Function body");
            return new NendoFunctionDefinition(
                definitionId,
                Text(body, "displayName"),
                Parameters(body),
                Enum<NendoBehaviourScalar>(body, "resultType"),
                Flag(body, "resultNullable"),
                Text(body, "expression"),
                Aliases(body),
                contractVersion);
        }

        internal NendoBehaviourDefinition ReadAction(string contractVersion, JsonElement body)
        {
            RequireKnownKeys(body, ActionKeys, "Action body");
            var steps = new List<NendoActionStep>();
            foreach (var element in Array(body, "steps"))
            {
                RequireKnownKeys(element, StepKeys, "step");
                var stepId = Text(element, "stepId");
                var assignments = Assignments(element);
                steps.Add(Enum<NendoActionStepKind>(element, "kind") switch
                {
                    NendoActionStepKind.SetField => NendoActionStep.SetFields(stepId, Target(element), assignments),
                    NendoActionStepKind.CreateRecord => NendoActionStep.CreateRecord(stepId, Text(element, "entityId"), assignments),
                    NendoActionStepKind.DeleteRecord => NendoActionStep.DeleteRecord(stepId, Target(element)),
                    _ => throw Refuse($"{_subject} has a step kind this contract does not define."),
                });
            }
            return new NendoActionDefinition(definitionId, Text(body, "displayName"), steps, contractVersion);
        }

        internal NendoBehaviourDefinition ReadTrigger(string contractVersion, JsonElement body)
        {
            RequireKnownKeys(body, TriggerKeys, "Trigger body");
            var relevant = new List<string>();
            foreach (var element in Array(body, "relevantFieldIds"))
            {
                if (element.ValueKind != JsonValueKind.String)
                    throw Refuse($"{_subject} needs every relevantFieldIds entry as a field ID in text.");
                relevant.Add(element.GetString()!);
            }
            var condition = body.TryGetProperty("conditionExpression", out var expression) && expression.ValueKind == JsonValueKind.String
                ? expression.GetString()
                : null;
            return new NendoTriggerDefinition(
                definitionId,
                Text(body, "entityId"),
                Text(body, "displayName"),
                Enum<NendoTriggerEvents>(body, "events"),
                Text(body, "actionId"),
                relevant,
                condition,
                Bindings(body, "conditionBindings"),
                Aliases(body),
                contractVersion);
        }

        private IReadOnlyList<NendoActionAssignment> Assignments(JsonElement element)
        {
            var assignments = new List<NendoActionAssignment>();
            foreach (var assignment in Array(element, "assignments"))
            {
                RequireKnownKeys(assignment, AssignmentKeys, "assignment");
                assignments.Add(new NendoActionAssignment(
                    Text(assignment, "fieldId"),
                    Text(assignment, "expression"),
                    Bindings(assignment, "bindings"),
                    Aliases(assignment)));
            }
            return assignments;
        }

        private NendoActionTarget Target(JsonElement element)
        {
            if (!element.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.Object)
                throw Refuse($"{_subject} needs target as an object whose kind is EventRecord or ReferencedRecord.");
            RequireKnownKeys(target, TargetKeys, "target");
            return Enum<NendoActionTargetKind>(target, "kind") == NendoActionTargetKind.EventRecord
                ? NendoActionTarget.EventRecord
                : NendoActionTarget.Referenced(Text(target, "referenceFieldId"));
        }

        private IReadOnlyList<NendoFunctionParameter> Parameters(JsonElement body)
        {
            var parameters = new List<NendoFunctionParameter>();
            foreach (var element in Array(body, "parameters"))
            {
                RequireKnownKeys(element, ParameterKeys, "parameter");
                parameters.Add(new NendoFunctionParameter(
                    Text(element, "parameterId"),
                    Text(element, "displayName"),
                    Enum<NendoBehaviourScalar>(element, "parameterType"),
                    Flag(element, "nullable")));
            }
            return parameters;
        }

        private IReadOnlyList<NendoFunctionCallAlias> Aliases(JsonElement body)
        {
            var aliases = new List<NendoFunctionCallAlias>();
            foreach (var element in Array(body, "callAliases"))
            {
                RequireKnownKeys(element, AliasKeys, "call alias");
                aliases.Add(new NendoFunctionCallAlias(Text(element, "alias"), Text(element, "functionId")));
            }
            return aliases;
        }

        /// <summary>
        /// A binding is checked against its published shape before any value is read,
        /// so the refusal names the shape, the key, and what the key is for. The
        /// alternative — reading keys one by one and refusing the first that is
        /// missing — told an author that a sum "misuses valueFieldId" without ever
        /// saying that a sum takes one.
        /// </summary>
        private IReadOnlyList<NendoBehaviourBinding> Bindings(JsonElement body, string property)
        {
            var bindings = new List<NendoBehaviourBinding>();
            var outer = _subject;
            try
            {
                foreach (var element in Array(body, property))
                {
                    _subject = outer;
                    if (element.ValueKind != JsonValueKind.Object)
                        throw Refuse($"{_subject} needs every entry of {property} as an object.");
                    var bindingId = Text(element, "bindingId");
                    _subject = $"Binding '{bindingId}' of {outer}";
                    var kind = Enum<NendoBindingKind>(element, "kind");
                    var aggregate = kind == NendoBindingKind.RelatedAggregate
                        ? Enum<NendoAggregateFunction>(element, "aggregate")
                        : (NendoAggregateFunction?)null;
                    var shape = NendoBindingShape.For(kind, aggregate);
                    var unknown = element.EnumerateObject().Select(item => item.Name)
                        .Where(name => !shape.Keys.Contains(name, StringComparer.Ordinal)).ToArray();
                    if (unknown.Length > 0)
                        throw Refuse(
                            $"{_subject} has a key this contract does not define: {string.Join(", ", unknown)}. " +
                            $"A {shape.Name} binding takes {string.Join(", ", shape.Keys)}.");
                    foreach (var key in shape.RequiredKeys)
                        if (!element.TryGetProperty(key, out _))
                            throw Refuse($"{_subject} ({shape.Name}) needs {key} — {NendoBindingShape.Purpose(key)}.");
                    var entityId = Text(element, "entityId");
                    bindings.Add(kind switch
                    {
                        NendoBindingKind.SameRecordField => NendoBehaviourBinding.SameRecordField(
                            bindingId, entityId, Text(element, "fieldId"),
                            Enum<NendoBehaviourScalar>(element, "resultType"), Flag(element, "nullable")),
                        NendoBindingKind.SameRecordCalculation => NendoBehaviourBinding.SameRecordCalculation(
                            bindingId, entityId, Text(element, "calculationId"),
                            Enum<NendoBehaviourScalar>(element, "resultType"), Flag(element, "nullable")),
                        NendoBindingKind.ReferenceTraversal => NendoBehaviourBinding.ReferenceTraversal(
                            bindingId, entityId, Text(element, "referenceFieldId"), Text(element, "relatedEntityId"),
                            Text(element, "fieldId"), Enum<NendoBehaviourScalar>(element, "resultType"), Flag(element, "nullable")),
                        NendoBindingKind.RelatedAggregate => Aggregate(element, bindingId, entityId, aggregate!.Value),
                        _ => throw Refuse($"{_subject} has a binding kind this contract does not define."),
                    });
                }
            }
            finally
            {
                _subject = outer;
            }
            return bindings;
        }

        private NendoBehaviourBinding Aggregate(JsonElement element, string bindingId, string entityId, NendoAggregateFunction aggregate)
        {
            var relatedEntityId = Text(element, "relatedEntityId");
            var relatedReferenceFieldId = Text(element, "relatedReferenceFieldId");
            if (aggregate != NendoAggregateFunction.Sum)
            {
                // A count's result type is not a choice, but a body that states it must
                // state it truthfully rather than be read as something it does not say.
                if (element.TryGetProperty("resultType", out _) && Enum<NendoBehaviourScalar>(element, "resultType") != NendoBehaviourScalar.Integer)
                    throw Refuse($"{_subject} ({NendoBindingKind.RelatedAggregate} {aggregate}) always produces Integer; leave resultType out or say Integer.");
            }
            if (element.TryGetProperty("nullable", out _) && Flag(element, "nullable"))
                throw Refuse($"{_subject} ({NendoBindingKind.RelatedAggregate} {aggregate}) is never null: an empty collection totals zero. Leave nullable out or say false.");
            return aggregate switch
            {
                NendoAggregateFunction.Count => NendoBehaviourBinding.RelatedCount(
                    bindingId, entityId, relatedEntityId, relatedReferenceFieldId),
                NendoAggregateFunction.FilteredCount => NendoBehaviourBinding.RelatedFilteredCount(
                    bindingId, entityId, relatedEntityId, relatedReferenceFieldId, Text(element, "predicateFieldId")),
                NendoAggregateFunction.Sum => NendoBehaviourBinding.RelatedSum(
                    bindingId, entityId, relatedEntityId, relatedReferenceFieldId,
                    Text(element, "valueFieldId"), Enum<NendoBehaviourScalar>(element, "resultType")),
                _ => throw Refuse($"{_subject} has an aggregate this contract does not define."),
            };
        }

        private void RequireKnownKeys(JsonElement element, string[] known, string what)
        {
            var unknown = element.EnumerateObject().Select(item => item.Name)
                .Where(name => !known.Contains(name, StringComparer.Ordinal)).ToArray();
            if (unknown.Length > 0)
                throw Refuse(
                    $"{_subject} has a key this contract does not define in its {what}: {string.Join(", ", unknown)}. " +
                    $"A {what} takes {string.Join(", ", known)}.");
        }

        private JsonElement.ArrayEnumerator Array(JsonElement element, string property)
        {
            if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
                throw Refuse($"{_subject} needs {property} as a list, empty or not.");
            return value.EnumerateArray();
        }

        private string Text(JsonElement element, string property)
        {
            if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
                throw Refuse($"{_subject} needs {property} as text.");
            return value.GetString()!;
        }

        private bool Flag(JsonElement element, string property)
        {
            if (!element.TryGetProperty(property, out var value) ||
                value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw Refuse($"{_subject} needs {property} as true or false.");
            return value.GetBoolean();
        }

        private TValue Enum<TValue>(JsonElement element, string property) where TValue : struct, Enum
        {
            var text = Text(element, property);
            return System.Enum.TryParse<TValue>(text, ignoreCase: false, out var parsed)
                ? parsed
                : throw Refuse(
                    $"{_subject} has {property} '{text}', which is not one this contract defines. " +
                    $"Use one of: {string.Join(", ", System.Enum.GetNames<TValue>().Where(name => name != "None"))}.");
        }

        /// <summary>
        /// A stored body that fails here is a damaged file, and the remedy is to look at
        /// it. An authored body is a request, and the message is the whole remedy.
        /// </summary>
        internal NendoValidationException Refuse(string problem) => new(
            source == NendoBehaviourBodySource.Stored
                ? $"{problem} A stored definition is refused rather than half-read; inspect the file before editing it."
                : problem);
    }
}
