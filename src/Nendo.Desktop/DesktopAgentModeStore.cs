using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// The agent access level each file was last given on this device (ADR-0009, 2026-09-29
/// amendment, W-126).
/// <para>
/// Every file session began at Off, so a person who works with an agent set the level again on
/// each open. Now the level a person chooses for a file is kept here, and the same file opens at
/// it again. Keyed by the application ID, and kept with the file's instance ID: a copy, a
/// Duplicate or a Fork is a new instance and begins at Off, so the level stays with the file the
/// person chose it for and never travels. Device state only: the file never carries it.
/// </para>
/// </summary>
internal sealed class DesktopAgentModeStore(string root)
{
    /// <summary>How many files keep a level before the one unused for longest forgets its.</summary>
    internal const int MaximumFiles = 256;

    private const int MaximumBytes = 128 * 1024;

    private string StatePath => Path.Combine(root, "agent-modes.json");

    /// <summary>The level this instance of the file was last given, or null when it has none.</summary>
    internal string? Recall(string applicationId, string instanceId)
    {
        if (string.IsNullOrWhiteSpace(applicationId) || string.IsNullOrWhiteSpace(instanceId)) return null;
        return Read().TryGetValue(applicationId, out var kept) && string.Equals(kept.Instance, instanceId, StringComparison.Ordinal)
            ? kept.Mode
            : null;
    }

    /// <summary>Keeps the level chosen for this file; Off, or null, forgets it.</summary>
    internal void Remember(string applicationId, string instanceId, string? fileName, string? mode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        using var guard = DesktopDeviceStateLock.Enter("agent-modes");
        var modes = Read();
        if (mode is null or "off") modes.Remove(applicationId);
        else modes[applicationId] = new StoredMode(mode, instanceId, Label(fileName), DateTimeOffset.UtcNow);
        Write(modes);
    }

    private Dictionary<string, StoredMode> Read()
    {
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) return [];
            var saved = JsonSerializer.Deserialize<StoredModes>(stream, new JsonSerializerOptions { MaxDepth = 6 });
            if (saved is not { Version: 1, Files: { } files }) return [];
            return files
                .Where(pair => !string.IsNullOrWhiteSpace(pair.Key) && pair.Value is { Mode: { Length: > 0 }, Instance: { Length: > 0 } })
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return [];
        }
    }

    // Best effort, like every device-state write: a level that could not be kept is still the
    // level for this run, and the next open starts at Off as it always did.
    private void Write(Dictionary<string, StoredMode> modes)
    {
        var kept = modes
            .OrderByDescending(pair => pair.Value.UsedAt)
            .Take(MaximumFiles)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        string? stage = null;
        try
        {
            Directory.CreateDirectory(root);
            stage = Path.Combine(root, $"agent-modes-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, new StoredModes(1, kept));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
        finally
        {
            if (stage is not null)
            {
                try { File.Delete(stage); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private static string? Label(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return null;
        var name = Path.GetFileName(fileName.Trim());
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    private sealed record StoredMode(string Mode, string Instance, string? Name, DateTimeOffset UsedAt);

    private sealed record StoredModes(int Version, Dictionary<string, StoredMode> Files);
}
