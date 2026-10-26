namespace Nendo.Engine;

/// <summary>
/// The file primitives of the browser host (ADR-0036). A page's file system is in memory and
/// belongs to this one process, so a file's identity, an instance's ownership and a verified move
/// are kept here, where Windows keeps them in the kernel. Nothing outside the page can replace a
/// file in it, so a path's identity lasts until the Engine itself moves or deletes the file.
/// </summary>
internal static class BrowserFileSystem
{
    private static readonly AsyncLocal<bool?> Forced = new();
    private static readonly Lock Gate = new();
    private static readonly Dictionary<string, ulong> Indexes = new(StringComparer.Ordinal);
    private static readonly HashSet<string> HeldInstances = new(StringComparer.Ordinal);
    private static ulong _lastIndex;

    /// <summary>Whether the Engine is running in a browser page, or a test has asked for its primitives.</summary>
    internal static bool Active => Forced.Value ?? OperatingSystem.IsBrowser();

    /// <summary>Uses the browser primitives in this async flow, so they can be exercised on Windows.</summary>
    internal static IDisposable Use()
    {
        var prior = Forced.Value;
        Forced.Value = true;
        return new Restore(prior);
    }

    internal static LocalFileIdentity Identity(FileStream file)
    {
        var path = Path.GetFullPath(file.Name);
        lock (Gate)
        {
            if (!Indexes.TryGetValue(path, out var index)) Indexes[path] = index = ++_lastIndex;
            return new(0, index, InPage: true);
        }
    }

    internal static void Moved(string from, string to)
    {
        lock (Gate)
        {
            Indexes.Remove(Path.GetFullPath(to));
            if (Indexes.Remove(Path.GetFullPath(from), out var index)) Indexes[Path.GetFullPath(to)] = index;
        }
    }

    internal static void Deleted(string path)
    {
        lock (Gate) Indexes.Remove(Path.GetFullPath(path));
    }

    internal static bool TryHold(string instanceId)
    {
        lock (Gate) return HeldInstances.Add(instanceId);
    }

    internal static void Release(string instanceId)
    {
        lock (Gate) HeldInstances.Remove(instanceId);
    }

    private sealed class Restore(bool? prior) : IDisposable
    {
        public void Dispose() => Forced.Value = prior;
    }
}
