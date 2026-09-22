using System.Text.Json;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

/// <summary>Which kind of change to a record raised an event.</summary>
public enum NendoRecordEventKind
{
    Created,
    Updated,
    Deleted,
}

/// <summary>One record, named the only way behaviour ever names one.</summary>
internal readonly record struct RecordKey(string EntityId, string RecordId);

/// <summary>
/// One logical change to one record.
/// <para>
/// Logical is the load-bearing word. A form that sets four fields writes four
/// low-level operations at four consecutive record versions, and those versions are
/// real — but they are not four events. Emitting them as four would let a trigger
/// see a record half-way through an edit the owner made as one action, and act on a
/// state that never existed as far as anybody outside the transaction is concerned.
/// </para>
/// <para>
/// Creation has no before and deletion has no after, which is what makes those two
/// distinguishable from an update without a separate flag.
/// </para>
/// </summary>
internal sealed record RecordEvent(
    RecordKey Key,
    NendoRecordEventKind Kind,
    IReadOnlyDictionary<string, JsonElement>? Before,
    IReadOnlyDictionary<string, JsonElement>? After,
    IReadOnlySet<string> ChangedFieldIds);

/// <summary>
/// Why a generated operation exists: the request that started the chain, the event
/// that selected it, and the trigger, action and step that produced it.
/// <para>
/// Recorded against the operation in the ordinary history rather than in a log of
/// its own, so the question "why did this record change?" is answered by the same
/// evidence that answers "what changed?".
/// </para>
/// </summary>
internal sealed record BehaviourAttribution(
    string RootScope,
    string RootKey,
    string TriggerId,
    string ActionId,
    string StepId,
    NendoRecordEventKind EventKind,
    string EventEntityId,
    string EventRecordId,
    string BehaviourDigest);

/// <summary>
/// A record whose value was read to decide what a chain did, and the version it was
/// read at. Includes records nothing wrote to: if a condition counted them, a later
/// replay of the same plan is only valid while they still say the same thing.
/// </summary>
internal readonly record struct BehaviourReadDependency(string EntityId, string RecordId, long RecordVersion);

/// <summary>
/// Everything one causal chain carries, passed explicitly from the coordinator
/// through storage to the planner.
/// <para>
/// Explicit, and not ambient. An implicit scope would make the state a chain runs
/// under depend on which thread happened to be running it, which is exactly the kind
/// of thing that works in a test and then leaks between two concurrent saves. It is
/// also what lets a replay be given a prepared context instead of persuading a
/// hidden one to behave differently.
/// </para>
/// </summary>
internal sealed class BehaviourExecutionContext
{
    internal BehaviourExecutionContext(
        CompiledBehaviour behaviour,
        BehaviourBudget budget,
        string rootScope,
        string rootKey,
        string behaviourDigest)
    {
        Behaviour = behaviour;
        Budget = budget;
        RootScope = rootScope;
        RootKey = rootKey;
        BehaviourDigest = behaviourDigest;
    }

    /// <summary>The validated definitions this chain runs, fixed for its whole life.</summary>
    internal CompiledBehaviour Behaviour { get; }

    /// <summary>One allowance for the entire chain, however deep it goes.</summary>
    internal BehaviourBudget Budget { get; }

    internal string RootScope { get; }

    internal string RootKey { get; }

    /// <summary>Identifies the exact behaviour this chain ran under, for trust and replay.</summary>
    internal string BehaviourDigest { get; }

    /// <summary>The consent this chain needed, re-checked before the transaction commits.</summary>
    internal NendoBehaviourGrant? RequiredGrant { get; init; }

    /// <summary>The revocation generation consent was given under, so a withdrawal cannot be outrun.</summary>
    internal long GrantedAtRevocationGeneration { get; init; }

    /// <summary>Events still to be processed, in the order they were raised.</summary>
    internal Queue<RecordEvent> Pending { get; } = new();

    /// <summary>Each generated operation and why it exists, in execution order.</summary>
    /// <summary>
    /// Every write the actions made, with why it exists and what it replaced.
    /// <para>
    /// The evidence is kept, not just the operation. It is what a compensation reads
    /// to reverse the generated half of a causal revision; without it the typed edit
    /// could be undone and the fields an action maintained could not.
    /// </para>
    /// </summary>
    internal List<(NendoOperation Operation, BehaviourAttribution Attribution, OperationEvidence Evidence)> Generated { get; } = [];

    /// <summary>Every record read to decide what happened, at the version it was read.</summary>
    internal Dictionary<RecordKey, long> ReadSet { get; } = [];

    /// <summary>
    /// Conditions that could not be decided. Kept separate from failures: a condition
    /// that cannot be evaluated blocks its action and is shown, while the initiating
    /// edit still commits — an error in a rule about the data must not destroy the
    /// data the owner just typed.
    /// </summary>
    internal List<(string TriggerId, string Code, string Message)> BlockedConditions { get; } = [];

    internal void Observe(RecordKey key, long recordVersion) => ReadSet[key] = recordVersion;
}
