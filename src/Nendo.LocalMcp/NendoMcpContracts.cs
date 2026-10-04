using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Microsoft.Extensions.AI;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal static class NendoMcpJson
{
    internal static JsonSerializerOptions Options { get; } = CreateOptions();

    /// <summary>
    /// How tool input schemas are generated. Every node a tool advertises carries a
    /// type: the two argument types in <see cref="NendoJsonInputs"/> bind any JSON and
    /// say what they accept, where a bare <see cref="JsonElement"/> said nothing.
    /// </summary>
    internal static AIJsonSchemaCreateOptions ToolSchemaOptions { get; } = new()
    {
        TransformSchemaNode = NendoJsonInputs.Advertise,
    };

    /// <summary>
    /// Serialization for tool results. The schema generated from a return type
    /// lists every declared member in <c>required</c>, including the nullable
    /// ones, so a payload that drops a null member fails validation in any client
    /// that checks the schema the tool itself advertises. Emitting the null keeps
    /// the payload total, and says "no expiry" rather than saying nothing.
    /// </summary>
    internal static JsonSerializerOptions ToolOptions { get; } = CreateToolOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DictionaryKeyPolicy = null,
            WriteIndented = false,
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }

    private static JsonSerializerOptions CreateToolOptions()
    {
        // The SDK freezes whatever options it is handed, which needs an explicit
        // resolver. This is the resolver Options already materializes lazily, so
        // tool results and resource payloads stay one serialization behaviour.
        return new JsonSerializerOptions(Options)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
        };
    }
}

public sealed record NendoMcpManifest(
    string FormatIdentifier,
    long FormatVersion,
    string MinimumHostVersion,
    string ApplicationId,
    string InstanceId,
    DateTimeOffset CreatedAt,
    DateTimeOffset ModifiedAt,
    long DefinitionRevision,
    long DataRevision,
    long ChangeSequence)
{
    /// <summary>What this file is for, in the author's words, or null if nobody has said.</summary>
    public string? Purpose { get; init; }

    /// <summary>
    /// How a person tells this file from others open beside it: the tone and the letter of the
    /// badge its icons carry, whether the file chose them or has them by default.
    /// </summary>
    public NendoMcpLook? Look { get; init; }

    /// <summary>
    /// The application's own name for one new file of it, such as "Archi model" (ADR-0022), or
    /// null when it gave none; the File menu then offers "New empty copy…".
    /// </summary>
    public string? NewFileLabel { get; init; }
}

/// <summary>A file's look as it is drawn, and which parts the file chose rather than has by default.</summary>
public sealed record NendoMcpLook(string Tone, string Letter, bool ToneChosen, bool LetterChosen);

public sealed record NendoMcpEntity(string EntityId, string DisplayName) { public bool Retired { get; init; } }

public sealed record NendoMcpEntitySchema(
    string EntityId,
    string DisplayName,
    IReadOnlyList<NendoMcpField> Fields)
{
    public bool Retired { get; init; }

    /// <summary>How many records the type holds now; null where the read did not count (W-146).</summary>
    public long? RecordCount { get; init; }

    /// <summary>
    /// Calculated fields this record type shows. Kept apart from
    /// <see cref="Fields"/> because nothing writes to one: they have no column, and
    /// a mutation naming one is refused.
    /// </summary>
    public IReadOnlyList<NendoMcpDerivedField> DerivedFields { get; init; } = [];

    /// <summary>
    /// The record type's declared hierarchy (ADR-0019): the self-reference that names each
    /// record's parent and, if declared, the Integer field that orders siblings. Null when
    /// the record type declares none.
    /// </summary>
    public NendoHierarchy? Hierarchy { get; init; }

    /// <summary>
    /// Whether a new file of this application keeps this type's records unless a record says
    /// otherwise (ADR-0022). False, the default, leaves them out.
    /// </summary>
    public bool KeptInNewFiles { get; init; }
}

/// <summary>One calculated field, with the formula that produces it.</summary>
public sealed record NendoMcpDerivedField(
    string FieldId,
    string DisplayName,
    string CalculationId,
    NendoBehaviourScalar ResultType,
    bool ResultNullable,
    string Expression);

/// <summary>
/// One record's calculated result.
/// <para>
/// Deliberately not merged into a record's values. A result may be a value, empty,
/// still being worked out or an error, and presenting one as a stored value would put
/// a number in front of a reader that no formula produced. <see cref="NumericLexeme"/>
/// carries the exact digits for the same reason stored numbers do.
/// </para>
/// </summary>
public sealed record NendoMcpCalculation(
    string CalculationId,
    string FieldId,
    NendoCalculationState State,
    NendoBehaviourScalar ResultType,
    JsonElement Value,
    string? ErrorCode,
    string? ErrorMessage)
{
    public string? NumericLexeme => Value.ValueKind == JsonValueKind.Number ? Value.GetRawText() : null;
}

