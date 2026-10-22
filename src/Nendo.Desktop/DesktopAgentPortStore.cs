using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// The agent port each file keeps on this device.
/// <para>
/// There was one port for the device, 41763, and whichever file turned agent access on first
/// took it; every other file listened on a temporary port that changed with every run. An
/// agent registered as "nendo" therefore reached whichever file had opened first, and a
/// second file could not be registered at all. Now the first file to ask keeps the device's
/// port and each further file keeps the next free one, so each can be registered once, under
/// a name of its own, and reached whatever order the files open in.
/// </para>
/// <para>
/// Keyed by the application ID and the file's instance ID together, so a file keeps its port
/// when it is moved or renamed, and a Fork, a Duplicate or a new file of the application, each
/// a new instance, gets one of its own. Keyed by the application alone, a new file
/// made from Reading 2025.nendo was handed 2025's port, could not bind it, and a port chosen
/// for either moved the other's too. Device state only: the file never carries a port, and a
/// list of files and their ports never leaves this computer. The name is kept only to say whose
/// a port is when a person asks for one that is taken.
/// </para>
/// <para>
/// A list written before the instance was part of the key keeps one entry per application. It
/// goes, once, to the instance it evidently belonged to: the one the access-level list of the
/// same era names for that application, or else the file whose name it was kept under. Only when
/// neither says does the first instance to ask take it. Any other instance is given a port of
/// its own.
/// </para>
/// </summary>
internal sealed class DesktopAgentPortStore(string root)
{
    /// <summary>How many files keep a port before the one unused for longest gives its up.</summary>
    internal const int MaximumFiles = 256;

    /// <summary>
    /// The port this file keeps. The first time a file asks, it is given the first port from
    /// <paramref name="basePort"/> that no other file keeps, and keeps it from then on.
    /// </summary>
    internal int Claim(string applicationId, string instanceId, string? fileName, int basePort)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        using var guard = DesktopDeviceStateLock.Enter("agents.ports");
        var ports = Read();
        var key = Key(applicationId, instanceId);
        var kept = TakeOver(ports, applicationId, instanceId, fileName);
        var port = kept?.Port ?? NextFree(ports, key, basePort);
        ports[key] = new StoredPort(port, Label(fileName) ?? kept?.Name, DateTimeOffset.UtcNow);
        Write(ports);
        return port;
    }

    /// <summary>What <see cref="Claim"/> would answer, without keeping anything.</summary>
    internal int Peek(string applicationId, string instanceId, int basePort, string? fileName = null)
    {
        var ports = Read();
        var key = Key(applicationId, instanceId);
        if (ports.TryGetValue(key, out var kept)) return kept.Port;
        return ports.TryGetValue(applicationId, out var legacy) && IsThisFilesEntry(legacy, applicationId, instanceId, fileName)
            ? legacy.Port
            : NextFree(ports, key, basePort);
    }

    /// <summary>
    /// Gives this file the port the person chose. Refused, naming the other file, when another
    /// file keeps it: two files told the same port would take turns being the one an agent reached.
    /// </summary>
    internal void Set(string applicationId, string instanceId, string? fileName, int port)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        if (port is < 1024 or > 65535) throw new NendoValidationException("Choose a port between 1024 and 65535.");
        using var guard = DesktopDeviceStateLock.Enter("agents.ports");
        var ports = Read();
        var key = Key(applicationId, instanceId);
        var kept = TakeOver(ports, applicationId, instanceId, fileName);
        foreach (var (otherId, other) in ports)
        {
            if (other.Port != port || string.Equals(otherId, key, StringComparison.Ordinal)) continue;
            var holder = other.Name ?? "another file";
            throw new NendoValidationException(
                $"Port {port} is kept for {holder}. Choose another port, or give {holder} a different one first.");
        }
        ports[key] = new StoredPort(port, Label(fileName) ?? kept?.Name, DateTimeOffset.UtcNow);
        Write(ports);
    }

    /// <summary>One file's entry: its application and its instance, joined by a character neither identifier holds.</summary>
    private static string Key(string applicationId, string instanceId) => applicationId + "\n" + instanceId;

    /// <summary>
    /// This file's entry, taking over its application's entry from a list written before the
    /// instance was part of the key, when this file has none of its own yet and that entry was
    /// this file's (<see cref="IsThisFilesEntry"/>).
    /// </summary>
    private StoredPort? TakeOver(Dictionary<string, StoredPort> ports, string applicationId, string instanceId, string? fileName)
    {
        var key = Key(applicationId, instanceId);
        if (ports.TryGetValue(key, out var kept)) return kept;
        if (!ports.TryGetValue(applicationId, out var legacy) || !IsThisFilesEntry(legacy, applicationId, instanceId, fileName)) return null;
        ports.Remove(applicationId);
        ports[key] = legacy;
        return legacy;
    }

    /// <summary>
    /// Whether an application's one entry from before was this instance's: the access-level list
    /// names the instance it kept for that application, or, when it names none, the entry was kept
    /// under this file's name. With neither, nothing says otherwise, and it is.
    /// </summary>
    private bool IsThisFilesEntry(StoredPort legacy, string applicationId, string instanceId, string? fileName)
    {
        if (new DesktopAgentModeStore(root).InstanceOf(applicationId) is { } owner)
            return string.Equals(owner, instanceId, StringComparison.Ordinal);
        if (legacy.Name is { } name && Label(fileName) is { } label)
            return string.Equals(name, label, StringComparison.OrdinalIgnoreCase);
        return true;
    }

    private static int NextFree(Dictionary<string, StoredPort> ports, string key, int basePort)
    {
        var taken = ports
            .Where(pair => !string.Equals(pair.Key, key, StringComparison.Ordinal))
            .Select(pair => pair.Value.Port)
            .ToHashSet();
        for (var port = basePort; port <= 65535; port++)
        {
            if (!taken.Contains(port)) return port;
        }
        for (var port = 1024; port < basePort; port++)
        {
            if (!taken.Contains(port)) return port;
        }
        return basePort;
    }

    private readonly DesktopKeyedFileStore<StoredPort> _files = new(DesktopDeviceStateLayout.Agents(root), "ports", MaximumFiles,
        entry => entry.UsedAt, entry => entry.Port is >= 1024 and <= 65535);

    private Dictionary<string, StoredPort> Read() => _files.Read();

    // Best effort, like every device-state write: a port that could not be kept is still the
    // port for this run, and the next run asks again.
    private void Write(Dictionary<string, StoredPort> entries) => _files.Write(entries);

    private static string? Label(string? fileName) => DesktopStateFile.FileLabel(fileName);

    private sealed record StoredPort(int Port, string? Name, DateTimeOffset UsedAt);
}
