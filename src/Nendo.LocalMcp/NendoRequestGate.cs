using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// How many requests this host serves at once, and for how long one may run.
/// <para>
/// Nothing bounded either until 2026-09-27: the Engine's one write gate was the only brake,
/// so a client that opened requests without finishing them held buffers and threads for as
/// long as it liked (F-182). One that outlives the timeout is cancelled and answered by name.
/// </para>
/// <para>
/// A request past the bound waits for a place, up to <see cref="QueueWait"/>, before its body
/// is read; only one that waits longer, or arrives while <see cref="MaximumWaiting"/> already
/// wait, is refused as busy. Until 2026-10-08 the seventeenth was refused at once, as HTTP 429:
/// a client that sent thirty calls in parallel read eleven of them as a broken connection
/// rather than as calls to repeat.
/// </para>
/// </summary>
internal sealed class NendoRequestGate(int maximum, TimeSpan timeout, TimeSpan queueWait, int maximumWaiting)
{
    /// <summary>The default bound on requests in flight at once, as the vocabulary publishes it.</summary>
    internal static readonly int DefaultMaximum = NendoAuthoringLimits.Current.RequestsInFlight;

    /// <summary>The default time a request may take, its body included.</summary>
    internal static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);

    /// <summary>The default time a request past the bound waits for a place.</summary>
    internal static readonly TimeSpan DefaultQueueWait = TimeSpan.FromSeconds(NendoAuthoringLimits.Current.RequestQueueSeconds);

    /// <summary>The default number of requests that may wait at once; past it the next is refused at once.</summary>
    internal const int DefaultMaximumWaiting = 64;

    private readonly SemaphoreSlim _places = new(maximum, maximum);
    private int _inFlight;
    private int _waiting;

    internal NendoRequestGate(int maximum, TimeSpan timeout)
        : this(maximum, timeout, DefaultQueueWait, DefaultMaximumWaiting)
    {
    }

    internal int Maximum => maximum;

    internal TimeSpan Timeout => timeout;

    internal TimeSpan QueueWait => queueWait;

    internal int MaximumWaiting => maximumWaiting;

    internal int InFlight => Volatile.Read(ref _inFlight);

    internal int Waiting => Volatile.Read(ref _waiting);

    /// <summary>
    /// Takes a place, waiting for one up to <see cref="QueueWait"/>. False when none came in
    /// time or too many already wait; the caller answers busy and holds nothing.
    /// </summary>
    internal async Task<bool> EnterAsync(CancellationToken cancellationToken)
    {
        if (_places.Wait(0))
        {
            Interlocked.Increment(ref _inFlight);
            return true;
        }
        if (Interlocked.Increment(ref _waiting) > maximumWaiting)
        {
            Interlocked.Decrement(ref _waiting);
            return false;
        }
        try
        {
            if (!await _places.WaitAsync(queueWait, cancellationToken)) return false;
            Interlocked.Increment(ref _inFlight);
            return true;
        }
        finally
        {
            Interlocked.Decrement(ref _waiting);
        }
    }

    internal void Exit()
    {
        Interlocked.Decrement(ref _inFlight);
        _places.Release();
    }
}
