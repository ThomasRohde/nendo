using Microsoft.Web.WebView2.Core;

namespace Nendo.Desktop;

/// <summary>
/// What a custom view may do in the browser: most of what a web page may do. It gets a context
/// menu, dialogs, DevTools, the clipboard and downloads, and its links open in the person's own
/// browser. The Workbench's document keeps its narrower rules: no browser context menu, no
/// permission grants, and no frame may load it.
/// <para>
/// Measured in prototypes/iframe-views/FINDINGS.md: the browser names neither the frame of a
/// context menu nor the origin of a permission request the way its flags suggest. A context
/// menu is told apart by the frame's own address (S13). A permission request carries the
/// Workbench's origin whichever view asked, so views are answered by a handler on their own
/// frame, and a grant is never saved where it would cover every view (S10).
/// </para>
/// </summary>
internal static class ExtensionWebViewPolicy
{
    /// <summary>
    /// Each window's download handler, which tells that window of what it saved (F-237). The event's
    /// sender may be another wrapper of the same browser, so the window rides in the handler.
    /// </summary>
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<CoreWebView2,
        Windows.Foundation.TypedEventHandler<CoreWebView2, CoreWebView2DownloadStartingEventArgs>> DownloadHandlers = new();

    internal static void Attach(CoreWebView2 core, Action<string>? downloadSaved = null)
    {
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDefaultScriptDialogsEnabled = true;
        core.Settings.AreDevToolsEnabled = true;
        core.ContextMenuRequested += OnContextMenuRequested;
        core.PermissionRequested += OnWorkbenchPermissionRequested;
        core.FrameCreated += OnFrameCreated;
        core.NewWindowRequested += OnNewWindowRequested;
        core.FrameNavigationStarting += OnFrameNavigationStarting;
        Windows.Foundation.TypedEventHandler<CoreWebView2, CoreWebView2DownloadStartingEventArgs> downloads = (_, args) => OnDownloadStarting(args, downloadSaved);
        DownloadHandlers.AddOrUpdate(core, downloads);
        core.DownloadStarting += downloads;
    }

    internal static void Detach(CoreWebView2 core)
    {
        core.ContextMenuRequested -= OnContextMenuRequested;
        core.PermissionRequested -= OnWorkbenchPermissionRequested;
        core.FrameCreated -= OnFrameCreated;
        core.NewWindowRequested -= OnNewWindowRequested;
        core.FrameNavigationStarting -= OnFrameNavigationStarting;
        if (DownloadHandlers.TryGetValue(core, out var downloads))
        {
            core.DownloadStarting -= downloads;
            DownloadHandlers.Remove(core);
        }
    }

    /// <summary>
    /// A download goes to the person's Downloads folder, under a name that overwrites nothing,
    /// without WebView2's own downloads panel. That panel opened over Nendo's window to ask about
    /// an Exchange XML file a view saved from a command in Nendo's row, which carries no click
    /// into the view, and after Keep the browser process spun and the window stayed white (F-237).
    /// The view says what it saved.
    /// </summary>
    private static void OnDownloadStarting(CoreWebView2DownloadStartingEventArgs args, Action<string>? saved)
    {
        args.Handled = true;
        // The journeys save into a folder of their own, never the person's Downloads; under native
        // diagnostics alone, the folder a test names in the environment is the one saved to.
        if (DesktopRuntimeConfiguration.NativeDiagnostics &&
            Environment.GetEnvironmentVariable("NENDO_DIAGNOSTICS_DOWNLOAD_FOLDER") is { Length: > 0 } folder)
            args.ResultFilePath = System.IO.Path.Combine(folder, System.IO.Path.GetFileName(args.ResultFilePath));
        if (saved is null) return;
        var operation = args.DownloadOperation;
        operation.StateChanged += (download, _) =>
        {
            if (download.State == CoreWebView2DownloadState.Completed) saved(download.ResultFilePath);
        };
    }

    /// <summary>The Workbench draws its own menus; a view gets the browser's, with Inspect.</summary>
    private static void OnContextMenuRequested(CoreWebView2 sender, CoreWebView2ContextMenuRequestedEventArgs args)
    {
        if (IsWorkbench(args.ContextMenuTarget.FrameUri)) args.Handled = true;
    }