public sealed record NendoMcpField(
    string FieldId,
    string DisplayName,
    NendoStorageKind StorageKind,
    bool Required,
    string? Presentation,
    IReadOnlyList<string> Options)
{
    public NendoReferenceDefinition? Reference { get; init; }
    public IReadOnlyList<NendoChoiceOption> Choices { get; init; } = [];
    public NendoRatingScale? Scale { get; init; }
    public bool Retired { get; init; }

    /// <summary>Whether no two records may hold equal values in this field (ADR-0020).</summary>
    public bool Unique { get; init; }

    /// <summary>The prefix and width the host numbers new records with (ADR-0020), or null.</summary>
    public NendoFieldSequence? Sequence { get; init; }
}

public sealed record NendoMcpRecord(
    string EntityId,
    string RecordId,
    long RecordVersion,
    IReadOnlyDictionary<string, JsonElement> Values)
{
    public IReadOnlyDictionary<string, string?> ReferenceLabels { get; init; } = new Dictionary<string, string?>();

    /// <summary>This record's calculated fields, in dependency order.</summary>
    public IReadOnlyList<NendoMcpCalculation> Calculations { get; init; } = [];

    /// <summary>
    /// This record's own say in whether a new file keeps it (ADR-0022). Absent when it follows
    /// its record type's keptInNewFiles.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? KeptInNewFiles { get; init; }

    // Additive exact projection; existing clients retain the original scalar values.
    public IReadOnlyDictionary<string, string> NumericLexemes => Values
        .Where(pair => pair.Value.ValueKind == JsonValueKind.Number)
        .ToDictionary(pair => pair.Key, pair => pair.Value.GetRawText(), StringComparer.Ordinal);
}

public sealed record NendoMcpPage<T>(IReadOnlyList<T> Items, string? NextCursor);

/// <summary>
/// One exact aggregate (W-146). <c>Shape</c> says which sections are filled: <c>whole</c> fills
/// <c>value</c> and <c>contributingRecords</c>; <c>grouped</c> fills <c>groups</c>; <c>cells</c>
/// fills the keys and <c>cells</c>; <c>buckets</c> fills the resolved bounds and <c>buckets</c>.
/// Every number is an invariant lexeme, and an empty set is null rather than zero.
/// </summary>
public sealed record NendoMcpAggregate(
    string EntityId,
    string Aggregate,
    string? FieldId,
    string Shape,
    long ChangeSequence)
{
    public string? Value { get; init; }
    public long? ContributingRecords { get; init; }
    public string? GroupByFieldId { get; init; }
    public IReadOnlyList<NendoMcpAggregateGroup>? Groups { get; init; }
    public string? RowByFieldId { get; init; }
    public string? ColumnByFieldId { get; init; }
    public IReadOnlyList<string>? RowKeys { get; init; }
    public IReadOnlyList<string>? ColumnKeys { get; init; }
    public IReadOnlyList<NendoMcpAggregateCell>? Cells { get; init; }
    public string? DateFieldId { get; init; }
    public string? Bucket { get; init; }
    public string? Range { get; init; }
    public string? Start { get; init; }
    public string? End { get; init; }
    public IReadOnlyList<NendoMcpAggregateGroup>? Buckets { get; init; }
    /// <summary>Records whose stored value is none of the configured groups; never folded into one.</summary>
    public long? Unrecognised { get; init; }
}

/// <summary>One group or bucket: its key (a choice ID, true, false, a bucket start, or null for unset), its exact value and how many records contributed.</summary>
public sealed record NendoMcpAggregateGroup(string? Key, string? Value, long ContributingRecords);

/// <summary>One cell of a grid aggregate.</summary>
public sealed record NendoMcpAggregateCell(string? RowKey, string? ColumnKey, string? Value, long ContributingRecords);

/// <summary>One record of a tree window (ADR-0019): its parent, its depth below the window's root and its child count.</summary>
public sealed record NendoMcpTreeNode(NendoMcpRecord Record, string? ParentRecordId, int Depth, int ChildCount);

public sealed record NendoMcpDiagnostic(
    string Code,
    NendoDiagnosticSeverity Severity,
    string Message,
    string? SemanticId,
    string? PropertyPath,
    string Hint);

