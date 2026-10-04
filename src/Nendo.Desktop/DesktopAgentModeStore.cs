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

    private readonly DesktopKeyedFileStore<StoredMode> _files = new(root, "agent-modes", MaximumFiles,
        entry => entry.UsedAt, entry => entry is { Mode: { Length: > 0 }, Instance: { Length: > 0 } });

    private Dictionary<string, StoredMode> Read() => _files.Read();

    // Best effort, like every device-state write: a level that could not be kept is still the
    // level for this run, and the next open starts at Off as it always did.
    private void Write(Dictionary<string, StoredMode> entries) => _files.Write(entries);

    private static string? Label(string? fileName) => DesktopStateFile.FileLabel(fileName);

    private sealed record StoredMode(string Mode, string Instance, string? Name, DateTimeOffset UsedAt);
}
