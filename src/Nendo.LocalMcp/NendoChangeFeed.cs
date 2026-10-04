using System.Threading.Channels;

namespace Nendo.LocalMcp;

/// <summary>
/// The three facts worth pushing instead of polling (W-151): a commit moved the manifest,
/// the proposal queue changed, and the file is closing. Each open <c>subscriptions/listen</c>
/// stream holds one <see cref="Listener"/>; the Engine's commit event, the proposal store
/// and the host's close each signal a URI, and the stream's handler sends
/// <c>resources/updated</c> for the ones its client asked for.
/// </summary>
internal sealed class NendoChangeFeed
{
    internal const string Manifest = "nendo://application/manifest";
    internal const string Proposals = "nendo://application/proposals";
    internal const string Health = "nendo://application/health";

    /// <summary>The URIs a listen stream can be told about. Every other subscription is acknowledged out.</summary>
    internal static readonly IReadOnlyList<string> Served = [Manifest, Proposals, Health];

    /// <summary>
    /// How many listen streams this host holds open at once. Each holds one of the request
    /// gate's places for as long as it lives, so the cap keeps most of the gate for calls.
    /// </summary>
    internal const int MaximumListeners = 4;

    private readonly object _gate = new();
    private readonly List<Listener> _listeners = [];
    private bool _closed;

    internal int Count { get { lock (_gate) return _listeners.Count; } }

    /// <summary>A new listener, or null when the host already holds <see cref="MaximumListeners"/> or is closing.</summary>
    internal Listener? TryOpen()
    {
        lock (_gate)
        {
            if (_closed || _listeners.Count >= MaximumListeners) return null;
            var listener = new Listener(this);
            _listeners.Add(listener);
            return listener;
        }
    }

    /// <summary>Tells every open stream that these resources changed. Never blocks the caller.</summary>
    internal void Signal(params string[] uris)
    {
        Listener[] listeners;
        lock (_gate) listeners = [.. _listeners];
        foreach (var listener in listeners)
            foreach (var uri in uris)
                listener.Writer.TryWrite(uri);
    }

    /// <summary>The file is closing: health changed, and every stream ends after saying so.</summary>
    internal void Close()
    {
        Listener[] listeners;
        lock (_gate)
        {
            _closed = true;
            listeners = [.. _listeners];
        }
        foreach (var listener in listeners)
        {
            listener.Writer.TryWrite(Health);
            listener.Writer.TryComplete();
        }
    }

    private void Remove(Listener listener)
    {
        lock (_gate) _listeners.Remove(listener);
    }

    internal sealed class Listener : IDisposable
    {
        private readonly NendoChangeFeed _feed;
        private readonly Channel<string> _channel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });

        internal Listener(NendoChangeFeed feed) => _feed = feed;

        internal ChannelWriter<string> Writer => _channel.Writer;

        internal ChannelReader<string> Reader => _channel.Reader;

        public void Dispose()
        {
            _channel.Writer.TryComplete();
            _feed.Remove(this);
        }
    }
}
