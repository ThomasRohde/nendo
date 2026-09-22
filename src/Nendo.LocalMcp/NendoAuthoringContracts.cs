using System.ComponentModel;
using Nendo.Engine;

namespace Nendo.LocalMcp;

public sealed record NendoAgentOperationInput(
    [property: Description("Canonical operation type from the bounded Nendo operation vocabulary.")]
    string OperationType,
    [property: Description("Semantic payload for the selected operation type: a JSON object whose keys are the ones nendo://application/vocabulary lists for it under operations.")]
    NendoObjectInput Payload);

public sealed record NendoAgentMutationInput(
    [property: Description("Human-readable summary of this mutation.")]
    string Description,
    [property: Description("Ordered canonical operations. Operation IDs are supplied by Nendo.")]
    IReadOnlyList<NendoAgentOperationInput> Operations);

/// <summary>One record in a bounded batch create.</summary>
public sealed record NendoRecordInput(
    [property: Description("Stable caller-selected record ID, distinct within the batch.")]
    string RecordId,
    [property: Description("Bounded scalar value map keyed by stable field ID. Exact integers and decimals may use the $nendoNumber envelope.")]
    NendoObjectInput Values)
{
    [property: Description("For each non-null reference field, the current version of its selected target, keyed by field ID.")]
    public IReadOnlyDictionary<string, long>? ExpectedTargetVersions { get; init; }
}

/// <summary>
/// A committed data write, with the identity it touched. Reporting the record back
/// saves a read on every reference-building write.
/// </summary>
public sealed record NendoDataApplyResult(
    string RevisionId,
    string OperationDigest,
    long DefinitionRevision,
    long DataRevision,
    long ChangeSequence,
    bool IsIdempotentReplay,
    IReadOnlyList<string> RecordIds)
{
    /// <summary>
    /// The version every listed record now holds, when this call can state it
    /// exactly: 1 after a create, the expected version plus one after a single
    /// field edit. Null after a delete, after a command (which may set several
    /// fields), and on an idempotent replay, where the record may have moved on
    /// since the original write — read the record rather than assume.
    /// </summary>
    public long? RecordVersion { get; init; }

    /// <summary>
    /// What this write's automatic actions changed besides the record named above:
    /// each other record touched, with its new version. Empty when no action ran,
    /// and when every step's target reference was empty. An idempotent replay, and a
    /// receipt read back later through <c>nendo.data.get_receipt</c>, name the same
    /// records with <c>recordVersion</c> null: the file may have moved since, so the
    /// entry says what changed and not a number that would be read as current. Read
    /// the record before writing to it.
    /// </summary>
    public IReadOnlyList<NendoGeneratedChange> AlsoChanged { get; init; } = [];
}

public sealed record NendoChangeSetBeginResult(
    string ChangeSetId,
    string Title,
    long CapturedDefinitionRevision,
    string State)
{
    /// <summary>
    /// How many other change sets are already open against this file. Every open
    /// proposal captured a definition revision, and accepting any one of them
    /// advances that revision and invalidates the rest.
    /// </summary>
    public int OutstandingProposals { get; init; }

    /// <summary>What to do about <see cref="OutstandingProposals"/>, when there are any.</summary>
    public string? Advisory { get; init; }
}

/// <param name="OperationCount">Operations submitted to this change set so far.</param>
public sealed record NendoChangeSetAddResult(
    string ChangeSetId,
    int MutationCount,
    int OperationCount,
    string State)
{
    /// <summary>The change-set ceiling, echoed so it is known before it is reached.</summary>
    public int MutationLimit { get; init; }

    public int OperationLimit { get; init; }

    /// <summary>
    /// What the submitted operations expand to. An inline <c>properties</c> map on
    /// <c>ui.addNode</c> becomes one <c>ui.setProperty</c> per property, so a
    /// UI-heavy change set spends this budget faster than the submitted one.
    /// </summary>
    public int CanonicalOperationCount { get; init; }

    public int CanonicalOperationLimit { get; init; }
}

public sealed record NendoChangeSetRejectResult(
    string ChangeSetId,
    string? ProposalId,
    string State);

/// <summary>
/// What happened when an Unattended session accepted its own validated proposal.
/// </summary>
/// <param name="Applied">
/// Whether the change reached the active file. False is the ordinary answer when the
/// file moved under the proposal, and it is not an error: <paramref name="State"/> and
/// <paramref name="Message"/> say which, and the proposal is still there to look at.
/// </param>
/// <param name="State">
/// The proposal's state after the attempt — <c>active</c> when it committed, and
/// otherwise <c>stale</c>, <c>failed</c> or <c>previewable</c>, the last of which means
/// the file's automatic actions are still waiting for a person.
/// </param>
/// <param name="DefinitionRevision">
/// The definition revision the file reached, so the next change set can be opened
/// against it without a read. Null when nothing was applied.
/// </param>
/// <param name="BehaviourApproved">
/// True when this acceptance also recorded the open file's automatic-action consent on
/// the person's behalf. Stated rather than left to be inferred: it is the part of this
/// level that a person would most want to find in a log afterwards.
/// </param>
public sealed record NendoChangeSetAcceptResult(
    string ChangeSetId,
    string ProposalId,
    bool Applied,
    string State,
    string? Message,
    long? DefinitionRevision,
    bool BehaviourApproved);
