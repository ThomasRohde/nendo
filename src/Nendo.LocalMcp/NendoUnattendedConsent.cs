namespace Nendo.LocalMcp;

/// <summary>
/// The one thing this adapter may ask its host to do on the person's behalf: record that
/// the open file may run the automatic actions it currently holds.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately a delegate and deliberately empty of arguments. The adapter cannot say
/// which file, which grant or which behaviour — the host reads all three from the session
/// it already owns — so there is no shape here for a caller to steer. It never learns
/// where a grant is stored, and it cannot read one back: the answer to "is this approved"
/// stays the Engine's, asked of the host's own authority, afresh, immediately before every
/// commit.
/// </para>
/// <para>
/// The host supplies it only at <see cref="AgentAccessMode.Unattended"/>. At every level
/// below, it is null and the refusals are exactly what they were
/// (ADR-0009, 2026-09-22 amendment).
/// </para>
/// </remarks>
public delegate Task NendoUnattendedConsent(CancellationToken cancellationToken);

/// <summary>
/// Whether this listener may grant the open file's automatic-action consent, and the act
/// of doing it. Both answers live here so no caller has to remember to check the mode.
/// </summary>
internal sealed class NendoUnattendedAuthority(AgentAccessMode mode, NendoUnattendedConsent? consent)
{
    /// <summary>
    /// Two conditions, not one. The mode is what the person chose; the delegate is what
    /// the host was willing to supply. A host that wires nothing still refuses, which is
    /// the same failure-closed default an embedding with no grant storage gets.
    /// </summary>
    internal bool IsAvailable => mode >= AgentAccessMode.Unattended && consent is not null;

    /// <summary>
    /// Grants consent, and reports whether it did. False is not a failure: it is this
    /// listener saying the question is not its to answer, and the caller then leaves the
    /// refusal it already had — which names the person and what they need to do.
    /// </summary>
    internal async Task<bool> GrantAsync(CancellationToken cancellationToken)
    {
        if (!IsAvailable) return false;
        await consent!(cancellationToken);
        return true;
    }
}
