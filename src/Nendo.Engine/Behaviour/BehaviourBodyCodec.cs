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
        // The keys each object of a body may carry: the published table, which the
        // canonical writer stays inside. Anything else is refused by name.
        private static readonly string[] CalculationKeys = NendoBehaviourBodyShape.KeysOf("Calculation body");
        private static readonly string[] FunctionKeys = NendoBehaviourBodyShape.KeysOf("Function body");
        private static readonly string[] ActionKeys = NendoBehaviourBodyShape.KeysOf("Action body");
        private static readonly string[] TriggerKeys = NendoBehaviourBodyShape.KeysOf("Trigger body");
        private static readonly string[] StepKeys = NendoBehaviourBodyShape.KeysOf("step");
        private static readonly string[] AssignmentKeys = NendoBehaviourBodyShape.KeysOf("assignment");
        private static readonly string[] LinkKeys = NendoBehaviourBodyShape.KeysOf("link");
        private static readonly string[] ParameterKeys = NendoBehaviourBodyShape.KeysOf("parameter");
        private static readonly string[] AliasKeys = NendoBehaviourBodyShape.KeysOf("call alias");
        private static readonly string[] TargetKeys = NendoBehaviourBodyShape.KeysOf("target");

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
                var kind = Enum<NendoActionStepKind>(element, "kind");
                if (kind != NendoActionStepKind.CreateRecord && element.TryGetProperty("links", out _))
                    throw Refuse($"{_subject} sets links in step '{stepId}', and only a CreateRecord step sets links.");
                steps.Add(kind switch
                {
                    NendoActionStepKind.SetField => NendoActionStep.SetFields(stepId, Target(element), assignments),
                    NendoActionStepKind.CreateRecord => NendoActionStep.CreateRecord(stepId, Text(element, "entityId"), assignments, Links(element)),
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
                Events(body),
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

        private IReadOnlyList<NendoActionLink> Links(JsonElement element)
        {
            var links = new List<NendoActionLink>();
            foreach (var link in Array(element, "links"))
            {
                if (link.ValueKind != JsonValueKind.Object)
                    throw Refuse($"{_subject} needs every entry of links as an object with fieldId and target.");
                RequireKnownKeys(link, LinkKeys, "link");
                links.Add(new NendoActionLink(Text(link, "fieldId"), Target(link)));
            }
            return links;
        }

        /// <summary>
        /// The events a trigger listens to: text as the canonical writer stores it,
        /// <c>"Created, Updated"</c>, or a list of the names, which is how authors send it.
        /// </summary>
        private NendoTriggerEvents Events(JsonElement body)
        {
            if (body.TryGetProperty("events", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                var events = NendoTriggerEvents.None;
                foreach (var item in list.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String || !System.Enum.TryParse<NendoTriggerEvents>(item.GetString(), false, out var one) ||
                        one == NendoTriggerEvents.None || item.GetString()!.Contains(',', StringComparison.Ordinal))
                        throw Refuse($"{_subject} lists an event this contract does not define. Use Created, Updated or Deleted.");
                    events |= one;
                }
                return events;
            }
            return Enum<NendoTriggerEvents>(body, "events");
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
                    var aggregate = kind is NendoBindingKind.RelatedAggregate or NendoBindingKind.SubtreeAggregate
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
                        NendoBindingKind.RelatedAggregate or NendoBindingKind.SubtreeAggregate =>
                            Aggregate(element, bindingId, entityId, kind, aggregate!.Value),
                        NendoBindingKind.HierarchyPath => Path(element, bindingId, entityId),
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

        /// <summary>A path is Text and never empty; a body that states either must state it truthfully.</summary>
        private NendoBehaviourBinding Path(JsonElement element, string bindingId, string entityId)
        {
            if (element.TryGetProperty("resultType", out _) && Enum<NendoBehaviourScalar>(element, "resultType") != NendoBehaviourScalar.Text)
                throw Refuse($"{_subject} (HierarchyPath) always produces Text; leave resultType out or say Text.");
            if (element.TryGetProperty("nullable", out _) && Flag(element, "nullable"))
                throw Refuse($"{_subject} (HierarchyPath) is never empty: every record has a place. Leave nullable out or say false.");
            string? prefix = null;
            if (element.TryGetProperty("prefix", out var value))
            {
                if (value.ValueKind != JsonValueKind.String || value.GetString()!.Length > NendoBehaviourBinding.MaximumPathPrefixLength)
                    throw Refuse($"{_subject} (HierarchyPath) takes prefix as text of at most {NendoBehaviourBinding.MaximumPathPrefixLength} characters.");
                prefix = value.GetString();
            }
            return NendoBehaviourBinding.HierarchyPath(bindingId, entityId, prefix);
        }

        private NendoBehaviourBinding Aggregate(JsonElement element, string bindingId, string entityId, NendoBindingKind kind, NendoAggregateFunction aggregate)
        {
            if (aggregate != NendoAggregateFunction.Sum)
            {
                // A count's result type is not a choice, but a body that states it must
                // state it truthfully rather than be read as something it does not say.
                if (element.TryGetProperty("resultType", out _) && Enum<NendoBehaviourScalar>(element, "resultType") != NendoBehaviourScalar.Integer)
                    throw Refuse($"{_subject} ({kind} {aggregate}) always produces Integer; leave resultType out or say Integer.");
            }
            if (element.TryGetProperty("nullable", out _) && Flag(element, "nullable"))
                throw Refuse($"{_subject} ({kind} {aggregate}) is never null: an empty collection totals zero. Leave nullable out or say false.");
            if (kind == NendoBindingKind.SubtreeAggregate)
            {
                var includeSelf = element.TryGetProperty("includeSelf", out _) && Flag(element, "includeSelf");
                return WithMember(element, aggregate, aggregate switch
                {
                    NendoAggregateFunction.Count => NendoBehaviourBinding.Subtree(bindingId, entityId, aggregate, includeSelf: includeSelf),
                    NendoAggregateFunction.FilteredCount => NendoBehaviourBinding.Subtree(bindingId, entityId, aggregate,
                        Member(element, kind, aggregate), includeSelf: includeSelf),
                    NendoAggregateFunction.Sum => NendoBehaviourBinding.Subtree(bindingId, entityId, aggregate,
                        Member(element, kind, aggregate), Enum<NendoBehaviourScalar>(element, "resultType"), includeSelf),
                    _ => throw Refuse($"{_subject} has an aggregate this contract does not define."),
                });
            }
            var relatedEntityId = Text(element, "relatedEntityId");
            var relatedReferenceFieldId = Text(element, "relatedReferenceFieldId");
            var acrossSubtree = element.TryGetProperty("acrossSubtree", out _) && Flag(element, "acrossSubtree");
            return WithMember(element, aggregate, aggregate switch
            {
                NendoAggregateFunction.Count => NendoBehaviourBinding.RelatedCount(
                    bindingId, entityId, relatedEntityId, relatedReferenceFieldId, acrossSubtree),
                NendoAggregateFunction.FilteredCount => NendoBehaviourBinding.RelatedFilteredCount(
                    bindingId, entityId, relatedEntityId, relatedReferenceFieldId, Member(element, kind, aggregate), acrossSubtree),
                NendoAggregateFunction.Sum => NendoBehaviourBinding.RelatedSum(
                    bindingId, entityId, relatedEntityId, relatedReferenceFieldId,
                    Member(element, kind, aggregate), Enum<NendoBehaviourScalar>(element, "resultType"), acrossSubtree),
                _ => throw Refuse($"{_subject} has an aggregate this contract does not define."),
            });
        }

        /// <summary>
        /// The stored field a sum or filtered count reads from each member, or null when it
        /// names a calculated field instead. Exactly one of the two is named.
        /// </summary>
        private string? Member(JsonElement element, NendoBindingKind kind, NendoAggregateFunction aggregate)
        {
            var (field, calculation) = aggregate == NendoAggregateFunction.Sum
                ? ("valueFieldId", "valueCalculationId")
                : ("predicateFieldId", "predicateCalculationId");
            var hasField = element.TryGetProperty(field, out _);
            var hasCalculation = element.TryGetProperty(calculation, out _);
            if (hasField == hasCalculation)
                throw Refuse(hasField
                    ? $"{_subject} ({kind} {aggregate}) names both {field} and {calculation}; name the stored field or the calculated one, not both."
                    : $"{_subject} ({kind} {aggregate}) needs {field} — {NendoBindingShape.Purpose(field)} — or {calculation} — {NendoBindingShape.Purpose(calculation)}.");
            return hasField ? Text(element, field) : null;
        }

        private NendoBehaviourBinding WithMember(JsonElement element, NendoAggregateFunction aggregate, NendoBehaviourBinding binding)
        {
            var key = aggregate switch
            {
                NendoAggregateFunction.Sum => "valueCalculationId",
                NendoAggregateFunction.FilteredCount => "predicateCalculationId",
                _ => null,
            };
            return key is not null && element.TryGetProperty(key, out _) ? binding.WithMemberCalculation(Text(element, key)) : binding;
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

        /// <summary>
        /// A list a body may leave out when it has nothing in it: an author who has no
        /// bindings should not have to send an empty list to be told it was missing.
        /// </summary>
        private static readonly JsonElement EmptyList = JsonDocument.Parse("[]").RootElement.Clone();

        private JsonElement.ArrayEnumerator Array(JsonElement element, string property)
        {
            if (!element.TryGetProperty(property, out var value)) return EmptyList.EnumerateArray();
            if (value.ValueKind != JsonValueKind.Array)
                throw Refuse($"{_subject} needs {property} as a list.");
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
