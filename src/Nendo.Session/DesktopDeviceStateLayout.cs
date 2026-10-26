namespace Nendo.Session;

/// <summary>
/// The folders of the device-state root (ADR-0034): one per concern, and nothing else at the root.
/// Each store is given the root and keeps its one document in its concern's folder, so the root
/// and an isolated one named by <c>NENDO_DEVICE_STATE_ROOT</c> have the same shape.
/// </summary>
internal static class DesktopDeviceStateLayout
{
    /// <summary>Agent connection, each file's port and access level, Launch, each agent's settings, and launched conversations.</summary>
    internal static string Agents(string root) => Path.Combine(Path.GetFullPath(root), "agents");

    /// <summary>The working folders launched agents start in.</summary>
    internal static string AgentSessions(string root) => Path.Combine(Agents(root), "sessions");

    /// <summary>Custom-view switches and development links, and the view-origin carry.</summary>
    internal static string Views(string root) => Path.Combine(Path.GetFullPath(root), "views");

    /// <summary>Consent for files' automatic actions.</summary>
    internal static string Actions(string root) => Path.Combine(Path.GetFullPath(root), "actions");

    /// <summary>Theme, the tray's choices, and window places.</summary>
    internal static string Window(string root) => Path.Combine(Path.GetFullPath(root), "window");

    /// <summary>Recent files and the icons drawn for files' looks.</summary>
    internal static string Files(string root) => Path.Combine(Path.GetFullPath(root), "files");

    /// <summary>The view-failure and agent-failure logs.</summary>
    internal static string Logs(string root) => Path.Combine(Path.GetFullPath(root), "logs");

    /// <summary>Where each running file's agent endpoint is published (ADR-0009).</summary>
    internal static string Discovery(string root) => Path.Combine(Path.GetFullPath(root), "Mcp", "active");
}
