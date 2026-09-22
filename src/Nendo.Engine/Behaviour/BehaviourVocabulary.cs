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
                "predicateFieldId"),
            new("Sum", "integer or decimal, matching the field named by valueFieldId",
                "An empty collection totals zero.",
                "A member with no value, or one that cannot be calculated, makes the whole total an error. A partial total of what could be read is never returned.",
                "valueFieldId"),
        ],
        // The same table the codec refuses against, so a key that is published is a
        // key that is accepted, and one that is accepted is published.
        [.. NendoBindingShape.All.Select(shape => new NendoBehaviourBindingDescription(
            shape.Kind.ToString(),
            shape.Aggregate?.ToString(),
            shape.RequiredKeys,
            shape.OptionalKeys,
            shape.Summary))],
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
