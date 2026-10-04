using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// A device-state document that keeps one entry per file, keyed by application ID, and forgets
/// the entry unused for longest once it holds <paramref name="maximumFiles"/>. The agent port
/// and the agent access level each file keeps are both one of these.
/// <para>
/// Best effort, like every device-state store: a document that cannot be read is an empty one,
/// and one that cannot be written leaves the previous one in place.
/// </para>
/// </summary>
internal sealed class DesktopKeyedFileStore<T>(
    string root,
    string stem,
    int maximumFiles,
    Func<T, DateTimeOffset> usedAt,
    Func<T, bool> usable) where T : class
{
    private const int MaximumBytes = 128 * 1024;

    private string StatePath => Path.Combine(root, stem + ".json");

    /// <summary>The usable entries, by application ID.</summary>
    internal Dictionary<string, T> Read()
    {
        try
        {
            var saved = DesktopStateFile.Read<StoredFiles>(StatePath, MaximumBytes, maximumDepth: 6);
            if (saved is not { Version: 1, Files: { } files }) return [];
            return files
                .Where(pair => !string.IsNullOrWhiteSpace(pair.Key) && pair.Value is not null && usable(pair.Value))
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return [];
        }
    }

    /// <summary>Keeps the most recently used entries, up to the cap.</summary>
    internal void Write(Dictionary<string, T> entries)
    {
        var kept = entries
            .OrderByDescending(pair => usedAt(pair.Value))
            .Take(maximumFiles)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        DesktopStateFile.TryReplace(root, StatePath, stem, stream => JsonSerializer.Serialize(stream, new StoredFiles(1, kept)));
    }

    private sealed record StoredFiles(int Version, Dictionary<string, T> Files);
}
