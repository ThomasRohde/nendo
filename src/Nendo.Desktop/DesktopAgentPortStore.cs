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
/// Keyed by the application ID, so a file keeps its port when it is moved or renamed, and a
/// Fork, which is a new application, gets one of its own. Device state only: the file never
/// carries a port, and a list of files and their ports never leaves this computer. The name is
/// kept only to say whose a port is when a person asks for one that is taken.
/// </para>
/// </summary>
internal sealed class DesktopAgentPortStore(string root)
{
    /// <summary>How many files keep a port before the one unused for longest gives its up.</summary>
    internal const int MaximumFiles = 256;

    private const int MaximumBytes = 128 * 1024;

    private string StatePath => Path.Combine(root, "agent-ports.json");

    /// <summary>
    /// The port this file keeps. The first time a file asks, it is given the first port from
    /// <paramref name="basePort"/> that no other file keeps, and keeps it from then on.
    /// </summary>
    internal int Claim(string applicationId, string? fileName, int basePort)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        using var guard = DesktopDeviceStateLock.Enter("agent-ports");
        var ports = Read();
        var port = ports.TryGetValue(applicationId, out var kept) ? kept.Port : NextFree(ports, applicationId, basePort);
        ports[applicationId] = new StoredPort(port, Label(fileName) ?? kept?.Name, DateTimeOffset.UtcNow);
        Write(ports);
        return port;
    }

    /// <summary>What <see cref="Claim"/> would answer, without keeping anything.</summary>
    internal int Peek(string applicationId, int basePort)
    {
        var ports = Read();
        return ports.TryGetValue(applicationId, out var kept) ? kept.Port : NextFree(ports, applicationId, basePort);
    }

    /// <summary>
    /// Gives this file the port the person chose. Refused, naming the other file, when another
    /// file keeps it: two files told the same port would take turns being the one an agent reached.
    /// </summary>
    internal void Set(string applicationId, string? fileName, int port)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        if (port is < 1024 or > 65535) throw new NendoValidationException("Choose a port between 1024 and 65535.");
        using var guard = DesktopDeviceStateLock.Enter("agent-ports");
        var ports = Read();
        foreach (var (otherId, other) in ports)
        {
            if (other.Port != port || string.Equals(otherId, applicationId, StringComparison.Ordinal)) continue;
            var holder = other.Name ?? "another file";
            throw new NendoValidationException(
                $"Port {port} is kept for {holder}. Choose another port, or give {holder} a different one first.");
        }
        ports.TryGetValue(applicationId, out var kept);
        ports[applicationId] = new StoredPort(port, Label(fileName) ?? kept?.Name, DateTimeOffset.UtcNow);
        Write(ports);
    }

    private static int NextFree(Dictionary<string, StoredPort> ports, string applicationId, int basePort)
    {
        var taken = ports
            .Where(pair => !string.Equals(pair.Key, applicationId, StringComparison.Ordinal))
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

    private Dictionary<string, StoredPort> Read()
    {
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) return [];
            var saved = JsonSerializer.Deserialize<StoredPorts>(stream, new JsonSerializerOptions { MaxDepth = 6 });
            if (saved is not { Version: 1, Files: { } files }) return [];
            return files
                .Where(pair => !string.IsNullOrWhiteSpace(pair.Key) && pair.Value is { Port: >= 1024 and <= 65535 })
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return [];
        }
    }

    // Best effort, like every device-state write: a port that could not be kept is still the
    // port for this run, and the next run asks again.
    private void Write(Dictionary<string, StoredPort> ports)
    {
        var kept = ports
            .OrderByDescending(pair => pair.Value.UsedAt)
            .Take(MaximumFiles)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        string? stage = null;
        try
        {
            Directory.CreateDirectory(root);
            stage = Path.Combine(root, $"agent-ports-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, new StoredPorts(1, kept));
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

    private sealed record StoredPort(int Port, string? Name, DateTimeOffset UsedAt);

    private sealed record StoredPorts(int Version, Dictionary<string, StoredPort> Files);
}
