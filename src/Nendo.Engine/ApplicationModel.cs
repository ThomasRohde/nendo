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
    /// <summary>Earlier history folded into one revision (ADR-0021): no operations, not compensable.</summary>
    Checkpoint,
}

/// <summary>What folding a file's older history would do now (ADR-0021), for the person to read first.</summary>
public sealed record NendoHistoryFoldPreview(
    bool CanFold,
    string? Reason,
    int Keep,
    long Revisions,
    long Operations,
    long? ThroughChangeSequence,
    DateTimeOffset? FirstAt,
    DateTimeOffset? LastAt,
    long OperationRows,
    long OperationCeiling,
    DateTimeOffset? LastFoldedAt);

/// <summary>A fold of older history, done (ADR-0021).</summary>
public sealed record NendoHistoryFoldResult(
    string CheckpointRevisionId,
    long ThroughChangeSequence,
    long Revisions,
    long Operations,
    long OperationRowsBefore,
    long OperationRowsAfter,
    string BackupLabel,
    DateTimeOffset FoldedAt)
{
    /// <summary>
    /// Whether the file gave the folded pages back. False when the compaction after the fold could
    /// not run, a full disk most often: the fold itself committed and stands (ECO-02).
    /// </summary>
    public bool SpaceReclaimed { get; init; } = true;
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

    /// <summary>
    /// The look this file chose for itself, or null when it chose none. Only what was chosen:
    /// the defaults are worked out where the look is drawn (<see cref="NendoLook.Resolve"/>),
    /// because the letter comes from the file's name, and a copy validated under another name
    /// must not read as a file that changed its look.
    /// </summary>
    public NendoApplicationLook? Look { get; init; }

    /// <summary>
    /// The application's own name for one new file of it, such as "Archi model" (ADR-0022), or
    /// null when it gave none. The File menu offers "New {label}…", or "New empty copy…".
    /// </summary>
    public string? NewFileLabel { get; init; }
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

    /// <summary>Whether no two records may hold equal values in this field (ADR-0020).</summary>
    public bool Unique { get; init; }

    /// <summary>The sequence that fills this field on a create that leaves it empty (ADR-0020), or null.</summary>
    public NendoFieldSequence? Sequence { get; init; }
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
    string Expression)
{
    /// <summary>
    /// The stable IDs of the fields its formula reads, ordered, as the retirement check reads them:
    /// a field named here cannot be retired while this calculation stays. Studio's Structure says so
    /// beside the field rather than leaving it to a refusal (UIT-19).
    /// </summary>
    public IReadOnlyList<string> ReadsFieldIds { get; init; } = [];

    /// <summary>The calculations its formula reads, by ID and ordered: on the same record, or through each member of an aggregate.</summary>
    public IReadOnlyList<string> ReadsCalculationIds { get; init; } = [];

    /// <summary>
    /// The record types its bindings start from or reach, ordered. Retiring one is refused while
    /// this calculation stays, as is retiring the record type that owns it.
    /// </summary>
    public IReadOnlyList<string> ReadsEntityIds { get; init; } = [];
}

public sealed record NendoEntitySnapshot(
    string EntityId,
    string DisplayName,
    IReadOnlyList<NendoFieldSnapshot> Fields)
{
    public bool Retired { get; init; }

    /// <summary>The calculated fields declared on this record type, ordered by stable ID.</summary>
    public IReadOnlyList<NendoDerivedFieldSnapshot> DerivedFields { get; init; } = [];

    /// <summary>The record type's declared hierarchy (ADR-0019), or null when it declares none.</summary>
    public NendoHierarchy? Hierarchy { get; init; }

    /// <summary>The link rule this record type declares (ADR-0026), or null when it declares none.</summary>
    public NendoLinkRule? LinkRule { get; init; }

    /// <summary>
    /// Whether a new file of this application keeps this type's records unless a record says
    /// otherwise (ADR-0022). False, the default, leaves them out.
    /// </summary>
    public bool KeptInNewFiles { get; init; }
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

    /// <summary>
    /// This record's own say in whether a new file keeps it (ADR-0022): true or false, or null
    /// when it follows its record type's <see cref="NendoEntitySnapshot.KeptInNewFiles"/>.
    /// Not a value of the record: it has no field and changes no version.
    /// </summary>
    public bool? KeptInNewFiles { get; init; }
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
    string CanonicalJson)
{
    /// <summary>
    /// The automatic action that made this operation, read from the attribution a save
    /// stores beside it; null for an operation the revision's author made.
    /// </summary>
    public NendoOperationAttribution? Attribution { get; init; }

    /// <summary>
    /// The label of the record a record operation acts on: its record type's first text field,
    /// read from the record as it stands or, once deleted, from the values its deletion kept.
    /// Null for an operation on no record, or a record whose label is empty. History named no
    /// record, so three deletes of one type read as three identical lines (UX-07).
    /// </summary>
    public string? RecordLabel { get; init; }
}

