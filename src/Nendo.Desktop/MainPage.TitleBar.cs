using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// The page's half of the title bar (W-093): the Workbench says where its controls are in the
/// top bar, and this page, which knows where the WebView sits in the window, hands them to it.
/// </summary>
public sealed partial class MainPage : IWorkbenchWindowHost
{
    private static MainWindow Window() => App.CurrentWindow ?? throw new NendoPreconditionException(
        "window-unavailable", "The window is not available.");

    /// <summary>Where the page starts in the window, in its pixels: its top left, which is the window's.</summary>
    private (double Left, double Top) PageOrigin()
    {
        if (_webView is null) return (0, 0);
        var origin = _webView.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point(0, 0));
        return (origin.X, origin.Y);
    }

    TitleBarView IWorkbenchWindowHost.SetTitleBarControls(IReadOnlyList<TitleBarRect> controls)
    {
        var (left, top) = PageOrigin();
        return Window().SetTitleBarControls(controls, left, top);
    }

    TitleBarDiagnosticsView IWorkbenchWindowHost.DiagnoseTitleBar(IReadOnlyList<TitleBarRect> points)
    {
        var (left, top) = PageOrigin();
        return Window().DiagnoseTitleBar(points, left, top);
    }

    TitleBarDiagnosticsView IWorkbenchWindowHost.ResizeWindow(double width, double height)
    {
        Window().ResizeClient(width, height);
        return ((IWorkbenchWindowHost)this).DiagnoseTitleBar([]);
    }

    /// <summary>The title bar changed shape, so the page keeps a new width free and says where its controls are again.</summary>
    internal void TitleBarChanged(TitleBarView bar) => PostWorkbenchEvent(WorkbenchEvents.TitleBarChanged, bar);

    /// <summary>
    /// The page is going, so nothing in the title bar is a control any more. Best effort: the
    /// window may be closing, and a title bar that still passed a few rectangles through would
    /// cost a drag from them, not the recovery panel that follows.
    /// </summary>
    private static void ForgetTitleBarControls()
    {
        try
        {
            App.CurrentWindow?.ClearTitleBarControls();
        }
        catch (Exception)
        {
        }
    }
}
