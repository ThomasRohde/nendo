using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nendo.Engine;

public enum NendoDiagnosticSeverity
{
    Error,
    Warning,
}

public sealed record NendoCompilerDiagnostic(
    string Code,
    NendoDiagnosticSeverity Severity,
    string Message,
    string? SemanticId,
    string? PropertyPath,
    string Hint);

public sealed record NendoCompileResult(
    bool IsValid,
    IReadOnlyList<NendoCompilerDiagnostic> Diagnostics)
{
    public long? SourceChangeSequence { get; init; }
    public IReadOnlyList<NendoApplicationPlan> Applications { get; init; } = [];

    /// <summary>
    /// The file's front page, when it has one. Separate from
    /// <see cref="Applications"/> because it belongs to the file rather than to a
    /// record type: giving it an <see cref="NendoEntityPlan"/> would mean inventing
    /// an entity that nothing stores, and every consumer would then have to know
    /// which of the plans was the pretend one.
    /// </summary>
    public NendoOverviewPlan? Overview { get; init; }
}

/// <summary>
/// The compiled front page: one node tree with no record type of its own. Each
/// tile, chart and recent list inside it names the type it reads, so the records
/// travel with the entity plans rather than with this one.
/// </summary>
/// <param name="Entities">
/// The record types the front page names, with their fields. They travel here
/// rather than being looked up among the application plans, because a type can be
/// read by a tile without owning a surface of its own — and a chart over it still
/// has to label its groups and tone them.
/// </param>
public sealed record NendoOverviewPlan(
    int ContractVersion,
    string ApplicationId,
    long DefinitionRevision,
    NendoSurfaceNodePlan Surface,
    IReadOnlyList<NendoEntityPlan> Entities);

/// <summary>
/// One compiled node. Children are ordered by declared position; the kind and its
/// permitted properties and children come from <see cref="NendoSemanticVocabulary"/>.
/// </summary>
public sealed record NendoSurfaceNodePlan(
    string SemanticId,
    string AutomationTarget,
    string Kind,
    IReadOnlyDictionary<string, JsonElement> Properties,
    IReadOnlyList<NendoSurfaceNodePlan> Children);

/// <summary>
/// One entity's compiled surfaces as an ordered node tree. Contract versions 1
/// and 2 held fixed form/list/board/command slots beside this and were removed
/// before the format had users; the tree is the only shape a host compiles.
/// </summary>
public sealed record NendoApplicationPlan(
    int ContractVersion,
    string ApplicationId,
    long DefinitionRevision,
    long DataRevision,
    string Digest,
    NendoEntityPlan Entity,
    IReadOnlyList<NendoSurfaceNodePlan> Surfaces,
    IReadOnlyList<NendoRecordPlan> Records);

public sealed record NendoEntityPlan(
    string SemanticId,
    string AutomationTarget,
    string DisplayName,
    IReadOnlyList<NendoFieldPlan> Fields)
{
    /// <summary>
    /// The calculated fields this record type shows. Separate from
    /// <see cref="Fields"/> because a surface must not offer an editor for one: there
    /// is no column behind it to write to.
    /// </summary>
    public IReadOnlyList<NendoDerivedFieldPlan> DerivedFields { get; init; } = [];
}

/// <summary>A field a surface can show but nobody can type into.</summary>
public sealed record NendoDerivedFieldPlan(
    string SemanticId,
    string AutomationTarget,
    string DisplayName,
    NendoBehaviourScalar ResultType,
    bool ResultNullable,
    string CalculationId,
    string Expression);

public sealed record NendoFieldPlan(
    string SemanticId,
    string AutomationTarget,
    string DisplayName,
    NendoStorageKind StorageKind,
    bool Required,
    string? Presentation,
    IReadOnlyList<string> Options)
{
    public IReadOnlyList<NendoChoiceOption> Choices { get; init; } = [];
    public NendoRatingScale? Scale { get; init; }

    /// <summary>
    /// Where a Reference field points, and which of the target's fields labels it. Null
    /// for every other kind, and for a reference nobody has bound yet.
    /// <para>
    /// A renderer needs this to draw a board grouped by the field (ADR-0004, 2026-09-17
    /// amendment, S7): the columns are records of the target type, and their headings are
    /// that label. It is on the plan rather than fetched separately because a surface that
    /// had to ask a second question to know what its own columns are would draw once
    /// without them.
    /// </para>
    /// </summary>
    public NendoReferenceDefinition? Reference { get; init; }
}

public sealed record NendoRecordPlan(
    string SemanticId,
    string AutomationTarget,
    long Version,
    IReadOnlyDictionary<string, JsonElement> Values)
{
    public IReadOnlyDictionary<string, string?> ReferenceLabels { get; init; } = new Dictionary<string, string?>();

    /// <summary>
    /// This record's calculated results, keyed by derived field ID. Kept out of
    /// <see cref="Values"/> so nothing can mistake one for a stored value: a result
    /// may be a value, empty, still loading or an error, and only the first of those
    /// is a value at all.
    /// </summary>
    public IReadOnlyDictionary<string, NendoCalculationResult> Calculations { get; init; } =
        new Dictionary<string, NendoCalculationResult>();
}

public static class NendoRenderPlanJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    internal static string SerializeForDigest(NendoComposableApplicationPlanPayload payload) =>
        JsonSerializer.Serialize(payload, Options);

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = null,
            WriteIndented = false,
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }
}

/// <summary>
/// The explicit digest projection. A digest is taken over this projection and
/// never over the plan record itself, so the value cannot move when an unrelated
/// field is added to <see cref="NendoApplicationPlan"/>. Node order is meaningful
/// because it is position.
/// </summary>
internal sealed record NendoComposableApplicationPlanPayload(
    int ContractVersion,
    string ApplicationId,
    long DefinitionRevision,
    long DataRevision,
    NendoEntityPlan Entity,
    IReadOnlyList<NendoSurfaceNodePlan> Surfaces,
    IReadOnlyList<NendoRecordPlan> Records)
{
    internal static NendoComposableApplicationPlanPayload From(NendoApplicationPlan plan) => new(
        plan.ContractVersion,
        plan.ApplicationId,
        plan.DefinitionRevision,
        plan.DataRevision,
        plan.Entity,
        plan.Surfaces,
        plan.Records);
}
