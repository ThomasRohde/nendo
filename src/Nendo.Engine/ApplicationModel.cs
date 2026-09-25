using System.Text.Json;

namespace Nendo.Engine;

public sealed record NendoDeleteRecordRequest(string EntityId, string RecordId, long ExpectedRecordVersion, NendoRequestContext Context);

public enum NendoStorageKind
{
    Text,
    Integer,
    Decimal,
    Boolean,
    Date,
    DateTime,
    Uuid,
    Reference,
    Unsupported,
}

public enum NendoRevisionLane
{
    Genesis,
    Definition,
    Data,
}

public enum NendoReversibilityClass
{
    Reversible,
    ReversibleWithRetainedState,
    IrreversibleDeclared,
}

public enum NendoSessionHealth
{
    Normal,
    RecoveryRequired,
    Closed,
    ReadOnly,
}

public sealed record NendoManifestSnapshot(
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
    /// <summary>
    /// What this file is for, in the author's words, or null when nobody has said.
    /// <para>
    /// The file's own, not the front page's: an <c>overviewSurface</c> carries a
    /// <c>description</c> drawn under its title, and a file with no front page has nowhere
    /// to put one. This is the sentence a person reads in the file's details and the first
    /// thing <c>nendo://application/describe</c> hands an agent. Prose the author writes:
    /// never markup, never a template, never derived from the file name, and absent rather
    /// than invented when it has not been set.
    /// </para>
    /// </summary>
    public string? Purpose { get; init; }
}

public sealed record NendoFieldSnapshot(
    string FieldId,
    string DisplayName,
    NendoStorageKind StorageKind,
    bool Required,
    string? Presentation,
    IReadOnlyList<string> Options)
{
    public string? UnsupportedStorageKind { get; init; }
    public NendoReferenceDefinition? Reference { get; init; }
    public IReadOnlyList<NendoChoiceOption> Choices { get; init; } = [];
    public NendoRatingScale? Scale { get; init; }
    public bool Retired { get; init; }
}

/// <summary>
/// The closed scale a <c>rating</c> Integer field is drawn on, both ends counted
/// (ADR-0004, 2026-09-14 amendment). A stored value outside it is a data issue the
/// reader states, never an invented dot count, so the scale bounds the drawing rather
/// than the column.
/// </summary>
public sealed record NendoRatingScale(long Min, long Max);

/// <summary>
/// One option of a single-choice field. <paramref name="Tone"/> is its colour as a
/// closed named hue from <see cref="NendoSemanticVocabulary.ChoiceTones"/>, or null
/// for none: a semantic token the renderer maps to Light and Dark colours, never a
/// hex value stored in the file (ADR-0004, 2026-09-14 amendment).
/// </summary>
public sealed record NendoChoiceOption(string Id, string DisplayName, bool Retired, string? Tone = null);

public sealed record NendoReferenceDefinition(string TargetEntityId, string LabelFieldId);

/// <summary>
/// A field a record type shows but does not store.
/// <para>
/// It is deliberately not a <see cref="NendoFieldSnapshot"/> with an extra flag, and
/// not a <see cref="NendoStorageKind"/> value: a calculated field has no physical
/// column, cannot be edited, and carries a result that may be a value, empty, still
/// loading or an error. Presenting it beside stored fields would invite every
/// consumer to treat it as one.
/// </para>
/// </summary>
public sealed record NendoDerivedFieldSnapshot(
    string FieldId,
    string DisplayName,
    string CalculationId,
    NendoBehaviourScalar ResultType,
    bool ResultNullable,
    string Expression);

public sealed record NendoEntitySnapshot(
    string EntityId,
    string DisplayName,
    IReadOnlyList<NendoFieldSnapshot> Fields)
{
    public bool Retired { get; init; }

    /// <summary>The calculated fields declared on this record type, ordered by stable ID.</summary>
    public IReadOnlyList<NendoDerivedFieldSnapshot> DerivedFields { get; init; } = [];
}

public sealed record NendoRecordSnapshot(
    string EntityId,
    string RecordId,
    long RecordVersion,
    IReadOnlyDictionary<string, JsonElement> Values)
{
    public IReadOnlyDictionary<string, string?> ReferenceLabels { get; init; } = new Dictionary<string, string?>();

    /// <summary>
    /// This record's calculated fields, in dependency order. Kept apart from
    /// <see cref="Values"/> because a calculation is not a stored value: it has no
    /// column, cannot be edited, and may be a value, empty, still loading or an error.
    /// </summary>
    public IReadOnlyList<NendoCalculationResult> Calculations { get; init; } = [];
}

public sealed record NendoUiNodeSnapshot(
    string SurfaceId,
    string NodeId,
    string? ParentNodeId,
    string Kind,
    int Position,
    IReadOnlyDictionary<string, JsonElement> Properties);

public sealed record NendoStoredOperationSnapshot(
    string OperationId,
    string OperationType,
    NendoReversibilityClass Reversibility,
    string CanonicalJson);

public sealed record NendoRevisionSnapshot(
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
    string? IdempotencyScope,
    string? IdempotencyKey,
    string? ProposalId,
    string? ProposalDigest,
    string? CompensationOfRevisionId,
    IReadOnlyList<NendoStoredOperationSnapshot> Operations);

