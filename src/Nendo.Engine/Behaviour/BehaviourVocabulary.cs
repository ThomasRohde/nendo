namespace Nendo.Engine;

/// <summary>
/// One function a formula may call, as published.
/// <para>
/// Generated from the closed catalogue the analyzer validates against, so a
/// documented function is a callable function and a callable one is documented.
/// </para>
/// </summary>
/// <param name="ParameterTypes">
/// What each argument accepts, in order, named the way a refusal names it.
/// <c>decimal|integer</c> means either. When <paramref name="Repeating"/> is true the
/// last entry repeats up to <paramref name="MaximumArguments"/>.
/// </param>
public sealed record NendoBehaviourFunctionDescription(
    string Name,
    int MinimumArguments,
    int MaximumArguments,
    IReadOnlyList<string> ParameterTypes,
    bool Repeating,
    string ResultType,
    string Summary);

/// <summary>One bounded aggregate over a related collection, and what it does at the edges.</summary>
/// <param name="FieldKey">
/// The binding key that names the field this aggregate works over — <c>valueFieldId</c>
/// for a sum, <c>predicateFieldId</c> for a filtered count — or null when it takes none.
/// </param>
public sealed record NendoBehaviourAggregateDescription(
    string Aggregate,
    string ResultType,
    string EmptyRule,
    string MissingValueRule,
    string? FieldKey);

/// <summary>
/// One way a formula may reach a value, and the keys it takes to do so. A
/// <c>RelatedAggregate</c> is published once per aggregate, because the keys differ.
/// </summary>
public sealed record NendoBehaviourBindingDescription(
    string Kind,
    string? Aggregate,
    IReadOnlyList<string> RequiredFields,
    IReadOnlyList<string> OptionalFields,
    string Summary);

/// <summary>
/// One kind of record an action step may write to, and what it selects at the edges.
/// An outside review created a record whose target reference was empty, expected a
/// refusal, and got a committed write that reported no effect; the catalogue named
/// the step kinds and never the targets, so nothing had said that was the rule.
/// </summary>
public sealed record NendoBehaviourActionTargetDescription(
    string Kind,
    string Summary);

