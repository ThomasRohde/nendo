using System.Text;
using System.Text.Json;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

/// <summary>
/// A capped, device-local record of agent requests that failed inside Nendo, kept under
/// the same switch and the same bounds as <see cref="DesktopViewFailureLog"/>
/// (ADR-0002, 2026-09-27 amendment).
/// <para>
/// An agent told <c>NENDO_INTERNAL_ERROR</c> could report a type name and nothing else,
/// and the host kept nothing it could be matched against. Each line here carries the
/// reference the agent was given, the request, the exception types and the frames — no
/// exception message, no argument, no handle, no lease and no path. It keeps the newest
/// <see cref="MaximumEntries"/> lines and fails soft.
/// </para>
/// </summary>
internal sealed class DesktopAgentFailureLog(string root)
{
    internal const int MaximumEntries = 50;

    // Failures arrive on agent request threads, possibly two at once; the read, trim and
    // replace below must not interleave.
    private static readonly object Gate = new();

    private readonly string _root = Path.GetFullPath(root);

    internal string LogPath => Path.Combine(_root, "agent-failures.jsonl");

    /// <summary>Appends one failure, keeping the newest <see cref="MaximumEntries"/>. Returns whether it was written.</summary>
    internal bool Record(NendoAgentFailure failure)
    {
        ArgumentNullException.ThrowIfNull(failure);
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(_root);
                var kept = Read().TakeLast(MaximumEntries - 1).ToList();
                kept.Add(failure);
                var text = new StringBuilder();
                foreach (var entry in kept) text.Append(JsonSerializer.Serialize(entry)).Append('\n');
                var stage = Path.Combine(_root, $"agent-failures-{Guid.NewGuid():N}.tmp");
                File.WriteAllText(stage, text.ToString(), new UTF8Encoding(false));
                File.Move(stage, LogPath, overwrite: true);
                return true;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                return false;
            }
        }
    }

    /// <summary>What has been recorded, oldest first. An unreadable line is skipped rather than fatal.</summary>
    internal IReadOnlyList<NendoAgentFailure> Read()
    {
        try
        {
            if (!File.Exists(LogPath)) return [];
            var entries = new List<NendoAgentFailure>();
            foreach (var line in File.ReadAllLines(LogPath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    if (JsonSerializer.Deserialize<NendoAgentFailure>(line) is { } entry) entries.Add(entry);
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