public sealed record NendoStorageHealthSnapshot(
    string JournalMode,
    string SynchronousMode,
    int BusyTimeoutMilliseconds,
    string IntegrityResult,
    IReadOnlyList<string> OperationalSidecars)
{
    public DateTimeOffset? IntegrityCheckedAt { get; init; }
    public long? IntegrityChangeSequence { get; init; }
}

public sealed record NendoSessionSnapshot(
    string FileName,
    NendoSessionHealth Health,
    NendoManifestSnapshot Manifest,
    IReadOnlyList<NendoEntitySnapshot> Entities,
    IReadOnlyList<NendoRecordSnapshot> Records,
    IReadOnlyList<NendoUiNodeSnapshot> UiNodes,
    NendoStorageHealthSnapshot Storage)
{
    /// <summary>
    /// The custom-view packages the file carries (ADR-0013), with their files but not their
    /// bytes. Definition, read in the same transaction as the rest, so a view and the package
    /// it names are never read from two different moments.
    /// </summary>
    public IReadOnlyList<NendoExtensionPackageSnapshot> ExtensionPackages { get; init; } = [];
}

/// <summary>
/// One record an automatic action changed while a write was committing, at the
/// version it now holds. <paramref name="Change"/> is <c>created</c>, <c>updated</c>
/// or <c>deleted</c>; the version is null after a delete.
/// </summary>
public sealed record NendoGeneratedChange(
    string EntityId,
    string RecordId,
    string Change,
    long? RecordVersion);

public sealed record NendoApplyResult(
    string RevisionId,
    string OperationDigest,
    long DefinitionRevision,
    long DataRevision,
    long ChangeSequence,
    bool IsIdempotentReplay)
{
    /// <summary>
    /// What this write's automatic actions changed besides what was asked for, one
    /// entry per record, the last write to it winning. The caller's own record is
    /// not repeated here. Empty on an idempotent replay, whose receipt describes the
    /// original write and not what the file holds now — read the record instead.
    /// </summary>
    public IReadOnlyList<NendoGeneratedChange> GeneratedChanges { get; init; } = [];

    /// <summary>
    /// The version the touched record now holds, where the applying service can
    /// state it exactly. A command sets one field per step against consecutive
    /// expected versions, so the resulting version is the expected version plus
    /// the step count — a number the caller cannot derive, because the steps live
    /// in the stored definition rather than in the request. Null where no single
    /// record version is the answer, and on an idempotent replay, where the
    /// original write's version may since have moved.
    /// </summary>
    public long? RecordVersion { get; init; }
}

public sealed record NendoChangeSetApplyResult(
    string ChangeSetDigest,
    IReadOnlyList<NendoApplyResult> Revisions,
    long DefinitionRevision,
    long DataRevision,
    long ChangeSequence);

public sealed record NendoRequestContext(
    string IdempotencyScope,
    string IdempotencyKey,
    string Origin);

public sealed record NendoProposalRequest(
    string ProposalId,
    string Title,
    string Origin,
    NendoChangeSet ChangeSet);

public sealed record NendoCreateRecordRequest(
    string EntityId,
    string RecordId,
    IReadOnlyDictionary<string, object?> Values,
    NendoRequestContext Context,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null);

/// <summary>One record inside a bounded batch create.</summary>
public sealed record NendoCreateRecordEntry(
    string RecordId,
    IReadOnlyDictionary<string, object?> Values,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null);

/// <summary>
/// Several records as one mutation, one revision and one idempotency key. A demo
/// dataset is fifty round trips without it and a real import is thousands.
/// </summary>
public sealed record NendoCreateRecordsRequest(
    string EntityId,
    IReadOnlyList<NendoCreateRecordEntry> Records,
    NendoRequestContext Context);

public sealed record NendoSetFieldRequest(
    string EntityId,
    string RecordId,
    string FieldId,
    long ExpectedRecordVersion,
    object? Value,
    NendoRequestContext Context,
    long? ExpectedTargetRecordVersion = null);

public sealed record NendoSetFieldsRequest(
    string EntityId,
    string RecordId,
    long ExpectedRecordVersion,
    IReadOnlyDictionary<string, object?> Values,
    NendoRequestContext Context,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null);

public sealed record NendoExecuteCommandRequest(
    string CommandId,
    string RecordId,
    long ExpectedRecordVersion,
    NendoRequestContext Context);

public class NendoException(string message) : Exception(message);

public sealed class NendoValidationException(string message) : NendoException(message);

public sealed class NendoPreconditionException(string code, string message) : NendoException(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// The refusal for a write that names a calculated field. A calculated field has no
/// column, so the stored-field lookup reported it as not existing while the schema
/// read listed it; the sentence is written once so the service, which checks the
/// snapshot, and storage, which checks the definitions, say the same thing.
/// </summary>
internal static class NendoCalculatedFieldRefusal
{
    internal static NendoPreconditionException For(string entityId, string fieldId, string calculationId) => new(
        "field-calculated",
        $"Field {fieldId} on entity {entityId} is calculated by {calculationId}; it is read-only. " +
        "Write the stored fields its formula reads instead. The schema read lists it under derivedFields.");
}

public sealed class NendoIdempotencyConflictException(string message) : NendoException(message);

public sealed class NendoRecoveryRequiredException(string message) : NendoException(message);

public sealed class NendoWriteOwnershipException(string message, string code = "path-in-use") : NendoException(message)
{
    public string Code { get; } = code;
}

public sealed class NendoCompensationNotSupportedException(string message) : NendoException(message);