/// <summary>
/// Which trigger, action and step made a generated operation, and the record event that
/// selected the trigger. The IDs are what the save recorded. The names are the
/// definitions' display names as the file holds them now, and null once a definition is
/// no longer in the file.
/// </summary>
public sealed record NendoOperationAttribution(
    string TriggerId,
    string? TriggerName,
    string ActionId,
    string? ActionName,
    string StepId,
    NendoRecordEventKind EventKind,
    string EventEntityId,
    string EventRecordId);

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

/// <summary>
/// An automatic action that did not run because its trigger's condition could not be
/// worked out for one record (ADR-0008 §6 and §12): the trigger, the record whose change
/// raised it, and the calculation code and sentence that say why. The save itself committed.
/// </summary>
public sealed record NendoBlockedCondition(
    string TriggerId,
    string DisplayName,
    string EntityId,
    string RecordId,
    string Code,
    string Message);

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
    /// The codes the host wrote into new records because their creates left a sequence field
    /// empty (ADR-0020). Empty on an idempotent replay — read the record instead.
    /// </summary>
    public IReadOnlyList<NendoAssignedValue> AssignedValues { get; init; } = [];

    /// <summary>
    /// The automatic actions this write did not run because a trigger condition could not be
    /// worked out, in the order they were met. The write committed without them, so what they
    /// keep (a total, a status) may now be out of date. Empty on an idempotent replay and on a
    /// receipt read back: the list is not stored with the revision.
    /// </summary>
    public IReadOnlyList<NendoBlockedCondition> BlockedConditions { get; init; } = [];

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

    /// <summary>
    /// Who committed the revision, as History names it, on a receipt read back; null on the
    /// result a write returns. The origin is part of what a replay must match, so a retry
    /// that resubmits a committed batch does so under the origin the batch was committed with.
    /// </summary>
    public string? Origin { get; init; }
}

/// <summary>One record a commit changed.</summary>
public sealed record NendoChangedRecord(string EntityId, string RecordId);

/// <summary>
/// What one commit changed: the revisions it wrote, every record a write or an automatic action
/// touched, and whether the definition moved, which can change records no write named.
/// </summary>
public sealed record NendoCommitSummary(
    long ChangeSequence,
    IReadOnlyList<string> RevisionIds,
    IReadOnlyList<NendoChangedRecord> Records,
    bool DefinitionChanged);

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

/// <summary>One record to create. <paramref name="KeptInNewFiles"/> marks it in the same revision (ADR-0022); null follows its type.</summary>
public sealed record NendoCreateRecordRequest(
    string EntityId,
    string RecordId,
    IReadOnlyDictionary<string, object?> Values,
    NendoRequestContext Context,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null,
    bool? KeptInNewFiles = null);

/// <summary>One record inside a bounded batch create.</summary>
public sealed record NendoCreateRecordEntry(
    string RecordId,
    IReadOnlyDictionary<string, object?> Values,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null,
    bool? KeptInNewFiles = null);

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

/// <summary>
/// A picture to embed (ADR-0031), and optionally the media field that names it, set in the same
/// revision so a drop on a record page is one change. The type is read from the content; a stated
/// one must agree with it.
/// </summary>
public sealed record NendoPutMediaRequest(
    byte[] Content,
    string? MediaType,
    string? Name,
    NendoRequestContext Context,
    NendoMediaTarget? Target = null);

/// <summary>The media field a put also sets, at the record's expected version.</summary>
public sealed record NendoMediaTarget(string EntityId, string RecordId, string FieldId, long ExpectedRecordVersion);

/// <summary>What a put stored: the address a field names it by, and the revision it made.</summary>
public sealed record NendoPutMediaResult(string Address, NendoApplyResult Result);

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
    NendoRequestContext Context)
{
    /// <summary>
    /// The record type the caller means the record to be of, when it says. A command runs on its
    /// own record type's record, so one named with another type's record is refused rather than
    /// run on a record of the same ID in the command's type (R2AP-08). Null checks nothing.
    /// </summary>
    public string? EntityId { get; init; }
}

public class NendoException(string message) : Exception(message);

public sealed class NendoValidationException(string message) : NendoException(message);

public sealed class NendoPreconditionException(string code, string message) : NendoException(message)
{
    public string Code { get; } = code;

    /// <summary>
    /// The record the refusal is about, where a person should be shown which one: a duplicate's
    /// holder (ADR-0020), or the record a reference points at (R2AP-07). The message names it by
    /// ID only, since an audited refusal never carries stored values; the host that shows it to
    /// the file's own user may name the record by its label instead.
    /// </summary>
    public string? RecordId { get; init; }
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