/// <summary>
/// One compiled surface node. Surfaces compose as a tree, so a file describes
/// itself through <see cref="NendoMcpSurfaces"/> as ordered roots and children.
/// <para>
/// The identifiers are the node IDs the author supplied. <c>commandId</c> is
/// present on a <c>recordCommand</c> root and is the value
/// <c>nendo.data.execute_command</c> takes; it is the node ID, stated rather
/// than left to be guessed. A stored <c>surfaceId</c> is deliberately absent: it
/// is not part of the compiled plan, and the plan is what the file's definition
/// digest is taken over.
/// </para>
/// </summary>
public sealed record NendoMcpSurfaceNode(
    string NodeId,
    string Kind,
    IReadOnlyDictionary<string, JsonElement> Properties,
    IReadOnlyList<NendoMcpSurfaceNode> Children)
{
    public string? Title { get; init; }
    public string? EntityId { get; init; }
    public string? CommandId { get; init; }
}

/// <summary>
/// <paramref name="State"/> separates the three cases a bare
/// <paramref name="IsValid"/> flag collapses: <c>valid</c>, <c>invalid</c> with
/// diagnostics, and <c>noCustomSurfaces</c> for a file that declares none — which
/// is a deliberate shape, not a malformed definition, and previously read as
/// invalid with nothing to explain it.
/// </summary>
public sealed record NendoMcpSurfaces(
    bool IsValid,
    string State,
    int? ContractVersion,
    IReadOnlyList<NendoMcpDiagnostic> Diagnostics)
{
    public IReadOnlyList<NendoMcpApplicationSurfaces> Applications { get; init; } = [];

    /// <summary>
    /// The file's front page, when it has one. It is not one of the applications
    /// because it belongs to the file rather than to a record type: an agent that
    /// authored one and looked for it among the record types would not find it.
    /// </summary>
    public NendoMcpSurfaceNode? Overview { get; init; }

    /// <summary>
    /// The file's own custom views (extensionView), in authored order. Like the front page they
    /// belong to the file, so they are not among the applications either.
    /// </summary>
    public IReadOnlyList<NendoMcpSurfaceNode> Views { get; init; } = [];
}

public sealed record NendoMcpApplicationSurfaces(string EntityId, string DisplayName)
{
    /// <summary>This entity's surface roots, in declared order.</summary>
    public IReadOnlyList<NendoMcpSurfaceNode> Surfaces { get; init; } = [];
}

/// <summary>
/// Everything an authoring client needs to plan, in one read: identity and
/// revisions, the bounds it must batch against, every record type with its fields
/// and references, and every compiled screen. The same reconnaissance previously
/// cost one read per record type plus a surfaces read that could not describe a
/// contract version 3 application at all.
/// </summary>
/// <summary>
/// The whole open application in one read.
/// <para>
/// <c>Purpose</c> is first because member order here is the order the payload serializes in,
/// and an agent reading a file it has never seen should be told what the file is for before
/// it is handed revisions, limits and a schema to infer purpose from. It is null for a file
/// whose author has not said, which is a fact about the file rather than a gap to fill.
/// </para>
/// </summary>
public sealed record NendoMcpDescription(
    string? Purpose,
    NendoMcpManifest Manifest,
    NendoAuthoringLimits Limits,
    IReadOnlyList<NendoMcpEntitySchema> Entities,
    NendoMcpSurfaces Surfaces,
    NendoMcpHealth Health)
{
    /// <summary>
    /// Every resource URI this host serves, including the templated ones.
    /// <c>resources/list</c> returns only the parameterless resources, so reading
    /// a record back — <c>nendo://application/entity/{entityId}/records</c> — was
    /// discoverable only through <c>resources/templates/list</c>. It is named here
    /// so one read answers "how do I read this file".
    /// </summary>
    public IReadOnlyList<NendoMcpRead> Reads { get; init; } = [];

    /// <summary>The custom-view packages the file carries, with their files but not their bytes.</summary>
    public IReadOnlyList<NendoMcpExtensionPackage> Extensions { get; init; } = [];

    /// <summary>What a new file of this application would keep now (ADR-0022).</summary>
    public NendoMcpNewFile? NewFile { get; init; }
}

/// <summary>
/// What a new file of this application keeps (ADR-0022): per record type, how many records it
/// would keep and leave out, and every kept record that points at one left out, which stops
/// one being made. Only the person makes a new file, from Nendo's File menu.
/// </summary>
public sealed record NendoMcpNewFile(
    string MenuLabel,
    IReadOnlyList<NendoNewFileTypeCount> Types,
    long ConflictCount,
    IReadOnlyList<NendoNewFileConflict> Conflicts);

/// <summary>A custom-view package in the file, as nendo://application/extensions lists it.</summary>
public sealed record NendoMcpExtensionPackage(
    string PackageId,
    string Title,
    string? Version,
    string EntryPoint,
    string? Description,
    long TotalBytes,
    IReadOnlyList<NendoMcpExtensionFile> Files);

