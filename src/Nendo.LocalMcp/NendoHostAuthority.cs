using System.Net;

namespace Nendo.LocalMcp;

// No bearer: the loopback perimeter, exact Host/Origin matching, the per-run generation and closed admission
// are the whole transport boundary (ADR-0009).
internal sealed class NendoHostAuthority(
    string hostRunId,
    AgentAccessMode mode,
    byte[] cursorKey,
    string applicationId,
    string instanceId,
    string? fileName = null)
{
    private int _port;
    private int _closed;

    /// <summary>
    /// Why a closed endpoint refuses, and where the current one is shown: the one sentence the
    /// perimeter, the tool path and the resource path all give.
    /// </summary>
    internal const string ClosedMessage =
        "This agent endpoint is closed: the file was closed, switched or entered recovery, or agent access " +
        "was turned off. Every handle and lease from it has ended. Ask the person which file is open; Nendo " +
        "shows the current address on the Agent page.";

    internal bool IsActive => Volatile.Read(ref _closed) == 0;

    internal void CloseAdmission() => Interlocked.Exchange(ref _closed, 1);

    internal void RequireActive()
    {
        if (!IsActive) throw new NendoAgentAuthorityException("HOST_CLOSED", ClosedMessage);
    }

    internal string HostRunId { get; } = hostRunId;

    internal AgentAccessMode Mode { get; } = mode;

    internal string ApplicationId { get; } = applicationId;

    internal string InstanceId { get; } = instanceId;

    /// <summary>The open file's name without its directory, or null when it has none to say.</summary>
    internal string? FileName { get; } = NendoFileLabel.FileName(fileName);

    internal NendoCursorCodec Cursors { get; } = new(cursorKey);

    internal int Port => Volatile.Read(ref _port);

    internal Uri Endpoint => Port > 0
        ? new Uri($"http://{IPAddress.Loopback}:{Port}/mcp", UriKind.Absolute)
        : throw new InvalidOperationException("The local MCP endpoint is not ready.");

    internal void SetPort(int port)
    {
        if (port is < 1 or > 65535 || Interlocked.CompareExchange(ref _port, port, 0) != 0)
        {
            throw new InvalidOperationException("The local MCP endpoint port is invalid or already assigned.");
        }
    }
}
