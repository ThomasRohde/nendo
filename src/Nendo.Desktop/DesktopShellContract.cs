namespace Nendo.Desktop;

public sealed record DesktopShellDescription(
    int BridgeProtocolVersion,
    string PermanentStudioRoute,
    Uri WorkbenchUri);

/// <summary>
/// Closed identifiers shared by the native shell and its local Workbench.
/// </summary>
public static class DesktopShellContract
{
    public const int BridgeProtocolVersion = 7;

    /// <summary>
    /// The first version whose renderer accepts an unsolicited message. Everything
    /// before it matches replies to requests by id and drops anything else, so a
    /// host event posted to an older Workbench is silently discarded rather than
    /// mishandled — which is why the host checks this before posting one.
    /// </summary>
    public const int EventBridgeProtocolVersion = 7;

    public const int SnapshotBridgeProtocolVersion = 6;

    public const int OutcomeBridgeProtocolVersion = 5;

    public const int AgentBridgeProtocolVersion = 4;

    public const int PreviousBridgeProtocolVersion = 3;

    public const int LegacyBridgeProtocolVersion = 2;

    public const string PermanentStudioRoute = "studio";

    public const string WorkbenchHostName = "app.nendo.local";

    public const string WorkbenchEntryPoint = "index.html";

    public static Uri WorkbenchUri { get; } =
        new($"https://{WorkbenchHostName}/{WorkbenchEntryPoint}", UriKind.Absolute);

    public static DesktopShellDescription Describe() =>
        new(BridgeProtocolVersion, PermanentStudioRoute, WorkbenchUri);

    public static bool IsSupportedBridgeProtocol(int version) =>
        version is LegacyBridgeProtocolVersion or PreviousBridgeProtocolVersion or AgentBridgeProtocolVersion
            or OutcomeBridgeProtocolVersion or SnapshotBridgeProtocolVersion or BridgeProtocolVersion;

    public static bool IsAllowedWorkbenchUri(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps &&
        uri.Host.Equals(WorkbenchHostName, StringComparison.OrdinalIgnoreCase);
}
