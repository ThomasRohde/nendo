using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// The agent access level each file was last given on this device (ADR-0009, 2026-09-29
/// amendment, W-126).
/// <para>
/// Every file session began at Off, so a person who works with an agent set the level again on
/// each open. Now the level a person chooses for a file is kept here, and the same file opens at
/// it again. Keyed by the application ID and the file's instance ID together (W-216, DSH-10): a
/// Duplicate, a Fork or a new file of the application is a new instance and begins at Off, and a
/// level chosen for one of them, Off included, leaves the original's alone, so the level stays
/// with the file the person chose it for and never travels. A copy made outside Nendo keeps the instance ID, and is the same
/// file here, as a moved one is. Device state only: the file never carries it.
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
        var modes = Read();
        if (modes.TryGetValue(Key(applicationId, instanceId), out var kept)) return kept.Mode;
        // A document written before the instance was part of the key keeps one entry per
        // application, which is this file's only while its instance matches.
        return modes.TryGetValue(applicationId, out var legacy) && string.Equals(legacy.Instance, instanceId, StringComparison.Ordinal)
            ? legacy.Mode
            : null;
    }

    /// <summary>Keeps the level chosen for this file; Off, or null, forgets it.</summary>
    internal void Remember(string applicationId, string instanceId, string? fileName, string? mode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        using var guard = DesktopDeviceStateLock.Enter("agent-modes");
        var modes = Read();
        // The old one-per-application entry moves to this file's own key, or goes with an Off,
        // but only when it was this file's: another instance's level is never touched.
        if (modes.TryGetValue(applicationId, out var legacy) && string.Equals(legacy.Instance, instanceId, StringComparison.Ordinal))
            modes.Remove(applicationId);
        var key = Key(applicationId, instanceId);
        if (mode is null or "off") modes.Remove(key);
        else modes[key] = new StoredMode(mode, instanceId, Label(fileName), DateTimeOffset.UtcNow);
        Write(modes);
    }

    /// <summary>
    /// The instance this list says keeps a level for the application: the one its older single
    /// entry was kept for, or else the only instance with an entry of its own. Null when it says
    /// nothing, or names several. It tells an older one-per-application port whose it was.
    /// </summary>
    internal string? InstanceOf(string applicationId)
    {
        if (string.IsNullOrWhiteSpace(applicationId)) return null;
        var modes = Read();
        if (modes.TryGetValue(applicationId, out var legacy)) return legacy.Instance;
        var prefix = applicationId + "\n";
        var instances = modes.Where(pair => pair.Key.StartsWith(prefix, StringComparison.Ordinal))
            .Select(pair => pair.Value.Instance).Distinct(StringComparer.Ordinal).Take(2).ToList();
        return instances.Count == 1 ? instances[0] : null;
    }

    /// <summary>One file's entry: its application and its instance, joined by a character neither identifier holds.</summary>
    private static string Key(string applicationId, string instanceId) => applicationId + "\n" + instanceId;

    private readonly DesktopKeyedFileStore<StoredMode> _files = new(root, "agent-modes", MaximumFiles,
        entry => entry.UsedAt, entry => entry is { Mode: { Length: > 0 }, Instance: { Length: > 0 } });

    private Dictionary<string, StoredMode> Read() => _files.Read();

    // Best effort, like every device-state write: a level that could not be kept is still the
    // level for this run, and the next open starts at Off as it always did.
    private void Write(Dictionary<string, StoredMode> entries) => _files.Write(entries);

    private static string? Label(string? fileName) => DesktopStateFile.FileLabel(fileName);

    private sealed record StoredMode(string Mode, string Instance, string? Name, DateTimeOffset UsedAt);
}
