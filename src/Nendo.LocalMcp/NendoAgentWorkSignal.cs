namespace Nendo.LocalMcp;

/// <summary>
/// Whether an agent is working on the open file right now, and what it is doing.
/// </summary>
/// <param name="Busy">True while at least one agent call is in flight.</param>
/// <param name="Client">
/// The display name of the client whose call started most recently, or the last one
/// seen while nothing is running. Never a handle, a lease or a pseudonym.
/// </param>
/// <param name="Activity">
/// The tool or resource name that call is for — <c>nendo.change_set.validate</c>,
/// <c>nendo://application/describe</c> — so a person can tell a read from a write.
/// Empty before the first call.
/// </param>
public sealed record NendoAgentWork(bool Busy, string Client, string Activity);

/// <summary>
/// The push half of agent presence. <see cref="NendoActivityLog"/> records what has
/// already happened; this says what is happening.
/// <para>
/// It exists because the host's pull path cannot answer the question while it matters.
/// An agent write holds the Engine's one gate for its whole duration, and asking who is
/// editing takes a semaphore the same write is holding, so the answer arrives after the
/// thing it describes has finished. A window with no way to say "an agent is writing to
/// this file" looks broken for exactly as long as the agent is useful.
/// </para>
/// <para>
/// Everything here is free of both gates on purpose. <see cref="Peek"/> reads two fields
/// under a short lock and does no I/O, so a window procedure may call it; the handler is
/// invoked on the agent's own request thread and must marshal and return, exactly like
/// the coordinator's commit event.
/// </para>
/// </summary>
public sealed class NendoAgentWorkSignal
{
    private readonly object _gate = new();
    private int _running;
    private string _client = string.Empty;
    private string _activity = string.Empty;
    private Action<NendoAgentWork>? _changed;

    /// <summary>
    /// The one owner of this signal, set by the host that started the listener. A single
    /// handler rather than an event, following the lease-ended handler: two subscribers
    /// would mean two things claiming to speak for the window.
    /// </summary>
    public void SetHandler(Action<NendoAgentWork>? handler)
    {
        lock (_gate) { _changed = handler; }
    }

    /// <summary>What the window would draw if it asked now. Takes no gate but its own.</summary>
    public NendoAgentWork Peek()
    {
        lock (_gate) { return new NendoAgentWork(_running > 0, _client, _activity); }
    }

    /// <summary>
    /// Brackets one agent call. The transport is stateless and several calls can overlap,
    /// so this counts rather than sets: busy stays true until the last one finishes, and a
    /// call that throws still ends its own bracket.
    /// </summary>
    internal IDisposable Begin(string client, string activity)
    {
        NendoAgentWork announced;
        lock (_gate)
        {
            _running++;
            _client = Bounded(client, 120);
            _activity = Bounded(activity, 180);
            announced = new NendoAgentWork(true, _client, _activity);
        }
        Announce(announced);
        return new Scope(this);
    }

    private void End()
    {
        NendoAgentWork announced;
        lock (_gate)
        {
            if (_running > 0) _running--;
            announced = new NendoAgentWork(_running > 0, _client, _activity);
        }
        Announce(announced);
    }

    /// <summary>
    /// Outside the lock, and never able to fail the request it is describing. A handler
    /// that threw here would turn a working agent call into a refused one, which is a
    /// worse outcome than a window that missed one update.
    /// </summary>
    private void Announce(NendoAgentWork work)
    {
        Action<NendoAgentWork>? handler;
        lock (_gate) { handler = _changed; }
        if (handler is null) return;
        try { handler(work); }
        catch (Exception) { }
    }

    private static string Bounded(string value, int maximum) =>
        new(value.Where(character => !char.IsControl(character)).Take(maximum).ToArray());

    private sealed class Scope(NendoAgentWorkSignal owner) : IDisposable
    {
        private int _ended;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _ended, 1) == 0) owner.End();
        }
    }
}
