namespace Nendo.Desktop;

internal enum WorkbenchFileAction { Create, Open, OpenRecent, OpenDropped, Close, Backup, Duplicate, Fork, Restore, Upgrade, Inspect, Diagnostics, Export, ResolveRecovery, ImportCsv, ExportCsv, CustomViews, OpenCustomView, ReviewCustomView, InstallCustomView }

/// <param name="DroppedPath">
/// Where a dropped file came from. Never read out of the request payload: the page
/// hands the host a file object and the host asks Windows for its path, so a page
/// cannot name a path of its own choosing and have Nendo open it.
/// </param>
internal sealed record WorkbenchFileActionRequest(WorkbenchFileAction Action, string? RecentId = null, string? DroppedPath = null, string? ViewId = null);
internal sealed record DesktopFileActionView(DesktopSessionView? Session, string? Notice)
{
    public string? RefreshNotice { get; init; }

    internal static async Task<DesktopFileActionView> CaptureAsync(
        Func<CancellationToken, Task<DesktopSessionView>> refresh, string? notice,
        CancellationToken cancellationToken = default)
    {
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        bounded.CancelAfter(TimeSpan.FromSeconds(2));
        try { return new(await refresh(bounded.Token), notice); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or
            OperationCanceledException or Nendo.Engine.NendoException)
        {
            return new(null, notice)
            {
                RefreshNotice = "The file view could not be refreshed. Inspect the current file state before starting another file action.",
            };
        }
    }
}

internal static partial class WorkbenchMethods
{
    internal const string SessionGetRecentFiles = "session.getRecentFiles";
    internal const string FileOpenRecent = "file.openRecent";
    internal const string FileOpenDropped = "file.openDropped";
    internal const string FileClose = "file.close";
    internal const string FileBackup = "file.backup";
    internal const string FileDuplicate = "file.duplicate";
    internal const string FileFork = "file.fork";
    internal const string FileRestore = "file.restore";
    internal const string FileUpgrade = "file.upgrade";
    internal const string FileInspect = "file.inspect";
    internal const string FileDiagnostics = "file.diagnostics";
    internal const string FileExport = "file.export";
    internal const string FileResolveRecovery = "file.resolveRecovery";
}

internal sealed partial class WorkbenchProtocolHandler
{
    private static readonly IReadOnlyDictionary<string, WorkbenchFileAction> FileMethods =
        new Dictionary<string, WorkbenchFileAction>(StringComparer.Ordinal)
        {
            [WorkbenchMethods.FileOpenRecent] = WorkbenchFileAction.OpenRecent,
            [WorkbenchMethods.FileOpenDropped] = WorkbenchFileAction.OpenDropped,
            [WorkbenchMethods.FileClose] = WorkbenchFileAction.Close,
            [WorkbenchMethods.FileBackup] = WorkbenchFileAction.Backup,
            [WorkbenchMethods.FileDuplicate] = WorkbenchFileAction.Duplicate,
            [WorkbenchMethods.FileFork] = WorkbenchFileAction.Fork,
            [WorkbenchMethods.FileRestore] = WorkbenchFileAction.Restore,
            [WorkbenchMethods.FileUpgrade] = WorkbenchFileAction.Upgrade,
            [WorkbenchMethods.FileInspect] = WorkbenchFileAction.Inspect,
            [WorkbenchMethods.FileDiagnostics] = WorkbenchFileAction.Diagnostics,
            [WorkbenchMethods.FileExport] = WorkbenchFileAction.Export,
            [WorkbenchMethods.FileResolveRecovery] = WorkbenchFileAction.ResolveRecovery,
            ["file.importCsv"] = WorkbenchFileAction.ImportCsv,
            ["file.exportCsv"] = WorkbenchFileAction.ExportCsv,
            ["file.customViews"] = WorkbenchFileAction.CustomViews,
            ["extension.open"] = WorkbenchFileAction.OpenCustomView,
            ["extension.review"] = WorkbenchFileAction.ReviewCustomView,
            // The Use surface's own next step: the native package picker and review, without the package manager in between.
            ["extension.install"] = WorkbenchFileAction.InstallCustomView,
        };

    private Task<DesktopFileActionView> RunFileActionAsync(WorkbenchFileAction action, string? recentId = null, string? droppedPath = null, string? viewId = null) =>
        (_fileActions ?? throw new Nendo.Engine.NendoPreconditionException("file-actions-unavailable",
            "File actions are unavailable in this host. Use the native recovery view."))(new(action, recentId, droppedPath, viewId));

    private async Task<object> RunSessionFileActionAsync(WorkbenchFileAction action)
    {
        var result = await RunFileActionAsync(action);
        // Preserve the existing success snapshot contract. If only its refresh
        // failed, return the known notice and an explicit unavailable view.
        return result.Session is { } snapshot ? snapshot : result;
    }
}
