using System.Text.Json;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

internal sealed record DesktopAgentSettingsView(
    bool LeaseExpiry,
    int LeaseExpirySeconds,
    bool FixedPort,
    int Port,
    bool Persisted,
    string? Notice);

// Device preference only, never application data. The defaults are the single-user local ones: a predictable
// port so a saved client configuration keeps working, and no lease expiry so an in-flight draft cannot die
// mid-conversation. Each can be hardened again by choice.
internal sealed class DesktopAgentSettingsStore
{
    private const int MaximumBytes = 4096;
    internal const int MinimumExpirySeconds = 15;
    internal const int MaximumExpirySeconds = 86400;

    private readonly string _root;
    private string StatePath => Path.Combine(_root, "agent-settings.json");

    internal bool LeaseExpiry { get; private set; }
    internal int LeaseExpirySeconds { get; private set; } = 60;
    internal bool FixedPort { get; private set; } = true;
    internal int Port { get; private set; } = NendoLocalMcpHostOptions.StandardPort;
    internal bool Persisted { get; private set; } = true;
    internal string? Notice { get; private set; }

    internal DesktopAgentSettingsStore(string root)
    {
        _root = Path.GetFullPath(root);
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) throw new JsonException("Agent settings document exceeds its limit.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var document = JsonSerializer.Deserialize<StoredAgentSettings>(bytes, new JsonSerializerOptions { MaxDepth = 4 });
            if (document?.Version != 1
                || !IsExpirySeconds(document.LeaseExpirySeconds)
                || !IsPort(document.Port))
            {
                throw new JsonException("Unsupported agent settings document.");
            }
            LeaseExpiry = document.LeaseExpiry;
            LeaseExpirySeconds = document.LeaseExpirySeconds;
            FixedPort = document.FixedPort;
            Port = document.Port;
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Persisted = false;
            Notice = "The saved agent connection settings could not be read. Using the local defaults for this session.";
        }
    }

    internal DesktopAgentSettingsView View() => new(
        LeaseExpiry, LeaseExpirySeconds, FixedPort, Port, Persisted, Notice);

    internal void Save(bool leaseExpiry, int leaseExpirySeconds, bool fixedPort, int port)
    {
        if (!IsExpirySeconds(leaseExpirySeconds))
        {
            throw new NendoValidationException(
                $"Choose a lease expiry between {MinimumExpirySeconds} and {MaximumExpirySeconds} seconds.");
        }
        if (!IsPort(port))
        {
            throw new NendoValidationException("Choose a port between 1024 and 65535.");
        }
        LeaseExpiry = leaseExpiry;
        LeaseExpirySeconds = leaseExpirySeconds;
        FixedPort = fixedPort;
        Port = port;

        string? ownedStage = null;
        try
        {
            Directory.CreateDirectory(_root);
            var stage = Path.Combine(_root, $"agent-settings-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                ownedStage = stage;
                JsonSerializer.Serialize(
                    stream,
                    new StoredAgentSettings(1, leaseExpiry, leaseExpirySeconds, fixedPort, port));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
            ownedStage = null;
            Persisted = true;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Persisted = false;
            Notice = "Connection settings applied for this session, but could not be saved for the next launch.";
        }
        finally
        {
            if (ownedStage is not null)
            {
                try { File.Delete(ownedStage); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private static bool IsExpirySeconds(int value) => value is >= MinimumExpirySeconds and <= MaximumExpirySeconds;

    private static bool IsPort(int value) => value is >= 1024 and <= 65535;

    // A document saved before 2026-09-13 also carries stableCredential; it is ignored on read.
    private sealed record StoredAgentSettings(
        int Version,
        bool LeaseExpiry,
        int LeaseExpirySeconds,
        bool FixedPort,
        int Port);
}
