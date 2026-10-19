using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Nendo.LocalMcp;

/// <summary>
/// How a client reaches this host. Both MCP eras are accepted: an <c>initialize</c>
/// handshake on any protocol version the SDK supports, and the 2026-07-28
/// <c>server/discover</c> path with per-request metadata. The header and metadata
/// lists apply to the discover path only; a handshake client needs neither. There is
/// no credential: the loopback perimeter and the owner's access mode are the boundary.
/// </summary>
internal sealed record NendoDiscoveryProtocol(
    string ProtocolVersion,
    bool InitializeHandshake,
    string Discover,
    IReadOnlyList<string> RequiredHeaders,
    IReadOnlyList<string> RequiredRequestMetadata,
    string Notes);

/// <param name="DisplayName">
/// The name of the open file, as the window title shows it. With two Nendo
/// windows open, the advertisement otherwise answered "which endpoint" but not
/// "which file", and matching one to the other meant cross-referencing the
/// write-owner sidecar by process ID. This is a label, not a location: no
/// directory, and no path an agent could open. Agents never receive a database
/// path.
/// </param>
internal sealed record NendoDiscoveryDocument(
    int SchemaVersion,
    string Endpoint,
    string HostRunId,
    int ProcessId,
    DateTimeOffset CreatedAt,
    AgentAccessMode Mode,
    string ApplicationId,
    string InstanceId,
    string DisplayName)
{
    public NendoDiscoveryProtocol Protocol { get; init; } = NendoDiscoveryStore.Protocol;

    /// <summary>
    /// When the writing process started. A process ID alone is reused by Windows once its
    /// process ends, so a crashed Nendo's entry read as live under whatever took the number;
    /// the entry is trusted only while the process holding that ID started at this moment.
    /// Null in an entry from a host that predates it.
    /// </summary>
    public DateTimeOffset? ProcessStartedAt { get; init; }
}

/// <param name="IsThisOne">
/// Whether this entry is the host answering the read. There is always exactly one, and
/// it is the file every other call in this session acts on.
/// </param>
/// <param name="DisplayName">
/// The open file's name as the window title shows it, and nothing more. No directory and
/// no path: an agent is told which file is open, never where it lives.
/// </param>
internal sealed record NendoRunningInstance(
    string HostRunId,
    string Endpoint,
    string ApplicationId,
    string InstanceId,
    string DisplayName,
    AgentAccessMode Mode,
    DateTimeOffset StartedAt,
    bool IsThisOne);

/// <param name="Note">
/// What a client can actually do with this, said plainly, because the list invites a
/// question it cannot answer.
/// </param>
internal sealed record NendoRunningInstances(
    string Note,
    IReadOnlyList<NendoRunningInstance> Instances);

internal sealed class NendoDiscoveryStore(string root)
{
    private const int SchemaVersion = 1;
    private readonly string _root = Path.GetFullPath(root);

    internal static NendoDiscoveryProtocol Protocol { get; } = new(
        ProtocolVersion: "2026-07-28",
        InitializeHandshake: true,
        Discover: "server/discover",
        RequiredHeaders: ["MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"],
        RequiredRequestMetadata:
        [
            "io.modelcontextprotocol/protocolVersion",
            "io.modelcontextprotocol/clientCapabilities",
            "io.modelcontextprotocol/clientInfo",
        ],
        Notes: "No credential and no session header. A standard MCP client sends initialize and proceeds. " +
            "A 2026-07-28 client calls server/discover instead and then sends the listed headers on every " +
            "request, with the metadata keys in params._meta, camelCase exactly as written; Mcp-Name carries " +
            "the tool name or resource URI of the request.");

    internal string Root => _root;

