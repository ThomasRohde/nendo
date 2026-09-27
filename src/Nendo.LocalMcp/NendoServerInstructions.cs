namespace Nendo.LocalMcp;

/// <summary>
/// What the host tells a client before its first call. A client shows this only up to
/// its own cut: Claude Code stops at 2,048 characters and says nothing on the wire, so
/// the sentences past that point are never read. Measured on 2026-09-27, the text was
/// 2,755 characters and lost the one that says no SQL, file, process or network access
/// exists. It is written to fit under <see cref="MaximumCharacters"/> in every variant,
/// and a test reads every variant back from both handshakes and holds it there.
/// </summary>
internal static class NendoServerInstructions
{
    /// <summary>The bound every instruction and description is held to, under the 2,048 cut.</summary>
    internal const int MaximumCharacters = 2_000;

    // The first sentence says what the product is: a reviewer who read only the tool list
    // could not tell this host had calculations at all. The transport paragraph written for
    // someone building an HTTP client is gone; server/discover and the MCP contract carry it.
    internal static string For(AgentAccessMode mode, TimeSpan? leaseTtl) =>
        "This is a Nendo file: record types and records, screens (lists, boards, calendars, record pages and " +
        "commands), calculated fields, reusable functions, and automatic actions that run on a trigger. " +
        "Records are written directly; everything else is authored as a change set (begin, add_operations, " +
        "validate), and calculations, functions, actions and triggers are its behaviour.setDefinition operation. " +
        "Read nendo://application/describe first: the whole open application in one call, and every read path " +
        "this host serves, including the templated ones resources/list leaves out. " +
        "nendo://application/vocabulary is the authoring contract: every operation with its payload, the " +
        "authoringRules and the limits. nendo://application/examples holds change sets you can send as they " +
        "stand; nendo://application/proposals lists what is waiting for the person. " +
        "To write, call nendo.lease.acquire, keep its applicationHandle private, and pass it with leaseId on " +
        "every owned call. " +
        (leaseTtl is { } ttl
            ? $"Renew within {(int)ttl.TotalSeconds} seconds or the lease lapses; release it when finished. "
            : "The lease has no expiry: release it when finished. ") +
        "Closing your client does not release it, and the person may revoke it at any time. " +
        "Save receiptContext from the grant before writing: after a lost response, nendo.data.get_receipt reads " +
        "the original outcome, and an unresolved receipt is not permission to resubmit with a new key. After a " +
        "reconnect, nendo.lease.status says who holds the lease. " +
        "Entity, field, record and node IDs are unique across the whole file, not per parent. " +
        "Compiled screens are exercised in the Use view, not Studio. " +
        "There is no SQL, file, process or network access, and no generic invocation. " +
        Acceptance(mode);

    private static string Acceptance(AgentAccessMode mode) => mode >= AgentAccessMode.Unattended
        ? "This session is at Unattended: nendo.change_set.accept applies your own validated proposal and " +
          "records this device's consent for any automatic actions it installs."
        : $"This session is at {NendoAccessLevels.DisplayName(mode)}: a validated change set is accepted or " +
          "rejected by the person in Nendo, and no tool accepts one at this level.";
}
