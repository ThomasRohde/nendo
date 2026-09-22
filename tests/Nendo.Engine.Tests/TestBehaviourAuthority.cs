namespace Nendo.Engine.Tests;

/// <summary>
/// A host's answer about consent, held in memory.
/// <para>
/// It grants by exact value, the way a real store must: approving one file's
/// behaviour approves that behaviour in that file at that revision and nothing
/// else. Tests that want a mismatch construct the grant they expect and change one
/// field, which is the same thing a copied file or an edited definition does.
/// </para>
/// </summary>
internal sealed class TestBehaviourAuthority : INendoBehaviourAuthority
{
    private readonly HashSet<NendoBehaviourGrant> _granted = [];

    public long RevocationGeneration { get; private set; }

    /// <summary>
    /// Runs immediately after a grant check answers, so a test can move consent at the
    /// exact moment a caller has just finished asking about it.
    /// </summary>
    internal Action? OnGrantChecked { get; set; }

    public bool IsGranted(NendoBehaviourGrant required)
    {
        var granted = _granted.Contains(required);
        OnGrantChecked?.Invoke();
        return granted;
    }

    internal void Approve(NendoBehaviourGrant grant) => _granted.Add(grant);

    /// <summary>Approves exactly what the open file currently asks for.</summary>
    internal NendoBehaviourGrant ApproveCurrent(NendoWriteCoordinator coordinator)
    {
        var required = coordinator.BehaviourTrust.Required
            ?? throw new AssertFailedException("The file requires no behaviour approval, so there is nothing to approve.");
        Approve(required);
        return required;
    }

    /// <summary>
    /// Withdraws every grant and moves the revocation generation, so work already in
    /// flight can tell that consent changed underneath it.
    /// </summary>
    internal void RevokeAll()
    {
        _granted.Clear();
        RevocationGeneration++;
    }

    /// <summary>Attaches this authority to a coordinator and approves what it needs.</summary>
    internal static TestBehaviourAuthority Approving(NendoWriteCoordinator coordinator)
    {
        var authority = new TestBehaviourAuthority();
        coordinator.BehaviourAuthority = authority;
        authority.ApproveCurrent(coordinator);
        return authority;
    }
}
