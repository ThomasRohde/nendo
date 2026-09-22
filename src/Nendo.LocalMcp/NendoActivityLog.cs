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
