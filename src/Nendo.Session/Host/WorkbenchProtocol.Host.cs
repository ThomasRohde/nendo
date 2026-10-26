using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// This build's answer to the methods a host owns (ADR-0036). It has no window, tabs, downloads,
/// native diagnostics or agents, so each of those is refused by name, and no recent files; anything
/// else is not part of the protocol at all.
/// </summary>
internal sealed partial class WorkbenchProtocolHandler
{
    private static readonly string[] WindowsHostPrefixes = ["window.", "agent.", "agentSession.", "acp.", "diagnostics.", "downloads."];

    private partial Task<HostAnswer> HandleUnboundHostMethodAsync(string method, JsonElement root, JsonElement payload, CancellationToken cancellationToken) =>
        method.StartsWith("agentSession.", StringComparison.Ordinal) || method.StartsWith("acp.", StringComparison.Ordinal)
            ? throw NotInThisHost(method)
            : Task.FromResult(HostAnswer.NotHandled);

    private partial bool IsHostIndependent(string method) => false;

    private partial Task<object?> HandleHostMethodAsync(string method, JsonElement payload, int protocolVersion, CancellationToken cancellationToken) =>
        // A page keeps no list of files across visits: its recent files are none.
        method == WorkbenchMethods.SessionGetRecentFiles ? Task.FromResult<object?>(new DesktopRecentFiles([], null))
        : WindowsHostPrefixes.Any(prefix => method.StartsWith(prefix, StringComparison.Ordinal))
            ? throw NotInThisHost(method)
            : throw new NendoPreconditionException(
                "unknown-method",
                $"Workbench method {method} is not part of protocol version {protocolVersion}.");

    private static NendoPreconditionException NotInThisHost(string method) =>
        new("not-in-this-host", $"{method} is answered by Nendo for Windows, not by this host.");
}
