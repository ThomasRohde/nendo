using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// Which file instance keeps its views' storage across the change of the view origin's key
/// (ADR-0013). The key gained the instance ID, which moved every view to a new origin;
/// for each application, the instance this device opened most recently keeps the origin it had,
/// so the owner's own views keep their drafts at the upgrade.
/// <para>
/// The choice is made once, on the first start of a host that has this key, from the recent-file
/// list before the file being opened is recorded in it, and kept as <c>view-origin-carry.json</c>
/// in device state. It is never written again: a Duplicate made afterwards has a new instance ID,
/// so it is never the one named, and its views start on storage of their own.
/// </para>
/// </summary>
internal sealed class ExtensionOriginCarry(string deviceStateRoot, Func<IReadOnlyDictionary<string, string>?> latestInstances)
{
    internal const string FileName = "view-origin-carry.json";
    private const int MaximumBytes = 64 * 1024;
    private const int MaximumEntries = 256;
    private static readonly IReadOnlyDictionary<string, string> None = new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly string _root = Path.GetFullPath(deviceStateRoot);
    private readonly object _sync = new();
    private IReadOnlyDictionary<string, string>? _holders;

    private string StatePath => Path.Combine(_root, FileName);

    /// <summary>Whether <paramref name="instanceId"/> is the instance of <paramref name="applicationId"/> that keeps the origin it had.</summary>
    internal bool Holds(string applicationId, string instanceId) =>
        Holders().TryGetValue(applicationId, out var holder) && string.Equals(holder, instanceId, StringComparison.Ordinal);

    /// <summary>The instance that keeps its origin, by application ID: read once, written once.</summary>
    internal IReadOnlyDictionary<string, string> Holders()
    {
        lock (_sync)
        {
            if (_holders is not null) return _holders;
            try
            {
                using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
                if (File.Exists(StatePath)) return _holders = ReadKept();
                // The list cannot be read just now: decide at a later start rather than on a passing failure.
                if (latestInstances() is not { } latest) return None;
                var kept = latest.Take(MaximumEntries).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
                DesktopStateFile.Replace(_root, StatePath, "view-origin-carry",
                    stream => JsonSerializer.Serialize(stream, new StoredCarry(1, kept)));
                return _holders = kept;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                return None;
            }
        }
    }

    private IReadOnlyDictionary<string, string> ReadKept()
    {
        try
        {
            var stored = DesktopStateFile.Read<StoredCarry>(StatePath, MaximumBytes, 4);
            if (stored is not { Version: 1, Holders: { } holders } || holders.Count > MaximumEntries) return None;
            return holders
                .Where(pair => pair.Key is { Length: > 0 and <= 200 } && pair.Value is { Length: > 0 and <= 200 })
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            // Kept but unreadable: every file takes the new key; the document is not written again.
            return None;
        }
    }

    private sealed record StoredCarry(int Version, Dictionary<string, string>? Holders);
}
