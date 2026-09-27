using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

public sealed record NendoAgentActivity(
    DateTimeOffset Timestamp,
    string Client,
    string Category,
    string Name,
    string Outcome,
    string? RevisionId,
    string? ProposalId);

internal sealed class NendoActivityLog(INendoClock clock)
{
    private const int Capacity = 200;
    private readonly object _gate = new();
    private readonly Queue<NendoAgentActivity> _events = new(Capacity);

    internal void Record(
        string category,
        string name,
        McpServer server,
        string outcome,
        string? revisionId = null,
        string? proposalId = null)
    {
        var client = NendoTransportIdentity.DisplayName(server.ClientInfo);
        var item = new NendoAgentActivity(
            clock.UtcNow,
            client,
            Bounded(category, 32),
            Bounded(name, 180),
            Bounded(outcome, 32),
            BoundedOptional(revisionId, 200),
            BoundedOptional(proposalId, 200));
        lock (_gate)
        {
            if (_events.Count == Capacity)
            {
                _events.Dequeue();
            }
            _events.Enqueue(item);
        }
    }

    /// <summary>The key a tool call's <see cref="Slot"/> is held under in the request's items.</summary>
    internal const string SlotKey = "nendo.activity";

    /// <summary>What a tool call did, told by the tool and written once by the host's filter.</summary>
    internal sealed class Slot
    {
        internal string? Category { get; set; }
        internal string? Outcome { get; set; }
        internal string? RevisionId { get; set; }
        internal string? ProposalId { get; set; }
    }

    /// <summary>
    /// What a tool did. Inside a call the host's filter is watching, it is held for the
    /// filter, which writes the call's one entry; outside one, it is written now.
    /// </summary>
    internal void Record(
        MessageContext context,
        string category,
        string name,
        string outcome,
        string? revisionId = null,
        string? proposalId = null)
    {
        if (context.Items.TryGetValue(SlotKey, out var held) && held is Slot slot)
        {
            slot.Category = category;
            slot.Outcome = outcome;
            slot.RevisionId = revisionId ?? slot.RevisionId;
            slot.ProposalId = proposalId ?? slot.ProposalId;
            return;
        }
        Record(category, name, context.Server, outcome, revisionId, proposalId);
    }

    /// <summary>The one entry for a tool call, from what its tool told the slot.</summary>
    internal void Record(Slot slot, string name, McpServer server, bool rejected) => Record(
        slot.Category ?? "tool",
        name,
        server,
        rejected ? "rejected" : slot.Outcome ?? "completed",
        slot.RevisionId,
        slot.ProposalId);

    internal IReadOnlyList<NendoAgentActivity> Snapshot(int maximum = 200)
    {
        if (maximum is < 1 or > Capacity)
        {
            throw new ArgumentOutOfRangeException(nameof(maximum));
        }
        lock (_gate)
        {
            return _events.TakeLast(maximum).ToArray();
        }
    }

    internal static string ResourceName(string uri)
    {
        var query = uri.IndexOf('?', StringComparison.Ordinal);
        return query < 0 ? uri : uri[..query];
    }

    private static string Bounded(string value, int maximum) =>
        new(value.Where(character => !char.IsControl(character)).Take(maximum).ToArray());

    private static string? BoundedOptional(string? value, int maximum) =>
        string.IsNullOrWhiteSpace(value) ? null : Bounded(value, maximum);
}
