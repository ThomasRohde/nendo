namespace Nendo.LocalMcp;

/// <summary>
/// The remembered results of one kind of authoring step, so an exact retry replays rather
/// than repeats. The newest <see cref="NendoReplayCache.Capacity"/> are kept and the oldest
/// fall away.
/// <para>
/// These lived in plain dictionaries for the life of the lease, and a lease has no expiry by
/// default, so a long session kept every begin, add, amend, validate, reject and accept it
/// ever made -- a validate's entry holding its whole preview (F-182). A retry arrives within
/// moments of the call it repeats; one arriving after 256 later calls of the same kind is
/// treated as a new call, which is what the contract says.
/// </para>
/// </summary>
internal sealed class NendoReplayCache<TKey, TValue>(int capacity = NendoReplayCache.Capacity)
    where TKey : notnull
{
    private readonly OrderedDictionary<TKey, TValue> _entries = new();

    internal int Count => _entries.Count;

    internal IEnumerable<TKey> Keys => _entries.Keys;

    internal bool TryGetValue(TKey key, out TValue value) => _entries.TryGetValue(key, out value!);

    /// <summary>Remembers one result, dropping the oldest once the cache is full.</summary>
    internal void Add(TKey key, TValue value)
    {
        _entries.Add(key, value);
        while (_entries.Count > capacity) _entries.RemoveAt(0);
    }

    internal bool Remove(TKey key) => _entries.Remove(key);

    /// <summary>Forgets every entry whose key matches, as a lease's end and an amend forget theirs.</summary>
    internal void RemoveWhere(Func<TKey, bool> predicate)
    {
        foreach (var key in _entries.Keys.Where(predicate).ToArray()) _entries.Remove(key);
    }

    internal void Clear() => _entries.Clear();
}

internal static class NendoReplayCache
{
    /// <summary>How many results of each kind a session's replays keep, per the MCP contract.</summary>
    internal const int Capacity = 256;
}
