using System.Text.Json.Nodes;
using System.Threading.Channels;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// The three facts worth pushing instead of polling (W-151): a commit moved the manifest,
/// the proposal queue changed, and the file is closing. Each open <c>subscriptions/listen</c>
/// stream holds one <see cref="Listener"/>; the Engine's commit event, the proposal store
/// and the host's close each signal a URI, and the stream's handler sends
/// <c>resources/updated</c> for the ones its client asked for.
/// <para>
/// A stream may also ask for one record type's records, <c>nendo://application/entity/{entityId}/records</c>
/// (W-171). It is told when a commit changes a record of that type, or changes the definition,
/// and the notification's <c>_meta</c> names the records under <see cref="ChangesMetaKey"/>, so
/// a client waiting on a button's request reads that record instead of paging the type.
/// </para>
/// </summary>
internal sealed class NendoChangeFeed
{
    internal const string Manifest = "nendo://application/manifest";
    internal const string Proposals = "nendo://application/proposals";
    internal const string Health = "nendo://application/health";

    /// <summary>The fixed URIs a listen stream can be told about, besides any record type's records.</summary>
    internal static readonly IReadOnlyList<string> Served = [Manifest, Proposals, Health];

    /// <summary>The <c>_meta</c> key a records notification names its changes under.</summary>
    internal const string ChangesMetaKey = "io.github.thomasrohde.nendo/changes";

    /// <summary>The most record IDs one notification names; past it, <c>truncated</c> says to read the type.</summary>
    internal const int MaximumNamedRecords = 100;

    private const string RecordsPrefix = "nendo://application/entity/";
    private const string RecordsSuffix = "/records";

    /// <summary>The record type a records URI names, or null when the URI is not one.</summary>
    internal static string? RecordsEntity(string uri)
    {
        if (!uri.StartsWith(RecordsPrefix, StringComparison.Ordinal) || !uri.EndsWith(RecordsSuffix, StringComparison.Ordinal)) return null;
        var entityId = uri[RecordsPrefix.Length..^RecordsSuffix.Length];
        return entityId.Length is > 0 and <= 200 && entityId.IndexOfAny(['/', '?', '#', '{', '}']) < 0 ? entityId : null;
    }

    internal static string RecordsUri(string entityId) => RecordsPrefix + entityId + RecordsSuffix;

    /// <summary>
    /// What a records notification for <paramref name="entityId"/> says about one commit, or null
    /// when the commit changed neither a record of that type nor the definition.
    /// </summary>
    internal static JsonObject? RecordsMeta(NendoCommitSummary summary, string entityId)
    {
        var records = summary.Records.Where(record => record.EntityId == entityId).Select(record => record.RecordId).ToArray();
        if (records.Length == 0 && !summary.DefinitionChanged) return null;
        return new JsonObject
        {
            [ChangesMetaKey] = new JsonObject
            {
                ["changeSequence"] = summary.ChangeSequence,
                ["revisionIds"] = new JsonArray([.. summary.RevisionIds.Select(id => (JsonNode)JsonValue.Create(id)!)]),
                ["entityId"] = entityId,
                ["recordIds"] = new JsonArray([.. records.Take(MaximumNamedRecords).Select(id => (JsonNode)JsonValue.Create(id)!)]),
                ["truncated"] = records.Length > MaximumNamedRecords,
                ["definitionChanged"] = summary.DefinitionChanged,
            },
        };
    }

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
                listener.Offer(new Change(uri, null));
    }

    /// <summary>Tells every open stream what a commit changed; each sends it for the record types it asked about.</summary>
    internal void SignalChanges(NendoCommitSummary summary)
    {
        Listener[] listeners;
        lock (_gate) listeners = [.. _listeners];
        foreach (var listener in listeners)
            listener.Offer(new Change(null, summary));
    }

    /// <summary>
    /// The most changes one stream holds unsent. A client that keeps its stream open and stops
    /// reading held a queue that grew with every commit for the connection's life (MTD-18). Past
    /// this the stream takes one last entry, <see cref="Change.Overflowed"/>, and ends: the client
    /// is then told that every resource it subscribed to changed, so it reads them again rather
    /// than missing a change it was never told it had missed, and it subscribes again.
    /// </summary>
    internal const int MaximumQueuedChanges = 1024;

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
            listener.Writer.TryWrite(new Change(Health, null));
            listener.Writer.TryComplete();
        }
    }

    /// <summary>One thing a stream is told: a fixed URI that changed, or what a commit changed.</summary>
    internal readonly record struct Change(string? Uri, NendoCommitSummary? Summary)
    {
        /// <summary>The stream held too many unsent changes: every subscribed resource is to be read again, and the stream ends.</summary>
        internal bool Overflowed { get; init; }
    }

    /// <summary>
    /// The resources/updated notifications one change asks for on a stream that subscribed to
    /// <paramref name="honoured"/>, each a URI and the change's metadata for it, if any. An overflow
    /// names every honoured URI with no metadata, since what changed is no longer known.
    /// </summary>
    internal static IEnumerable<(string Uri, JsonObject? Changes)> Notifications(Change change, IReadOnlyList<string> honoured)
    {
        if (change.Overflowed)
        {
            foreach (var uri in honoured) yield return (uri, null);
            yield break;
        }
        if (change.Summary is { } summary)
        {
            foreach (var entityId in honoured.Select(RecordsEntity).OfType<string>())
                if (RecordsMeta(summary, entityId) is { } changes) yield return (RecordsUri(entityId), changes);
            yield break;
        }
        if (change.Uri is { } changed && honoured.Contains(changed, StringComparer.Ordinal)) yield return (changed, null);
    }

    private void Remove(Listener listener)
    {
        lock (_gate) _listeners.Remove(listener);
    }

    internal sealed class Listener : IDisposable
    {
        private readonly NendoChangeFeed _feed;
        // One place past the bound is kept for the overflow entry.
        private readonly Channel<Change> _channel = Channel.CreateBounded<Change>(
            new BoundedChannelOptions(MaximumQueuedChanges + 1) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        private readonly object _offering = new();

        internal Listener(NendoChangeFeed feed) => _feed = feed;

        internal ChannelWriter<Change> Writer => _channel.Writer;

        /// <summary>
        /// Queues a change without waiting. A stream already holding <see cref="MaximumQueuedChanges"/>
        /// takes the overflow entry instead, in the place kept for it, and ends after what it holds.
        /// </summary>
        internal void Offer(Change change)
        {
            lock (_offering)
            {
                if (_channel.Reader.Count < MaximumQueuedChanges && _channel.Writer.TryWrite(change)) return;
                if (_channel.Writer.TryWrite(new Change(null, null) { Overflowed = true })) _channel.Writer.TryComplete();
            }
        }

        internal ChannelReader<Change> Reader => _channel.Reader;

        public void Dispose()
        {
            _channel.Writer.TryComplete();
            _feed.Remove(this);
        }
    }
}
