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
    internal static void Attach(CoreWebView2 core)
    {
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDefaultScriptDialogsEnabled = true;
        core.Settings.AreDevToolsEnabled = true;
        core.ContextMenuRequested += OnContextMenuRequested;
        core.PermissionRequested += OnWorkbenchPermissionRequested;
        core.FrameCreated += OnFrameCreated;
        core.NewWindowRequested += OnNewWindowRequested;
        core.FrameNavigationStarting += OnFrameNavigationStarting;
    }

    internal static void Detach(CoreWebView2 core)
    {
        core.ContextMenuRequested -= OnContextMenuRequested;
        core.PermissionRequested -= OnWorkbenchPermissionRequested;
        core.FrameCreated -= OnFrameCreated;
        core.NewWindowRequested -= OnNewWindowRequested;
        core.FrameNavigationStarting -= OnFrameNavigationStarting;
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
    /// A view may read the clipboard and download several files without being asked each time.
    /// Anything else it asks for gets the browser's own prompt. Either way the answer is this
    /// frame's alone, and nothing reaches the Workbench's handler below.
    /// </summary>
    private static void OnViewPermissionRequested(CoreWebView2Frame sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        args.Handled = true;
        if (args.PermissionKind is not (CoreWebView2PermissionKind.ClipboardRead or CoreWebView2PermissionKind.MultipleAutomaticDownloads))
            return;
        args.SavesInProfile = false;
        args.State = CoreWebView2PermissionState.Allow;
    }

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
    /// would share an origin with the Workbench and could reach into it (S9b).
    /// </summary>
    private static void OnFrameNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (IsWorkbench(args.Uri)) args.Cancel = true;
    }

    private static bool IsWorkbench(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) &&
        string.Equals(uri.Host, DesktopShellContract.WorkbenchHostName, StringComparison.OrdinalIgnoreCase);
}