/// <summary>
/// One object of a definition body: the keys it takes, which of them it needs, and, for the
/// four bodies a <c>behaviour.setDefinition</c> sends, a body the codec accepts as it stands.
/// <para>
/// The codec refuses every key not listed here, so the table is the contract rather than a
/// description of it. An agent building a studio manager on 2026-10-10 learnt the action,
/// assignment and trigger shapes by sending made-up keys and reading the refusals, six refusals
/// in two minutes; ADR-0008 says no author discovers the contract by failing.
/// </para>
/// </summary>
public sealed record NendoBehaviourBodyShape(
    string Name,
    IReadOnlyList<string> RequiredKeys,
    IReadOnlyList<string> OptionalKeys,
    string Summary,
    string? Example = null)
{
    public static IReadOnlyList<NendoBehaviourBodyShape> All { get; } =
    [
        new("Calculation body", ["entityId", "fieldId", "displayName", "resultType", "resultNullable", "expression"], ["bindings", "callAliases"],
            "A calculated field of entityId. fieldId is the new field's own stable ID, never a stored field's. expression names " +
            "each value by a binding's bindingId; resultNullable says whether the field may be empty. bindings and callAliases " +
            "are lists and may be left out when empty.",
            """{"entityId":"invoiceLine","fieldId":"invoiceLineTotal","displayName":"Line total","resultType":"Decimal","resultNullable":false,"expression":"quantity * unitPrice","bindings":[{"bindingId":"quantity","kind":"SameRecordField","entityId":"invoiceLine","fieldId":"invoiceLineQuantity","resultType":"Decimal","nullable":false},{"bindingId":"unitPrice","kind":"SameRecordField","entityId":"invoiceLine","fieldId":"invoiceLineUnitPrice","resultType":"Decimal","nullable":false}]}"""),
        new("Function body", ["displayName", "resultType", "resultNullable", "expression"], ["parameters", "callAliases"],
            "A reusable pure function. Its parameters are named in expression by parameterId and bound by position at a call.",
            """{"displayName":"With tax","resultType":"Decimal","resultNullable":false,"expression":"amount * 1.25","parameters":[{"parameterId":"amount","displayName":"Amount","parameterType":"Decimal","nullable":false}]}"""),
        new("Action body", ["displayName", "steps"], [],
            "Ordered steps that write records. An action names no record type; the trigger that runs it does.",
            """{"displayName":"Create the kickoff task","steps":[{"stepId":"kickoff","kind":"CreateRecord","entityId":"task","assignments":[{"fieldId":"taskTitle","expression":"'Kickoff call'"}],"links":[{"fieldId":"taskProject","target":{"kind":"EventRecord"}}]}]}"""),
        new("Trigger body", ["entityId", "displayName", "events", "actionId"], ["relevantFieldIds", "conditionExpression", "conditionBindings", "callAliases"],
            "Runs actionId when a record of entityId is Created, Updated or Deleted. events is a list of those names, or text " +
            "such as \"Created, Updated\". relevantFieldIds narrows an update to changes of those fields. conditionExpression, " +
            "when given, must be true for the action to run; its values come from conditionBindings.",
            """{"entityId":"project","displayName":"When a project is created","events":["Created"],"actionId":"projectKickoff"}"""),
        new("step", ["stepId", "kind"], ["target", "entityId", "assignments", "links"],
            "SetField writes assignments to target; DeleteRecord deletes target and takes no assignments; CreateRecord adds a " +
            "record of entityId with its assignments and links, and takes no target."),
        new("assignment", ["fieldId", "expression"], ["bindings", "callAliases"],
            "One stored field and the formula that produces its value. A SetField assignment's bindings start from the record " +
            "the step writes; a CreateRecord assignment's from the record that raised the event. A formula produces no " +
            "reference; a create step sets one with a link."),
        new("link", ["fieldId", "target"], [],
            "A reference field of the record a CreateRecord step adds, set to target: EventRecord, the record that raised " +
            "the event, or ReferencedRecord, the record its referenceFieldId names. The field must be a reference to that " +
            "record's type. EventRecord cannot be linked from a Deleted event; an empty referenced field leaves the link empty."),
        new("target", ["kind"], ["referenceFieldId"],
            "EventRecord, or ReferencedRecord with the referenceFieldId of the event record to follow."),
        new("parameter", ["parameterId", "displayName", "parameterType", "nullable"], [],
            "One typed parameter of a function, in call order."),
        new("call alias", ["alias", "functionId"], [],
            "The name a formula calls a reusable function by, and the function's definition ID."),
    ];

    /// <summary>Every key the named object accepts, required ones first.</summary>
    public IReadOnlyList<string> Keys => [.. RequiredKeys, .. OptionalKeys];

    internal static string[] KeysOf(string name) => [.. All.Single(shape => shape.Name == name).Keys];
}

/// <summary>The finite ceilings a formula runs under. Host-owned; no file raises them.</summary>
public sealed record NendoBehaviourLimitsDescription(
    int SourceLength,
    int SyntaxItems,
    int AstNodes,
    int ParseDepth,
    int AstDepth,
    int GraphDepth,
    int CatalogueSize,
    int Definitions,
    int Parameters,
    int IdentifierLength,
    int WorkUnits,
    int FunctionCalls,
    int TextLength,
    int CacheEntries,
    int RelatedRows,
    int GeneratedChanges);

/// <summary>
/// Everything an authoring client needs to write a calculation, a reusable function,
/// an action or a trigger, without probing.
/// <para>
/// It is one catalogue, produced from the tables the Engine already enforces: the
/// function set, the operator allow-list, the scalar domain, the binding kinds, the
/// aggregate rules and the limits. There is no second MCP-only copy to drift from it.
/// </para>
/// </summary>
public sealed record NendoBehaviourDescription(
    string ContractVersion,
    IReadOnlyList<string> Scalars,
    IReadOnlyList<string> Operators,
    IReadOnlyList<NendoBehaviourFunctionDescription> Functions,
    IReadOnlyList<NendoBehaviourAggregateDescription> Aggregates,
    IReadOnlyList<NendoBehaviourBindingDescription> Bindings,
    IReadOnlyList<NendoBehaviourBodyShape> Bodies,
    IReadOnlyList<string> TriggerEvents,
    IReadOnlyList<string> ActionSteps,
    IReadOnlyList<NendoBehaviourActionTargetDescription> ActionTargets,
    IReadOnlyList<string> Capabilities,
    NendoBehaviourLimitsDescription Limits,
    string Note);

