namespace Nendo.Session;

// The shapes of the window a host may own: what the Windows host answers about its title bar.
// The browser host has no window of its own and passes no window host.

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Where the page's controls are in the window's title bar, so Windows moves the window
    /// from the rest of it. Answered with the title bar itself: its height and the width Windows
    /// keeps at each end for its own buttons.
    /// </summary>
    internal const string WindowSetTitleBarControls = "window.setTitleBarControls";

    /// <summary>
    /// The title bar as Windows holds it and what it answers at points of the page. Answered only
    /// when NENDO_NATIVE_DIAGNOSTICS=1, for the journey that measures it.
    /// </summary>
    internal const string DiagnosticsTitleBar = "diagnostics.titleBar";

    /// <summary>Give the window's client area a size, for the journey that measures a narrow window. Diagnostics only.</summary>
    internal const string DiagnosticsResizeWindow = "diagnostics.resizeWindow";
}

/// <summary>A rectangle of the page in its CSS pixels, from the page's top left.</summary>
internal sealed record TitleBarRect(double X, double Y, double Width, double Height);

/// <summary>
/// The window's title bar in the page's CSS pixels: how tall it is, and how much of its
/// width Windows keeps for its own buttons at the left and at the right.
/// </summary>
internal sealed record TitleBarView(double Height, double Left, double Right);

/// <summary>What a press at one point reaches: the window's class and its hit-test code.</summary>
internal sealed record TitleBarHit(string Window, int Code);

/// <summary>
/// What the journey measures: the page's place in the window, the title bar, the regions Windows
/// holds (in the page's CSS pixels) and what a press reaches at each point asked about.
/// </summary>
internal sealed record TitleBarDiagnosticsView(
    double Scale,
    double PageLeft,
    double PageTop,
    double ClientWidth,
    double ClientHeight,
    TitleBarView Bar,
    IReadOnlyList<TitleBarRect> Caption,
    IReadOnlyList<TitleBarRect> Passthrough,
    IReadOnlyList<TitleBarHit> Hits);

/// <summary>What the title bar needs from the page that owns the window and its WebView.</summary>
internal interface IWorkbenchWindowHost
{
    /// <summary>Hand Windows the rectangles of the page's controls in the title bar; answers the title bar.</summary>
    TitleBarView SetTitleBarControls(IReadOnlyList<TitleBarRect> controls);

    /// <summary>The title bar as Windows holds it, and its hit-test code at each point of the page.</summary>
    TitleBarDiagnosticsView DiagnoseTitleBar(IReadOnlyList<TitleBarRect> points);

    /// <summary>Give the window's client area this size, in the page's CSS pixels.</summary>
    TitleBarDiagnosticsView ResizeWindow(double width, double height);
}
