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
    [property: Description("The History revision this write committed; on an idempotent replay, the original one.")]
    string RevisionId,
    [property: Description("Digest of the canonical operations committed. An exact replay returns the same digest.")]
    string OperationDigest,
    [property: Description("The file's definition revision after this write.")]
    long DefinitionRevision,
    [property: Description("The file's data revision after this write.")]
    long DataRevision,
    [property: Description("The file's change sequence after this write. A paged read begun before it restarts on NENDO_STALE_CURSOR.")]
    long ChangeSequence,
    [property: Description("True when this idempotency key had already committed and this is that original outcome, not a second write.")]
    bool IsIdempotentReplay,
    [property: Description("Every record this write created, changed or deleted, in the order the request named them.")]
    IReadOnlyList<string> RecordIds)
{
    /// <summary>
    /// The version every listed record now holds, when this call can state it
    /// exactly: 1 after a create, the expected version plus one after a single
    /// field edit, one more per step after a command. Null after a delete, when an
    /// automatic action moved only some records of a batch, when a move wrote
    /// siblings too, and on an idempotent replay, where the record may have moved on
    /// since the original write — read the record rather than assume.
    /// </summary>
    [Description("The version the listed records now hold, when one number is exact: 1 after a create, the expected version plus one after a field edit, one more per step after a command. Null after a delete, when an automatic action moved only some records of a batch, when a move wrote siblings too, and on an idempotent replay: read the record instead.")]
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
    [Description("Each other record this write's automatic actions created, updated or deleted, with the version it now holds. Empty when no action ran. On an idempotent replay the versions are null, because the file may have moved since: read a record before writing to it.")]
    public IReadOnlyList<NendoGeneratedChange> AlsoChanged { get; init; } = [];

    /// <summary>
    /// The codes the host wrote into new records because their creates left a numbered field
    /// empty (ADR-0020): each record, field and code. Empty when nothing was numbered, and on an
    /// idempotent replay — read the record instead.
    /// </summary>
    [Description("The codes the host wrote into numbered fields that a create left empty, one entry per record and field. Empty when nothing was numbered, and on an idempotent replay.")]
    public IReadOnlyList<NendoAssignedValue> Assigned { get; init; } = [];
}

public sealed record NendoChangeSetBeginResult(
    [property: Description("Server-minted change-set ID. Pass it to add_operations, amend, validate, preview and reject.")]
    string ChangeSetId,
    [property: Description("The title the person sees on the proposal.")]
    string Title,
    [property: Description("The definition revision the draft is built against. If the file's definition moves before acceptance, the proposal goes stale.")]
    long CapturedDefinitionRevision,
    [property: Description("draft: the change set takes operations until validate freezes it into a proposal.")]
    string State)
{
    /// <summary>
    /// How many other change sets are already open against this file. Every open
    /// proposal captured a definition revision, and accepting any one of them
    /// advances that revision and invalidates the rest.
    /// </summary>
    [Description("How many other change sets are already open against this file. Accepting any one of them advances the definition revision and makes the others stale.")]
    public int OutstandingProposals { get; init; }

    /// <summary>What to do about <see cref="OutstandingProposals"/>, when there are any.</summary>
    [Description("What to do about outstandingProposals, or null when there are none.")]
    public string? Advisory { get; init; }
}

/// <param name="OperationCount">Operations submitted to this change set so far.</param>
public sealed record NendoChangeSetAddResult(
    [property: Description("The draft the operations were appended to.")]
    string ChangeSetId,
    [property: Description("Mutations the draft holds now. Pass it to nendo.change_set.amend as dropFromMutationOrdinal to append without dropping.")]
    int MutationCount,
    [property: Description("Operations submitted to this change set so far.")]
    int OperationCount,
    [property: Description("draft: the change set still takes operations.")]
    string State)
{
    /// <summary>The change-set ceiling, echoed so it is known before it is reached.</summary>
    [Description("The most mutations one change set may hold.")]
    public int MutationLimit { get; init; }

    [Description("The most operations that may be submitted to one change set.")]
    public int OperationLimit { get; init; }

    /// <summary>
    /// What the submitted operations expand to. An inline <c>properties</c> map on
    /// <c>ui.addNode</c> becomes one <c>ui.setProperty</c> per property, so a
    /// UI-heavy change set spends this budget faster than the submitted one.
    /// </summary>
    [Description("What the submitted operations expand to: an inline properties map on ui.addNode becomes one ui.setProperty per property, so this budget runs out faster than operationCount.")]
    public int CanonicalOperationCount { get; init; }

    [Description("The most canonical operations one change set may expand to.")]
    public int CanonicalOperationLimit { get; init; }
}

public sealed record NendoChangeSetRejectResult(
    [property: Description("The change set rejected.")]
    string ChangeSetId,
    [property: Description("The proposal it had become, or null when it was still a draft.")]
    string? ProposalId,
    [property: Description("rejected: the draft or proposal is gone and the file is as it was.")]
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
    [property: Description("The change set whose proposal was accepted.")]
    string ChangeSetId,
    [property: Description("The proposal accepted, as nendo://application/proposals names it.")]
    string ProposalId,
    [property: Description("Whether the change reached the file. False is an ordinary answer, not an error: state and message say why, and the proposal is still there.")]
    bool Applied,
    [property: Description("active when it committed; otherwise stale (the file moved under it), failed (the reviewed plan no longer matches) or previewable (still waiting for a person).")]
    string State,
    [property: Description("Why it was not applied and what to do, or null when it was.")]
    string? Message,
    [property: Description("The definition revision the file reached, so the next change set can begin against it without a read. Null when nothing was applied.")]
    long? DefinitionRevision,
    [property: Description("True when this acceptance also recorded this device's consent to run the automatic actions the change installs. The person can withdraw it under Agent and under Health.")]
    bool BehaviourApproved);