    internal async Task<string> WriteAsync(
        NendoHostAuthority authority,
        string applicationId,
        string instanceId,
        string displayName,
        CancellationToken cancellationToken)
    {
        NendoProtectedFiles.SecureDirectory(_root);
        CleanupStaleEntries();
        var document = new NendoDiscoveryDocument(
            SchemaVersion,
            authority.Endpoint.AbsoluteUri,
            authority.HostRunId,
            Environment.ProcessId,
            DateTimeOffset.UtcNow,
            authority.Mode,
            applicationId,
            instanceId,
            Label(displayName))
        {
            ProcessStartedAt = ProcessStart(Environment.ProcessId).Started,
        };
        var finalPath = Path.Combine(_root, $"{authority.HostRunId}.json");
        var temporaryPath = Path.Combine(_root, $".{authority.HostRunId}.{Guid.NewGuid():N}.tmp");
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(document, NendoMcpJson.Options);
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(bytes, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }
            NendoProtectedFiles.SecureFile(temporaryPath);
            File.Move(temporaryPath, finalPath, overwrite: false);
            NendoProtectedFiles.SecureFile(finalPath);
            return finalPath;
        }
        catch
        {
            DeleteIfPresent(temporaryPath);
            DeleteIfPresent(finalPath);
            throw;
        }
    }

    /// <summary>
    /// A file name and nothing else. Anything that arrives carrying a directory
    /// is reduced to its last segment, so a caller cannot widen this field into a
    /// path by handing one in.
    /// </summary>
    private static string Label(string displayName) =>
        Path.GetFileName(displayName.Trim().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));

    internal static void DeleteIfPresent(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }
        try
        {
            File.Delete(path);
        }
        catch (FileNotFoundException)
        {
        }
        catch (DirectoryNotFoundException)
        {
        }
    }

    internal static IReadOnlySet<string> AllowedIdentityValues()
    {
        using var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
        var user = identity.User
            ?? throw new InvalidOperationException("The current Windows user identity is unavailable.");
        return new HashSet<string>(StringComparer.Ordinal)
        {
            user.Value,
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value,
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value,
        };
    }

    /// <summary>
    /// Every running Nendo this device is advertising, newest last.
    /// </summary>
    /// <remarks>
    /// The host has written this directory since discovery existed and nothing read it, so
    /// an agent could not tell which file the person had in front of them and a second
    /// Nendo was unreachable in practice — its endpoint was published and no client looked.
    /// This is the read side.
    /// <para>
    /// An entry is admitted on exactly the terms the sweep uses to keep one, because an
    /// entry worth deleting is not an entry worth reporting. It carries no path: the
    /// display name is a file name and nothing else, by <see cref="Label"/>, and that is
    /// deliberate — an agent is told which file is open, never where it lives.
    /// </para>
    /// </remarks>
    internal IReadOnlyList<NendoDiscoveryDocument> ReadLiveEntries()
    {
        if (!Directory.Exists(_root)) return [];
        var entries = new List<NendoDiscoveryDocument>();
        foreach (var path in Directory.EnumerateFiles(_root, "*.json", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if (ReadValidEntry(path) is { } document) entries.Add(document);
            }
            catch (JsonException)
            {
                // Unreadable is not reportable. The sweep removes it on the next write.
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
        return [.. entries.OrderBy(entry => entry.CreatedAt).ThenBy(entry => entry.HostRunId, StringComparer.Ordinal)];
    }

    /// <summary>
    /// The one definition of an entry worth trusting, used by both the sweep and the read.
    /// Kept in one place so a rule tightened for one of them cannot be missed by the other.
    /// </summary>
    private static NendoDiscoveryDocument? ReadValidEntry(string path)
    {
        // Read without denying delete: the host that owns the entry removes it when its agent
        // access stops, and a reader in another process must not make that stop fail.
        string text;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new StreamReader(stream))
            text = reader.ReadToEnd();
        var document = JsonSerializer.Deserialize<NendoDiscoveryDocument>(text, NendoMcpJson.Options);
        return document is null ||
            document.SchemaVersion != SchemaVersion ||
            string.IsNullOrWhiteSpace(document.HostRunId) ||
            Path.GetFileNameWithoutExtension(path) != document.HostRunId ||
            !Uri.TryCreate(document.Endpoint, UriKind.Absolute, out var endpoint) ||
            endpoint.Scheme != Uri.UriSchemeHttp ||
            endpoint.Host != "127.0.0.1" ||
            document.ProcessId <= 0 ||
            !IsWriterAlive(document)
            ? null
            : document;
    }

    /// <summary>
    /// Whether the process that wrote the entry is still the one running under its ID: it must
    /// have started when the entry says, or, for an entry that does not say, before the entry was
    /// written. A process that started later took a dead host's number.
    /// </summary>
    private static bool IsWriterAlive(NendoDiscoveryDocument document)
    {
        var process = ProcessStart(document.ProcessId);
        if (!process.Running) return false;
        // A process this user may not inspect is not known to be another one: the entry is kept
        // rather than swept, as before the start time was read.
        if (process.Started is not { } started) return true;
        return document.ProcessStartedAt is { } recorded
            ? (started - recorded).Duration() < StartTolerance
            : started <= document.CreatedAt + StartTolerance;
    }

    private static readonly TimeSpan StartTolerance = TimeSpan.FromSeconds(1);

    /// <summary>Whether a process runs under the ID, and when it started, which is null when this user may not read it.</summary>
    private readonly record struct ProcessLiveness(bool Running, DateTimeOffset? Started);

    private static ProcessLiveness ProcessStart(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            try
            {
                return process.HasExited
                    ? new(false, null)
                    : new(true, new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero));
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return new(true, null);
            }
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or NotSupportedException)
        {
            return new(false, null);
        }
    }

    /// <summary>How old a half-written entry must be before the sweep removes it, so it never races a host writing one.</summary>
    private static readonly TimeSpan OrphanAge = TimeSpan.FromMinutes(1);

    private void CleanupStaleEntries()
    {
        // A host that crashed between creating its temporary file and moving it into place left
        // the temporary file behind, and the sweep read only *.json.
        foreach (var path in Directory.EnumerateFiles(_root, ".*.tmp", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if (DateTime.UtcNow - File.GetLastWriteTimeUtc(path) > OrphanAge) DeleteIfPresent(path);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
        foreach (var path in Directory.EnumerateFiles(_root, "*.json", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if (ReadValidEntry(path) is null)
                {
                    DeleteIfPresent(path);
                }
            }
            catch (JsonException)
            {
                DeleteIfPresent(path);
            }
            catch (IOException)
            {
                // A live host may be rotating this entry. Fail closed by leaving it untouched.
            }
            catch (UnauthorizedAccessException)
            {
                // Do not weaken or replace an entry the current process cannot inspect.
            }
        }
    }

}