    /// <summary>
    /// Every frame the Workbench holds is a view: its content security policy frames nothing else.
    /// The frame's handler runs first and covers the frames a view nests inside itself.
    /// </summary>
    private static void OnFrameCreated(CoreWebView2 sender, CoreWebView2FrameCreatedEventArgs args) =>
        args.Frame.PermissionRequested += OnViewPermissionRequested;

    /// <summary>
    /// A view may read the clipboard, play media and download several files without being asked
    /// each time. Anything else it asks for is refused. Either way the answer is this frame's
    /// alone, nothing reaches the Workbench's handler below, and nothing is kept in the profile.
    /// </summary>
    private static void OnViewPermissionRequested(CoreWebView2Frame sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        var answer = ViewPermission(args.PermissionKind);
        args.Handled = answer.Handled;
        args.SavesInProfile = answer.SavesInProfile;
        args.State = answer.State;
    }

    /// <summary>
    /// The whole answer a view gets, which the handler only copies. A request carries the
    /// Workbench's origin whichever view asked, so an answer WebView2's own prompt kept would
    /// cover every view of every file: the person's Allow for their own map view would hand a
    /// file someone sent them their location without asking (DAE-02). So nothing is left to that
    /// prompt and nothing is kept. Autoplay is allowed because the frame delegates it.
    /// </summary>
    internal static (bool Handled, bool SavesInProfile, CoreWebView2PermissionState State) ViewPermission(CoreWebView2PermissionKind kind) =>
        (true, false, kind is CoreWebView2PermissionKind.ClipboardRead or CoreWebView2PermissionKind.MultipleAutomaticDownloads
            or CoreWebView2PermissionKind.Autoplay
            ? CoreWebView2PermissionState.Allow
            : CoreWebView2PermissionState.Deny);

    /// <summary>The Workbench asks for nothing, so it is given nothing.</summary>
    private static void OnWorkbenchPermissionRequested(CoreWebView2 sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        args.SavesInProfile = false;
        args.State = CoreWebView2PermissionState.Deny;
    }

    /// <summary>
    /// No second browser window, ever. A link the person followed opens in their own browser;
    /// a window a script opened on its own opens nowhere.
    /// </summary>
    private static void OnNewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (!args.IsUserInitiated || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme is not ("http" or "https" or "mailto")) return;
        if (ExtensionOrigins.IsViewHost(uri.Host) || IsWorkbench(args.Uri)) return;
        _ = Windows.System.Launcher.LaunchUriAsync(uri);
    }

    /// <summary>
    /// A view, or a frame a view nests, cannot load the Workbench's own origin. That document
    /// would share an origin with the Workbench and could reach into it (S9b). Nor can it start
    /// another app through a scheme of its own: a frame sent to <c>search-ms:</c> or
    /// <c>ms-settings:</c> reached WebView2's "open this app?" prompt (DAE-13). A <c>mailto:</c>
    /// link the person followed opens their mail app, as a pop-up's does.
    /// </summary>
    private static void OnFrameNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
    {
        var answer = FrameNavigation(args.Uri, args.IsUserInitiated);
        args.Cancel = answer.Cancel;
        if (answer.Mail is { } mail) _ = Windows.System.Launcher.LaunchUriAsync(mail);
    }

    /// <summary>The whole answer to a frame's navigation, which the handler only copies.</summary>
    internal static (bool Cancel, Uri? Mail) FrameNavigation(string? address, bool userInitiated)
    {
        // The scheme is read from the text, so nothing turns on what Uri accepts.
        var colon = address?.IndexOf(':') ?? -1;
        if (colon <= 0) return (true, null);
        var scheme = address![..colon].ToLowerInvariant();
        if (IsWorkbench(address)) return (true, null);
        // A javascript: link runs in the frame's own document and starts nothing else.
        if (scheme is "http" or "https" or "data" or "blob" or "about" or "javascript") return (false, null);
        return (true, scheme == "mailto" && userInitiated && Uri.TryCreate(address, UriKind.Absolute, out var mail) ? mail : null);
    }

    private static bool IsWorkbench(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
        string.Equals(uri.Host, DesktopShellContract.WorkbenchHostName, StringComparison.OrdinalIgnoreCase);
}
