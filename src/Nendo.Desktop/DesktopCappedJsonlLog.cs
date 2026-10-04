using System.Text;
using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// A device-local file of one JSON entry per line that keeps only the newest
/// <paramref name="maximumEntries"/> and fails soft: a write that cannot happen returns false,
/// and a line that cannot be read is skipped. The view-failure and agent-failure logs are both
/// one of these.
/// </summary>
internal sealed class DesktopCappedJsonlLog<T>(string root, string stem, int maximumEntries) where T : class
{
    private readonly string _root = Path.GetFullPath(root);

    internal string LogPath => Path.Combine(_root, stem + ".jsonl");

    /// <summary>Appends one entry, keeping the newest. Returns whether it was written.</summary>
    internal bool Record(T entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            Directory.CreateDirectory(_root);
            var kept = Read().TakeLast(maximumEntries - 1).ToList();
            kept.Add(entry);
            var text = new StringBuilder();
            foreach (var line in kept) text.Append(JsonSerializer.Serialize(line)).Append('\n');
            var stage = Path.Combine(_root, $"{stem}-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(stage, text.ToString(), new UTF8Encoding(false));
            File.Move(stage, LogPath, overwrite: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return false;
        }
    }

    /// <summary>What has been recorded, oldest first. An unreadable line is skipped rather than fatal.</summary>
    internal IReadOnlyList<T> Read()
    {
        try
        {
            if (!File.Exists(LogPath)) return [];
            var entries = new List<T>();
            foreach (var line in File.ReadAllLines(LogPath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    if (JsonSerializer.Deserialize<T>(line) is { } entry) entries.Add(entry);
                }
                catch (JsonException) { }
            }
            return entries;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }
}