/// <summary>The published behaviour catalogue, generated from what the Engine enforces.</summary>
public static class NendoBehaviourVocabulary
{
    public static NendoBehaviourDescription Description() => new(
        NendoBehaviourContract.Version,
        [.. Enum.GetNames<NendoBehaviourScalar>().OrderBy(name => name, StringComparer.Ordinal)],
        // Written as they appear in a formula rather than as parser node names: the
        // client types these characters, it does not type "GreaterOrEqual".
        ["and", "or", "not", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "?:"],
        NendoBehaviourCatalogue.Describe(),
        [
            new("Count", "integer",
                "An empty collection counts zero. Zero is an answer, not a missing one.",
                "Nothing is skipped: a member with no value is still a member.",
                null),
            new("FilteredCount", "integer",
                "An empty collection counts zero.",
                "A predicate that is empty or cannot be calculated makes the whole count an error, rather than quietly counting it as false.",
                "predicateFieldId or predicateCalculationId"),
            new("Sum", "integer or decimal, matching what valueFieldId or valueCalculationId names",
                "An empty collection totals zero.",
                "A member with no value, or one that cannot be calculated, makes the whole total an error. A partial total of what could be read is never returned.",
                "valueFieldId or valueCalculationId"),
        ],
        // The same table the codec refuses against, so a key that is published is a
        // key that is accepted, and one that is accepted is published.
        [.. NendoBindingShape.All.Select(shape => new NendoBehaviourBindingDescription(
            shape.Kind.ToString(),
            shape.Aggregate?.ToString(),
            shape.RequiredKeys,
            shape.OptionalKeys,
            shape.Summary))],
        NendoBehaviourBodyShape.All,
        [.. Enum.GetNames<NendoTriggerEvents>().Where(name => name != "None").OrderBy(name => name, StringComparer.Ordinal)],
        [.. Enum.GetNames<NendoActionStepKind>().OrderBy(name => name, StringComparer.Ordinal)],
        [.. Enum.GetNames<NendoActionTargetKind>().OrderBy(name => name, StringComparer.Ordinal)
            .Select(kind => new NendoBehaviourActionTargetDescription(kind, ActionTargetSummary(kind)))],
        [.. Enum.GetNames<NendoBehaviourCapabilities>().Where(name => name != "None").OrderBy(name => name, StringComparer.Ordinal)],
        Describe(NendoBehaviourLimits.Default),
        "Calculations read; actions write only through the same typed record operations a person's edit uses. " +
        "There is no clock, no file, no network and no host service reachable from a formula, and the function " +
        "set above is closed: a name that is not in it is refused rather than resolved.");

    // The rule the planner applies, stated where an author reads. A target that selects
    // no record is not an error: the step writes nothing, the save still commits, and
    // the write result's alsoChanged carries nothing for it.
    private static string ActionTargetSummary(string kind) => kind switch
    {
        nameof(NendoActionTargetKind.EventRecord) =>
            "The record the event is about. A deleted event leaves no record to write, so a SetField or DeleteRecord step " +
            "against it selects nothing and the save commits without it.",
        nameof(NendoActionTargetKind.ReferencedRecord) =>
            "The record named by referenceFieldId on the event record, resolved from both the before and the after state " +
            "of the event, so a reassignment reaches the record it left as well as the one it joined. An empty reference " +
            "names no record: the step writes nothing, the save still commits, and alsoChanged carries nothing for it. " +
            "Make the reference field required if the action must always have a target.",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "An action target kind this catalogue does not describe."),
    };

    private static NendoBehaviourLimitsDescription Describe(NendoBehaviourLimits limits) => new(
        limits.SourceLength, limits.SyntaxItems, limits.AstNodes, limits.ParseDepth, limits.AstDepth,
        limits.GraphDepth, limits.CatalogueSize, limits.Definitions, limits.Parameters, limits.IdentifierLength, limits.WorkUnits,
        limits.FunctionCalls, limits.TextLength, limits.CacheEntries, limits.RelatedRows, limits.GeneratedChanges);
}
