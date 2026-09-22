namespace Nendo.Engine;

/// <summary>
/// What a file's automatic actions are able to do, in the terms a person is asked
/// to consent to.
/// <para>
/// Derived from the actions a trigger can actually reach, not declared by the file,
/// so a definition cannot understate itself. Deleting records is separated from
/// creating and updating them because it is the one an owner is most likely to
/// refuse on its own.
/// </para>
/// </summary>
[Flags]
public enum NendoBehaviourCapabilities
{
    None = 0,
    CreateRecords = 1,
    UpdateRecords = 2,
    DeleteRecords = 4,
}

/// <summary>
/// Exactly what consent covers: this application, this copy of it, this behaviour,
/// under this contract, at this definition revision, doing these things.
/// <para>
/// One record describes both what a file requires and what the owner approved, so
/// deciding whether a grant applies is record equality rather than a policy with
/// somewhere to be lenient. Every field is load-bearing:
/// </para>
/// <list type="bullet">
/// <item>Application and instance ID, so approving one file does not approve a copy
/// of it, or a different file that happens to carry the same definitions.</item>
/// <item>The behaviour digest, so changing what an action does needs new consent
/// even though the file is the same file.</item>
/// <item>The contract version, so a host that would evaluate the definitions
/// differently does not inherit approval given for this host's reading of them.</item>
/// <item>The definition revision, conservatively: any definition change at all asks
/// again. A more selective digest would have to cover every function, formula and
/// schema binding that affects what an action means, and would need its own
/// invalidation tests before it could be trusted to ask less often.</item>
/// </list>
/// </summary>
public sealed record NendoBehaviourGrant(
    string ApplicationId,
    string InstanceId,
    string BehaviourDigest,
    string ContractVersion,
    long DefinitionRevision,
    NendoBehaviourCapabilities Capabilities);

/// <summary>
/// Whether the host currently holds consent for a file's automatic actions.
/// <para>
/// The Engine consumes this and nothing more. It never learns where a grant is
/// stored, never receives a path, and has no way to record one — so there is
/// nothing here for a formula or a stored definition to reach even in principle.
/// Consent is the host's to give, and a file cannot give it to itself.
/// </para>
/// </summary>
public interface INendoBehaviourAuthority
{
    /// <summary>
    /// Increments whenever consent is withdrawn. An answer may be remembered only
    /// together with the generation it was given under, which is what stops a
    /// revocation from being outrun by work already in flight.
    /// </summary>
    long RevocationGeneration { get; }

    /// <summary>
    /// Asked afresh each time, including immediately before a commit. A cached
    /// Boolean would leave a window between deciding and committing in which
    /// consent could be withdrawn and the write would land anyway.
    /// </summary>
    bool IsGranted(NendoBehaviourGrant required);
}

/// <summary>
/// What the open file needs from its host before it may be edited, and whether it
/// has it.
/// </summary>
/// <param name="RequiresApproval">
/// True when the file carries a trigger. A file with calculations but no triggers
/// needs no consent: calculating reads data and writes nothing.
/// </param>
public sealed record NendoBehaviourTrust(
    bool RequiresApproval,
    bool IsApproved,
    NendoBehaviourGrant? Required)
{
    internal static NendoBehaviourTrust None { get; } = new(false, true, null);
}

/// <summary>
/// The authority a host supplies when it has no grant storage at all.
/// <para>
/// Refusing is the only safe default. A host that has not been given a way to ask
/// its owner cannot answer for them, and treating silence as consent would make
/// every embedding that forgot to wire up a grant store run a stranger's actions.
/// </para>
/// </summary>
internal sealed class DeniedBehaviourAuthority : INendoBehaviourAuthority
{
    internal static DeniedBehaviourAuthority Instance { get; } = new();

    public long RevocationGeneration => 0;

    public bool IsGranted(NendoBehaviourGrant required) => false;
}
