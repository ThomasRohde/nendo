using System.Text.Json;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

// Device preference only, never application data. The defaults are the single-user local ones: a predictable
// port so a saved client configuration keeps working, and no lease expiry so an in-flight draft cannot die
// mid-conversation. Each can be hardened again by choice.
internal sealed class DesktopAgentSettingsStore
{
    private const int MaximumBytes = 4096;
    internal const int MinimumExpirySeconds = 15;
    internal const int MaximumExpirySeconds = 86400;

    private readonly string _root;
    private string Folder => DesktopDeviceStateLayout.Agents(_root);
    private string StatePath => Path.Combine(Folder, "connection.json");
    private bool _pendingLeaseExpiry;
    private bool _pendingLeaseExpirySeconds;
    private bool _pendingFixedPort;
    private bool _pendingPort;
    // The document was read but holds nothing usable, so a save replaces it whole.
    private bool _unusableDocument;

    internal bool LeaseExpiry { get; private set; }
    internal int LeaseExpirySeconds { get; private set; } = 60;
    internal bool FixedPort { get; private set; } = DefaultFixedPort;
    internal int Port { get; private set; } = NendoLocalMcpHostOptions.StandardPort;
    internal bool Persisted { get; private set; } = true;
    internal string? Notice { get; private set; }

    /// <summary>
    /// A kept port, the single-user local default, unless the process owner said the system
    /// picks them (<see cref="DesktopRuntimeConfiguration.AgentPortsBySystem"/>).
    /// </summary>
    internal static bool DefaultFixedPort
    {
        get
        {
            try { return !DesktopRuntimeConfiguration.AgentPortsBySystem; }
            catch (NendoValidationException) { return true; }
        }
    }

    internal DesktopAgentSettingsStore(string root)
    {
        _root = Path.GetFullPath(root);
        try
        {
            var bytes = DesktopStateFile.ReadBytes(StatePath, MaximumBytes, "Agent settings document exceeds its limit.");
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
            _unusableDocument = exception is JsonException;
            Persisted = false;
            Notice = "The saved agent connection settings could not be read. Using the local defaults for this session.";
        }
    }

    /// <summary>
    /// Reads the document again, keeping only this window's choices that could not be saved.
    /// <para>
    /// The settings are the device's, and every open file is a window of its own. This store was
    /// read once per window, so a lease expiry or a Fixed port choice saved in one window never
    /// reached a listener another window started later, nor its Agent page. The window
    /// refreshes before each listener start and each status read: the document is 4 KB at most.
    /// </para>
    /// </summary>
    internal void Refresh()
    {
        var latest = new DesktopAgentSettingsStore(_root);
        // A read that failed says nothing about the device's settings: the window keeps the ones it
        // last read rather than falling back to the defaults, which would quietly turn a chosen
        // lease expiry off and move the port.
        if (!latest.Persisted) return;
        if (!(_pendingLeaseExpiry || _pendingLeaseExpirySeconds || _pendingFixedPort || _pendingPort))
        {
            LeaseExpiry = latest.LeaseExpiry;
            LeaseExpirySeconds = latest.LeaseExpirySeconds;
            FixedPort = latest.FixedPort;
            Port = latest.Port;
            Persisted = true;
            Notice = null;
            _unusableDocument = false;
            return;
        }
        // A session choice that could not be saved stays this window's until a save lands; the
        // rest follows the device. The notice that says the choice is this session's stays too.
        if (!_pendingLeaseExpiry) LeaseExpiry = latest.LeaseExpiry;
        if (!_pendingLeaseExpirySeconds) LeaseExpirySeconds = latest.LeaseExpirySeconds;
        if (!_pendingFixedPort) FixedPort = latest.FixedPort;
        if (!_pendingPort) Port = latest.Port;
    }

    internal void Save(bool leaseExpiry, int leaseExpirySeconds, bool fixedPort, int port)
    {
        Validate(leaseExpirySeconds, port);
        // The page submits all four controls. Only differences from this window's
        // last view express an edit; its unchanged controls may already be stale.
        // An unsaved session choice remains an edit on an identical retry.
        var changeExpiry = _pendingLeaseExpiry |= leaseExpiry != LeaseExpiry;
        var changeSeconds = _pendingLeaseExpirySeconds |= leaseExpirySeconds != LeaseExpirySeconds;
        var changeFixed = _pendingFixedPort |= fixedPort != FixedPort;
        var changePort = _pendingPort |= port != Port;
        LeaseExpiry = leaseExpiry;
        LeaseExpirySeconds = leaseExpirySeconds;
        FixedPort = fixedPort;
        Port = port;

        try
        {
            using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
            var latest = new DesktopAgentSettingsStore(_root);
            // A corrupt or unsupported document holds no other window's choice, so this
            // window's values repair it. One that could not be opened may still hold one.
            if (!latest.Persisted && !latest._unusableDocument) throw new IOException("The shared agent settings could not be read for merging.");
            var merge = latest.Persisted;
            LeaseExpiry = changeExpiry || !merge ? leaseExpiry : latest.LeaseExpiry;
            LeaseExpirySeconds = changeSeconds || !merge ? leaseExpirySeconds : latest.LeaseExpirySeconds;
            FixedPort = changeFixed || !merge ? fixedPort : latest.FixedPort;
            Port = changePort || !merge ? port : latest.Port;
            DesktopStateFile.Replace(Folder, StatePath, "connection", stream => JsonSerializer.Serialize(
                stream,
                new StoredAgentSettings(1, LeaseExpiry, LeaseExpirySeconds, FixedPort, Port)));
            _pendingLeaseExpiry = _pendingLeaseExpirySeconds = _pendingFixedPort = _pendingPort = false;
            Persisted = true;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Persisted = false;
            Notice = "Connection settings applied for this session, but could not be saved for the next launch.";
        }
    }

    internal static void Validate(int leaseExpirySeconds, int port)
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
    }

    private static bool IsExpirySeconds(int value) => value is >= MinimumExpirySeconds and <= MaximumExpirySeconds;

    private static bool IsPort(int value) => value is >= 1024 and <= 65535;

    // An older document may also carry stableCredential; it is ignored on read.
    private sealed record StoredAgentSettings(
        int Version,
        bool LeaseExpiry,
        int LeaseExpirySeconds,
        bool FixedPort,
        int Port);
}