/// <summary>One file of a package: where it is, what it is and which bytes.</summary>
public sealed record NendoMcpExtensionFile(string Path, string MediaType, string Sha256, long ByteLength);

/// <summary>
/// One page of a package file. Exactly one of <paramref name="Text"/> and <paramref name="Base64"/>
/// is set; <paramref name="Sha256"/> and <paramref name="ByteLength"/> describe the whole file.
/// </summary>
public sealed record NendoMcpExtensionFileContent(
    string PackageId,
    string Path,
    string MediaType,
    string Sha256,
    long ByteLength,
    long Offset,
    long Length,
    long? NextOffset,
    string? Text,
    string? Base64);

public sealed record NendoMcpOperation(
    string OperationType,
    NendoReversibilityClass Reversibility,
    IReadOnlyList<string> AffectedSemanticIds);

public sealed record NendoMcpRevision(
    string RevisionId,
    DateTimeOffset CreatedAt,
    string Origin,
    string Description,
    NendoRevisionLane Lane,
    long DefinitionRevisionBefore,
    long DefinitionRevisionAfter,
    long DataRevisionBefore,
    long DataRevisionAfter,
    long ChangeSequence,
    string OperationDigest,
    string? ProposalId,
    string? ProposalDigest,
    string? CompensationOfRevisionId,
    long OperationCount,
    string OperationsUri);

/// <summary>
/// <paramref name="IntegrityResult"/> is the result of the last scan, which is not
/// necessarily a statement about the file now: reading health never rescans.
/// <see cref="ChangesSinceIntegrityCheck"/> and <see cref="IntegrityStale"/> say how
/// far the file has moved since, so "ok" measured 32 changes ago cannot be read as
/// "ok" measured now. <c>nendo.health.verify_integrity</c> requests a fresh scan.
/// </summary>
public sealed record NendoMcpHealth(
    [property: Description("normal, recoveryRequired, closed or readOnly. Anything but normal refuses writes.")]
    NendoSessionHealth State,
    [property: Description("ok, or what the last integrity scan found. It describes the file at integrityChangeSequence, not necessarily now.")]
    string IntegrityResult,
    [property: Description("How the file is kept durable: local-coordinated-durable-file, one local file with coordinated writes.")]
    string DurabilityProfile)
{
    [Description("When the last integrity scan ran, or null if none has.")]
    public DateTimeOffset? IntegrityCheckedAt { get; init; }

    [Description("The change sequence the last integrity scan measured.")]
    public long? IntegrityChangeSequence { get; init; }

    /// <summary>The file's change sequence when this health was read.</summary>
    [Description("The file's change sequence when this health was read.")]
    public long? ChangeSequence { get; init; }

    /// <summary>
    /// How many committed changes the file has taken since the integrity result
    /// was measured. Zero means the result describes the file as it stands.
    /// </summary>
    [Description("Committed changes since the integrity result was measured. Zero means it describes the file as it stands.")]
    public long? ChangesSinceIntegrityCheck => ChangeSequence is { } current && IntegrityChangeSequence is { } checkedAt
        ? Math.Max(0, current - checkedAt)
        : null;

    /// <summary>True when the file has changed since the integrity result was measured.</summary>
    [Description("True when the file has changed since the integrity result was measured. nendo.health.verify_integrity measures it now.")]
    public bool IntegrityStale => ChangesSinceIntegrityCheck is > 0;
}

/// <summary>
/// The outcome of an explicitly requested integrity scan. <paramref name="Rescanned"/>
/// is false when the file has not changed since the last scan, in which case the
/// recorded result already describes the file as it stands and no scan was run.
/// </summary>
public sealed record NendoMcpIntegrityCheck(
    [property: Description("False when the file had not changed since the last scan, so the recorded result already describes it and no scan ran.")]
    bool Rescanned,
    [property: Description("What was measured, in a sentence.")]
    string Message,
    [property: Description("The file's health as measured now.")]
    NendoMcpHealth Health);

/// <summary>
/// One page of a record type written as faithful Nendo CSV.
/// </summary>
/// <param name="Csv">
/// The rows themselves, CRLF-terminated. The header row is present on the first page and
/// on no other, so the pages concatenate into one valid document in the order they are
/// read.
/// </param>
/// <param name="FieldIds">
/// The stable field ID behind each column, in column order. The header carries display
/// names, which are what a person reads and not what an import maps by.
/// </param>
public sealed record NendoMcpCsvPage(
    string EntityId,
    string Csv,
    int RecordCount,
    IReadOnlyList<string> FieldIds,
    string? NextCursor);
