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

    /// <summary>
    /// Appends one entry, keeping the newest. Returns whether it was written.
    /// <para>
    /// Under the device-state lock for this log, across every Nendo on this computer: one failure
    /// can reach every window at once (a browser process they share exits), and each one read,
    /// appended and moved its copy over the others', so one line survived and the losers' stages
    /// were left behind (R2SP-06). The stage goes whatever happens, and the move waits out a reader.
    /// The lock is required: going ahead without it after a second, as a convenience document may,
    /// is how lines were still lost while several windows wrote at once on a busy disk. A line that
    /// cannot have the lock within its wait is not written, and the call says so.
    /// </para>
    /// </summary>
    internal bool Record(T entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            Directory.CreateDirectory(_root);
            using var guard = DesktopDeviceStateLock.EnterRequired(LogPath);
            var kept = Read().TakeLast(maximumEntries - 1).ToList();
            kept.Add(entry);
            var text = new StringBuilder();
            foreach (var line in kept) text.Append(JsonSerializer.Serialize(line)).Append('\n');
            var bytes = new UTF8Encoding(false).GetBytes(text.ToString());
            DesktopStateFile.Replace(_root, LogPath, stem, stream => stream.Write(bytes));
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
            // Shared for delete, as every device-state reader is, so a window reading the log never
            // blocks another's replacement of it (R2SP-07).
            using var stream = new FileStream(LogPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            using var reader = new StreamReader(stream, new UTF8Encoding(false));
            while (reader.ReadLine() is { } line)
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
