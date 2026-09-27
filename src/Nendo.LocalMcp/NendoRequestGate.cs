namespace Nendo.LocalMcp;

/// <summary>
/// How many requests this host serves at once, and for how long one may run.
/// <para>
/// Nothing bounded either until 2026-09-27: the Engine's one write gate was the only brake,
/// so a client that opened requests without finishing them held buffers and threads for as
/// long as it liked (F-182). A request past the bound is refused by name before its body is
/// read; one that outlives the timeout is cancelled and answered by name.
/// </para>
/// </summary>
internal sealed class NendoRequestGate(int maximum, TimeSpan timeout)
{
    /// <summary>The default bound on requests in flight at once.</summary>
    internal const int DefaultMaximum = 16;

    /// <summary>The default time a request may take, its body included.</summary>
    internal static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);

    private int _inFlight;

    internal int Maximum => maximum;

    internal TimeSpan Timeout => timeout;

    internal int InFlight => Volatile.Read(ref _inFlight);

    internal bool TryEnter()
    {
        if (Interlocked.Increment(ref _inFlight) <= maximum) return true;
        Interlocked.Decrement(ref _inFlight);
        return false;
    }

    internal void Exit() => Interlocked.Decrement(ref _inFlight);
}
