using System.Net;

namespace Nendo.LocalMcp;

// No bearer: the loopback perimeter, exact Host/Origin matching, the per-run generation and closed admission
// are the whole transport boundary (ADR-0009, 2026-09-13 amendment).
internal sealed class NendoHostAuthority(
    string hostRunId,
    AgentAccessMode mode,
    byte[] cursorKey,
    string applicationId,
    string instanceId)
{
    private int _port;
    private int _closed;

    internal bool IsActive => Volatile.Read(ref _closed) == 0;

    internal void CloseAdmission() => Interlocked.Exchange(ref _closed, 1);

    internal void RequireActive()
    {
        if (!IsActive) throw new NendoAgentAuthorityException("HOST_CLOSED", "This agent endpoint is closed. Enable access again in the current file session.");
    }

    internal string HostRunId { get; } = hostRunId;

    internal AgentAccessMode Mode { get; } = mode;

    internal string ApplicationId { get; } = applicationId;

    internal string InstanceId { get; } = instanceId;

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
