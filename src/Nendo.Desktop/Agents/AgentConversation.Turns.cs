using System.Text;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// One turn, as whoever sent its message reads it back (ADR-0033): whether it has ended, the
/// agent's message text of that turn, and why it stopped. <c>StopReason</c> is ACP's own word
/// (<c>end_turn</c>, <c>cancelled</c>, <c>max_tokens</c>, <c>max_turn_requests</c>, <c>refusal</c>),
/// <c>error</c> when the agent answered with an error, or <c>ended</c> when the conversation ended
/// first.
/// </summary>
internal sealed record AgentTurnView(string TurnId, bool Done, string? Reply, string? StopReason);

internal sealed partial class AgentConversation
{
    /// <summary>The most of one turn's reply a reader is given.</summary>
    internal const int MaximumReplyCharacters = 100_000;

    /// <summary>Turns kept for reading back, oldest ended ones let go first.</summary>
    private const int MaximumTurns = 16;

    /// <summary>Views' messages that may wait for the turn before them, in all, and from one view.</summary>
    internal const int MaximumQueued = 8;
    internal const int MaximumQueuedFromOneView = 2;

    private readonly Dictionary<string, Turn> _turns = new(StringComparer.Ordinal);
    private readonly Queue<QueuedMessage> _queue = new();
    private long _turnNumber;

    /// <summary>
    /// Stop a view's own turn (ADR-0033): one still waiting leaves the queue; one running is
    /// cancelled as Stop would; one ended is left alone.
    /// </summary>
    internal async Task CancelTurnAsync(string turnId)
    {
        string? sessionId = null;
        PendingPermission[] open = [];
        long revision;
        lock (_sync)
        {
            if (!_turns.TryGetValue(turnId, out var turn) || turn.Done) return;
            var waiting = _queue.FirstOrDefault(message => ReferenceEquals(message.Turn, turn));
            if (waiting is not null)
            {
                var kept = _queue.Where(message => !ReferenceEquals(message, waiting)).ToArray();
                _queue.Clear();
                foreach (var message in kept) _queue.Enqueue(message);
                EndTurn(turn, "cancelled");
            }
            else if (_working)
            {
                sessionId = _sessionId;
                open = _permissions.Values.ToArray();
            }
            revision = Touch();
        }
        Raise(revision);
        foreach (var permission in open) permission.Answer.TrySetResult(null);
        if (sessionId is null) return;
        try { await _connection.NotifyAsync("session/cancel", new { sessionId }); }
        catch (AcpConnectionClosedException) { }
    }

    /// <summary>Keep a view's message for after the turn that runs. Called under the lock.</summary>
    private void Enqueue(QueuedMessage message)
    {
        if (_queue.Count >= MaximumQueued)
            throw new NendoPreconditionException("agent-working", $"{MaximumQueued} messages already wait for the agent. Try again when it has answered some.");
        if (_queue.Count(waiting => string.Equals(waiting.From, message.From, StringComparison.Ordinal)) >= MaximumQueuedFromOneView)
            throw new NendoPreconditionException("agent-working", $"This view already has {MaximumQueuedFromOneView} messages waiting for the agent.");
        message.Turn = new Turn($"t{++_turnNumber}", long.MaxValue);
        _turns[message.Turn.Id] = message.Turn;
        _queue.Enqueue(message);
    }

    /// <summary>A waiting message's turn starts: its reply is what follows its entry. Called under the lock.</summary>
    private static Turn StartQueuedTurn(Turn turn, MutableEntry said)
    {
        turn.PromptOrder = said.Order;
        return turn;
    }

    /// <summary>Every waiting message ends unsent, with <paramref name="stopReason"/>. Called under the lock.</summary>
    private void DropQueue(string stopReason)
    {
        while (_queue.Count > 0)
        {
            var turn = _queue.Dequeue().Turn;
            turn.Reply = string.Empty;
            turn.StopReason = stopReason;
            turn.Done = true;
        }
    }

    /// <summary>A turn this conversation ran, by the ID <see cref="Prompt"/> answered.</summary>
    internal AgentTurnView ReadTurn(string turnId)
    {
        lock (_sync)
        {
            if (!_turns.TryGetValue(turnId, out var turn))
                throw new NendoPreconditionException("agent-turn-gone", "That message's turn is no longer kept. Read the conversation instead.");
            return new AgentTurnView(turn.Id, turn.Done, turn.Reply, turn.StopReason);
        }
    }

    /// <summary>Start keeping a turn whose message is <paramref name="said"/>. Called under the lock.</summary>
    private Turn BeginTurn(MutableEntry said)
    {
        var turn = new Turn($"t{++_turnNumber}", said.Order);
        _turns[turn.Id] = turn;
        if (_turns.Count > MaximumTurns)
        {
            foreach (var old in _turns.Values.Where(candidate => candidate.Done).OrderBy(candidate => candidate.PromptOrder).Take(_turns.Count - MaximumTurns).ToArray())
                _turns.Remove(old.Id);
        }
        return turn;
    }

    /// <summary>
    /// End a turn: its reply is every agent message after its own, joined, bounded and redacted.
    /// Called under the lock.
    /// </summary>
    private void EndTurn(Turn turn, string stopReason)
    {
        var reply = new StringBuilder();
        foreach (var entry in _entries.Where(entry => entry.Kind == "agent" && entry.Order > turn.PromptOrder))
        {
            if (reply.Length > 0) reply.Append("\n\n");
            reply.Append(entry.Text);
            if (reply.Length > MaximumReplyCharacters) { reply.Length = MaximumReplyCharacters; break; }
        }
        turn.Reply = Redact(reply.ToString());
        turn.StopReason = stopReason;
        turn.Done = true;
    }

    private sealed class Turn(string id, long promptOrder)
    {
        internal string Id { get; } = id;
        internal long PromptOrder { get; set; } = promptOrder;
        internal bool Done { get; set; }
        internal string? Reply { get; set; }
        internal string? StopReason { get; set; }
    }
}
