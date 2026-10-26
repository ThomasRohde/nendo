using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// The Windows host's own methods: its windows and tabs, title bar, downloads, native diagnostics
/// and the agents it runs (ADR-0002, ADR-0030). The shared dispatch hands them here.
/// </summary>
internal sealed partial class WorkbenchProtocolHandler
{
    private partial async Task<HostAnswer> HandleUnboundHostMethodAsync(string method, JsonElement root, JsonElement payload, CancellationToken cancellationToken) =>
        WorkbenchMethods.AgentSessionMethods.Contains(method)
            ? new HostAnswer(true, await HandleAgentSessionAsync(method, RequiredString(root, "fileSessionId", 120), payload, cancellationToken))
            : HostAnswer.NotHandled;

    private partial bool IsHostIndependent(string method) =>
        method is WorkbenchMethods.DownloadsShow or WorkbenchMethods.WindowTakeTab
            or WorkbenchMethods.WindowBeginTabDrag or WorkbenchMethods.WindowEndTabDrag or WorkbenchMethods.DiagnosticsTabDrag;

    private partial async Task<object?> HandleHostMethodAsync(string method, JsonElement payload, int protocolVersion, CancellationToken cancellationToken) =>
        method switch
        {
            WorkbenchMethods.DiagnosticsFrameProcesses when DesktopRuntimeConfiguration.NativeDiagnostics =>
                await ExtensionHost().ReadFrameProcessesAsync(),
            WorkbenchMethods.SessionGetRecentFiles => await _session.GetRecentFilesAsync(cancellationToken),
            WorkbenchMethods.WindowSetTitleBarControls => SetTitleBarControls(payload),
            WorkbenchMethods.WindowDetachTab => DetachTab(payload),
            WorkbenchMethods.WindowTakeTab => TabWindows().TakeTab(),
            WorkbenchMethods.WindowBeginTabDrag => await BeginTabDragAsync(payload),
            WorkbenchMethods.WindowEndTabDrag => EndTabDrag(payload),
            WorkbenchMethods.DiagnosticsCloseWindow when DesktopRuntimeConfiguration.NativeDiagnostics => CloseWindow(),
            WorkbenchMethods.DiagnosticsExit when DesktopRuntimeConfiguration.NativeDiagnostics => Exit(),
            WorkbenchMethods.DiagnosticsTabDrag when DesktopRuntimeConfiguration.NativeDiagnostics => DiagnoseTabDrag(payload),
            WorkbenchMethods.DownloadsShow => ShowDownload(payload),
            WorkbenchMethods.DiagnosticsTitleBar when DesktopRuntimeConfiguration.NativeDiagnostics => DiagnoseTitleBar(payload),
            WorkbenchMethods.DiagnosticsResizeWindow when DesktopRuntimeConfiguration.NativeDiagnostics => ResizeWindow(payload),
            WorkbenchMethods.AgentGetStatus => await _session.GetAgentStatusAsync(cancellationToken),
            WorkbenchMethods.AgentSetMode => await SetAgentModeAsync(payload, cancellationToken),
            WorkbenchMethods.AgentRevokeEditing => await _session.RevokeAgentEditingAsync(cancellationToken),
            WorkbenchMethods.AgentGetProposal => await GetAgentProposalAsync(payload, cancellationToken),
            WorkbenchMethods.AgentSetSettings => await SetAgentSettingsAsync(payload, cancellationToken),
            _ => throw new NendoPreconditionException(
                "unknown-method",
                $"Workbench method {method} is not part of protocol version {protocolVersion}."),
        };
}
